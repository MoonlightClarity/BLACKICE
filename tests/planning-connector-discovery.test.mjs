import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {ChatGPTConnector} from '../lib/chatgpt-connector.mjs';
import {DirectExecutionAPI,validDirectArguments} from '../lib/direct-execution-api.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {createDirectPlanningBrowserTools} from '../lib/direct-planning-browser-tools.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';
import {planningConnectorSchema} from '../lib/planning-connector-schema.mjs';

test('real MCP HTTP discovery and disposable graph roundtrip retain strict canonical admission',{timeout:10000},async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'planning-discovery-')),cwd=path.join(directory,'workspace');
 await mkdir(cwd);
 const store=await new PlanningBrowserStore({dataDir:directory}).init();
 const execution=await new DirectExecutionAPI({dataDir:directory,allowedRoot:cwd,additionalTools:createDirectPlanningBrowserTools({store})}).init();
 const client={id:'discovery-synthetic-owner',scopes:['read','planning:write']};
 const oauth={setOrigin(){},status:()=>({healthy:true}),revokeAll:async()=>{},authenticateRequest:async req=>req.headers.authorization==='Bearer synthetic-test-token'?client:null,
  challenge:()=> 'Bearer error="invalid_token"',handle:async(_req,res)=>{res.writeHead(404);res.end();}};
 const connector=await new ChatGPTConnector({dataDir:directory,execution,planning:{tools:()=>[],call:()=>{throw Error('Unexpected route');}},oauth,version:'discovery-test'}).init();
 const server=createServer((req,res)=>Promise.resolve(connector.handle(req,res)).catch(error=>res.destroy(error)));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await connector.close();await store.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(directory,{recursive:true,force:true});});
 connector.setOrigin('https://owned.example');await connector.setEnabled(true);
 let sequence=0;
 const rpc=async(method,params={})=>{
  const res=await fetch(origin+'/mcp/chatgpt',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer synthetic-test-token'},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})});
  assert.equal(res.status,200);const wire=await res.json();assert.ok(!wire.error,JSON.stringify(wire));return wire.result;
 };
 const call=async(name,args)=>{
  const result=await rpc('tools/call',{name,arguments:args});
  return {...JSON.parse(result.content.find(x=>x.type==='text').text),isError:result.isError===true};
 };
 const settled=async(job)=>{
  assert.ok(job.jobId,JSON.stringify(job));
  for(let i=0;i<200;i++){
   const r=await call('blackice_get_job',{jobId:job.jobId,limit:50000});
   if(r.settled)return {job:r,value:r.result?JSON.parse(r.result.text.text):null};
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('Synthetic graph job did not settle');
 };
 const catalog=(await rpc('tools/list')).tools;
 const wireWrite=catalog.find(x=>x.name==='blackice_planning_graph_write'),wireRead=catalog.find(x=>x.name==='blackice_planning_graph_read');
 const canonical=execution.tools(client).find(x=>x.name===wireWrite.name).inputSchema;
 const bytes=JSON.stringify(wireWrite.inputSchema).length;
 assert.ok(bytes<18000,'Compact discovery budget exceeded: '+bytes);
 assert.equal(wireWrite.inputSchema.oneOf,undefined);
 assert.deepEqual(wireWrite.inputSchema.required,['requestId','action']);
 assert.ok(wireWrite.inputSchema.properties.values.properties.interpretation);
 assert.match(wireWrite.description,/requestId is mandatory/);
 assert.ok(wireRead.inputSchema.properties.action.enum.includes('schema'));
 assert.deepEqual(canonical,execution.definitions.get(wireWrite.name).inputSchema,'Discovery cannot mutate canonical validation');
 const described=await settled(await call(wireRead.name,{requestId:'schema-one',action:'schema',writeAction:'record_response',field:'contract'}));
 assert.equal(described.job.status,'succeeded');assert.deepEqual(described.value.schema,canonical.properties.contract);
 const created=await settled(await call(wireWrite.name,{requestId:'create-one',action:'create_request',graphRequestId:'disposable',title:'Synthetic connector test',objective:'Verify schema discovery only.'}));
 assert.equal(created.job.status,'succeeded');
 const added=await settled(await call(wireWrite.name,{requestId:'add-one',action:'add_module',graphRequestId:'disposable',nodeId:'frame',kind:'frame',title:'Synthetic frame'}));
 assert.equal(added.job.status,'succeeded');
 const fields=planningModuleTemplate('frame').fields,values=Object.fromEntries(fields.map(field=>[field.id,'Synthetic '+field.label]));
 const args={requestId:'response-one',action:'record_response',graphRequestId:'disposable',nodeId:'frame',expectedNodeRevision:1,values,
  grounding:fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'request:disposable'}))};
 assert.equal(validDirectArguments(args,wireWrite.inputSchema),true);assert.equal(validDirectArguments(args,canonical),true);
 const written=await settled(await call(wireWrite.name,args));assert.equal(written.job.status,'succeeded',JSON.stringify(written.job));
 const read=await settled(await call(wireRead.name,{requestId:'read-one',action:'get',graphRequestId:'disposable',nodeId:'frame'}));
 assert.deepEqual(read.value.node.response.values,values);
 assert.equal(read.value.node.response.provenance.kind,'external_agent');
 const duplicate=await call(wireWrite.name,args);assert.equal(duplicate.jobId,written.job.jobId);
 const before=(await store.get('disposable')).revision;
 for(const invalid of [
  {operation:'record_response',response:{interpretation:'private-marker'}},
  {...args,requestId:'extra-one',actor:{id:'forged'}},
  {...args,requestId:'contract-invalid',contract:{notAContract:'private-marker'}},
  {...args,requestId:'wrong-type',values:{interpretation:42}},
  {requestId:'missing-value',action:'record_response',graphRequestId:'disposable',nodeId:'frame',expectedNodeRevision:2}
 ]){
  const error=await call(wireWrite.name,invalid);
  assert.equal(error.code,'DIRECT_REQUEST_INVALID');assert.equal(error.isError,true);assert.equal(error.jobId,undefined);
  assert.ok(!JSON.stringify(error).includes('private-marker'));
 }
 assert.equal((await store.get('disposable')).revision,before);
 assert.equal((await store.get('disposable')).attempts.length,0);
 t.diagnostic(JSON.stringify({canonicalBytes:JSON.stringify(canonical).length,discoveryBytes:bytes,syntheticGraph:'disposable',roundtrip:'passed',chatgptClientRendering:'not exercised by HTTP test'}));
});

test('discovery projection leaves unrelated tool schemas unchanged',()=>{
 const schema={type:'object',properties:{x:{type:'string'}},required:['x']};
 assert.equal(planningConnectorSchema('blackice_workspace_write',schema),schema);
});
