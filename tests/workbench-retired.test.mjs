import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HarnessEngine } from '../lib/engine.mjs';
import { approvedWindowsPackageFile } from '../scripts/windows-release-inputs.mjs';

const read = relative => readFileSync(fileURLToPath(new URL('../' + relative, import.meta.url)), 'utf8');

test('the Windows VM launcher and renderer IPC are removed from BLACKICE', () => {
  const index = read('public/next/index.html');
  const app = read('public/next/app.mjs');
  const preload = read('desktop/preload.cjs');
  const main = read('desktop/main.mjs');
  const server = read('server.mjs');
  assert.doesNotMatch(index, /data-space="workbench"|workbench\.css/);
  assert.doesNotMatch(app, /createWorkbenchWorkspace|workspaces\/workbench\.mjs/);
  assert.doesNotMatch(preload, /relay:vm-surface|relay:workbench-features/);
  assert.doesNotMatch(main, /WorkbenchNativeSurface|relay:vm-surface|bindWorkbench/);
  assert.doesNotMatch(server, /\/api\/workbench|new WindowsWorkbench|workbenchVideo/);
});

test('explicit retired VM control requests are rejected before task execution', () => {
  assert.throws(
    () => HarnessEngine.prototype.startRun.call({}, { workbench: true }),
    { code: 'WORKBENCH_RETIRED', status: 410 }
  );
});

test('retired virtual machine resources are not approved as Windows installer inputs', () => {
  for (const file of [
    'lib/windows-workbench.mjs',
    'lib/workbench-agent-tools.mjs',
    'desktop/workbench-native-runtime.mjs',
    'desktop/workbench-freerdp-host.mjs',
    'scripts/workbench-headless-broker.ps1',
    'scripts/package-workbench-freerdp.mjs',
    'resources/workbench-native/package.json',
    'resources/guest/workbench-guest-video.exe',
    'public/next/workbench.css',
    'public/next/workspaces/workbench.mjs',
  ]) assert.equal(approvedWindowsPackageFile(file, '2.39.60'), false, file);
});

test('retiring Workbench preserves Chat, Planning, Cronjobs, Browser, Knowledge and Settings', () => {
  const index = read('public/next/index.html');
  const spaces = [...index.matchAll(/data-space="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(spaces, ['chat','visuals','planning','cronjobs','browser','knowledge','settings']);
});

test('retained Cronjobs routes preserve the workflow manager and legacy Tasks and Activity aliases', async () => {
  const source=read('public/next/app.mjs').replace(/\r\n/g,'\n');
  const routes=source.slice(source.indexOf('function updateTabs('),source.indexOf("for(const tab of tabs){\n  tab.addEventListener"));
  assert.ok(routes.includes('async function show('));
  assert.match(source,/cronjobs:.*createCronjobsWorkspace/);
  assert.match(source,/workflows:.*createWorkflowWorkspace/);
  const manager=read('public/next/workspaces/tasks.mjs');
  assert.match(manager,/manager\.id='next-cronjobs-manage-workflows'/);
  assert.match(manager,/manager\.textContent='Manage saved workflows'/);
  assert.match(manager,/manager\.addEventListener\('click',\(\)=>onNavigate\?\.\('workflows'\)\)/);

  const opened=[],hashes=[];
  const element=()=>({children:[],dataset:{},hidden:false,setAttribute(name,value){this[name]=value;},append(...items){this.children.push(...items);},querySelector(){return null;}});
  const tabs=['chat','visuals','planning','cronjobs','browser','knowledge','settings'].map(name=>Object.assign(element(),{dataset:{space:name}}));
  const modules=Object.fromEntries(['cronjobs','workflows'].map(name=>[name,async()=>()=>({enter(){opened.push(name);},leave(){},updateStatus(){}})]));
  const app=new Function('modules','document','stage','tabs','history',
    'let current=null,revision=0,status=null;const spaces=new Map(),api=()=>{},events={},notify=()=>{};'+routes+';return{show,spaces};'
  )(modules,{createElement:element},element(),tabs,{replaceState(_state,_title,hash){hashes.push(hash);}});

  await app.show('tasks');await app.spaces.get('cronjobs').loading;
  assert.deepEqual(opened,['cronjobs']);assert.equal(hashes.at(-1),'#cronjobs');
  assert.equal(app.spaces.has('tasks'),false);
  await app.show('workflows');await app.spaces.get('workflows').loading;
  assert.equal(opened.at(-1),'workflows');assert.equal(hashes.at(-1),'#workflows');
  assert.deepEqual(tabs.filter(tab=>tab['aria-selected']==='true').map(tab=>tab.dataset.space),['cronjobs']);
  await app.show('activity');
  assert.equal(opened.at(-1),'cronjobs');assert.equal(hashes.at(-1),'#cronjobs');
  assert.deepEqual([...app.spaces.keys()],['cronjobs','workflows']);
});

test('Windows installer validation and release workflow do not require VM companions', () => {
  for (const file of [
    'scripts/package-public.mjs',
    'scripts/verify-windows-release.ps1',
    '.github/workflows/publish-windows-release.yml',
    'desktop/electron-builder.yml',
  ]) {
    const content=read(file);
    assert.doesNotMatch(content, /package-workbench|workbench-native|workbench-guest|release-native-source-assets|Native-Sources\.tar/i,file);
  }
});
