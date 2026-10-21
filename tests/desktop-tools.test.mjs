import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopToolHandler, DESKTOP_TOOL, desktopToolForContainment, desktopInspectionResult } from '../lib/desktop-tools.mjs';
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
test('generic desktop mutation is unavailable in every mode, including saved or stale tool calls', async () => {
  for (const contained of [false, true, () => false, () => true]) {
    const actions = [];
    const handler = createDesktopToolHandler({ contained, desktop: {
      status: () => ({ enabled: true }), perform: async args => { actions.push(args); return { text: 'observed' }; },
    } });
    for (const action of ['invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse', 'scroll', 'scroll_into_view']) {
      assert.ok(!desktopToolForContainment(contained).inputSchema.properties.action.enum.includes(action));
      await assert.rejects(handler(call({ action, ref, value: 'never' })), /read-only inspection only/);
    }
    assert.equal(actions.length, 0, 'rejected requests never reach the native controller');
    assert.equal((await handler(call({ action: 'get_text', ref }))).success, true);
    assert.deepEqual(actions, [{ action: 'get_text', ref }]);
  }
});
test('inspection results do not advertise native mutation actions or alter the controller result', async () => {
  const native = { action: 'inspect', root: { ref, actions: ['inspect', 'get_text', 'set_value'], children: [{ name: 'Button', actions: ['invoke', 'toggle'] }] } };
  const before = structuredClone(native), handler = createDesktopToolHandler({ desktop: { status: () => ({ enabled: true }), perform: async () => native } });
  const result = JSON.parse((await handler(call({ action: 'inspect', windowId: '123' }))).contentItems[0].text);
  assert.deepEqual(result.root.actions, ['inspect', 'get_text']);
  assert.deepEqual(result.root.children[0].actions, []);
  assert.deepEqual(native, before);
  assert.deepEqual(desktopInspectionResult({ actions: ['windows', 'screenshot', 'invoke'] }), { actions: ['windows', 'screenshot'] });
});

test('desktop tools continue beyond the former hidden 100-action cutoff and respect explicit limits', async () => {
  const desktop = { status: () => ({ enabled: true }), perform: async () => ({ windows: [] }) }, handler = createDesktopToolHandler({ desktop });
  for (let index = 0; index < 105; index++) assert.equal((await handler(call({ action: 'windows' }))).success, true);
  const limited = createDesktopToolHandler({ desktop, maxCalls: 2 }); await limited(call({ action: 'windows' })); await limited(call({ action: 'windows' })); await assert.rejects(limited(call({ action: 'windows' })), /configured desktop action limit/);
  for (const maxCalls of [0, -1, 1.5, false]) assert.throws(() => createDesktopToolHandler({ desktop, maxCalls }), /positive whole number/);
});
test('detachment prevents inspection without introducing permission prompts', async () => {
  let performed = 0, enabled = false, approvals = 0;
  const desktop = { status: () => ({ enabled }), perform: async () => { performed++; return {}; } };
  const handler = createDesktopToolHandler({ desktop, requestApproval: async () => { approvals++; return { decision: 'decline' }; } });
  await assert.rejects(handler(call({ action: 'get_text', ref })), /detached/);
  assert.equal(performed, 0);
  enabled = true;
  assert.equal((await handler(call({ action: 'get_text', ref }))).success, true);
  assert.equal(performed, 1);
  assert.equal(approvals, 0);
});
test('cancellation before desktop invocation prevents inspection', async () => {
  const controller = new AbortController(); let performed = false;
  const handler = createDesktopToolHandler({ signal: controller.signal, desktop: { status: () => ({ enabled: true }), perform: async () => { performed = true; } } });
  controller.abort();
  await assert.rejects(handler(call({ action: 'get_text', ref })), /cancelled|stopped/i);
  assert.equal(performed, false);
});

test('cancellation during event delivery is rechecked before inspection', async () => {
  const controller = new AbortController(); let performed = false;
  const handler = createDesktopToolHandler({
    signal: controller.signal,
    desktop: { status: () => ({ enabled: true }), perform: async (_args, { signal }) => { if (signal.aborted) throw new Error('Run cancelled.'); performed = true; return {}; } },
    onEvent: event => { if (event.status === 'running') controller.abort(); },
  });
  await assert.rejects(handler(call({ action: 'get_text', ref })), /cancelled|stopped/i);
  assert.equal(performed, false);
});
test('desktop workflows retain the user-selected agent parallelism', () => {
  const w = validateWorkflow({ name: 'Desktop', settings: { maxParallel: 4 }, nodes: [
    { id: 'in', type: 'input' }, { id: 'agent', type: 'agent', prompt: 'Observe', desktop: true }, { id: 'out', type: 'output' },
  ], edges: [{ source: 'in', target: 'agent' }, { source: 'agent', target: 'out' }] });
  assert.equal(w.settings.maxParallel, 4);
  assert.equal(w.nodes[1].desktop, true);
});

test('agent schema rejects physical input and unknown inspection arguments before invocation', async () => {
  let performed=0;
  const handler=createDesktopToolHandler({desktop:{status:()=>({enabled:true}),perform:async()=>{performed++;return{};}}});
  for(const action of ['click','double_click','right_click','type','key','focus']) {
    assert.ok(!DESKTOP_TOOL.inputSchema.properties.action.enum.includes(action));
    await assert.rejects(handler(call({action,x:10,y:10,keys:'ENTER',text:'never'})), /Physical input is disabled/);
  }
  await assert.rejects(handler(call({action:'inspect',ref,x:10})),/Unknown desktop argument/);
  assert.equal(performed,0);
});
