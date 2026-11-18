/** Real Electron + source BLACKICE server; inert model, disposable profile/data only. */
const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),{EventEmitter}=require('events');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win,server;const checks=[],external=[],errors=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=s=>win.webContents.executeJavaScript(s);
const until=async(s,label=s)=>{for(let i=0;i<120;i++){if(await run(s))return;await sleep(100);}throw Error('Timed out: '+label);};
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="360" height="140" viewBox="0 0 360 140"><title>Inline chart</title><defs><linearGradient id="g"><stop stop-color="#3388ff"/><stop offset="1" stop-color="#55cc99"/></linearGradient></defs><rect width="360" height="140" rx="18" fill="url(#g)"/><text x="24" y="80" font-size="28" fill="white">SVG preview</text></svg>';
const raw='<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><circle cx="60" cy="40" r="30" fill="#ec4899"/></svg>';
const fence=(language,source)=>'\x60\x60\x60'+language+'\n'+source+'\n\x60\x60\x60';
const outputs=[
 'Rendered SVGs below.\n\n'+fence('svg',svg)+'\n\n'+fence('xml',raw)+'\n\n'+raw,
 'Malformed source remains available.\n\n'+fence('svg','<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>')+'\n\n'+fence('svg','<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svgExecuted=true</script></svg>')+'\n\n'+fence('svg','<svg xmlns="http://www.w3.org/2000/svg"><image href="https://invalid.example/image.png"/></svg>'),
 '## Ordinary reply\n\n**Unchanged** Markdown.\n\n'+fence('javascript','const example = "<svg>not an image</svg>";'),
];
let calls=0;
class Runtime extends EventEmitter{
 status(){return {connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0,models:[]};}
 async start(){return this.status()}async close(){}
 async runAgent(options){const output=outputs[calls++];if(output===undefined)throw Error('Unexpected model request');return{output,threadId:'svg-fixture-'+calls};}
}
(async()=>{
 await app.whenReady();const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));
 server=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:path.join(out,'data'),defaultCwd:out,remoteAccess:null});
 const url=await server.listen({waitForRemote:false});
 win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});
 win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=details.url.startsWith(url)||details.url.startsWith('data:')||details.url==='about:blank';if(!allowed)external.push(details.url);callback({cancel:!allowed});});
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)});
 await win.loadURL(url+'/#chat');await until('!!document.querySelector("#next-chat-input")');
 for(let caseIndex=0;caseIndex<outputs.length;caseIndex++){
   if(caseIndex)await run('document.querySelector("#next-chat-new").click()');
   await run('document.querySelector("#next-chat-input").value='+JSON.stringify('SVG regression case '+caseIndex)+';document.querySelector("#next-chat-input").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-chat-form").requestSubmit()');
   await until('!!document.querySelector(".next-chat-response") && document.querySelector(".next-chat-response").textContent.includes('+JSON.stringify(caseIndex===0?'Rendered SVGs':caseIndex===1?'Malformed source':'Ordinary reply')+')');
   await until('document.querySelector("#next-chat-stop").hidden');
   if(caseIndex===0){
     await until('document.querySelectorAll("figure.chat-svg-preview img").length===3');
     for(const width of [1200,640,390]){
       win.setSize(width,850);await sleep(150);
       const metrics=await run('(async()=>{const images=[...document.querySelectorAll("figure.chat-svg-preview img")];await Promise.all(images.map(x=>x.decode()));return images.map(x=>({natural:x.naturalWidth,width:x.getBoundingClientRect().width,right:x.getBoundingClientRect().right,left:x.getBoundingClientRect().left,viewport:innerWidth,source:x.closest("figure").querySelector("details code").textContent,closed:!x.closest("figure").querySelector("details").open}));})()');
       if(metrics.some(x=>!x.natural||x.width<=0||x.right>x.viewport+1||x.left<0||!x.closed))throw Error('Bad image layout '+JSON.stringify(metrics));
       if(metrics[0].source!==svg||metrics[1].source!==raw||metrics[2].source!==raw)throw Error('Changed SVG source');
       fs.writeFileSync(path.join(out,'svg-'+width+'.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(out,'svg-'+width+'.jpg'),(await win.webContents.capturePage()).resize({width:Math.min(width,640)}).toJPEG(35));checks.push('Three decoded images/source exact at '+width);
     }
     await run('document.querySelector("details.chat-svg-source summary").click()');await until('document.querySelector("details.chat-svg-source").open');checks.push('Source disclosure opens');
     await run('document.execCommand=()=>false;Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{globalThis.__copiedSvg=value;}}});document.querySelector("[data-copy-svg]").click()');
     await until('document.querySelector(".chat-svg-copy-status").textContent==="Copied SVG source."');
     if(await run('globalThis.__copiedSvg')!==svg)throw Error('Copy changed source');
     checks.push('Copy button delivers exact source to clipboard adapter');
     await run('navigator.clipboard.writeText=async()=>{throw Error("Synthetic clipboard failure")};document.querySelector("[data-copy-svg]").click()');
     await until('document.querySelector(".chat-svg-copy-status").textContent.length>0 && document.querySelector(".chat-svg-copy-status").textContent!=="Copied SVG source."');
     checks.push('Copy failure visible without source loss');
     for(let n=0;n<3;n++){await win.reload();await until('document.querySelectorAll("figure.chat-svg-preview img").length===3');await run('Promise.all([...document.querySelectorAll("figure.chat-svg-preview img")].map(x=>x.decode()))');checks.push('Reload decode '+n);}
   }else{
     const state=await run('({images:document.querySelectorAll("figure.chat-svg-preview").length,code:[...document.querySelectorAll(".next-chat-response pre code")].map(x=>x.textContent),executed:globalThis.__svgExecuted===true,strong:!!document.querySelector(".next-chat-response strong")})');
     if(state.images||state.executed)throw Error('Unsafe/nonSVG content previewed '+JSON.stringify(state));
     if(caseIndex===1&&state.code.length!==3)throw Error('Fallback lost sources');
     if(caseIndex===2&&(!state.strong||state.code[0]!=='const example = "<svg>not an image</svg>";'))throw Error('Ordinary rendering changed');
     checks.push(caseIndex===1?'Malformed/script/external SVG escaped fallback':'Ordinary Markdown and code unchanged');
   }
 }
 const performanceCheck=await run('(async()=>{const {renderMarkdown}=await import("/editor-model.mjs");const input="<svg>\\n".repeat(5000),start=performance.now();const html=renderMarkdown(input,{svgPreviews:true});return {durationMs:performance.now()-start,preview:html.includes("chat-svg-preview"),retained:html.includes("&lt;svg&gt;")};})()');
 if(performanceCheck.preview||!performanceCheck.retained||performanceCheck.durationMs>250)throw Error('Malformed performance '+JSON.stringify(performanceCheck));
 checks.push('5000 malformed roots bounded '+performanceCheck.durationMs.toFixed(2)+'ms');
 if(external.length)throw Error('Unexpected external requests '+JSON.stringify(external));
 if(errors.length)throw Error('Renderer errors '+JSON.stringify(errors));
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,electron:process.versions.electron,chromium:process.versions.chrome,checks,calls,external,errors},null,2));
})().catch(async e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack+'\n'+JSON.stringify({errors,external}));if(win){fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(out,'failure-dom.txt'),await run('document.documentElement.outerHTML'));}process.exitCode=1}).finally(async()=>{win?.destroy();if(server)await server.close();app.exit(process.exitCode||0)});setTimeout(()=>app.exit(2),90000).unref();
