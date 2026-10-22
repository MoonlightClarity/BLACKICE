import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopToolHandler, DESKTOP_TOOL, desktopToolForContainment, desktopInspectionResult } from '../lib/desktop-tools.mjs';
import { DesktopController } from '../lib/desktop.mjs';
import { validateWorkflow } from '../lib/engine.mjs';

const call = arguments_ => ({ name: 'relay_desktop', arguments: arguments_ });
const ref = 'uia_0123456789ab_1';
test('desktop screenshot returns actual image content with coordinate metadata', async () => {
  let approvals = 0;
  const handler = createDesktopToolHandler({ desktop: {
    status: () => ({ enabled: true }),
    perform: async () => ({ image: { mimeType: 'image/png', data: 'PIXELS', width: 1280, height: 720 }, coordinates: { width: 1280, nativeWidth: 1920 }, foregroundWindow: { id: '123' } }),
  }, requestApproval: async () => { approvals++; } });
  const result = await handler(call({ action: 'screenshot' }));
  assert.equal(result.success, true);
  assert.equal(result.contentItems[1].imageUrl, 'data:image/png;base64,PIXELS');
  assert.equal(JSON.parse(result.contentItems[0].text).coordinates.nativeWidth, 1920);
  assert.equal(approvals, 0);
});
test('every task mode exposes and dispatches supported UIA mutations through the native controller without approval prompts', async () => {
  const mutations = [
    { action: 'invoke', ref }, { action: 'set_value', ref, value: 'Hello \u03bb' },
    { action: 'set_value', ref, value: '' }, { action: 'set_value', ref, value: 4.5 },
    { action: 'select', ref }, { action: 'toggle', ref }, { action: 'expand', ref },
    { action: 'collapse', ref }, { action: 'scroll', ref, direction: 'down', amount: 2, unit: 'small' },
    { action: 'scroll_into_view', ref },
  ];
  for (const contained of [false, true, () => false, () => true]) {
    const requests = []; let approvals = 0;
    const desktop = new DesktopController({ platform: 'win32', runner: async request => {
      requests.push(request); return { text: 'native result', mechanism: 'fixture_uia', observedInput: { cursorMoved: false, foregroundChanged: false } };
    } });
    desktop.setEnabled(true);
    const handler = createDesktopToolHandler({ contained, desktop, requestApproval: async () => { approvals++; } });
    for (const args of mutations) {
      assert.ok(desktopToolForContainment(contained).inputSchema.properties.action.enum.includes(args.action));
      const result = await handler(call(args));
      assert.equal(result.success, true);
      assert.deepEqual(JSON.parse(result.contentItems[0].text), { text: 'native result', mechanism: 'fixture_uia', observedInput: { cursorMoved: false, foregroundChanged: false } });
    }
    assert.deepEqual(requests, mutations, 'every requested semantic action reaches the existing native runner once');
    assert.equal(approvals, 0);
  }
});
test('inspection results preserve supported native mutation actions without advertising unimplemented operations', async () => {
  const native = { action: 'inspect', root: { ref, actions: ['inspect', 'get_text', 'set_value'], children: [{ name: 'Button', actions: ['invoke', 'toggle', 'click'] }] } };
  const before = structuredClone(native), handler = createDesktopToolHandler({ desktop: { status: () => ({ enabled: true }), perform: async () => native } });
  const result = JSON.parse((await handler(call({ action: 'inspect', windowId: '123' }))).contentItems[0].text);
  assert.deepEqual(result.root.actions, ['inspect', 'get_text', 'set_value']);
  assert.deepEqual(result.root.children[0].actions, ['invoke', 'toggle']);
  assert.deepEqual(native, before);
  assert.deepEqual(desktopInspectionResult({ actions: ['windows', 'screenshot', 'invoke', 'unimplemented_action'] }), { actions: ['windows', 'screenshot', 'invoke'] });
});

test('native provider failures are surfaced once without replay or a physical-input fallback', async () => {
  let performed = 0;
  const desktop = new DesktopController({ platform: 'win32', runner: async () => { performed++; throw new Error('This control does not support the invoke accessibility pattern.'); } });
  desktop.setEnabled(true);
  const handler = createDesktopToolHandler({ desktop });
  await assert.rejects(handler(call({ action: 'invoke', ref })), /does not support the invoke accessibility pattern/);
  assert.equal(performed, 1);
});

test('desktop tools continue beyond the former hidden 100-action cutoff and respect explicit limits', async () => {
  const desktop = { status: () => ({ enabled: true }), perform: async () => ({ windows: [] }) }, handler = createDesktopToolHandler({ desktop });
  for (let index = 0; index < 105; index++) assert.equal((await handler(call({ action: 'windows' }))).success, true);
  const limited = createDesktopToolHandler({ desktop, maxCalls: 2 }); await limited(call({ action: 'windows' })); await limited(call({ action: 'windows' })); await assert.rejects(limited(call({ action: 'windows' })), /configured desktop action limit/);
  for (const maxCalls of [0, -1, 1.5, false]) assert.throws(() => createDesktopToolHandler({ desktop, maxCalls }), /positive whole number/);
});
test('detachment prevents semantic mutation without introducing permission prompts', async () => {
  let performed = 0, enabled = false, approvals = 0;
  const desktop = { status: () => ({ enabled }), perform: async () => { performed++; return {}; } };
  const handler = createDesktopToolHandler({ desktop, requestApproval: async () => { approvals++; return { decision: 'decline' }; } });
  await assert.rejects(handler(call({ action: 'invoke', ref })), /detached/);
  assert.equal(performed, 0);
  enabled = true;
  assert.equal((await handler(call({ action: 'invoke', ref }))).success, true);
  assert.equal(performed, 1);
  assert.equal(approvals, 0);
});
test('cancellation before desktop invocation prevents semantic mutation', async () => {
  const controller = new AbortController(); let performed = false;
  const handler = createDesktopToolHandler({ signal: controller.signal, desktop: { status: () => ({ enabled: true }), perform: async () => { performed = true; } } });
  controller.abort();
  await assert.rejects(handler(call({ action: 'invoke', ref })), /cancelled|stopped/i);
  assert.equal(performed, false);
});

test('cancellation during event delivery is rechecked before semantic mutation', async () => {
  const controller = new AbortController(); let performed = false;
  const handler = createDesktopToolHandler({
    signal: controller.signal,
    desktop: { status: () => ({ enabled: true }), perform: async (_args, { signal }) => { if (signal.aborted) throw new Error('Run cancelled.'); performed = true; return {}; } },
    onEvent: event => { if (event.status === 'running') controller.abort(); },
  });
  await assert.rejects(handler(call({ action: 'set_value', ref, value: 'not dispatched' })), /cancelled|stopped/i);
  assert.equal(performed, false);
});
test('desktop workflows retain the user-selected agent parallelism', () => {
  const w = validateWorkflow({ name: 'Desktop', settings: { maxParallel: 4 }, nodes: [
    { id: 'in', type: 'input' }, { id: 'agent', type: 'agent', prompt: 'Observe', desktop: true }, { id: 'out', type: 'output' },
  ], edges: [{ source: 'in', target: 'agent' }, { source: 'agent', target: 'out' }] });
  assert.equal(w.settings.maxParallel, 4);
  assert.equal(w.nodes[1].desktop, true);
});

test('agent schema rejects unimplemented physical input and unknown desktop arguments before invocation', async () => {
  let performed=0;
  const handler=createDesktopToolHandler({desktop:{status:()=>({enabled:true}),perform:async()=>{performed++;return{};}}});
  for(const action of ['click','double_click','right_click','type','key','focus']) {
    assert.ok(!DESKTOP_TOOL.inputSchema.properties.action.enum.includes(action));
    await assert.rejects(handler(call({action,x:10,y:10,keys:'ENTER',text:'never'})), /Physical input is not implemented/);
  }
  await assert.rejects(handler(call({action:'inspect',ref,x:10})),/Unknown desktop argument/);
  assert.equal(performed,0);
});
