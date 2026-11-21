'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {RULE,RULE_SOURCE,observeTextPositionCorrespondence:observe}=require('./text-position-correspondence.cjs');
function row(position=1,sections=4){
 return {nPositionSections:sections,
  serverRow:{batchRow:1,serverBatchRow:1,slotId:0,taskId:0,tokenId:279,positions:[position,0,0,0],output:false,isPrompt:true,embeddingRow:-1},
  microbatchRow:{microRow:1,batchRow:1,tokenId:279,inputKind:'token',positions:sections===1?[position]:[position,position,position,0],sequenceIds:[0],output:false}};
}
test('preserved nonzero text row follows allocator expansion without changing either representation',()=>{
 // Exact token and coordinate regression retained from a failed live observation.
 // Private provenance stays in the separate evidence receipt, not this fixture.
 const input=row(),before=structuredClone(input),out=observe(input);
 assert.equal(out.complete,true,JSON.stringify(out.conflicts));assert.equal(out.rule,RULE);
 assert.equal(out.ruleSource.sha256,'f05699a784309200f1ee1a64857ba1f86b003cde5301275be90731b76723c9ec');
 assert.deepEqual(out.serverPositions,[1,0,0,0]);assert.deepEqual(out.microbatchPositions,[1,1,1,0]);
 assert.deepEqual(out.expectedMicrobatchPositions,[1,1,1,0]);assert.deepEqual(input,before);
 out.serverPositions[0]=9;out.microbatchPositions[0]=9;assert.deepEqual(input,before);
 assert.match(out.scope,/actual runtime source identity.*independent evidence/);
});
test('one and four sections retain exact signed32 semantics including zero and boundaries',()=>{
 for(const p of [-2147483648,-1,0,1,15,2147483647])for(const sections of [1,4]){
  const out=observe(row(p,sections));assert.equal(out.complete,true,JSON.stringify(out.conflicts));
  assert.deepEqual(out.expectedMicrobatchPositions,sections===1?[p]:[p,p,p,0]);
 }
 assert.equal(Object.isFrozen(RULE_SOURCE),true);
});
test('unsupported counts are rejected instead of being truncated or coerced',()=>{
 for(const sections of [0,2,3,5,-1,1.5,'4',null,undefined]){
  const input=row();input.nPositionSections=sections;
  assert.equal(observe(input).complete,false,String(sections));
 }
 const input=row();delete input.nPositionSections;assert.equal(observe(input).complete,false);
});
test('all expanded coordinates and unused logical coordinates are checked',()=>{
 const mutations=[
  x=>x.microbatchRow.positions=[1,0,0,0],x=>x.microbatchRow.positions=[1,1,2,0],
  x=>x.microbatchRow.positions=[1,1,1,1],x=>x.microbatchRow.positions=[1,1,1],
  x=>x.microbatchRow.positions=[1,1,1,0,0],x=>x.serverRow.positions=[1,1,0,0],
  x=>x.serverRow.positions=[1,0,1,0],x=>x.serverRow.positions=[1,0,0,1],
  x=>x.serverRow.positions=[1],x=>x.serverRow.positions=[1,0,0,0,0]
 ];
 for(const mutate of mutations){const input=row();mutate(input);const before=structuredClone(input),out=observe(input);assert.equal(out.complete,false);assert.deepEqual(input,before);assert.deepEqual(out.serverPositions,input.serverRow.positions);assert.deepEqual(out.microbatchPositions,input.microbatchRow.positions);}
});
test('nonintegers, overflow, sparse arrays and nonarray coordinates fail explicitly',()=>{
 for(const value of [NaN,Infinity,1.5,'1',2147483648,-2147483649,null])for(const side of ['serverRow','microbatchRow']){
  const input=row();input[side].positions[0]=value;assert.equal(observe(input).complete,false);
 }
 for(const mutate of [x=>delete x.serverRow.positions[2],x=>delete x.microbatchRow.positions[1],x=>x.serverRow.positions='1,0,0,0',x=>x.microbatchRow.positions=null]){
  const input=row();mutate(input);assert.equal(observe(input).complete,false);
 }
});
test('embedding, mixed, missing, inherited and mismatched token fields are rejected',()=>{
 for(const mutate of [
  x=>x.serverRow.embeddingRow=0,x=>x.serverRow.embeddingRow='-1',x=>delete x.serverRow.embeddingRow,
  x=>x.microbatchRow.inputKind='embedding',x=>x.microbatchRow.inputKind='mixed',x=>delete x.microbatchRow.inputKind,
  x=>x.microbatchRow.tokenId=280,x=>x.microbatchRow.tokenId=-1,x=>x.serverRow.tokenId=-1,
  x=>x.microbatchRow.tokenId=2147483648,x=>delete x.serverRow.tokenId,
  x=>x.serverRow=Object.create(x.serverRow),x=>x.microbatchRow=Object.create(x.microbatchRow)
 ]){const input=row();mutate(input);assert.equal(observe(input).complete,false);}
 for(const input of [null,[],{},{serverRow:null,microbatchRow:null,nPositionSections:4}])assert.equal(observe(input).complete,false);
});
test('a supplied rule label cannot override contradictory coordinates or claim runtime-source evidence',()=>{
 const input=row();input.rule=RULE;input.ruleSource=RULE_SOURCE;input.runtimeSourceVerified=true;input.microbatchRow.positions=[1,0,0,0];
 const out=observe(input);assert.equal(out.complete,false);assert.equal(Object.hasOwn(out,'runtimeSourceVerified'),false);
});
test('both native entrypoints declare the helper among the files they hash into run receipts',()=>{
 for(const name of ['./runtime-lifecycle.cjs','./runtime-parity.cjs']){
  const runtime=require(name);assert.ok(Object.isFrozen(runtime.SOURCE_FILES));
  assert.ok(runtime.SOURCE_FILES.includes('text-position-correspondence.cjs'),name);
  assert.equal(new Set(runtime.SOURCE_FILES).size,runtime.SOURCE_FILES.length);
 }
});
