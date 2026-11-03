import { createReadStream, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { compactRunEvent, RUN_EVENT_LIMITS } from './run-event-retention.mjs';
import { renameWithRetry } from './coalescing-persistence.mjs';

const changed=()=>Object.assign(new Error('Source runs.json changed during streaming migration. The original archive and source were preserved.'),{code:'RUN_MIGRATION_SOURCE_CHANGED'});
const invalid=message=>Object.assign(new Error(message),{code:'RUN_MIGRATION_INVALID'});
const signature=value=>[value.size,value.mtimeMs,value.ctimeMs,value.ino].join(':');
const whitespace=byte=>byte===32||byte===9||byte===13||byte===10;
const durable=event=>{
  const data=event?.data;
  return ['message','steer'].includes(data?.type)
    || data?.type==='item'&&data.item?.type==='agentMessage';
};

/**
 * Stream a large JSON array while converting the nested run.events arrays into
 * bounded event indexes. All other run fields are copied as exact JSON bytes.
 * The caller must first create a verified content-addressed original archive.
 */
export async function streamCompactRunHistory(source, write, { highWaterMark=256*1024 }={}) {
  let depth=0,inString=false,escaped=false,topKey=null,readingKey=false,keyBytes=[];
  let expectKey=false, colonPending=false, inEvents=false, captureStart=-1;
  let eventParts=[],events=[],eventSizes=[],eventBytes=0, eventCount=0, omittedEvents=0, omittedBytes=0;
  let passStart=0, totalRuns=0, eventCollections=0, originalBytes=0, projectedBytes=0;
  let rootClosed=false;
  const flush=async portion=>{if(portion?.length)await write(portion)};
  const append=event=>{
    const projected=compactRunEvent(event), length=Buffer.byteLength(JSON.stringify(projected),'utf8');
    events.push(projected); eventSizes.push(length);eventBytes+=length;
    eventCount++;
    // Protect current messages. Only auxiliary events may be elided from the
    // bounded live timeline, and the original is already immutable on disk.
    while(events.length>RUN_EVENT_LIMITS.maxEvents || eventBytes>RUN_EVENT_LIMITS.perRunBytes){
      const index=events.findIndex(x=>!durable(x));
      if(index<0)break;
      omittedEvents++;
      omittedBytes+=eventSizes[index];
      eventBytes-=eventSizes[index];
      events.splice(index,1);eventSizes.splice(index,1);
    }
  };
  for await (const chunk of createReadStream(source,{highWaterMark})){
    let lastNonEvent=0;
    for(let i=0;i<chunk.length;i++){
      const b=chunk[i];
      if(inEvents&&captureStart>=0&&eventParts.length===0&&captureStart>i)throw invalid('Unbalanced event boundary.');
      if(inString){
        if(escaped)escaped=false;
        else if(b===92)escaped=true;
        else if(b===34){
          inString=false;
          if(readingKey){topKey=Buffer.from(keyBytes).toString('utf8');readingKey=false;keyBytes=[];expectKey=false;colonPending=true;}
        }else if(readingKey&&keyBytes.length<256)keyBytes.push(b);
        continue;
      }
      if(b===34){
        if(!inEvents&&depth===2&&expectKey){readingKey=true;keyBytes=[];}
        inString=true;continue;
      }
      if(inEvents){
        if(b===123&&depth===3){
          captureStart=i;eventParts=[];
        }
        if(b===125&&depth===4){
          if(captureStart<0)throw invalid('An event object closed without an opening.');
          eventParts.push(chunk.subarray(captureStart,i+1));
          const raw=Buffer.concat(eventParts).toString('utf8');
          let parsed;
          try{parsed=JSON.parse(raw)}catch{throw invalid('Malformed event object during immutable history conversion.')}
          append(parsed);
          captureStart=-1;eventParts=[];
        }
        if(b===93&&depth===3){
          if(captureStart>=0)throw invalid('Event array terminated before its current object.');
          const replacement=Buffer.from(JSON.stringify(events),'utf8');
          await flush(replacement);
          projectedBytes+=replacement.length;
          inEvents=false;eventCollections++;
          events=[];eventSizes=[];eventBytes=0;
          lastNonEvent=i+1;
        }
        if(b===123||b===91)depth++;
        else if(b===125||b===93)depth--;
        if(depth<0)throw invalid('Invalid nested event depth.');
        continue;
      }
      if(colonPending&&!whitespace(b)&&b!==58&&depth===2)throw invalid('Expected property colon.');
      if(b===58&&colonPending&&depth===2){colonPending=false;continue;}
      if(b===91&&depth===2&&topKey==='events'&&!colonPending){
        await flush(chunk.subarray(lastNonEvent,i));
        originalBytes+=i-lastNonEvent;
        inEvents=true;captureStart=-1;eventParts=[];events=[];eventSizes=[];eventBytes=0;
        lastNonEvent=i+1;
        depth++;continue;
      }
      if(b===123||b===91){
        if(b===123&&depth===1){totalRuns++;expectKey=true;topKey=null;}
        depth++;
      }else if(b===125||b===93){
        if(b===125&&depth===2){expectKey=false;topKey=null;}
        depth--;
        if(depth<0)throw invalid('Unexpected closing delimiter.');
        if(depth===0){if(b!==93)throw invalid('Root JSON must be an array.');rootClosed=true;}
      }else if(b===44&&depth===2){expectKey=true;topKey=null;}
      else if(b===44&&depth===1){topKey=null;}
    }
    if(inEvents){
      if(captureStart>=0){
        eventParts.push(chunk.subarray(captureStart));
        captureStart=0;
      }
    }else await flush(chunk.subarray(lastNonEvent));
  }
  if(depth!==0||inString||inEvents||!rootClosed||totalRuns===0)throw invalid('Incomplete or empty run-history JSON array.');
  return {runs:totalRuns,eventCollections,eventsSeen:eventCount,eventsOmitted:omittedEvents,omittedEventBytes:omittedBytes,projectedBytes};
}

/** Replace only after original archive is validated, source identity is stable,
 * and a complete compact JSON array has been produced and synced to disk. */
export async function compactOversizedRunsOnDisk(dataDir,{archive,thresholdBytes=32*1024*1024,io=fs,highWaterMark}={}){
  const original=path.join(dataDir,'runs.json');
  const old=await io.stat(original);
  if(old.size<=thresholdBytes)return null;
  if(!archive||archive.bytes!==old.size||!archive.sha256||!archive.relativePath)
    throw invalid('Migration requires a verified immutable original history archive.');
  const preserved=await io.stat(path.join(dataDir,archive.relativePath));
  if(!preserved.isFile()||preserved.size!==old.size)throw invalid('Original full history archive is unavailable.');
  const temporary=original+'.compact-'+randomUUID()+'.tmp';
  let result;
  try{
    const handle=await io.open(temporary,'wx');
    try{
      const write=async data=>handle.writeFile(data);
      result=await streamCompactRunHistory(original,write,{highWaterMark});
      await handle.sync();
    }finally{await handle.close();}
    const current=await io.stat(original);
    if(signature(current)!==signature(old))throw changed();
    const replacement=await io.stat(temporary);
    if(!replacement.isFile())throw invalid('Compaction did not produce a regular replacement file.');
    if(replacement.size>=old.size)return {...result,skipped:true,reason:'no-savings',archive,originalBytes:old.size,compactedBytes:old.size};
    // Validate the entire reduced file before any replacement. Keep the
    // original source and immutable archive untouched on malformed input.
    if(replacement.size>128*1024*1024)throw invalid('Projected run history exceeds the safe single-load budget.');
    let parsed;
    try{parsed=JSON.parse(await io.readFile(temporary,'utf8'));}
    catch{throw invalid('The compacted run-history file was not valid JSON. Original history was preserved.');}
    if(!Array.isArray(parsed)||parsed.length!==result.runs||parsed.some(run=>!run||typeof run.id!=='string'||!Array.isArray(run.events)))
      throw invalid('Compacted run-history identities do not match the streamed source.');
    // Source might have changed while validation ran. Recheck before an atomic
    // Windows-compatible replacement.
    if(signature(await io.stat(original))!==signature(old))throw changed();
    await renameWithRetry(temporary,original,{io});
    return {...result,archive,originalBytes:old.size,compactedBytes:replacement.size};
  }finally{await io.rm(temporary,{force:true}).catch(()=>{});}
}

