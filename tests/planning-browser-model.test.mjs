import test from 'node:test';
import assert from 'node:assert/strict';
import {PLANNING_MODULE_TEMPLATES,planningModuleTemplate,parseModuleResponse,projectPlanningRequest,planningOutlineRows} from '../public/planning-browser-model.mjs';

test('analytical fields allow closed tasks with no decision-changing uncertainty instead of inventing new checks',()=>{
  const frame=planningModuleTemplate('frame');
  assert.match(frame.fields.find(field=>field.id==='decisiveUnknown').description,/no decision-changing unknown remains/);
  assert.match(frame.fields.find(field=>field.id==='decisiveUnknown').description,/fictional or synthetic premises/);
  assert.match(frame.fields.find(field=>field.id==='keyAssumption').description,/no material extra assumption/);
  assert.match(planningModuleTemplate('inquiry').fields.find(field=>field.id==='remainingUncertainty').description,/Stop when additional checking cannot change/);
});

function graph(){return {version:1,id:'request-one',conversationId:'conversation-one',objective:'Choose the least costly reliable route.',nodes:[],edges:[],responses:[],assignments:[],attempts:[],sources:[]};}
function node(id,parentId=null,kind='decision'){return {id,parentId,kind,title:id,prompt:'Explain the material choice.',revision:1};}
function response(g,id,revision=1,extra={}){
  const n=g.nodes.find(item=>item.id===id),fields=planningModuleTemplate(n.kind).fields;
  return {id:id+'-response-'+revision,nodeId:id,kind:n.kind,revision,nodeRevision:n.revision,values:Object.fromEntries(fields.map(f=>[f.id,'Public finding about '+f.label])),grounding:fields.filter(f=>f.grounding==='required').map(f=>({field:f.id,sourceId:'request:'+g.id})),sources:[{id:'request:'+g.id,kind:'user_request',text:g.objective}],inputs:[],challengeResponses:[],openQuestions:[],provenance:{kind:'human',at:'2026-10-30T12:00:00.000Z'},...extra};
}
test('module fields express different cognitive tasks rather than a shared done checklist',()=>{
  assert.deepEqual(PLANNING_MODULE_TEMPLATES.map(t=>t.kind),['cycle','viability','inference','plan','think','respond','frame','inquiry','evidence','comparison','decision','action','synthesis']);
  assert.deepEqual(planningModuleTemplate('decision').fields.map(f=>f.id),['recommendation','strongestAlternative','opportunityCost','keyAssumption','discriminatingObservation','reversalCondition']);
  assert(planningModuleTemplate('inquiry').fields.some(f=>f.id==='competingExplanations'));
  assert(planningModuleTemplate('action').fields.some(f=>f.id==='observedResult'));
  assert(!planningModuleTemplate('evidence').fields.some(f=>f.id==='recommendation'));
});
test('public response parser rejects tool-completion and fabricated provenance fields',()=>{
  for(const value of [{done:true},{values:{recommendation:'Proceed'},status:'done'},{values:{recommendation:'Proceed'},provenance:{kind:'runtime'}},{values:{recommendation:{text:'Nested claim'}}}])
    assert.throws(()=>parseModuleResponse(value,'decision'));
  assert.throws(()=>parseModuleResponse('tool succeeded','decision'),{code:'PLANNING_RESPONSE_PARSE'});
  const partial=parseModuleResponse('{"values":{"recommendation":"Inspect the cheaper alternative."}}','decision');
  assert(partial.missingFields.includes('strongestAlternative'));
  assert(!partial.missingFields.includes('recommendation'));
});
test('projection is idempotent and recursive outline retains real containment',()=>{
  const g=graph();g.nodes=[node('root'),node('child','root'),node('grandchild','child')];
  const one=projectPlanningRequest(g),two=projectPlanningRequest(one);
  assert.deepEqual(two,one);
  assert.deepEqual(planningOutlineRows(one).map(n=>[n.id,n.depth,n.number,n.children]),[['root',0,'1',['child']],['child',1,'1.1',['grandchild']],['grandchild',2,'1.1.1',[]]]);
  assert.equal(two.edges.filter(e=>e.kind==='contains').length,2);
});
test('whole-branch prerequisites wait for unfinished children while independent responses remain ready',()=>{
  const g=graph();g.nodes=[node('frame',null,'frame'),node('check','frame','inquiry'),node('dependent'),node('independent')];
  g.responses=[response(g,'frame'),response(g,'dependent'),response(g,'independent')];g.edges=[{id:'wait',kind:'depends_on',from:'dependent',to:'frame'}];
  const view=projectPlanningRequest(g),byId=Object.fromEntries(view.nodes.map(n=>[n.id,n]));
  assert.equal(byId.frame.readiness.state,'ready');assert.equal(byId.frame.readiness.subtreeReady,false);
  assert.deepEqual(byId.frame.readiness.unresolvedChildren,['check']);
  assert.equal(byId.dependent.readiness.state,'blocked');assert.deepEqual(byId.dependent.readiness.blockedDependencies,['frame']);
  assert.equal(byId.independent.readiness.state,'ready');
});
test('a child can consume parent framing without a false containment dependency',()=>{
  const g=graph();g.nodes=[node('frame',null,'frame'),node('child','frame')];const parent=response(g,'frame');g.responses=[parent,response(g,'child')];
  g.edges=[{id:'read-frame',kind:'consumes',from:'child',to:'frame',sourceResponseId:parent.id,sourceResponseRevision:1,sourceField:'objective',freshness:'latest'}];
  const view=projectPlanningRequest(g);assert(view.nodes.every(n=>n.readiness.state==='ready'));assert(view.nodes.every(n=>n.readiness.subtreeReady));
});
test('named empty tool receipts do not satisfy grounding or certify actions',()=>{
  const g=graph();g.nodes=[node('action',null,'action')];const r=response(g,'action');
  r.sources.push({id:'receipt:empty',kind:'tool_receipt',title:'Success',text:'',contentHash:'a'.repeat(64)});
  r.grounding=r.grounding.map(link=>link.field==='observedResult'?{...link,sourceId:'receipt:empty'}:link);
  g.responses=[r];const n=projectPlanningRequest(g).nodes[0];assert.equal(n.readiness.state,'needs_grounding');assert(n.readiness.missingGrounding.includes('observedResult'));assert.equal(n.readiness.verifiedAction,false);
});
test('open questions are visible without inventing a universal completion gate',()=>{
  const g=graph();g.nodes=[node('choice')];g.responses=[response(g,'choice',1,{openQuestions:['Would a later price change reverse this choice?']})];
  const n=projectPlanningRequest(g).nodes[0];assert.equal(n.readiness.state,'ready');assert.deepEqual(n.readiness.openQuestions,g.responses[0].openQuestions);assert.equal(n.readiness.verifiedAction,false);
});
test('latest and explicit historical consumption retain different freshness semantics',()=>{
  const g=graph();g.nodes=[node('producer'),node('latest'),node('historical')];const old=response(g,'producer'),current=response(g,'producer',2);
  g.responses=[old,current,response(g,'latest'),response(g,'historical')];
  g.edges=['latest','historical'].map(id=>({id:'consume-'+id,kind:'consumes',from:id,to:'producer',sourceResponseId:old.id,sourceResponseRevision:old.revision,sourceField:'recommendation',freshness:id==='latest'?'latest':'pinned'}));
  const view=projectPlanningRequest(g);assert.equal(view.nodes.find(n=>n.id==='latest').readiness.state,'stale');assert.equal(view.nodes.find(n=>n.id==='historical').readiness.state,'ready');
});
test('an addressed challenge retains its actual producer response grounding',()=>{
  const g=graph();g.nodes=[node('claim'),node('challenge')];const challenger=response(g,'challenge');const claim=response(g,'claim',1,{challengeResponses:[{edgeId:'challenge-edge',disposition:'addressed',note:'The narrower recommendation remains supported.'}]});g.responses=[claim,challenger];g.edges=[{id:'challenge-edge',kind:'challenges',from:'challenge',to:'claim'}];
  assert.equal(projectPlanningRequest(g).nodes[0].readiness.state,'challenged');
  claim.sources.push({id:'response:'+challenger.id,kind:'response',text:JSON.stringify(challenger.values)});
  assert.equal(projectPlanningRequest(g).nodes[0].readiness.state,'ready');
  assert.throws(()=>parseModuleResponse({values:{},challengeResponses:[...claim.challengeResponses,...claim.challengeResponses]},'decision'));
});

test('old request objectives with unknown authorship are not promoted by captured source snapshots',()=>{
  const g=graph();g.nodes=[node('choice')];const old=response(g,'choice');old.sources[0].provenance={kind:'human'};g.responses=[old];
  const source=projectPlanningRequest(g).sources.find(s=>s.id==='request:'+g.id);
  assert.equal(source.kind,'request_objective');assert.equal(source.provenance.kind,'unrecorded');assert.equal(source.verified,false);
});

test('an addressed note cannot close a challenger that has never produced a public response',()=>{
  const g=graph();g.nodes=[node('claim'),node('unanswered-challenge')];
  g.edges=[{id:'unanswered-edge',kind:'challenges',from:'unanswered-challenge',to:'claim'}];
  g.responses=[response(g,'claim',1,{challengeResponses:[{edgeId:'unanswered-edge',disposition:'addressed',note:'The answer declares this addressed without seeing a challenge response.'}]})];
  const claim=projectPlanningRequest(g).nodes.find(node=>node.id==='claim');
  assert.equal(claim.readiness.state,'challenged');assert.deepEqual(claim.readiness.openChallenges,['unanswered-edge']);assert.equal(claim.readiness.verifiedAction,false);
});
