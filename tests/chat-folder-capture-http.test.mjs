import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){}async close(){}async runAgent(){throw Error('No model');}}
test('folder assignment waits for accepted conversation capture before validating root',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-folder-capture-'));
 const app=await createHarnessServer({runtime:new Runtime(),dataDir:dir,defaultCwd:dir,port:0,remoteAccess:false});
 let release;const gate=new Promise(resolve=>release=resolve);t.after(async()=>{release();await app.close();await rm(dir,{recursive:true,force:true});});
 const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
 const request=async(route,body)=>{const response=await fetch(url+route,{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 const organization=(await request('/api/conversation-folders?state=active')).body.folderOrganization;
 app.conversations.chain=app.conversations.chain.then(()=>gate);
 const capture=app.conversations.capture({id:'new-root',taskId:'new-root',status:'completed',settled:true,input:'New request',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),workflow:{nodes:[]},nodes:{}});
 let done=false;const pending=request('/api/conversation-folders/edit',{expectedRevision:organization.revision,operations:[{type:'assign',rootId:'new-root',folderId:null}]}).then(result=>{done=true;return result;});
 await new Promise(resolve=>setTimeout(resolve,50));assert.equal(done,false);release();await capture;
 const result=await pending;assert.equal(result.status,200);const saved=(await request('/api/conversations?state=active')).body.conversations;
 assert.equal(saved.find(item=>item.rootId==='new-root').folderSource,'manual');
});

test('removed automatic folder API cannot create folders or alter saved organization',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-manual-folders-')),app=await createHarnessServer({runtime:new Runtime(),dataDir:dir,defaultCwd:dir,port:0,remoteAccess:false});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();const response=await fetch(url+'/api/conversation-folders/auto-step',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({rootIds:['a','b','c']})});assert.equal(response.status,404);const snapshot=await(await fetch(url+'/api/conversation-folders?state=active',{headers:{Cookie:cookie}})).json();assert.deepEqual(snapshot.folderOrganization.folders,[]);assert.equal(snapshot.folderOrganization.revision,0);assert.equal(snapshot.folderOrganization.autoEnabled,undefined);
});

test('recursive folder HTTP archive/trash/restore preserves chats and empty folders',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-folder-http-life-'));
 const app=await createHarnessServer({runtime:new Runtime(),dataDir:dir,defaultCwd:dir,port:0,remoteAccess:false});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
 const request=async(route,body)=>{const response=await fetch(url+route,{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 let org=(await request('/api/conversation-folders')).body.folderOrganization;
 org=(await request('/api/conversation-folders/edit',{expectedRevision:org.revision,operations:[{type:'create_folder',name:'Parent'}]})).body.folderOrganization;
 const id=org.folders[0].id;
 let result=await request('/api/conversation-folders/'+id+'/delete',{expectedRevision:org.revision,expectedMetadataRevision:org.lifecycleRevision});assert.equal(result.status,200);assert.deepEqual(result.body.rootIds,[]);assert.equal(result.body.folderOrganization.folders[0].state,'deleted');
 result=await request('/api/conversation-folders/'+id+'/restore',{expectedRevision:org.revision,expectedMetadataRevision:result.body.lifecycleRevision});assert.equal(result.status,200);
 org=result.body.folderOrganization;
 await app.conversations.capture({id:'saved-root',taskId:'saved-root',status:'completed',settled:true,input:'Saved content',createdAt:new Date().toISOString(),workflow:{nodes:[]},nodes:{},events:[]});
 org=(await request('/api/conversation-folders/edit',{expectedRevision:org.revision,operations:[{type:'assign',rootId:'saved-root',folderId:id}]})).body.folderOrganization;
 result=await request('/api/conversation-folders/'+id+'/archive',{expectedRevision:org.revision,expectedMetadataRevision:org.lifecycleRevision});assert.equal(result.status,200);assert.deepEqual(result.body.rootIds,['saved-root']);
 assert.equal((await request('/api/conversations?state=active')).body.conversations.length,0);assert.equal((await request('/api/conversations?state=archived')).body.conversations[0].folderId,id);
 const stale=await request('/api/conversation-folders/'+id+'/delete',{expectedRevision:org.revision,expectedMetadataRevision:org.lifecycleRevision});assert.equal(stale.status,409);
 assert.equal((await request('/api/conversations/saved-root')).body.runs[0].input,'Saved content');
});
