import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
import {createWorkbenchClipboardTransfer,createWorkbenchClipboardHandler,validateWorkbenchClipboardText,
  validateWorkbenchClipboardSnapshot} from '../lib/workbench-clipboard.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
const agent={online:true,paired:true,agentId:'fixture-agent',guestSessionId:2,capabilities:['clipboard_state','clipboard_read','clipboard_write']};
const snapshot=(text='Guest \u{1f9ca}\ntext',sequence=17)=>({sequence,hasText:true,formats:['text/plain'],text,characters:text.length,sha256:hash(text)});
const fixture=options=>{
  let host={formats:['text/plain','text/html'],text:'Host \u{1f9ca}\r\ntext'},reads=0,writes=[];
  const calls=[],control=new WorkbenchConsoleControl();
  const bridge={agentStatus:async()=>({...agent,...options?.agent}),request:async(kind,args,extra)=>{
    calls.push({kind,args,extra});if(options?.request)return options.request(kind,args,calls);
    return {kind,status:'completed',agentId:agent.agentId,guestSessionId:2,result:kind==='clipboard_state'?{sequence:17,hasText:true,formats:['text/plain']}:kind==='clipboard_read'?snapshot():
      {written:true,sequence:18,characters:args.text.length,sha256:hash(args.text)}};
  }};
  const workbench={consoleControl:control,bridge:()=>bridge,status:async()=>({canRunNativeApps:true,guest:{agent:{...agent,...options?.agent}}})};
  const adapters={getWorkbench:()=>workbench,readHostClipboard:()=>{reads++;return {...host}},writeHostText:text=>{writes.push(text);host={formats:['text/plain'],text}}};
  const transfer=createWorkbenchClipboardTransfer(adapters);
  return {transfer,workbench,bridge,control,calls,writes,adapters,get reads(){return reads},get host(){return host},set host(value){host=value}};
};

test('clipboard text and snapshots retain Unicode but reject truncated or unsupported contracts',()=>{
  assert.equal(validateWorkbenchClipboardText('line\r\n\u{1f9ca}\ttext'),'line\r\n\u{1f9ca}\ttext');
  for(const text of ['',null,'x'.repeat(65537),'a\0b','\ud800','\udfff'])assert.throws(()=>validateWorkbenchClipboardText(text),{code:'WORKBENCH_CLIPBOARD_TEXT'});
  assert.deepEqual(validateWorkbenchClipboardSnapshot(snapshot()),snapshot());
  assert.deepEqual(validateWorkbenchClipboardSnapshot(snapshot('new clipboard',0)),snapshot('new clipboard',0));
  assert.deepEqual(validateWorkbenchClipboardSnapshot({sequence:1,hasText:false,formats:['image'],characters:0}),{sequence:1,hasText:false,formats:['image'],characters:0});
  assert.equal(validateWorkbenchClipboardSnapshot(snapshot('')).characters,0);
  for(const changed of [{sequence:-1},{sequence:0x100000000},{characters:999},{sha256:'a'.repeat(64)},{extra:true},{formats:['text/plain','text/plain']}])
    assert.throws(()=>validateWorkbenchClipboardSnapshot({...snapshot(),...changed}));
});

test('explicit user host-to-guest transfer is conditional, does not paste, and returns no clipboard contents',async()=>{
  const f=fixture(),user=await f.control.take(),original=f.host;
  const result=await f.transfer({direction:'toGuest',controlToken:user.controlToken});
  assert.deepEqual(f.calls.map(c=>[c.kind,c.args]),[['clipboard_state',{}],['clipboard_write',{text:original.text,expectedSequence:17}]]);
  assert.equal(f.calls[0].extra.expectedAgent.agentId,agent.agentId);assert.equal(f.calls[0].extra.timeoutMs,6000);
  assert.equal(result.copied,true);assert.equal(result.pasted,false);assert.equal(result.characters,original.text.length);
  assert.deepEqual(result.consoleControl,{owner:'user',revision:user.revision});assert.equal(f.writes.length,0);assert.deepEqual(f.host,original);
  assert.equal(JSON.stringify(result).includes(original.text),false);assert.equal('text' in result,false);assert.equal('sha256' in result,false);
});

test('explicit guest-to-host transfer commits only verified guest text and retains ownership',async()=>{
  const f=fixture(),user=await f.control.take();
  const result=await f.transfer({direction:'fromGuest',controlToken:user.controlToken});
  assert.deepEqual(f.writes,[snapshot().text]);assert.equal(f.calls.length,1);assert.equal(f.reads,3);
  assert.equal(result.copied,true);assert.equal(result.characters,snapshot().text.length);assert.equal(f.control.owner,'user');
});

test('host clipboard changes during asynchronous guest read are preserved in both directions',async()=>{
  for(const direction of ['toGuest','fromGuest']){
    const f=fixture({request:async kind=>{f.host={formats:['image'],text:undefined};return {kind,status:'completed',agentId:agent.agentId,guestSessionId:2,
      result:kind==='clipboard_state'?{sequence:17,hasText:true,formats:['text/plain']}:snapshot()}}});
    await assert.rejects(f.transfer({direction}),{code:'WORKBENCH_CLIPBOARD_CHANGED'});
    assert.deepEqual(f.host,{formats:['image'],text:undefined});assert.equal(f.writes.length,0);assert.equal(f.calls.length,1);
  }
});

test('a host clipboard change during the final awaited focus check is preserved immediately before commit',async()=>{
  const f=fixture();let guards=0;
  await assert.rejects(f.transfer({direction:'fromGuest'},{guard:async()=>{if(++guards===8)f.host={formats:['image'],text:undefined};return true}}),{code:'WORKBENCH_CLIPBOARD_CHANGED'});
  assert.equal(f.writes.length,0);assert.deepEqual(f.host,{formats:['image'],text:undefined});
});

test('empty or non-text guest clipboard never clears the host clipboard',async()=>{
  for(const value of [snapshot(''),{sequence:11,hasText:false,formats:[],characters:0},{sequence:12,hasText:false,formats:['image','files'],characters:0}]){
    const f=fixture({request:async kind=>({kind,status:'completed',agentId:agent.agentId,guestSessionId:2,result:value})}),before=f.host;
    await assert.rejects(f.transfer({direction:'fromGuest'}),{code:/WORKBENCH_CLIPBOARD_(FORMAT|EMPTY)/});
    assert.equal(f.writes.length,0);assert.deepEqual(f.host,before);
  }
});

test('non-text or oversized host copies do not dispatch a clipboard operation',async()=>{
  for(const host of [{formats:['image']},{formats:['text/plain'],text:'x'.repeat(65537)}]){
    const f=fixture();f.host=host;await assert.rejects(f.transfer({direction:'toGuest'}));
    assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  }
  const f=fixture();f.host={formats:['text/plain'],text:'x'.repeat(65537)};
  await f.transfer({direction:'fromGuest'});assert.deepEqual(f.writes,[snapshot().text]);
});

test('user without token and blocked ownership cannot read either system clipboard',async()=>{
  const f=fixture();await f.control.take();await assert.rejects(f.transfer({direction:'fromGuest'}),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  assert.equal(f.reads,0);assert.equal(f.calls.length,0);
  f.control.owner='none';await assert.rejects(f.transfer({direction:'toGuest'}),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  assert.equal(f.reads,0);assert.equal(f.calls.length,0);
});

test('a newer owner revision or changed pairing before commit preserves host clipboard',async()=>{
  for(const changed of ['owner','agent']){
    const f=fixture({request:async kind=>{
      if(changed==='owner')void f.control.take();else f.bridge.agentStatus=async()=>({...agent,agentId:'replacement'});
      return {kind,status:'completed',agentId:agent.agentId,guestSessionId:2,result:snapshot()};
    }}),before=f.host;
    await assert.rejects(f.transfer({direction:'fromGuest'}));assert.equal(f.writes.length,0);assert.deepEqual(f.host,before);
  }
});

test('unconfirmed, wrong identity, malformed and oversized receipts never write host text or retry',async()=>{
  for(const changed of [{status:'pending'},{kind:'capture'},{agentId:'old'},{guestSessionId:9},{result:{...snapshot(),sha256:'bad'}},
    {result:{...snapshot(),text:'x'.repeat(65537),characters:65537,sha256:hash('x'.repeat(65537))}}]){
    const f=fixture({request:async kind=>({kind,status:'completed',agentId:agent.agentId,guestSessionId:2,result:snapshot(),...changed})}),before=f.host;
    await assert.rejects(f.transfer({direction:'fromGuest'}));assert.equal(f.calls.length,1);assert.equal(f.writes.length,0);assert.deepEqual(f.host,before);
  }
});

test('a guest sequence conflict or malformed write receipt is never reported copied or automatically retried',async()=>{
  for(const changed of [{status:'failed',error:'changed'},{result:{written:true,sequence:18,characters:999,sha256:'bad'}}]){
    const f=fixture({request:async(kind,args)=>({kind,status:'completed',agentId:agent.agentId,guestSessionId:2,
      result:kind==='clipboard_state'?{sequence:17,hasText:true,formats:['text/plain']}:{written:true,sequence:18,characters:args.text.length,sha256:hash(args.text)},...(kind==='clipboard_write'?changed:{})})});
    await assert.rejects(f.transfer({direction:'toGuest'}),{code:'WORKBENCH_CLIPBOARD_UNCONFIRMED'});assert.equal(f.calls.length,2);assert.equal(f.writes.length,0);
  }
});

test('automatic controllers can supply an asynchronous focus guard without weakening the owner fence',async()=>{
  let focused=true;
  const f=fixture({request:async kind=>{focused=false;return {kind,status:'completed',agentId:agent.agentId,guestSessionId:2,result:snapshot()}}});
  await assert.rejects(f.transfer({direction:'fromGuest'},{guard:async()=>focused}),{code:'WORKBENCH_CLIPBOARD_PAUSED'});
  assert.equal(f.writes.length,0);assert.equal(f.calls.length,1);
});

test('trusted desktop handler exposes directions only and rejects untrusted frames before reading host clipboard',async()=>{
  const f=fixture(),handler=createWorkbenchClipboardHandler({...f.adapters,trustedSender:event=>event==='trusted'});
  assert.throws(()=>handler('untrusted',{direction:'fromGuest'}),{code:'WORKBENCH_CLIPBOARD_SENDER'});assert.equal(f.reads,0);
  await assert.rejects(handler('trusted',{direction:'fromGuest',text:'injected'}),{code:'WORKBENCH_CLIPBOARD_ARGUMENTS'});assert.equal(f.reads,0);
  assert.equal((await handler('trusted',{direction:'fromGuest'})).copied,true);
});

test('metadata-only clipboard polling reads no host clipboard and returns no guest text',async()=>{
  const f=fixture(),user=await f.control.take();
  const result=await f.transfer.state({controlToken:user.controlToken},{guard:async()=>true});
  assert.deepEqual(result,{sequence:17,hasText:true,formats:['text/plain'],consoleControl:{owner:'user',revision:user.revision}});
  assert.deepEqual(f.calls.map(c=>[c.kind,c.args]),[['clipboard_state',{}]]);assert.equal(f.reads,0);assert.equal(f.writes.length,0);
  await assert.rejects(f.transfer.state(),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
});

test('metadata-only polling rejects text-bearing or stale state receipts',async()=>{
  for(const value of [{sequence:17,hasText:true,formats:['text/plain'],text:'private'},
    {sequence:-1,hasText:false,formats:[]},{sequence:17,hasText:false,formats:['text/plain']}]){
    const f=fixture({request:async kind=>({kind,status:'completed',agentId:agent.agentId,guestSessionId:2,result:value})});
    await assert.rejects(f.transfer.state(),{code:'WORKBENCH_CLIPBOARD_RESPONSE'});assert.equal(f.reads,0);assert.equal(f.writes.length,0);
  }
});

test('a verified fast guest-state adapter avoids slow host inventory for state and deferred paste transfers',async()=>{
  const f=fixture();let observations=0;
  f.workbench.status=()=>assert.fail('A fast native clipboard path must not start a Hyper-V inventory probe');
  const transfer=createWorkbenchClipboardTransfer({...f.adapters,getGuestState:async workbench=>{
    assert.equal(workbench,f.workbench);observations++;return {canRunNativeApps:true,guest:{agent}};
  }});
  assert.equal((await transfer.state()).sequence,17);
  assert.equal((await transfer({direction:'toGuest'})).copied,true);assert.equal(observations,2);
  const denied=createWorkbenchClipboardTransfer({...f.adapters,getGuestState:async()=>({canRunNativeApps:false,guest:{agent}})});
  await assert.rejects(denied({direction:'fromGuest'}),{code:'WORKBENCH_CLIPBOARD_UNAVAILABLE'});
});

test('normal large code blocks transfer exactly without truncation and host-to-guest never reads old guest text',async()=>{
  const large=('code \u{1f9ca}\n').repeat(7000).slice(0,65536),f=fixture();
  f.host={formats:['text/plain'],text:large};const copied=await f.transfer({direction:'toGuest'});
  assert.equal(copied.characters,large.length);assert.equal(f.calls[1].args.text,large);
  assert.equal(f.calls.some(call=>call.kind==='clipboard_read'),false);
  const g=fixture({request:async kind=>({kind,status:'completed',agentId:agent.agentId,guestSessionId:2,result:snapshot(large)})});
  await g.transfer({direction:'fromGuest'});assert.deepEqual(g.writes,[large]);
});

test('an accessible initial zero clipboard serial stays an exact CAS value without clearing or seeding first',async()=>{
  const f=fixture({request:async(kind,args)=>({kind,status:'completed',agentId:agent.agentId,guestSessionId:2,
    result:kind==='clipboard_state'?{sequence:0,hasText:false,formats:[]}:{written:true,sequence:1,characters:args.text.length,sha256:hash(args.text)}})});
  const result=await f.transfer({direction:'toGuest'});assert.equal(result.copied,true);assert.equal(f.calls[1].args.expectedSequence,0);
  assert.deepEqual(f.calls.map(value=>value.kind),['clipboard_state','clipboard_write']);assert.equal(f.writes.length,0);
});
