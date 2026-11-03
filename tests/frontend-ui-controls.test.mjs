import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { prepareUIExpression } from '../desktop/frontend-ui-controls.mjs';
import { createFrontendDevtools } from '../desktop/frontend-devtools.mjs';
const args = { ref: 'ui-1', expectedDocumentId: 'doc', expectedUrl: 'http://app', operation: 'fill', text: 'hello' };
function fixture(overrides = {}) {
  const node = { isConnected: true, type: 'text', tagName: 'INPUT', autocomplete: '', closest: () => null, contains: x => x === node,
    checkVisibility: () => true, getBoundingClientRect: () => ({ left: 10, top: 10, right: 50, bottom: 40, width: 40, height: 30 }), ...overrides };
  const document = { activeElement: node, elementFromPoint: () => node };
  document[Symbol.for('blackice.frontend.ui.references')] = { documentId: 'doc', nodes: new Map([['ui-1', node]]), refs: new WeakMap(), next: 1 };
  return { node, document, location: { href: 'http://app' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), innerWidth: 800, innerHeight: 600 };
}
test('renderer guard rejects stale, detached, hidden, disabled, occluded and secret targets', () => {
  for (const [change, code] of [[{ type:'password' }, 'SECRET_INPUT'], [{ autocomplete:'one-time-code' }, 'SECRET_INPUT'], [{ isConnected:false }, 'STALE_REF'], [{ disabled:true }, 'DISABLED'], [{ checkVisibility:()=>false }, 'HIDDEN']]) {
    const result = vm.runInNewContext(prepareUIExpression(args), fixture(change));
    assert.equal(result.error.code, 'FRONTEND_UI_' + code);
  }
  const f = fixture(); f.document.elementFromPoint = () => ({});
  assert.equal(vm.runInNewContext(prepareUIExpression(args), f).error.code, 'FRONTEND_UI_OCCLUDED');
  assert.equal(vm.runInNewContext(prepareUIExpression({ ...args, expectedUrl:'other' }), fixture()).error.code, 'FRONTEND_UI_STALE_DOCUMENT');
});
test('snapshot redacts password and OTP values and emits stable references', async () => {
  const f = fixture({ type:'password', value:'do-not-leak', id:'p', getAttribute:()=>null, innerText:'', textContent:'', parentElement:null });
  f.document.body = { innerText:'' }; f.document.querySelectorAll=()=>[f.node];
  Object.assign(f, { scrollX:0, scrollY:0, devicePixelRatio:1 });
  let expression;
  const debug = { isAttached:()=>true, on(){}, removeListener(){}, async sendCommand(method, params){ expression=params.expression; return { result:{value: vm.runInNewContext(expression,f)} }; } };
  const controller = createFrontendDevtools({ getWindow:()=>({ webContents:{ id:1, debugger:debug, getOSProcessId:()=>1, on(){}, removeListener(){} } }) });
  try { const receipt=await controller.execute({action:'snapshot'}); assert.equal(receipt.snapshot.documentId,'doc'); assert.equal(receipt.snapshot.controls[0].value,'[redacted]'); assert.ok(receipt.snapshot.controls[0].ref); assert.ok(!JSON.stringify(receipt).includes('do-not-leak')); }
  finally {controller.close();}
});

function controllerFixture(f, onInput = () => {}) {
  const calls = [];
  const debug = { isAttached:()=>true, on(){}, removeListener(){}, async sendCommand(method, params) {
    calls.push({method,params});
    if (method === 'Runtime.evaluate') return {result:{value:vm.runInNewContext(params.expression,f)}};
    await onInput(method,params);
    return {};
  } };
  const controller = createFrontendDevtools({getWindow:()=>({webContents:{id:1,debugger:debug,getOSProcessId:()=>1,on(){},removeListener(){}}})});
  return {controller,calls};
}

test('hover layout changes cannot click the old target coordinates', async () => {
  let left=10;
  const f=fixture({getBoundingClientRect:()=>({left,top:10,right:left+40,bottom:40,width:40,height:30})});
  f.document.elementFromPoint=x=>x>=left&&x<=left+40?f.node:{};
  const {controller,calls}=controllerFixture(f,(_method,params)=>{if(params.type==='mouseMoved') left=200;});
  try {
    await assert.rejects(controller.execute({action:'interact',...args,operation:'click'}));
    assert.ok(!calls.some(c=>c.params.type==='mousePressed'), 'must not press at stale coordinates');
  } finally {controller.close();}
});

test('drag rechecks destination geometry before sending pointer movement', async () => {
  let left=200;
  const f=fixture();
  const destination={...f.node,getBoundingClientRect:()=>({left,top:10,right:left+40,bottom:40,width:40,height:30}),contains:n=>n===destination};
  f.document[Symbol.for('blackice.frontend.ui.references')].nodes.set('ui-2',destination);
  f.document.elementFromPoint=x=>x>=left&&x<=left+40?destination:f.node;
  const {controller,calls}=controllerFixture(f,(_method,params)=>{if(params.type==='mousePressed') left=400;});
  try {
    await assert.rejects(controller.execute({action:'interact',...args,operation:'drag',destinationRef:'ui-2'}));
    assert.ok(!calls.some(c=>c.params.type==='mouseMoved'&&c.params.buttons===1), 'must not drag to stale coordinates');
    assert.ok(calls.some(c=>c.params.type==='mouseReleased'), 'must release held pointer');
  } finally {controller.close();}
});

test('snapshot redacts secret textarea text as well as its value', async () => {
  const f=fixture({tagName:'TEXTAREA',autocomplete:'current-password',value:'secret-fixture',textContent:'secret-fixture',innerText:'',id:'secret',getAttribute:()=>null,parentElement:null});
  f.document.body={innerText:''};f.document.querySelectorAll=()=>[f.node];
  Object.assign(f,{scrollX:0,scrollY:0,devicePixelRatio:1});
  const {controller}=controllerFixture(f);
  try {assert.ok(!JSON.stringify(await controller.execute({action:'snapshot'})).includes('secret-fixture'));}
  finally {controller.close();}
});

test('fresh snapshot restores reference for a detached then reattached element', async () => {
  const f=fixture({value:'ordinary',id:'ordinary',getAttribute:()=>null,innerText:'',textContent:'',parentElement:null});
  f.document.body={innerText:''};f.document.querySelectorAll=()=>f.node.isConnected?[f.node]:[];
  Object.assign(f,{scrollX:0,scrollY:0,devicePixelRatio:1});
  const {controller}=controllerFixture(f);
  try {
    await controller.execute({action:'snapshot'});
    f.node.isConnected=false;
    await controller.execute({action:'snapshot'});
    f.node.isConnected=true;
    const snapshot=(await controller.execute({action:'snapshot'})).snapshot;
    assert.equal(vm.runInNewContext(prepareUIExpression({...args,ref:snapshot.controls[0].ref}),f).ok,true);
  } finally {controller.close();}
});

test('snapshot supports nonsecure documents without crypto.randomUUID', async () => {
  const f=fixture({value:'ordinary',getAttribute:()=>null,parentElement:null});
  delete f.document[Symbol.for('blackice.frontend.ui.references')];
  f.crypto={getRandomValues(array){return array.fill(42);}};
  f.document.body={innerText:''};f.document.querySelectorAll=()=>[f.node];
  Object.assign(f,{scrollX:0,scrollY:0,devicePixelRatio:1});
  const {controller}=controllerFixture(f);
  try {assert.ok((await controller.execute({action:'snapshot'})).snapshot.documentId);}
  finally {controller.close();}
});

test('press preserves focus without synthetic mouse activation', async () => {
  const f=fixture({focus(){}});
  const {controller,calls}=controllerFixture(f);
  try {
    await controller.execute({action:'interact',...args,operation:'press',key:'Enter'});
    assert.ok(!calls.some(c=>c.method==='Input.dispatchMouseEvent'));
    assert.deepEqual(calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.params.type),['keyDown','keyUp']);
  } finally {controller.close();}
});
