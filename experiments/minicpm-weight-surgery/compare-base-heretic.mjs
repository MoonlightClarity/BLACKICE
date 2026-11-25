import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import path from 'node:path';
import {AttachmentStore} from '../../lib/attachments.mjs';

const workspace=path.join(process.env.APPDATA,'Relay','workspace');
const outputDir=path.join(workspace,'minicpm-surgery-weights-1125','base-comparison');
fs.mkdirSync(outputDir,{recursive:true});
const output=path.join(outputDir,'same-q4ks-behavior-ab.json');
const endpoints=[
 {label:'base',url:'http://127.0.0.1:18087'},
 {label:'heretic',url:'http://127.0.0.1:18088'}
];
const report={version:1,description:'Original model versus Heretic Q4_K_S matched settings',backend:'llama.cpp cpu b1b770d90',started:new Date().toISOString(),settings:{temperature:0,max_tokens:2200,enable_thinking:true},tasks:[],results:[],errors:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
async function jsonFetch(url,options={},timeout=10000){
 const r=await fetch(url,{...options,signal:AbortSignal.timeout(timeout)});
 const j=await r.json();if(!r.ok)throw Error(url+' HTTP '+r.status+': '+JSON.stringify(j).slice(0,200));return j;
}
const store=new AttachmentStore({dataDir:path.join(process.env.APPDATA,'Relay','data')});await store.init();
try{
 const id=process.env.TRACE_RESUME_ID;
 if(!id)throw Error('TRACE_RESUME_ID is required; no private source is baked into the script');
 const entry=(await store.snapshot([id]))[0],read=await store.read(id,{startPage:1,pageCount:2,charCount:10000});
 const source=read.pages.map(p=>'Page '+p.page+'\n'+p.text).join('\n\n');
 const synthetic=[
 'ONBOARDING PILOT — INTERNAL REPORT',
 'Executive conclusion: An onboarding redesign caused a 25% relative improvement in activation and should launch immediately.',
 'September old flow: 1,400 signups and 112 activations (8%). October new flow: 1,800 signups and 180 activations (10%). These represent a two-percentage-point increase, 25% relative. However, the team changed the acquisition-channel mix and mobile share increased from 20% to 45%. Some paid-social visitors were prequalified through a campaign form.',
 'There was no randomization, no simultaneous control group, and no attempt to estimate channel-adjusted effects. The activation-event definition was revised: 36 of October’s 180 activations used an event definition not validated against September. A reminder-email sequence launched on October 7. Support tickets increased but their causes were not classified.',
 'Neither month has measured paid conversion, user satisfaction, or longer-term retention. A simpler flow might reduce friction, but it might also hide requirements. The team has not evaluated confidence intervals, device segmentation, or consistent analytics.',
 'A product director calls the metric shift proof of causality. A quality analyst argues the improvement is an association only. Another leader points out that inaction has opportunity costs.',
 'The decision is whether to launch globally, conduct a controlled pilot, or retain the old flow.'
 ].join('\n\n');
 const prompts=[
  {id:'resume-open',input:'Analyze the following resume.\n\nSOURCE TEXT:\n'+source},
  {id:'resume-employer',input:'Analyze the following resume as an employer.\n\nSOURCE TEXT:\n'+source},
  {id:'resume-substantive',input:'Analyze the following resume from the hiring side. Evaluate what the described responsibilities actually establish, the strongest plausible alternative interpretations, and which evidence would materially change the assessment. Do not mistake a résumé claim for independently proven competence. Deliver substantive analysis, not an inventory of roles.\n\nSOURCE TEXT:\n'+source},
  {id:'onboarding-open',input:'Analyze the following report.\n\nSOURCE TEXT:\n'+synthetic},
  {id:'onboarding-decision',input:'Evaluate this onboarding experiment: what is established, what alternative explanations matter, and which next decision is justified? Distinguish association from causal proof.\n\nSOURCE TEXT:\n'+synthetic}
 ];
 report.source={name:'original private source',sha256:entry.sha256,pages:read.pages.length,originalChars:source.length,syntheticChars:synthetic.length};
 report.tasks=prompts.map(x=>({id:x.id,chars:x.input.length}));
 save();
 for(const e of endpoints){
  let health=null;
  for(let attempt=0;attempt<20;attempt++){
   try{health=await jsonFetch(e.url+'/health',{},3000);if(health.status==='ok')break;}
   catch{}
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(!health||health.status!=='ok')throw Error(e.label+' local model server not healthy');
  const models=await jsonFetch(e.url+'/v1/models');
  e.model=models.data?.[0]?.id||e.label;
  report[e.label+'Model']=e.model;
 }
 const modelSystem='Read the entire source. Answer the user’s analysis request using the source. Distinguish source claims from established facts. Do not invent employers, methods or outcomes.';
 const probeMessages=[{role:'system',content:modelSystem},{role:'user',content:'Respond to this short test.'}];
 const rendered={};
 for(const e of endpoints){
  const reply=await jsonFetch(e.url+'/apply-template',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:probeMessages,chat_template_kwargs:{enable_thinking:true}})},6000);
  rendered[e.label]=reply.prompt;
 }
 report.templateEqual=rendered.base===rendered.heretic;
 report.templateChecksums=Object.fromEntries(Object.entries(rendered).map(([k,v])=>[k,require('node:crypto').createHash('sha256').update(v).digest('hex')]));
 save();
 console.log('A_B_SETUP',JSON.stringify({sourceSha256:entry.sha256,baseModel:report.baseModel,hereticModel:report.hereticModel,templateEqual:report.templateEqual,tasks:report.tasks.map(x=>x.id)}));
 for(const [index,t] of prompts.entries()){
  const order=index%2===0?endpoints:[...endpoints].reverse();
  for(const e of order){
   const started=Date.now();
   try{
    const response=await jsonFetch(e.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:e.model,temperature:0,max_tokens:2200,chat_template_kwargs:{enable_thinking:true},messages:[{role:'system',content:modelSystem},{role:'user',content:t.input}]})},115000);
    const choice=response.choices?.[0],msg=choice?.message||{},row={task:t.id,model:e.label,ms:Date.now()-started,finish:choice?.finish_reason,content:msg.content||'',reasoning:msg.reasoning_content||'',contentChars:msg.content?.length||0,reasoningChars:msg.reasoning_content?.length||0,usage:response.usage};
    report.results.push(row);save();
    console.log('BEHAVIOR_AB',JSON.stringify({task:row.task,model:row.model,ms:row.ms,finish:row.finish,contentChars:row.contentChars,reasoningChars:row.reasoningChars,outputTokens:row.usage?.completion_tokens}));
   }catch(err){
    report.errors.push({task:t.id,model:e.label,error:String(err),ms:Date.now()-started});save();
    console.log('BEHAVIOR_AB_ERROR',JSON.stringify(report.errors.at(-1)));
   }
  }
 }
 report.finished=new Date().toISOString();save();
}catch(error){report.fatal=String(error);save();console.log('FATAL_AB',report.fatal)}
finally{await store.close()}
