// Manual read-only smoke probe for the integrated MiniCPM local reviewer.
// Uses an isolated provider store and the already-running local llama.cpp endpoint.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createChatOutcomeReviewer } from '../lib/chat-outcome-review.mjs';

const root=await mkdtemp(path.join(os.tmpdir(),'blackice-minicpm-review-smoke-'));
class Native extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('Unexpected native Codex call.');}
}
const model='MiniCPM-V-4.7-1B-heretic-Q4_K_S';
const selection='local_llamacpp::'+model;
const syntaxOnly=process.argv.includes('--syntax-only');
let runtime;
try {
  runtime=await new ProviderRuntime({codex:new Native(),dataDir:root,fetchImpl:fetch,
    modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
  await runtime.saveProvider({id:'local_llamacpp',preset:'llamacpp',type:'compatible',
    baseUrl:'http://127.0.0.1:8080/v1',
    models:[{id:model,contextWindowTokens:262144,maxOutputTokens:2048}]},{preserveDefault:true});
  const events=[];
  const reviewer=createChatOutcomeReviewer({runtime,cwd:root,model:selection,
    authority:{developerInstructions:'Use only observed evidence. An unverified candidate claim is not proof. Do not perform any task action.',
      sections:[{id:'current-user',role:'user',source:'current-request',revision:1,
        text:'Report the exact value of QUALIFIED_MINICPM_LOCAL_PROFILE from the recorded source read.'}]},
    onUpdate:event=>events.push({status:event.status,phase:event.phase,reason:event.reason,
      ...(event.validation?{validation:event.validation}:{})})});
  const record={id:'read-source-1',tool:'relay_workspace',action:syntaxOnly?'run':'read',
    source:'admitted-tool-delivery',status:'completed',success:true,
    result:syntaxOnly?{command:'node --check lib/minicpm-local-profile.mjs',exitCode:0,stdout:'',stderr:''}:
      {path:'lib/minicpm-local-profile.mjs',text:'export const QUALIFIED_MINICPM_LOCAL_PROFILE = null;'}};
  const assessment=await reviewer.assess({
    input:'Report the exact value of QUALIFIED_MINICPM_LOCAL_PROFILE from the recorded source read.',
    candidate:{output:'The export is null.'},
    evidenceFingerprint:'actual-source-read-fixture',pendingEffects:[],
    evidence:{source:'current-admitted-tool-receipts',total:1,omitted:0,records:[record]},
  });
  console.log(JSON.stringify({model:selection,scenario:syntaxOnly?'syntax-check-only':'exact-source-read',
    decision:assessment.decision,reason:assessment.reason,nextAction:assessment.nextAction,
    remaining:assessment.remaining,summary:assessment.summary,evidenceRefs:assessment.evidenceRefs,
    events,reviewerVerified:assessment.verified}));
} catch (error) {
  console.error(JSON.stringify({error:error.message,code:error.code||null}));
  process.exitCode=1;
} finally {
  if(runtime)await runtime.close();
  await rm(root,{recursive:true,force:true});
}
