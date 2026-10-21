import test from 'node:test';
import assert from 'node:assert/strict';
import {browserTreeModel,browserCapacityLabel,browserParentChoices} from '../public/browser-tree-model.mjs';
import {browserTabTreeMarkup,openBrowserWorkspace} from '../public/browser-ui.mjs';
import {renderObserveBrowserTree} from '../public/observe-ui.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const page=(tabId,folderId,parentTabId=null,extra={})=>({tabId,folderId,parentTabId,title:'Page '+tabId,url:'https://'+tabId+'.example.test/',browser:'relay',visible:false,canShow:false,...extra});
const inventory=()=>({available:true,browsers:{relay:{available:true}},activeTab:'one',folders:[{id:'personal',name:'Personal',kind:'user'},{id:'research',name:'Release research',kind:'task',taskId:'task-a'},{id:'other',name:'Other work',kind:'user'}],tabs:[page('one','personal'),page('two','research'),page('three','research','two',{suspended:true}),page('four','other')],capacity:{live:3,maxLive:32,saved:4,maxSaved:256,perTaskLive:8}});
const flatten=nodes=>nodes.flatMap(node=>[node.tabId,...flatten(node.children)]);

test('folder tree preserves parent relationships, task identity, live counts and suspended history',()=>{
 const source=inventory(),before=structuredClone(source),tree=browserTreeModel(source);
 assert.deepEqual(source,before);
 assert.deepEqual(tree.folders.map(folder=>[folder.id,folder.count,folder.live,folder.saved]),[['personal',1,1,0],['research',2,1,1],['other',1,1,0]]);
 assert.deepEqual(tree.folders[1].roots.map(tab=>tab.tabId),['two']);assert.deepEqual(tree.folders[1].roots[0].children.map(tab=>tab.tabId),['three']);
 assert.equal(tree.folders[1].taskId,'task-a');assert.equal(tree.live,3);assert.equal(tree.saved,1);
 assert.equal(browserCapacityLabel(source),'3 of 32 live · 4 retained');
});

test('malformed parent metadata cannot hide pages, cross folders, or make tree traversal loop',()=>{
 const status={folders:[{id:'a',name:'A'},{id:'b',name:'B'}],tabs:[page('one','a','two'),page('two','a','one'),page('self','a','self'),page('missing','a','absent'),page('cross','b','one'),page('orphan','gone'),page('duplicate','a'),page('duplicate','b')]};
 const tree=browserTreeModel(status),ids=tree.folders.flatMap(folder=>flatten(folder.roots));
 assert.deepEqual([...ids].sort(),['cross','missing','one','orphan','self','two']);assert.equal(new Set(ids).size,ids.length);
 assert.equal(tree.folders.find(folder=>folder.id==='b').roots[0].parentTabId,null);
 assert.equal(tree.folders.find(folder=>folder.id===null).roots[0].tabId,'orphan');
});

test('parent choices reject self, descendants and pages in another folder',()=>{
 const state=inventory();state.tabs.push(page('fourth','research','three'),page('sibling','research'));
 assert.deepEqual(browserParentChoices(state,'two','research').map(tab=>tab.tabId),['sibling']);
 assert.deepEqual(browserParentChoices(state,'three','research').map(tab=>tab.tabId),['two','sibling']);
 state.tabs.find(tab=>tab.tabId==='three').owner={taskId:'task-a',nodeId:'review'};
 state.tabs.find(tab=>tab.tabId==='two').owner={taskId:'task-a',nodeId:'capture'};
 state.tabs.find(tab=>tab.tabId==='sibling').owner={taskId:'task-a',nodeId:'review'};
 assert.deepEqual(browserParentChoices(state,'three','research').map(tab=>tab.tabId),['sibling'],'parenting cannot cross worker ownership');
});

test('folder markup escapes authored labels, discloses saved pages, and preserves collapsed state',()=>{
 const status=inventory();status.folders[1].name='<img onerror="bad">';status.tabs[2].title='<script>saved</script>';
 const html=browserTabTreeMarkup(status,{selected:'three',folderState:new Map([['personal',false],['research',true]])});
 assert.match(html,/&lt;img onerror=&quot;bad&quot;&gt;/);assert.match(html,/&lt;script&gt;saved&lt;\/script&gt;/);assert.doesNotMatch(html,/<img|<script/);
 assert.match(html,/data-browser-folder="personal"><summary>/);assert.match(html,/data-browser-folder="research" open/);
 assert.match(html,/data-browser-tab="three" aria-current="page"/);assert.match(html,/browser-tab-state">Saved/);
 assert.match(html,/Create folder/);assert.match(html,/Close folder/);assert.match(html,/3 of 32 live · 4 retained/);
 const placement=html.slice(html.indexOf('id="browser-tab-placement-form"'));
 assert.match(placement,/value="research"/);assert.doesNotMatch(placement,/value="personal"|value="other"/,'task-owned pages cannot be moved into a different ownership folder');
});

test('Activity renders only contained pages in folder hierarchy without granting new page actions',()=>{
 const status=inventory();status.tabs.push(page('outside','research',null,{browser:'neo'}),page('window','research',null,{visible:true}));
 const html=renderObserveBrowserTree({status,selectedId:'three',folderState:new Map([['personal',false]])});
 assert.match(html,/Folders &amp; pages/);assert.match(html,/Release research/);assert.match(html,/data-observe-browser="tree-tab" data-tab-id="three" aria-current="page"/);
 assert.match(html,/<small>Saved<\/small>/);assert.doesNotMatch(html,/data-tab-id="outside"|data-tab-id="window"|data-observe-browser="show"/);
 assert.match(html,/data-observe-folder="personal"><summary/);
});

async function workspace(t,{suspendReason,persistence}={}){
 const f=planningDOM(t),calls=[],status=inventory();f.mount.id='browser-workspace-view';
 if(persistence)status.persistence=persistence;
 f.document.querySelectorAll=selector=>[...f.document.head.querySelectorAll(selector),...f.document.body.querySelectorAll(selector)];
 await openBrowserWorkspace({showModal(){},closeModal(){},toast(){},api:async(route,method,body)=>{
  calls.push({route,method,body});if(route==='/api/browser/status')return structuredClone(status);
  assert.equal(route,'/api/browser/action');assert.equal(method,'POST');
  if(body.action==='folder_create'){const folder={id:'created',name:body.name,kind:'user'};status.folders.push(folder);return{folder};}
  if(body.action==='folder_rename'){status.folders.find(folder=>folder.id===body.folderId).name=body.name;return{renamed:true};}
  if(body.action==='folder_close'){status.tabs=status.tabs.filter(tab=>tab.folderId!==body.folderId);status.folders=status.folders.filter(folder=>folder.id!==body.folderId);return{closed:true};}
  if(body.action==='tab_move'){Object.assign(status.tabs.find(tab=>tab.tabId===body.tabId),{folderId:body.folderId,parentTabId:body.parentTabId});return{moved:true};}
  if(body.action==='suspend'){assert.equal(body.browser,'relay');const tab=status.tabs.find(tab=>tab.tabId===body.tabId);assert.ok(tab);if(!suspendReason){tab.suspended=true;status.capacity.live--;}return{...structuredClone(status),receipt:{tabId:body.tabId,suspended:!suspendReason,...(suspendReason?{reason:suspendReason}:{})}};}
  if(body.action==='screenshot')return{imageUrl:'data:image/png;base64,x'};
  assert.fail('Unexpected action '+body.action);
 }});
 return{...f,calls,status,async submit(selector){return f.$(selector).dispatch('submit',{},true);}};
}

test('folder create, rename and close act once on their observed folder and preserve unrelated pages',async t=>{
 const f=await workspace(t);assert.deepEqual(f.calls.map(call=>call.route),['/api/browser/status']);
 await f.input('#browser-folder-name','New <research>');await f.submit('#browser-folder-create-form');
 assert.deepEqual(f.calls.find(call=>call.body?.action==='folder_create').body,{action:'folder_create',name:'New <research>'});
 assert.equal(f.$('#browser-folder-name').value,'');assert.equal(f.$('[data-browser-folder="created"]').open,true);
 await f.click('[data-browser-folder-rename="created"]');await new Promise(resolve=>setImmediate(resolve));
 await f.input('#browser-folder-rename-name','Verified sources');await f.submit('#browser-folder-rename-form');
 assert.equal(f.status.folders.find(folder=>folder.id==='created').name,'Verified sources');
 const before=f.status.tabs.map(tab=>tab.tabId);await f.click('[data-browser-folder-close="created"]');
 assert.deepEqual(f.status.tabs.map(tab=>tab.tabId),before);assert.equal(f.status.folders.some(folder=>folder.id==='created'),false);
 assert.equal(f.calls.filter(call=>call.body?.action==='folder_close').length,1);
});

test('moving the selected page uses its exact folder and parent while retaining drafts and folder disclosure',async t=>{
 const f=await workspace(t);f.$('[data-browser-folder="research"]').open=false;
 await f.input('#browser-url','https://draft.example.test/');await f.input('#browser-folder-name','Unsubmitted folder');
 const folder=f.$('#browser-tab-folder');folder.value='other';await folder.dispatch('change');
 const parent=f.$('#browser-tab-parent');parent.value='four';await f.submit('#browser-tab-placement-form');
 assert.deepEqual(f.calls.find(call=>call.body?.action==='tab_move').body,{action:'tab_move',tabId:'one',folderId:'other',parentTabId:'four'});
 assert.equal(f.$('#browser-url').value,'https://draft.example.test/');assert.equal(f.$('#browser-folder-name').value,'Unsubmitted folder');assert.equal(f.$('[data-browser-folder="research"]').open,false);
 assert.equal(f.$('[data-browser-tab="one"]').getAttribute('aria-current'),'page');
});

test('Suspend releases the exact live page without deleting it or loading another page',async t=>{
 const f=await workspace(t);await f.input('#browser-url','https://unsent.test/');
 const button=f.$('[data-browser-suspend="two"]');button.focus();await f.click(button);
 assert.deepEqual(f.calls.filter(call=>call.body?.action==='suspend').map(call=>call.body),[{action:'suspend',browser:'relay',tabId:'two'}]);
 assert.deepEqual(f.status.tabs.map(tab=>tab.tabId),['one','two','three','four']);assert.equal(f.status.tabs.find(tab=>tab.tabId==='two').suspended,true);
 assert.equal(f.$('[data-browser-suspend="two"]'),null);assert.equal(document.activeElement.dataset.browserTab,'two');
 assert.equal(f.$('[data-browser-tab="one"]').getAttribute('aria-current'),'page');assert.equal(f.$('#browser-url').value,'https://unsent.test/');
 assert.match(f.$('#browser-tab-notice').textContent,/Page suspended/);assert.equal(f.calls.some(call=>call.body?.action==='screenshot'||call.body?.action==='close'),false);
});

test('a blocked suspension keeps the page live and reports the actual reason',async t=>{
 const f=await workspace(t,{suspendReason:'A download is still running.'});await f.click('[data-browser-suspend="one"]');
 assert.notEqual(f.status.tabs[0].suspended,true);assert.ok(f.$('[data-browser-suspend="one"]'));
 assert.match(f.$('#browser-tab-notice').textContent,/Page stayed live\. A download is still running\./);assert.doesNotMatch(f.$('#browser-tab-notice').textContent,/Page suspended/);
 assert.equal(f.calls.filter(call=>call.body?.action==='suspend').length,1);
});

test('both folder views expose failed saved state and omit suspend for saved or external pages',()=>{
 const status=inventory();status.persistence={healthy:false,error:'Save failed <script>alert(1)</script>'};status.tabs.push(page('external','personal',null,{browser:'firefox'}));
 const workspace=browserTabTreeMarkup(status),activity=renderObserveBrowserTree({status,selectedId:'one',treeOpen:false});
 for(const html of [workspace,activity]){assert.match(html,/role="alert"/);assert.match(html,/Save failed &lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.match(html,/Changes may not survive a restart/);assert.doesNotMatch(html,/<script>/);}
 assert.match(workspace,/data-browser-suspend="one"/);assert.doesNotMatch(workspace,/data-browser-suspend="three"|data-browser-suspend="external"/);
 assert.match(activity,/data-observe-browser="tree-suspend" data-tab-id="one"/);assert.doesNotMatch(activity,/data-observe-browser="tree-suspend" data-tab-id="three"/);
 status.persistence={healthy:true};assert.doesNotMatch(browserTabTreeMarkup(status),/browser-tree-save-error/);assert.doesNotMatch(renderObserveBrowserTree({status}),/observe-browser-save-error/);
});
