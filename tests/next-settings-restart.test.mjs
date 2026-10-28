import test from 'node:test';
import assert from 'node:assert/strict';
import { createForceRestart } from '../public/next/workspaces/settings-restart.mjs';
import { createSettingsWorkspace } from '../public/next/workspaces/settings.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const storage = () => { const values = new Map(); return { getItem:key=>values.get(key)||null, setItem:(key,value)=>values.set(key,value) }; };
const result = (id,status='scheduled',extra={}) => ({protocol:1,acknowledged:true,receipt:{requestId:id,force:true,status,...extra}});
const settle = () => new Promise(resolve=>setImmediate(resolve));
const until = async read => { for(let i=0;i<100;i++){if(read())return;await settle();}throw Error('Restart UI did not settle.'); };

test('force restart uses one stable request and checks its actual receipt after a lost reply', async () => {
  const calls=[],saved=storage(); let number=0;
  const api=async(route,method,body)=>{calls.push({route,method,body});if(route.endsWith('/status'))return result(body.requestId,'completed');throw new Error('Connection lost');};
  const client=createForceRestart({api,storage:saved,makeId:()=>`force-${++number}`});
  await client.start(); assert.equal(client.state().record.status,'unknown');assert.equal(client.state().canStart,false);
  await client.start();assert.equal(calls.length,1,'an uncertain restart is not submitted twice');
  const reopened=createForceRestart({api,storage:saved,makeId:()=>`force-${++number}`});
  assert.equal(reopened.state().record.requestId,'force-1');await reopened.check();
  assert.equal(reopened.state().record.status,'completed');assert.match(reopened.state().record.message,/reopened/);
  assert.deepEqual(calls.map(item=>item.body),[{requestId:'force-1',force:true},{requestId:'force-1'}]);
  assert.equal(reopened.state().canStart,true);
});

test('a scheduling acknowledgement is not reported as a completed restart', async () => {
  const client=createForceRestart({api:async(_route,_method,body)=>result(body.requestId),storage:storage(),makeId:()=> 'force-scheduled'});
  await client.start();assert.equal(client.state().record.status,'scheduled');assert.match(client.state().record.message,/scheduled/i);
  assert.doesNotMatch(client.state().record.message,/reopened/);assert.equal(client.state().canStart,false);
});

test('double clicks admit one restart and unavailable ID creation reports an error without sending', async () => {
  let release; const held=new Promise(resolve=>{release=resolve;});let calls=0;
  const client=createForceRestart({storage:storage(),makeId:()=> 'force-held',api:async(_route,_method,body)=>{calls++;await held;return result(body.requestId);}});
  const first=client.start();await client.start();assert.equal(calls,1);release();await first;
  let error='';const invalid=createForceRestart({storage:storage(),makeId:()=>{throw Error('unavailable');},api:async()=>{throw Error('must not send');},onChange:value=>{error=value.error||'';}});
  await invalid.start();assert.match(error,/could not be created/i);assert.equal(invalid.state().record,null);
});

test('failed receipt allows an explicit new request, while a wrong receipt stays uncertain', async () => {
  let count=0;const calls=[];const client=createForceRestart({storage:storage(),makeId:()=>`force-${++count}`,api:async(route,_method,body)=>{
    calls.push(body);if(calls.length===1)return result('wrong');if(route.endsWith('/status'))return result(body.requestId,'failed',{error:{message:'Browser is busy.'}});return result(body.requestId);
  }});
  await client.start();assert.equal(client.state().record.status,'unknown');assert.equal(client.state().canStart,false);
  await client.check();assert.equal(client.state().record.status,'failed');assert.match(client.state().record.message,/Browser is busy/);
  await client.start();assert.equal(client.state().record.requestId,'force-2');assert.equal(calls.length,3);
});

test('completed and failed force receipts show recorded interruptions and unconfirmed outcomes', async () => {
  const saved=storage(), effects={
    privateSessions:[{sessionId:'app_one',outcome:'confirmed'},{sessionId:'app_two',outcome:'requested'},{sessionId:'app_three',outcome:'uncertain'}],
    browser:{loads:{stopped:2,uncertain:1},interactions:{dismissed:1},downloads:{cancelled:1,completed:1,interrupted:1,uncertain:1}},
  };
  const client=createForceRestart({storage:saved,makeId:()=> 'force-effects',api:async(_route,_method,body)=>result(body.requestId,'failed',{error:{message:'A browser action did not settle.'},forceEffects:effects})});
  await client.start();const message=client.state().record.message;
  assert.match(message,/A browser action did not settle/);
  assert.match(message,/1 private session confirmed closed/);
  assert.match(message,/cleanup requested for 1 private session, but process exit is unconfirmed/);
  assert.match(message,/cleanup outcome unknown for 1 private session/);
  assert.match(message,/2 browser loads stopped/);
  assert.match(message,/1 browser interaction dismissed/);
  assert.match(message,/1 download cancelled/);
  assert.match(message,/1 download completed before cancellation/);
  assert.match(message,/1 download interrupted/);
  assert.match(message,/2 browser actions with unconfirmed outcomes/);
  const reopened=createForceRestart({storage:saved,api:async(_route,_method,body)=>result(body.requestId,'completed',{forceEffects:effects})});
  assert.equal(reopened.state().record.message,message);
  await reopened.check();assert.match(reopened.state().record.message,/BLACKICE reopened/);
  assert.match(reopened.state().record.message,/process exit is unconfirmed/);
});

test('settings exposes force restart locally with its consequences and sends force once', async t => {
  const dom=planningDOM(t),calls=[],info={desktopLifecycle:{available:true,supportsRestart:true,localManagement:true},execution:{activeCount:2},models:[]};
  const workspace=createSettingsWorkspace({mount:dom.mount,getStatus:()=>info,events:{subscribe:()=>()=>{}},api:async(route,method,body)=>{
    calls.push({route,method,body});if(route==='/api/status')return info;if(route==='/api/runtime/settings'||route==='/api/execution/settings')return {};
    if(route==='/api/desktop/restart')return result(body.requestId);throw Error(`Unexpected request: ${route}`);
  }});t.after(()=>workspace.destroy());workspace.enter();await until(()=>!dom.$('#next-settings-restart-card').hidden);
  assert.match(dom.$('#next-settings-restart-card').textContent,/stops? active work and browser activity|stop active work and browser activity/i);
  assert.match(dom.$('#next-settings-restart-card').textContent,/close private application sessions.*unsaved session work may be lost/i);
  assert.match(dom.$('#next-settings-restart-card').textContent,/pauses scheduled and queued work/i);
  assert.match(dom.$('#next-settings-restart-card').textContent,/can still fail if work cannot settle/i);
  await dom.click('#next-settings-force-restart');await until(()=>/scheduled/i.test(dom.$('#next-settings-restart-feedback').textContent));
  const actions=calls.filter(item=>item.route==='/api/desktop/restart');assert.equal(actions.length,1);assert.equal(actions[0].body.force,true);
  assert.equal(dom.$('#next-settings-force-restart').disabled,true);assert.equal(dom.$('#next-settings-check-restart').hidden,false);
  workspace.updateStatus({...info,desktopLifecycle:{...info.desktopLifecycle,localManagement:false}});assert.equal(dom.$('#next-settings-restart-card').hidden,true);
});
