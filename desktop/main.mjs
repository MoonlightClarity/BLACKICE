import { app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain, nativeTheme, screen, shell, safeStorage, session, clipboard } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessServer } from '../server.mjs';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { ElectronBrowserDriver } from './browser-driver.mjs';
import { BrowserRouter } from './browser-router.mjs';
import { LazyFirefoxDriver } from './firefox-lazy.mjs';
import { startBackgroundBrowser } from '../lib/browser-startup.mjs';
import { DiagnosticsStore } from '../lib/diagnostics.mjs';
import {recoverProfileRestore} from '../lib/profile-backup.mjs';
import {prepareProfileMaintenance,registerMaintenanceHelper,cancelPreparedMaintenance,awaitProfileMaintenance,readMaintenanceReceipt} from '../lib/profile-maintenance.mjs';
import { DesktopLifecycle, parseDesktopLaunchArgs, prepareDesktopProfile, buildDesktopRelaunchArgs } from './lifecycle.mjs';
import { DesktopRestartController } from './restart.mjs';
import { writeDesktopRuntimeRecord } from './runtime-record.mjs';
import { createClipboardHandler, isTrustedDesktopSender } from './clipboard.mjs';
import { desktopRemoteAccessArgs, runRemoteAccessCLI } from '../lib/remote-access-cli.mjs';
import { desktopBrowserArgs, runBrowserCLI } from '../lib/browser-cli.mjs';
import { desktopRestartArgs, runDesktopRestartCLI } from '../lib/desktop-restart-cli.mjs';
import { DESKTOP_RESTART_ORIGIN_ENV } from '../lib/desktop-restart-origin.mjs';
import { credentialTemporaryProtection } from '../lib/credential-temp-protection.mjs';
import { DesktopStartup, createStartupIndicator } from './startup.mjs';
import { createDesktopConnectionStartup } from './connection-startup.mjs';
import { DesktopRendererRecovery } from './renderer-recovery.mjs';

const accessArgs = desktopRemoteAccessArgs(process.argv, { packaged: app.isPackaged });
const browserArgs = desktopBrowserArgs(process.argv, { packaged: app.isPackaged });
const restartArgs = desktopRestartArgs(process.argv, { packaged: app.isPackaged });
if (accessArgs || browserArgs || restartArgs) {
  // A CLI invocation must not initialize a profile, take its lock, show its
  // window, or log the code/credential in desktop diagnostics.
  const exitCode = await (browserArgs ? runBrowserCLI : accessArgs ? runRemoteAccessCLI : runDesktopRestartCLI)(browserArgs || accessArgs || restartArgs, {
    defaultProfile: path.join(app.getPath('appData'), 'Relay'), expectedExecutable: process.execPath,
    legacyHandoff: runtime => {
      // Explicit compatibility bootstrap only. The already-verified old primary
      // owns the actual restart; this secondary never launches a replacement.
      app.setName('BLACKICE'); app.setPath('userData', runtime.profile);
      if (app.requestSingleInstanceLock({ headless: false, background: false, quit: false, restart: true })) {
        app.releaseSingleInstanceLock();
        throw Object.assign(new Error('The verified primary stopped before the legacy handoff. No restart was scheduled.'), { code: 'DESKTOP_RESTART_LEGACY_UNAVAILABLE' });
      }
    },
  });
  app.exit(exitCode);
} else {
delete process.env[DESKTOP_RESTART_ORIGIN_ENV];
const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.dirname(DESKTOP_DIR);
const ACTIVE = new Set(['queued', 'running', 'waiting']);
let mainWindow, harness, origin, shutdownPromise, didClose = false;
let rendererRecovery = null;
let windowState = {}, windowSaveTimer, windowWriteChain = Promise.resolve();
let maintenancePromise=null,maintenanceReceipt=null,maintenanceScheduled=false;
let runtimeRecord = null, runtimeWriteChain = Promise.resolve();
let desktopRestart = null, restartReady = false, restartClosing = false;
const launch = parseDesktopLaunchArgs();
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
// --headless controls BLACKICE's window, not Chromium's browser implementation.
// The contained browser and Electron safeStorage remain fully available.
app.commandLine.removeSwitch('headless');

app.setName('BLACKICE');
app.setAppUserModelId('com.agentdesk.workbench');
// Keep existing conversation data and encrypted settings under the historical
// Relay profile. Presentation can change without moving saved user data.
// A separate, verified profile migration can happen later if needed.
app.setPath('userData', await prepareDesktopProfile(launch, { defaultProfile: path.join(app.getPath('appData'), 'Relay') }));
nativeTheme.themeSource = 'dark';
const diagnostics = new DiagnosticsStore({ dataDir: app.getPath('userData'), version: app.getVersion() });
const startup = new DesktopStartup({ headless: launch.headless || launch.background, createIndicator: () => createStartupIndicator({ BrowserWindow, icon: path.join(DESKTOP_DIR, 'icon.ico'), onQuit: () => app.quit() }) });
const desktopLifecycle = new DesktopLifecycle({ headless: launch.headless, background: launch.background, getWindow: () => mainWindow, createWindow, saveWindow: saveWindowState, quit: () => app.quit(), restart: async () => {
  if (!desktopRestart) throw new Error('BLACKICE is still starting. Try restart after it is ready.');
  await desktopRestart.request({ requestId: randomUUID(), ownerId: 'local' });
  const receipt = await desktopRestart.waitForHandoff();
  if (!['restarting', 'completed'].includes(receipt?.status)) throw Object.assign(new Error(receipt?.error?.message || 'BLACKICE could not prepare the restart and remains open.'), { code: receipt?.error?.code || 'DESKTOP_RESTART_PREPARE_FAILED' });
} });
desktopLifecycle.on('updated', () => { if (runtimeRecord && !shutdownPromise) void saveRuntimeRecord(); });

function saveRuntimeRecord() {
  if (!runtimeRecord) return runtimeWriteChain;
  const value = JSON.stringify({ ...runtimeRecord, lifecycle: desktopLifecycle.status(), restart: desktopRestart?.status(), at: new Date().toISOString() });
  const file = path.join(app.getPath('userData'), 'desktop-runtime.json');
  runtimeWriteChain = runtimeWriteChain.catch(() => {}).then(() => writeDesktopRuntimeRecord(file, value)).catch(error => diagnostics.recordError('desktop', 'storage_failed', error));
  return runtimeWriteChain;
}

async function migrateHistory(dataDir) {
  const marker = path.join(dataDir, 'migration.json');
  try { await fs.access(marker); return; } catch {}
  const candidates = app.isPackaged
    ? [path.resolve(path.dirname(process.execPath), '..', 'relay-harness', 'data')]
    : [path.join(APP_DIR, 'data')];
  let migrated = false;
  for (const source of candidates) {
    for (const name of ['workflows.json', 'runs.json', 'knowledge.json']) {
      try {
        // Validate first; never overwrite history already created by the desktop app.
        JSON.parse(await fs.readFile(path.join(source, name), 'utf8'));
        await fs.copyFile(path.join(source, name), path.join(dataDir, name), constants.COPYFILE_EXCL);
        migrated = true;
      } catch (error) {
        if (!['ENOENT', 'EEXIST'].includes(error.code)) console.warn(`History migration skipped ${name}: ${error.message}`);
      }
    }
  }
  await fs.writeFile(marker, JSON.stringify({ version: 1, migrated, at: new Date().toISOString() }));
}

function trustedSender(event) {
  return isTrustedDesktopSender(event, mainWindow, origin);
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event) || args.length !== 0) throw new Error('BLACKICE desktop request is not allowed.');
    return fn();
  });
}

async function detachDesktop() {
  desktopRestart?.cancelPending();
  const pausingOperations=harness?.operations?.pause('Emergency stop requested.');
  pausingOperations?.catch(()=>{});
  const pausingInbox = harness?.inbox?.pause('Emergency stop requested. Resume the inbox when ready.');
  pausingInbox?.catch(() => {});
  harness?.browser?.cancel();
  const detaching = Promise.resolve().then(() => harness?.desktop?.setEnabled(false));
  let cancelled = 0;
  for (const run of harness?.engine.listRuns() || []) {
    if (!ACTIVE.has(run.status)) continue;
    try { harness.engine.cancelRun(run.id); cancelled++; } catch (error) { console.warn(error.message); }
  }
  cancelled += harness?.engine.cancelCompactions() || 0;
  await harness?.learning?.cancelBackground('Emergency stop requested.');
  await pausingInbox;
  await pausingOperations;
  await detaching;
  return { enabled: false, cancelled };
}

async function shutdown() {
  rendererRecovery?.stop();
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    restartReady = false;
    if (desktopRestart?.cancelPending()) await desktopRestart.waitForHandoff();
    desktopLifecycle.stop();
    startup.stop();
    void diagnostics.record({ component: 'desktop', event: 'stopping' });
    globalShortcut.unregisterAll();
    clearTimeout(windowSaveTimer);
    const savingWindow=saveWindowState();
    // A prepared restart has already admitted an idle, drained runtime. Preserve
    // the saved queue settings instead of applying the emergency-stop pauses.
    if (restartClosing) await Promise.resolve(harness?.desktop?.setEnabled(false)).catch(error => diagnostics.recordError('desktop', 'desktop_detach_failed', error));
    else await detachDesktop().catch(error => diagnostics.recordError('desktop', 'emergency_stop_failed', error));
    await savingWindow;
    try { await startup.drainAfter(() => harness?.close()); session.defaultSession?.flushStorageData();await session.defaultSession?.cookies.flushStore().catch(()=>{});await diagnostics.record({ component: 'desktop', event: 'stopped' }); }
    catch (error) { await diagnostics.recordError('desktop', 'stop_failed', error); throw error; }
    finally { try { await runtimeWriteChain; runtimeRecord = null; await fs.rm(path.join(app.getPath('userData'), 'desktop-runtime.json'), { force: true }); } finally { await diagnostics.close(); } }
  })();
  return shutdownPromise;
}

function profileMaintenance(mode){
  if(maintenancePromise)return maintenancePromise;
  if (restartClosing || ['scheduled', 'restarting'].includes(desktopRestart?.status().status)) return Promise.reject(new Error('BLACKICE is preparing a restart. Profile maintenance can start after it reopens.'));
  maintenancePromise=(async()=>{
    const profileDir=app.getPath('userData');
    const chosen=await dialog.showOpenDialog(mainWindow,{title:mode==='backup'?'Choose where to save the BLACKICE backup':'Choose a BLACKICE backup folder to restore',properties:['openDirectory',...(mode==='backup'?['createDirectory']:[])]});
    if(chosen.canceled||!chosen.filePaths[0])return{cancelled:true};
    const backupDir=mode==='backup'?path.join(chosen.filePaths[0],`BLACKICE-${new Date().toISOString().replace(/[:.]/g,'-')}.relay-backup`):chosen.filePaths[0];
    let prepared, maintenanceBegan = false;
    try{
      await harness.beginMaintenance();
      maintenanceBegan = true;
      prepared=await prepareProfileMaintenance({mode,profileDir,backupDir,appVersion:app.getVersion(),allowForeignBinding:mode==='restore'});
      const args=[path.join(DESKTOP_DIR,'maintenance-helper.mjs'),prepared.requestFile,process.execPath,...(!app.isPackaged?[APP_DIR]:[])];
      const child=spawn(process.execPath,args,{detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
      await registerMaintenanceHelper(prepared.requestFile,prepared.request.id,child.pid);child.unref();
      void diagnostics.record({component:'maintenance',event:mode==='backup'?'backup_started':'restore_started'});
      maintenanceScheduled=true;setImmediate(()=>app.quit());return{scheduled:true,restarting:true};
    }catch(error){if(prepared)await cancelPreparedMaintenance(prepared.requestFile,prepared.request.id).catch(()=>{});if(maintenanceBegan)harness?.endMaintenance();void diagnostics.recordError('maintenance','maintenance_failed',error);throw new Error(`${error.message} Queued work stays paused if maintenance preparation began.`);}
  })().finally(()=>{if(!maintenanceScheduled)maintenancePromise=null;});
  return maintenancePromise;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return windowWriteChain;
  windowState = { bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
  const snapshot = JSON.stringify(windowState);
  const destination = path.join(app.getPath('userData'), 'window-state.json');
  windowWriteChain = windowWriteChain.catch(() => {}).then(async () => {
    await fs.writeFile(`${destination}.tmp`, snapshot);
    await fs.rename(`${destination}.tmp`, destination);
  }).catch(error => console.warn(`Window state could not be saved: ${error.message}`));
  return windowWriteChain;
}

async function loadWindowState() {
  try { windowState = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'window-state.json'), 'utf8')); } catch { windowState = {}; }
  if (!windowState || typeof windowState !== 'object' || Array.isArray(windowState)) windowState = {};
  const bounds = windowState.bounds;
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key])) || bounds.width < 1100 || bounds.height < 760 || bounds.width > 32768 || bounds.height > 32768) { windowState = {}; return; }
  windowState.maximized = windowState.maximized === true;
  const visible = screen.getAllDisplays().some(display => {
    const area = display.workArea;
    return Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x) >= 200
      && Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y) >= 100;
  });
  if (!visible) { windowState = {}; return; }
  const titleVisible = screen.getAllDisplays().some(({ workArea: area }) => bounds.y >= area.y && bounds.y + 36 <= area.y + area.height
    && Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x) >= 200);
  if (!titleVisible) {
    const area = screen.getDisplayMatching(bounds).workArea;
    bounds.width = Math.max(1100, Math.min(bounds.width, area.width));
    bounds.height = Math.max(760, Math.min(bounds.height, area.height));
    bounds.x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width));
    bounds.y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height));
  }
}

async function startLocalHarness(dataDir, defaultCwd) {
  const portFile = path.join(app.getPath('userData'), 'desktop-port.json');
  const connectionStartup = createDesktopConnectionStartup({ platform: process.platform, executable: process.execPath, profileDir: app.getPath('userData'), appDir: APP_DIR, packaged: app.isPackaged,
    loginItem: {
      // Electron 44 parses this lookup as a command line; quotes preserve paths with spaces.
      inspect: async ({ path, args }) => app.getLoginItemSettings({ path: `"${path}"`, args }),
      enable: async ({ path, args, name }) => app.setLoginItemSettings({ openAtLogin: true, enabled: true, path, args, name }),
    },
  });
  let port = 0;
  try { const saved = JSON.parse(await fs.readFile(portFile, 'utf8')); if (Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535) port = saved.port; } catch {}
  const createInstance = async selectedPort => {
    const independent = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(app.getPath('userData'), 'downloads') }).init();
    const firefox = await new LazyFirefoxDriver().init();
    const driver = new BrowserRouter({ independent, firefox });
    const browser = new BrowserWorkspace({ driver });
    const secretStorage = safeStorage.isEncryptionAvailable() ? {
      encryptSecret: value => safeStorage.encryptString(value).toString('base64'),
      decryptSecret: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
    } : {};
    const credentialStorage = { ...secretStorage, storageBackend: () => process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : safeStorage.getSelectedStorageBackend(), isEncryptionAvailable: () => safeStorage.isEncryptionAvailable() };
    try { return await createHarnessServer({ installPath: path.dirname(process.execPath), port: selectedPort, dataDir, defaultCwd, browser, secretStorage, credentialStorage,
      protectCredentialTemporaryDirectory: credentialTemporaryProtection({ dataDir }), revealCredentialImportFile: filename => shell.showItemInFolder(filename),
      openExternal: url => shell.openExternal(url), tokenRuntimeExecutable: process.execPath, diagnostics, desktopLifecycle, desktopRestart, connectionStartup, maintenanceStatus:()=>maintenanceReceipt?{mode:maintenanceReceipt.mode,status:maintenanceReceipt.status,requiresReauthentication:maintenanceReceipt.result?.requiresReauthentication===true}:null, signedBrowser: true, startSignedBrowser: browserOptions => startBackgroundBrowser(browserOptions) }); }
    catch (error) { await browser.close(); throw error; }
  };
  let instance = await createInstance(port);
  let url;
  try { url = await instance.listen(); }
  catch (error) {
    await instance.close();
    if (error.code !== 'EADDRINUSE' || port === 0) throw error;
    instance = await createInstance(0);
    url = await instance.listen();
  }
  await fs.writeFile(portFile, JSON.stringify({ port: Number(new URL(url).port) }));
  return { instance, url };
}

function createWindow() {
  rendererRecovery?.stop();
  const window = mainWindow = new BrowserWindow({
    width: 1500, height: 980, minWidth: 780, minHeight: 560,
    ...(windowState.bounds || {}),
    title: 'BLACKICE', backgroundColor: '#000000', darkTheme: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#eeeeee', height: 36 },
    show: false, autoHideMenuBar: true,
    icon: path.join(DESKTOP_DIR, 'icon.ico'),
    webPreferences: {
      preload: path.join(DESKTOP_DIR, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, devTools: !app.isPackaged,
      spellcheck: false,
      additionalArguments: [`--relay-version=${app.getVersion()}`],
    },
  });
  mainWindow.removeMenu();
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (['https:', 'http:'].includes(target.protocol)) void shell.openExternal(target.href).catch(() => console.warn('The link could not be opened in the default browser.'));
    } catch {}
    return { action: 'deny' };
  });
  const preventNavigation = (event, target) => {
    try {
      const parsed = new URL(target);
      if (parsed.origin === origin && ['/', '/index.html'].includes(parsed.pathname)) return;
    } catch {}
    event.preventDefault();
  };
  contents.on('will-navigate', preventNavigation);
  contents.on('will-redirect', preventNavigation);
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
  contents.session.setPermissionCheckHandler(() => true);
  contents.session.setDevicePermissionHandler(() => true);
  contents.session.setUSBProtectedClassesHandler(() => []);
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try { allowed = new URL(details.url).origin === origin; } catch {}
    if (details.resourceType === 'image' && /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(details.url)) allowed = true;
    callback({ cancel: !allowed });
  });
  const recovery = rendererRecovery = new DesktopRendererRecovery({
    window, url: `${origin}/`,
    isClosing: () => Boolean(shutdownPromise || didClose || restartClosing || maintenanceScheduled || desktopLifecycle.stopped || desktopLifecycle.quitting),
    showRecovery: options => dialog.showMessageBox(window, options),
    onCrash: details => diagnostics.record({ component: 'desktop', event: 'renderer_gone', level: 'error', reason: details.reason, exitCode: details.exitCode }),
    onUnresponsive: () => diagnostics.record({ component: 'desktop', event: 'renderer_unresponsive', level: 'warning' }),
    onResponsive: () => diagnostics.record({ component: 'desktop', event: 'renderer_responsive' }),
    onError: error => diagnostics.recordError('desktop', 'window_reopen_failed', error),
    onUnavailable: () => {
      if (!startup.stopped && desktopLifecycle.mode === 'window' && !window.isDestroyed()) { window.show(); startup.indicator?.dispose(); }
    },
  });
  let readyToShow = false;
  const handoffStartup = () => startup.handoff(mainWindow, readyToShow);
  mainWindow.on('show', handoffStartup);
  mainWindow.once('ready-to-show', () => { readyToShow = true; if (!startup.stopped && !desktopLifecycle.stopped && desktopLifecycle.mode === 'window') { if (windowState.maximized) mainWindow.maximize(); mainWindow.show(); } handoffStartup(); });
  for (const event of ['move', 'resize', 'maximize', 'unmaximize']) mainWindow.on(event, () => {
    clearTimeout(windowSaveTimer); windowSaveTimer = setTimeout(() => { void saveWindowState(); }, 350);
  });
  mainWindow.on('close', () => { recovery.stop(); void saveWindowState(); });
  mainWindow.on('closed', () => { mainWindow = null; if (!didClose) desktopLifecycle.windowClosed(); });
  return recovery.loadInitial();
}

if (!app.requestSingleInstanceLock({ headless: launch.headless, background: launch.background, quit: launch.quit, restart: launch.restart })) {
  app.quit();
} else if (launch.quit) {
  app.releaseSingleInstanceLock(); app.quit();
} else {
  let fatalFailure = false;
  const failClosed = (error, event) => {
    if (fatalFailure) return;
    fatalFailure = true;
    rendererRecovery?.stop();
    void diagnostics.recordError('desktop', event, error);
    void detachDesktop().catch(() => {}).finally(() => app.quit());
  };
  process.on('uncaughtException', error => failClosed(error, 'uncaught_exception'));
  process.on('unhandledRejection', error => failClosed(error, 'unhandled_rejection'));
  app.on('second-instance', (_event, commandLine, _directory, extra) => {
    // Malformed secondary arguments must never reach the fatal-error quit path.
    try {
      const requested = extra && ['headless', 'background', 'quit', 'restart'].every(key => typeof extra[key] === 'boolean') ? extra : parseDesktopLaunchArgs(commandLine);
      void desktopLifecycle.secondInstance(requested).then(async () => {
        // Reopening a settled failed shell is an explicit, bounded retry.
        if (!requested.quit && !requested.restart && !requested.headless && !requested.background) await rendererRecovery?.retry();
      }).catch(error => diagnostics.recordError('desktop', requested.restart ? 'restart_failed' : 'window_reopen_failed', error));
    } catch (error) { void diagnostics.recordError('desktop', 'lifecycle_request_failed', error); }
  });
  app.on('window-all-closed', () => desktopLifecycle.windowClosed());
  app.on('before-quit', event => {
    rendererRecovery?.stop();
    if (didClose) return;
    event.preventDefault();
    const timer = setTimeout(async () => {
      // A provider that fails to acknowledge cancellation must not keep the app alive.
      try {
        await Promise.race([
          Promise.resolve(harness?.runtime.close?.()),
          new Promise(resolve => setTimeout(resolve, 3_000)),
        ]);
      } catch (error) { await diagnostics.recordError('desktop', 'stop_failed', error); }
      finally { await Promise.race([diagnostics.flush(), new Promise(resolve => setTimeout(resolve, 1000))]); app.exit(1); }
    }, 25_000);
    void shutdown().catch(error => console.error('BLACKICE shutdown:', error.message)).finally(() => {
      clearTimeout(timer); didClose = true; app.quit();
    });
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.whenReady().then(async () => {
    await startup.step(() => awaitProfileMaintenance({profileDir:app.getPath('userData')}));
    await startup.step(() => recoverProfileRestore({profileDir:app.getPath('userData')}));
    maintenanceReceipt=await startup.step(() => readMaintenanceReceipt(app.getPath('userData')));
    await startup.step(() => diagnostics.init()); await startup.step(() => diagnostics.record({ component: 'desktop', event: 'started' }));
    if(maintenanceReceipt)void diagnostics.record({component:'maintenance',event:maintenanceReceipt.status==='completed'?(maintenanceReceipt.mode==='backup'?'backup_completed':'restore_completed'):'maintenance_failed',...(maintenanceReceipt.status==='failed'?{level:'error',code:maintenanceReceipt.code}:{})});
    Menu.setApplicationMenu(null);
    await startup.showIndicator();
    const userData = app.getPath('userData');
    const dataDir = path.join(userData, 'data');
    const defaultCwd = app.isPackaged || launch.profileDir ? path.join(userData, 'workspace') : path.join(APP_DIR, 'workspace');
    await startup.step(() => fs.mkdir(dataDir, { recursive: true }));
    if (!launch.profileDir) await startup.step(() => migrateHistory(dataDir));
    // The primary owns every receipt and native handoff. Normal --restart calls
    // use the acknowledged local protocol; only explicit legacy bootstrap uses
    // the old single-instance event.
    desktopRestart = new DesktopRestartController({
      profileDir: userData,
      getIdentity: () => ({ pid: process.pid, startedAt: processStartedAt, profileDir: userData, mode: desktopLifecycle.status().mode }),
      getLaunchOptions: () => ({ execPath: process.execPath, args: buildDesktopRelaunchArgs({ profileDir: launch.profileDir, mode: desktopLifecycle.status().mode }), profileDir: userData, mode: desktopLifecycle.status().mode }),
      checkReady: async context => {
        if (!restartReady || shutdownPromise || maintenancePromise) throw Object.assign(new Error('BLACKICE is starting, closing, or preparing profile maintenance.'), { code: 'DESKTOP_RESTART_CLOSING' });
        if (context.jobId && !context.origin) throw Object.assign(new Error('The originating restart action has no owned binding.'), { code: 'DESKTOP_RESTART_ORIGIN_INVALID' });
        await harness.assertRestartReady(context);
      },
      prepare: async context => {
        if (!restartReady || shutdownPromise || maintenancePromise) throw Object.assign(new Error('BLACKICE is no longer ready to restart.'), { code: 'DESKTOP_RESTART_CLOSING' });
        await harness.beginRestart(context);
        if (context.jobId) {
          const job = await harness.directExecution.validateRestartOrigin(context.origin, { requireFinished: true });
          if (job.jobId !== context.jobId || job.ownerId !== context.ownerId) throw Object.assign(new Error('The originating action does not match the restart receipt.'), { code: 'DESKTOP_RESTART_ORIGIN_INVALID' });
        }
        await saveWindowState();
        await runtimeWriteChain;
        await diagnostics.flush();
      },
      release: () => harness?.endRestart(),
      relaunch: options => { harness.assertRestartPrepared(); app.relaunch(options); restartClosing = true; },
      quit: () => app.quit(),
    });
    await startup.step(() => desktopRestart.init());
    const local = await startup.step(() => startLocalHarness(dataDir, defaultCwd), value => value.instance.close());
    harness = local.instance;
    await startup.step(() => harness.desktop.setEnabled(true));
    harness.server.on('relay.shutdown', () => app.quit());
    origin = local.url;
    ipcMain.handle('relay:write-clipboard', createClipboardHandler({ trustedSender, writeText: text => clipboard.writeText(text) }));
    handle('relay:minimize', () => mainWindow.minimize());
    handle('relay:maximize', () => {
      if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
      return mainWindow.isMaximized();
    });
    handle('relay:close', () => { app.quit(); });
    handle('relay:pick-folder', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose an agent workspace', properties: ['openDirectory', 'createDirectory'], defaultPath: defaultCwd,
      });
      return result.canceled ? null : result.filePaths[0];
    });
    handle('relay:pick-files', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Attach files to your task', properties: ['openFile', 'multiSelections'], defaultPath: defaultCwd,
        filters: [{ name: 'All files', extensions: ['*'] }],
      });
      return result.canceled ? [] : result.filePaths;
    });
    ipcMain.handle('relay:open-artifact', async (event, reference) => {
      if (!trustedSender(event) || !reference || typeof reference !== 'object' || Array.isArray(reference)
        || Object.keys(reference).some(key => !['taskId','artifactId'].includes(key))
        || !/^[a-zA-Z0-9_-]{1,100}$/.test(reference.taskId || '') || !/^artifact_[a-f0-9-]{36}$/.test(reference.artifactId || '')) throw new Error('Choose a file registered for this task.');
      const artifact = await harness.tasks.verifyArtifact(reference.taskId, reference.artifactId);
      const error = await shell.openPath(artifact.path); if (error) throw new Error(error);
      return { opened: true, name: artifact.fileName };
    });
    handle('relay:detach-desktop', detachDesktop);
    handle('relay:backup-profile',()=>profileMaintenance('backup'));
    handle('relay:restore-profile',()=>profileMaintenance('restore'));
    const shortcutRegistered = globalShortcut.register('Control+Alt+Escape', () => {
      void diagnostics.record({ component: 'desktop', event: 'emergency_stop', level: 'warning' });
      void detachDesktop().catch(error => diagnostics.recordError('desktop', 'emergency_stop_failed', error));
    });
    if (!shortcutRegistered) console.warn('Ctrl+Alt+Escape is already reserved by another application. Use Detach desktop in BLACKICE.');
    runtimeRecord = {
      pid: process.pid, executable: process.execPath, url: origin, version: app.getVersion(), startedAt: processStartedAt, shortcutRegistered, at: new Date().toISOString(),
      profileMode: launch.profileDir ? 'custom' : 'default',
      capabilities: { electron: true, nativeRestart: true, encryptedSecretsAvailable: safeStorage.isEncryptionAvailable(), containedBrowser: true },
    };
    await startup.step(() => saveRuntimeRecord());
    await startup.step(() => loadWindowState());
    await startup.step(() => desktopLifecycle.start());
    await startup.step(() => diagnostics.record({ component: 'desktop', event: 'ready' }));
    await startup.step(() => desktopRestart.confirmStartup());
    restartReady = true;
    await startup.step(() => saveRuntimeRecord());
  }).catch(async error => {
    if (startup.stopped || shutdownPromise || didClose) return;
    desktopLifecycle.stop(); startup.stop();
    await diagnostics.recordError('desktop', 'start_failed', error);
    if (!launch.headless && !launch.background) dialog.showErrorBox('BLACKICE could not start', error.message);
    else console.error('BLACKICE could not start:', error.message);
    await shutdown().catch(() => {});
    didClose = true; app.exit(1);
  });
}
}
