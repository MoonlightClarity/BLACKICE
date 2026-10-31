import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { CodexRuntime } from '../lib/codex.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { KnowledgeStore } from '../lib/knowledge.mjs';
import { WORKSPACE_TOOL } from '../lib/workspace-tools.mjs';
import { capabilityGuidance } from '../lib/tool-routing.mjs';
import { estimateContextTokens } from '../lib/context.mjs';

const until=async(check,label='routing condition')=>{const end=Date.now()+5000;while(Date.now()<end){const result=check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not settle`);};
const graph=model=>({id:'routing-workflow',name:'Tool routing protocol test',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',prompt:'Answer the current request using attached capabilities when needed.',model},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}});
const manifest=instructions=>JSON.parse(instructions.split('ACTUAL ATTACHED CATALOG\n')[1].split('\nTOOL SELECTION PLAYBOOKS')[0]);
const occurrences=(text,part)=>text.split(part).length-1;
class OfflineCodex extends EventEmitter{status(){return{connected:false,authenticated:false,models:[],defaultModel:null};}async close(){}}
const response=(type,text)=>type==='openai'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:20,output_tokens:3,total_tokens:23}}:type==='anthropic'?{content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:3}}:{choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:3,total_tokens:23}};

for(const type of ['openai','anthropic','compatible'])test(`${type}: the engine sends fresh exact capability guidance in the real instruction layer and keeps user history clean`,async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'relay-routing-provider-')),cwd=path.join(directory,'workspace');await mkdir(cwd);const requests=[],server=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString())});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response(type,`Verified routing turn ${requests.length}.`)));}catch(cause){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:cause.message}}));}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const runtime=await new ProviderRuntime({dataDir:directory,codex:new OfflineCodex()}).init();await runtime.saveProvider({id:'routing',type,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'routing-fixture-session-key',models:['routing-model']});const knowledge=await new KnowledgeStore({dataDir:directory}).init(),engine=await new HarnessEngine({runtime,dataDir:directory,defaultCwd:cwd,knowledge}).init();
  t.after(async()=>{await engine.close();await runtime.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.match(path.basename(directory),/^relay-routing-provider-/);await rm(directory,{recursive:true,force:true});});
  const settled=id=>until(()=>{const run=engine.getRun(id);return run.settled&&run;},'provider engine run');
  const first=engine.startRun({workflow:graph('routing::routing-model'),input:'FIRST_ROUTING_USER_MESSAGE'}),one=await settled(first.id);assert.equal(one.status,'completed',one.error);
  const instructions=body=>type==='openai'?body.instructions:type==='anthropic'?body.system:body.messages.find(message=>message.role==='system')?.content;
  const messages=body=>type==='openai'?body.input:body.messages.filter(message=>message.role!=='system');
  const toolNames=body=>(body.tools||[]).map(tool=>type==='compatible'?tool.function.name:tool.name);
  const firstInstructions=instructions(requests[0].body);assert.equal(typeof firstInstructions,'string');assert.match(firstInstructions,/CAPABILITY ROUTING — BEFORE ACTION/);assert.match(firstInstructions,/GENERAL ANALYTICAL METHOD/);
  assert.match(firstInstructions,/actual candidate wording, designs, allocations or rival predictions under common conditions/);
  assert.match(firstInstructions,/reasoning operations, not mandatory stages, fields or an output template/);
  assert.match(firstInstructions,/evidence and fit threshold for the next authorized action/);
  assert.deepEqual(manifest(firstInstructions).map(item=>item.name),toolNames(requests[0].body));assert.deepEqual(new Set(toolNames(requests[0].body)),new Set(['relay_workspace','relay_control','relay_memory','relay_skills','relay_history']));for(const name of ['relay_browser','relay_desktop','relay_connections','relay_identity','relay_files','relay_task'])assert.ok(!manifest(firstInstructions).some(item=>item.name===name),name);
  assert.ok(!JSON.stringify(messages(requests[0].body)).includes('CAPABILITY ROUTING — BEFORE ACTION'),'routing policy must not exist only in a user prompt');
  // Remote providers can receive a genuinely updated catalog on their next turn.
  engine.knowledge=null;const second=engine.continueRun(first.id,{nodeId:'agent',message:'SECOND_ROUTING_USER_MESSAGE'}),two=await settled(second.id);assert.equal(two.status,'completed',two.error);assert.equal(two.nodes.agent.threadId,one.nodes.agent.threadId);assert.equal(requests.length,2);
  const latest=requests[1].body,current=instructions(latest);assert.deepEqual(toolNames(latest),['relay_workspace','relay_control']);assert.deepEqual(manifest(current).map(item=>item.name),['relay_workspace','relay_control']);assert.ok(!current.includes('relay_memory'));assert.ok(!current.includes('relay_skills'));assert.equal(occurrences(current,'CAPABILITY ROUTING — BEFORE ACTION'),1);
  const userMessages=messages(latest).filter(message=>message.role==='user'),history=JSON.stringify(messages(latest));assert.equal(userMessages.length,2);assert.equal(userMessages.filter(message=>JSON.stringify(message.content).includes('FIRST_ROUTING_USER_MESSAGE')).length,1);assert.equal(userMessages.filter(message=>JSON.stringify(message.content).includes('SECOND_ROUTING_USER_MESSAGE')).length,1);assert.equal(occurrences(history,'CAPABILITY ROUTING — BEFORE ACTION'),0);if(type==='compatible')assert.equal(latest.messages.filter(message=>message.role==='system').length,1);
  const disk=JSON.parse(await readFile(path.join(directory,'provider-threads',two.nodes.agent.threadId+'.json'),'utf8'));assert.equal(disk.developerInstructions,current);assert.equal(occurrences(JSON.stringify(disk.messages),'CAPABILITY ROUTING — BEFORE ACTION'),0);assert.equal(disk.transcript.filter(message=>message.role==='user'&&JSON.stringify(message.content).includes('FIRST_ROUTING_USER_MESSAGE')).length,1);
  const bareEstimate=estimateContextTokens([disk.messages,latest.tools]);assert.ok(two.nodes.agent.contextStatus.estimatedInputTokens>bareEstimate+200,'the real context budget includes developer instructions rather than counting only user history');
});

const fixtureSource=String.raw`import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n'),reply=(id,result)=>send({id,result}),notice=(method,params)=>send({method,params});
const threads=new Map();let counter=0,skillConfig={},configUnavailable=false;
readline.createInterface({input:process.stdin}).on('line',line=>{const {id,method,params={}}=JSON.parse(line);if(id===undefined)return;appendFileSync(process.argv[2],JSON.stringify({method,params})+'\n');
if(method==='initialize')return reply(id,{});
if(method==='account/read')return reply(id,{account:{type:'chatgpt',planType:'fixture'},requiresOpenaiAuth:true});
if(method==='model/list')return reply(id,{data:[{id:'routing-native-model',model:'routing-native-model',isDefault:true,supportedReasoningEfforts:[]}],nextCursor:null});
if(method==='fixture/config'){skillConfig=params.config;configUnavailable=params.unavailable===true;return reply(id,{});}
if(method==='config/read'){if(configUnavailable)return send({id,error:{code:-32601,message:'config/read unavailable'}});return reply(id,{config:skillConfig});}
if(method==='skills/list')return reply(id,{data:params.cwds.map(cwd=>({cwd,skills:[{path:process.platform==='win32'?'C:/fixture/browseros-neo/SKILL.md':'/fixture/browseros-neo/SKILL.md'}],errors:[]}))});
if(method==='thread/start'){const threadId='routing-native-'+(++counter);threads.set(threadId,{instructions:params.developerInstructions||'',tools:params.dynamicTools||[],turns:0});return reply(id,{thread:{id:threadId,...(params.ephemeral===true?{ephemeral:true}:{})},model:'routing-native-model'});}
if(method==='fixture/restoreLegacyCatalog'){const state=threads.get(params.threadId);state.tools=state.tools.filter(tool=>params.names.includes(tool.name));return reply(id,{names:state.tools.map(tool=>tool.name)});}
if(method==='thread/resume'){const state=threads.get(params.threadId);if(params.developerInstructions!==undefined)state.instructions=params.developerInstructions;return reply(id,{thread:{id:params.threadId},model:'routing-native-model'});}
if(method==='turn/start'){const state=threads.get(params.threadId),turnId='native-turn-'+(++counter);state.turns++;reply(id,{turn:{id:turnId}});const item={type:'agentMessage',id:'reply-'+turnId,text:JSON.stringify({instructions:state.instructions,tools:state.tools.map(tool=>tool.name),input:params.input})};setImmediate(()=>{notice('turn/started',{threadId:params.threadId,turn:{id:turnId,status:'inProgress'}});notice('item/completed',{threadId:params.threadId,turnId,item});notice('thread/tokenUsage/updated',{threadId:params.threadId,turnId,tokenUsage:{total:{inputTokens:state.turns*20,outputTokens:state.turns*5,totalTokens:state.turns*25},last:{inputTokens:20,outputTokens:5,totalTokens:25},modelContextWindow:128000}});notice('turn/completed',{threadId:params.threadId,turn:{id:turnId,status:'completed',items:[item]}});});return;}
reply(id,{});});`;
async function nativeHarness(t){const directory=await mkdtemp(path.join(tmpdir(),'relay-routing-native-')),cwd=path.join(directory,'workspace');await mkdir(cwd);const fixture=path.join(directory,'app-server.mjs'),log=path.join(directory,'wire.jsonl'),cleanup=[];await writeFile(fixture,fixtureSource);const runtime=new CodexRuntime({command:process.execPath,args:[fixture,log],cwd,requestTimeoutMs:3000,runTimeoutMs:5000});t.after(async()=>{for(const close of cleanup)await close();await runtime.close();assert.match(path.basename(directory),/^relay-routing-native-/);await rm(directory,{recursive:true,force:true});});return{directory,cwd,runtime,cleanup,wire:async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};}

test('native Codex sends actual developerInstructions on thread/start and thread/resume while turn input contains only its user prompt',async t=>{
  const {runtime,cwd,wire}=await nativeHarness(t),firstInstructions=capabilityGuidance([WORKSPACE_TOOL])+'\nFIRST_DEVELOPER_POLICY',secondInstructions=capabilityGuidance([WORKSPACE_TOOL])+'\nUPDATED_SECOND_DEVELOPER_POLICY';
  const first=await runtime.runAgent({cwd,prompt:'FIRST_NATIVE_USER_MESSAGE',developerInstructions:firstInstructions,dynamicTools:[WORKSPACE_TOOL]});const one=JSON.parse(first.output);assert.equal(one.instructions,firstInstructions);assert.deepEqual(one.tools,['relay_workspace']);assert.deepEqual(one.input,[{type:'text',text:'FIRST_NATIVE_USER_MESSAGE'}]);
  const second=await runtime.runAgent({cwd,prompt:'SECOND_NATIVE_USER_MESSAGE',threadId:first.threadId,usageBaseline:first.usage.total,developerInstructions:secondInstructions,dynamicTools:[WORKSPACE_TOOL]});const two=JSON.parse(second.output);assert.equal(two.instructions,secondInstructions);assert.ok(!two.instructions.includes('FIRST_DEVELOPER_POLICY'));assert.deepEqual(two.input,[{type:'text',text:'SECOND_NATIVE_USER_MESSAGE'}]);
  const records=await wire(),start=records.find(item=>item.method==='thread/start'),resume=records.find(item=>item.method==='thread/resume');assert.equal(start.params.developerInstructions,firstInstructions);assert.equal(resume.params.developerInstructions,secondInstructions);assert.equal(resume.params.threadId,first.threadId);assert.equal(resume.params.dynamicTools,undefined,'native saved catalogs are not extended on resume');for(const turn of records.filter(item=>item.method==='turn/start'))assert.ok(!JSON.stringify(turn.params.input).includes('CAPABILITY ROUTING'));
  assert.equal(occurrences(two.instructions,'CAPABILITY ROUTING — BEFORE ACTION'),1);assert.ok(second.context.estimatedInputTokens>=estimateContextTokens([secondInstructions,'SECOND_NATIVE_USER_MESSAGE']));
});

test('engine native follow-up guidance excludes newly available tools that are absent from the original saved catalog',async t=>{
  const {runtime,directory,cwd,wire,cleanup}=await nativeHarness(t);await runtime.start();const engine=await new HarnessEngine({runtime,dataDir:directory,defaultCwd:cwd}).init();cleanup.push(()=>engine.close());const settled=id=>until(()=>{const run=engine.getRun(id);return run.settled&&run;},'native engine run');
  const first=engine.startRun({workflow:graph('routing-native-model'),input:'NATIVE_ENGINE_FIRST'}),one=await settled(first.id);assert.equal(one.status,'completed',one.error);assert.deepEqual(one.nodes.agent.toolNames,['relay_workspace','relay_control']);
  // Restore both the actual fixture thread and saved run to the pre-control catalog.
  const legacy=await runtime._request('fixture/restoreLegacyCatalog',{threadId:one.nodes.agent.threadId,names:['relay_workspace']});assert.deepEqual(legacy.names,['relay_workspace']);engine.runs.get(first.id).nodes.agent.toolNames=['relay_workspace'];
  engine.browser={status:()=>({available:true})};engine.connections={list:()=>[],redact:value=>String(value)};const next=engine.continueRun(first.id,{nodeId:'agent',message:'NATIVE_ENGINE_FOLLOWUP'}),two=await settled(next.id);assert.equal(two.status,'completed',two.error);const receipt=JSON.parse(two.nodes.agent.output);assert.deepEqual(receipt.tools,['relay_workspace']);assert.deepEqual(manifest(receipt.instructions).map(item=>item.name),['relay_workspace']);assert.doesNotMatch(receipt.instructions,/relay_control:|relay_browser:|relay_connections:/);assert.equal(two.nodes.agent.threadId,one.nodes.agent.threadId);
  const records=await wire(),resume=records.find(item=>item.method==='thread/resume');assert.match(resume.params.developerInstructions,/ACTUAL ATTACHED CATALOG/);assert.equal(resume.params.dynamicTools,undefined);const turn=records.filter(item=>item.method==='turn/start').at(-1);assert.equal(occurrences(JSON.stringify(turn.params.input),'NATIVE_ENGINE_FOLLOWUP'),1);assert.equal(occurrences(JSON.stringify(turn.params.input),'CAPABILITY ROUTING — BEFORE ACTION'),0);
});

test('the legacy relay history setting preserves native continuation and contained browser routing in developer instructions', async t => {
  const { runtime, directory, cwd, wire, cleanup } = await nativeHarness(t);
  await runtime.start();
  const engine = await new HarnessEngine({ runtime, dataDir: directory, defaultCwd: cwd }).init();
  cleanup.push(() => engine.close());
  engine.runtimeSettings = { get: () => ({ codexHistory: 'relay' }) };
  engine.browser = { status: () => ({ available: true, contained: true, browsers: { relay: { available: true } } }) };
  engine.connections = { list: () => [{ id: 'optional-browser', enabled: true, connected: false, error: 'fetch failed' }], redact: value => String(value) };
  const settled = id => until(() => { const run = engine.getRun(id); return run.settled && run; }, 'browser routing run');
  const firstInput = 'Inspect the current website.';
  const first = engine.startRun({ workflow: graph('routing-native-model'), input: firstInput });
  const one = await settled(first.id);
  assert.equal(one.status, 'completed', one.error);
  const firstReceipt = JSON.parse(one.nodes.agent.output);
  assert.ok(firstReceipt.tools.includes('relay_browser'));
  assert.ok(firstReceipt.tools.includes('relay_connections'));
  assert.match(firstReceipt.instructions, /A tool or method named in a prior assistant plan/);
  assert.match(firstReceipt.instructions, /Use only the BLACKICE contained browser/);
  assert.match(firstReceipt.instructions, /Never attach or launch Chrome/);
  assert.match(firstReceipt.instructions, /empty tabs list means this task has no visible pages/);
  assert.match(firstReceipt.instructions, /complete independent work/);
  assert.equal(one.input, firstInput);
  const selectedInput = 'Continue this website task using only the BLACKICE browser.';
  const second = engine.continueRun(first.id, { nodeId: 'agent', message: selectedInput });
  const two = await settled(second.id);
  assert.equal(two.status, 'completed', two.error);
  assert.equal(two.taskId, one.taskId);
  assert.equal(two.input, selectedInput);
  assert.equal(two.nodes.agent.codexHistory, 'codex');
  assert.equal(two.nodes.agent.threadId, one.nodes.agent.threadId);
  const secondReceipt = JSON.parse(two.nodes.agent.output);
  assert.match(secondReceipt.instructions, /Use only the BLACKICE contained browser/);
  assert.match(secondReceipt.instructions, /All website work stays in the BLACKICE contained relay_browser/);
  assert.ok(JSON.stringify(secondReceipt.input).includes(selectedInput));
  assert.deepEqual(manifest(secondReceipt.instructions).map(item => item.name), secondReceipt.tools);
  const openings = (await wire()).filter(item => ['thread/start', 'thread/resume'].includes(item.method));
  assert.deepEqual(openings.map(item => item.method), ['thread/start', 'thread/resume'], 'The legacy setting preserves the saved native thread.');
  for (const record of openings) {
    assert.match(record.params.developerInstructions, /Use only the BLACKICE contained browser/);
    assert.match(record.params.developerInstructions, /Native browser adapters are not exposed to this task/);
  }
});

const browserScopeSkillPath = process.platform === 'win32' ? 'C:/fixture/browseros-neo/SKILL.md' : '/fixture/browseros-neo/SKILL.md';
const browserScopeTool = { name: 'relay_browser', description: 'Contained browser fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };

test('native contained-browser sessions exclude Neo while preserving existing skill settings across start and resume', async t => {
  const { runtime, cwd, wire } = await nativeHarness(t);
  await runtime.start();
  const existing = [
    { name: 'unrelated-disabled', enabled: false, marker: 'preserve' },
    { name: 'browseros-neo', enabled: true, marker: 'preserve-neo-metadata' },
    { path: 'C:/fixture/browseros-neo/SKILL.md', enabled: true },
  ];
  await runtime._request('fixture/config', { config: { skills: { config: existing } } });
  const expected = [...existing, { path: browserScopeSkillPath, enabled: false }];
  const options = { cwd, dynamicTools: [WORKSPACE_TOOL, browserScopeTool] };
  const first = await runtime.runAgent({ ...options, prompt: 'FIRST_SCOPE_MESSAGE' });
  await runtime.runAgent({ ...options, prompt: 'CONTINUED_SCOPE_MESSAGE', threadId: first.threadId, usageBaseline: first.usage.total });
  await runtime._request('fixture/config', { config: { skills: { config: expected } } });
  await runtime.runAgent({ ...options, prompt: 'RELAY_HISTORY_SCOPE_MESSAGE', codexHistory: 'relay' });
  const records = await wire(), openings = records.filter(record => ['thread/start', 'thread/resume'].includes(record.method));
  assert.equal(openings.length, 3);
  for (const [index, record] of openings.entries()) {
    assert.deepEqual(record.params.config?.['skills.config'], index < 2 ? expected : [...expected, { path: browserScopeSkillPath, enabled: false }]);
    assert.equal(record.params.config?.['features.apps'], false);
    assert.equal(record.params.config?.['features.remote_plugin'], false);
  }
  const reads = records.filter(record => record.method === 'config/read');
  assert.equal(reads.length, 3);
  for (const record of reads) assert.deepEqual(record.params, { cwd, includeLayers: false });
  for (const turn of records.filter(record => record.method === 'turn/start')) assert.ok(!JSON.stringify(turn.params.input).includes('browseros-neo'), 'skill scoping must not be task-prompt coaching');
  assert.equal(existing[1].enabled, true, 'the inherited configuration was not mutated');
});

test('native browser exclusion accepts absent skill settings and remains active without an attached contained browser', async t => {
  const { runtime, cwd, wire } = await nativeHarness(t);
  await runtime.start();
  await runtime._request('fixture/config', { config: { skills: null } });
  await runtime.runAgent({ cwd, prompt: 'CONTAINED_SCOPE', dynamicTools: [browserScopeTool] });
  await runtime.runAgent({ cwd, prompt: 'NO_BROWSER_SCOPE', dynamicTools: [WORKSPACE_TOOL] });
  const records = await wire(), openings = records.filter(record => record.method === 'thread/start');
  for (const opening of openings) {
    assert.deepEqual(opening.params.config?.['skills.config'], [{ path: browserScopeSkillPath, enabled: false }]);
    assert.equal(opening.params.config?.['features.apps'], false);
    assert.equal(opening.params.config?.['features.remote_plugin'], false);
  }
  assert.equal(records.filter(record => record.method === 'config/read').length, 2);
});


test('native start and resume keep ambient Chrome plugins and MCP adapters disabled when the contained browser is unavailable', async t => {
  const { runtime, cwd, wire } = await nativeHarness(t);
  await runtime.start();
  const config = {
    plugins: { 'chrome-tools': { enabled: true } },
    mcp_servers: { 'custom-browser-alias': { enabled: true, command: 'chrome-devtools-mcp' } },
  };
  await runtime._request('fixture/config', { config });
  const options = { cwd, dynamicTools: [WORKSPACE_TOOL] };
  const first = await runtime.runAgent({ ...options, prompt: 'No contained browser is attached; prepare local work.' });
  await runtime.runAgent({ ...options, prompt: 'Continue the same preparation.', threadId: first.threadId, usageBaseline: first.usage.total });
  const openings = (await wire()).filter(record => ['thread/start', 'thread/resume'].includes(record.method));
  assert.equal(openings.length, 2);
  for (const record of openings) {
    assert.deepEqual(record.params.config?.plugins, { 'chrome-tools': { enabled: false } });
    assert.deepEqual(record.params.config?.mcp_servers, { 'custom-browser-alias': { enabled: false } });
    assert.equal(record.params.config?.['features.apps'], false);
    assert.equal(record.params.config?.['features.remote_plugin'], false);
  }
  assert.equal(config.plugins['chrome-tools'].enabled, true);
  assert.equal(config.mcp_servers['custom-browser-alias'].enabled, true);
});

test('native contained-browser scope does not start a model turn with unreadable or malformed inherited skill configuration', async t => {
  const { runtime, cwd, wire } = await nativeHarness(t);
  await runtime.start();
  await runtime._request('fixture/config', { unavailable: true });
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'UNREADABLE_SCOPE', dynamicTools: [browserScopeTool] }), error => error.code === 'CODEX_CAPABILITY_SCOPE_UNAVAILABLE');
  await runtime._request('fixture/config', { config: { skills: { config: {} } } });
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'MALFORMED_SCOPE', dynamicTools: [browserScopeTool] }), error => error.code === 'CODEX_CAPABILITY_SCOPE_UNAVAILABLE');
  const records = await wire();
  assert.equal(records.filter(record => ['thread/start', 'thread/resume', 'turn/start'].includes(record.method)).length, 0);
});
