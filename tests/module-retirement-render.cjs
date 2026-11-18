const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url');
const root=process.argv[2],out=process.argv[3];app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win,f;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=s=>win.webContents.executeJavaScript(s),checks=[];
const until=async s=>{for(let i=0;i<80;i++){if(await run(s))return;await sleep(100)}throw Error(s)};
(async()=>{await app.whenReady();f=(await import(pathToFileURL(path.join(root,'tests/next-fixture-server.mjs')))).makeFixture();await new Promise(r=>f.server.listen(0,'127.0.0.1',r));
win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{offscreen:true,backgroundThrottling:false}});
await win.loadURL('http://127.0.0.1:'+f.server.address().port+'/next/#chat');await until('!!document.querySelector("#next-chat-send")');
await run('localStorage.setItem("blackice.next.chatOptions",JSON.stringify({planningMode:"ontology",directoryMode:"on",planningOntology:{modules:{verification:true}}}));localStorage.setItem("blackice.next.chatOntology.new",JSON.stringify({planningMode:"ontology",planningOntology:{modules:{verification:true}}}))');
await win.reload();await until('!!document.querySelector("#next-chat-send")');await sleep(300);
for(const width of [1200,640]){win.setSize(width,850);await sleep(200);
const ok=await run('(()=>{const removed=["#next-chat-plan","#next-chat-directory-mode","#next-chat-ontology-inline","#next-chat-ontology-default"];const kept=["#next-chat-model","#next-chat-effort","#next-chat-tier","#next-chat-goal-toggle","#next-chat-autonomy-toggle","#next-chat-send"];return removed.every(s=>!document.querySelector(s))&&kept.every(s=>document.querySelector(s));})()');
if(!ok)throw Error('Ghost/missing controls');checks.push('No ghost modules; core controls retained '+width);fs.writeFileSync(path.join(out,'retired-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
await run('document.querySelector("#next-chat-input").value="Synthetic retirement UI test";document.querySelector("#next-chat-input").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-chat-form").requestSubmit()');for(let i=0;i<50&&!f.state.submittedRuns.length;i++)await sleep(100);
if(f.state.submittedRuns.length!==1)throw Error('Expected one submitted run');const sent=f.state.submittedRuns[0];if(JSON.stringify(sent).includes('"planningOntology"'))throw Error('Policy leaked');checks.push('Stale storage cannot restore policy on new send');
fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,checks},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1}).finally(async()=>{win?.destroy();if(f){f.server.closeAllConnections();await new Promise(r=>f.server.close(r));await f.closeKnowledge()}app.exit(process.exitCode||0)});setTimeout(()=>app.exit(2),30000).unref();
