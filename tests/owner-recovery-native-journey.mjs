/** Explicit disposable rendered verification. Never uses the installed profile.
 * Uses the real app, preload, IPC boundary, HTTP endpoint and recovery broker.
 * Dialog responses are synthetic; this is NOT evidence of a human OS approval. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url),filename=fileURLToPath(import.meta.url),root=path.dirname(path.dirname(filename));
const arg=name=>process.argv.find(x=>x.startsWith(name+'='))?.slice(name.length+1);
async function launch(){
  const profile=await mkdtemp(path.join(tmpdir(),'blackice-owner-review-'));
  const output=path.resolve(process.env.BLACKICE_RECOVERY_QA_OUTPUT||path.join(root,'.build','owner-recovery-qa'));
  await mkdir(output,{recursive:true});let child,finished=false,logs='';
  try{
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    child=spawn(process.env.BLACKICE_ELECTRON||require('electron'),[filename,'--review-profile='+profile,'--review-output='+output],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    for(const stream of [child.stdout,child.stderr])stream.on('data',x=>{logs=(logs+x).slice(-20000);});
    const exit=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('Disposable recovery fixture timed out.\n'+logs));},90000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('close',(code,signal)=>{clearTimeout(timer);finished=true;resolve({code,signal});});
    });
    const result=JSON.parse(await readFile(path.join(output,'receipt.json'),'utf8'));
    assert.deepEqual(exit,{code:0,signal:null},logs);assert.equal(result.ok,true,result.error+'\n'+logs);
    assert.equal(result.isolatedProfile,true);assert.equal(result.normalWindowClose,true);
    console.log(JSON.stringify(result,null,2));
  }finally{if(child&&!finished)child.kill();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150});}
}
async function native(){
  const {app,BrowserWindow,ipcMain}=require('electron'),profile=arg('--review-profile'),output=arg('--review-output');
  assert.ok(profile&&output);assert.equal(app.isReady(),false);
  app.setPath('userData',profile);mkdirSync(path.join(profile,'session'),{recursive:true});app.setPath('sessionData',path.join(profile,'session'));
  app.on('window-all-closed',()=>{});
  let window,harness,origin,result={ok:false},dialogResponse=1;
  const dialogs=[],failures=[];
  app.once('will-quit',()=>writeFileSync(path.join(output,'receipt.json'),JSON.stringify({...result,isolatedProfile:app.getPath('userData')===profile,willQuit:true},null,2)));
  const until=async(read,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(await read())return;await new Promise(r=>setTimeout(r,40));}throw Error(label+' timed out');};
  try{
    await app.whenReady();
    const {createHarnessServer}=await import('../server.mjs');
    const {createOwnerRecoveryHandlers}=await import('../desktop/owner-recovery.mjs');
    const {isTrustedDesktopSender}=await import('../desktop/clipboard.mjs');
    class FixtureRuntime extends EventEmitter{
      status(){return {connected:true,authenticated:true,models:[],activeTurns:0,defaultModel:'fixture'};}
      async start(){return this.status();} async close(){}
      async runAgent(){throw Error('No model may run in this UI fixture.');}
    }
    harness=await createHarnessServer({runtime:new FixtureRuntime(),remoteAccess:false,port:0,dataDir:path.join(profile,'data'),defaultCwd:path.join(profile,'workspace'),nativeOwnerRecovery:true});
    origin=await harness.listen({waitForRemote:false});
    window=new BrowserWindow({width:1280,height:900,useContentSize:true,show:false,webPreferences:{preload:path.join(root,'desktop','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    const handlers=createOwnerRecoveryHandlers({trustedSender:event=>isTrustedDesktopSender(event,window,origin),control:harness.ownerRecovery,
      showMessageBox:async options=>{dialogs.push(options);return {response:dialogResponse};}});
    ipcMain.handle('relay:review-retained-effect',handlers.review);ipcMain.handle('relay:cancel-retained-effect',handlers.cancel);
    window.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message);});
    await window.loadURL(new URL('/',origin).href);
    const evaluate=expression=>window.webContents.executeJavaScript(expression);
    const clickControl=async(action,id)=>{
      const selector='[data-request-id="'+id+'"][data-owner-recovery="'+action+'"]:not(:disabled)';
      await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify(selector)+'))'),'Exact '+action+' control');
      await evaluate('(()=>{const n=document.querySelector('+JSON.stringify(selector)+');n.scrollIntoView({block:"center"});n.click();return true})()');
    };
    const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic native decision did not settle')),15000);timer.unref();})]);
    await until(()=>evaluate('Boolean(document.querySelector(".next-tab[data-space=settings]"))'),'App shell');
    await evaluate('document.querySelector(".next-tab[data-space=settings]").click();true');
    await until(()=>evaluate('Boolean(document.querySelector("#next-settings-section-recovery"))'),'Settings tabs');
    const claims=[{taskId:'fixture-old-task',operationId:'fixture-old-operation',digest:'synthetic-immutable-digest',tool:'run_command',action:'run',deliveryState:'UNKNOWN',effectState:'UNKNOWN'}];
    const seed=label=>{
      const promise=harness.ownerRecovery.request({taskId:'fixture-task',runId:'fixture-run',nodeId:'fixture-node',operationId:label,
        candidate:{tool:'browser',action:'click',target:'https://example.test/application',summary:label,
          parameters:{button:'Submit',applicationId:'synthetic-only'},preconditions:{url:'https://example.test/application',buttonLabel:'Submit'},descriptor:{kind:'fixture-only-no-dispatch'}},claims});
      promise.catch(()=>{}); // Cleanup may cancel a still-pending synthetic request after an earlier assertion.
      const request=harness.ownerRecovery.list().at(-1);return {promise,request};
    };
    const first=seed('Synthetic exact-action review');
    await evaluate('document.querySelector("#next-settings-section-recovery").click();true');
    await until(()=>evaluate('Boolean(document.querySelector("[data-owner-recovery=review]:not(:disabled)"))'),'Pending review visible');
    assert.equal(await evaluate('document.querySelector("#next-settings-recovery").hidden'),false);
    assert.match(await evaluate('document.querySelector("#next-settings-recovery").textContent'),/synthetic-immutable-digest/);
    await evaluate('document.querySelector(".owner-recovery details").open=true;true');
    // DOM readiness can precede Chromium's next compositor frame. Await paint,
    // then recheck the exact Settings surface before capturing the app window.
    await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    await new Promise(r=>setTimeout(r,250));
    assert.equal(await evaluate('(()=>{const el=document.querySelector("#next-settings-recovery");const r=el?.getBoundingClientRect();return Boolean(el&&!el.hidden&&r.width>0&&r.height>0&&getComputedStyle(el).visibility!=="hidden")})()'),true);
    await writeFile(path.join(output,'settings-wide.png'),(await window.webContents.capturePage()).toPNG());
    await clickControl('review',first.request.requestId);
    const approval=await bounded(first.promise);assert.equal(dialogs.length,1);
    assert.match(dialogs[0].detail,/synthetic-only/);assert.match(dialogs[0].detail,/fixture-old-operation/);
    assert.equal(dialogs[0].defaultId,0);harness.ownerRecovery.consumed(approval.requestId);
    assert.deepEqual(harness.ownerRecovery.read(approval.requestId).claims,claims);
    await evaluate('document.querySelector("[data-owner-recovery=refresh]").click();true');
    await until(()=>evaluate('document.querySelector("#next-settings-recovery").textContent.includes("Continuation reserved")'),'Consumed state');

    dialogResponse=0;const second=seed('Synthetic cancelled action');
    const cancelled=second.promise.then(()=>({unexpected:true}),error=>({code:error.code}));
    await evaluate('document.querySelector("[data-owner-recovery=refresh]").click();true');
    await clickControl('review',second.request.requestId);
    assert.equal((await bounded(cancelled)).code,'OWNER_RECOVERY_CANCELLED');assert.equal(dialogs.length,2);
    assert.deepEqual(harness.ownerRecovery.read(second.request.requestId).claims,claims);

    const third=seed('Synthetic direct cancel');const directCancelled=third.promise.catch(error=>error.code);
    await evaluate('document.querySelector("[data-owner-recovery=refresh]").click();true');
    await clickControl('cancel',third.request.requestId);
    assert.equal(await bounded(directCancelled),'OWNER_RECOVERY_CANCELLED');assert.equal(dialogs.length,2);
    await evaluate('document.querySelector("#next-settings-section-general").click();document.querySelector("#next-settings-section-recovery").click();true');
    window.setContentSize(780,560);
    await new Promise(r=>setTimeout(r,250));
    const geometry=await evaluate('(()=>{const panel=document.querySelector(".next-panel"),card=document.querySelector(".owner-recovery-request");return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,panelWidth:panel.clientWidth,panelScrollWidth:panel.scrollWidth,cardWidth:card.getBoundingClientRect().width}})()');
    assert.ok(geometry.documentWidth<=geometry.viewport+1,JSON.stringify(geometry));assert.ok(geometry.panelScrollWidth<=geometry.panelWidth+1,JSON.stringify(geometry));
    await writeFile(path.join(output,'settings-narrow.png'),(await window.webContents.capturePage()).toPNG());
    const sources={};for(const file of ['server.mjs','lib/owner-recovery.mjs','desktop/main.mjs','desktop/preload.cjs','desktop/owner-recovery.mjs','public/owner-recovery-ui.mjs','public/owner-recovery.css','public/next/workspaces/settings.mjs'])
      sources[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
    result={ok:true,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sources,dialogMode:'synthetic responses through real native IPC; no OS human approval asserted',
      checks:{wholeApp:true,realBroker:true,realLocalEndpoint:true,exactReview:true,nativeCancel:true,directCancel:true,retainedClaims:true,navigation:true,narrowGeometry:true,screenshot:true,noModelRun:true,noExternalAction:true},
      screenshots:[path.join(output,'settings-wide.png'),path.join(output,'settings-narrow.png')],geometry,consoleErrors:failures};
    assert.deepEqual(failures,[]);
  }catch(error){result={...result,ok:false,error:error.stack||String(error)};}
  finally{
    try{if(window&&!window.isDestroyed()){const closed=new Promise(r=>window.once('closed',r));window.close();await closed;result.normalWindowClose=true;}await harness?.close();}
    catch(error){result.ok=false;result.error=[result.error,error.stack].filter(Boolean).join('\n');}
    app.quit();
  }
}
if(process.versions.electron)void native().catch(error=>{console.error(error);require('electron').app.exit(1);});
else await launch();
