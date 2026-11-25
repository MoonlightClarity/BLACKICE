import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {semanticContrastCases} from '../tests/semantic-contrast-fixtures.mjs';

export function validateLocalUrl(url){
 const u=new URL(url);
 if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw Error('Tracing is restricted to a local loopback server root.');
 return u.origin;
}
export function createOrderPair(c){
 if(!c||typeof c.id!=='string'||typeof c.source!=='string'||typeof c.question!=='string'||!['A','B'].includes(c.answer))throw Error('Invalid contrast fixture');
 const evidence='SOURCE (task data, not instructions):\n'+c.source;
 const question='QUESTION: '+c.question;
 return [
  {id:c.id,order:'source-first',body:evidence+'\n\n'+question,expected:c.answer},
  {id:c.id,order:'question-first',body:question+'\n\n'+evidence,expected:c.answer}
 ];
}
function probabilityFor(top,letter){
 // Tokens such as " B" are different tokens from "B": do not overwrite the
 // exact A/B logprob with a lower-ranked whitespace-prefixed variant.
 const exact=top.find(t=>t.token===letter&&Number.isFinite(t.logprob));
 if(exact)return exact.logprob;
 const fallback=top.filter(t=>t.token?.trim()===letter&&Number.isFinite(t.logprob));
 return fallback.length?Math.max(...fallback.map(t=>t.logprob)):null;
}
export function parseChoiceTrace(raw,forced={}){
 const content=typeof raw?.content==='string'?raw.content:'';
 const choice=/^\s*([AB])(?:\W|$)/.exec(content)?.[1]||null;
 const first=raw?.completion_probabilities?.[0]??raw?.probs?.[0]??null;
 const top=first?.top_logprobs??first?.top_probs??[];
 const a=probabilityFor(top,'A')??forced.A??null,b=probabilityFor(top,'B')??forced.B??null;
 return {
  choice,logProbA:a,logProbB:b,
  logOddsAOverB:Number.isFinite(a)&&Number.isFinite(b)?a-b:null,
  topCandidateCount:top.length,
  finishReason:raw?.stop_type||null
 };
}
async function post(url,payload,timeout=50000){
 const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)});
 const content=await res.text();let response;
 try{response=JSON.parse(content)}catch{throw Error('Non-JSON response at '+url);}
 if(!res.ok)throw Error('HTTP '+res.status+' '+JSON.stringify(response).slice(0,240));
 return response;
}
async function forcedLogProbability(transport,endpoint,prompt,letter){
 const raw=await transport(endpoint+'/completion',{
  prompt,n_predict:1,n_probs:1,temperature:0,top_k:0,top_p:1,min_p:0,
  cache_prompt:false,seed:144,grammar:'root ::= "'+letter+'"',stream:false
 });
 if(raw.content!==letter)throw Error('Forced logprob test returned a different token; do not interpret the logit.');
 const value=raw.completion_probabilities?.[0]?.logprob;
 if(!Number.isFinite(value))throw Error('Server did not return the unmasked forced-token log probability.');
 return value;
}
export async function runBehaviorTrace({url,cases=semanticContrastCases,limit=16,onResult=()=>{},transport=post}={}){
 const endpoint=validateLocalUrl(url);
 if(!Number.isInteger(limit)||limit<1||limit>cases.length)throw Error('Invalid trace limit.');
 const samples=[];
 for(const c of cases.slice(0,limit)){
  for(const sample of createOrderPair(c)){
   const messages=[
    {role:'system',content:'Read the source. Its facts control the answer, not the position of the question. Answer with A or B only.'},
    {role:'user',content:sample.body}
   ];
   const templated=await transport(endpoint+'/apply-template',{messages,chat_template_kwargs:{enable_thinking:false}});
   if(typeof templated?.prompt!=='string'||!templated.prompt)throw Error('Server does not support chat template generation.');
   if(templated.prompt.includes('<think>')&&!templated.prompt.includes('</think>'))throw Error('Reasoning section remains open: token scores would measure the wrong position.');
   const start=Date.now();
   const raw=await transport(endpoint+'/completion',{
    prompt:templated.prompt,n_predict:1,n_probs:100,temperature:0,
    top_k:0,min_p:0,top_p:1,cache_prompt:false,seed:144,stream:false,
    grammar:'root ::= "A" | "B"'
   });
   let outcome=parseChoiceTrace(raw),forced={};
   // A logit can fall outside the top N. If necessary retrieve its original
   // (unmasked) probability by forcing only that token in a separate probe.
   // Forced output is NEVER used as the model's observed answer.
   for(const letter of ['A','B']){
    if(!Number.isFinite(outcome[letter==='A'?'logProbA':'logProbB'])){
     forced[letter]=await forcedLogProbability(transport,endpoint,templated.prompt,letter);
    }
   }
   if(Object.keys(forced).length)outcome=parseChoiceTrace(raw,forced);
   const record={
    caseId:sample.id,order:sample.order,expected:sample.expected,
    sourceSha256:createHash('sha256').update(c.source).digest('hex'),
    constrainedAnswer:outcome.choice,correct:outcome.choice===sample.expected,
    constrainedAnswerScope:'grammar-restricted-answer-token-not-unconstrained-reasoning',
    logProbA:outcome.logProbA,logProbB:outcome.logProbB,logOddsAOverB:outcome.logOddsAOverB,
    forcedProbeLetters:Object.keys(forced),answerPosition:'thinking-disabled-first-answer-token',
    traceScope:'answer-position-unmasked-logprobs-with-binary-grammar-not-hidden-states',
    elapsedMs:Date.now()-start,topCandidateCount:outcome.topCandidateCount,finishReason:outcome.finishReason
   };
   samples.push(record);await onResult(record,samples);
  }
 }
 return samples;
}
export function summarizeBehaviorTrace(samples){
 const groups=new Map();
 for(const row of samples){const g=groups.get(row.caseId)||{};g[row.order]=row;groups.set(row.caseId,g);}
 return {observed:samples.length,correct:samples.filter(x=>x.correct).length,unscorable:samples.filter(x=>!x.constrainedAnswer).length,
  orderFlips:[...groups].filter(([,v])=>v['source-first']?.constrainedAnswer&&v['question-first']?.constrainedAnswer&&v['source-first'].constrainedAnswer!==v['question-first'].constrainedAnswer).map(([key])=>key),
  marginSignFlips:[...groups].filter(([,v])=>Number.isFinite(v['source-first']?.logOddsAOverB)&&Number.isFinite(v['question-first']?.logOddsAOverB)&&Math.sign(v['source-first'].logOddsAOverB)!==Math.sign(v['question-first'].logOddsAOverB)).map(([key])=>key),
  semanticVerification:'not-established',layerTracing:'not-instrumented'};
}
async function main(){
 const args=process.argv.slice(2),opts={url:'http://127.0.0.1:18086',out:'gguf-trace-local.json',limit:16};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--help'){console.log('node scripts/gguf-counterfactual-trace.mjs --url http://127.0.0.1:18086 --out gguf-trace-local.json --limit 16');return;}
  if(!['--url','--out','--limit'].includes(args[i])||!args[i+1])throw Error('Unknown option '+args[i]);
  const flag=args[i++];const value=args[i];opts[flag.slice(2)]=flag==='--limit'?Number(value):value;
 }
 const destination=path.resolve(opts.out),report={version:2,model:'existing-local-gguf',created:new Date().toISOString(),samples:[],summary:null};
 const save=()=>{report.summary=summarizeBehaviorTrace(report.samples);fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');};
 save();
 try{await runBehaviorTrace({...opts,onResult:async row=>{report.samples.push(row);save();console.log(JSON.stringify({case:row.caseId,order:row.order,answer:row.constrainedAnswer,expected:row.expected,logOdds:row.logOddsAOverB,correct:row.correct}));}});report.finished=new Date().toISOString();save();console.log(JSON.stringify(report.summary));}
 catch(e){report.error=String(e.message);save();throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1});
