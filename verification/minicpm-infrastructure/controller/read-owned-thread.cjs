'use strict';
// Run after the owned native run is terminal+settled, not during generation.
// Copies only the exact run-bound native thread to a new controller evidence file.
const fs=require('node:fs'),path=require('node:path');
const {sha,assertOwned,terminal,windowsPath}=require('./native-api.cjs');
function readOwnedThread({run,config,dataDir,out}){
  assertOwned(run,config);if(!terminal(run.status)||run.settled!==true)throw Error('Owned native run must be terminal and settled');
  const threadId=run.nodes?.agent?.threadId;
  if(!/^provider_[A-Za-z0-9_-]{1,100}$/.test(threadId||''))throw Error('Exact native provider thread ID missing');
  if(!path.isAbsolute(dataDir)||!path.isAbsolute(out))throw Error('Absolute data/evidence paths required');
  const source=path.join(dataDir,'provider-threads',threadId+'.json');
  if(windowsPath(out).startsWith(windowsPath(config.workspace)+path.win32.sep)||windowsPath(out)===windowsPath(config.workspace))throw Error('Controller evidence must be outside agent workspace');
  const before=fs.statSync(source);if(!before.isFile()||before.size>64*1024*1024)throw Error('Native thread exceeds bounded file contract');
  const bytes=fs.readFileSync(source),after=fs.statSync(source);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==after.size)throw Error('Native thread changed while reading');
  const thread=JSON.parse(bytes.toString('utf8'));
  if(thread.id!==threadId||thread.version!==1||thread.providerType!=='compatible'||thread.hostOnlyTools!==true||windowsPath(thread.cwd)!==windowsPath(config.workspace)||`${thread.providerId}::${thread.model}`!==config.model||!Array.isArray(thread.messages)||!Array.isArray(thread.transcript))throw Error('Native thread identity/format mismatch');
  const fd=fs.openSync(out,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const saved=fs.readFileSync(out);if(!saved.equals(bytes))throw Error('Evidence readback differs');
  return {schema:'blackice.minicpm.owned-provider-transcript.v1',runId:run.id,taskId:run.taskId,threadId,source,path:out,sha256:sha(saved),bytes:saved.length,sourceMtime:after.mtime.toISOString(),messageCount:thread.transcript.length,pendingToolCalls:thread.pendingToolCalls?.length||0,pendingToolResults:thread.pendingToolResults?.length||0};
}
module.exports={readOwnedThread};
if(require.main===module){const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2)options[args[i]]=args[i+1];try{const state=JSON.parse(fs.readFileSync(options['--state'],'utf8'));const result=readOwnedThread({run:state.run,config:state.config,dataDir:options['--data-dir'],out:options['--out']});process.stdout.write(JSON.stringify(result)+'\n');}catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}}
