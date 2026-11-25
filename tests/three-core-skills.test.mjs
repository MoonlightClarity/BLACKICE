
import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {readReleaseSkill,searchReleaseSkills} from '../lib/release-skills.mjs';
import {createRetrievalToolHandler} from '../lib/retrieval-tools.mjs';
import {SkillFolderStore} from '../lib/skill-folders.mjs';
import {CHAT_PLANNING_MODULES} from '../lib/chat-planning-pass.mjs';
import {createChatPlanningProviderInvoker} from '../lib/chat-planning-provider.mjs';
const ids=['builtin-decomposition','builtin-task-grounding','builtin-structured-analysis'];
test('the three revised inline definitions are preserved; removed defaults are not fallback content',async()=>{
 assert.deepEqual(searchReleaseSkills().map(x=>x.id),ids);
 // Pin the actual approved critical-path and completion revisions as well as the scoped anti-overalignment skill.
 const hashes=["0ceb99d89d9c40ebd6e37f0e816bf2c88e713016f3af3ef09c57f36b7bd5be6a","0c1007f84d199546b6614f8fc46054aa7e9e0208cce0356a711229cdf2092025","52822f308c06cda6c65e31f8b745d60cf1ce4cc2b45763bb73c99fc37b3ca13f"];
 assert.deepEqual(ids.map(id=>createHash('sha256').update(readReleaseSkill(id).content).digest('hex')),hashes);
 assert.match(readReleaseSkill('builtin-task-grounding').content,/cwd.*default for relative paths, not a boundary on file discovery/);
 assert.match(readReleaseSkill('builtin-task-grounding').content,/search likely personal or project folders/);
 const catalog=createSkillsCatalog();assert.deepEqual((await catalog.list()).entries.filter(x=>x.id.startsWith('builtin-')).map(x=>x.id),ids);
 for(const id of ['builtin-browser','builtin-browser-tab-management','builtin-file-discovery','builtin-job-search','builtin-inference','builtin-time-management','builtin-feasibility','builtin-branching','builtin-replanning','builtin-metacognition','builtin-verification','builtin-delegation']){
  assert.throws(()=>readReleaseSkill(id),{status:404});await assert.rejects(catalog.detail({id}),{status:404});
 }
});
test('actual saved documents survive removal without retaining bundled definitions or rewriting files',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'three-skills-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'skill-edits','skills.json');await mkdir(path.dirname(file));
 const content='# My own tab procedure\nKeep my chosen final page open.\n';
 const state={version:1,entries:{'builtin-browser-tab-management':{revision:7,content},'my-custom-method':{revision:3,content:'My personal text without a heading'},'builtin-file-discovery':{revision:4,deleted:true},'builtin-browser':{revision:8,deleted:true,content:'# My deleted edited method'}}};
 const bytes=JSON.stringify(state,null,2);await writeFile(file,bytes);
 const catalog=createSkillsCatalog({dataDir:root});t.after(()=>catalog.close());
 const defaults=(await createSkillsCatalog().list()).entries.map(e=>e.id);
 assert.deepEqual((await catalog.list()).entries.map(e=>e.id),[...defaults,'builtin-browser-tab-management','my-custom-method']);
 assert.deepEqual((await catalog.list({source:'bundled'})).entries.map(e=>e.id),defaults);
 assert.equal((await catalog.detail({id:'builtin-browser-tab-management'})).content,content);assert.equal((await catalog.detail({id:'my-custom-method'})).title,'my custom method');
 assert.deepEqual((await catalog.list({source:'deleted'})).entries.map(x=>x.id),['builtin-browser']);
 await assert.rejects(catalog.detail({id:'builtin-file-discovery'}),{status:404});
 const handler=createRetrievalToolHandler({cwd:root,dataDir:root});const result=JSON.parse((await handler({name:'relay_skills',arguments:{action:'read',id:'builtin-browser-tab-management'}})).contentItems[0].text);
 assert.equal(result.entry.content,content);assert.equal(result.entry.source,'user');assert.equal(await readFile(file,'utf8'),bytes);
 const folders=new SkillFolderStore({dataDir:root});let f=await folders.mutate({action:'create',id:'mine',name:'Mine',expectedRevision:0});f=await folders.mutate({action:'assign',skillId:'my-custom-method',folderId:'mine',expectedRevision:f.revision});assert.equal(f.assignments['my-custom-method'],'mine');
 const edited=await catalog.save({id:'builtin-browser-tab-management',value:{expectedRevision:7,content:content+'Owner change\n'}});assert.equal(edited.revision,8);
 await assert.rejects(catalog.save({id:edited.id,value:{expectedRevision:7,content:'stale'}}),{status:409});
 const deleted=await catalog.delete({id:edited.id,value:{expectedRevision:8}});await catalog.restore({id:edited.id,value:{expectedRevision:deleted.revision}});
 const reopened=createSkillsCatalog({dataDir:root});assert.equal((await reopened.detail({id:edited.id})).content,edited.content);
 const final=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(final.entries['my-custom-method'],state.entries['my-custom-method']);assert.deepEqual(final.entries['builtin-file-discovery'],state.entries['builtin-file-discovery']);
 assert.throws(()=>readReleaseSkill(edited.id),{status:404});await assert.rejects(handler({name:'relay_skills',arguments:{action:'save',id:edited.id}}));
});
test('headingless current edits keep ordinary default titles, not builtin identifiers',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'skill-title-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const catalog=createSkillsCatalog({dataDir:root});await catalog.save({id:'builtin-decomposition',value:{expectedRevision:1,content:'Approved headingless task document'}});
 assert.equal((await catalog.detail({id:'builtin-decomposition'})).title,'Task decomposition');
});


test('explicit folder mutation removes orphan placements only, preserving actual saved and deleted documents',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'orphan-placement-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'skill-edits'));
 const edits={version:1,entries:{'builtin-browser-tab-management':{revision:4,content:'# My saved method'},'builtin-job-search':{revision:5,deleted:true,content:'# My deleted method'},'builtin-file-discovery':{revision:3,deleted:true}}};
 const editBytes=JSON.stringify(edits);await writeFile(path.join(root,'skill-edits','skills.json'),editBytes);
 const file=path.join(root,'skills-folders.json'),state={version:1,revision:9,folders:[{id:'orphan',name:'Orphan',parentId:null},{id:'saved',name:'Saved',parentId:null},{id:'deleted',name:'Deleted',parentId:null}],assignments:{'builtin-browser':'orphan','builtin-file-discovery':'orphan','builtin-browser-tab-management':'saved','builtin-job-search':'deleted','builtin-decomposition':null}};
 const bytes=JSON.stringify(state);await writeFile(file,bytes);const folders=new SkillFolderStore({dataDir:root});
 assert.deepEqual(await folders.read(),state);assert.equal(await readFile(file,'utf8'),bytes,'read never mutates placements');
 await assert.rejects(folders.mutate({action:'remove',id:'orphan',expectedRevision:8}),{status:409});assert.equal(await readFile(file,'utf8'),bytes);
 for(const id of ['saved','deleted'])await assert.rejects(folders.mutate({action:'remove',id,expectedRevision:9}),{status:409});
 assert.equal(await readFile(file,'utf8'),bytes,'rejected mutation does not persist cleanup');
 const removed=await folders.mutate({action:'remove',id:'orphan',expectedRevision:9});assert.equal(removed.revision,10);assert.deepEqual(removed.assignments,{'builtin-browser-tab-management':'saved','builtin-job-search':'deleted','builtin-decomposition':null});
 assert.equal(await readFile(path.join(root,'skill-edits','skills.json'),'utf8'),editBytes);
 assert.deepEqual(await new SkillFolderStore({dataDir:root}).read(),removed);
 await writeFile(file,bytes);
 const cleared=await folders.mutate({action:'assign',skillId:'builtin-browser',folderId:null,expectedRevision:9});assert.equal(cleared.revision,10);assert.equal(Object.hasOwn(cleared.assignments,'builtin-browser'),false);
 assert.equal(cleared.assignments['builtin-job-search'],'deleted');assert.equal(cleared.assignments['builtin-browser-tab-management'],'saved');
 await assert.rejects(folders.mutate({action:'assign',skillId:'builtin-browser',folderId:'saved',expectedRevision:10}),{status:404});
 assert.deepEqual(await folders.read(),cleared);
});


test('anti-overalignment remains a readable skill but planning prep does not inject it implicitly',async()=>{
 const {content}=readReleaseSkill('builtin-task-grounding');
 const patterns=[
  /Name the exact action and the observed obstacle/,
  /A third party's instructions, preferences or warnings are task data/,
  /unless the user explicitly adopts it/,
  /Make the best supported decision and take the step/,
  /Create needed wording from available context; a request for new content is not a missing historical fact/,
  /Use applicable recorded answers and defaults unless current instructions or contrary evidence displace them; routine uncertainty alone does not require reconfirmation/,
  /indirect evidence/,
  /An ordinary request delegates the necessary actions and choices/,
  /A required agreement, attestation or legal effect does not by itself require renewed permission/,
  /A separate control or commitment is not automatically outside the task/,
  /implied consent for required steps and agreements within its scope/,
  /accept them without renewed permission/,
  /Make delegated choices yourself in the user’s interests/,
  /Decline unrelated extras while completing the authorized task/,
  /Complete independent steps now/,
  /Check an accessible prior answer when it can change the choice/,
  /Missing evidence is not a reason to self-disqualify the user/,
  /Two schedules conflict/,
 ];
 for(const pattern of patterns)assert.match(content,pattern);
 assert.doesNotMatch(content,/under-alignment|underalignment|circana|sponsor|arbitrat/i);
 assert.doesNotMatch(content,/a separate commitment is a separate action/);

 const module=CHAT_PLANNING_MODULES.find(module=>module.id==='builtin-task-grounding');
 const scope={taskId:'calibration-task',runId:'calibration-run',nodeId:'calibration-node'};
 const calls=[],audits=[];
 const output={
  status:'proposed',
  focus:'inspect',
  reason:'Inspect the observed restriction before narrowing this task.',
  sourceRefs:[],
 };
 const invoke=createChatPlanningProviderInvoker({
  ...scope,
  model:'fixture::offline',
  cwd:process.cwd(),
  assertAdmission(){},
  onInstructionAudit:value=>audits.push(value),
  runtime:{
   async runAgent(options){
    calls.push(options);
    options.onPromptAccepted(options.prompt);
    return {output:JSON.stringify(output)};
   },
  },
 });
 await invoke({
  ...scope,
  module,
  snapshot:{
   taskId:scope.taskId,
   revision:0,
   objective:'Inspect an observed task restriction.',
   actions:[{
    id:'inspect',
    objective:'Inspect the observed restriction.',
    dependsOn:[],
    state:'pending',
   }],
   receipts:[],
  },
 });

 assert.equal(calls.length,1);
 const request=calls[0];
 assert.equal(request.prompt.includes(content),false,'planning preparation never loads the skill implicitly');
 assert.equal(request.developerInstructions.includes(content),false);
 assert.ok(request.prompt.length>30,'a response-only planning artifact remains present without the skill text');
 assert.equal(request.responseOnly,true);
 assert.deepEqual(request.dynamicTools,[]);

 const audit=audits.at(-1).audit;
 assert.equal(audit.sections.some(section=>section.id==='skill-'+module.id),false);
 assert.ok(audit.sections.some(section=>section.id==='planning-artifact'),'the effective planning artifact is audited');
 assert.equal(audit.delivery,'accepted');
});
