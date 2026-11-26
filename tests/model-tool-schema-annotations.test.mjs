import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  toolSchemaStructureMatches,toolSchemaAnnotationDelta,applyToolSchemaAnnotations
} from '../lib/model-tool-schema-annotations.mjs';
import {ToolDescriptionOverrides} from '../lib/tool-description-overrides.mjs';

const schema=()=>({
 type:'object',description:'Original schema',additionalProperties:false,required:['action'],
 properties:{
  action:{type:'string',enum:['read','write'],description:'Original action'},
  description:{type:'string',description:'A property literally named description'},
  value:{type:'string'}
 },
 oneOf:[
  {properties:{action:{const:'read',description:'Original read'}}},
  {properties:{action:{const:'write',description:'Original write'}}}
 ]
});
const tool=(inputSchema=schema())=>({name:'relay_example',type:'function',description:'Original tool',inputSchema});
async function temp(t){
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-tool-annotations-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 return dataDir;
}

test('editable schema documentation cannot change execution fields, even for a field named description',()=>{
 const original=schema(),edited=structuredClone(original);
 edited.description='Entirely different schema introduction';
 edited.properties.action.description='Owner-supplied description';
 edited.properties.description.description='Owner note on description input';
 edited.oneOf[0].properties.action.description='Owner-supplied read';
 edited.properties.value.examples=['foo'];
 delete edited.oneOf[1].properties.action.description;
 const delta=toolSchemaAnnotationDelta(original,edited);
 assert.ok(delta.length>=5);
 assert.equal(toolSchemaStructureMatches(original,edited),true);
 const actual=applyToolSchemaAnnotations(original,delta);
 assert.deepEqual(actual,edited);
 assert.deepEqual(original.properties.action.enum,['read','write']);
 assert.deepEqual(actual.properties.action.enum,original.properties.action.enum);
 assert.equal(Object.hasOwn(actual.properties,'description'),true);
});

test('Runtime cannot advertise unsupported action/field contracts through a documentation editor',async t=>{
 const base=tool(),store=await new ToolDescriptionOverrides({dataDir:await temp(t)}).init();
 const badAction=structuredClone(base.inputSchema);
 badAction.properties.action.enum=['imaginary'];
 await assert.rejects(store.save({name:base.name,inputSchema:badAction,expectedRevision:0},[base]),
  {status:422,code:'TOOL_SCHEMA_EXECUTION_MISMATCH'});
 const badField=structuredClone(base.inputSchema);
 badField.properties.newUnauthorizedField={type:'string'};
 await assert.rejects(store.save({name:base.name,inputSchema:badField,expectedRevision:0},[base]),{status:422});
 assert.equal(store.revision,0,'rejected structural edits have no persistence effect');
 assert.deepEqual(store.project([base])[0],base,'the effective definition is unchanged');
});

test('schema edits store a documentation delta and retain fresh executable variants',async t=>{
 const dataDir=await temp(t),store=await new ToolDescriptionOverrides({dataDir}).init();
 const standard=tool(),narrow=tool(schema());
 narrow.inputSchema.properties.action.enum=['read'];
 narrow.inputSchema.oneOf=[narrow.inputSchema.oneOf[0]];
 const edited=structuredClone(standard.inputSchema);
 edited.properties.action.description='Owner docs replace shipped prose';
 edited.oneOf[0].properties.action.description='Owner read docs';
 await store.save({name:standard.name,description:'Owner tool wording',inputSchema:edited,expectedRevision:0},[standard,narrow]);
 const [first,second]=store.project([standard,narrow]);
 assert.equal(first.description,'Owner tool wording');
 assert.equal(second.description,'Owner tool wording');
 assert.deepEqual(first.inputSchema.properties.action.enum,['read','write']);
 assert.deepEqual(second.inputSchema.properties.action.enum,['read']);
 assert.equal(second.inputSchema.properties.action.description,'Owner docs replace shipped prose');
 assert.equal(second.inputSchema.oneOf.length,1);
 const reordered=tool(schema());
 reordered.inputSchema.oneOf.reverse();
 const projectedReordered=store.project([reordered])[0];
 assert.equal(projectedReordered.inputSchema.oneOf[0].properties.action.description,'Original write',
  'reordered action must not receive the old read-action wording');
 const evolved=tool(schema());
 evolved.inputSchema.properties.newSupportedField={type:'integer'};
 evolved.inputSchema.properties.action.enum.push('inspect');
 const [fresh]=store.project([evolved]);
 assert.ok(fresh.inputSchema.properties.newSupportedField,'later executable fields remain advertised');
 assert.deepEqual(fresh.inputSchema.properties.action.enum,['read','write','inspect']);
 assert.equal(fresh.inputSchema.properties.action.description,'Owner docs replace shipped prose');
 const loaded=await new ToolDescriptionOverrides({dataDir}).init();
 assert.deepEqual(loaded.project([evolved]),store.project([evolved]),'documentation delta survives reload');
 assert.equal(JSON.stringify(loaded.state).includes('newSupportedField'),false,'built-in schemas are not copied into the edit store');
});

test('legacy full-schema overrides do not freeze or advertise outdated executable fields',async t=>{
 const dataDir=await temp(t),original=tool(),legacy=structuredClone(original.inputSchema);
 legacy.properties.action.enum=['obsolete'];
 await writeFile(path.join(dataDir,'tool-descriptions.json'),JSON.stringify({version:1,revision:2,
   overrides:{relay_example:{description:'Owner description',inputSchema:legacy}}}));
 const store=await new ToolDescriptionOverrides({dataDir}).init();
 const [advertised]=store.project([original]);
 assert.deepEqual(advertised.inputSchema,original.inputSchema,'the handler contract wins over a stale legacy override');
 assert.equal(advertised.description,'Owner description','independent text edit is retained');
 assert.match(store.list([original]).tools[0].schemaWarning,/not applied/);
});
