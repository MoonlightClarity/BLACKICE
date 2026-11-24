import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {inFlightEffectSignature} from '../lib/goal-recovery-policy.mjs';

const hashOld=(tool,args)=>{
 const canonical=Object.fromEntries(Object.entries(args).sort(([a],[b])=>a.localeCompare(b)));
 return createHash('sha256').update(JSON.stringify([tool,canonical])).digest('hex');
};

test('a permitted retry of an old value-only fill consumes the exact saved permit before dispatch',async()=>{
 const original={action:'fill',browser:'relay',tabId:'owned-page',ref:'supported-field',value:'Supported answer'};
 const canonical={action:'fill',browser:'relay',tabId:'owned-page',ref:'supported-field',text:'Supported answer'};
 const legacySignature=hashOld('relay_browser',original);
 const newSignature=inFlightEffectSignature({name:'relay_browser',arguments:canonical});
 assert.notEqual(legacySignature,newSignature,'The test must cover a true historical spelling alias.');
 const pending={id:'old-receipt',kind:'uncertain_external_effect',signature:legacySignature,
   at:'2026-11-24T09:00:00.000Z',code:'BROWSER_ACTION_FAILED',
   resolution:{outcome:'unknown',deliberateRetry:true,runId:'retry-turn',retryUsedAt:null}};
 const writes=[],conversations={states:{root:{goalUnresolvedEffects:[pending]}},
   async changeState(root,patch){
     writes.push(structuredClone(patch));
     Object.assign(this.states[root],structuredClone(patch));
   }};
 const goals=new ConversationGoals({engine:{runs:new Map()},conversations,autoStart:false});
 goals.recoveryRunCurrent=()=>true;
 const run={id:'retry-turn',taskId:'root',goal:{id:'goal'},goalEvidence:[]};
 const dispatched=[];
 const handler=async args=>{dispatched.push(structuredClone(args));return {success:true,contentItems:[]};};
 const invoke=goals.wrapTools(run,'agent',handler);
 const call={name:'relay_browser',arguments:canonical};
 const response=await invoke(call);
 assert.equal(response.success,true);
 assert.equal(dispatched.length,1);
 assert.equal(writes.length,1,'An explicit deliberate retry permit must be consumed in the durable ledger.');
 const stored=conversations.states.root.goalUnresolvedEffects[0];
 assert.ok(stored.resolution.retryUsedAt,'Durable permit must be marked used before action.');
 assert.equal(stored.retryAttempts.length,1);
 const duplicate=await invoke(call);
 assert.equal(duplicate.success,false);
 assert.equal(duplicate.actionDispatched,false);
 assert.equal(dispatched.length,1,'A lost result cannot replay this write twice.');
});
