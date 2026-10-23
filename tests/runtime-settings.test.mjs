import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeSettingsStore,validateRuntimeSettings } from '../lib/runtime-settings.mjs';
const defaults = { codexHistory:'relay', runTimeoutMs:null, providerIdleTimeoutMs:300000, defaultEffort:'default', defaultServiceTier:'default', defaultContext:{preset:'model',windowTokens:null,autoCompact:true}, verbosity:'balanced', subagentsEnabled:false, maxSubagents:3 };
const prefs = codexHistory => ({ ...defaults, codexHistory });

async function settingsStore(t){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-history-settings-'));
  const store=new RuntimeSettingsStore({dataDir});await store.init();
  t.after(async()=>{await store.close();await fs.rm(dataDir,{recursive:true,force:true});});
  return{store,dataDir};
}
test('simultaneous context preference patches merge atomically without reverting another window',async t=>{
 const {store}=await settingsStore(t);
 await store.update({defaultContext:{preset:'model',headroomTokens:2000}});
 await Promise.all([store.update({defaultContext:{preset:'900k',headroomTokens:3000}}),store.update({defaultContext:{autoCompact:false}})]);
 assert.deepEqual(store.get().defaultContext,{preset:'900k',windowTokens:900000,autoCompact:false,headroomTokens:3000});
 assert.deepEqual(JSON.parse(await fs.readFile(store.file,'utf8')).defaultContext,store.get().defaultContext);
});

test('runtime preferences default to Relay-only with no agent deadline and a five-minute API inactivity watchdog',async t=>{
  for(const codexHistory of ['relay','codex'])assert.deepEqual(validateRuntimeSettings({codexHistory}),{codexHistory});
  for(const value of [null,undefined,[],{},'relay',{codexHistory:true},{codexHistory:'private'},{codexHistory:'relay',defaultModel:'other'},{maxConcurrentRuns:4}])assert.throws(()=>validateRuntimeSettings(value),error=>error.status===400&&error.code==='RUNTIME_SETTINGS_INVALID');
  const{store,dataDir}=await settingsStore(t);assert.deepEqual(store.get(),prefs('relay'));assert.deepEqual(await fs.readdir(dataDir),[],'ordinary startup does not create or touch provider configuration');
  const exposed=store.get();exposed.codexHistory='codex';assert.deepEqual(store.get(),prefs('relay'),'callers cannot mutate saved preferences through the getter');
});

test('history choices persist independently of provider credentials and survive restart',async t=>{
  const{store,dataDir}=await settingsStore(t),events=[];store.on('updated',value=>events.push(value));
  assert.deepEqual(await store.update(prefs('codex')),prefs('codex'));assert.deepEqual(events,[prefs('codex')]);assert.deepEqual(JSON.parse(await fs.readFile(store.file,'utf8')),prefs('codex'));assert.deepEqual(await fs.readdir(dataDir),['runtime-settings.json']);
  const restarted=await new RuntimeSettingsStore({dataDir}).init();t.after(()=>restarted.close());assert.deepEqual(restarted.get(),prefs('codex'));
  await restarted.update(prefs('relay'));const again=await new RuntimeSettingsStore({dataDir}).init();t.after(()=>again.close());assert.deepEqual(again.get(),prefs('relay'));
});

test('Fast defaults persist independently from reasoning and reject invalid updates without rewriting saved preferences', async t => {
  const {store,dataDir}=await settingsStore(t);
  await store.update({defaultEffort:'max',defaultServiceTier:'fast'});
  const saved=await fs.readFile(store.file,'utf8');
  const restarted=await new RuntimeSettingsStore({dataDir}).init();t.after(()=>restarted.close());
  assert.equal(restarted.get().defaultServiceTier,'fast');assert.equal(restarted.get().defaultEffort,'max');
  for(const value of [null,undefined,true,'priority','auto','ultrafast'])await assert.rejects(store.update({defaultServiceTier:value}),{code:'RUNTIME_SETTINGS_INVALID'});
  assert.equal(await fs.readFile(store.file,'utf8'),saved);
  await store.update({defaultServiceTier:'default'});assert.equal(store.get().defaultEffort,'max');assert.equal(store.get().defaultServiceTier,'default');
});

test('serialized history saves publish the value only after each durable write and invalid updates cannot poison the queue',async t=>{
  const{store}=await settingsStore(t),events=[];store.on('updated',value=>events.push(value));
  await assert.rejects(store.update({codexHistory:'relay',unexpected:true}),{code:'RUNTIME_SETTINGS_INVALID'});
  const values=await Promise.all([store.update(prefs('codex')),store.update(prefs('relay')),store.update(prefs('codex'))]);
  assert.deepEqual(values,[prefs('codex'),prefs('relay'),prefs('codex')]);assert.deepEqual(events,values);assert.deepEqual(store.get(),prefs('codex'));assert.deepEqual(JSON.parse(await fs.readFile(store.file,'utf8')),prefs('codex'));
});

test('a failed atomic replacement keeps the prior history choice and persisted file, cleans staging and permits a later save',async t=>{
  const{store,dataDir}=await settingsStore(t);await store.update(prefs('codex'));const priorFile=store.file,priorBytes=await fs.readFile(priorFile),events=[];store.on('updated',value=>events.push(value));
  const blocked=path.join(dataDir,'blocked-destination');await fs.mkdir(blocked);store.file=blocked;
  await assert.rejects(store.update(prefs('relay')),error=>error.code==='RUNTIME_SETTINGS_SAVE_FAILED'&&error.status===500);
  assert.deepEqual(store.get(),prefs('codex'));assert.deepEqual(await fs.readFile(priorFile),priorBytes);assert.deepEqual(events,[]);assert.equal((await fs.readdir(dataDir)).some(name=>name.endsWith('.tmp')),false);
  store.file=priorFile;await store.update(prefs('relay'));assert.deepEqual(store.get(),prefs('relay'));assert.deepEqual(events,[prefs('relay')]);
});

test('invalid saved history preferences are reported and preserved instead of replaced by defaults',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-history-invalid-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  for(const contents of ['not-json',JSON.stringify({codexHistory:'unsupported'}),JSON.stringify({codexHistory:'codex',apiKey:'do-not-read-or-edit'})]){
    const file=path.join(dataDir,'runtime-settings.json');await fs.writeFile(file,contents);const store=new RuntimeSettingsStore({dataDir});
    await assert.rejects(store.init(),/Cannot load runtime preferences.*existing file was preserved/);assert.equal(await fs.readFile(file,'utf8'),contents);await store.close();
  }
});

test('closing history preferences prevents later writes without altering the saved choice',async t=>{
  const{store}=await settingsStore(t);await store.update(prefs('codex'));await store.close();
  await assert.rejects(store.update(prefs('relay')),error=>error.status===503&&/closing/.test(error.message));assert.deepEqual(store.get(),prefs('codex'));assert.deepEqual(JSON.parse(await fs.readFile(store.file,'utf8')),prefs('codex'));
});

test('legacy history-only preferences gain defaults without rewriting the saved file', async t => {
  const { store, dataDir } = await settingsStore(t); await store.close();
  const file = path.join(dataDir, 'runtime-settings.json'), saved = '{ "codexHistory": "codex" }'; await fs.writeFile(file, saved);
  const restored = await new RuntimeSettingsStore({ dataDir }).init(); t.after(() => restored.close());
  assert.deepEqual(restored.get(), prefs('codex')); assert.equal(await fs.readFile(file, 'utf8'), saved);
});

test('time budgets accept explicit unlimited and long safe integer choices without coercion', async t => {
  const { store } = await settingsStore(t);
  for (const key of ['runTimeoutMs', 'providerIdleTimeoutMs']) {
    for (const value of [null, 1, 30 * 86400000, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual(validateRuntimeSettings({ [key]: value }), { [key]: value });
      const saved = await store.update({ [key]: value }); assert.equal(saved[key], value);
    }
    for (const value of [undefined, 0, -1, 0.1, '300000', false, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const before = store.get(); await assert.rejects(store.update({ [key]: value }), { code: 'RUNTIME_SETTINGS_INVALID' }); assert.deepEqual(store.get(), before);
    }
  }
});

test('serialized partial changes from different windows preserve unrelated preferences', async t => {
  const { store } = await settingsStore(t);
  const result = await Promise.all([store.update({ runTimeoutMs: 120000 }), store.update({ codexHistory: 'codex' }), store.update({ providerIdleTimeoutMs: null })]);
  assert.deepEqual(result, [
    { ...defaults, runTimeoutMs: 120000 },
    { ...prefs('codex'), runTimeoutMs: 120000 },
    { ...prefs('codex'), runTimeoutMs: 120000, providerIdleTimeoutMs: null },
  ]);
  assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')), result[2]);
  await store.update({ runTimeoutMs: null }); assert.deepEqual(store.get(), { ...prefs('codex'), runTimeoutMs: null, providerIdleTimeoutMs: null });
});

test('global reasoning and context defaults persist with max, ultra, 900k, and explicit automatic-compression choices', async t => {
  const {store,dataDir}=await settingsStore(t);
  for(const defaultEffort of ['default','none','minimal','low','medium','high','xhigh','max','ultra']) assert.equal((await store.update({defaultEffort})).defaultEffort,defaultEffort);
  await store.update({defaultContext:{preset:'900k',autoCompact:false}});
  const expected={...defaults,defaultEffort:'ultra',defaultContext:{preset:'900k',windowTokens:900000,autoCompact:false}};
  assert.deepEqual(store.get(),expected);
  const exposed=store.get();exposed.defaultContext.autoCompact=true;assert.deepEqual(store.get(),expected);
  const restored=await new RuntimeSettingsStore({dataDir}).init();t.after(()=>restored.close());assert.deepEqual(restored.get(),expected);
  for(const patch of [{defaultEffort:'extreme'},{defaultEffort:null},{defaultContext:null},{defaultContext:{preset:'custom'}},{defaultContext:{autoCompact:'false'}}]) await assert.rejects(store.update(patch),{code:'RUNTIME_SETTINGS_INVALID'});
  assert.deepEqual(store.get(),expected);
});


test('subagents and verbosity can be independently configured, persist and reject invalid choices', async t => {
  const {store,dataDir}=await settingsStore(t);
  assert.equal(store.get().subagentsEnabled,false);
  const updated=await Promise.all([store.update({subagentsEnabled:true}),store.update({verbosity:'detailed'}),store.update({maxSubagents:4})]);
  assert.equal(updated.at(-1).maxSubagents,4);
  assert.deepEqual({subagentsEnabled:store.get().subagentsEnabled,verbosity:store.get().verbosity,maxSubagents:store.get().maxSubagents},{subagentsEnabled:true,verbosity:'detailed',maxSubagents:4});
  const restarted=await new RuntimeSettingsStore({dataDir}).init();t.after(()=>restarted.close());
  assert.deepEqual(restarted.get(),store.get());
  for(const patch of [{subagentsEnabled:'true'},{subagentsEnabled:null},{verbosity:'verbose'},{verbosity:0},{maxSubagents:0},{maxSubagents:9},{maxSubagents:'4'},{maxSubagents:2.5}]){
    const prior=store.get();await assert.rejects(store.update(patch),{code:'RUNTIME_SETTINGS_INVALID'});assert.deepEqual(store.get(),prior);
  }
});
