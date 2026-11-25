import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AttachmentStore} from '../../lib/attachments.mjs';

const root=path.join(process.env.APPDATA,'Relay','workspace','minicpm-surgery-weights-1125','activation-traces');
fs.mkdirSync(root,{recursive:true});
const st=new AttachmentStore({dataDir:path.join(process.env.APPDATA,'Relay','data')});await st.init();
try{
 const id=process.env.TRACE_RESUME_ID;
 if(!id)throw Error('TRACE_RESUME_ID required');
 const e=(await st.snapshot([id]))[0];
 const read=await st.read(id,{startPage:1,pageCount:2,charCount:10000});
 const source=read.pages.map(p=>'Page '+p.page+'\n'+p.text).join('\n\n');
 const sys='Read the entire source. Answer the user’s analysis request using the source. Distinguish source claims from established facts. Do not invent employers, methods or outcomes.';
 const tasks=[
  {id:'resume-summary',message:'Summarize the following resume.\n\nSOURCE TEXT:\n'+source},
  {id:'resume-analysis',message:'Analyze the following resume as an employer.\n\nSOURCE TEXT:\n'+source},
  {id:'resume-substantive',message:'Analyze the following resume from the hiring side. Evaluate what the described responsibilities actually establish, the strongest plausible alternative interpretations, and which evidence would materially change the assessment. Do not mistake a résumé claim for independently proven competence. Deliver substantive analysis, not an inventory of roles.\n\nSOURCE TEXT:\n'+source},
  {id:'synthetic-evidence',message:'Analyze the report and evaluate what evidence establishes causality.\n\nREPORT:\nThe old onboarding had 1,400 signups and 112 activations. The new flow had 1,800 signups and 180 activations. The acquisition-channel mix changed, mobile share rose, reminder emails launched, and activation instrumentation changed. No randomized control group was used. A director calls this proof the new flow caused the improvement. Evaluate the evidence and decision.'},
 ];
 const report={version:1,promptPrivate:true,backend:'llama-cpp b1b770d90',sourceSha256:e.sha256,prompts:[]};
 for(const t of tasks){
  const messages=[{role:'system',content:sys},{role:'user',content:t.message}];
  const prompts=[];
  for(const port of [18089,18088]){
   const r=await fetch('http://127.0.0.1:'+port+'/apply-template',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages,chat_template_kwargs:{enable_thinking:true}}),signal:AbortSignal.timeout(7000)});
   const j=await r.json();if(!r.ok||typeof j.prompt!=='string')throw Error('Cannot render template at port '+port);
   prompts.push(j.prompt);
  }
  if(prompts[0]!==prompts[1])throw Error('Prompt template mismatch in '+t.id);
  const filename=path.join(root,t.id+'.txt');fs.writeFileSync(filename,prompts[0],'utf8');
  report.prompts.push({id:t.id,path:filename,chars:prompts[0].length,sha256:createHash('sha256').update(prompts[0]).digest('hex')});
  console.log(JSON.stringify({id:t.id,chars:prompts[0].length,identicalTemplates:true}));
 }
 fs.writeFileSync(path.join(root,'private-prompt-manifest.json'),JSON.stringify(report,null,2));
}finally{await st.close()}
