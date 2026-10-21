import test from 'node:test';
import assert from 'node:assert/strict';
import { initConfigureUI } from '../public/configure-ui.mjs';

// A small DOM fixture replaces nodes on innerHTML and refuses focus on disabled
// controls, so these tests exercise controller behavior rather than HTML strings.
const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity]));
class Element {
  constructor(document,tag,attributes={}){this.ownerDocument=document;this.tagName=tag.toUpperCase();this.attributes=attributes;this.children=[];this.parentElement=null;this.text='';this.id=attributes.id||'';this.type=attributes.type||(tag==='input'?'text':'');this.disabled='disabled'in attributes;this.open='open'in attributes;this.checked='checked'in attributes;this.classList={add(){},remove(){}};this.selectionStart=this.selectionEnd=['TEXTAREA','INPUT'].includes(this.tagName)&&['','text'].includes(this.type)?0:null;this.selectionDirection='none';}
  get dataset(){return Object.fromEntries(Object.entries(this.attributes).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));}
  get value(){if(this.editedValue!==undefined)return this.editedValue;if(this.tagName==='SELECT'){const options=this.querySelectorAll('option');return(options.find(option=>'selected'in option.attributes)||options[0])?.attributes.value||'';}return this.tagName==='TEXTAREA'?decode(this.text):this.attributes.value||'';}
  set value(value){this.editedValue=String(value);}
  contains(element){for(let node=element;node;node=node.parentElement)if(node===this)return true;return false;}
  matches(selector){return selector.split(',').some(part=>{const tokens=part.trim().replaceAll('>',' > ').split(/\s+/);const simple=(node,token)=>{if(!node)return false;const tag=/^[a-z][\w-]*/i.exec(token)?.[0];if(tag&&node.tagName!==tag.toUpperCase())return false;const id=/#([\w-]+)/.exec(token)?.[1];if(id&&node.id!==id)return false;for(const match of token.matchAll(/\.([\w-]+)/g))if(!(node.attributes.class||'').split(/\s+/).includes(match[1]))return false;for(const match of token.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g))if(!(match[1]in node.attributes)||match[2]!==undefined&&node.attributes[match[1]]!==match[2])return false;return true;};const chain=(node,index)=>{if(!simple(node,tokens[index]))return false;if(index===0)return true;if(tokens[index-1]==='>')return chain(node.parentElement,index-2);for(let parent=node.parentElement;parent;parent=parent.parentElement)if(chain(parent,index-1))return true;return false;};return chain(this,tokens.length-1);});}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  querySelectorAll(selector){const result=[];const visit=node=>{for(const child of node.children){if(child.matches(selector))result.push(child);visit(child);}};visit(this);return result;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  focus(options){if(!this.disabled&&!this.closest('[hidden]')){this.ownerDocument.activeElement=this;this.lastFocusOptions=options;}}
  setSelectionRange(start,end,direction='none'){if(this.selectionStart===null)throw new Error('Selection is unsupported');this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}
}
class Mount extends Element {
  constructor(document){super(document,'div');this.handlers=new Map();this.writes=0;}
  get innerHTML(){return this.markup;}
  set innerHTML(markup){
    if(this.contains(this.ownerDocument.activeElement))this.ownerDocument.activeElement=this.ownerDocument.body;
    for(const child of this.children)child.parentElement=null;this.children=[];this.markup=markup;this.writes++;const stack=[this],voids=new Set(['input','br','hr','img','meta','link','area','base','embed','source','track','wbr']);
    for(const token of markup.match(/<[^>]+>|[^<]+/g)||[]){
      if(token.startsWith('</')){const tag=token.slice(2,-1).toUpperCase();while(stack.length>1&&stack.pop().tagName!==tag){};continue;}
      if(token.startsWith('<')){const [,tag,rest]=/^<([\w-]+)([\s\S]*?)>$/.exec(token)||[];if(!tag)continue;const attributes=Object.fromEntries([...rest.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([,key,value])=>[key,decode(value||'')])),node=new Element(this.ownerDocument,tag,attributes),parent=stack.at(-1);parent.children.push(node);node.parentElement=parent;if(!voids.has(tag))stack.push(node);}
      else stack.at(-1).text+=token;
    }
  }
  addEventListener(type,handler){this.handlers.set(type,handler);}
  removeEventListener(type){this.handlers.delete(type);}
  event(type,target){return this.handlers.get(type)?.({target,preventDefault(){}});}
  click(action,index=0){const target=this.querySelectorAll(`[data-configure="${action}"]`)[index];assert.ok(target,`Action ${action} exists`);target.focus();return this.event('click',target);}
  input(selector,value){const target=this.querySelector(selector);assert.ok(target,`Field ${selector} exists`);target.value=value;return this.event(target.tagName==='SELECT'?'change':'input',target);}
  toggle(section,open=true){const target=this.querySelector(`[data-configure-section="${section}"]`);assert.ok(target,`Section ${section} exists`);target.open=open;return this.event('toggle',target);}
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const settings=()=>({maxConcurrentRuns:null,codexHistory:'relay',runTimeoutMs:null,providerIdleTimeoutMs:300000});
const workflow=(id='first')=>({id,name:`Workflow ${id}`,nodes:[{id:'one',type:'agent',name:'First step',prompt:'Saved instructions',model:'default'},{id:'two',type:'agent',name:'Second step',prompt:'More instructions',model:'default'}],edges:[{source:'one',target:'two'}],settings:{}});
function setup(t,options={}){
  const previous={exists:Object.hasOwn(globalThis,'document'),value:globalThis.document},document={};document.body=new Element(document,'body');document.activeElement=document.body;const mount=new Mount(document);mount.parentElement=document.body;document.body.children.push(mount);globalThis.document=document;
  const current={status:{runtimeSettings:settings(),execution:{capacity:null,unlimited:true}},workflow:workflow(),workflows:[workflow(),workflow('second')]},ui=initConfigureUI({mount,getSnapshot:()=>current,api:async()=>settings(),...options});
  t.after(()=>{ui.destroy();if(previous.exists)globalThis.document=previous.value;else delete globalThis.document;});
  return{document,mount,current,ui,focus(selector,index=0){const target=mount.querySelectorAll(selector)[index];assert.ok(target,`Focus target ${selector} exists`);target.focus();return target;}};
}

for(const section of ['execution','preferences'])test(`${section} disclosure keeps keyboard focus through asynchronous settings loading`,async t=>{
  const read=deferred(),{document,mount,focus}=setup(t,{api:()=>read.promise}),selector=`[data-configure-section="${section}"] > summary`,initial=focus(selector),loading=mount.toggle(section);
  assert.notStrictEqual(document.activeElement,initial,'loading replaces the disclosure node');assert.strictEqual(document.activeElement,mount.querySelector(selector));
  read.resolve(settings());await loading;assert.strictEqual(document.activeElement,mount.querySelector(selector));assert.deepEqual(document.activeElement.lastFocusOptions,{preventScroll:true});
});

test('a pending settings response preserves the action the user moved to, including duplicate actions',async t=>{
  const read=deferred(),{document,mount,focus}=setup(t,{api:()=>read.promise,onOperations(){}}),loading=mount.toggle('preferences'),selector='[data-configure="operations"]';
  const actions=mount.querySelectorAll(selector);assert.equal(actions.length,2,'the workspace and schedule sections each have an operations link');const chosen=focus(selector,1);
  read.resolve(settings());await loading;assert.notStrictEqual(document.activeElement,chosen);assert.strictEqual(document.activeElement,mount.querySelectorAll(selector)[1],'the later duplicate must not jump to the first link');
});

test('a late settings response leaves focus outside Settings where the user put it',async t=>{
  const read=deferred(),{document,mount}=setup(t,{api:()=>read.promise}),loading=mount.toggle('execution'),outside=new Element(document,'button');outside.parentElement=document.body;document.body.children.push(outside);outside.focus();
  read.resolve(settings());await loading;assert.strictEqual(document.activeElement,outside);
});

test('workflow and step selection retain their focus after selecting a new value',async t=>{
  const selected=deferred(),{document,mount,current,ui,focus}=setup(t,{onSelectWorkflow:()=>selected.promise});ui.showWorkflows();
  focus('[data-configure-field="workflow"]');const selecting=mount.input('[data-configure-field="workflow"]','second');current.workflow=current.workflows[1];selected.resolve();await selecting;
  assert.strictEqual(document.activeElement,mount.querySelector('[data-configure-field="workflow"]'));assert.equal(document.activeElement.value,'second');
  focus('[data-configure-field="step"]');await mount.input('[data-configure-field="step"]','two');assert.strictEqual(document.activeElement,mount.querySelector('[data-configure-field="step"]'));assert.equal(document.activeElement.value,'two');
});

test('a workflow conflict retains draft text, focus and selection direction',async t=>{
  let writes=0;const{document,mount,current,ui,focus}=setup(t,{onUpdateWorkflow:()=>{writes++;}});ui.showWorkflows();await mount.click('edit');
  await mount.input('[data-configure-draft="name"]','Unsaved name');await mount.input('[data-configure-draft="prompt"]','Unsaved instruction wording');const original=focus('[data-configure-draft="prompt"]');original.setSelectionRange(3,16,'backward');current.workflow.nodes[0].prompt='Changed in another view';
  await mount.event('submit',mount.querySelector('#configure-step-editor'));
  const restored=mount.querySelector('[data-configure-draft="prompt"]');assert.strictEqual(document.activeElement,restored);assert.equal(restored.value,'Unsaved instruction wording');assert.equal(mount.querySelector('[data-configure-draft="name"]').value,'Unsaved name');assert.deepEqual([restored.selectionStart,restored.selectionEnd,restored.selectionDirection],[3,16,'backward']);assert.equal(writes,0);
});

test('independent history loading preserves an edited duration and its text selection',async t=>{
  const read=deferred();let reads=0;const{document,mount,focus}=setup(t,{api:()=>++reads===1?settings():read.promise});await mount.toggle('preferences');await mount.input('#configure-runTimeoutMs','limit');await mount.input('[data-configure-runtime="amount"][data-configure-runtime-key="runTimeoutMs"]','13.5');
  const loading=mount.toggle('history'),selector='[data-configure-runtime="amount"][data-configure-runtime-key="runTimeoutMs"]',original=focus(selector);original.setSelectionRange(1,4,'backward');read.resolve({...settings(),runTimeoutMs:2000});await loading;
  const restored=mount.querySelector(selector);assert.strictEqual(document.activeElement,restored);assert.equal(restored.value,'13.5','an unrelated GET cannot overwrite the runtime draft');assert.deepEqual([restored.selectionStart,restored.selectionEnd,restored.selectionDirection],[1,4,'backward']);
});

test('busy recovery controls move focus to their disclosure and do not steal it back on completion',async t=>{
  const exporting=deferred(),{document,mount}=setup(t,{onSupport:()=>exporting.promise});await mount.toggle('recovery');const pending=mount.click('support'),summary='[data-configure-section="recovery"] > summary';
  assert.equal(mount.querySelector('[data-configure="support"]').disabled,true);assert.strictEqual(document.activeElement,mount.querySelector(summary));exporting.resolve({});await pending;assert.strictEqual(document.activeElement,mount.querySelector(summary));assert.equal(mount.querySelector('[data-configure="support"]').disabled,false);
});

test('focused actions retain ownership during a changed status render',t=>{
  const{document,mount,current,ui,focus}=setup(t,{onConnections(){}}),original=focus('[data-configure="connections"]');current.status.version='New status';ui.update();assert.notStrictEqual(document.activeElement,original);assert.strictEqual(document.activeElement,mount.querySelector('[data-configure="connections"]'));
});
