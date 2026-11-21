'use strict';
// Pinned allocator semantics only. This module performs no I/O and cannot prove
// that a running binary contains the attributed source, or prove task ownership.
const RULE='llama-batch-text-scalar-expansion-v1';
const RULE_SOURCE=Object.freeze({
 sourceCommit:'b1b770d90d94cad9e9ea5b993bdbc383a522fb28',
 relativePath:'src/llama-batch.cpp',
 sha256:'f05699a784309200f1ee1a64857ba1f86b003cde5301275be90731b76723c9ec',
 expansion:'For a token-ID row: section j is j < 3 ? token.pos[0] : 0.',
 split:'Each position section is copied using the original selected batch index.'
});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>object(value)&&Object.hasOwn(value,key);
const int32=value=>Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
function exactInt32Array(value,length){
 if(!Array.isArray(value)||value.length!==length)return false;
 for(let i=0;i<length;i++)if(!Object.hasOwn(value,i)||!int32(value[i]))return false;
 return true;
}
const raw=value=>Array.isArray(value)?value.slice():value===undefined?null:value;
function observeTextPositionCorrespondence(input={}){
 const server=object(input)?input.serverRow:null,micro=object(input)?input.microbatchRow:null;
 const sections=object(input)?input.nPositionSections:undefined;
 const result={
  schema:'blackice.minicpm.text-position-correspondence.v1',complete:false,
  rule:RULE,ruleSource:RULE_SOURCE,
  scope:'Coordinate correspondence under the pinned text rule only; actual runtime source identity and task ownership require independent evidence.',
  nPositionSections:sections===undefined?null:sections,
  serverPositions:raw(server?.positions),microbatchPositions:raw(micro?.positions),
  expectedMicrobatchPositions:null,conflicts:[]
 };
 const reject=(code,message)=>result.conflicts.push({code,message});
 if(!object(input)||!Object.hasOwn(input,'nPositionSections')||(sections!==1&&sections!==4))
  reject('TEXT_POSITION_SECTIONS','Observed position-section count must be the supported integer 1 or 4.');
 if(!own(server,'embeddingRow')||!int32(server.embeddingRow)||server.embeddingRow>=0||
    !own(micro,'inputKind')||micro.inputKind!=='token')
  reject('TEXT_POSITION_INPUT','Explicit token input and a negative integer server embedding-row index are required.');
 if(!own(server,'tokenId')||!int32(server.tokenId)||server.tokenId<0||
    !own(micro,'tokenId')||!int32(micro.tokenId)||micro.tokenId<0||micro.tokenId!==server.tokenId)
  reject('TEXT_POSITION_TOKEN','The source and core rows must contain the same nonnegative signed32 token ID.');
 const serverValid=own(server,'positions')&&exactInt32Array(server.positions,4);
 if(!serverValid||server.positions.slice(1).some(value=>value!==0))
  reject('TEXT_POSITION_SERVER','Logical text positions must be exactly four signed32 integers with all three unused coordinates zero.');
 const microValid=own(micro,'positions')&&(sections===1||sections===4)&&exactInt32Array(micro.positions,sections);
 if(!microValid)reject('TEXT_POSITION_CORE','Core positions must be exactly the observed 1 or 4 signed32 coordinates.');
 if(serverValid&&(sections===1||sections===4)){
  const p=server.positions[0];result.expectedMicrobatchPositions=sections===1?[p]:[p,p,p,0];
  if(microValid&&!result.expectedMicrobatchPositions.every((value,index)=>value===micro.positions[index]))
   reject('TEXT_POSITION_EXPANSION','Core coordinates differ from the exact pinned allocator text expansion.');
 }
 result.complete=result.conflicts.length===0;
 return result;
}
module.exports={RULE,RULE_SOURCE,observeTextPositionCorrespondence};
