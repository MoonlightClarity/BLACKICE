/**
 * Disposable end-to-end renderer fixture. Serves the ACTUAL /next/ application
 * modules and the real conversation-folders persistence service, but only
 * synthetic conversations. No provider, job, external browser or user profile.
 *
 * Usage: node tests/conversation-folders-render-fixture.mjs <port-record.json>
 * SIGTERM closes this listener and discards all synthetic profile data.
 */
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {makeFixture} from './next-fixture-server.mjs';
import {ConversationFolders} from '../lib/conversation-folders.mjs';

const file=process.argv[2];
if(!file)throw Error('Port-record path required.');
const fixture=makeFixture();
const profile=await mkdtemp(path.join(tmpdir(),'blackice-conversation-folders-render-'));
const store=await new ConversationFolders({dataDir:profile}).init();
const when='2026-11-15T12:00:00.000Z';
const make=(id,title,state='active',runStatus='completed')=>({
  id:'turn-'+id,rootId:id,taskId:id,runId:'turn-'+id,latestRunId:'turn-'+id,
  title,state,status:runStatus,settled:runStatus==='completed',
  updatedAt:when,createdAt:when
});
const records=[
  make('sample-run-0','BLACKICE profile diagnostics','active','running'),
  make('sample-1','BLACKICE batch reporting'),
  make('sample-2','BLACKICE renderer validation'),
  make('sample-3','BLACKICE conversation controls'),
  make('sample-mixed','BLACKICE and Phoenix integration'),
  make('sample-phoenix','Phoenix model notes'),
  make('sample-skills','Skills catalog review'),
  make('sample-archive','Phoenix archive','archived'),
  make('sample-trash','BLACKICE deleted example','deleted'),
  make('sample-running','BLACKICE active job','active','running')
];
const table=new Map(records.map(item=>[item.rootId,item]));
const base=fixture.server.listeners('request')[0];
fixture.server.removeAllListeners('request');
const json=(res,value,status=200)=>{
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
};
const payload=async req=>{
  let text='';
  for await(const chunk of req){
    text+=chunk;if(text.length>65536)throw Object.assign(Error('Fixture payload too long'),{status:413});
  }
  return JSON.parse(text||'{}');
};
const activeItems=state=>records.filter(item=>item.state===state);
const projection=state=>{
  const items=activeItems(state);
  return {conversations:store.decorate(items),folderOrganization:{...store.snapshot(),counts:store.counts(items)}};
};
const audits={read:0,edit:0,auto:0,run:0,provider:0,archival:0};
fixture.server.on('request',async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost'),pathname=url.pathname;
    if(pathname==='/api/conversations'&&req.method==='GET'){
      audits.read++;return json(res,projection(url.searchParams.get('state')||'active'));
    }
    if(pathname==='/api/conversation-folders'&&req.method==='GET'){
      const state=url.searchParams.get('state')||'active';
      return json(res,{folderOrganization:projection(state).folderOrganization});
    }
    if(pathname==='/api/conversation-folders/edit'&&req.method==='POST'){
      audits.edit++;const input=await payload(req);
      const result=await store.edit(input,{exists:id=>table.has(id)});
      return json(res,{folderOrganization:result});
    }
    if(pathname==='/api/conversation-folders/auto-step'&&req.method==='POST'){
      audits.auto++;const input=await payload(req);
      const result=await store.autoStep({...input,resolve:id=>{
        const row=table.get(id);
        return row?{rootId:row.rootId,title:row.title,state:row.state,
          busy:!row.settled}:null;
      }});
      return json(res,{folderOrganization:result});
    }
    if(pathname==='/fixture/folders'&&req.method==='GET')
      return json(res,{...projection('active'),audit:audits,
        legacyStates:Object.fromEntries(records.map(item=>[item.rootId,item.state]))});
    if(pathname==='/fixture/changing-title'&&req.method==='POST'){
      const input=await payload(req),item=table.get(input.rootId);
      if(!item)return json(res,{error:'Fixture chat not found.'},404);
      item.title=String(input.title||item.title).slice(0,120);
      return json(res,{item});
    }
    if(pathname.match(/^\/api\/conversations\/[^/]+\/(archive|delete|restore|rename)$/)&&req.method==='POST') {
      audits.archival++;return json(res,{error:'Lifecycle writes deliberately disabled in disposable fixture.'},403);
    }
    if(pathname==='/api/runs'&&req.method==='POST') {
      audits.run++;return json(res,{error:'No synthetic model runs.'},403);
    }
    return base(req,res);
  }catch(error){return json(res,{error:error.message||'Fixture error',code:error.code||null,currentRevision:error.currentRevision??null},error.status||500);}
});
await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));
const port=fixture.server.address().port;
await writeFile(file,JSON.stringify({port,pid:process.pid,profile,base:'http://127.0.0.1:'+port}));
console.log(JSON.stringify({event:'fixture_ready',port,pid:process.pid,profile}));
let closing=false;
async function close(){
  if(closing)return;closing=true;
  fixture.server.closeAllConnections();
  await new Promise(resolve=>fixture.server.close(resolve));
  await fixture.close();
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  console.log(JSON.stringify({event:'fixture_closed',audit:audits}));
}
process.once('SIGTERM',()=>{void close().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});});
process.once('SIGINT',()=>{void close().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});});
