import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TaskExternalContextStore,eligibleExternalContextCall} from '../lib/task-external-context.mjs';

async function fixture(t,opts={}){
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-shell-context-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 return new TaskExternalContextStore({
  dataDir,taskId:'shell-task',thresholdBytes:500,
  visibleResultBudgetBytes:1500,forcePageBytes:6400,...opts,
 });
}
const call={name:'relay_workspace',arguments:{action:'run',command:'node --test'}};
const body=overrides=>({
 cwd:'C:\\example',command:'node --test',exitCode:0,signal:null,
 stdout:'NODE_START\n'+'A'.repeat(3200)+'\nNODE_DONE_2030',
 stderr:'',truncated:false,timedOut:false,durationMs:25,shell:'powershell',...overrides,
});
const output=data=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(data)}]});
const parse=response=>JSON.parse(response.contentItems[0].text);

test('archives large successful command stdout while retaining exact exit/status metadata and original bytes',async t=>{
 const store=await fixture(t);
 const original=output(body());
 const result=await store.archiveResult(call,original);
 const view=parse(result);
 assert.equal(view.externalContext,true);
 assert.equal(view.exitCode,0);
 assert.equal(view.signal,null);
 assert.equal(view.timedOut,false);
 assert.equal(view.truncated,false);
 assert.equal(view.command,'node --test');
 assert.equal(view.cwd,'C:\\example');
 assert.equal(view.shell,'powershell');
 assert.equal(view.outputIsExcerpt,true);
 assert.match(view.stdout,/ARCHIVED STDOUT EXCERPT/);
 assert.match(view.stdout,/NODE_START/);
 assert.match(view.stdout,/NODE_DONE_2030/);
 assert(!view.stdout.includes('A'.repeat(900)));
 assert.equal(view.originalStdoutBytes,Buffer.byteLength(body().stdout));
 assert.equal((await store.read({reference:view.reference,maxBytes:8192})).text,original.contentItems[0].text);
 assert.equal(original.contentItems[0].text,JSON.stringify(body()),'The host result is unchanged.');
});

test('nonzero exit, truncated shell capture, signal and diagnostic stderr remain authoritative',async t=>{
 const store=await fixture(t);
 const shell=body({stdout:'A'.repeat(4100),stderr:'ERR_START\n'+'x'.repeat(1500)+'\nERR_FINAL',exitCode:1,signal:'SIGTERM',truncated:true,timedOut:true});
 const view=parse(await store.archiveResult(call,output(shell)));
 assert.equal(view.exitCode,1);
 assert.equal(view.truncated,true);
 assert.equal(view.archiveCaptureTruncated,true);
 assert.equal(view.signal,'SIGTERM');
 assert.equal(view.timedOut,true);
 assert.match(view.stderr,/ERR_START/);
 assert.match(view.stderr,/ERR_FINAL/);
 assert.match(view.nextAction,/already omitted bytes/);
 const exact=await store.read({reference:view.reference,maxBytes:8192});
 assert.deepEqual(JSON.parse(exact.text),shell);
});

test('adaptive budget retains first shell result inline but archives subsequent output, then de-duplicates it',async t=>{
 const store=await fixture(t,{visibleResultBudgetBytes:10000,forcePageBytes:6400});
 const data=body({stdout:'Q'.repeat(2600)});
 const first=await store.archiveResult(call,output(data));
 const second=await store.archiveResult(call,output(data));
 const third=await store.archiveResult(call,output(data));
 assert(!parse(first).externalContext);
 assert(!parse(second).externalContext);
 assert(!parse(third).externalContext);
 const fourth=await store.archiveResult(call,output(data));
 assert(parse(fourth).externalContext);
 const again=await store.archiveResult(call,output(data));
 assert.equal(parse(again).reference,parse(fourth).reference);
});

test('unknown command-result shape is never represented as a restorable shell outcome',async t=>{
 const store=await fixture(t);
 const malformed=output({exitCode:0,stdout:'X'.repeat(3500)});
 const returned=await store.archiveResult(call,malformed);
 assert.strictEqual(returned,malformed);
 assert(store.exposedBytes>3000);
});

test('a failed archive leaves entire original command result and exit code intact',async t=>{
 const store=await fixture(t);
 const original=output(body());
 store.save=async()=>{throw Error('storage unavailable');};
 const result=await store.archiveResult(call,original);
 assert.strictEqual(result,original);
 assert.equal(store.exposedBytes,Buffer.byteLength(original.contentItems[0].text));
});

test('only the host-owned workspace run tool is permitted for shell-output archival',()=>{
 assert.equal(eligibleExternalContextCall(call),true);
 assert.equal(eligibleExternalContextCall({...call,namespace:'foreign'}),false);
 assert.equal(eligibleExternalContextCall({name:'relay_browser',arguments:{action:'run'}}),false);
 assert.equal(eligibleExternalContextCall({name:'relay_workspace',arguments:{action:'write'}}),false);
});
