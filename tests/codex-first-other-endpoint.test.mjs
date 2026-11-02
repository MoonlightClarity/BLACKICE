import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chatOptionChoices,validateChatOptions} from '../public/next/chat/options-model.mjs';
import {connectionDefaultModels} from '../public/connection-models.mjs';

const ant='antigravity::gemini-3.8-flash-low';
const qwen='qwen_code::qwen3-coder-plus';
const external='custom_endpoint::model-alpha';
const cachedStatus={
  connected:true,authenticated:true,defaultModel:'gpt-6.1-sol',
  codex:{connected:true,authenticated:true},
  models:[
    {id:'gpt-6.1-sol',displayName:'GPT 6.1 Sol',available:true,providerId:'codex'},
    {id:ant,displayName:'Antigravity · Gemini Flash Low',providerId:'antigravity',available:true},
    {id:qwen,displayName:'Qwen Code · Qwen 3',providerId:'qwen_code',available:true},
    {id:external,displayName:'Other endpoint model',providerId:'custom_endpoint',available:true}
  ]
};

test('chat picker excludes retired native CLIs even when the mounted client has stale server metadata',()=>{
  const opts=chatOptionChoices(cachedStatus,{model:'default'});
  assert.deepEqual(opts.models.map(x=>x.id),['default','gpt-6.1-sol',external]);
  assert.equal(opts.models.find(x=>x.id===external).disabled,false);
  assert.match(opts.models.find(x=>x.id===external).label,/Unsupported endpoint/);
  assert.doesNotThrow(()=>validateChatOptions(cachedStatus,{model:external,effort:'default'}));
});

test('historic chat still shows exact retired original model without making it selectable',()=>{
  const opts=chatOptionChoices(cachedStatus,{model:ant});
  assert.equal(opts.selected.model,ant);
  assert.equal(opts.models.find(x=>x.id===ant)?.disabled,true);
  assert.match(opts.models.find(x=>x.id===ant)?.label,/retired \(historical chat\)/);
  assert.ok(!opts.models.some(x=>x.id===qwen));
});

test('official Codex and explicitly enabled other endpoint stay selectable in general settings',()=>{
  const choices=connectionDefaultModels({...cachedStatus,defaultModelSelection:'codex'});
  assert.ok(choices.some(x=>x.value==='codex'));
  assert.ok(choices.some(x=>x.value==='gpt-6.1-sol'));
  assert.ok(choices.some(x=>x.value===external&&!x.disabled&&/Unsupported endpoint/.test(x.label)));
  assert.ok(!choices.some(x=>[ant,qwen].includes(x.value)));
});

test('models page always uses Codex first and keeps optional unsupported endpoint editor',async()=>{
  const settings=await readFile(new URL('../public/next/workspaces/settings.mjs',import.meta.url),'utf8');
  const focus=await readFile(new URL('../public/next/workspaces/settings-subscriptions.mjs',import.meta.url),'utf8');
  const providers=await readFile(new URL('../public/next/workspaces/settings-providers.mjs',import.meta.url),'utf8');
  const picker=await readFile(new URL('../public/next/core/model-picker.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(settings,/status\.subscriptionFocus===true\s*\?/);
  assert.match(settings,/focus\.createSubscriptionModelSettings/);
  assert.match(focus,/Connect another endpoint · unsupported \(optional\)/);
  assert.match(providers,/Other endpoints · unsupported/);
  assert.match(providers,/id="next-provider-new"/);
  assert.match(picker,/\!\/\^\(\?:antigravity\|qwen_code\)::\//);
});
