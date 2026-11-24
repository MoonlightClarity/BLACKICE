import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrowserFillRequest, validateBrowserFillRequest, createBrowserToolHandler } from '../lib/browser.mjs';

test('a value-only fill spelling error becomes one text-only operation without mutating the call', () => {
  const original = Object.freeze({action:'fill',browser:'relay',tabId:'observed-tab',ref:'observed-field',value:'Supported draft'});
  const normalized=normalizeBrowserFillRequest(original);
  assert.deepEqual(normalized,{action:'fill',browser:'relay',tabId:'observed-tab',ref:'observed-field',text:'Supported draft'});
  assert.equal(validateBrowserFillRequest(normalized),'Supported draft');
  assert.equal(original.value,'Supported draft');
  assert.strictEqual(normalizeBrowserFillRequest(normalized),normalized);
  assert.equal(normalizeBrowserFillRequest({action:'fill',value:''}).text,'');
  assert.strictEqual(normalizeBrowserFillRequest({action:'select',value:'Choice'}).value,'Choice');
});

test('ambiguous, missing, or nonstring fill values remain rejected without dispatch', () => {
  for(const args of [
    {action:'fill',value:3},
    {action:'fill',value:null},
    {action:'fill',text:'one',value:'two'},
    {action:'fill',text:null,value:'one'},
    {action:'fill'}
  ]){
    const normalized=normalizeBrowserFillRequest(args);
    assert.strictEqual(normalized,args);
    assert.throws(()=>validateBrowserFillRequest(normalized),error=>
      error.code==='BROWSER_VALIDATION'&&error.actionDispatched===false&&error.inputDispatched===false);
  }
});

test('the shared agent browser path repairs the field spelling before preparing a page write', async () => {
  const calls=[],status={
    available:true,contained:true,activeTab:'tab-one',
    tabs:[{tabId:'tab-one',url:'https://forms.example.test/apply',documentId:'tab-one:1',
      purpose:'task',suspended:false,owner:null}],
    folders:[],ownerActiveTabs:{}
  };
  const browser={status:()=>status,async perform(args){
    calls.push(args);
    return {tabId:'tab-one',url:'https://forms.example.test/apply',documentId:'tab-one:1',
      receipt:{filled:true},frames:[{elements:[]}]};
  }};
  const handler=createBrowserToolHandler({browser,maxCalls:4});
  const original={name:'relay_browser',arguments:{action:'fill',browser:'relay',tabId:'tab-one',
    ref:'field-one',value:'Evidence grounded answer'}};
  const outcome=await handler(original);
  assert.equal(outcome.success,true,JSON.stringify(outcome));
  assert.equal(calls.length,1);
  assert.equal(calls[0].text,'Evidence grounded answer');
  assert.equal(Object.hasOwn(calls[0],'value'),false);
  assert.equal(original.arguments.value,'Evidence grounded answer','The original call remains inspectable.');
});
