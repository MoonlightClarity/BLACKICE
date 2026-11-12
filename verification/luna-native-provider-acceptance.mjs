#!/usr/bin/env node
// Optional real Luna integration smoke; uses provider tokens, no writes or browser actions.
// Repro: ELECTRON_RUN_AS_NODE=1 BLACKICE.exe verification/luna-native-provider-acceptance.mjs
// Set BLACKICE_WRITE_LIVE_RECEIPT=1 to write a bounded public-safe receipt.
import {CodexRuntime} from '../lib/codex.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {runPreparedDirectoryAgent} from '../lib/shadowdancer-engine.mjs';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
const command=process.env.BLACKICE_CODEX_EXE||'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const root=await mkdtemp(path.join(os.tmpdir(),'luna-provider-acceptance-'));
const cwd=path.join(root,'work'),dataDir=path.join(root,'data');
await Promise.all([mkdir(cwd),mkdir(dataDir)]);
const codex=new CodexRuntime({command,cwd,isolatedHistory:false,nativeModelMetadata:false,runTimeoutMs:80000});
const provider=await new ProviderRuntime({codex,dataDir}).init();
const input='/directory Return the result of this synthetic arithmetic check: 2 plus 2. No tools or external sources are needed.';
const events=[],steps=[],started=Date.now();
let receipt={version:1,model:'gpt-6-luna',startedAt:new Date().toISOString(),success:false,isolatedHistory:false};
try{
 await codex.start();
 receipt.supportBefore=provider.supportsHostOnlyToolDispatch({model:'gpt-6-luna',cwd});
 const out=await runPreparedDirectoryAgent({runtime:provider,
  options:{cwd,prompt:input,developerInstructions:'This is a bounded arithmetic acceptance test. Preserve the host-only tool boundary.',dynamicTools:[],sandbox:'read-only',onEvent:event=>{
    if(event.type==='capabilities')events.push({profile:event.profile,native:event.native,sandbox:event.sandbox,networkAccess:event.networkAccess,attachedTools:event.attachedTools});
  }},
  input,model:'gpt-6-luna',conversationId:'luna-provider-smoke',runId:'luna-provider-smoke-'+Date.now(),
  agentInstructions:'Return only the arithmetic finding.',getAcceptedDirections:()=>({currentUserRequest:{text:input},priorUserRequests:[],acceptedDirections:[]}),
  onProgress:row=>steps.push({phase:row.phase||null,status:row.status||null}),
 });
 const verifiedScopes=[...codex.hostOnlyVerifiedModels.keys()].map(key=>({model:key.split('\u0000')[0],cwd:key.split('\u0000').slice(1).join('\u0000')}));
 receipt={...receipt,success:Boolean(out.output&&events.length>=3),elapsedMs:Date.now()-started,
   finalAnswer:String(out.output||'').slice(0,250),phaseCount:events.length,events,phases:steps,
   verifiedAfter:verifiedScopes.length>0&&verifiedScopes.every(scope=>provider.supportsHostOnlyToolDispatch(scope)),
   verificationDiagnostics:{connected:codex.status().connected,authenticated:codex.status().authenticated,
     verifiedScopeCount:verifiedScopes.length,selectedAvailable:provider.resolveModel('gpt-6-luna').available,
     verifiedScopePaths:verifiedScopes.map(scope=>path.relative(root,scope.cwd)||'.')}};
 if(receipt.supportBefore!==false||!receipt.verifiedAfter||!receipt.success||events.some(x=>x.profile!=='host-only-task-tools'||x.native!==true||x.networkAccess!==false))process.exitCode=2;
}catch(e){receipt={...receipt,elapsedMs:Date.now()-started,error:{code:e?.code||null,message:String(e?.message||e).slice(0,750)}};process.exitCode=2;}
finally{await provider.close().catch(()=>{});await codex.close().catch(()=>{});}
console.log('LUNA_NATIVE_PROVIDER_ACCEPTANCE='+JSON.stringify(receipt));
if(process.env.BLACKICE_WRITE_LIVE_RECEIPT==='1')await writeFile(new URL('./luna-native-provider-acceptance.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
await new Promise(resolve=>setTimeout(resolve,350));
try{await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:150})}catch(e){console.log('LIVE_ACCEPTANCE_CLEANUP_WARNING='+e.code);}
if(!receipt.success||receipt.verifiedAfter!==true||receipt.supportBefore!==false||receipt.error)process.exit(2);
