import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopController } from '../lib/desktop.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const enabled = process.platform === 'win32' && process.env.RELAY_LIVE_UIA_QA === '1';
test('live background accessibility actions change only a dedicated non-activating fixture and leave foreground and cursor untouched', { skip: !enabled, timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-uia-live-'));
  const stateFile = path.join(directory, 'state.json');
  const script = fileURLToPath(new URL('./fixtures/desktop-uia-fixture.ps1', import.meta.url));
  const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Sta','-ExecutionPolicy','Bypass','-File',script,'-StateFile',stateFile], { windowsHide: true, stdio: ['ignore','ignore','pipe'], shell: false });
  let errorText=''; child.stderr.on('data', value => { errorText += value.toString(); });
  const desktop = new DesktopController();
  t.after(async () => {
    desktop.setEnabled(false);
    await writeFile(`${stateFile}.stop`, '').catch(() => {});
    await Promise.race([new Promise(resolve => child.once('exit',resolve)), sleep(1000)]);
    if (child.exitCode === null) child.kill();
    assert.match(path.basename(directory), /^relay-uia-live-/);
    await rm(directory,{recursive:true,force:true});
  });
  const state = async check => {
    const until=Date.now()+8000;
    let latest;
    while(Date.now()<until) {
      try { const value=JSON.parse(await readFile(stateFile,'utf8')); latest=value; if(!check || check(value)) return value; } catch {}
      if(child.exitCode !== null) assert.fail(`Fixture exited: ${errorText}`);
      await sleep(40);
    }
    assert.fail(`Fixture state did not settle: ${JSON.stringify(latest)} ${errorText}`);
  };
  const before=await state();
  assert.notEqual(before.foreground,before.handle,'the fixture never activates itself');
  desktop.setEnabled(true);
  const windows=await desktop.perform({action:'windows'});
  assert.ok(windows.windows.some(window=>window.id===before.handle));
  let tree=await desktop.perform({action:'inspect',windowId:before.handle,maxDepth:8,maxNodes:200});
  const element=name=>{const item=tree.elements.find(item=>item.name===name);assert.ok(item,`Missing fixture element: ${name}; found ${tree.elements.map(item=>item.name).join(', ')}`);return item;};
  const originalRefs=new Map(tree.elements.map(item=>[`${item.automationId}:${item.name}`,item.ref]));
  const edit=element('Fixture text field'), button=element('Fixture apply'), checkbox=element('Fixture enabled');
  assert.ok(edit.actions.includes('set_value')); assert.ok(button.actions.includes('invoke'));
  assert.ok(!checkbox.actions.includes('toggle'),'known focus-taking WinForms provider is not advertised as background-capable');
  await assert.rejects(desktop.perform({action:'toggle',ref:checkbox.ref}),/WinForms checkbox provider activates its window/);
  const act=async args=>{const result=await desktop.perform(args);if(result.observedInput?.cursorMoved||result.observedInput?.foregroundChanged)t.diagnostic(JSON.stringify({action:args.action,before,after:await state(),observation:result.observedInput}));assert.deepEqual(result.observedInput,{cursorMoved:false,foregroundChanged:false},`${args.action} input state`);return result;};
  await act({action:'set_value',ref:edit.ref,value:'Background λ🚀 value'});
  assert.equal((await desktop.perform({action:'get_text',ref:edit.ref})).text,'Background λ🚀 value');
  await act({action:'invoke',ref:button.ref});
  const nativeCheckbox=element('Fixture native checkbox'); assert.ok(nativeCheckbox.actions.includes('toggle'));
  await act({action:'toggle',ref:nativeCheckbox.ref});
  const option=element('Fixture option 2'); assert.ok(option.actions.includes('select')); await act({action:'select',ref:option.ref});
  const parent=element('Fixture parent'); assert.ok(parent.actions.includes('expand')); await act({action:'expand',ref:parent.ref});
  await state(value=>value.text==='Background λ🚀 value'&&value.clicks===1&&value.nativeChecked&&!value.checked&&value.selected===2&&value.expanded);
  await act({action:'collapse',ref:parent.ref});
  const list=element('Fixture choices'); assert.ok(list.actions.includes('scroll'),'fixture list exposes ScrollPattern');
  await act({action:'scroll',ref:list.ref,direction:'down',amount:1,unit:'large'});
  const after=await state(value=>!value.expanded&&value.topIndex>0);
  assert.equal(after.foreground,before.foreground,'foreground remains the original user window');
  assert.equal(after.cursorX,before.cursorX,'physical pointer X unchanged'); assert.equal(after.cursorY,before.cursorY,'physical pointer Y unchanged');
  tree=await desktop.perform({action:'inspect',windowId:before.handle,maxDepth:8,maxNodes:200});
  assert.equal(element('Fixture text field').ref,originalRefs.get('fixtureEdit:Fixture text field'),'refs stay stable across fresh inspections');
  await assert.rejects(desktop.perform({action:'invoke',ref:element('Fixture unsupported canvas').ref}),/does not support.*invoke.*No physical-input fallback/i);
  await assert.rejects(desktop.perform({action:'set_value',ref:element('Fixture readonly').ref,value:'Must not change'}),/read-only/i);
  await assert.rejects(desktop.perform({action:'click',x:10,y:10}),/Physical mouse/);
  desktop.setEnabled(false); desktop.setEnabled(true);
  await assert.rejects(desktop.perform({action:'invoke',ref:button.ref}),/Unknown or expired/);
  t.diagnostic('Background set_value/get_text, invoke, toggle, select, expand/collapse and semantic scroll verified against actual fixture state; foreground and cursor unchanged.');
});
