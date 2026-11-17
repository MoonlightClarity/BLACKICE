
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {pathToFileURL}=require('url');
const root=process.argv[2],out=process.argv[3]; if(!root||!out)throw Error('root and evidence required');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
const dataDir=fs.mkdtempSync(path.join(out,'store-'));
let win,server,store;const results=[],errors=[];app.on('window-all-closed',()=>{});
const html=fs.readFileSync(path.join(root,'public/next/index.html'),'utf8').replace('<script type="module" src="/next/app.mjs"></script>','<script type="module" src="/fixture.mjs"></script>').replace('<script src="/next/guard.js" defer></script>','');
const fixture="\nimport {createSwarmWorkspace} from '/next/workspaces/swarm.mjs';\nconst stage=document.querySelector('#next-stage');stage.innerHTML='<section class=\"next-space\" id=\"swarm\"></section>';\nconst api=async(route,method='GET',body)=>{const r=await fetch(route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}); const value=await r.json();if(!r.ok)throw Error(value.error);return value;};\nconst swarm=createSwarmWorkspace({mount:document.querySelector('#swarm'),api,events:{subscribe(){return()=>{}}}});swarm.enter();\n";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const run=code=>win.webContents.executeJavaScript(code,true);
async function until(code){for(let i=0;i<200;i++){if(await run(code))return;await sleep(25);}throw Error('Timeout '+code);}
async function click(label){await run('(()=>{const b=[...document.querySelectorAll(".swarm-shell button")].find(n=>n.textContent==='+JSON.stringify(label)+');if(!b)throw Error("Missing button "+'+JSON.stringify(label)+');b.click();return true;})()');}
async function capture(name){await sleep(150);const shot=await win.webContents.capturePage();fs.writeFileSync(path.join(out,name+'.png'),shot.toPNG());fs.writeFileSync(path.join(out,name+'.jpg'),shot.toJPEG(40));}
(async()=>{
await app.whenReady();
const {SwarmBoardStore}=await import(pathToFileURL(path.join(root,'lib/swarm-board.mjs')));
store=await new SwarmBoardStore({dataDir}).init();
const human={kind:'human',id:'local-session',label:'Fixture'};
await store.apply({action:'create_project',mutationId:'create_a',value:{id:'a',name:'Lifecycle fixture',objective:'Test synthetic project controls.'}},human);
await store.apply({action:'create_project',mutationId:'create_b',value:{id:'b',name:'Unaffected project',objective:'Must remain active.'}},human);
server=http.createServer(async(req,res)=>{try{
const u=new URL(req.url,'http://localhost');
if(u.pathname.startsWith('/api/swarm')){
let result;if(req.method==='POST'){let body='';for await(const c of req)body+=c;result=await store.apply(JSON.parse(body),human);}else result=store.snapshot();
res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(result));}
if(u.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(html)}
if(u.pathname==='/fixture.mjs'){res.setHeader('Content-Type','text/javascript');return res.end(fixture)}
const file=path.resolve(root,'public','.'+u.pathname);if(!file.startsWith(path.join(root,'public')+path.sep))throw Error('bad path');
res.setHeader('Content-Type',({'.css':'text/css','.mjs':'text/javascript','.js':'text/javascript','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
}catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}))}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
win=new BrowserWindow({show:false,width:1536,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
await win.loadURL('http://127.0.0.1:'+server.address().port);
await until('document.querySelector(".swarm-project-header h2")?.textContent==="Lifecycle fixture"');
await click('Edit project');
assert(await run('document.querySelector(".swarm-project-setup").open'));
await run('(()=>{const f=document.querySelector(".swarm-project-setup form");f.querySelector("input").value="Renamed fixture";f.requestSubmit();return true;})()');
await until('document.querySelector(".swarm-project-header h2")?.textContent==="Renamed fixture"');
await click('Archive project');
await until('document.querySelector(".swarm-project-header h2")?.textContent==="Unaffected project"');
await click('Archive (1)');
await until('document.querySelector(".swarm-project-header h2")?.textContent==="Renamed fixture"');
await capture('archived');
await click('Restore project');
await until('!document.querySelector(".swarm-project-header")');
await click('Active (2)');
await until('document.querySelector(".swarm-project-header h2")?.textContent==="Renamed fixture"');
await click('Edit project');
await run('(()=>{document.querySelector(".swarm-project-setup input").value="Unsaved draft";return true;})()');
await click('Delete project');
await until('document.querySelector(".swarm-project-header h2")?.textContent==="Unaffected project"');
await click('Trash (1)');
await until('document.querySelector(".swarm-project-header h2")?.textContent==="Renamed fixture"');
assert.equal(await run('document.querySelector(".swarm-main form")===null'),true);
assert.equal(store.snapshot('a').lifecycle,'trashed');
assert.equal(store.snapshot('b').lifecycle,'active');
await capture('trashed');
await click('Restore project');await until('!document.querySelector(".swarm-project-header")');await click('Active (2)');
await until('document.querySelector(".swarm-project-header h2")?.textContent==="Renamed fixture"');
await click('Edit project');
assert.equal(await run('document.querySelector(".swarm-project-setup input").value'),'Unsaved draft');
await click('Discard this draft and reload');
for(const width of [1536,1024,640]){
win.setContentSize(width,900);await sleep(120);
const metrics=await run('(()=>{const r=document.querySelector(".swarm-shell");return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,rootWidth:r.clientWidth,rootScroll:r.scrollWidth,overflows:[...r.querySelectorAll("nav,aside,button")].filter(n=>n.checkVisibility()&&n.scrollWidth>n.clientWidth+2).map(n=>({tag:n.tagName,text:n.textContent,w:n.clientWidth,sw:n.scrollWidth}))};})()');
assert(metrics.documentWidth<=width+1);assert(metrics.rootScroll<=metrics.rootWidth+1);assert.deepEqual(metrics.overflows,[]);results.push(metrics);await capture('active-'+width);
}
await store.close();const reopened=await new SwarmBoardStore({dataDir}).init();assert.equal(reopened.snapshot('a').lifecycle,'active');assert.equal(reopened.snapshot('a').name,'Renamed fixture');await reopened.close();
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,results,electron:process.versions.electron},null,2));win.destroy();server.close();app.exit(0);
})().catch(async e=>{try{if(win){await capture('failure');fs.writeFileSync(path.join(out,'failure.html'),await run('document.body.innerHTML'));}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:e.stack,results},null,2));}finally{win?.destroy();server?.close();app.exit(1)}});
