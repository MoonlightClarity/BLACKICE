import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createBrowserWorkspace} from '../public/next/workspaces/browser.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const identity={tabId:'fallback-tab',url:'https://fixture.example/page',documentId:'fallback-tab:7'};
const guard={tabId:identity.tabId,expectedUrl:identity.url,expectedDocumentId:identity.documentId};
const interaction=(status,extra={})=>({...identity,id:'browser_input_fixture',kind:'javascript_dialog',dialogType:'prompt',
  status,message:'A website message <img src=x>',defaultPrompt:'Saved prompt',...extra});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function until(read){for(let i=0;i<80;i++){if(read())return;await settle();}throw Error('Fallback browser did not settle.');}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function browserDOM(t){
  const dom=planningDOM(t);
  dom.document.createDocumentFragment=()=>dom.element('fragment');
  const prototype=Object.getPrototypeOf(dom.mount),type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperty(prototype,'type',{get:type.get,set(value){this.setAttribute('type',value);}});
  prototype.replaceChildren=function(...children){
    for(const child of this.children)child.parentElement=null;
    this.children=[];this.rawText='';this.markup='';this.append(...children);
  };
  return dom;
}
async function fixture(t,pending){
  const dom=browserDOM(t),calls=[];
  let current=pending;
  const workspace=createBrowserWorkspace({mount:dom.mount,events:{subscribe:()=>()=>{}},notify(){},
    api:async(route,method='GET',body)=>{
      calls.push({route,method,body});
      if(route.startsWith('/api/browser/status'))return {tabs:[{browser:'relay',visible:false,...identity,title:'Fixture page',
        ...(current?{pendingInteraction:current}:{})}],activeTab:identity.tabId};
      assert.equal(route,'/api/browser/action');
      if(body.action==='screenshot')return {...identity,width:1280,height:900,imageUrl:'data:image/png;base64,aGVsbG8=',
        ...(current?{pendingInteraction:current}:{})};
      current=null;return {...identity,ok:true};
    }});
  t.after(()=>workspace.destroy());workspace.enter();
  try{await until(()=>dom.$('#next-browser-image')&&!dom.$('#next-browser-shot').disabled);}
  catch(error){throw Error(error.message+' '+dom.$('#next-browser-status')?.textContent+' '+JSON.stringify(calls));}
  const action=type=>calls.filter(call=>call.body?.action===type);
  return {...dom,calls,action,async idle(){await until(()=>!dom.$('#next-browser-shot').disabled&&Boolean(dom.$('#next-browser-image')));}};
}

test('a blocked request is an informative notice and ordinary exact-page input needs no acknowledgement',async t=>{
  const f=await fixture(t,interaction('blocked'));
  assert.equal(f.$('#next-browser-interaction').hidden,false);
  assert.match(f.$('#next-browser-interaction').textContent,/Browser notice/);
  assert.match(f.$('#next-browser-interaction').textContent,/<img src=x>/);
  assert.equal(f.$('#next-browser-interaction').querySelector('button'),null);
  assert.equal(f.$('#next-browser-interaction').querySelector('img'),null);
  for(const selector of ['.next-browser-page','#next-browser-type','#next-browser-type-send','#next-browser-key-send'])
    assert.equal(f.$(selector).disabled,false,selector+' remains available after a closed request');
  await f.$('.next-browser-page').dispatch('click',{clientX:225,clientY:25});
  await until(()=>f.action('click').length===1);await f.idle();
  assert.deepEqual(f.action('click')[0].body,{action:'click',browser:'relay',...guard,x:640,y:450});
  assert.equal(f.action('interaction').length,0,'Continuing never sends an implicit acknowledge or site decision.');
});

async function tabFixture(t,{initial,activeTab='page-a',hook}={}){
  const dom=browserDOM(t),calls=[],subscribers=new Set(),state={tabs:initial||[
    {browser:'relay',visible:false,tabId:'page-a',title:'Page A',url:'https://fixture.example/a',documentId:'a:1'},
    {browser:'relay',visible:false,tabId:'page-b',title:'Page B',url:'https://fixture.example/b',documentId:'b:1'},
  ],activeTab};let nextId=0;
  const snapshot=()=>structuredClone({tabs:state.tabs,activeTab:state.activeTab,browsers:{relay:{activeTab:state.activeTab}}});
  const api=async(route,method='GET',body)=>{
    const call={route,method,body};calls.push(call);
    if(route.startsWith('/api/browser/status')){
      const captured=snapshot();if(hook){const result=await hook(call,state,captured);if(result!==undefined)return result;}return captured;
    }
    assert.equal(route,'/api/browser/action');
    if(hook){const result=await hook(call,state);if(result!==undefined)return result;}
    if(body.action==='open'){
      const tabId='new-'+(++nextId),tab={browser:'relay',visible:false,tabId,url:body.url,title:body.url==='about:blank'?'New tab':'Opened page',documentId:tabId+':1'};
      state.tabs.push(tab);state.activeTab=tabId;return {...tab,ok:true};
    }
    const tab=state.tabs.find(item=>item.tabId===body.tabId);assert.ok(tab,'An existing tab must be targeted: '+body.action+' '+body.tabId);
    if(body.action==='tab_select'){state.activeTab=tab.tabId;return snapshot();}
    if(body.action==='close'){
      state.tabs=state.tabs.filter(item=>item.tabId!==body.tabId);if(state.activeTab===body.tabId)state.activeTab=state.tabs[0]?.tabId||null;return {ok:true,tabId:body.tabId};
    }
    if(body.action==='navigate'){tab.url=body.url;tab.title='Navigated page';tab.documentId+=':next';}
    if(body.action==='screenshot')return {...tab,width:1280,height:900,imageUrl:'data:image/png;base64,aGVsbG8='};
    return {...tab,ok:true};
  };
  const create=()=>createBrowserWorkspace({mount:dom.mount,api,events:{subscribe(handler){subscribers.add(handler);return()=>subscribers.delete(handler);}},notify(){}});
  let workspace=create();t.after(()=>workspace.destroy());workspace.enter();
  const idle=async()=>{await until(()=>!dom.$('#next-browser-new').disabled&&Boolean(dom.$('#next-browser-image')));};await idle();
  return {...dom,state,calls,subscribers,get workspace(){return workspace;},idle,
    action:type=>calls.filter(call=>call.body?.action===type),selected:()=>dom.$('.next-browser-tab[aria-selected="true"]')?.dataset.tabId,
    async select(tabId){await dom.click(`[data-tab-id="${tabId}"]`);await idle();},
    async recreate(){workspace.destroy();workspace=create();workspace.enter();await idle();},
    emit(){for(const handler of subscribers)handler({type:'browser.updated'});}};
}

test('each fallback + Tab creates an independent persistent blank page; Enter navigates that same page and close uses its id',async t=>{
  const f=await tabFixture(t);await f.input('#next-browser-url','Unsent A address');
  await f.click('#next-browser-new');await f.idle();const first=f.selected();assert.equal(first,'new-1');
  assert.equal(f.$('#next-browser-url').value,'');assert.equal(f.$(`[data-tab-id="${first}"]`).textContent,'New tab');
  assert.deepEqual(f.action('open')[0].body,{action:'open',browser:'relay',url:'about:blank'});
  await f.click('#next-browser-new');await f.idle();const second=f.selected();assert.equal(second,'new-2');
  assert.equal(f.state.tabs.filter(tab=>tab.url==='about:blank').length,2);assert.equal(f.action('open').length,2);
  await f.input('#next-browser-url','https://fixture.example/new-page');await f.$('#next-browser-form').dispatch('submit');await f.idle();
  assert.deepEqual(f.action('navigate')[0].body,{action:'navigate',browser:'relay',tabId:second,url:'https://fixture.example/new-page'});
  assert.equal(f.action('open').length,2,'Address submission navigates the actual blank tab.');
  await f.select(first);assert.equal(f.$('#next-browser-url').value,'');
  await f.select('page-a');assert.equal(f.$('#next-browser-url').value,'Unsent A address');
  assert.deepEqual(f.action('tab_select').map(call=>call.body.tabId),[first,'page-a']);
  await f.click(`[data-close-tab="${first}"]`);await f.idle();assert.equal(f.state.tabs.some(tab=>tab.tabId===first),false);
  assert.deepEqual(f.action('close').at(-1).body,{action:'close',browser:'relay',tabId:first});
});

test('fallback restores the backend-selected page, preserves tab drafts on status/navigation and persists explicit selections',async t=>{
  const f=await tabFixture(t,{activeTab:'page-b'});assert.equal(f.selected(),'page-b');
  await f.input('#next-browser-url','B draft address');await f.select('page-a');await f.input('#next-browser-url','A draft address');
  await f.select('page-b');assert.equal(f.$('#next-browser-url').value,'B draft address');assert.equal(f.state.activeTab,'page-b');
  f.state.activeTab='page-a';f.state.tabs[1].url='https://fixture.example/external-navigation';
  await f.click('#next-browser-refresh');await f.idle();assert.equal(f.selected(),'page-b','Passive status never changes an existing selected tab.');
  assert.equal(f.$('#next-browser-url').value,'B draft address');
  await f.select('page-b');assert.equal(f.state.activeTab,'page-b','Explicitly clicking the selected tab reasserts its durable backend selection.');f.state.activeTab='page-a';
  f.workspace.leave();assert.equal(f.subscribers.size,0);f.workspace.enter();await f.idle();
  assert.equal(f.selected(),'page-a','Reentry adopts the backend selection.');assert.equal(f.$('#next-browser-url').value,'A draft address');
  await f.select('page-b');await f.recreate();assert.equal(f.selected(),'page-b','A new component restores the durable backend selection.');
  assert.equal(f.$('#next-browser-url').value,'https://fixture.example/external-navigation','New component shows the restored URL, with no browser-storage draft.');
});

test('a delayed old status cannot undo a newer explicit tab selection or its address draft',async t=>{
  const held=deferred();let hold=false;
  const f=await tabFixture(t,{hook:(call,_state,captured)=>{if(call.method==='GET'&&hold){hold=false;return held.promise.then(()=>captured);}}});
  hold=true;await f.click('#next-browser-refresh');await until(()=>f.calls.filter(call=>call.method==='GET').length>=2);
  await f.select('page-b');await f.input('#next-browser-url','New B draft');held.resolve();await settle();await settle();
  assert.equal(f.selected(),'page-b');assert.equal(f.$('#next-browser-url').value,'New B draft');assert.equal(f.state.activeTab,'page-b');
});

test('newer address edits survive a held navigation response, backend URL changes, and blur',async t=>{
  const nav=deferred();let hold=false;
  const f=await tabFixture(t,{hook:async(call,state)=>{if(call.body?.action==='navigate'&&hold){hold=false;const tab=state.tabs.find(tab=>tab.tabId===call.body.tabId);tab.url=call.body.url;await nav.promise;return {...tab,ok:true};}}});
  await f.input('#next-browser-url','https://fixture.example/submitted');hold=true;await f.$('#next-browser-form').dispatch('submit');
  await until(()=>f.action('navigate').length===1);await f.input('#next-browser-url','https://fixture.example/newer-draft');f.$('#next-browser-refresh').focus();
  nav.resolve();await f.idle();assert.equal(f.$('#next-browser-url').value,'https://fixture.example/newer-draft');
  await f.select('page-b');await f.select('page-a');assert.equal(f.$('#next-browser-url').value,'https://fixture.example/newer-draft');
  await f.$('#next-browser-form').dispatch('submit');await f.idle();assert.equal(f.action('navigate').length,2);assert.equal(f.state.tabs[0].url,'https://fixture.example/newer-draft');
});

test('a pending blank open completes across workspace leave/reentry once and preserves its address draft',async t=>{
  const opened=deferred();let hold=true;
  const f=await tabFixture(t,{hook:async(call,state)=>{if(call.body?.action==='open'&&hold){hold=false;const tab={browser:'relay',visible:false,tabId:'delayed-blank',url:'about:blank',title:'New tab',documentId:'delayed:1'};state.tabs.push(tab);state.activeTab=tab.tabId;await opened.promise;return {...tab,ok:true};}}});
  await f.input('#next-browser-url','Original A draft');await f.click('#next-browser-new');await until(()=>f.action('open').length===1);
  await f.input('#next-browser-url','https://fixture.example/new-blank-draft');f.workspace.leave();f.workspace.enter();
  await until(()=>f.selected()==='delayed-blank');assert.equal(f.$('#next-browser-url').value,'https://fixture.example/new-blank-draft');
  opened.resolve();await f.idle();assert.equal(f.action('open').length,1);assert.equal(f.selected(),'delayed-blank');assert.equal(f.$('#next-browser-url').value,'https://fixture.example/new-blank-draft');
  await f.select('page-a');assert.equal(f.$('#next-browser-url').value,'Original A draft');await f.select('delayed-blank');assert.equal(f.$('#next-browser-url').value,'https://fixture.example/new-blank-draft');
  await f.$('#next-browser-form').dispatch('submit');await f.idle();assert.equal(f.action('navigate').at(-1).body.tabId,'delayed-blank');assert.equal(f.action('open').length,1);
});

test('a blank open that finishes while hidden performs no hidden reads and its saved tab survives component recreation',async t=>{
  const opened=deferred();let hold=true;
  const f=await tabFixture(t,{hook:async(call,state)=>{if(call.body?.action==='open'&&hold){hold=false;await opened.promise;const tab={browser:'relay',visible:false,tabId:'hidden-blank',url:'about:blank',title:'New tab',documentId:'hidden:1'};state.tabs.push(tab);state.activeTab=tab.tabId;return {...tab,ok:true};}}});
  await f.click('#next-browser-new');await until(()=>f.action('open').length===1);await f.input('#next-browser-url','https://fixture.example/retained-hidden-draft');
  f.workspace.leave();const before=f.calls.length;opened.resolve();await settle();await settle();assert.equal(f.calls.length,before,'Completing an explicit open does not start hidden status or screenshot work.');
  f.workspace.enter();await f.idle();assert.equal(f.selected(),'hidden-blank');assert.equal(f.$('#next-browser-url').value,'https://fixture.example/retained-hidden-draft');
  await f.recreate();assert.equal(f.selected(),'hidden-blank');assert.equal(f.$('#next-browser-url').value,'');assert.equal(f.$('[data-tab-id="hidden-blank"]').textContent,'New tab');
  assert.equal(f.action('open').length,1,'Restoring a saved blank tab never opens it again.');
});

test('failed explicit open or tab selection is reported without replay or an implicit screenshot selection',async t=>{
  let failure='open';const f=await tabFixture(t,{hook:call=>{if(call.body?.action===failure)throw Error('Synthetic '+failure+' failure');}});
  const captures=f.action('screenshot').length;await f.click('#next-browser-new');await until(()=>!f.$('#next-browser-new').disabled);
  assert.equal(f.action('open').length,1);assert.match(f.$('#next-browser-status').textContent,/Synthetic open failure/);assert.equal(f.action('screenshot').length,captures);
  assert.equal(f.$('#next-browser-url').value,'https://fixture.example/a','A failed new-tab request does not replace the existing tab address.');
  failure='tab_select';await f.click('[data-tab-id="page-b"]');await until(()=>!f.$('#next-browser-new').disabled);
  assert.equal(f.action('tab_select').length,1);assert.match(f.$('#next-browser-status').textContent,/Synthetic tab_select failure/);assert.equal(f.action('screenshot').length,captures);
  f.workspace.leave();const before=f.calls.length;f.emit();await settle();assert.equal(f.calls.length,before);assert.equal(f.state.activeTab,'page-a');
});

for(const action of ['type','press','scroll'])test('blocked metadata alone does not disable '+action,async t=>{
  const f=await fixture(t,interaction('blocked',{kind:'file_chooser'}));
  if(action==='type'){
    await f.input('#next-browser-type','Continue typing');await f.$('#next-browser-type-form').dispatch('submit');
  }else if(action==='press')await f.click('#next-browser-key-send');
  else{
    await f.$('#next-browser-preview').dispatch('wheel',{clientX:225,clientY:25,deltaX:0,deltaY:80,deltaMode:0,cancelable:true});
    await sleep(110);
  }
  await until(()=>f.action(action).length===1);
  const payload=f.action(action)[0].body;
  assert.equal(payload.browser,'relay');for(const [key,value]of Object.entries(guard))assert.equal(payload[key],value);
  assert.equal(f.action('interaction').length,0);
});

test('a genuinely pending prompt keeps its explicit choices and blocks page input until answered',async t=>{
  const f=await fixture(t,interaction('pending'));
  assert.deepEqual(f.$('#next-browser-interaction').querySelectorAll('button').map(button=>button.textContent),['Accept','Dismiss']);
  for(const selector of ['.next-browser-page','#next-browser-type','#next-browser-type-send','#next-browser-key-send'])
    assert.equal(f.$(selector).disabled,true,selector+' waits for the actual pending prompt');
  await f.$('.next-browser-page').dispatch('click',{clientX:225,clientY:25});assert.equal(f.action('click').length,0);
  const field=f.$('#next-browser-interaction').querySelector('input');field.value='An explicit prompt response';
  await f.click(f.$('#next-browser-interaction').querySelector('button'));
  await until(()=>f.action('interaction').length===1);
  assert.deepEqual(f.action('interaction')[0].body,{action:'interaction',browser:'relay',...guard,
    interactionId:'browser_input_fixture',decision:'accept',promptText:'An explicit prompt response'});
  await f.idle();assert.equal(f.$('#next-browser-type-send').disabled,false);
});

test('a genuinely pending file request retains Choose files and Dismiss without adding acknowledgement',async t=>{
  const f=await fixture(t,interaction('pending',{kind:'file_chooser',multiple:false}));
  const buttons=f.$('#next-browser-interaction').querySelectorAll('button');
  assert.deepEqual(buttons.map(button=>button.textContent),['Choose files…','Dismiss']);
  assert.equal(f.$('.next-browser-page').disabled,true);
  await f.click(buttons[1]);await until(()=>f.action('interaction').length===1);
  assert.deepEqual(f.action('interaction')[0].body,{action:'interaction',browser:'relay',...guard,
    interactionId:'browser_input_fixture',decision:'dismiss'});
});
