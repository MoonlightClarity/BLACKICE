const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path'),{pathToFileURL}=require('url');
const root=process.argv[2],out=process.argv[3];app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win,f;const sleep=ms=>new Promise(r=>setTimeout(r,ms));const run=s=>win.webContents.executeJavaScript(s);
const until=async(s)=>{for(let i=0;i<80;i++){if(await run(s))return;await sleep(100)}throw Error(s)};
(async()=>{await app.whenReady();f=(await import(pathToFileURL(path.join(root,'tests/next-fixture-server.mjs')))).makeFixture();
const base=f.server.listeners('request')[0];f.server.removeAllListeners('request');
let proposals=[{id:'fixture-memory',status:'pending',kind:'memory',operation:'upsert',title:'Synthetic task preference',cwd:'C:/Synthetic/Task-A',provenance:{source:'agent',runId:'fixture-task'},before:null,after:{content:'Use short paragraphs for this task only.',cwd:'C:/Synthetic/Task-A',kind:'memory'}}],decisions=[];
f.server.on('request',(req,res)=>{const p=new URL(req.url,'http://fixture').pathname;if(p==='/api/knowledge/approvals'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({approvals:proposals}))}if(p==='/api/knowledge/approvals/fixture-memory'&&req.method==='POST'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{decisions.push(JSON.parse(body));proposals=[];res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture-memory',status:'rejected'}))});return;}return base(req,res)});
await new Promise(r=>f.server.listen(0,'127.0.0.1',r));
win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{offscreen:true,backgroundThrottling:false}});
await win.loadURL('http://127.0.0.1:'+f.server.address().port+'/next/#chat');await until('!!document.querySelector(".next-approval-dialog[open]")');
for(const width of [1100,640]){win.setSize(width,800);await sleep(200);const bounds=await run('(()=>{const r=document.querySelector(".next-approval-dialog").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight}})()');if(bounds.left<0||bounds.right>bounds.w||bounds.top<0||bounds.bottom>bounds.h)throw Error('Dialog outside viewport '+JSON.stringify(bounds));fs.writeFileSync(path.join(out,'approval-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
await run('[...document.querySelectorAll(".next-approval-dialog button")].find(b=>b.textContent==="Not now").click()');
if(decisions.length)throw Error('Dismiss mutated');await run('document.querySelector(".next-approval-trigger").click()');
await run('[...document.querySelectorAll(".next-approval-dialog button")].find(b=>b.textContent==="Reject change").click()');await until('document.querySelector(".next-approval-status").textContent.includes("rejected")');
if(decisions.length!==1||decisions[0].decision!=='reject')throw Error('Wrong decision');
fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,decisions,checks:['initial prompt','desktop/mobile viewport','dismiss no mutation','reopen persistent badge','explicit reject']},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1}).finally(async()=>{win?.destroy();if(f){f.server.closeAllConnections();await new Promise(r=>f.server.close(r));await f.closeKnowledge()}app.exit(process.exitCode||0)});setTimeout(()=>app.exit(2),30000).unref();
