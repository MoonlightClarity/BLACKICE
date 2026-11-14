import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativePlanningTools} from './lib/native-planning-tools.mjs';
import {estimateContextTokens} from './lib/context.mjs';
import {validDirectArguments} from './lib/direct-execution-api.mjs';

// Experiment only: keep all top-level constraints, variant keys, action constants
// and per-action required lists; omit an exactly duplicated variant constraint.
function compact(schema) {
  const s=structuredClone(schema);
  if (!Array.isArray(s.oneOf) || !s.properties) return s;
  for (const branch of s.oneOf) for (const [key,value] of Object.entries(branch.properties||{})) {
    if (key!=='action' && JSON.stringify(value)===JSON.stringify(s.properties[key])) branch.properties[key]={};
  }
  return s;
}
const stub=Object.fromEntries(['list','get','create','addNode','updateNode','link','addSource'].map(name=>[name,()=>{}]));
const provider=createNativePlanningTools({store:stub});

test('deduplicated planning schemas retain every action, allowed key and required field', () => {
 for(const tool of provider.catalog) {
  const before=tool.inputSchema,after=compact(before);
  assert.deepEqual(after.properties.action,before.properties.action);
  for(let i=0;i<before.oneOf.length;i++){
   assert.deepEqual(after.oneOf[i].required,before.oneOf[i].required);
   assert.deepEqual(Object.keys(after.oneOf[i].properties),Object.keys(before.oneOf[i].properties));
   assert.deepEqual(after.oneOf[i].properties.action,before.oneOf[i].properties.action);
  }
  assert.equal(tool.mutating,tool.annotations.readOnlyHint===false);
  const a=estimateContextTokens(before),b=estimateContextTokens(after);
  console.log(tool.name, 'original',a,'compact',b,'saved',a-b);
 }
});

test('representative read and action calls remain accepted and malformed calls rejected', () => {
 const read=provider.catalog.find(t=>t.name==='relay_planning_read').inputSchema;
 const write=provider.catalog.find(t=>t.name==='relay_planning_write').inputSchema;
 for(const [s,args] of [[read,{requestId:'a',action:'schema',writeAction:'create_request'}],
   [write,{requestId:'b',action:'create_request',title:'Audit',objective:'Test'}],
   [write,{requestId:'b',action:'create_request',title:'Audit'}],
   [write,{requestId:'b',action:'create_request',title:'Audit',objective:'Test',unknown:true}]]) {
  assert.equal(validDirectArguments(args,compact(s)),validDirectArguments(args,s));
 }
});

function sample(s,depth=0) {
 if(depth>30)throw Error('schema too deep');
 if(Object.hasOwn(s,'const'))return s.const;
 if(s.enum)return s.enum[0];
 if(s.anyOf)return sample(s.anyOf[0],depth+1);
 if(s.oneOf)return sample(s.oneOf[0],depth+1);
 if(s.type==='object'){const v={};for(const k of s.required||[])v[k]=sample(s.properties[k],depth+1);return v;}
 if(s.type==='array')return Array.from({length:s.minItems||0},()=>sample(s.items,depth+1));
 if(s.type==='integer'||s.type==='number')return s.minimum??1;
 if(s.type==='boolean')return true;
 if(s.type==='null')return null;
 return 'a'.repeat(Math.max(1,s.minLength||0));
}
test('each Planning action retains validation and required fields in generated cases', () => {
 let tested=0;
 for(const tool of provider.catalog){const s=tool.inputSchema,c=compact(s);
  for(const branch of s.oneOf){
   const call=sample(branch);assert.equal(validDirectArguments(call,s),true,`${tool.name} ${call.action} fixture`);
   assert.equal(validDirectArguments(call,c),true,`${tool.name} ${call.action} compact`);tested++;
   for(const required of branch.required){const missing={...call};delete missing[required];assert.equal(validDirectArguments(missing,c),validDirectArguments(missing,s),`${call.action} missing ${required}`);}
   const unknown={...call,unexpected_audit_field:true};assert.equal(validDirectArguments(unknown,c),validDirectArguments(unknown,s),`${call.action} unknown field`);
  }
 }
 assert.equal(tested,16);
});
