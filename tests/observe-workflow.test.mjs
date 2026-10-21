import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initObserveUI } from '../public/observe-ui.mjs';

const recordedRun=JSON.parse(await readFile(new URL('./fixtures/observed-delegation-run.json',import.meta.url),'utf8'));
const unescape=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const attributes=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,name,value])=>[name,unescape(value)]));

// This adapter parses the actual generated map nodes and controls. The real
// Observe handlers and workflow zoom/read/restore functions run unchanged.
function fixture(t,{onOpenWorkflow}={}){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),elements=new Map(),listeners=new Map(),opened=[],runRequests=[];
  const doc={activeElement:null,getElementById:()=>({})};globalThis.document=doc;
  const basic=()=>({innerHTML:'',textContent:'',hidden:false,value:'',scrollHeight:100,scrollTop:0,clientHeight:100,isConnected:true,classList:{toggle(){},add(){}},focus(){doc.activeElement=this;}});
  const host=basic();let html='',maps=[],nodes=[],buttons=[];host.writes=0;
  Object.defineProperty(host,'innerHTML',{get:()=>html,set(value){
    html=value;host.writes++;for(const node of [...nodes,...buttons,...maps.map(map=>map.querySelector('[data-workflow-scroll]'))])node.isConnected=false;maps=[];nodes=[];buttons=[];
    const mapTag=/<section\b[^>]*data-workflow-map="[^"]+"[^>]*>/.exec(value)?.[0];if(!mapTag)return;
    const attrs=attributes(mapTag),viewport={...basic(),parentHost:host,dataset:{workflowScroll:''},scrollLeft:0,scrollTop:0,clientWidth:600},canvasAttrs=attributes(/<div\b[^>]*data-workflow-canvas[^>]*>/.exec(value)[0]),canvas={dataset:{width:canvasAttrs['data-width'],height:canvasAttrs['data-height'],zoom:canvasAttrs['data-zoom']},style:{}},size={style:{}};
    const map={dataset:{workflowMap:attrs['data-workflow-map']},querySelector(selector){return selector==='[data-workflow-scroll]'?viewport:selector==='[data-workflow-canvas]'?canvas:selector==='[data-workflow-size]'?size:null;}};maps=[map];
    for(const [tag]of value.matchAll(/<button\b[^>]*>/g)){
      const attrs=attributes(tag),button={...basic(),attributes:attrs,parentHost:host,dataset:Object.fromEntries(Object.entries(attrs).filter(([name])=>name.startsWith('data-')).map(([name,value])=>[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value])),closest(selector){if(selector==='[data-workflow-map]')return this.dataset.workflowAction?map:null;if(selector==='[data-workflow-action]')return this.dataset.workflowAction?this:null;if(selector==='[data-workflow-node]')return this.dataset.workflowNode?this:null;if(selector==='[data-observe-action]')return this.dataset.observeAction?this:null;return null;}};
      buttons.push(button);if(button.dataset.workflowNode)nodes.push(button);
    }
  }});
  host.querySelectorAll=selector=>selector==='[data-workflow-map]'?maps:selector==='[data-workflow-node]'?nodes:selector==='[data-workflow-action]'?buttons.filter(button=>button.dataset.workflowAction):selector==='[data-observe-action]'?buttons.filter(button=>button.dataset.observeAction):selector==='[data-workflow-scroll]'?maps.map(map=>map.querySelector(selector)):[];host.contains=node=>Boolean(node?.isConnected&&node?.parentHost===host);
  const element=key=>{if(key==='#observe-workflow')return host;if(!elements.has(key))elements.set(key,basic());return elements.get(key);};
  const mount={...basic(),hidden:false,classList:{add(){}},querySelector:element,querySelectorAll:()=>[],addEventListener:(name,handler)=>listeners.set(name,handler),removeEventListener:name=>listeners.delete(name),contains:node=>host.contains(node)};
  const active=structuredClone(recordedRun),snapshot={currentRun:active,runs:[active]},ui=initObserveUI({mount,getSnapshot:()=>snapshot,onOpenWorkflow:async(...args)=>{opened.push(args);await onOpenWorkflow?.(...args);},onOpenRun:(...args)=>runRequests.push(args)});
  t.after(()=>{ui.destroy();if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  return{ui,host,element,snapshot,active,opened,runRequests,async enter(){ui.enter();await listeners.get('change')({target:{id:'observe-run',value:snapshot.currentRun.id}});},nodes:()=>nodes,button:action=>buttons.find(button=>button.dataset.observeAction===action),toolbar:action=>buttons.find(button=>button.dataset.workflowAction===action),viewport:()=>maps[0]?.querySelector('[data-workflow-scroll]'),canvas:()=>maps[0]?.querySelector('[data-workflow-canvas]'),async click(target){assert.ok(target,'the rendered target exists');await listeners.get('click')({target});},focus:node=>node.focus(),focused:()=>doc.activeElement};
}

test('Activity renders the authenticated parent-child execution receipt without inventing child runs',async t=>{
  const f=fixture(t);await f.enter();
  assert.equal(f.element('#observe-content').hidden,false);
  assert.match(f.host.innerHTML,/Live authenticated parent-child delegation workflow map/);
  assert.equal(f.nodes().length,5,'three saved workflow nodes plus two actual delegated children');
  assert.deepEqual(f.nodes().filter(node=>node.attributes['data-node-type']==='subagent').map(node=>node.attributes['data-status']),['completed','completed']);
  assert.equal(f.snapshot.runs.length,1);assert.equal(f.snapshot.currentRun.id,recordedRun.id);
  assert.deepEqual(f.runRequests,[[recordedRun.id,'observe']],'Activity selects the actual saved parent run');
});

test('selecting a delegated node opens its detail and routes Workflows to the actual parent step',async t=>{
  const f=fixture(t);await f.enter();const child=f.nodes().find(node=>node.attributes['data-node-type']==='subagent');await f.click(child);
  const selected=f.nodes().find(node=>node.dataset.workflowNode===child.dataset.workflowNode);assert.equal(selected.attributes['aria-pressed'],'true');assert.match(f.host.innerHTML,/workflow-map-detail/);
  const inspect=f.button('workflow');assert.equal(inspect.dataset.nodeId,'agent');await f.click(inspect);
  assert.deepEqual(f.opened,[[recordedRun.id,'agent']]);assert.deepEqual(f.runRequests,[[recordedRun.id,'observe']]);assert.equal(f.snapshot.runs.length,1);
});

test('run graph zoom, pan and keyboard focus survive new execution evidence and routine updates',async t=>{
  const f=fixture(t);await f.enter();const fittedZoom=Number(f.canvas().dataset.zoom);await f.click(f.toolbar('zoom-in'));f.viewport().scrollLeft=185;f.viewport().scrollTop=39;
  const focused=f.nodes().find(node=>node.dataset.workflowNode==='agent');f.focus(focused);const writes=f.host.writes;f.ui.update();assert.equal(f.host.writes,writes,'unchanged snapshots keep mounted graph controls');assert.strictEqual(f.focused(),focused);
  f.active.nodes.agent.output='A newly received final output receipt.';f.ui.update();
  assert.equal(f.host.writes,writes+1);assert.equal(Number(f.canvas().dataset.zoom),fittedZoom*1.2);assert.equal(f.viewport().scrollLeft,185);assert.equal(f.viewport().scrollTop,39);assert.equal(f.focused().dataset.workflowNode,'agent');assert.notStrictEqual(f.focused(),focused,'focus follows the replacement node after an actual evidence update');
});

test('selected details follow fresh receipts while Fit resets only the diagram viewport',async t=>{
  const f=fixture(t);await f.enter();await f.click(f.nodes().find(node=>node.dataset.workflowNode==='agent'));f.active.nodes.agent.output='Verified final evidence';f.ui.update();assert.match(f.host.innerHTML,/Verified final evidence/);
  await f.click(f.toolbar('zoom-in'));f.viewport().scrollLeft=150;f.viewport().scrollTop=50;await f.click(f.toolbar('fit'));
  assert.equal(f.viewport().scrollLeft,0);assert.equal(f.viewport().scrollTop,0);assert.ok(Number(f.canvas().dataset.zoom)<=1);assert.equal(f.nodes().find(node=>node.dataset.workflowNode==='agent').attributes['aria-pressed'],'true');assert.equal(f.snapshot.currentRun.id,recordedRun.id);
});

test('zoom toolbar, scroll region and Inspect step retain keyboard focus when execution receipts refresh',async t=>{
  const f=fixture(t);await f.enter();await f.click(f.nodes().find(node=>node.dataset.workflowNode==='agent'));
  const targets=[{get:()=>f.toolbar('zoom-in'),key:'workflowAction',value:'zoom-in'},{get:()=>f.viewport(),key:'workflowScroll',value:''},{get:()=>f.button('workflow'),key:'observeAction',value:'workflow'}];
  for(const[index,target]of targets.entries()){
    const previous=target.get();f.focus(previous);f.viewport().scrollLeft=170;f.viewport().scrollTop=25;f.active.nodes.agent.output='Updated execution receipt '+index;f.ui.update();
    assert.notStrictEqual(f.focused(),previous,'focus moves to the freshly rendered equivalent control');assert.equal(f.focused().dataset[target.key],target.value);assert.equal(f.viewport().scrollLeft,170);assert.equal(f.viewport().scrollTop,25);if(target.key==='observeAction')assert.equal(f.focused().dataset.nodeId,'agent');
  }
});

test('leaving Activity releases the graph and a different actual run starts without stale selection or viewport',async t=>{
  const f=fixture(t);await f.enter();const fittedZoom=Number(f.canvas().dataset.zoom);await f.click(f.nodes().find(node=>node.dataset.workflowNode==='agent'));await f.click(f.toolbar('zoom-in'));f.viewport().scrollLeft=190;
  f.ui.leave();assert.equal(f.host.innerHTML,'');const other={...structuredClone(recordedRun),id:'other-saved-run',workflowName:'A separate saved run'};f.snapshot.runs=[other];f.snapshot.currentRun=other;await f.enter();
  assert.match(f.host.innerHTML,/A separate saved run workflow map/);assert.equal(Number(f.canvas().dataset.zoom),fittedZoom);assert.equal(f.viewport().scrollLeft,0);assert.ok(f.nodes().every(node=>node.attributes['aria-pressed']==='false'));assert.doesNotMatch(f.host.innerHTML,/workflow-map-detail/);
});
