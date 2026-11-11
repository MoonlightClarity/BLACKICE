import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,validatePlanningModuleResponse} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {childAdmissionSnapshot,childAdmissionReview,childAdmissionNeeded,childAdmissionPrompt,childAdmissionSchema,parseChildAdmission,assertChildAdmission} from '../lib/planning-child-admission.mjs';
import {planningCycleEvidence,planningInvocationEvidence} from '../lib/planning-invocation.mjs';
import {responseCycleStage,responseCycleTemplate} from '../public/response-cycle-model.mjs';
import {fixtureUserAgency} from './fixture-user-agency.mjs';

const profile={model:'fixture-local',effort:'low',serviceTier:'default'};
const captured=options=>JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
const cases=[
  ['service','Send the prepared service request.','Submit the real request through its official form.','Tool receipt confirming submission','requires_effect'],
  ['file','Rename the selected folder.','The folder has the requested new name.','Fresh file-system observation','requires_effect'],
  ['reservation','Reserve the chosen appointment.','The requested time is booked.','Provider booking confirmation','requires_effect'],
  ['missing-observation','Read the unprovided document to determine its title.','Report the title from a newly read file.','The not-yet-captured file text','requires_observation'],
  ['receipt-analysis','Determine whether the supplied receipt reports delivery.','Explain what the retained submission receipt establishes.','The supplied receipt text','captured_analysis'],
  ['arithmetic','Determine the difference between supplied capacities.','Report the difference of the two stipulated numbers.','The stipulated capacities','captured_analysis'],
  ['draft','Draft an unsent request using the supplied facts.','Provide proposed request text without sending it.','The supplied drafting facts','captured_analysis'],
  ['hypothetical','Explain the result if the stated folder-renaming rule were applied.','Give a hypothetical result without changing any file.','The stipulated rule and folder names','captured_analysis'],
  ['limitation','Determine which delivery claims the supplied receipt does not establish.','State the limits of this retained receipt.','The supplied receipt only','captured_analysis'],
];
function child(input,row=cases[0]){const [key,objective,description,evidenceNeeded]=row;return {key,title:key,objective,reason:'This question or operation supports the parent outcome.',required:true,executionTarget:'analysis',sourceIds:[input.sources[0].id],acceptanceCriteria:[{id:'result',label:'Requested result',description,verification:'response',accuracy:{mode:'qualitative',tolerance:'',decisionThreshold:'',evidenceNeeded,consequence:'An incorrect task outcome.',unknownPolicy:'assumption',stopWhen:'The stated result is established.'}}]};}
function answer(input){const stage=responseCycleStage(input.module.kind,{pipelineVersion:2}),sourceId=input.sources[0].id;return {userAgency:fixtureUserAgency(),values:Object.fromEntries(input.template.fields.map(field=>[field.id,'The supplied synthetic records support a bounded finding.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[],checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:[sourceId],note:'The supplied records are the stated basis.'})),subproblems:[],childResults:[],inferences:[]};}
function judgment(snapshot,{classification='captured_analysis',retained='preserved'}={}){return {findings:snapshot.requests.map(item=>({key:item.key,classification,rationale:classification==='captured_analysis'?'The question returns a narrower finding from retained inputs.':'The requested completion requires work beyond the captured analytical inputs.',paths:['response.values.subproblemMap'],sourceIds:snapshot.sources.map(source=>source.id)})),retainedOutcome:{assessment:snapshot.retainedObligations?retained:'not_applicable',rationale:snapshot.retainedObligations?'The replacement is assessed against the exact original obligation.':'This is not a semantic refinement.',paths:snapshot.retainedObligations?['response.values.delegatedWork']:[]}};}
async function fixture(t,handler){const dir=await mkdtemp(path.join(os.tmpdir(),'planning-child-admission-')),store=await new PlanningBrowserStore({dataDir:dir}).init(),calls=[];
  const runtime={runAgent:async options=>{const input=captured(options);calls.push({input,options});const output=await handler(input,calls.length,options);return {output:typeof output==='string'?output:JSON.stringify(output),threadId:'fixture-thread',turnId:'fixture-turn-'+calls.length,usage:{inputTokens:100,outputTokens:20,totalTokens:120}};}};
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>({maxSubagents:2,defaultModel:profile.model,defaultEffort:profile.effort})}),service=new ResponseCycleService({store,runner,getSettings:()=>({defaultModel:profile.model,defaultEffort:profile.effort})});
  t.after(async()=>{await runner.close();await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  let request=await store.create({conversationId:'admission-fixture',title:'Synthetic bounded task',objective:'Complete the delegated synthetic task while preserving its required outcome.',cwd:dir});
  request=await service.createCycle(request.id,{title:'Synthetic task',purpose:request.objective,planningExecutionMode:'plan_only',expectedRequestRevision:request.revision,clientRequestId:'root-fixture'});
  request=await service.bindProfile(request,request.cycles[0]);
  return {dir,store,runner,service,calls,request,cycle:request.cycles[0]};
}
async function single(f){const node=f.request.nodes.find(item=>item.id===f.cycle.stageNodeIds.inference),claim=await f.runner.start({requestId:f.request.id,nodeId:node.id,expectedNodeRevision:node.revision,...profile,clientRequestId:'manual-response'});return f.runner.wait(f.request.id,claim.attempt.id);}
const budget=()=>({used:0,max:20,maxPasses:3});


export {profile,captured,cases,child,answer,judgment,fixture,single,budget};
