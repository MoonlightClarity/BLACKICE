import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {semanticContrastCases} from '../tests/semantic-contrast-fixtures.mjs';
import {createOrderPair,validateLocalUrl} from './gguf-counterfactual-trace.mjs';

function tokenLogp(top,letter){
 const exact=top.find(x=>x.token===letter&&Number.isFinite(x.logprob));
 if(exact)return exact.logprob;
 const candidates=top.filter(x=>x.token?.trim()===letter&&Number.isFinite(x.logprob));
 return candidates.length?Math.max(...candidates.map(x=>x.logprob)):null;
}
export function extractReasoningTransition(raw){
 const records=raw?.completion_probabilities;
 if(!Array.isArray(records)||!records.length)return {status:'missing-token-probabilities'};
 const full=records.map(x=>x.token||'').join('');
 const close=full.lastIndexOf('</think>');
 if(close<0)return {status:'missing-reasoning-finalizer',tokens:records.length};
 const after=full.slice(close+8);
 const match=/^\s*([AB])(?=$|[\s).:])/u.exec(after);
 if(!match)return {status:'no-final-answer-choice',tokens:records.length,reasoningChars:close};
 const targetOffset=close+8+match[0].lastIndexOf(match[1]);
 let pointer=0,index=-1;
 for(let i=0;i<records.length;i++){
  const text=records[i].token||'';
  if(pointer<=targetOffset&&targetOffset<pointer+text.length){index=i;break}
  pointer+=text.length;
 }
 if(index<0)return {status:'unmapped-answer-token'};
 const top=records[index].top_logprobs||[];
 const a=tokenLogp(top,'A'),b=tokenLogp(top,'B');
 return {status:'answer-transition-located',tokens:records.length,reasoningChars:close,
  answerTokenIndex:index,answerChoice:match[1],logProbA:a,logProbB:b,
  logOddsAOverB:Number.isFinite(a)&&Number.isFinite(b)?a-b:null,
  answerTokenLogp:records[index].logprob,topCandidates:top.length,
  trailingExplanationChars:after.slice(match[0].length).trim().length
 };
}
async function post(endpoint,payload,timeout=45000){
 const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)});
 const body=await r.json();if(!r.ok)throw Error('HTTP '+r.status+': '+String(body.error?.message||'').slice(0,200));return body;
}
export async function traceReasoningExamples({url,cases=semanticContrastCases,ids,seed=144,onSample=()=>{}}={}){
 const endpoint=validateLocalUrl(url),targets=cases.filter(x=>ids.includes(x.id));
 const results=[];
 for(const c of targets){
  for(const sample of createOrderPair(c)){
   const messages=[{role:'system',content:'Read the source evidence, then answer using the source only. Do not agree with a question just because it is asked. Answer A or B with one brief reason.'},{role:'user',content:sample.body}];
   const template=await post(endpoint+'/apply-template',{messages,chat_template_kwargs:{enable_thinking:true}});
   if(!template.prompt?.endsWith('<think>\n'))throw Error('Model chat template no longer starts in the expected reasoning section.');
   const t0=Date.now();
   const raw=await post(endpoint+'/completion',{prompt:template.prompt,n_predict:500,n_probs:100,temperature:0,top_k:0,top_p:1,min_p:0,cache_prompt:false,seed,stream:false},45000);
   const transition=extractReasoningTransition(raw);
   const entry={id:sample.id,order:sample.order,expected:sample.expected,
    sourceSha256:createHash('sha256').update(c.source).digest('hex'),
    elapsedMs:Date.now()-t0,stopType:raw.stop_type||null,
    transition,correct:transition.answerChoice===sample.expected,
    traceScope:'reasoning-to-answer-token-no-layer-activations'};
   results.push(entry);await onSample(entry,results);
  }
 }
 return results;
}
async function main(){
 const args=process.argv.slice(2),opts={url:'http://127.0.0.1:18086',out:'gguf-reasoning-transition.json',ids:'link-present,only-18-improved,line-management,explicit-company-b-platform'};
 for(let i=0;i<args.length;i++){
  const flag=args[i],value=args[i+1];if(!['--url','--out','--ids'].includes(flag)||!value)throw Error('Usage: --url URL --out FILE --ids id1,id2');
  opts[flag.slice(2)]=value;i++;
 }
 const report={version:1,started:new Date().toISOString(),model:'existing-local-gguf',samples:[],semanticVerification:'not-established',scope:'answer-token-transition'};
 const file=path.resolve(opts.out),save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
 save();
 try{
  await traceReasoningExamples({url:opts.url,ids:opts.ids.split(','),onSample:async row=>{report.samples.push(row);save();console.log(JSON.stringify({id:row.id,order:row.order,expected:row.expected,choice:row.transition.answerChoice,logOdds:row.transition.logOddsAOverB,correct:row.correct,status:row.transition.status,ms:row.elapsedMs}));}});
  report.finished=new Date().toISOString();save();
 }catch(e){report.error=e.message;save();throw e}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1});
