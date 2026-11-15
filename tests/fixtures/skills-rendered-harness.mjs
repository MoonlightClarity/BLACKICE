// Disposable, read-only UI acceptance host. No BLACKICE runtime or model process.
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {KnowledgeStore} from '../../lib/knowledge.mjs';
import {createSkillsCatalog,skillIdFromRequestPath} from '../../lib/skills-catalog.mjs';

const root=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const directory=await mkdtemp(path.join(tmpdir(),'blackice-skills-browser-'));
const cwd=path.join(directory,'fixture-workspace');await mkdir(cwd);
const store=await new KnowledgeStore({dataDir:path.join(directory,'data')}).init();
await store.upsert({id:'rendered-skill',kind:'skill',title:'Rendered acceptance procedure',summary:'Check actual Chromium painting and selected content',content:'# Rendered acceptance\nUse the actual Skills UI to inspect this persistent fixture content.\n<untrusted markup stays text>',cwd});
const catalog=createSkillsCatalog({knowledge:store,defaultCwd:cwd,nativeSkills:async()=>({available:false,skills:[],reason:'Native runtime intentionally not started in isolated fixture.'})});
const html=`<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BLACKICE Skills — isolated rendering test</title>
<link rel="stylesheet" href="/next/base.css"><link rel="stylesheet" href="/next/controls.css"><link rel="stylesheet" href="/next/brand.css"><link rel="stylesheet" href="/next/skills.css">
<style>body{margin:0;padding:28px;box-sizing:border-box;background:#101923;color:#e4edf5;font-family:system-ui,sans-serif}
#skills-mount{max-width:1450px;margin:0 auto}
#acceptance-nav{display:block;max-width:1450px;margin:10px auto;font-size:12px;color:#b6d2ef}</style></head>
<body><main id="skills-mount"></main><output id="acceptance-nav" aria-live="polite"></output>
<script type="module">
import {createSkillsWorkspace} from '/next/workspaces/skills.mjs';
const read=async(url,method='GET',body,{signal}={})=>{
 const response=await fetch(url,{method,signal,headers:{'Accept':'application/json'}});
 const result=await response.json();
 if(!response.ok)throw Object.assign(new Error(result.error||'Fixture API failed'),{status:response.status});
 return result;
};
const workspace=createSkillsWorkspace({mount:document.querySelector('#skills-mount'),api:read,
 events:{subscribe(){return()=>{}}},
 onNavigate:(space,options)=>{document.querySelector('#acceptance-nav').textContent=space+' navigation: '+JSON.stringify(options);}});
workspace.enter();
window.addEventListener('beforeunload',()=>workspace.destroy());
</script></body></html>`;
const staticFiles=new Map([
  ['/next/base.css','public/next/base.css'],['/next/brand.css','public/next/brand.css'],
  ['/next/controls.css','public/next/controls.css'],['/next/skills.css','public/next/skills.css'],
  ['/next/workspaces/skills.mjs','public/next/workspaces/skills.mjs'],
]);
const send=(res,status,data)=>{
  const body=JSON.stringify(data);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(body);
};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);}
    if(req.method==='GET'&&staticFiles.has(url.pathname)){
      const file=staticFiles.get(url.pathname),body=await readFile(path.join(root,file));
      res.writeHead(200,{'Content-Type':path.extname(file)==='.css'?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store'});
      return res.end(body);
    }
    if(req.method==='GET'&&url.pathname==='/api/skills')return send(res,200,await catalog.list({cwd:url.searchParams.get('cwd')||undefined,query:url.searchParams.get('query')||'',source:url.searchParams.get('source')||'all'}));
    const id=skillIdFromRequestPath(url.pathname);
    if(req.method==='GET'&&id)return send(res,200,await catalog.detail({id,cwd:url.searchParams.get('cwd')||undefined}));
    if(req.method==='GET'&&url.pathname==='/fixture/state')return send(res,200,{pid:process.pid,skill:store.get('rendered-skill').revision});
    if(req.method==='POST'&&url.pathname==='/fixture/revise'){
      const before=store.get('rendered-skill');
      const next=await store.upsert({...before,content:before.content+'\nConcurrent revision '+(before.revision+1),expectedRevision:before.revision});
      return send(res,200,{revision:next.revision});
    }
    return send(res,404,{error:'Fixture route not found.'});
  }catch(error){return send(res,error?.status||500,{error:String(error?.message||error)});}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const port=server.address().port,receipt=process.argv[2];
if(receipt)await writeFile(receipt,JSON.stringify({pid:process.pid,port,url:`http://127.0.0.1:${port}/`,cwd,at:new Date().toISOString()}));
process.stdout.write('SKILLS_RENDERED_FIXTURE '+JSON.stringify({pid:process.pid,port})+'\n');
const close=async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});process.exit(0);};
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
