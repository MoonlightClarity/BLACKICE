/** Isolated native credential-authentication acceptance. Synthetic loopback accounts only.
 * Launch with raw Electron, never the installed app. No provider is started.
 */
import assert from 'node:assert/strict';
import { app, BrowserWindow, safeStorage } from 'electron';
import { promises as fs, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWorkspace } from '../../lib/browser.mjs';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserRouter } from '../../desktop/browser-router.mjs';
import { BrowserCredentialVault } from '../../lib/browser-credentials.mjs';
import { createBrowserCredentialToolHandler, createDirectBrowserCredentialTools } from '../../lib/browser-credential-tools.mjs';
import { connectorBrowserOwner } from '../../lib/connector-browser-owner.mjs';
import { createFixtureCertificate, FIXTURE_HOSTNAME } from './remote-access-native-tls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--profile-dir','--out','--receipt','--nonce'].includes(args[i]) && args[i + 1]);
  assert.equal(options[args[i]], undefined); options[args[i]] = args[i + 1];
}
const profile = options['--profile-dir'], out = options['--out'], receiptPath = options['--receipt'], nonce = options['--nonce'];
assert.equal(process.platform, 'win32');
assert.ok([profile, out, receiptPath].every(v => typeof v === 'string' && path.isAbsolute(v)));
assert.match(nonce, /^[a-f0-9-]{36}$/);
assert.equal(profile, path.join(out, 'owned-profile-' + nonce));
assert.equal(receiptPath, path.join(out, 'native-credential-authentication-result-' + nonce + '.json'));
assert.ok(!existsSync(profile) && !existsSync(receiptPath));
assert.ok(path.relative(ROOT, out).startsWith('..' + path.sep));
mkdirSync(out, { recursive: true }); mkdirSync(profile);
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.setName('BLACKICE isolated credential authentication');
assert.equal(app.requestSingleInstanceLock(), true);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP ' + FIXTURE_HOSTNAME + ' 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const report = { schema: 1, fixture: 'browser-credential-authentication-native', nonce, profile, candidate: ROOT,
  pid: process.pid, platform: process.platform, electron: process.versions.electron, startedAt: new Date().toISOString(),
  externalAccountsTested: false, providerTurnsRequested: 0, loopbackOnly: true, checks: [], errors: [], foregroundEvents: [], passed: false };
const progressPath = path.join(out, 'native-credential-authentication-progress-' + nonce + '.json');
const evidence = [], clients = new Set();
const served = { posts: 0, accepted: 0, rejected: 0, unexpected: 0 };
let browser, driver, vault, server, origin, expectedPassword, finished = false;
const sourceFiles = ['lib/browser.mjs','lib/browser-credentials.mjs','lib/browser-credential-tools.mjs',
  'desktop/browser-driver.mjs','desktop/browser-router.mjs','tests/fixtures/browser-credential-authentication-native.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async f => [f, createHash('sha256').update(await fs.readFile(path.join(ROOT,f))).digest('hex')])));
const save = () => writeFileSync(progressPath, JSON.stringify(report,null,2) + '\n');
const stage = name => { report.stage = name; save(); process.stdout.write(JSON.stringify({stage:name,checks:report.checks.length}) + '\n'); };
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); stage(name); };
const safeError = e => ({stage:report.stage,code:/^[A-Z][A-Z0-9_]{1,70}$/.test(e?.code || '')?e.code:'FIXTURE_CHECK_FAILED',
  frames:String(e?.stack || '').split('\n').slice(1).filter(v=>v.includes('browser-credential-authentication-native.mjs')).slice(0,3)});
async function until(name, predicate) {
  const end = Date.now()+15000;
  do { if(await predicate()) return; await new Promise(r=>setTimeout(r,40)); } while(Date.now()<end);
  throw Object.assign(Error(name),{code:'FIXTURE_TIMEOUT'});
}
const inspect = (tabId, script) => driver.tabs.get(tabId).window.webContents.executeJavaScript(script);
function form(url) {
  const reject = url.searchParams.has('reject'), js = url.searchParams.has('js'), signup = url.searchParams.has('signup');
  return '<!doctype html><title>Owned authentication fixture</title><h1>Fixture sign in</h1>'
    + '<form method="post" action="' + (reject?'/reject':'/accept') + '">'
    + '<label>Username<input name="username" type="email" autocomplete="username"></label>'
    + '<label>Password<input name="password" type="password" autocomplete="' + (signup?'new-password':'current-password') + '"></label>'
    + (signup?'<label>Confirm password<input name="confirmation" type="password" autocomplete="new-password"></label>':'')
    + '<button type="' + (js?'button':'submit') + '">Sign in</button></form>';
}
async function serve(req,res) {
  clients.add(req.socket.remoteAddress);
  const url = new URL(req.url, 'https://' + req.headers.host);
  if(url.hostname !== FIXTURE_HOSTNAME) { served.unexpected++;res.writeHead(400);return res.end(); }
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
  if(req.method === 'GET' && url.pathname === '/favicon.ico') {res.writeHead(204);return res.end();}
  if(req.method === 'GET' && url.pathname === '/form') return res.end(form(url));
  if(req.method === 'POST' && ['/accept','/reject'].includes(url.pathname)) {
    served.posts++; let bytes = '';
    for await (const chunk of req) { bytes += chunk; if(bytes.length > 8192) { served.unexpected++;res.writeHead(413);return res.end(); } }
    const values = new URLSearchParams(bytes);
    const matches = values.get('username') === 'synthetic@example.test' && values.get('password') === expectedPassword;
    if(matches && url.pathname === '/accept') { served.accepted++;res.end('<title>Fixture account</title><h1 data-auth-result="accepted">Signed in</h1>'); }
    else { served.rejected++;res.writeHead(401);res.end('<title>Fixture rejection</title><h1 data-auth-result="rejected">Sign in rejected</h1>'); }
    return;
  }
  served.unexpected++;res.writeHead(404);res.end();
}
const handle = entry => ({credentialId:entry.credentialId,revision:entry.revision,origin:entry.origin});
async function fresh(entry, suffix='', owner) {
  // Retire only the disposable tab after the preceding case's replay checks.
  for (const tabId of [...driver.tabs.keys()]) await browser.perform({action:'close',browser:'relay',tabId});
  const opened = await browser.perform({action:'open',browser:'relay',url:origin+'/form'+suffix},owner?{owner}:{});
  let view; await until('visible owned login fields',async()=>{view=await browser.perform({action:'snapshot',browser:'relay',tabId:opened.tabId},owner?{owner}:{});return view.frames.some(f=>f.url===view.url && f.elements.some(e=>e.name==='Password'));});
  evidence.push(view);
  const frame=view.frames.find(f=>f.url===view.url), ref=name=>frame.elements.find(e=>e.name===name)?.ref;
  const result={...handle(entry),browser:'relay',tabId:view.tabId,expectedUrl:view.url,expectedDocumentId:view.documentId,
    passwordRef:ref('Password'),usernameRef:ref('Username'),submitRef:ref('Sign in'),intent:suffix.includes('signup')?'signup':'login',
    ...(ref('Confirm password')?{confirmationRef:ref('Confirm password')}:{})};
  assert.ok(result.passwordRef&&result.usernameRef&&result.submitRef);return result;
}
let authorizations=0;
const authenticationOptions=()=>({vault,ownerId:'fixture-owner',beforeDispatch:async()=>{authorizations++;}});
async function authenticate(target, requestId) {
  const result=await browser.authenticateCredential({...target,requestId},authenticationOptions());
  evidence.push(result);return result;
}
app.on('browser-window-created',(_,window)=>{for(const name of ['show','focus'])window.on(name,()=>report.foregroundEvents.push({id:window.id,name}));});
async function run() {
  try {
    stage('initialize isolated native authentication');
    report.beforeHashes=await hashes();
    check('Actual Windows protected storage is available in isolated profile',safeStorage.isEncryptionAvailable()&&app.getPath('userData')===profile);
    const tls=createFixtureCertificate();
    server=https.createServer({key:tls.key,cert:tls.certificate},(req,res)=>{serve(req,res).catch(()=>{served.unexpected++;res.destroy();});});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    origin='https://'+FIXTURE_HOSTNAME+':'+server.address().port;
    driver=await new ElectronBrowserDriver({dataDir:profile,downloadDir:path.join(profile,'downloads')}).init();
    await driver.session.setProxy({mode:'direct'});
    const pin=new X509Certificate(tls.certificate).fingerprint256;
    driver.session.setCertificateVerifyProc((request,callback)=>{let valid=false;try{valid=request.hostname===FIXTURE_HOSTNAME&&new X509Certificate(request.certificate.data).fingerprint256===pin;}catch{}callback(valid?0:-2);});
    browser=new BrowserWorkspace({driver:new BrowserRouter({independent:driver})});
    vault=await new BrowserCredentialVault({dataDir:path.join(profile,'credential-data'),storageBackend:'dpapi',
      isEncryptionAvailable:()=>safeStorage.isEncryptionAvailable(),encryptSecret:v=>safeStorage.encryptString(v),decryptSecret:v=>safeStorage.decryptString(v)}).init();
    const tool=createBrowserCredentialToolHandler({vault,browser,ownerId:'fixture-owner'});
    const generated=await tool({name:'relay_credentials',arguments:{action:'generate',origin,username:'synthetic@example.test',requestId:'auth_native_generation'}});
    assert.ok(generated.success);const entry=JSON.parse(generated.contentItems[0].text);evidence.push(generated);
    await vault.withSecret(handle(entry),async secret=>{expectedPassword=secret.password;});
    check('Production authentication API is available',typeof browser.authenticateCredential==='function');
    const target=await fresh(entry), result=await authenticate(target,'native_auth_success');
    await until('controlled POST received',()=>served.posts===1);
    check('Authorized native authentication sends exactly one synthetic credential POST',served.posts===1&&served.accepted===1&&result.submissionRequested===true);
    check('Dispatch receipt does not claim authenticated success',result.outcome==='dispatched'&&result.authenticated!==true);
    const repeated=await authenticate(target,'native_auth_success');
    check('Same request replay returns existing result without another POST',served.posts===1&&repeated.submissionRequested===result.submissionRequested);
    let conflicting=false;try{await authenticate({...target,submitRef:'changed'},'native_auth_success');}catch{conflicting=true;}
    check('Changed request cannot reuse an existing operation identity',conflicting&&served.posts===1);
    const wrong=await fresh(entry,'?reject=1'), rejected=await authenticate(wrong,'native_auth_rejected');
    await until('controlled rejection received',()=>served.posts===2);
    check('Endpoint rejection is not reported as authenticated',served.rejected===1&&rejected.authenticated!==true);
    const stale=await fresh(entry);let staleRejected=false;
    try{await authenticate({...stale,expectedDocumentId:'stale-document'},'native_auth_stale');}catch{staleRejected=true;}
    check('Stale document rejects before another credential POST',staleRejected&&served.posts===2);
    const changed=await fresh(entry);
    await inspect(changed.tabId,"document.querySelector('form').action='https://wrong.example.test/submit'");
    let changedRejected=false;try{await authenticate(changed,'native_auth_foreign');}catch{changedRejected=true;}
    check('Changed foreign form destination rejects without network dispatch',changedRejected&&served.posts===2);
    const jsOnly=await fresh(entry,'?js=1');let unsupported=false;
    try{await authenticate(jsOnly,'native_auth_js_only');}catch{unsupported=true;}
    check('JS-only button is unsupported rather than falsely successful',unsupported&&served.posts===2);
    const signup=await fresh(entry,'?signup=1'), signedUp=await authenticate(signup,'native_auth_signup');
    await until('controlled signup POST received',()=>served.posts===3);
    check('Authorized signup fills confirmation and dispatches one native POST',served.accepted===2&&signedUp.outcome==='dispatched'&&signedUp.authenticated!==true);
    const unauthorized=await fresh(entry);let missingAuthority=false;
    try{await browser.authenticateCredential({...unauthorized,requestId:'native_auth_missing'},{vault,ownerId:'fixture-owner'});}catch{missingAuthority=true;}
    check('Missing host authorization callback cannot dispatch',missingAuthority&&served.posts===3);
    let revoked=false, revocationChecks=0;
    try{await browser.authenticateCredential({...unauthorized,requestId:'native_auth_revoked'},{vault,ownerId:'fixture-owner',beforeDispatch:async()=>{if(++revocationChecks>=3)throw Object.assign(Error('Owned fixture authorization revoked'),{code:'FIXTURE_REVOKED'});}});}catch{revoked=true;}
    check('Authorization revoked after preparation prevents submit',revoked&&revocationChecks>=3&&served.posts===3);
    const uncertainTarget=await fresh(entry), originalPrepare=driver.prepareCredentialAuthentication.bind(driver);
    // Fault injection loses only the receipt after the actual native commit returned.
    // It does not replace Chromium dispatch or the server; this is not a network-failure claim.
    driver.prepareCredentialAuthentication=async(...args)=>{const commit=await originalPrepare(...args);return async(...values)=>{await commit(...values);throw Object.assign(Error('Synthetic lost adapter receipt'),{code:'FIXTURE_LOST_RECEIPT'});};};
    let uncertain;try{uncertain=await authenticate(uncertainTarget,'native_auth_uncertain');}finally{driver.prepareCredentialAuthentication=originalPrepare;}
    await until('uncertain native POST received',()=>served.posts===4);
    check('Lost adapter receipt preserves uncertainty after actual native POST',uncertain.outcome==='unknown'&&uncertain.submissionRequested===null&&uncertain.authenticated!==true&&served.accepted===3);
    await vault.close();
    vault=await new BrowserCredentialVault({dataDir:path.join(profile,'credential-data'),storageBackend:'dpapi',
      isEncryptionAvailable:()=>safeStorage.isEncryptionAvailable(),encryptSecret:v=>safeStorage.encryptString(v),decryptSecret:v=>safeStorage.decryptString(v)}).init();
    const recovered=await authenticate(uncertainTarget,'native_auth_uncertain');
    check('Unknown result survives vault restart without duplicate submission',recovered.outcome==='unknown'&&served.posts===4);
    report.injectedFaults=['adapter receipt lost after native dispatch'];
    const handlerOwner={taskId:'native-fixture-task',runId:'native-fixture-run',nodeId:'native-fixture-node'};
    const nativeTarget=await fresh(entry,'',handlerOwner);
    let nativeAuthorizations=0;
    const nativeHandler=createBrowserCredentialToolHandler({vault,browser,ownerId:'native-handler-fixture',browserOwner:handlerOwner,
      beforeDispatch:async()=>{nativeAuthorizations++;}});
    const nativeResult=await nativeHandler({name:'relay_credentials',arguments:{action:'authenticate',...nativeTarget,requestId:'native_handler_auth'}});
    evidence.push(nativeResult);
    await until('native handler controlled POST',()=>served.posts===5);
    check('Production native tool handler dispatches through owned actual browser service',nativeResult.success===true&&JSON.parse(nativeResult.contentItems[0].text).outcome==='dispatched'&&nativeAuthorizations>0&&served.accepted===4);
    const client={id:'direct-fixture-client',scopes:['browser:read','browser:write']}, directOwner=connectorBrowserOwner(client.id);
    const directTarget=await fresh(entry,'',directOwner);let directAuthorizations=0;
    const directTools=createDirectBrowserCredentialTools({vault,browser,reauthorize:async(observed,context)=>{
      assert.equal(observed.id,client.id);assert.deepEqual(context.scopes,['browser:write']);assert.ok(!context.signal?.aborted);directAuthorizations++;
    }});
    const direct=directTools.find(item=>item.definition.name==='blackice_credentials_authenticate');
    assert.ok(direct);
    const directResult=await direct.execute({...directTarget,requestId:'direct_handler_auth'},{client});
    evidence.push(directResult);
    await until('direct adapter controlled POST',()=>served.posts===6);
    check('Production direct tool adapter dispatches through exact client-owned service',directResult.success===true&&JSON.parse(directResult.contentItems[0].text).outcome==='dispatched'&&directAuthorizations>0&&served.accepted===5);
    report.toolIntegration={nativeHandler:true,directAdapter:true,realProviderUsed:false,realOAuthTokenUsed:false,
      authorizationContext:'injected trusted fixture callbacks; production adapters and native service',nativeAuthorizations,directAuthorizations};
    const masked=await fresh(entry);
    const {intent,submitRef,...fillArgs}=masked;await browser.fillCredential(fillArgs,{vault});
    await inspect(masked.tabId,"document.querySelector('[name=password]').type='text'");
    const maskedView=await browser.perform({action:'snapshot',browser:'relay',tabId:masked.tabId});evidence.push(maskedView);
    let captureBlocked=false;try{await browser.perform({action:'screenshot',browser:'relay',tabId:masked.tabId});}catch(e){captureBlocked=e.code==='BROWSER_CREDENTIAL_CAPTURE_BLOCKED';}
    check('Existing protected snapshot and screenshot masking stays active',captureBlocked&&!JSON.stringify(maskedView).includes(expectedPassword));
    check('Authentication checks host authorization and never leaks generated password',authorizations>0&&!JSON.stringify([report,evidence]).includes(expectedPassword));
    check('All interactions remain on owned loopback sites and hidden windows',served.unexpected===0&&clients.size>0&&[...clients].every(v=>['127.0.0.1','::ffff:127.0.0.1'].includes(v))&&report.foregroundEvents.length===0&&BrowserWindow.getAllWindows().every(w=>!w.isVisible()&&!w.isFocused()&&!w.isFocusable()));
  }catch(e){report.errors.push(safeError(e));}
  finally{
    expectedPassword=undefined;
    try{await vault?.close();await(browser?browser.close():driver?.close());server?.closeAllConnections();if(server?.listening)await new Promise(resolve=>server.close(resolve));
      report.cleanup=BrowserWindow.getAllWindows().length===0&&!server?.listening;
      report.afterHashes=await hashes();report.sourceUnchanged=JSON.stringify(report.beforeHashes)===JSON.stringify(report.afterHashes);
    }catch(e){report.errors.push(safeError(e));}
    report.served={...served};report.authorizationChecks=authorizations;report.finishedAt=new Date().toISOString();
    report.passed=report.errors.length===0&&report.cleanup&&report.sourceUnchanged&&report.checks.length===20;
    report.profileRetainedForPostExitCleanup=true;finished=true;clearTimeout(watchdog);save();writeFileSync(receiptPath,JSON.stringify(report,null,2)+'\n');app.exit(report.passed?0:1);
  }
}
const watchdog=setTimeout(()=>{if(finished)return;report.errors.push({stage:report.stage,code:'FIXTURE_HARD_DEADLINE'});writeFileSync(receiptPath,JSON.stringify(report,null,2)+'\n');app.exit(1);},180000);
app.whenReady().then(run).catch(e=>{report.errors.push(safeError(e));writeFileSync(receiptPath,JSON.stringify(report,null,2)+'\n');app.exit(1);});
