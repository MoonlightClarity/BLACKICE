import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHarnessServer} from '../server.mjs';
import {IdentityStore,DEFAULT_SOUL} from '../lib/identity.mjs';
class Runtime extends EventEmitter {
 status(){return {connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0};}
 async start(){return this.status();}
 async close(){}
 async runAgent(){throw Error('No model admission permitted in startup fixture');}
}
for(const mode of ['fresh','upgrade-removed-agents','existing-user-agents'])test('startup '+mode+' preserves workspace instruction ownership',async t=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-soul-startup-'));
 const dataDir=path.join(root,'data'),defaultCwd=path.join(root,'workspace'),agents=path.join(defaultCwd,'AGENTS.md');
 await fs.mkdir(defaultCwd);const custom='# Local user project instructions\nKeep my own work.\n';
 if(mode==='existing-user-agents')await fs.writeFile(agents,custom);
 if(mode==='upgrade-removed-agents'){
  const old=await fs.readFile(new URL('./fixtures/soul-default-20261115.md',import.meta.url),'utf8');
  const store=await new IdentityStore({dataDir}).init(),doc=await store.read('soul');
  await store.update({kind:'soul',content:old,expectedRevision:doc.revision,expectedHash:doc.diskHash,provenance:{source:'seed'}});
  await store.close();await fs.writeFile(agents,'Historical fixture instructions');await fs.unlink(agents);
 }
 let app; t.after(async()=>{await app?.close();await fs.rm(root,{recursive:true,force:true});});
 for(let i=0;i<2;i++){
  app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir,defaultCwd});
  assert.equal(await fs.readFile(path.join(dataDir,'identity','SOUL.md'),'utf8'),DEFAULT_SOUL);
  if(mode==='existing-user-agents')assert.equal(await fs.readFile(agents,'utf8'),custom);
  else await assert.rejects(fs.stat(agents),{code:'ENOENT'});
  await app.close();app=null;
 }
});
