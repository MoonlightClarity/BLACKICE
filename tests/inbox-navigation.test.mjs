import test from 'node:test';
import assert from 'node:assert/strict';
import {initInboxUI} from '../public/inbox-ui.mjs';
import {createDraftStore} from '../public/draft-store.mjs';

const escape=value=>String(value??'').replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
const decode=value=>String(value).replace(/&(amp|lt|gt|quot);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"'}[name]));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const task=(id='one',extra={})=>({id,revision:1,title:'Task '+id,input:'Instructions '+id,cwd:'C:/work',status:'queued',attempts:[],attachmentIds:[],...extra});
const snapshot=items=>({items:structuredClone(items),status:{autoRun:false,paused:false,pending:items.filter(item=>item.status==='queued').length,active:items.filter(item=>item.status==='running').length,completed:items.filter(item=>item.status==='completed').length},settings:{pauseOnFailure:true}});
class Storage{values=new Map();get length(){return this.values.size;}key(index){return[...this.values.keys()][index];}getItem(key){return this.values.get(key)??null;}setItem(key,value){this.values.set(key,value);}removeItem(key){this.values.delete(key);}}

// The fixture models node replacement, focus, selector matching and event
// handlers. Removing focused descendants moves focus to the document body,
// so a render cannot pass by retaining a detached test double.
function dom(){
  const listeners=new Map();let document;
  class Element{
    constructor(tag='div',attributes={}){this.tagName=tag.toUpperCase();this.attributes={...attributes};this.children=[];this.parent=null;this.scrollTop=0;this.scrollLeft=0;this.selectionStart=0;this.selectionEnd=0;this._text='';this._value=decode(attributes.value||'');this.dataset=new Proxy({}, {get:(_target,key)=>this.attributes['data-'+String(key).replace(/[A-Z]/g,char=>'-'+char.toLowerCase())],set:(_target,key,value)=>{this.attributes['data-'+String(key).replace(/[A-Z]/g,char=>'-'+char.toLowerCase())]=String(value);return true;}});this.classList={add:name=>this.attributes.class=[this.attributes.class,name].filter(Boolean).join(' ')};}
    get id(){return this.attributes.id||'';}get type(){return this.attributes.type||(this.tagName==='BUTTON'?'submit':this.tagName==='INPUT'?'text':'');}
    get disabled(){return Object.hasOwn(this.attributes,'disabled');}set disabled(value){if(value)this.attributes.disabled='';else delete this.attributes.disabled;}
    get hidden(){return Object.hasOwn(this.attributes,'hidden');}set hidden(value){if(value)this.attributes.hidden='';else delete this.attributes.hidden;}
    get tabIndex(){return Object.hasOwn(this.attributes,'tabindex')?Number(this.attributes.tabindex):['BUTTON','INPUT','TEXTAREA','SELECT','SUMMARY'].includes(this.tagName)?0:-1;}set tabIndex(value){this.attributes.tabindex=String(value);}
    get isConnected(){return this===document.body||Boolean(this.parent?.isConnected);}
    get value(){return this._value;}set value(value){this._value=String(value);}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}set textContent(value){this.replaceChildren();this._text=String(value);}
    get innerHTML(){return this._html||'';}set innerHTML(value){this.replaceChildren();this._html=String(value);parse(this,String(value));}
    replaceChildren(){if(this.contains(document.activeElement)&&document.activeElement!==this)document.activeElement=document.body;for(const child of this.children)child.parent=null;this.children=[];this._text='';}
    append(child){child.parent=this;this.children.push(child);}
    contains(node){for(let current=node;current;current=current.parent)if(current===this)return true;return false;}
    matches(selector){return selector.split(',').some(part=>match(this,part.trim()));}
    closest(selector){for(let node=this;node;node=node.parent)if(node.matches(selector))return node;return null;}
    querySelectorAll(selector){const output=[];const walk=node=>{for(const child of node.children){if(child.matches(selector))output.push(child);walk(child);}};walk(this);return output;}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    setAttribute(name,value){this.attributes[name]=String(value);}getAttribute(name){return this.attributes[name]??null;}
    getClientRects(){return this.isConnected&&!this.closest('[hidden],[inert]')?[{}]:[];}
    focus(){if(this.isConnected&&!this.disabled)document.activeElement=this;}
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
    requestSubmit(){return document.emit('submit',this);}
    insertAdjacentHTML(position,html){const fragment=new Element();parse(fragment,html);if(position==='afterbegin'){for(const child of fragment.children)child.parent=this;this.children.unshift(...fragment.children);}else if(position==='beforebegin'){const parent=this.parent;if(!parent)return;for(const child of fragment.children)child.parent=parent;parent.children.splice(parent.children.indexOf(this),0,...fragment.children);}else for(const child of fragment.children)this.append(child);}
  }
  function simple(node,selector){
    const attrs=[...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];for(const [,name,value]of attrs)if(!Object.hasOwn(node.attributes,name)||value!==undefined&&node.attributes[name]!==value)return false;
    const plain=selector.replace(/\[[^\]]*\]/g,''),tag=/^[a-z]+/i.exec(plain)?.[0],id=/#([\w-]+)/.exec(plain)?.[1],classes=[...plain.matchAll(/\.([\w-]+)/g)].map(match=>match[1]);
    return(!tag||node.tagName===tag.toUpperCase())&&(!id||node.id===id)&&classes.every(name=>(node.attributes.class||'').split(/\s+/).includes(name));
  }
  function match(node,selector){const parts=selector.split(/\s+(?![^\[]*\])/);if(!simple(node,parts.pop()))return false;let ancestor=node.parent;while(parts.length){const part=parts.pop();while(ancestor&&!simple(ancestor,part))ancestor=ancestor.parent;if(!ancestor)return false;ancestor=ancestor.parent;}return true;}
  function parse(root,html){
    const stack=[root],voids=new Set(['input','img','br','hr','meta','link']);
    for(const token of html.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)){
      const text=token[0];if(text.startsWith('</')){if(stack.length>1)stack.pop();continue;}
      if(!text.startsWith('<')){const current=stack.at(-1);current._text+=decode(text);if(current.tagName==='TEXTAREA')current._value+=decode(text);continue;}
      const tag=/^<([a-z][\w-]*)/i.exec(text)[1],attrs={};for(const [,name,value]of text.slice(tag.length+1,-1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g))attrs[name]=decode(value??'');
      const node=new Element(tag,attrs);stack.at(-1).append(node);if(!voids.has(tag)&&!text.endsWith('/>'))stack.push(node);
    }
  }
  document={body:null,activeElement:null,addEventListener(type,handler){const group=listeners.get(type)||[];group.push(handler);listeners.set(type,group);},querySelector:selector=>document.body.querySelector(selector),async emit(type,target,extra={}){const event={type,target,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...extra};for(const handler of listeners.get(type)||[])await handler(event);return event;},show(html){document.body.innerHTML='<section class="modal">'+html+'</section>';},close(){document.body.innerHTML='';},external(){const node=new Element('button',{id:'external-control'});document.body.append(node);node.focus();return node;}};
  document.body=new Element('body');document.activeElement=document.body;return document;
}

function fixture(t,{items=[task()],api:intercept}={}){
  const previous={document:globalThis.document,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout},document=dom(),timers=new Map(),requests=[],receipts=[],opened=[],messages=[],storage=new Storage(),draftStore=createDraftStore({storage});let data=snapshot(items),nextTimer=0;
  globalThis.document=document;globalThis.setTimeout=(callback,delay,...args)=>{if(delay!==1400)return previous.setTimeout(callback,delay,...args);const timer={inboxTimer:++nextTimer};timers.set(timer,callback);return timer;};globalThis.clearTimeout=timer=>timer?.inboxTimer?timers.delete(timer):previous.clearTimeout(timer);
  const api=async(route,method='GET',body)=>{requests.push({route,method,body:structuredClone(body)});const fallback=()=>structuredClone(data);return intercept?intercept(route,method,body,fallback):fallback();};
  const ui=initInboxUI({api,showModal:(_type,html)=>document.show(html),closeModal:()=>document.close(),toast:(message,error)=>messages.push({message,error}),escape,icon:()=>'',getCwd:()=> 'C:/work',draftStore,onOpenRun:async id=>opened.push(id),onRunStarted:async(run,{isCurrent})=>{receipts.push({run:structuredClone(run),isCurrent});if(isCurrent())opened.push(run.id);}});
  t.after(()=>{ui.cancel();for(const[key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
  const find=selector=>{const node=document.querySelector(selector);assert.ok(node,'Missing control: '+selector);return node;};
  return{ui,document,find,requests,receipts,opened,messages,draftStore,setItems(items){data=snapshot(items);},async tick(){const [timer,callback]=timers.entries().next().value||[];assert.ok(callback,'Inbox poll should be scheduled');timers.delete(timer);await callback();},async click(selector){const node=find(selector);node.focus();return document.emit('click',node);},async input(id,value){const node=find('#'+id);node.value=value;return document.emit('input',node);},key(key){return document.emit('keydown',document.activeElement,{key});},submit(){return document.emit('submit',find('#inbox-editor'));}};
}

test('Inbox preserves nodes when unchanged and restores focus plus scroll when a poll changes content',async t=>{
  const f=fixture(t,{items:[task('one'),task('two')]});await f.ui.open();
  const row=f.find('[data-inbox="select"][data-id="two"]');row.focus();f.find('.inbox-list').scrollTop=44;f.find('.inbox-detail').scrollTop=91;f.find('#inbox-view').scrollTop=12;
  await f.tick();assert.equal(f.document.activeElement,row);assert.equal(row.isConnected,true,'unchanged data retains actual nodes');
  f.setItems([task('one'),task('two',{title:'Updated title'})]);await f.tick();
  assert.equal(row.isConnected,false);assert.equal(f.document.activeElement,f.find('[data-inbox="select"][data-id="two"]'));assert.equal(f.find('.inbox-list').scrollTop,44);assert.equal(f.find('.inbox-detail').scrollTop,91);assert.equal(f.find('#inbox-view').scrollTop,12);
});

test('Inbox polls leave outside focus alone and choose a surviving row when a focused task leaves the tab',async t=>{
  const f=fixture(t,{items:[task('one'),task('two')]});await f.ui.open();const outside=f.document.external();
  f.setItems([task('one',{title:'Changed'}),task('two')]);await f.tick();assert.equal(f.document.activeElement,outside);
  f.find('[data-inbox="select"][data-id="two"]').focus();f.setItems([task('one'),task('two',{status:'completed'})]);await f.tick();assert.equal(f.document.activeElement,f.find('[data-inbox="select"][data-id="one"]'));
});

test('Inbox tabs have one tab stop, keyboard navigation, a labelled panel and an announced current task',async t=>{
  const f=fixture(t,{items:[task('next'),task('done',{status:'completed'}),task('trash',{status:'deleted'})]});await f.ui.open();f.find('#inbox-tab-queued').focus();
  for(const [key,id]of [['ArrowRight','history'],['End','deleted'],['ArrowRight','queued'],['ArrowLeft','deleted'],['Home','queued']]){
    const event=await f.key(key);assert.equal(event.defaultPrevented,true);assert.equal(event.stopped,true);assert.equal(f.document.activeElement.id,'inbox-tab-'+id);
    const tabs=f.document.querySelector('.inbox-tabs').querySelectorAll('[role="tab"]');assert.equal(tabs.filter(tab=>tab.tabIndex===0).length,1);assert.equal(f.document.activeElement.getAttribute('aria-selected'),'true');assert.equal(f.find('#inbox-panel').getAttribute('aria-labelledby'),'inbox-tab-'+id);assert.equal(f.document.activeElement.getAttribute('aria-controls'),'inbox-panel');
  }
  await f.click('#inbox-tab-history');assert.equal(f.find('[data-inbox="select"][data-id="done"]').getAttribute('aria-current'),'true');assert.equal(f.find('#inbox-detail').textContent.includes('Task done'),true);assert.equal(f.requests.filter(call=>call.method!=='GET').length,0);
});

test('an abandoned Inbox start retains its real receipt without navigating into a replacement draft',async t=>{
  const held=deferred(),f=fixture(t,{api:(route,method,_body,fallback)=>method==='POST'&&route.endsWith('/run')?held.promise:fallback()});await f.ui.open();const starting=f.click('[data-inbox="run"]');
  f.ui.close();await f.ui.open({draft:{input:'My newer task',cwd:'C:/work'}});f.find('#inbox-input').focus();const focused=f.document.activeElement;
  const run={id:'actual-started-run',status:'running'};f.setItems([task('one',{status:'running',runId:run.id})]);held.resolve({run});await starting;
  assert.deepEqual(f.receipts.map(receipt=>receipt.run),[run]);assert.equal(f.receipts[0].isCurrent(),false);assert.deepEqual(f.opened,[]);assert.equal(f.find('#inbox-input').value,'My newer task');assert.equal(f.document.activeElement,focused);assert.deepEqual(f.messages,[]);
  f.ui.close();await f.ui.open({selectedId:'one'});assert.equal(f.find('[data-inbox="open-run"]').dataset.runId,run.id,'the started task remains inspectable');
});

test('an Inbox start that still owns its view exposes exactly one navigation receipt',async t=>{
  const f=fixture(t,{api:(route,method,_body,fallback)=>method==='POST'&&route.endsWith('/run')?{run:{id:'owned-run'}}:fallback()});await f.ui.open();await f.click('[data-inbox="run"]');assert.deepEqual(f.opened,['owned-run']);assert.equal(f.receipts.length,1);assert.equal(f.receipts[0].isCurrent(),true);
});

for(const succeeds of [true,false])test(`a late Inbox draft ${succeeds?'save':'failure'} preserves a different draft and its focused field`,async t=>{
  const held=deferred(),f=fixture(t,{api:(route,method,_body,fallback)=>route==='/api/inbox'&&method==='POST'?held.promise:fallback()});await f.ui.open({draft:{input:'Original task',cwd:'C:/work'}});const saving=f.submit();
  f.ui.close();await f.ui.open({draft:{input:'Independent newer draft',cwd:'C:/work'}});const field=f.find('#inbox-input');field.focus();field.setSelectionRange(3,8);
  if(succeeds)held.resolve(task('saved',{input:'Original task'}));else held.reject(new Error('Original save failed'));await saving;
  assert.equal(f.find('#inbox-input'),field);assert.equal(field.value,'Independent newer draft');assert.equal(f.document.activeElement,field);assert.deepEqual([field.selectionStart,field.selectionEnd],[3,8]);assert.deepEqual(f.messages,[]);
  const drafts=f.draftStore.list().map(cached=>cached.data.draft.input);assert.ok(drafts.includes('Independent newer draft'));assert.equal(drafts.includes('Original task'),!succeeds);
});

test('reopening a pending draft prevents a duplicate create and rebases newer text as an edit of the saved task',async t=>{
  const held=deferred();let saves=0;const f=fixture(t,{api:(route,method,body,fallback)=>{if(route==='/api/inbox'&&method==='POST'){saves++;return held.promise;}if(method==='PUT')return task('saved',{...body,revision:2});return fallback();}});
  await f.ui.open({draft:{input:'Original task',cwd:'C:/work'}});const saving=f.submit();f.ui.close();await f.ui.open();
  assert.equal(f.find('#inbox-editor button[type="submit"]').disabled,true);await f.submit();assert.equal(saves,1);
  await f.input('inbox-input','Newer text in reopened draft');f.setItems([task('saved',{input:'Original task'})]);held.resolve(task('saved',{input:'Original task'}));await saving;
  assert.equal(f.find('#inbox-input').value,'Newer text in reopened draft');assert.equal(f.find('#inbox-editor button[type="submit"]').disabled,false);assert.equal(f.draftStore.list()[0].data.editingId,'saved');
  await f.submit();const edits=f.requests.filter(call=>call.method==='PUT');assert.equal(edits.length,1);assert.equal(edits[0].route,'/api/inbox/saved');assert.equal(edits[0].body.expectedRevision,1);assert.equal(edits[0].body.input,'Newer text in reopened draft');assert.equal(saves,1);
});

test('a stale Inbox load cannot replace a newer dialog or restart its polling loop',async t=>{
  const held=deferred();let reads=0;const f=fixture(t,{api:(_route,_method,_body,fallback)=>++reads===1?held.promise:fallback()});const first=f.ui.open({selectedId:'old'});f.ui.close();f.setItems([task('new')]);await f.ui.open({selectedId:'new'});
  const row=f.find('[data-inbox="select"][data-id="new"]');row.focus();held.resolve(snapshot([task('old')]));await first;assert.equal(f.document.activeElement,row);assert.equal(f.find('[aria-current="true"]').dataset.id,'new');await f.tick();assert.equal(reads,3);
});

test('a failed save restores the originating focused field and its text selection',async t=>{
  const held=deferred(),f=fixture(t,{api:(route,method,_body,fallback)=>route==='/api/inbox'&&method==='POST'?held.promise:fallback()});await f.ui.open({draft:{input:'Keep all of this text',cwd:'C:/work'}});
  const before=f.find('#inbox-input');before.focus();before.setSelectionRange(5,11);const saving=f.submit();assert.equal(f.document.activeElement,f.find('#inbox-view'),'disabled fields leave focus in the live dialog');held.reject(new Error('Try saving again'));await saving;
  const after=f.find('#inbox-input');assert.equal(f.document.activeElement,after);assert.equal(after.value,'Keep all of this text');assert.deepEqual([after.selectionStart,after.selectionEnd],[5,11]);assert.equal(f.find('#inbox-editor button[type="submit"]').disabled,false);assert.equal(f.messages.at(-1).message,'Try saving again');
});

test('newer text left in an abandoned original draft is rebased without touching the current draft',async t=>{
  const held=deferred(),f=fixture(t,{api:(route,method,_body,fallback)=>route==='/api/inbox'&&method==='POST'?held.promise:fallback()});await f.ui.open({draft:{input:'Submitted text',cwd:'C:/work'}});const saving=f.submit();
  await f.input('inbox-input','Later original text');f.ui.close();await f.ui.open({draft:{input:'Independent task',cwd:'C:/work'}});held.resolve(task('saved',{input:'Submitted text',revision:3}));await saving;
  assert.equal(f.find('#inbox-input').value,'Independent task');const original=f.draftStore.list().find(cached=>cached.data.draft.input==='Later original text');assert.ok(original);assert.equal(original.data.editingId,'saved');assert.equal(original.data.baseRevision,3);
});

test('an abandoned Pause and edit does not open its editor over a newer draft',async t=>{
  const held=deferred(),f=fixture(t,{items:[task('armed',{startWhenIdle:true})],api:(route,_method,_body,fallback)=>route==='/api/inbox/pause'?held.promise:fallback()});await f.ui.open();const editing=f.click('[data-inbox="edit"]');f.ui.close();await f.ui.open({draft:{input:'New draft after leaving',cwd:'C:/work'}});held.resolve({paused:true});await editing;assert.equal(f.find('#inbox-input').value,'New draft after leaving');assert.deepEqual(f.messages,[]);
});
