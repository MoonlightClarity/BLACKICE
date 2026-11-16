import {app,BaseWindow,WebContentsView,safeStorage} from 'electron';
import assert from 'node:assert/strict';
import https from 'node:https';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {promises as fs} from 'node:fs';
import {createHash,X509Certificate} from 'node:crypto';
import {ElectronBrowserDriver} from '../desktop/browser-driver.mjs';
import {BrowserWorkspace} from '../lib/browser.mjs';
import {BrowserCredentialVault} from '../lib/browser-credentials.mjs';
import {createLiveBrowserWindow} from '../desktop/browser-surface.mjs';
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const output=option('output'),reuse=option('reuse'),tls=option('tls');
if(!output||!path.isAbsolute(output)||!tls)throw Error('--output and --tls fixture directory required');
if(reuse&&(!path.resolve(reuse).startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(reuse).startsWith('blackice-native-passwords-')))throw Error('Only disposable native fixture profiles can be reused.');
const root=reuse||mkdtempSync(path.join(tmpdir(),'blackice-native-passwords-'));
mkdirSync(path.join(root,'profile'),{recursive:true});
app.setPath('userData',path.join(root,'profile'));app.setPath('sessionData',path.join(root,'profile'));
app.setName('BLACKICE native password fixture');app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const cert=readFileSync(path.join(tls,'cert.pem'),'utf8'),key=readFileSync(path.join(tls,'key.pem'),'utf8'),certificate=new X509Certificate(cert);
const report={root,platform:process.platform,electron:process.versions.electron,realAccounts:false,realUserVault:false,phase:reuse?'restart-new-task':'fresh-signup',tlsException:'Only exact fixture certificate and loopback hostname in disposable app session; no OS trust changes',checks:[]};
let driver,browser,vault,server,backend;
const stateFile=path.join(root,'fixture-server.json'),hash=v=>createHash('sha256').update(v).digest('hex');
const stage=n=>{report.stage=n;writeFileSync(output,JSON.stringify(report,null,2));console.log(n);};
const timer=setTimeout(()=>finish(Error('Native password fixture timed out')),120000);
async function finish(error){clearTimeout(timer);report.passed=!error;if(error)report.error=error.stack||String(error);try{if(driver)driver.session.setCertificateVerifyProc(null);await vault?.close();server?.closeAllConnections();server?.close();}catch{}writeFileSync(output,JSON.stringify(report,null,2));app.exit(error?1:0);}
async function until(test,label){for(let i=0;i<80;i++){if(await test())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+label);}
async function act(tabId,name,action,text){const snap=await browser.perform({action:'snapshot',tabId},{source:'agent',owner});const element=snap.frames.flatMap(f=>f.elements||[]).find(e=>e.name===name);assert.ok(element,'Missing '+name);return browser.perform({action,tabId,ref:element.ref,expectedUrl:snap.url,expectedDocumentId:snap.documentId,...(text===undefined?{}:{text})},{source:'agent',owner});}
const owner={taskId:reuse?'new-task-after-restart':'signup-task',nodeId:'worker',runId:'native-run'};
async function main(){try{
 stage('ready');await app.whenReady();assert.equal(process.platform,'win32');assert.equal(safeStorage.isEncryptionAvailable(),true);
 vault=await new BrowserCredentialVault({dataDir:root,storageBackend:'dpapi',isEncryptionAvailable:()=>safeStorage.isEncryptionAvailable(),encryptSecret:v=>safeStorage.encryptString(v).toString('base64'),decryptSecret:v=>safeStorage.decryptString(Buffer.from(v,'base64'))}).init();
 report.nativeDPAPI=true;
 backend=reuse?JSON.parse(readFileSync(stateFile,'utf8')):{accounts:{},signupCount:0,loginCount:0,port:0};
 const signup='<form action="/signup" method="post"><label>Username<input name="username" type="email" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="new-password"></label><label>Confirm password<input name="confirm" type="password" autocomplete="new-password"></label><label><input type="checkbox" name="terms" required>Accept synthetic terms</label><button>Create account</button></form>';
 const login='<form action="/login" method="post"><label>Username<input name="username" type="email" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>';
 server=https.createServer({key,cert},async(req,res)=>{res.setHeader('Content-Type','text/html');if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const data=new URLSearchParams(body),username=data.get('username'),password=data.get('password')||'';if(req.url==='/signup'&&data.get('terms')==='on'&&password.length>=16&&password===data.get('confirm')){backend.accounts[username]=hash(password);backend.signupCount++;writeFileSync(stateFile,JSON.stringify(backend));res.end('<h1>Account created</h1>');}else if(req.url==='/login'&&backend.accounts[username]===hash(password)){backend.loginCount++;writeFileSync(stateFile,JSON.stringify(backend));res.end('<h1>Login verified</h1>');}else{res.statusCode=400;res.end('<h1>Rejected</h1>');}}else res.end('<!doctype html><meta charset="utf-8"><h1>Synthetic '+(reuse?'login':'signup')+'</h1>'+(reuse?login:signup));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(backend.port,'127.0.0.1',resolve);});backend.port=server.address().port;const origin='https://127.0.0.1:'+backend.port;
 driver=await new ElectronBrowserDriver({dataDir:root,downloadDir:path.join(root,'downloads'),liveSurface:true,createSurfaceWindow:options=>createLiveBrowserWindow({BaseWindow,WebContentsView,options})}).init();
 driver.session.setCertificateVerifyProc((request,callback)=>{let same=false;try{same=new X509Certificate(request.certificate.data).fingerprint256===certificate.fingerprint256;}catch{}callback(request.hostname==='127.0.0.1'&&same?0:-3);});
 browser=new BrowserWorkspace({driver});browser.setPasswordManager(vault);
 stage('open-target');const opened=await browser.perform({action:'open',url:origin+'/'},{source:'agent',owner});
 const manager=await browser.perform({action:'password_manager',tabId:opened.tabId},{source:'agent',owner});let wc=driver.tab(manager.tabId).window.webContents;
 await until(()=>wc.executeJavaScript("document.querySelector('#status')?.textContent.startsWith('Local vault ready')"),'native manager ready');
 report.checks.push('Actual contained Passwords UI opens with native encrypted store');
 const previousWC=wc;driver.suspendTab(driver.tab(manager.tabId));
 await browser.perform({action:'snapshot',tabId:manager.tabId},{source:'agent',owner});
 wc=driver.tab(manager.tabId).window.webContents;assert.notEqual(wc,previousWC);
 await until(()=>wc.executeJavaScript("document.querySelector('#status')?.textContent.startsWith('Local vault ready')"),'manager resumed');
 report.checks.push('Manager suspend and resume rebinds scoped IPC to replacement native WebContents');
 if(!reuse){
  stage('generate-through-ui');
  await act(manager.tabId,'Username or email','fill','synthetic@example.test');
  await act(manager.tabId,'Label','fill','Generated signup');
  await act(manager.tabId,'Generate and save','click');
  await until(async()=> (await vault.list({origin})).length===1,'generated saved');
  const entry=(await vault.list({origin}))[0];backend.credentialId=entry.credentialId;backend.credentialRevision=entry.revision;backend.origin=origin;
  report.credentialId=entry.credentialId;
  report.checks.push('Agent used real manager controls to generate and durably save a signup credential');
 }else{
  stage('rediscover-after-restart');
  const entries=await vault.list({origin});const entry=entries.find(e=>e.credentialId===backend.credentialId);
  assert.ok(entry);assert.equal(entry.revision,backend.credentialRevision);report.credentialId=entry.credentialId;
  report.checks.push('New process and different task rediscovered the same saved credential ID and revision');
 }
 stage('fill-from-manager');
 await act(manager.tabId,'Use on site','click');
 await until(()=>driver.tab(opened.tabId).window.webContents.executeJavaScript("document.querySelector('input[name=password]').value.length>=16"),'target filled');
 const filled=await driver.tab(opened.tabId).window.webContents.executeJavaScript("({username:document.querySelector('input[name=username]').value,length:document.querySelector('input[name=password]').value.length})");
 assert.equal(filled.username,'synthetic@example.test');
 report.checks.push('Manager Use filled actual original website fields without submitting');
 assert.equal(backend.signupCount,reuse?1:0);assert.equal(backend.loginCount,0);
 if(!reuse){await act(opened.tabId,'Accept synthetic terms','click');await act(opened.tabId,'Create account','click');assert.equal(backend.signupCount,1);report.checks.push('Ordinary browser accepted synthetic terms and submitted signup; server confirmed account creation');}
 else{await act(opened.tabId,'Sign in','click');assert.equal(backend.loginCount,1);report.checks.push('Fresh task submitted login after full app restart; server verified the original generated password');}
 if(reuse){
 stage('save-update-existing-vault');
 await act(manager.tabId,'Clear form','click');
 await act(manager.tabId,'Username or email','fill','second@example.test');
 await act(manager.tabId,'Label','fill','Existing synthetic login');
 await act(manager.tabId,'Password to save or replace','fill','Synthetic-Existing-123456!');
 await act(manager.tabId,'Save login','click');
 await until(async()=> (await vault.list({origin})).length===2,'second saved');
 const second=(await vault.list({origin})).find(e=>e.username==='second@example.test');assert.ok(second);
 const buttons=await browser.perform({action:'snapshot',tabId:manager.tabId},{source:'agent',owner});
 const replaceIndex=await wc.executeJavaScript(`Array.from(document.querySelectorAll('.entry')).findIndex(e=>e.querySelector('[data-credential-id]')?.dataset.credentialId===${JSON.stringify(second.credentialId)})`); const replace=buttons.frames.flatMap(f=>f.elements||[]).filter(e=>e.name==='Replace')[replaceIndex];assert.ok(replace);
 await browser.perform({action:'click',tabId:manager.tabId,ref:replace.ref,expectedUrl:buttons.url,expectedDocumentId:buttons.documentId},{source:'agent',owner});
 await act(manager.tabId,'Password to save or replace','fill','Synthetic-Replaced-123456!');
 await act(manager.tabId,'Save login','click');
 await until(async()=> (await vault.list({origin})).some(e=>e.credentialId===second.credentialId&&e.revision===second.revision+1),'updated saved');
 assert.ok((await vault.list({origin})).some(e=>e.credentialId===backend.credentialId&&e.revision===backend.credentialRevision));
 report.checks.push('Actual manager Save and Replace preserve existing original login and update stable credential ID');
 }
 const envelope=await fs.readFile(vault.store.file,'utf8');assert.ok(!envelope.includes('synthetic@example.test'));report.checks.push('Saved store remains OS-encrypted with unchanged vault schema');
 writeFileSync(stateFile,JSON.stringify(backend));await driver.session.flushStorageData();report.origin=origin;
 await finish();
}catch(error){await finish(error);}}
main();
