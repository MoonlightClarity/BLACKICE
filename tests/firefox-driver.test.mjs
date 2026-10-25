import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirefoxDriver, FirefoxBiDiDriver, closeOwnedFirefoxSession } from '../desktop/firefox-driver.mjs';

function fixture(options = {}) {
  const behavior={...options};const{frames=false,verifyMismatch=false}=options;
  const commands=[], contexts=new Map([['existing-user-tab','https://user.fixture.test/']]);let next=0,socket;
  class FakeWebSocket extends EventTarget {
    constructor(endpoint) { super(); socket=this; this.endpoint=endpoint;this.readyState=0;queueMicrotask(()=>{if(this.readyState!==3){this.readyState=1;this.dispatchEvent(new Event('open'));}}); }
    send(text) {
      const command=JSON.parse(text);commands.push(command);const{method,params}=command;
      behavior.onCommand?.(command,this);
      if(method===behavior.hangMethod)return;
      if(method===behavior.failMethod){this.reply(command,{type:'error',error:'invalid argument',message:'fixture protocol error'});return;}
      let result={};
      if(method==='session.new')result={sessionId:'fixture-session',capabilities:{browserName:'firefox',browserVersion:'158.0'}};
      if(method==='browsingContext.create'){const context=`task-${++next}`;contexts.set(context,'about:blank');result={context};}
      if(method==='browsingContext.navigate'){contexts.set(params.context,params.url);result={url:params.url,navigation:'fixture-navigation'};}
      if(method==='browsingContext.close')contexts.delete(params.context);
      if(method==='browsingContext.getTree')result={contexts:params.root?[{context:params.root,url:contexts.get(params.root),children:frames?[{context:`${params.root}-frame`,url:'https://embedded.fixture.test/',children:[]}]:[]}]:[...contexts].map(([context,url])=>({context,url,children:[]}))};
      if(method==='script.callFunction'){
        const args=params.arguments.map(arg=>arg.value),context=params.target.context;
        if(params.functionDeclaration.includes('function snapshotPage')){
          const elements=[{ref:`${context}:document:1`,role:'button',name:'Publish fixture',tag:'button'},{ref:`${context}:document:2`,role:'textbox',name:'Post text',tag:'div',contentEditable:true}];
          result={type:'success',result:{type:'string',value:JSON.stringify({title:'Disposable fixture',url:contexts.get(context)||'https://embedded.fixture.test/',readyState:'complete',elements:args[2]?elements.filter(item=>item.name.toLowerCase().includes(String(args[2]).toLowerCase())):elements,text:'Disposable fixture text',truncated:false})}};
        }else if(args[2]==='node')result={type:'success',result:{type:'node',sharedId:`shared-${args[1]}`}};
        else result={type:'success',result:{type:'string',value:JSON.stringify({matched:!(verifyMismatch&&args[2]==='verifyFill'),focused:true,prepared:true,selected:args[3]})}};
      }
      if(method==='browsingContext.captureScreenshot')result={data:'iVBORw0KGgo='};
      const override=behavior.response?.(command,result);if(override!==undefined)result=override;
      this.reply(command,{type:'success',result});
      if(method==='browser.close')queueMicrotask(()=>this.close());
    }
    reply(command,response){queueMicrotask(()=>{if(this.readyState===1)this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:command.id,...response})}));});}
    event(method,params){this.raw(JSON.stringify({type:'event',method,params}));}
    raw(data){this.dispatchEvent(new MessageEvent('message',{data}));}
    close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  return {commands,contexts,behavior,WebSocketClass:FakeWebSocket,get socket(){return socket;}};
}
async function driver(t,options={}) { const mock=fixture(options);const instance=await createFirefoxDriver({endpoint:'ws://127.0.0.1:9222',profileName:'Disposable fixture',profileSource:'fixture-only',WebSocketClass:mock.WebSocketClass,...options});t.after(()=>instance.close().catch(()=>{}));return{mock,instance}; }
const open = instance => instance.perform({action:'open',url:'https://task.fixture.test/'});

test('Firefox BiDi uses the actual protocol handshake, background task tabs and no foreground operations',async t=>{
  const{mock,instance}=await driver(t);
  assert.equal(mock.socket.endpoint,'ws://127.0.0.1:9222/session');assert.equal(mock.commands[0].method,'session.new');
  assert.equal(instance.status().activeTab,null,'existing user pages must not be selected by default');
  await assert.rejects(instance.perform({action:'snapshot'}),{code:'BROWSER_VALIDATION'});
  const result=await open(instance);assert.equal(result.tabId,'task-1');assert.equal(result.frames[0].elements.length,2);
  assert.deepEqual(mock.commands.find(command=>command.method==='browsingContext.create').params,{type:'tab',background:true});
  const before=mock.commands.length;const shown=instance.show(result.tabId);assert.equal(shown.foregrounded,false);assert.equal(mock.commands.length,before);
  assert.equal(instance.status().tabs.find(tab=>tab.tabId==='existing-user-tab').owned,false);assert.equal(instance.status().tabs.find(tab=>tab.tabId===result.tabId).owned,true);
  assert.equal(instance.status().accountAuthenticated,'unknown');assert.equal(instance.status().physicalInput,false);assert.equal(instance.status().browserVersion,'158.0');
  assert.equal(mock.commands.some(command=>command.method==='browsingContext.activate'),false);
});

test('Firefox fills contenteditable through trusted page keyboard actions and always releases input',async t=>{
  const{mock,instance}=await driver(t);const page=await open(instance);
  const result=await instance.perform({action:'fill',tabId:page.tabId,ref:'task-1:document:2',text:'Hello\nWorld'});
  assert.equal(result.receipt.input,'browser-keyboard');assert.equal(result.receipt.characters,11);
  const commands=mock.commands.filter(command=>command.method==='input.performActions'&&command.params.actions[0].type==='key');assert.equal(commands.length,2);
  assert.equal(commands[0].params.context,page.tabId);assert.ok(commands[0].params.actions[0].actions.some(action=>action.value==='\uE009'));
  assert.ok(commands[1].params.actions[0].actions.some(action=>action.value==='\uE007'),'newline uses actual browser Enter');
  assert.equal(mock.commands.filter(command=>command.method==='input.releaseActions').length,3);
  const focus=mock.commands.find(command=>command.method==='script.callFunction'&&command.params.arguments[2]?.value==='focusText');assert.ok(focus);
  assert.equal(result.receipt.verified,true);
});

test('Firefox refs are owned by their top-level tab even for cross-origin child frames',async t=>{
  const{mock,instance}=await driver(t,{frames:true});const first=await open(instance);const second=await open(instance);
  const count=mock.commands.length;
  await assert.rejects(instance.perform({action:'click',tabId:second.tabId,ref:`${first.tabId}-frame:document:1`}),{code:'BROWSER_VALIDATION'});
  assert.equal(mock.commands.length,count,'cross-tab refs must fail before page input');
  await instance.perform({action:'click',tabId:second.tabId,ref:`${second.tabId}-frame:document:1`});
  const click=mock.commands.find(command=>command.method==='input.performActions');assert.equal(click.params.context,`${second.tabId}-frame`);
  assert.deepEqual(click.params.actions[0].actions[0].origin,{type:'element',element:{sharedId:`shared-${second.tabId}-frame:document:1`}});
});

test('Firefox refuses to claim a successful fill when actual editor readback does not match',async t=>{
  const{instance}=await driver(t,{verifyMismatch:true});const page=await open(instance);
  await assert.rejects(instance.perform({action:'fill',tabId:page.tabId,ref:'task-1:document:2',text:'Requested text'}),{code:'BROWSER_INPUT_UNCONFIRMED'});
});

test('Firefox conditional waits pass typed numeric timeout and reject blind waits',async t=>{
  const{mock,instance}=await driver(t);const page=await open(instance);
  await assert.rejects(instance.perform({action:'wait',tabId:page.tabId}),{code:'BROWSER_VALIDATION'});
  await instance.perform({action:'wait',tabId:page.tabId,query:'Ready',timeoutMs:1234});
  const wait=mock.commands.find(command=>command.method==='script.callFunction'&&command.params.functionDeclaration.includes('function waitForPage'));
  assert.deepEqual(wait.params.arguments[3],{type:'number',value:1234});assert.equal(wait.params.awaitPromise,true);
  await instance.perform({action:'wait',tabId:page.tabId,text:'Text alias',timeoutMs:456});
  const textWait=mock.commands.filter(command=>command.method==='script.callFunction'&&command.params.functionDeclaration.includes('function waitForPage')).at(-1);
  assert.deepEqual(textWait.params.arguments[1],{type:'string',value:'Text alias'});assert.deepEqual(textWait.params.arguments[3],{type:'number',value:456});
});

test('Firefox screenshots return actual protocol image data and query narrows controls',async t=>{
  const{instance}=await driver(t);const page=await open(instance);
  const screenshot=await instance.perform({action:'screenshot',tabId:page.tabId});assert.equal(screenshot.imageUrl,'data:image/png;base64,iVBORw0KGgo=');
  const narrowed=await instance.perform({action:'read',tabId:page.tabId,query:'Post text'});assert.equal(narrowed.frames[0].elements.length,1);assert.equal(narrowed.frames[0].elements[0].role,'textbox');
});

test('Firefox preserves preexisting user tabs and gracefully closes only owned task tabs before the owned browser',async t=>{
  let shutdown=0;const{mock,instance}=await driver(t,{onClose:async()=>{shutdown++;}});const page=await open(instance);
  await assert.rejects(instance.perform({action:'close',tabId:'existing-user-tab'}),{code:'BROWSER_VALIDATION'});
  await instance.close();await instance.close();assert.equal(shutdown,1);
  const closes=mock.commands.filter(command=>command.method==='browsingContext.close');assert.deepEqual(closes.map(command=>command.params.context),[page.tabId]);
  assert.equal(mock.commands.at(-1).method,'browser.close');assert.equal(mock.commands.some(command=>command.method==='session.end'),false,'session must remain alive until graceful browser shutdown');
});

test('Firefox cancellation releases browser input and rejects later completion without leaving pending requests',async t=>{
  const{mock,instance}=await driver(t,{hangMethod:'input.performActions'});const page=await open(instance);const controller=new AbortController();
  const operation=instance.perform({action:'click',tabId:page.tabId,ref:'task-1:document:1'},{signal:controller.signal});
  while(!mock.commands.some(command=>command.method==='input.performActions'))await new Promise(resolve=>setImmediate(resolve));controller.abort();
  await assert.rejects(operation,{name:'AbortError'});assert.ok(mock.commands.some(command=>command.method==='input.releaseActions'));assert.equal(instance.connection.pending.size,0);
});

test('Firefox reports protocol failures and unsupported actions instead of inventing success',async t=>{
  const{mock,instance}=await driver(t,{failMethod:'input.performActions'});const page=await open(instance);
  await assert.rejects(instance.perform({action:'click',tabId:page.tabId,ref:'task-1:document:1'}),/fixture protocol error/);assert.ok(mock.commands.some(command=>command.method==='input.releaseActions'));
  await assert.rejects(instance.perform({action:'upload',tabId:page.tabId,paths:['not-read']}),{code:'BROWSER_UNSUPPORTED'});
  assert.equal(mock.commands.some(command=>/storage\.|cookies/i.test(command.method)),false);
});

test('Firefox accepts only local BiDi endpoints and validates navigation before any new tab is created',async t=>{
  for(const endpoint of ['ws://other.test:9222/session','http://127.0.0.1:9222/session','ws://user:secret@127.0.0.1:9222/session','ws://127.0.0.1:9222/other'])assert.throws(()=>new FirefoxBiDiDriver({endpoint}),{code:'BROWSER_VALIDATION'});
  const{mock,instance}=await driver(t);const before=mock.commands.length;await assert.rejects(instance.perform({action:'open',url:'javascript:alert(1)'}),{code:'BROWSER_VALIDATION'});assert.equal(mock.commands.length,before);
  const opened=await instance.perform({action:'open',url:'file:///C:/Documents/local.html'});assert.equal(opened.url,'file:///C:/Documents/local.html');
});

test('Firefox disconnect rejects outstanding work immediately and clears pending commands and stale refs',async t=>{
  const{mock,instance}=await driver(t);const page=await open(instance);mock.behavior.hangMethod='script.callFunction';
  const operation=instance.perform({action:'snapshot',tabId:page.tabId});
  while(!instance.connection.pending.size)await new Promise(resolve=>setImmediate(resolve));
  mock.socket.close();await assert.rejects(operation,{code:'BROWSER_DISCONNECTED'});
  assert.equal(instance.connection.pending.size,0);assert.equal(instance.operations.size,0);assert.equal(instance.status().connected,false);assert.equal(instance.tab(page.tabId).refs.size,0);
  await assert.rejects(instance.perform({action:'click',tabId:page.tabId,ref:'task-1:document:1'}),{code:'BROWSER_UNAVAILABLE'});
  await assert.rejects(instance.close(),{code:'BROWSER_SHUTDOWN_UNCONFIRMED'});
});

test('Firefox action deadlines cover hung page scripts and late replies cannot complete a cancelled operation',async t=>{
  const{mock,instance}=await driver(t);const page=await open(instance);instance.timeoutMs=40;mock.behavior.hangMethod='script.callFunction';
  await assert.rejects(instance.perform({action:'snapshot',tabId:page.tabId}),{code:'BROWSER_TIMEOUT'});
  const late=mock.commands.at(-1);assert.equal(instance.connection.pending.size,0);assert.equal(instance.operations.size,0);
  mock.socket.reply(late,{type:'success',result:{type:'success',result:{type:'string',value:'{}'}}});
  mock.behavior.hangMethod=null;instance.timeoutMs=25000;
  assert.equal((await instance.perform({action:'snapshot',tabId:page.tabId})).tabId,page.tabId);
});

test('Firefox lost connection interrupts navigation settling and removes its listeners',async t=>{
  const{mock,instance}=await driver(t);const page=await open(instance);
  mock.behavior.onCommand=(command,socket)=>{if(command.method==='input.performActions')socket.event('browsingContext.navigationStarted',{context:page.tabId});};
  const operation=instance.perform({action:'click',tabId:page.tabId,ref:'task-1:document:1'});
  while(!instance.listenerCount(`settled:${page.tabId}`))await new Promise(resolve=>setImmediate(resolve));
  mock.socket.close();await assert.rejects(operation,{code:'BROWSER_DISCONNECTED'});
  assert.equal(instance.listenerCount(`settled:${page.tabId}`),0);
});

test('Firefox fails a completed click if input release is uncertain and repairs release before accepting new input',async t=>{
  const{mock,instance}=await driver(t);const page=await open(instance);mock.behavior.failMethod='input.releaseActions';
  await assert.rejects(instance.perform({action:'click',tabId:page.tabId,ref:'task-1:document:1'}),{code:'BROWSER_INPUT_UNCONFIRMED'});
  assert.ok(instance.status().inputWarning);mock.behavior.failMethod=null;
  const offset=mock.commands.length;await instance.perform({action:'click',tabId:page.tabId,ref:'task-1:document:1'});
  const input=mock.commands.slice(offset).filter(command=>command.method.startsWith('input.'));
  assert.deepEqual(input.map(command=>command.method),['input.releaseActions','input.performActions','input.releaseActions']);assert.equal(instance.status().inputWarning,undefined);
});

test('Firefox iframe navigation invalidates parent snapshots before any prepared input is sent',async t=>{
  const{mock,instance}=await driver(t,{frames:true});const page=await open(instance);
  mock.behavior.onCommand=(command,socket)=>{if(command.method==='script.callFunction'&&command.params.arguments[2]?.value==='node')socket.event('browsingContext.navigationStarted',{context:`${page.tabId}-frame`});};
  await assert.rejects(instance.perform({action:'click',tabId:page.tabId,ref:'task-1-frame:document:1'}),{code:'BROWSER_STALE_PAGE'});
  assert.equal(mock.commands.some(command=>command.method==='input.performActions'),false);assert.equal(instance.tab(page.tabId).refs.size,0);
});

test('Firefox never substitutes a child frame for an unavailable main page or accepts oversized page output',async t=>{
  const{mock,instance}=await driver(t,{frames:true});const page=await open(instance);
  mock.behavior.response=(command,result)=>command.method==='script.callFunction'&&command.params.target.context===page.tabId?{type:'exception',exceptionDetails:{text:'main page unavailable'}}:result;
  await assert.rejects(instance.perform({action:'snapshot',tabId:page.tabId}),{code:'BROWSER_PAGE'});assert.equal(instance.tab(page.tabId).refs.size,0);
  mock.behavior.response=(command,result)=>command.method==='script.callFunction'?{type:'success',result:{type:'string',value:'x'.repeat(512001)}}:result;
  await assert.rejects(instance.perform({action:'snapshot',tabId:page.tabId}),{code:'BROWSER_PROTOCOL'});
});

test('Firefox rejects a screenshot captured after navigation rather than pairing it with a stale snapshot',async t=>{
  const{mock,instance}=await driver(t);const page=await open(instance);
  mock.behavior.onCommand=(command,socket)=>{if(command.method==='browsingContext.captureScreenshot')socket.event('browsingContext.navigationStarted',{context:page.tabId});};
  await assert.rejects(instance.perform({action:'screenshot',tabId:page.tabId}),{code:'BROWSER_STALE_PAGE'});
});

test('Firefox owns popups only from task tabs and preserves unrelated popups during shutdown',async t=>{
  const{mock,instance}=await driver(t);const page=await open(instance);
  for(const[context,opener]of[['task-popup',page.tabId],['user-popup','existing-user-tab']]){mock.contexts.set(context,'https://popup.fixture.test/');mock.socket.event('browsingContext.contextCreated',{context,parent:null,originalOpener:opener,url:'https://popup.fixture.test/'});}
  await instance.perform({action:'tabs'});assert.equal(instance.status().tabs.find(tab=>tab.tabId==='task-popup').owned,true);assert.equal(instance.status().tabs.find(tab=>tab.tabId==='user-popup').owned,false);
  await instance.close();assert.deepEqual(mock.commands.filter(command=>command.method==='browsingContext.close').map(command=>command.params.context).sort(),[page.tabId,'task-popup'].sort());
});

test('Firefox shutdown cancels pending input, waits for release, and shuts down once',async t=>{
  let confirmations=0;const{mock,instance}=await driver(t,{onClose:async()=>{confirmations++;}});const page=await open(instance);mock.behavior.hangMethod='input.performActions';
  const operation=instance.perform({action:'click',tabId:page.tabId,ref:'task-1:document:1'});const rejected=assert.rejects(operation,{name:'AbortError'});
  while(!mock.commands.some(command=>command.method==='input.performActions'))await new Promise(resolve=>setImmediate(resolve));
  await Promise.all([instance.close(),instance.close(),rejected]);assert.equal(confirmations,1);assert.equal(instance.operations.size,0);
  assert.ok(mock.commands.findIndex(command=>command.method==='input.releaseActions')<mock.commands.findIndex(command=>command.method==='browser.close'));
});

test('Firefox malformed protocol output rejects pending work and incomplete initialization closes its session',async()=>{
  const mock=fixture({failMethod:'session.subscribe'});let cleanup=0;
  await assert.rejects(createFirefoxDriver({endpoint:'ws://127.0.0.1:9222',WebSocketClass:mock.WebSocketClass,onClose:async()=>{cleanup++;}}),/fixture protocol error/);
  assert.equal(cleanup,1);assert.equal(mock.commands.at(-1).method,'browser.close');
  const other=fixture();const instance=await createFirefoxDriver({endpoint:'ws://127.0.0.1:9222',WebSocketClass:other.WebSocketClass});
  other.behavior.hangMethod='browsingContext.getTree';const pending=instance.perform({action:'tabs'});other.socket.raw('{broken');
  await assert.rejects(pending,{code:'BROWSER_PROTOCOL'});assert.equal(instance.status().connected,false);assert.equal(instance.connection.pending.size,0);await assert.rejects(instance.close(),{code:'BROWSER_SHUTDOWN_UNCONFIRMED'});
});

test('Firefox failed-start cleanup uses only a new session and graceful browser close',async()=>{
  const mock=fixture();
  assert.deepEqual(await closeOwnedFirefoxSession({endpoint:'ws://127.0.0.1:9222',WebSocketClass:mock.WebSocketClass}),{closed:true});
  assert.deepEqual(mock.commands.map(command=>command.method),['session.new','browser.close']);
  assert.equal(mock.socket.readyState,3);
});

test('Firefox failed-start cleanup closes its transport on protocol failure, timeout and cancellation',async()=>{
  for(const method of ['session.new','browser.close']){
    const mock=fixture({failMethod:method});
    await assert.rejects(closeOwnedFirefoxSession({endpoint:'ws://127.0.0.1:9222',WebSocketClass:mock.WebSocketClass}),/fixture protocol error/);
    assert.equal(mock.socket.readyState,3);assert.equal(mock.commands.some(command=>command.method==='browsingContext.getTree'),false);
  }
  const hung=fixture({hangMethod:'browser.close'});
  await assert.rejects(closeOwnedFirefoxSession({endpoint:'ws://127.0.0.1:9222',WebSocketClass:hung.WebSocketClass,timeoutMs:25}),{code:'BROWSER_TIMEOUT'});
  assert.equal(hung.socket.readyState,3);
  const aborted=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(closeOwnedFirefoxSession({endpoint:'ws://127.0.0.1:9222',WebSocketClass:aborted.WebSocketClass,signal:controller.signal}),{name:'AbortError'});
  assert.equal(aborted.socket,undefined);
});
