import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {BrowserWorkspace,agentBrowserRequest,BROWSER_TOOL} from '../lib/browser.mjs';
import {tabMarkChange,restoredTabMark} from '../lib/browser-in-use.mjs';
import {browserCleanupPreview} from '../lib/browser-scoped-cleanup.mjs';
const owner={taskId:'task',runId:'run',nodeId:'worker'},tab={tabId:'tab',owner,conversationId:'task',inUse:false};
test('mark authority is separate from ownership; human marks cannot be removed or replaced by agents',()=>{
 const args={action:'tab_mark',tabId:'tab',inUse:true};
 assert.deepEqual(tabMarkChange(args,tab,{source:'agent',owner}),{inUse:true,inUseBy:{kind:'task',taskId:'task',nodeId:'worker'}});
 for(const context of [{source:'agent'},{source:'agent',owner:{...owner,nodeId:'other'}}])assert.throws(()=>tabMarkChange(args,tab,context),{code:'BROWSER_TAB_OWNERSHIP'});
 const human={...tab,inUse:true,inUseBy:{kind:'user'}};
 for(const inUse of [false,true])assert.throws(()=>tabMarkChange({...args,inUse},human,{source:'agent',owner}),{code:'BROWSER_TAB_IN_USE'});
 assert.deepEqual(tabMarkChange({...args,inUse:false},human,{source:'user'}),{inUse:false,inUseBy:null});
 assert.throws(()=>agentBrowserRequest({...args,inUse:'yes'},{tabs:[tab]},owner),{code:'BROWSER_VALIDATION'});
 assert.throws(()=>agentBrowserRequest({...args,owner},{tabs:[tab]},owner),{code:'BROWSER_VALIDATION'});
 assert.throws(()=>agentBrowserRequest({action:'close',tabId:'tab'},{tabs:[human]},owner),{code:'BROWSER_TAB_IN_USE'});
 assert.deepEqual(restoredTabMark({inUse:true,inUseBy:{kind:'task',taskId:4}}),{inUse:true,inUseBy:{kind:'user'}});
});
test('bulk close retains explicit in-use marks, reports them distinctly, and closes only unmarked tabs',async()=>{
 class Driver extends EventEmitter{constructor(){super();this.tabs=[{...tab,inUse:true},{tabId:'idle'}];this.effects=[];}status(){return {tabs:this.tabs,connected:true};}async perform(args,options){assert.equal(options.protectInUse,true);this.effects.push(args.tabId);this.tabs=this.tabs.filter(x=>x.tabId!==args.tabId);return this.status();}}
 const driver=new Driver(),browser=new BrowserWorkspace({driver});try{const receipt=await browser.closeTabs();assert.deepEqual(receipt.skippedInUseIds,['tab']);assert.deepEqual(receipt.closedTabIds,['idle']);assert.deepEqual(receipt.failedTabs,[]);assert.deepEqual(receipt.remainingTabIds,['tab']);assert.deepEqual(driver.effects,['idle']);}finally{await browser.close();}
});
test('scoped cleanup cannot select a marked page, even with clear DOM inspection',()=>{
 const preview=browserCleanupPreview({tabs:[{...tab,inUse:true}],persistence:{healthy:true}},{kind:'conversation',conversationId:'task'},{inspections:new Map([['tab',{state:'clear'}]])});
 assert.equal(preview.eligible,0);assert.match(preview.rows[0].reason,/in use/);
});

test('tab_mark is exposed as a control operation, never a read-only observation',async()=>{
 const {describeHostOperation}=await import('../lib/operation-descriptors.mjs');
 const descriptor=await describeHostOperation({name:'relay_browser',arguments:{action:'tab_mark',tabId:'tab',inUse:true}});
 assert.equal(descriptor.effect,'control');assert.ok(BROWSER_TOOL.inputSchema.properties.action.enum.includes('tab_mark'));assert.equal(BROWSER_TOOL.inputSchema.properties.inUse.type,'boolean');
});
