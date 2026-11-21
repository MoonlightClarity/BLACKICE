import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {composeAgentDeveloperInstructions} from '../lib/developer-instruction-budget.mjs';
import {createInstructionAudit,withPreparedAdapterInstructions,withInstructionAcceptance,identityAuditSources,withDeliveredSkillInstructions,withSavedToolDefinitions} from '../lib/instruction-audit.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {IdentityStore} from '../lib/identity.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');

test('instruction sections reproduce the composed payload without truncation or absent sections',()=>{
 const bundle=composeAgentDeveloperInstructions({core:'Core\n',capabilities:'Tools\n',worker:'Worker\n',analysis:''});
 assert.equal(bundle.sections.map(item=>item.text).join(''),bundle.instructions);
 assert.deepEqual(bundle.sections.map(item=>item.id),['core','capabilities','worker']);
 const repeated=[{id:'a',role:'user',text:'Repeat\n'},{id:'b',role:'user',text:'Repeat\n'},{id:'absent',role:'user',text:'Absent'}];
 const audit=createInstructionAudit({developerInstructions:bundle.instructions,prompt:'Repeat\nRepeat\n',sections:[...bundle.sections,...repeated],tools:[{name:'fixture',inputSchema:{type:'object'}}]});
 assert.deepEqual(audit.sections.filter(item=>item.layer==='prompt').map(item=>item.id),['a','b']);
 assert.equal(audit.developer.sha256,hash(bundle.instructions));
 assert.equal(audit.totals.characters,bundle.instructions.length+14);
 assert.ok(Object.isFrozen(audit));assert.ok(Object.isFrozen(audit.sections[0]));
 assert.doesNotMatch(JSON.stringify(audit),/inputSchema/);
});

test('adapter capture matches final wire instructions and repeated callbacks do not accumulate',()=>{
 let audit=createInstructionAudit({developerInstructions:'Core',sections:[{id:'core',role:'developer',text:'Core'}]});
 const first=withPreparedAdapterInstructions(audit,{developerInstructions:'Core\nAdapter',adapter:'fixture',role:'system',source:'fixture'});
 assert.equal(first.sections.map(item=>item.text).join(''),'Core\nAdapter');
 assert.ok(first.sections.every(item=>item.role==='system'));
 const second=withPreparedAdapterInstructions(first,{developerInstructions:'Core\nAdapter',adapter:'fixture',role:'system',source:'fixture'});
 assert.equal(second.sections.length,first.sections.length);
 const replaced=withPreparedAdapterInstructions(second,{developerInstructions:'Different mode',adapter:'fixture',role:'system'});
 assert.equal(replaced.sections.length,1);assert.equal(replaced.sections[0].text,'Different mode');
 assert.equal(withInstructionAcceptance(replaced).delivery,'accepted');
 assert.equal(audit.delivery,'prepared');
});

test('later API requests preserve acceptance only for the same exact tool catalog',()=>{
 const tools=[{name:'fixture',description:'Operation',inputSchema:{type:'object',properties:{value:{type:'string',enum:['original'],description:'Argument documentation'}}}}];
 const original=withInstructionAcceptance(createInstructionAudit({tools}));
 const next=withPreparedAdapterInstructions(original,{adapter:'compatible',tools:structuredClone(tools)});
 assert.equal(next.delivery,'accepted');assert.equal(next.tools.status,'accepted');
 assert.ok(next.sections.filter(item=>item.layer==='tool-definition').every(item=>item.status==='accepted'));
 const schemaChanged=structuredClone(tools);schemaChanged[0].inputSchema.properties.value.enum=['changed'];
 const changed=withPreparedAdapterInstructions(next,{adapter:'compatible',tools:schemaChanged});
 assert.equal(changed.sections[0].text,next.sections[0].text,'Schema changes can leave all readable description text unchanged.');
 assert.notEqual(changed.tools.sha256,next.tools.sha256);
 assert.equal(changed.tools.status,'prepared');assert.equal(changed.sections[0].status,'prepared');
 const pending=withPreparedAdapterInstructions(changed,{adapter:'compatible',tools:schemaChanged});
 assert.equal(pending.tools.status,'prepared','Repetition alone does not prove acceptance.');
 const acceptedChanged=withInstructionAcceptance(pending);
 assert.equal(withPreparedAdapterInstructions(acceptedChanged,{adapter:'compatible',tools:schemaChanged}).sections[0].status,'accepted');
 const descriptionChanged=structuredClone(schemaChanged);descriptionChanged[0].description='Changed operation';
 assert.equal(withPreparedAdapterInstructions(acceptedChanged,{adapter:'compatible',tools:descriptionChanged}).sections[0].status,'prepared');
 assert.equal(original.sections[0].status,'accepted');assert.equal(original.tools.sha256,hash(JSON.stringify(tools)));
});

test('the exact active goal objective is an explicit exception without capturing ordinary task or history',()=>{
 const goal={id:'audit-goal',status:'active',objective:'ACTIVE_GOAL_OBJECTIVE',turns:0,maxTurns:3};
 const contract=ConversationGoals.prototype.instructions.call({forRun:()=>goal},{goal:{id:goal.id}});
 assert.match(contract,/ACTIVE_GOAL_OBJECTIVE/);
 const audit=createInstructionAudit({developerInstructions:contract,prompt:'ORDINARY_USER_TASK\nPRIVATE_HISTORY',sections:[{
   id:'goal',title:'Active goal contract',source:'lib/conversation-goals.mjs',role:'developer',text:contract,
 }]});
 assert.equal(audit.sections.find(item=>item.id==='goal').text,contract);
 assert.equal(audit.developer.sha256,hash(contract));
 assert.match(audit.notes.join('\n'),/active goal contract is a narrow exception.*objective is captured exactly/);
 assert.doesNotMatch(JSON.stringify(audit),/ORDINARY_USER_TASK|PRIVATE_HISTORY/);
});

test('SOUL audit preserves active decoded content and revision without copying USER facts',()=>{
 const soul={content:'# Soul\nUse "quotes".\n[Identity excerpt: middle omitted.]',revision:7,hash:'a'.repeat(64),truncated:true};
 const user={content:'PRIVATE_PROFILE_FACT',revision:4,truncated:false};
 const identity={documents:{soul,user},text:'Identity envelope\nSOUL_DOCUMENT='+JSON.stringify(soul)+'\nUSER_PROFILE_DATA='+JSON.stringify(user)};
 const captured=identityAuditSources(identity);
 const audit=createInstructionAudit({prompt:identity.text,sections:captured.sections,contextSources:captured.contextSources});
 const shown=audit.sections.find(item=>item.id==='soul');
 assert.equal(shown.text,soul.content);assert.equal(shown.revision,7);assert.equal(shown.truncated,true);
 assert.equal(shown.wireSha256,hash('SOUL_DOCUMENT='+JSON.stringify(soul)));
 assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_PROFILE_FACT/);
 assert.equal(audit.contextSources[0].revision,4);
 const omitted=createInstructionAudit({prompt:'Connectivity check',sections:captured.sections});
 assert.equal(omitted.sections.length,0);
});

test('native resume retains captured tool descriptions and marks unknown historic catalogs unavailable',()=>{
 const oldTools=[{name:'fixture',description:'Saved old description',inputSchema:{type:'object',properties:{arg:{description:'Saved argument documentation',type:'string'}}}}];
 const currentTools=[{name:'fixture',description:'NEW CURRENT DESCRIPTION',inputSchema:{type:'object'}}];
 const original=withInstructionAcceptance(createInstructionAudit({tools:oldTools}));
 const current=createInstructionAudit({tools:currentTools});
 const resumed=withSavedToolDefinitions(current,original,{names:['fixture'],sourceRunId:'source-run',threadId:'native-thread'});
 assert.equal(resumed.tools.sha256,hash(JSON.stringify(oldTools)));
 assert.equal(resumed.tools.status,'saved');
 assert.match(resumed.sections[0].text,/Saved old description/);
 assert.match(resumed.sections[0].text,/inputSchema.properties.arg.description:\nSaved argument documentation/);
 assert.doesNotMatch(JSON.stringify(resumed),/NEW CURRENT DESCRIPTION/);
 assert.equal(resumed.sections[0].wireSha256,hash(JSON.stringify(oldTools[0])));
 assert.equal(resumed.tools.sourceRunId,'source-run');
 const twice=withSavedToolDefinitions(current,resumed,{names:['fixture'],sourceRunId:'next-run',threadId:'native-thread'});
 assert.equal(twice.sections[0].source,resumed.sections[0].source);
 assert.equal(twice.tools.sourceRunId,'source-run');
 const unknown=withInstructionAcceptance(withSavedToolDefinitions(current,null,{names:['fixture'],threadId:'historic-thread'}));
 assert.equal(unknown.tools.status,'unavailable');assert.equal(unknown.tools.sha256,null);
 assert.equal(unknown.sections[0].status,'unavailable');assert.equal(unknown.totals.toolDefinitionCharacters,0);
 assert.doesNotMatch(JSON.stringify(unknown),/NEW CURRENT DESCRIPTION/);
 assert.match(unknown.sections[0].reason,/actual descriptions were not captured/);
 assert.equal(original.sections[0].status,'accepted');
});

test('on-demand skill audit records only delivered content and groups identical rereads',()=>{
 const base=createInstructionAudit();
 const skill={id:'owner-fixture',title:'Owner procedure',source:'user',revision:3,content:'# Method\nDo the owner-selected work.'};
 const wire=JSON.stringify(skill);
 const first=withDeliveredSkillInstructions(base,skill,wire);
 assert.equal(first.sections.length,1);assert.equal(base.sections.length,0);
 assert.equal(first.sections[0].role,'tool');assert.equal(first.sections[0].status,'delivered');assert.equal(first.sections[0].text,skill.content);
 const repeated=withDeliveredSkillInstructions(first,skill,wire);
 assert.equal(repeated.sections.length,1);assert.equal(repeated.sections[0].deliveries,2);
 const changed=withDeliveredSkillInstructions(repeated,{...skill,revision:4,content:'Updated method'},JSON.stringify({...skill,revision:4,content:'Updated method'}));
 assert.equal(changed.sections.length,2);assert.deepEqual(changed.sections.map(item=>item.revision),[3,4]);
});

test('engine audits owner skill replacements, deleted overlays, active SOUL and exact adapter payload', {timeout:20000}, async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-instruction-audit-'));
 const cwd=path.join(dir,'workspace');await mkdir(cwd);
 const dataDir=path.join(dir,'data');
 const identity=await new IdentityStore({dataDir}).init();
 const savedSoul=await identity.read('soul');
 const firstSoul=await identity.update({kind:'soul',content:'# Owner behavior\nFIRST_ACTIVE_SOUL',expectedRevision:savedSoul.revision,expectedHash:savedSoul.diskHash});
 const savedUser=await identity.read('user');
 await identity.update({kind:'user',content:'# User\nPRIVATE_PROFILE_MARKER',expectedRevision:savedUser.revision,expectedHash:savedUser.diskHash});
 const catalog=createSkillsCatalog({dataDir}),skillId='library-what-makes-done';
 const bundled=await catalog.detail({id:skillId});
 const firstSkill=await catalog.save({id:skillId,value:{expectedRevision:bundled.revision,content:'# Owner procedure\nFIRST_OWNER_SKILL'}});
 let admit,release;const entered=new Promise(resolve=>admit=resolve),gate=new Promise(resolve=>release=resolve);
 class Runtime extends EventEmitter {
  calls=[];store={get:()=>({baseUrl:'https://fixture.invalid/v1'})};
  status(){return {connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]};}
  async runAgent(options){
   this.calls.push(options);
   options.onInstructionAuditPrepared?.({developerInstructions:options.developerInstructions+'\nFIXTURE_ADAPTER',adapter:'fixture',role:'system',source:'offline test'});
   options.onPromptAccepted?.(options.prompt);
   if(this.calls.length===1){admit();await gate;}
   return {output:'Fixture complete.',threadId:'fixture-'+this.calls.length};
  }
 }
 const runtime=new Runtime(),engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd,identity}).init();
 engine.runtimeSettings={get:()=>({subagentsEnabled:false,executionGuardrails:false})};
 t.after(async()=>{release();await engine.close();await identity.close();await catalog.close();await rm(dir,{recursive:true,force:true});});
 const workflow={name:'Instruction audit fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture::remote',prompt:'Reply briefly.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}};
 const first=engine.startRun({workflow,input:{task:'Explain the fixture.',directoryMode:'off'}});
 await entered;
 const snapshot=engine.getRun(first.id).nodes.agent.instructionAudit;
 assert.equal(snapshot.captureStage,'adapter-prepared');assert.equal(snapshot.delivery,'accepted');
 assert.equal(snapshot.sections.filter(item=>item.layer==='developer').map(item=>item.text).join(''),runtime.calls[0].developerInstructions+'\nFIXTURE_ADAPTER');
 assert.equal(snapshot.sections.find(item=>item.id==='soul').revision,firstSoul.revision);
 assert.equal(snapshot.sections.find(item=>item.id==='skill-'+skillId).revision,firstSkill.revision);
 assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_PROFILE_MARKER|GENERAL ANALYTICAL METHOD/);
 const secondSoul=await identity.update({kind:'soul',content:'# Owner behavior\nSECOND_ACTIVE_SOUL',expectedRevision:firstSoul.revision,expectedHash:firstSoul.diskHash});
 const secondSkill=await catalog.save({id:skillId,value:{expectedRevision:firstSkill.revision,content:'# Owner procedure\nSECOND_OWNER_SKILL\n'+'x'.repeat(21000)+'\nEND_OF_OWNER_SKILL'}});
 release();await engine.executions.get(first.id);
 assert.equal(engine.getRun(first.id).status,'completed',engine.getRun(first.id).error);
 assert.deepEqual(engine.getRun(first.id).nodes.agent.instructionAudit,snapshot);
 const second=engine.startRun({workflow,input:{task:'Explain the next fixture.',directoryMode:'off'}});await engine.executions.get(second.id);
 const later=engine.getRun(second.id).nodes.agent.instructionAudit;
 assert.equal(later.sections.find(item=>item.id==='soul').revision,secondSoul.revision);
 assert.match(later.sections.find(item=>item.id==='soul').text,/SECOND_ACTIVE_SOUL/);
 assert.match(later.sections.find(item=>item.id==='skill-'+skillId).text,/SECOND_OWNER_SKILL/);
 assert.match(later.sections.find(item=>item.id==='skill-'+skillId).text,/END_OF_OWNER_SKILL/);
 assert.doesNotMatch(JSON.stringify(later),/FIRST_ACTIVE_SOUL|FIRST_OWNER_SKILL/);
 await catalog.delete({id:skillId,value:{expectedRevision:secondSkill.revision}});
 const third=engine.startRun({workflow,input:{task:'Explain the last fixture.',directoryMode:'off'}});await engine.executions.get(third.id);
 assert.equal(engine.getRun(third.id).status,'completed',engine.getRun(third.id).error);
 assert.ok(!engine.getRun(third.id).nodes.agent.instructionAudit.sections.some(item=>item.id==='skill-'+skillId));
 assert.doesNotMatch(runtime.calls.at(-1).prompt,/FIRST_OWNER_SKILL|SECOND_OWNER_SKILL|WHAT MAKES DONE/);
 const intent=await catalog.detail({id:'library-intent-inference'});
 const longIntent='# Owner intent method\n'+'a'.repeat(21000)+'\nINTENT_TAIL_SENT';
 await catalog.save({id:intent.id,value:{expectedRevision:intent.revision,content:longIntent}});
 const selected=engine.startRun({workflow:{...workflow,id:'mission_chat_audit_fixture',description:'A focused task started from Mission.'},input:{task:'Use the intent inference skill. Explain its steps.',directoryMode:'off'}});
 await engine.executions.get(selected.id);assert.equal(engine.getRun(selected.id).status,'completed',engine.getRun(selected.id).error);
 assert.match(runtime.calls.at(-1).prompt,/INTENT_TAIL_SENT/);
 assert.match(engine.getRun(selected.id).nodes.agent.instructionAudit.sections.find(item=>item.id==='skill-library-intent-inference').text,/INTENT_TAIL_SENT/);

});

test('delegated execution has a separate exact audit with frozen SOUL and assignment-relevant methods', {timeout:20000}, async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-delegate-audit-')),cwd=path.join(dir,'workspace');await mkdir(cwd);
 const dataDir=path.join(dir,'data'),identity=await new IdentityStore({dataDir}).init();
 const original=await identity.read('soul');
 const soul=await identity.update({kind:'soul',content:'# Owner behavior\nDELEGATE_FROZEN_SOUL',expectedRevision:original.revision,expectedHash:original.diskHash});
 const user=await identity.read('user');await identity.update({kind:'user',content:'PRIVATE_DELEGATE_PROFILE',expectedRevision:user.revision,expectedHash:user.diskHash});
 const catalog=createSkillsCatalog({dataDir}),method=await catalog.detail({id:'library-what-makes-done'});
 await catalog.save({id:method.id,value:{expectedRevision:method.revision,content:'# Completion\nOWNER_SHARED_COMPLETION'}});
 const jobMethod=await catalog.detail({id:'library-job-search'});
 await catalog.save({id:jobMethod.id,value:{expectedRevision:jobMethod.revision,content:'# Job search\nOWNER_JOB_ONLY'}});

 let childCall;
 class Runtime extends EventEmitter {
  store={get:()=>({baseUrl:'https://fixture.invalid/v1'})};
  status(){return {connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]};}
  async runAgent(options){
   const child=options.prompt.startsWith('You are a short-lived BLACKICE subagent.');
   options.onInstructionAuditPrepared?.({developerInstructions:options.developerInstructions+(child?'\nCHILD_ADAPTER':'\nPARENT_ADAPTER'),adapter:'fixture',role:'system',source:'offline delegate test'});
   options.onPromptAccepted?.(options.prompt);
   if(child){childCall=options;return {output:'Worker checked the assigned fixture.'};}
   const result=await options.onToolCall({name:'relay_delegate',arguments:{tasks:[{id:'review',prompt:'Inspect the synthetic fixture and report its result.',readOnly:true},{id:'reference',prompt:'Inspect a separate reference fixture and report its result.',readOnly:true}]}});
   assert.equal(result.success,true,result.contentItems?.[0]?.text);
   return {output:'Coordinator combined the result.'};
  }
 }
 const runtime=new Runtime(),engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd,identity}).init();
 engine.runtimeSettings={get:()=>({subagentsEnabled:true,maxSubagents:2,executionGuardrails:false})};
 t.after(async()=>{await engine.close();await identity.close();await catalog.close();await rm(dir,{recursive:true,force:true});});
 const workflow={id:'mission_chat_delegate_audit',description:'A focused task started from Mission.',name:'Delegated instruction audit',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture::remote',prompt:'Delegate an independent fixture check.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}};
 const started=engine.startRun({workflow,input:{task:'Use the job search skill. Inspect a synthetic fixture.',directoryMode:'off'}});await engine.executions.get(started.id);
 const run=engine.getRun(started.id);assert.equal(run.status,'completed',run.error);
 const parent=run.nodes.agent.instructionAudit,delegate=parent.delegates.find(item=>item.id==='review');
 assert.equal(delegate.label,'review');assert.ok(delegate.nodeId);assert.equal(delegate.audit.captureStage,'adapter-prepared');assert.equal(delegate.audit.delivery,'accepted');
 assert.equal(delegate.audit.sections.filter(item=>item.layer==='developer').map(item=>item.text).join(''),childCall.developerInstructions+'\nCHILD_ADAPTER');
 assert.equal(delegate.audit.sections.find(item=>item.id==='soul').revision,soul.revision);
 assert.match(childCall.prompt,/DELEGATE_FROZEN_SOUL|OWNER_SHARED_COMPLETION/);
 assert.doesNotMatch(childCall.prompt,/PRIVATE_DELEGATE_PROFILE|OWNER_JOB_ONLY/);
 assert.match(parent.sections.find(item=>item.id==='skill-library-job-search').text,/OWNER_JOB_ONLY/);
 assert.equal(parent.delegates.length,2);
 assert.deepEqual(new Set(parent.delegates.map(item=>item.id)),new Set(['review','reference']));
 assert.match(delegate.audit.sections.find(item=>item.id==='inherited-skill-library-what-makes-done').text,/OWNER_SHARED_COMPLETION/);
 assert.doesNotMatch(parent.sections.map(item=>item.text).join(''),/CHILD_ADAPTER/);
 assert.ok(delegate.audit.sections.some(item=>item.source==='lib/subagents.mjs'));
});
