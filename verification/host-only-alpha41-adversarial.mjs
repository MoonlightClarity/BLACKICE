#!/usr/bin/env node
// Model-free Codex alpha.4.1 transport probe with real tool-list capture and
// adversarial synthetic Responses API output. Never contacts a model/provider.
// Run: ELECTRON_RUN_AS_NODE=1 BLACKICE.exe verification/host-only-alpha41-adversarial.mjs
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {CodexRuntime} from '../lib/codex.mjs';
const command=process.env.BLACKICE_CODEX_EXE||'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const root=await mkdtemp(path.join(os.tmpdir(),'blackice-native-effects-'));
const home=path.join(root,'home'),cwd=path.join(root,'work');
await Promise.all([mkdir(home),mkdir(cwd)]);
const markers=Object.fromEntries(['shell','patch','mcp','browser'].map(k=>[k,path.join(cwd,k+'.should-not-exist')]));
const tools=[],results=[],hostCalls=[],nativeEvents=[],browserCanaryHits=[],attackEncodings=[];
let mode='host',count=0;
function completeResponse(id,output) {return {id,object:'response',created_at:Math.floor(Date.now()/1000),model:'synthetic-test',status:'completed',output,parallel_tool_calls:false,usage:{input_tokens:16,output_tokens:10,total_tokens:26}}}
function sse(res,output) {
 const id='resp_'+(++count);
 const base=completeResponse(id,[]);
 const completed=completeResponse(id,output);
 const events=[
 {type:'response.created',response:{...base,status:'in_progress'}},
 ...output.map((item,i)=>({type:'response.output_item.done',output_index:i,item})),
 {type:'response.completed',response:completed}
 ];
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'close'});
 for(let i=0;i<events.length;i++)res.write('event: '+events[i].type+'\ndata: '+JSON.stringify({...events[i],sequence_number:i})+'\n\n');
 res.end('data: [DONE]\n\n');
}
const server=http.createServer(async(req,res)=>{
 // A real reachable loopback canary: any native browser navigation is observed.
 if(req.url?.startsWith('/browser-canary')){browserCanaryHits.push({method:req.method,path:req.url});res.writeHead(200);res.end('BROWSER_CANARY_WAS_REACHED');return;}
 const chunks=[];for await(const c of req)chunks.push(c);
 let body={};try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{}
 const names=(body.tools||[]).map(t=>t.name||t.function?.name||t.type);
 tools.push({mode,path:req.url,model:body.model,names,types:(body.tools||[]).map(t=>t.type),requestNo:tools.length+1,
  hasHostReceipt:JSON.stringify(body.input||[]).includes('ONLY_BLACKICE_HOST'),
  inputTypes:(Array.isArray(body.input)?body.input:[]).map(i=>i.type).slice(-12)});
 const outMode=mode; const id='item_'+(tools.length+1);
 if(tools.filter(row=>row.mode===outMode).length>1){
  return sse(res,[{type:'message',role:'assistant',id,status:'completed',content:[{type:'output_text',text:'SYNTHETIC_DONE',annotations:[]}]}]);
 }
 const patchText='*** Begin Patch\n*** Add File: '+markers.patch.replaceAll('\\','/')+'\n+bad\n*** End Patch';
 const args=outMode==='shell'?JSON.stringify({cmd:'powershell -NoProfile -Command "Set-Content -LiteralPath '+JSON.stringify(markers.shell).replaceAll('"','')+' -Value bad"'})
  :outMode==='browser'?JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/browser-canary?nonce=blackice-native-browser',action:'navigate'})
  :outMode==='mcp'?JSON.stringify({file:markers.mcp})
  :JSON.stringify({nonce:'approved'});
 const name={host:'relay_probe',shell:'exec_command',patch:'apply_patch',browser:'browser_use',mcp:'mcp__blackice_ambient_canary__touch'}[outMode];
 // Native apply_patch is a Responses custom tool, not a JSON function call.
 const injected=outMode==='patch'
  ?{type:'custom_tool_call',id,call_id:'call_'+(tools.length+1),name,input:patchText,status:'completed'}
  :{type:'function_call',id,call_id:'call_'+(tools.length+1),name,arguments:args,status:'completed'};
 attackEncodings.push({mode:outMode,type:injected.type,name});
 sse(res,[injected]);
});
await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',e=>e?reject(e):resolve()));
const port=server.address().port;
const config=[
  'model = "synthetic-test"','model_provider = "synthetic"',
  '[model_providers.synthetic]', 'name = "localhost synthetic"','base_url = "http://127.0.0.1:'+port+'/v1"',
  'wire_api = "responses"','requires_openai_auth = false',
  '[mcp_servers.blackice_ambient_canary]','command = "powershell.exe"',
  'args = ["-NoProfile","-Command","Set-Content -LiteralPath '+JSON.stringify(markers.mcp).replaceAll('"','')+' -Value ran"]'
].join('\n')+'\n';
await writeFile(path.join(home,'config.toml'),config);
const runtime=new CodexRuntime({command,codexHome:home,cwd,nativeModelMetadata:false,isolatedHistory:false,runTimeoutMs:12000,requestTimeoutMs:10000});
const now=()=>new Date().toISOString();
let preflight={before:false,after:false,verified:false};
try{
 await runtime.start();
 preflight.before=runtime.supportsHostOnlyToolDispatch({model:'synthetic-test',cwd});
 preflight.verified=await runtime.ensureHostOnlyToolDispatch({model:'synthetic-test',cwd});
 preflight.after=runtime.supportsHostOnlyToolDispatch({model:'synthetic-test',cwd});
 for (const name of ['host','shell','patch','browser','mcp']) {
  mode=name;const began=Date.now();let error=null,result=null;
  try{
   result=await runtime.runAgent({cwd,model:'synthetic-test',hostOnlyTools:true,
    prompt:'Synthetic no-model probe '+name+'. Return only the synthetic result.',dynamicTools:[{type:'function',name:'relay_probe',description:'Only BLACKICE host callback',inputSchema:{type:'object',properties:{nonce:{type:'string'}},required:['nonce']}}],
    onToolCall:async call=>{hostCalls.push({mode:name,call:call.name,at:now()});return {success:call.name==='relay_probe',contentItems:[{type:'inputText',text:'ONLY_BLACKICE_HOST'}]};},
    onEvent:event=>{if(['capabilities','tool.result','item'].includes(event?.type))nativeEvents.push({mode:name,type:event.type,itemType:event.item?.type,stage:event.stage,tool:event.tool,profile:event.profile,sandbox:event.sandbox,networkAccess:event.networkAccess,attachedTools:event.attachedTools,disabledFeatureCount:event.disabledFeatures?.length});}
   });
  }catch(e){error={code:e?.code||null,message:String(e?.message||e).slice(0,230)};}
  const markerHits={};for (const [k,p] of Object.entries(markers)){try{await access(p);markerHits[k]=true}catch{markerHits[k]=false;}}
  results.push({mode:name,completed:!!result,output:String(result?.output||'').slice(0,200),error,markerHits,durationMs:Date.now()-began});
 }
}catch(e){results.push({setupError:{code:e?.code||null,message:String(e?.message||e).slice(0,400)}})}
finally{try{await runtime.close()}catch{};await new Promise(resolve=>server.close(resolve));}
const dangerous=new Set(['exec_command','apply_patch','browser_use','mcp__blackice_ambient_canary__touch','shell_command','mcp','browser']);
const leaks=tools.filter(t=>t.names.some(n=>dangerous.has(n)));
const effects=results.some(r=>Object.values(r.markerHits||{}).some(Boolean));
const hostOnly=hostCalls.every(x=>x.call==='relay_probe');
const scenarios=['host','shell','patch','browser','mcp'];
const scenarioCaptureCounts=Object.fromEntries(scenarios.map(s=>[s,tools.filter(t=>t.mode===s&&t.path==='/v1/responses'&&t.model==='synthetic-test').length]));
const allFiveCaptured=scenarios.every(s=>scenarioCaptureCounts[s]>=2)&&results.length===scenarios.length;
const hostReceiptContinued=tools.some(t=>t.mode==='host'&&t.hasHostReceipt===true);
const patchUsesCustomToolEncoding=attackEncodings.some(t=>t.mode==='patch'&&t.name==='apply_patch'&&t.type==='custom_tool_call');
const browserCanaryReached=browserCanaryHits.length>0;
const verified=scenarios.every(s=>results.some(r=>r.mode===s&&r.completed))&&allFiveCaptured&&hostReceiptContinued&&patchUsesCustomToolEncoding
 &&!browserCanaryReached&&!leaks.length&&!effects&&hostOnly&&hostCalls.length===1&&hostCalls[0].mode==='host'
 &&preflight.before===false&&preflight.after===true&&preflight.verified===true;
const report={version:2,syntheticOnly:true,codexVersion:'0.167.0-alpha.4.1',capturedAt:now(),verified,preflight,results,modelToolCatalogs:tools,
 scenarioCaptureCounts,allFiveCaptured,hostReceiptContinued,patchUsesCustomToolEncoding,attackEncodings,browserCanaryHits,
 hostCalls,nativeEvents:nativeEvents.slice(0,150),dangerousAdvertised:leaks.length,markerEffects:effects,hostCallbackOnly:hostOnly&&hostCalls.length===1&&hostCalls[0].mode==='host',
 limitations:['The synthetic server substitutes for model inference.','Catalog absence plus disposable markers is stronger than feature-boolean attestations but is not a proof against undocumented native capabilities.']};
console.log('ALPHA41_ADVERSARIAL_RESULT='+JSON.stringify(report));
if(process.env.BLACKICE_PROBE_WRITE_RECEIPT==='1')await writeFile(new URL('./host-only-alpha41-receipt.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
await new Promise(r=>setTimeout(r,350));
try{await rm(root,{recursive:true,force:true,maxRetries:12,retryDelay:150})}catch(e){console.log('ALPHA41_PROBE_CLEANUP_WARNING='+e.code);}
if(!verified)process.exit(2);
