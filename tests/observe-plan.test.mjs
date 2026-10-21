import test from 'node:test';
import assert from 'node:assert/strict';
import {observePlan} from '../public/observe-model.mjs';
import {renderObservePlan,initObserveUI} from '../public/observe-ui.mjs';

const step=(id,status,extra={})=>({id,title:'Step '+id,status,...extra});

test('a plan with only blocked unfinished steps never claims all saved work is complete',()=>{
  const saved={steps:[step('done','done'),step('publish','blocked',{blockedReason:'The website needs sign-in.',doneWhen:'Exactly one post exists.'})]},before=structuredClone(saved),model=observePlan(saved),html=renderObservePlan(model);
  assert.equal(model.done,1);assert.equal(model.blocked,1);assert.match(model.summary,/Needs attention: Step publish/);assert.doesNotMatch(model.summary,/complete/);assert.match(html,/The website needs sign-in/);assert.match(html,/>Blocked</);assert.match(html,/Exactly one post exists/);assert.deepEqual(saved,before);
});

test('current, pending, and complete summaries match saved statuses without inventing execution',()=>{
  const active=observePlan({steps:[step('blocked','blocked'),step('active','active'),step('next','pending')]});assert.match(active.summary,/Current: Step active · 1 blocked step/);
  const pending=observePlan({steps:[step('next','pending')]});assert.equal(pending.summary,'Next saved step: Step next');assert.equal(pending.done,0);
  assert.equal(observePlan({steps:[step('done','done')]}).summary,'All saved steps marked complete');
  assert.equal(observePlan({steps:[step('unknown','unexpected')]}).summary,'Some saved steps have an unknown status.');
});

test('a filtered set of complete steps cannot claim hidden blocked steps are complete',()=>{
  const model=observePlan({steps:[step('shown','done'),step('hidden','blocked')]},{stepIds:['shown']});
  assert.equal(model.filtered,true);assert.equal(model.steps.length,1);assert.equal(model.done,1);assert.equal(model.summary,'All shown steps marked complete');
});

test('saved criteria, evidence, notes and blocker reasons render as bounded escaped text',()=>{
  const model=observePlan({steps:[step('unsafe','blocked',{title:'<img onerror=alert(1)>',doneWhen:'<script>criteria</script>',evidence:'<b>proof</b>',note:'<svg onload=alert(2)>',blockedReason:'<iframe src=x>'})]}),html=renderObservePlan(model);
  assert.doesNotMatch(html,/<img|<script|<b>|<svg|<iframe/);assert.match(html,/&lt;script&gt;criteria/);assert.match(html,/Saved evidence/);assert.match(html,/&lt;iframe/);
  const missing=renderObservePlan(observePlan({steps:[step('blocked','blocked')]}));assert.match(missing,/No blocker reason was saved/);
  const long=observePlan({steps:[step('long','done',{title:'x'.repeat(900),evidence:'e'.repeat(9000)})]});assert.equal(long.steps[0].title.length,300);assert.equal(long.steps[0].evidence.length,2000);
  assert.deepEqual(observePlan({steps:'invalid'}).steps,[]);
});

const decode=value=>String(value).replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)]));
function fixture(t){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),elements=new Map(),listeners=new Map();
  const document={activeElement:null,getElementById:()=>({})};globalThis.document=document;
  const basic=()=>({innerHTML:'',textContent:'',hidden:false,value:'',scrollHeight:100,scrollTop:0,clientHeight:100,isConnected:true,classList:{toggle(){},add(){}}});
  const host=basic();host.writes=0;let html='',controls=[],details=[];
  Object.defineProperty(host,'innerHTML',{get:()=>html,set(value){html=value;host.writes++;for(const control of controls)control.isConnected=false;controls=[];details=[];
    for(const[tag]of value.matchAll(/<summary\b[^>]*data-observe-plan-control="[^"]+"[^>]*>/g)){
      const values=attrs(tag);controls.push({isConnected:true,parentHost:host,dataset:{observePlanControl:values['data-observe-plan-control']},focus(options){document.activeElement=this;this.focusOptions=options;}});
    }
    for(const[tag]of value.matchAll(/<details\b[^>]*data-observe-plan-step="[^"]+"[^>]*>/g)){const values=attrs(tag);details.push({dataset:{observePlanStep:values['data-observe-plan-step']},open:/\sopen(?:\s|>)/.test(tag)});}
  }});
  host.contains=node=>node?.parentHost===host&&node.isConnected;host.querySelectorAll=()=>controls;
  const element=key=>{if(key==='#observe-workflow')return null;if(key==='#observe-plan-list')return host;if(!elements.has(key))elements.set(key,basic());return elements.get(key);};
  const mount={...basic(),hidden:false,classList:{add(){}},querySelector:element,querySelectorAll:()=>[],addEventListener:(name,handler)=>listeners.set(name,handler),removeEventListener:name=>listeners.delete(name),contains:()=>true};
  const active={id:'active-run',input:'A real task',status:'running',workflow:{nodes:[],edges:[]},nodes:{},events:[],taskState:{steps:[step('blocked','blocked',{doneWhen:'A checked result exists.',blockedReason:'Waiting for website access.',evidence:'No result yet.'})]}},other={...active,id:'other-run',status:'completed',taskState:{steps:[step('blocked','done',{evidence:'A separate task result.'})]}},snapshot={currentRun:active,runs:[active,other]};
  const ui=initObserveUI({mount,getSnapshot:()=>snapshot,onOpenRun:async()=>{}});
  t.after(()=>{ui.destroy();if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  return{ui,active,other,snapshot,host,element,controls:()=>controls,details:()=>details,focused:()=>document.activeElement,toggle:detail=>listeners.get('toggle')({target:detail}),select:id=>listeners.get('change')({target:{id:'observe-run',value:id}})};
}

test('Activity retains expanded step evidence and focused disclosure across actual saved evidence updates',t=>{
  const f=fixture(t);f.ui.enter();assert.match(f.element('#observe-current-step').textContent,/Needs attention/);assert.equal(f.element('#observe-plan-count').textContent,'0 / 1 · 1 blocked');const detail=f.details()[0];detail.open=true;f.toggle(detail);const summary=f.controls()[0];summary.focus();const writes=f.host.writes;
  f.ui.update();assert.equal(f.host.writes,writes);assert.strictEqual(f.focused(),summary);
  f.active.taskState.steps[0].evidence='Fresh evidence received.';f.ui.update();assert.equal(f.details()[0].open,true);assert.notStrictEqual(f.focused(),summary);assert.equal(f.focused().dataset.observePlanControl,'blocked');assert.equal(f.focused().focusOptions.preventScroll,true);assert.match(f.host.innerHTML,/Fresh evidence received/);
  f.active.taskState.steps[0].status='done';f.ui.update();assert.equal(f.element('#observe-current-step').textContent,'All saved steps marked complete');assert.equal(f.element('#observe-plan-count').textContent,'1 / 1');assert.equal(f.details()[0].open,true);
});

test('changing tasks or leaving releases saved step disclosures and private evidence',async t=>{
  const f=fixture(t);f.ui.enter();f.details()[0].open=true;f.toggle(f.details()[0]);await f.select('other-run');assert.equal(f.details()[0].open,false);assert.doesNotMatch(f.host.innerHTML,/No result yet|Waiting for website access/);assert.match(f.host.innerHTML,/A separate task result/);
  assert.match(f.element('#observe-feed-empty').textContent,/No live updates were captured/);f.ui.leave();assert.equal(f.host.innerHTML,'');assert.equal(f.element('#observe-current-step').textContent,'');
});

test('an empty Activity view cannot navigate an undefined conversation and explains inactive evidence honestly',t=>{
  const f=fixture(t);f.snapshot.currentRun=null;f.snapshot.runs=[];f.ui.enter();assert.equal(f.element('[data-observe-action="conversation"]').disabled,true);assert.equal(f.element('#observe-content').hidden,true);
});
