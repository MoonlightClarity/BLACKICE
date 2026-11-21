'use strict';
// Shared value contract for pure policy evidence and prompt composition.
const crypto=require('node:crypto');
const SCHEMA='blackice.minicpm.policy-qualification.v1';
const CAPTURE_SCHEMA='blackice.minicpm.provider-capture.v1';
const SOURCE_FILES=Object.freeze(['lib/engine.mjs','lib/providers.mjs','lib/instruction-audit.mjs','lib/benchmark-workspace.mjs','lib/task-action-directory.mjs','lib/instruction-store.mjs','lib/identity.mjs','public/mission-model.mjs','lib/developer-instruction-budget.mjs','lib/directory-done-checklist.mjs','lib/chat-intent-inference.mjs']);
const SKILLS=Object.freeze({'library-what-makes-done':'WHAT MAKES DONE','library-anti-completion-bias':'ANTI-COMPLETION BIAS'});
const TOOLS=Object.freeze(['relay_directory_action','relay_workspace']);
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.trim().length>0;
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const positive=v=>integer(v)&&v>0;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v?Date.parse(v):null;
function canonical(v){
 if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);
 if(typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(record(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 throw TypeError('Finite JSON values required.');
}
const digest=v=>sha(canonical(v));
const without=(v,keys)=>Object.fromEntries(Object.entries(v||{}).filter(([k])=>!keys.includes(k)));
function issues(){
 const missing=[],conflicts=[];
 const add=(field,code,observed,expected,conflict=false)=>{
  (conflict?conflicts:missing).push({field,code,observed:observed===undefined?null:observed,...(expected===undefined?{}:{expected})});return false;
 };
 const equal=(field,a,b)=>{
  if(a===undefined||b===undefined)return add(field,'missing-binding',a,b);
  try{return canonical(a)===canonical(b)||add(field,'different',a,b,true);}
  catch{return add(field,'invalid-json-binding',null);}
 };
 return {missing,conflicts,add,equal};
}
module.exports={SCHEMA,CAPTURE_SCHEMA,SOURCE_FILES,SKILLS,TOOLS,record,text,integer,positive,hash,sha,time,canonical,digest,without,issues};
