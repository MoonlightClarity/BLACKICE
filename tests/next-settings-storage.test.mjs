import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createSettingsWorkspace } from '../public/next/workspaces/settings.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const until = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  throw Error('Storage settings UI did not settle.');
};
const initial = () => ({
  categories: [
    {id:'conversations',title:'Conversations',detail:'Saved chats',kind:'history',deletable:true,bytes:2048,files:2,unsafe:false},
    {id:'actions',title:'Action history',detail:'Tool outcomes',kind:'history',deletable:true,bytes:4096,files:4,unsafe:false},
    {id:'vm',title:'Virtual machine',detail:'Guest disk',kind:'system',deletable:false,bytes:8192,files:1,unsafe:false}
  ],
  pending:null,policy:{autoClearTemporaryOnStartup:false},lastCleanup:null,
  externalWorkspace:null
});
async function setup(t, beforeApi = async () => {}) {
  const dom=planningDOM(t),calls=[],info={connected:true,execution:{activeCount:0},models:[]};
  let state=initial();
  const api=async(route,method='GET',body)=>{
    calls.push({route,method,body});
    await beforeApi(route, method, body);
    if(route==='/api/status')return info;
    if(route==='/api/runtime/settings')return {};
    if(route==='/api/execution/settings')return {};
    if(route==='/api/storage/overview')return structuredClone(state);
    if(route==='/api/storage/cleanup'){
      state.pending={categories:body.categories,requestedAt:'2026-11-11T00:00:00.000Z',status:'queued'};
      return {pending:state.pending,applies:'next-startup'};
    }
    if(route==='/api/storage/cleanup/cancel'){
      state.pending=null;
      return {cancelled:true};
    }
    if(route==='/api/storage/policy'){
      state.policy={...body};
      return state.policy;
    }
    throw Error('Unexpected route '+route);
  };
  const workspace=createSettingsWorkspace({mount:dom.mount,api,events:{subscribe:()=>()=>{}},getStatus:()=>info});
  t.after(()=>workspace.destroy());
  workspace.enter();
  await dom.click('#next-settings-section-storage');
  try { await until(()=>Boolean(dom.$('#storage-schedule') && dom.$('#storage-usage')?.children.length===2 && dom.$('#storage-system')?.children.length===1 && !dom.$('#storage-refresh').disabled)); }
  catch(error) {throw Error(error.message+'; panel='+dom.$('#next-settings-storage')?.textContent+'; status='+dom.$('#storage-total')?.textContent+'; calls='+JSON.stringify(calls.map(c=>c.route))+'; selected='+dom.$('#next-settings-section-storage')?.getAttribute('aria-selected'));}
  return {...dom,workspace,calls,state:()=>state};
}

test('Storage & Data panel shows accurate sizes and protected system categories',async t=>{
  const d=await setup(t);
  assert.match(d.$('#storage-total').textContent,/14 KiB/);
  assert.equal(d.$('#storage-categories').querySelectorAll('input').length,2);
  assert.equal(d.$('#storage-schedule').disabled,true);
  assert.match(d.$('#storage-system').textContent,/Files from earlier versions/);
  assert.equal(d.$('#storage-system').querySelectorAll('input').length,0);
  assert.equal(d.calls.filter(c=>c.method==='POST').length,0);
});

test('Storage deletion requires exact user confirmation and never runs directly',async t=>{
  const d=await setup(t), fields=d.$('#storage-categories').querySelectorAll('input');
  fields[0].checked=true;await fields[0].dispatch('change');
  assert.equal(d.$('#storage-schedule').disabled,true);
  await d.input('#storage-confirm','yes');
  assert.equal(d.$('#storage-schedule').disabled,true);
  await d.input('#storage-confirm','DELETE SELECTED DATA');
  assert.equal(d.$('#storage-schedule').disabled,false);
  await d.click('#storage-schedule');
  await until(()=>Boolean(d.state().pending));
  assert.deepEqual(d.state().pending.categories,['conversations']);
  assert.equal(d.$('#storage-cancel').hidden,false);
  const mutations=d.calls.filter(c=>c.method==='POST');
  assert.deepEqual(mutations.map(c=>c.route),['/api/storage/cleanup']);
  assert.equal(mutations[0].body.confirmation,'DELETE SELECTED DATA');
  assert.match(d.$('#storage-pending').textContent,/next startup/i);
  await d.click('#storage-cancel');
  await until(()=>!d.state().pending);
  assert.equal(d.$('#storage-cancel').hidden,true);
  assert.match(d.$('#storage-feedback').textContent,/cancelled/i);
});

test('Only the temporary-data cleanup policy can run automatically',async t=>{
  const d=await setup(t);
  d.$('#storage-auto').checked=true;
  await d.click('#storage-save-policy');
  assert.equal(d.state().policy.autoClearTemporaryOnStartup,true);
  assert.deepEqual(d.calls.filter(c=>c.method==='POST').map(c=>c.route),['/api/storage/policy']);
});

test('Storage settings surfaces queued-cleanup failure and permits cancelling it',async t=>{
  const d=await setup(t);
  const overview=d.calls.filter(c=>c.route==='/api/storage/overview');
  assert.ok(overview.length);
  d.state().pendingError='Invalid request';
  d.state().startupWarning='Unclean shutdown';
  await d.click('#storage-refresh');
  await until(()=>/needs repair/.test(d.$('#storage-pending').textContent));
  assert.equal(d.$('#storage-schedule').disabled,true);
  assert.equal(d.$('#storage-cancel').hidden,false);
  await d.click('#storage-cancel');
  assert.match(d.$('#storage-feedback').textContent,/cancelled/i);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('leaving storage clears prior confirmation and selections before reentry', async t => {
  const d=await setup(t), field=d.$('#storage-categories').querySelectorAll('input')[0];
  field.checked=true; await field.dispatch('change');
  await d.input('#storage-confirm','DELETE SELECTED DATA');
  assert.equal(d.$('#storage-schedule').disabled,false);
  await d.click('#next-settings-section-general');
  await d.click('#next-settings-section-storage');
  await until(()=>d.$('#storage-total').textContent==='14 KiB' && !d.$('#storage-refresh').disabled);
  assert.equal(d.$('#storage-confirm').value,'');
  assert.equal(d.$('#storage-schedule').disabled,true);
  assert.equal(d.$('#storage-categories').querySelectorAll('input')[0].checked,false);
});

test('failed storage scans disable deletion until a successful preview', async t => {
  let failScan=false;
  const d=await setup(t,async route=>{ if(route==='/api/storage/overview'&&failScan)throw Error('Offline'); });
  const field=d.$('#storage-categories').querySelectorAll('input')[0];
  field.checked=true; await field.dispatch('change');
  await d.input('#storage-confirm','DELETE SELECTED DATA');
  failScan=true; await d.click('#storage-refresh');
  await until(()=>/failed/.test(d.$('#storage-scan-status').textContent));
  assert.equal(d.$('#storage-schedule').disabled,true);
  assert.equal(d.$('#storage-save-policy').disabled,true);
});

test('a repeated queue click is ignored and a late response after destroy is harmless', async t => {
  const hold=deferred();
  const d=await setup(t,async route=>{ if(route==='/api/storage/cleanup')await hold.promise; });
  const field=d.$('#storage-categories').querySelectorAll('input')[0];
  field.checked=true; await field.dispatch('change');
  await d.input('#storage-confirm','DELETE SELECTED DATA');
  const sending=d.click('#storage-schedule');
  await until(()=>d.calls.some(call=>call.route==='/api/storage/cleanup'));
  await d.click('#storage-schedule');
  assert.equal(d.calls.filter(call=>call.route==='/api/storage/cleanup').length,1);
  d.workspace.destroy(); hold.resolve();
  await sending; await tick();
  assert.equal(d.mount.children.length,0);
});
