import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {browserControlDescriptor,browserAssociatedFileInput,browserPointerHitMatches} from '../desktop/browser-control-identity.mjs';
const source = await readFile(new URL('../desktop/browser-driver.mjs',import.meta.url),'utf8');
const snapshotSource=source.slice(source.indexOf('function pageSnapshot('),source.indexOf('\nasync function smoothPageScroll('));
const elementSource=source.slice(source.indexOf('function elementAction('),source.indexOf('\nasync function elementActionResult('));
function fixture() {
 const label={isConnected:true,tagName:'LABEL',textContent:'Resume',children:[],childNodes:[],getAttribute:()=>null,getBoundingClientRect:()=>({width:70,height:20}),tabIndex:-1};
 const input={isConnected:true,tagName:'INPUT',type:'file',name:'resume',labels:[label],value:'',hidden:true,children:[],childNodes:[],getAttribute:()=>null,getBoundingClientRect:()=>({width:0,height:0}),tabIndex:-1,matches:()=>false};
 const unrelated={...input,name:'unrelated',labels:[]}, disabled={...input,name:'disabled',disabled:true};
 const doc={forms:[],title:'Fixture',readyState:'complete',documentElement:{children:[label,input,unrelated,disabled]},querySelectorAll:()=>[],getElementById:()=>null};
 const context=vm.createContext({document:doc,location:{href:'https://example.test/'},getComputedStyle:el=>({display:el.hidden?'none':'block',visibility:'visible'})});
 const snapshot=()=>JSON.parse(JSON.stringify(vm.runInContext(`(${snapshotSource})("fixture","same","",false,${browserControlDescriptor.toString()},${browserAssociatedFileInput.toString()})`,context)));
 const act=(ref,action,args)=>JSON.parse(JSON.stringify(vm.runInContext(`(${elementSource})("fixture",${JSON.stringify(ref)},${JSON.stringify(action)},${JSON.stringify(args)},null,()=>({kind:"file"}),${browserControlDescriptor.toString()},${browserPointerHitMatches.toString()},${browserAssociatedFileInput.toString()})`,context)));
 return {input,label,snapshot,act};
}
test('hidden associated native file input is observable for upload only, not arbitrary hidden or disabled controls',()=>{
 const f=fixture(),snapshot=f.snapshot();
 const files=snapshot.elements.filter(x=>x.type==='file');
 assert.equal(files.length,1);assert.equal(files[0].name,'Resume');assert.equal(files[0].hidden,true);assert.equal(files[0].uploadOnly,true);
 const ref=files[0].ref;
 assert.deepEqual(f.act(ref,'host-inspect',{action:'upload'}),{kind:'file'});
 assert.equal(f.act(ref,'prepare',{action:'click'}).__blackiceElementError.code,'BROWSER_REF_STALE');
 assert.equal(f.act(ref,'host-inspect',{action:'click'}).__blackiceElementError.code,'BROWSER_REF_STALE');
 f.label.isConnected=false;
 assert.equal(f.act(ref,'host-inspect',{action:'upload'}).__blackiceElementError.code,'BROWSER_REF_STALE');
});
test('hidden upload reference cannot be reused after its exact control changes',()=>{
 const f=fixture(),ref=f.snapshot().elements.find(x=>x.type==='file').ref;
 f.input.isConnected=false;
 assert.equal(f.act(ref,'host-inspect',{action:'upload'}).__blackiceElementError.controlBindingCause,'control-disconnected');
});
