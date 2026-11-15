import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexRuntime} from '../lib/codex.mjs';
for(const [info,status,expected] of [['contextWindowExceeded','failed','CONTEXT_OVERFLOW'],['rateLimitExceeded','failed','CODEX_TURN_FAILED'],[undefined,'failed','CODEX_TURN_FAILED'],['contextWindowExceeded','interrupted','ABORT_ERR']]){
 test(`terminal provider type ${info} / ${status} maps to ${expected}`,()=>{
  const state={turnId:'turn',messages:new Map()},failures=[];
  const runtime={threads:new Map([['thread',state]]),_emitRun(){},_finish(_state,error){failures.push(error);}};
  CodexRuntime.prototype._notification.call(runtime,'turn/completed',{threadId:'thread',turn:{id:'turn',status,items:[],error:{message:'Context window text is not itself a typed signal',...(info?{codexErrorInfo:info}:{})}}});
  assert.equal(failures.length,1);assert.equal(failures[0].code,expected);
 });
}
