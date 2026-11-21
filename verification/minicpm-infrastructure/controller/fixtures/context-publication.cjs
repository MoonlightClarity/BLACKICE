'use strict';
// Synthetic source-shaped evidence for tests only. This never qualifies a live model.
const crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function attachPublication(input,provided={}){
 const value=structuredClone(input),sr=value.startupReceipt,p=value.propsResponse;
 if(!sr||!p?.json?.blackice_runtime)return {input:value,bytes:{}};
 const old=p.json.blackice_runtime;
 const raw=Object.fromEntries(Object.entries(sr).filter(([key])=>!['observedAt','modelSha256','binarySha256'].includes(key)));
 raw.startupId=raw.startupId??raw.id;
 raw.traceFile=raw.traceFile??'C:\\fixture-trace\\'+raw.pid+'-fixture-process.ctx-'+raw.id+'.jsonl';
 value.startupReceipt.startupId=raw.startupId;value.startupReceipt.traceFile=raw.traceFile;
 p.json.blackice_runtime={...structuredClone(raw),...structuredClone(old)};
 p.json.blackice_runtime_state=p.json.blackice_runtime_state??'awake';
 p.startedAt=p.startedAt??p.at;
 const startup=provided.startupArtifactBytes?Buffer.from(provided.startupArtifactBytes):Buffer.from(JSON.stringify(raw,null,2)+'\n');
 const startupSource=raw.traceFile.replace(/\.jsonl$/,'.startup.json'),startupRef={path:startupSource,bytes:startup.length,sha256:sha(startup)};
 let prefix;
 if(provided.contextPrefixBytes)prefix=Buffer.from(provided.contextPrefixBytes);
 else{
  const processId=raw.traceFile.split('\\').at(-1).split('.ctx-')[0].slice(String(raw.pid).length+1);
  const header={schema:'blackice.minicpm.live-trace.v1',at:raw.at,pid:raw.pid,processId,processStartedAt:raw.processStartedAt};
  const rows=[
   {...header,event:'context_start',processSequence:2,fileSequence:1,data:{startupId:raw.id}},
   {...header,event:'runtime_startup',processSequence:4,fileSequence:2,data:{startupId:raw.id,receipt:startupRef,runtime:raw}},
  ];
  prefix=Buffer.from(rows.map(e=>JSON.stringify(e)).join('\n')+'\n');
 }
 const at=value.now,fileIdentity={dev:'1',ino:'17',birthtimeNs:'1795250000000000000'};
 value.currentPublication={
  schema:'blackice.minicpm.context-publication-input.v1',
  contextPrefix:{path:'C:\\fixture-observation\\context-prefix.jsonl',bytes:prefix.length,sha256:sha(prefix)},
  startupArtifact:{path:'C:\\fixture-observation\\startup.native.json',bytes:startup.length,sha256:sha(startup)},
  contextSource:{path:raw.traceFile,highWaterMark:prefix.length,startedAt:at,finishedAt:at,before:{bytes:prefix.length,identity:fileIdentity},after:{bytes:prefix.length,identity:{...fileIdentity}},rereadSha256:sha(prefix)},
  propsAfterResponse:{...structuredClone(p),startedAt:at,at},
 };
 return {input:value,bytes:{contextPrefixBytes:prefix,startupArtifactBytes:startup}};
}
module.exports={attachPublication};
