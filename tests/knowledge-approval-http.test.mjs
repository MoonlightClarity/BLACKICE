import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
class Runtime extends EventEmitter {
 status(){return {connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0};}
 async start(){return this.status();} async close(){} async runAgent(){assert.fail('No model in approval test');}
}
test('owner HTTP approval applies only explicit exact decisions; reject and remote attempts do not mutate',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-approval-http-')),cwd=path.join(root,'workspace');await mkdir(cwd);
 const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:path.join(root,'data'),defaultCwd:cwd});
 const url=await app.listen();t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
 const request=async(route,body,remote=false)=>{const res=await fetch(url+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{}),...(remote?{'x-blackice-remote':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
 const stage=async(title)=>{await assert.rejects(app.knowledge.upsert({kind:'memory',title,content:'Synthetic fact',cwd},{source:'agent',runId:'fixture'}),{code:'KNOWLEDGE_APPROVAL_REQUIRED'});return app.knowledge.listApprovals().find(p=>p.title===title).id;};
 let id=await stage('Reject me');assert.equal(app.knowledge.list().length,0);
 assert.equal((await request('/api/knowledge/approvals')).data.approvals[0].id,id);
 assert.equal((await request('/api/knowledge/approvals/'+id,{decision:'approve',content:'Injected'})).status,400);
 assert.equal((await request('/api/knowledge/approvals/'+id,{decision:'approve'},true)).status,403);
 assert.equal((await request('/api/knowledge',{kind:'memory',title:'Bypass',content:'x'},true)).status,403);
 assert.equal(app.knowledge.list().length,0);
 assert.equal((await request('/api/knowledge/approvals/'+id,{decision:'reject'})).data.status,'rejected');
 assert.equal(app.knowledge.list().length,0);
 id=await stage('Approve me');
 const result=await request('/api/knowledge/approvals/'+id,{decision:'approve'});
 assert.equal(result.status,200);assert.equal(result.data.status,'approved');assert.equal(app.knowledge.list().length,1);
 assert.equal(app.knowledge.list()[0].provenance.source,'agent');
 assert.equal((await request('/api/knowledge/approvals')).data.approvals.length,0);
 const asset=await fetch(url+'/next/core/knowledge-approvals.mjs',{headers:{Cookie:cookie}});
 assert.equal(asset.status,200);assert.match(await asset.text(),/createKnowledgeApprovals/);
 const human=await request('/api/knowledge',{kind:'skill',title:'Human authored',content:'Reusable procedure'});
 assert.equal(human.status,200);assert.equal(app.knowledge.list().length,2);
});
