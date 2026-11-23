// Offline, model-free stress of real BLACKICE tool and Directory boundaries.
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const candidate=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const control=process.env.BLACKICE_BENCH_CONTROL_ROOT||path.join(path.dirname(candidate),'BLACKICE-context-control-20261123');
const reportDir=process.env.BLACKICE_BENCH_REPORT_DIR||path.join(path.dirname(candidate),'BLACKICE-context-benchmark-results-20261123');
const readCount=Number(process.argv.find(arg=>arg.startsWith('--reads='))?.slice(8)||180);
if(!Number.isSafeInteger(readCount)||readCount<1||readCount>2000)throw Error('Choose 1–2000 read operations.');
const expectCapacity=process.argv.includes('--expect-capacity');
const expectControlCapacity=process.argv.includes('--expect-control-capacity');
const outputs=[];
for(const [variant,sourceRoot] of [['control',control],['candidate',candidate]]){
 const {HarnessEngine}=await import(pathToFileURL(path.join(sourceRoot,'lib','engine.mjs')).href);
 const temp=await mkdtemp(path.join(tmpdir(),'blackice-stress-'+variant+'-'));
 let engine,metrics={variant,readCount:0,readTextBytes:0,pageCount:0,negativeReads:0,startAt:new Date().toISOString()};
 try{
  const work=path.join(temp,'work');
  await mkdir(work);
  const log=path.join(work,'incident.log');
  const logLines=Array.from({length:500},(_,i)=>'trace '+i+' state='+((i*13)%17)+' classification=transient_observation '+('x'.repeat(35)));
  logLines.splice(185,0,'SENTINEL_2077');
  await writeFile(log,logLines.join('\n')+'\n');
  const target=path.join(work,'fix.mjs');
  await writeFile(target,'export const add=(a,b)=>a-b;\n');
  const testfile=path.join(work,'fix.test.mjs');
  await writeFile(testfile,"import test from 'node:test';import assert from 'node:assert/strict';import {add} from './fix.mjs';test('sums',()=>assert.equal(add(2,3),5));\n");
  class Runtime extends EventEmitter {
   status(){return {connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
   async runAgent(options){
    const call=async(name,args)=>{
     const answer=await options.onToolCall({name,arguments:args,callId:'stress-'+(++metrics.callSequence)});
     metrics.readTextBytes+=(answer.contentItems||[]).filter(x=>x.type==='inputText').reduce((n,x)=>n+Buffer.byteLength(x.text||''),0);
     return answer;
    };
    metrics.hasPagingTool=options.dynamicTools.some(x=>x.name==='relay_context_page');
    metrics.callSequence=0;const refs=[];
    for(let i=0;i<readCount;i++){
     const result=await call('relay_workspace',{action:'read',path:log});
     if(result.success!==true)throw Error('A planned read was not returned: '+String(result.code||'UNKNOWN')+' '+String(result.contentItems?.[0]?.text||'').slice(0,150));
     metrics.readCount++;
     const payload=result.contentItems[0].text;
     if(metrics.hasPagingTool){
       const row=JSON.parse(payload);
       if(row.externalContext===true&&row.reference){
        metrics.archivedReads=(metrics.archivedReads||0)+1;
        refs.push(row.reference);
        if(i===50||i===120||i===readCount-1){
         const found=await call('relay_context_page',{action:'search',reference:row.reference,needle:'SENTINEL_2077'});
         metrics.pageCount++;
         const offset=JSON.parse(found.contentItems[0].text).matches[0]?.offset;
         if(!Number.isInteger(offset))throw Error('Saved evidence was not searchable');
         const page=await call('relay_context_page',{action:'read',reference:row.reference,offset,maxBytes:512});
         metrics.pageCount++;
         if(!JSON.parse(page.contentItems[0].text).text.startsWith('SENTINEL_2077'))throw Error('Archived evidence could not be recovered exactly');
        }
       }else{
        if(!row.content?.includes('SENTINEL_2077'))throw Error('Retained original workspace observation lacks its evidence marker');
        metrics.inlineReads=(metrics.inlineReads||0)+1;
       }
     }else if(!payload.includes('SENTINEL_2077'))throw Error('Control did not receive full source result');
    }
    if(metrics.hasPagingTool&&readCount>256){
      const history=await call('relay_directory_action',{action:'read'});
      if(history.success!==true)throw Error('Ledger archive retrieval was rejected');
      const archive=JSON.parse(history.contentItems[0].text);
      const active=JSON.parse(history.contentItems.at(-1).text);
      if(!archive.externalContext||active.view!=='bounded-active-context')throw Error('Large Directory read did not provide an external reference and bounded active view');
      const search=await call('relay_context_page',{action:'search',reference:archive.reference,needle:'"id":"receipt-1"'});
      const first=JSON.parse(search.contentItems[0].text).matches[0]?.offset;
      if(!Number.isInteger(first))throw Error('Oldest saved Directory receipt was not searchable');
      const page=await call('relay_context_page',{action:'read',reference:archive.reference,offset:first,maxBytes:512});
      if(!JSON.parse(page.contentItems[0].text).text.startsWith('"id":"receipt-1"'))throw Error('Oldest saved receipt could not be recovered from the archive');
      metrics.ledgerArchiveRetrieved=true;
    }
    const denied=await call('relay_workspace',{action:'read',path:path.join(work,'missing.txt')});
    if(denied.success!==false)throw Error('Expected negative read to fail');metrics.negativeReads++;
    const dir=async(action,extra={})=>{
     const result=await call('relay_directory_action',{action,...extra});if(result.success!==true)throw Error('Directory action '+action+' was rejected: '+result.contentItems[0].text.slice(0,400));return result;
    };
    await dir('plan',{actions:[{id:'repair',objective:'Correct the arithmetic module',dependsOn:[]}]});
    await dir('focus',{id:'repair'});
    const write=await call('relay_workspace',{action:'write',path:target,text:'export const add=(a,b)=>a+b;\n'});
    if(write.success!==true)throw Error('Code write failed');
    const receipt=write.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
    if(!receipt)throw Error('Missing host receipt for code write');
    const check=await call('relay_workspace',{action:'run',command:'node --test fix.test.mjs'});
    if(check.success!==true)throw Error('Could not run source tests');
    const readCheck=check.contentItems[0].text;
    if(!readCheck.includes('"exitCode":0'))throw Error('Source tests did not pass');
    await dir('observe',{id:'repair',outcome:'objective-met',claim:'Code repaired and its test passed.',receipts:[receipt]});
    const firstFinal=await options.onBeforeFinal({output:'Fixed and tested.',signal:options.signal});
    if(firstFinal?.continue===true&&/ONE-TIME CODING VERIFICATION REVIEW/.test(firstFinal.prompt||'')){
      metrics.coverageReviewSeen=true;
      if(await options.onBeforeFinal({output:'The public test passed; no further checks are claimed by this scripted fixture.',signal:options.signal})!==undefined)
        throw Error('Directory requested another finalization after the one-time coverage handoff.');
    }else if(firstFinal!==undefined)throw Error('Directory refused final for a reason other than a verified one-time coding review.');
    metrics.references=refs;
    return {output:'Fixed and tested.'};
   }
  }
  const runtime=new Runtime();
  engine=await new HarnessEngine({runtime,dataDir:path.join(temp,'engine'),defaultCwd:work}).init();
  const graph={name:'Stress',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Fixer',model:'fixture',prompt:'Use tools to fix source'},{id:'o',type:'output'}],
   edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
  const task=engine.startRun({workflow:graph,input:{task:'Inspect incident traces, repair the module, and verify tests',directoryActions:'on'}});
  await engine.executions.get(task.id);
  const outcome=engine.getRun(task.id);
  metrics.status=outcome.status; metrics.error=outcome.error||null;
  const state=(await engine.actionDirectories.get(task.id,'Inspect incident traces')).read();
  metrics.receipts=state.receipts.length;
  if(metrics.hasPagingTool&&readCount>256){
    const disk=JSON.parse(await readFile(path.join(temp,'engine','task-action-directory',task.id+'.json'),'utf8'));
    if(disk.receipts?.length!==metrics.receipts||disk.receipts[0]?.id!=='receipt-1')throw Error('Saved host Directory ledger lost historical receipts');
    metrics.durableLedgerVerified=true;
  }
  metrics.codeFinal=(await readFile(target,'utf8')).trim();
  if(metrics.status!=='completed'||!metrics.codeFinal.includes('a+b'))throw Error(metrics.error||'Run did not complete');
  if(variant==='candidate'){
   const root=path.join(temp,'engine','task-external-context',task.id);
   const archiveEntries=await readdir(root);metrics.archiveFiles=archiveEntries.length;
   const archiveStats=await Promise.all(archiveEntries.map(name=>stat(path.join(root,name))));
   metrics.archiveBytes=archiveStats.reduce((sum,row)=>sum+row.size,0);
   const {TaskExternalContextStore}=await import(pathToFileURL(path.join(sourceRoot,'lib','task-external-context.mjs')).href);
   const reopened=new TaskExternalContextStore({dataDir:path.join(temp,'engine'),taskId:task.id});
   const last=metrics.references.at(-1);
   const searched=await reopened.search({reference:last,needle:'SENTINEL_2077'});
   if(!searched.matches.length)throw Error('Post-run archive recovery failed');
   metrics.reopenedSuccess=true;
  }
  metrics.pass=true;
 }catch(error){metrics.pass=false;metrics.error=String(error?.stack||error).slice(0,1500);}
 finally{
  metrics.finishedAt=new Date().toISOString();
  await engine?.close().catch(()=>{});
  outputs.push(metrics);
  await rm(temp,{recursive:true,force:true}).catch(()=>{});
 }
}
await mkdir(reportDir,{recursive:true});
const f=path.join(reportDir,readCount===180&&!expectCapacity&&!expectControlCapacity?'offline-longhorizon-stress.json':`offline-stress-${readCount}${expectCapacity?'-capacity':expectControlCapacity?'-paged':''}.json`);
await writeFile(f,JSON.stringify({sourceHashes:{control:'3fc873c8394fb8381456c305cd91068ce9b98eac',candidate:'b49913517b409338cfe93ce0d450a710c34949d3'},results:outputs},null,2));
console.log(JSON.stringify({report:f,results:outputs.map(o=>({variant:o.variant,pass:o.pass,reads:o.readCount,calls:o.callSequence,modelFacingBytes:o.readTextBytes,receipts:o.receipts,archiveFiles:o.archiveFiles,error:o.error}))}));
const valid=expectControlCapacity?(outputs.find(x=>x.variant==='control')?.pass===false&&String(outputs.find(x=>x.variant==='control')?.error||'').includes('DIRECTORY_CAPACITY')&&outputs.find(x=>x.variant==='candidate')?.pass===true&&outputs.find(x=>x.variant==='candidate')?.ledgerArchiveRetrieved===true&&outputs.find(x=>x.variant==='candidate')?.durableLedgerVerified===true):expectCapacity?outputs.every(x=>!x.pass&&String(x.error||'').includes('DIRECTORY_CAPACITY')):outputs.every(x=>x.pass);
console.log(JSON.stringify({expectCapacity,requestedReads:readCount,valid}));
process.exitCode=valid?0:1;
