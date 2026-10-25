import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DiagnosticsStore } from '../lib/diagnostics.mjs';
import { electronExitReceipt } from '../desktop/electron-exit-diagnostics.mjs';

test('Electron process exit and Crashpad local-only receipts persist without user content', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-native-diagnostics-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new DiagnosticsStore({ dataDir, version:'2.33.14' });
  await store.init();
  const crash = electronExitReceipt('renderer', {
    reason:'crashed',exitCode:-2147483645,
    url:'https://private.example/billing',
    message:'A private conversation should never enter the log.',
  }, 57);
  assert.equal(await store.record(crash),true);
  assert.equal(await store.record({
    component:'electron-crashpad',event:'local_enabled',
    mode:'local-only',uploadToServer:false,
    profilePath:'C:\\Users\\person\\private',
    payload:'Private memory content',
  }),true);
  await store.flush();
  const content = await readFile(store.file(0),'utf8');
  const lines = content.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(lines.length,2);
  assert.equal(lines[0].component,'electron-process');
  assert.equal(lines[0].event,'process_gone');
  assert.equal(lines[0].reason,'crashed');
  assert.equal(lines[0].exitCode,-2147483645);
  assert.equal(lines[0].processType,'renderer');
  assert.equal(lines[0].webContentsId,57);
  assert.equal(lines[1].component,'electron-crashpad');
  assert.equal(lines[1].event,'local_enabled');
  assert.equal(lines[1].mode,'local-only');
  assert.equal(lines[1].uploadToServer,false);
  assert.doesNotMatch(content,/private|billing|person|conversation|memory content/i);
  await store.close();
});

test('malformed Electron process metadata is ignored, not written verbatim',async t=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-native-diagnostics-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=new DiagnosticsStore({dataDir,version:'2.33.14'});
  await store.init();
  assert.equal(await store.record({component:'desktop',event:'local_enabled'}),false,
    'Crashpad-only events must not be accepted from unrelated components.');
  assert.equal(await store.record({component:'electron-process',event:'ready'}),false,
    'Native process metadata must use the dedicated event name.');
  const accepted=await store.record({
    component:'electron-process',event:'process_gone',reason:'https://bad.example/path',
    exitCode:'crash!',processType:'renderer C:\\private\\file',webContentsId:'123',
    url:'https://bad.example/path',data:'secret',
  });
  assert.equal(accepted,true);
  const event=(await store.snapshot()).events[0];
  assert.equal(event.component,'electron-process');
  assert.equal(event.reason,undefined);
  assert.equal(event.exitCode,undefined);
  assert.equal(event.processType,undefined);
  assert.equal(event.webContentsId,undefined);
  assert.doesNotMatch(JSON.stringify(event),/bad\.example|private|secret/i);
  await store.close();
});
