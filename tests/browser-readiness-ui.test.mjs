import test from 'node:test';
import assert from 'node:assert/strict';
import {browserReadinessModel,browserWorkspaceMarkup,openBrowserWorkspace} from '../public/browser-ui.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const connected={available:true,catalogConnected:true,browserConnected:true,nativeIntegration:true};
const focus=signed=>browserReadinessModel(signed).find(row=>row.name==='Native focus setting');

test('a reachable browser and even reported account authentication cannot confirm the native focus preference',()=>{
  assert.equal(focus({...connected,accountAuthenticated:true}).label,'Not checked');
  const html=browserWorkspaceMarkup({signedBrowser:connected});
  for(const label of ['Tool connection','Browser link','Native focus setting','Not checked','Check native preference'])assert.ok(html.includes(label));
  assert.doesNotMatch(html,/Native focus setting<\/dt><dd[^>]*>.*?Preference checked/);
});

test('a checked preference requires a connected browser and a successful native policy check',()=>{
  const checkedAt='2026-10-18T04:00:00.000Z',backgroundWindow={ready:true,supported:true,policyVerified:true,created:false,checkedAt};
  assert.deepEqual(focus({...connected,backgroundWindow}),{name:'Native focus setting',state:'ready',label:'Preference checked',description:'Neo’s native focus preference passed the last check. Neo may still activate an external window; this is not containment.',checkedAt});
  for(const signed of [{...connected,backgroundWindow:{ready:true,supported:false}},{...connected,backgroundWindow:{...backgroundWindow,policyVerified:false}},{...connected,available:false,browserConnected:false,backgroundWindow}])assert.equal(focus(signed).state,'pending');
  assert.equal(focus({...connected,backgroundWindow:{ready:false,reason:'Focus policy disabled.'}}).state,'blocked');
  assert.equal(focus({...connected,backgroundWindow:{...backgroundWindow,checkedAt:'<img>'}}).checkedAt,null);
  const html=browserWorkspaceMarkup({signedBrowser:{...connected,backgroundWindow}});
  assert.match(html,/Neo may still activate an external window; this is not containment/);
  assert.match(html,/Use Activity’s contained browser to work without native browser windows/);
  assert.doesNotMatch(html,/Focus protection|>Verified<|keep your current window in front|never-steal-focus setting passed/);
});

function documentFixture(t){
  const previous=globalThis.document;let mount={innerHTML:''};const button={textContent:'Check native preference',isConnected:true},error={textContent:''},done={};
  globalThis.document={querySelector:selector=>selector==='#browser-workspace-view'?mount:selector==='#browser-check-background'?button:selector==='#browser-ui-error'?error:selector==='[data-browser-done]'?done:null,querySelectorAll:()=>[]};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  return{button,error,get mount(){return mount;},replace(){mount={innerHTML:''};return mount;}};
}
const options=api=>({api,showModal(){},closeModal(){},toast(){}});

test('background checking is explicit and a rejected check refreshes the visible readiness reason',async t=>{
  const fixture=documentFixture(t),calls=[];let checked=false;
  await openBrowserWorkspace(options(async(route,method,body)=>{
    calls.push({route,method,body});
    if(route==='/api/browser/start'){checked=true;throw Error('Never-steal-focus must be enabled.');}
    return{available:false,signedBrowser:checked?{...connected,available:false,backgroundWindow:{ready:false},reason:'Never-steal-focus must be enabled.'}:connected};
  }));
  assert.deepEqual(calls.map(call=>call.route),['/api/browser/status']);
  await fixture.button.onclick();
  assert.deepEqual(calls.map(call=>call.route),['/api/browser/status','/api/browser/start','/api/browser/status']);
  assert.deepEqual(calls[1],{route:'/api/browser/start',method:'POST',body:{}});
  assert.match(fixture.mount.innerHTML,/Needs attention|Never-steal-focus must be enabled/);
  assert.equal(fixture.error.textContent,'Never-steal-focus must be enabled.');
});

test('an old browser status response cannot overwrite a newly opened browser workspace',async t=>{
  const fixture=documentFixture(t),gate=deferred();let reads=0;
  const api=async()=>++reads===1?gate.promise:{available:false,signedBrowser:{...connected,reason:'New workspace'}};
  const first=openBrowserWorkspace(options(api));fixture.replace();await openBrowserWorkspace(options(api));const current=fixture.mount.innerHTML;
  gate.resolve({available:false,signedBrowser:{available:false,reason:'Old response'}});await first;
  assert.equal(fixture.mount.innerHTML,current);assert.doesNotMatch(fixture.mount.innerHTML,/Old response/);
});

test('an old failed status request cannot replace a new workspace with its error',async t=>{
  const fixture=documentFixture(t),gate=deferred();let reads=0;
  const api=async()=>++reads===1?gate.promise:{available:false,signedBrowser:connected};
  const first=openBrowserWorkspace(options(api));fixture.replace();await openBrowserWorkspace(options(api));
  gate.reject(Error('Old private error'));await first;assert.equal(fixture.mount.textContent,undefined);
});

test('a responding browser with a blocked focus check offers checking access instead of another startup',()=>{
  const html=browserWorkspaceMarkup({signedBrowser:{...connected,available:false,backgroundWindow:{ready:false},reason:'Focus setting needs attention.',endpoint:'http://127.0.0.1:9010/mcp'}});
  assert.match(html,/BrowserOS neo<\/strong><span>Needs attention/);assert.match(html,/id="browser-check-background"/);assert.doesNotMatch(html,/id="browser-start"/);assert.match(html,/Browser link<\/dt><dd[^>]*>[\s\S]*?Responding/);
});

for(const action of ['screenshot','read'])test(`a late ${action} result cannot populate a replacement browser workspace`,async t=>{
  const previous=globalThis.document,gate=deferred(),preview={},inspect={},done={},view={innerHTML:''};let mount=view;const target={children:[],replaceChildren(){this.children=[];},append(node){this.children.push(node);}};
  const elements=new Map([['#browser-preview',preview],['#browser-inspect',inspect],['[data-browser-done]',done],['#browser-preview-content',target]]);
  globalThis.document={querySelector:selector=>selector==='#browser-workspace-view'?mount:elements.get(selector)||null,querySelectorAll:()=>[],createElement:tag=>({tag})};t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  await openBrowserWorkspace(options(async(route,method,body)=>route==='/api/browser/action'?gate.promise:{available:true,tabs:[{tabId:'old-page',url:'https://example.test/'}]}));
  const pending=(action==='screenshot'?preview:inspect).onclick();mount={innerHTML:'New browser workspace'};
  gate.resolve(action==='screenshot'?{imageUrl:'data:image/png;base64,old'}:{frames:[{title:'Old page',url:'https://example.test/',text:'Old page text'}]});await pending;
  assert.deepEqual(target.children,[]);assert.equal(mount.innerHTML,'New browser workspace');
});

test('an in-flight or unconfirmed check cannot reuse an earlier green focus result',()=>{
  const signed={...connected,backgroundWindow:{ready:true,policyVerified:true,checkedAt:'2026-10-18T04:00:00Z'}};
  const checking=browserReadinessModel(signed,{checking:true}).find(row=>row.name==='Native focus setting'),unconfirmed=browserReadinessModel(signed,{unconfirmed:true}).find(row=>row.name==='Native focus setting');
  assert.equal(checking.label,'Checking…');assert.equal(checking.state,'pending');assert.equal(checking.checkedAt,null);
  assert.equal(unconfirmed.label,'Unconfirmed');assert.equal(unconfirmed.state,'pending');assert.equal(unconfirmed.checkedAt,null);
});

const decode=value=>String(value??'').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const attributes=source=>Object.fromEntries([...source.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([,name,value])=>[name,decode(value??'')]));
const nativeStatus=(checkedAt='2026-10-18T04:00:00Z')=>({available:true,activeTab:'tab-1',tabs:[{tabId:'tab-1',title:'First page',url:'https://first.example/'},{tabId:'tab-2',title:'Second page',url:'https://second.example/'}],signedBrowser:{...connected,backgroundWindow:{ready:true,policyVerified:true,checkedAt}}});
function interactiveFixture(t,api){
  const previous=globalThis.document,calls=[],toasts=[];let mount,controls=[],byId=new Map(),html='';
  const body={isConnected:true},doc={activeElement:body,body,createElement:tag=>({tag}),querySelector(selector){if(selector==='#browser-workspace-view')return mount;if(selector==='#modal-root .modal')return{classList:{add(){}}};if(selector==='[data-browser-done]')return controls.find(node=>node.dataset.browserDone!==undefined)||null;return selector.startsWith('#')?byId.get(selector.slice(1))||null:null;},querySelectorAll(selector){if(selector==='#browser-workspace-view button')return controls.filter(node=>node.tagName==='BUTTON');const attribute=/^\[data-([^\]]+)\]$/.exec(selector)?.[1];if(!attribute)return[];const key=attribute.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());return controls.filter(node=>node.dataset[key]!==undefined);}};
  function node(tag,attrs,text=''){
    let disabled=false;const element={tagName:tag.toUpperCase(),id:attrs.id||'',textContent:decode(text.replace(/<[^>]+>/g,'')),isConnected:true,parentMount:mount,dataset:Object.fromEntries(Object.entries(attrs).filter(([name])=>name.startsWith('data-')).map(([name,value])=>[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value])),attributes:{...attrs},hidden:Object.hasOwn(attrs,'hidden'),value:attrs.value||'',open:Object.hasOwn(attrs,'open'),selectionStart:0,selectionEnd:0,selectionDirection:'none',setAttribute(name,value){this.attributes[name]=String(value);},focus(options){if(!this.disabled){doc.activeElement=this;this.focusOptions=options;}},setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}};
    Object.defineProperty(element,'disabled',{get:()=>disabled,set:value=>{disabled=value;if(value&&doc.activeElement===element)doc.activeElement=body;}});return element;
  }
  function replace(){
    for(const control of controls)control.isConnected=false;controls=[];byId=new Map();doc.activeElement=body;html='';mount={scrollTop:0,scrollLeft:0,attributes:{},setAttribute(name,value){this.attributes[name]=String(value);},contains:element=>Boolean(element?.isConnected&&element.parentMount===mount)};
    Object.defineProperty(mount,'innerHTML',{get:()=>html,set:value=>{
      for(const control of controls){control.isConnected=false;if(doc.activeElement===control)doc.activeElement=body;}controls=[];byId=new Map();html=value;mount.scrollTop=0;mount.scrollLeft=0;
      for(const[,tag,source,text]of value.matchAll(/<(button|p|div|details|input|form)\b([^>]*)(?:>([\s\S]*?)<\/\1>|\s*\/?>)/g)){
        const attrs=attributes(source);if(!attrs.id&&tag!=='button')continue;const element=node(tag,attrs,text||'');controls.push(element);if(element.id)byId.set(element.id,element);
      }
      // Nested block matching above deliberately stays simple; parse controls and
      // named regions separately so this fixture follows the actual rendered IDs.
      for(const[tag]of value.matchAll(/<[a-z]+\b[^>]*\bid="[^"]+"[^>]*>/g)){
        const attrs=attributes(tag.replace(/^<[a-z]+\s*/i,'').replace(/>$/,''));if(byId.has(attrs.id))continue;const element=node(/^<([a-z]+)/i.exec(tag)[1],attrs);controls.push(element);byId.set(element.id,element);
      }
      for(const[,source,text]of value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)){
        const attrs=attributes(source);if(attrs.id&&byId.has(attrs.id))continue;if(controls.some(item=>item.tagName==='BUTTON'&&Object.entries(attrs).filter(([key])=>key.startsWith('data-')).some(([key,value])=>item.attributes[key]===value)))continue;const element=node('button',attrs,text);controls.push(element);if(element.id)byId.set(element.id,element);
      }
      for(const details of controls.filter(item=>item.tagName==='DETAILS')){const summary=node('summary',{},'Summary');summary.closest=selector=>selector==='details'?details:null;details.querySelector=selector=>selector==='summary'?summary:null;controls.push(summary);}
      const form=byId.get('browser-open-form');if(form)form.querySelector=selector=>selector==='button'?controls.find(item=>item.tagName==='BUTTON'&&item.attributes.type==='submit'):null;
    }});return mount;
  }
  replace();globalThis.document=doc;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const open=()=>openBrowserWorkspace({api:async(route,method,body)=>{calls.push({route,method,body});return api(route,method,body,calls);},showModal(){},closeModal(){replace();},toast:message=>toasts.push(message)});
  return{open,calls,toasts,replace,get mount(){return mount;},get html(){return html;},get:selector=>doc.querySelector(selector),buttons:()=>controls.filter(item=>item.tagName==='BUTTON'),focused:()=>doc.activeElement};
}

test('pending background checks disable duplicate actions while task navigation and Done stay usable',async t=>{
  const gate=deferred();let checked=false;const f=interactiveFixture(t,async route=>{if(route==='/api/browser/start'){await gate.promise;checked=true;}return nativeStatus(checked?'2026-10-18T04:01:00Z':undefined);});await f.open();
  const check=f.get('#browser-check-background');check.focus();const pending=check.onclick();
  assert.equal(f.mount.attributes['aria-busy'],'true');assert.match(f.get('#browser-ui-progress').textContent,/Checking background access/);assert.match(f.get('#browser-readiness-content').innerHTML,/Checking…/);assert.doesNotMatch(f.get('#browser-readiness-content').innerHTML,/>Preference checked</);
  assert.equal(f.get('#browser-reconnect').disabled,true);assert.equal(f.get('[data-browser-done]').disabled,false);const second=f.buttons().find(item=>item.dataset.browserTab==='tab-2');assert.equal(second.disabled,false);
  await f.get('#browser-reconnect').onclick();await check.onclick();assert.equal(f.calls.filter(call=>call.route==='/api/browser/start').length,1);assert.equal(f.calls.filter(call=>call.route==='/api/browser/reconnect').length,0);
  second.focus();await second.onclick();assert.equal(f.get('#browser-reconnect').disabled,true,'freshly rendered controls retain the shared pending state');
  gate.resolve();await pending;assert.equal(f.mount.attributes['aria-busy'],'false');assert.equal(f.get('#browser-reconnect').disabled,false);assert.equal(f.get('#browser-ui-progress').hidden,true);assert.equal(f.focused().dataset.browserTab,'tab-2','completion must not steal focus from navigation');
});

test('reconnect preserves newly typed addresses, selection, disclosures, scroll, and input focus',async t=>{
  const gate=deferred(),f=interactiveFixture(t,async route=>{if(route==='/api/browser/reconnect')await gate.promise;return nativeStatus();});await f.open();
  const tab=f.buttons().find(item=>item.dataset.browserTab==='tab-2');await tab.onclick();f.get('#browser-separate').open=true;f.get('#browser-downloads').open=true;
  const reconnect=f.get('#browser-reconnect');reconnect.focus();const pending=reconnect.onclick();const address='https://example.test/?q="<draft>"';f.get('#browser-url').value=address;f.get('#browser-url').focus();f.get('#browser-url').setSelectionRange(8,17,'forward');f.mount.scrollTop=245;f.mount.scrollLeft=9;
  gate.resolve();await pending;assert.equal(f.get('#browser-url').value,address);assert.equal(f.focused(),f.get('#browser-url'));assert.equal(f.get('#browser-url').selectionStart,8);assert.equal(f.get('#browser-url').selectionEnd,17);assert.equal(f.get('#browser-separate').open,true);assert.equal(f.get('#browser-downloads').open,true);assert.equal(f.mount.scrollTop,245);assert.equal(f.mount.scrollLeft,9);assert.match(f.html,/class="browser-tab-row selected"><button[^>]+data-browser-tab="tab-2"/);assert.doesNotMatch(f.html,/<draft>/);
});

test('failed checks preserve their cause and suppress stale verification when status refresh also fails',async t=>{
  let phase='initial';const f=interactiveFixture(t,async route=>{if(route==='/api/browser/start'){phase='failed';throw Error('Native focus policy needs attention.');}if(phase==='failed')throw Error('Status transport failed.');return nativeStatus();});await f.open();await f.get('#browser-check-background').onclick();
  assert.match(f.get('#browser-ui-error').textContent,/Native focus policy needs attention.*Current status could not be refreshed/);assert.match(f.get('#browser-readiness-content').innerHTML,/Unconfirmed/);assert.doesNotMatch(f.get('#browser-readiness-content').innerHTML,/>Preference checked</);assert.equal(f.get('#browser-ui-progress').hidden,false);assert.equal(f.get('#browser-check-background').disabled,false);
});

test('a successful native response remains usable evidence if the later status read fails',async t=>{
  let checked=false;const f=interactiveFixture(t,async route=>{if(route==='/api/browser/start'){checked=true;return nativeStatus('2026-10-18T04:02:00Z');}if(checked)throw Error('Could not refresh tab inventory.');return nativeStatus();});await f.open();await f.get('#browser-check-background').onclick();
  assert.match(f.get('#browser-readiness-content').innerHTML,/>Preference checked</);assert.match(f.get('#browser-readiness-content').innerHTML,/2026-10-18T04:02:00Z/);assert.match(f.get('#browser-ui-error').textContent,/Could not refresh tab inventory/);assert.equal(f.get('#browser-ui-progress').hidden,true);
});

test('keyboard focus follows the recovery control if a failed check changes Check into Start',async t=>{
  let checked=false;const f=interactiveFixture(t,async route=>{if(route==='/api/browser/start'){checked=true;throw Error('Browser disconnected.');}const status=nativeStatus();return checked?{...status,signedBrowser:{nativeIntegration:true,available:false,catalogConnected:false,browserConnected:false,canStart:true,endpoint:'http://127.0.0.1:9010/mcp'}}:status;});await f.open();const button=f.get('#browser-check-background');button.focus();await button.onclick();
  assert.equal(f.get('#browser-check-background'),null);assert.equal(f.focused(),f.get('#browser-start'));assert.equal(f.get('#browser-start').disabled,false);assert.equal(f.focused().focusOptions.preventScroll,true);
});

test('a successful startup updates connection controls even when the follow-up status read fails',async t=>{
  let checked=false;const f=interactiveFixture(t,async route=>{if(route==='/api/browser/start'){checked=true;return nativeStatus('2026-10-18T04:03:00Z');}if(checked)throw Error('Tab inventory is temporarily unavailable.');return{...nativeStatus(),signedBrowser:{nativeIntegration:true,available:false,catalogConnected:false,browserConnected:false,canStart:true}};});await f.open();const start=f.get('#browser-start');start.focus();await start.onclick();
  assert.equal(f.get('#browser-start'),null);assert.ok(f.get('#browser-check-background'));assert.match(f.html,/BrowserOS neo<\/strong><span>Connected/);assert.match(f.get('#browser-readiness-content').innerHTML,/>Preference checked</);assert.equal(f.focused(),f.get('#browser-check-background'));assert.match(f.get('#browser-ui-error').textContent,/Tab inventory is temporarily unavailable/);
});

test('closing and reopening during a background request prevents late refreshes, errors, and detached actions',async t=>{
  const gate=deferred(),f=interactiveFixture(t,async route=>{if(route==='/api/browser/start')await gate.promise;return nativeStatus();});await f.open();const old=f.get('#browser-check-background'),pending=old.onclick();f.replace();await f.open();const reads=f.calls.filter(call=>call.route==='/api/browser/status').length;
  gate.reject(Error('Old request failed.'));await pending;await old.onclick();assert.equal(f.calls.filter(call=>call.route==='/api/browser/status').length,reads);assert.equal(f.calls.filter(call=>call.route==='/api/browser/start').length,1);assert.equal(f.get('#browser-ui-error').textContent,'');assert.equal(f.get('#browser-ui-progress').hidden,true);assert.deepEqual(f.toasts,[]);
});
