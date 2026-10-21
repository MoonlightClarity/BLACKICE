import test from 'node:test';
import assert from 'node:assert/strict';
import {initArtifactUI} from '../public/artifact-ui.mjs';
const held=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const preview=(name='board.svg',extra={})=>({artifact:{title:name,fileName:name,size:100,path:`C:\\fixture\\${name}`,sha256:'a'.repeat(64)},previewKind:'text',content:'<svg/>',...extra});
function fixture(t,api,{openNative}={}){
  const oldDocument=globalThis.document,nodes=new Map(),calls=[];let modal,viewEpoch=0,closed=0,focused;
  const detach=node=>{if(!node)return;node.isConnected=false;for(const id of node.childIds||[])detach(nodes.get(id));};
  function make(id){const node={id,isConnected:true,textContent:'',disabled:false,focus(){focused=this;},classList:{add(){}},childIds:[]};Object.defineProperty(node,'innerHTML',{get(){return this.html||'';},set(html){for(const child of this.childIds){detach(nodes.get(child));nodes.delete(child);}this.childIds=[];this.html=html;for(const match of html.matchAll(/id="([^"]+)"/g)){this.childIds.push(match[1]);nodes.set(match[1],make(match[1]));}}});node.insertAdjacentHTML=(_,html)=>{node.innerHTML+=html;};return node;}
  const showModal=(kind,html)=>{detach(modal);nodes.clear();modal=make('modal');modal.innerHTML=html;};
  const closeModal=()=>{detach(modal);nodes.clear();modal=null;closed++;};
  globalThis.document={getElementById:id=>nodes.get(id),querySelector:()=>modal};t.after(()=>{globalThis.document=oldDocument;});
  const ui=initArtifactUI({api:(url,options)=>{calls.push({url,options});return api(url,options);},showModal,closeModal,escape,icon:()=>'',renderMarkdown:value=>`<p>${escape(value)}</p>`,safeSvgPreview:value=>value==='<svg/>'?'data:image/svg+xml;base64,c3Zn':null,openNative,captureOwnership:()=>viewEpoch,ownsOwnership:epoch=>epoch===viewEpoch});
  return{ui,calls,node:id=>nodes.get(id),focused:()=>focused,replace:()=>showModal('other','<div id="other">Other work</div>'),leaveView:()=>{viewEpoch++;},close:()=>{ui.cancel();closeModal();},closed:()=>closed,markup:()=>nodes.get('artifact-view')?.innerHTML||'',actions:()=>nodes.get('artifact-actions')?.innerHTML||''};
}
const ids={taskId:'task-one',artifactId:'artifact_one'};
test('opening immediately shows an owned loading state and the actual checked SVG preview',async t=>{
  const pending=held(),f=fixture(t,()=>pending.promise),opening=f.ui.open(ids);
  assert.match(f.markup(),/Reading file/);assert.equal(f.calls.length,1);
  assert.strictEqual(f.focused(),f.node('artifact-close'));
  pending.resolve(preview());assert.equal(await opening,true);
  assert.equal(f.node('artifact-title').textContent,'board.svg');assert.match(f.markup(),/data:image\/svg\+xml/);assert.match(f.markup(),/SVG source/);assert.match(f.markup(),/File details/);assert.match(f.actions(),/\/api\/tasks\/task-one\/artifacts\/artifact_one\/content/);
});
test('closing aborts the read and a late response cannot reopen the dialog',async t=>{
  const pending=held(),f=fixture(t,()=>pending.promise),opening=f.ui.open(ids);f.close();
  assert.equal(f.calls[0].options.signal.aborted,true);pending.resolve(preview());assert.equal(await opening,false);assert.equal(f.node('artifact-title'),undefined);assert.equal(f.closed(),1);
});
test('a delayed preview never replaces a newer modal or renders its stale failure',async t=>{
  const pending=held(),f=fixture(t,()=>pending.promise),opening=f.ui.open(ids);f.replace();pending.reject(Error('stale failure'));
  assert.equal(await opening,false);assert.ok(f.node('other'));assert.equal(f.node('artifact-retry'),undefined);
});
test('rapid selections keep the newest file when earlier reads complete last',async t=>{
  const a=held(),b=held(),f=fixture(t,url=>url.includes('artifact_one')?a.promise:b.promise);
  const first=f.ui.open(ids),second=f.ui.open({...ids,artifactId:'artifact_two'});b.resolve(preview('second.md'));assert.equal(await second,true);a.resolve(preview('first.svg'));assert.equal(await first,false);assert.equal(f.node('artifact-title').textContent,'second.md');
});
test('a changed chat or mode dismisses only the preview that still owns the dialog',async t=>{
  const pending=held(),f=fixture(t,()=>pending.promise),opening=f.ui.open(ids);f.leaveView();pending.resolve(preview());assert.equal(await opening,false);assert.equal(f.closed(),1);
});
test('a failed read offers a single-flight retry inside its existing dialog',async t=>{
  const retry=held();let reads=0;const f=fixture(t,()=>++reads===1?Promise.reject(Error('<file changed>')):retry.promise);assert.equal(await f.ui.open(ids),false);assert.match(f.markup(),/&lt;file changed&gt;/);
  const button=f.node('artifact-retry'),opening=button.onclick();button.onclick();assert.equal(f.calls.length,2);retry.resolve(preview('notes.md',{content:'# Notes'}));assert.equal(await opening,true);assert.match(f.markup(),/<article/);assert.equal(f.node('artifact-retry'),undefined);
});
test('native opening is single-flight and a late error cannot leak into another preview',async t=>{
  const pending=held(),opened=[];const f=fixture(t,()=>preview(),{openNative:value=>{opened.push(value);return pending.promise;}});await f.ui.open(ids);const button=f.node('artifact-open-native'),opening=button.onclick();await button.onclick();assert.equal(opened.length,1);assert.deepEqual(opened[0],ids);f.replace();pending.reject(Error('late native error'));await opening;assert.ok(f.node('other'));assert.equal(f.node('artifact-open-error'),undefined);
});
test('unsafe SVG remains escaped source and download-only files do not invent an inline preview',async t=>{
  const f=fixture(t,()=>preview('unsafe.svg',{content:'<script>bad()</script>'}));await f.ui.open(ids);assert.doesNotMatch(f.markup(),/<script>|<img/);assert.match(f.markup(),/&lt;script&gt;/);
  const g=fixture(t,()=>preview('result.pdf',{previewKind:'download',message:'Open in its application.'}));await g.ui.open(ids);assert.match(g.markup(),/Open in its application/);assert.doesNotMatch(g.markup(),/<img|<iframe/);assert.match(g.actions(),/Download/);
});
