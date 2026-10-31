import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RuntimeSettingsStore,validateRuntimeSettings} from '../lib/runtime-settings.mjs';
import {CONTROL_TOOL,CONTROL_INSTRUCTIONS,CONTROL_SCHEMA_VERSION,PRE_PERSISTENT_HISTORY_CONTROL_TOOL,PRE_PERSISTENT_HISTORY_CONTROL_INSTRUCTIONS,PRE_CONTEXT_CONTROL_TOOL,PRE_CONTEXT_CONTROL_INSTRUCTIONS,createControlToolHandler} from '../lib/control-tools.mjs';

const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const unpack=result=>JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-persistent-preferences-'));
  const legacy={codexHistory:'relay',defaultEffort:'ultra',defaultServiceTier:'fast',defaultContext:{preset:'extended',autoCompact:false,headroomTokens:2048},hiddenModelProviders:['example-provider'],connectedGmail:true,executionGuardrails:false,subagentsEnabled:true,maxSubagents:4,providerIdleTimeoutMs:600000};
  const original=Buffer.from('  '+JSON.stringify(legacy,null,4)+'\n');
  const preferences=path.join(directory,'runtime-settings.json'),providers=path.join(directory,'providers.json');
  const providerBytes=Buffer.from('{ "fixture": "opaque-provider-settings-must-not-change" }\n');
  await writeFile(preferences,original);await writeFile(providers,providerBytes);
  const beforeStat=await stat(preferences),store=new RuntimeSettingsStore({dataDir:directory}),events=[];store.on('updated',value=>events.push(value));await store.init();
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  const engine={runtimeSettings:store,runtime:{status:()=>({defaultModel:'example-provider::selected',models:[{id:'example-provider::selected'}]})},listWorkflows:()=>[]};
  const handler=definition=>createControlToolHandler({engine,run:{id:'fixture',cwd:directory},nodeId:'agent',...(definition?{toolDefinition:definition}:{})});
  return{directory,legacy,original,preferences,providers,providerBytes,beforeStat,store,events,handler};
}

test('loading legacy relay preferences normalizes only in memory and read APIs leave both profile files byte-identical',async t=>{
  const f=await fixture(t),current=f.handler();
  const loaded=f.store.get();assert.equal(loaded.codexHistory,'codex');
  for(const [key,value]of Object.entries(f.legacy))if(key!=='codexHistory'&&key!=='defaultContext')assert.deepEqual(loaded[key],value);
  assert.deepEqual(loaded.defaultContext,{preset:'extended',windowTokens:null,autoCompact:false,headroomTokens:2048});
  const read=await current({name:'relay_control',arguments:{action:'runtime_get'}});assert.equal(read.success,true);assert.equal(unpack(read).codexHistory,'codex');
  const catalog=await current({name:'relay_control',arguments:{action:'catalog'}});assert.equal(catalog.success,true);assert.equal(unpack(catalog).runtimeSettings.codexHistory,'codex');assert.equal(unpack(catalog).defaultModel,'example-provider::selected');
  const description=await current({name:'relay_control',arguments:{action:'describe'}});assert.equal(description.success,true);
  assert.equal(Object.hasOwn(unpack(description).tool.inputSchema.properties.runtime.properties,'codexHistory'),false);
  assert.doesNotMatch(unpack(description).notes.join('\n'),/chooses codexHistory:relay|temporary native sessions with Relay|Keep in BLACKICE only|Also show in Codex/);
  assert.deepEqual(await readFile(f.preferences),f.original);assert.deepEqual(await readFile(f.providers),f.providerBytes);assert.deepEqual(f.events,[]);
  assert.equal((await stat(f.preferences)).mtimeMs,f.beforeStat.mtimeMs);assert.deepEqual((await readdir(f.directory)).sort(),['providers.json','runtime-settings.json']);
});

test('an explicit unrelated save persists the canonical native policy without resetting selected provider or context preferences',async t=>{
  const f=await fixture(t),before=f.store.get();
  const saved=await f.store.update({verbosity:'concise'});
  assert.deepEqual(saved,{...before,verbosity:'concise'});assert.equal(saved.codexHistory,'codex');
  assert.deepEqual(JSON.parse(await readFile(f.preferences,'utf8')),saved);assert.deepEqual(await readFile(f.providers),f.providerBytes);
  const restored=await new RuntimeSettingsStore({dataDir:f.directory}).init();t.after(()=>restored.close());assert.deepEqual(restored.get(),saved);
  assert.deepEqual(f.events,[saved]);
});

test('old and current runtime control callers cannot re-enable temporary history and invalid requests preserve bytes',async t=>{
  const f=await fixture(t);
  assert.deepEqual(validateRuntimeSettings({codexHistory:'relay'}),{codexHistory:'codex'});
  for(const definition of [PRE_CONTEXT_CONTROL_TOOL,PRE_PERSISTENT_HISTORY_CONTROL_TOOL,CONTROL_TOOL]){
    const handler=f.handler(definition),before=f.store.get();
    const result=await handler({name:'relay_control',arguments:{action:'runtime_set',runtime:{codexHistory:'relay'}}});
    assert.equal(result.success,true);assert.equal(unpack(result).codexHistory,'codex');assert.deepEqual(f.store.get(),before);
  }
  const before=await readFile(f.preferences),current=f.handler();
  for(const codexHistory of ['private','temporary',false,null]){
    const result=await current({name:'relay_control',arguments:{action:'runtime_set',runtime:{codexHistory}}});
    assert.equal(result.success,false);assert.match(unpack(result).error,/persistent/);
    assert.deepEqual(await readFile(f.preferences),before);
  }
  assert.deepEqual(await readFile(f.providers),f.providerBytes);
});

test('schema9 removes the history choice while schema8 and schema7 tool definitions and instructions retain exact recorded bytes',()=>{
  // Digests captured independently from the installed/source schema8 baseline before this amendment.
  assert.equal(digest(PRE_PERSISTENT_HISTORY_CONTROL_TOOL),'87613592ceb8134366e09004f53d196c625ba61d20db99955adf547248d6437a');
  assert.equal(digest(PRE_PERSISTENT_HISTORY_CONTROL_INSTRUCTIONS),'ba1313c52a5b1d6f5c15d1b7be4ee558904a866b2c1d3dab3c37652e60aba263');
  assert.equal(digest(PRE_CONTEXT_CONTROL_TOOL),'b66363382582754f1de21b9390adc92e5ab4639fba8ee6c620c8e967fe4d11a8');
  assert.equal(digest(PRE_CONTEXT_CONTROL_INSTRUCTIONS),'bb2474986bc93c57f706685adcb2a8cda43e4d003761abff1c3b5f3e645f6a9c');
  assert.equal(CONTROL_SCHEMA_VERSION,9);
  const current=CONTROL_TOOL.inputSchema.properties.runtime.properties,old=PRE_PERSISTENT_HISTORY_CONTROL_TOOL.inputSchema.properties.runtime.properties;
  assert.equal(Object.hasOwn(current,'codexHistory'),false);assert.deepEqual(old.codexHistory.enum,['relay','codex']);
  assert.deepEqual(current.defaultContext.properties.preset.enum,['model','extended','900k','custom']);
  assert.notEqual(current.defaultContext,old.defaultContext,'New schema changes cannot mutate an old native continuation definition.');
  assert.ok(CONTROL_INSTRUCTIONS.startsWith(PRE_PERSISTENT_HISTORY_CONTROL_INSTRUCTIONS));assert.match(CONTROL_INSTRUCTIONS,/persistent resumable Codex history/);
});
