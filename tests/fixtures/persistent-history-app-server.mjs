import readline from 'node:readline';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const option=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.split('=').slice(1).join('='),file=option('store');
const saved=file&&existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{counter:0,threads:{}};
const write=()=>{if(file)writeFileSync(file,JSON.stringify(saved));};
const send=value=>process.stdout.write(JSON.stringify(value)+'\n'),reply=(id,result)=>send({id,result}),fail=(id,message)=>send({id,error:{code:-32000,message}}),notice=(method,params)=>send({method,params});
const active=new Map();let imports=0;
function complete(threadId,turnId,compact){
 const thread=saved.threads[threadId];thread.turns++;if(compact)thread.compactions++;
 const text=JSON.stringify({savedText:thread.items.map(item=>item.content?.[0]?.text||'').join(''),dynamicTools:thread.dynamicTools,compactions:thread.compactions,config:thread.config});
 const item=compact?{type:'contextCompaction',id:'checkpoint-'+turnId}:{type:'agentMessage',id:'answer-'+turnId,text};
 active.delete(threadId);write();notice('item/completed',{threadId,turnId,item});
 notice('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:{total:{inputTokens:thread.turns*20,outputTokens:thread.turns*5,totalTokens:thread.turns*25},last:{inputTokens:20,outputTokens:5,totalTokens:25},modelContextWindow:Math.floor((thread.config?.model_context_window||272000)*.95)}});
 notice('turn/completed',{threadId,turn:{id:turnId,status:'completed',items:[item]}});
}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params={}}=JSON.parse(line);if(id===undefined)return;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',planType:'fixture'},requiresOpenaiAuth:true});
 if(method==='model/list')return reply(id,{data:[{id:'fixture',model:'fixture',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null});
 if(method==='config/read')return reply(id,{config:{plugins:{},mcp_servers:{},skills:{config:[]}}});
 if(method==='skills/list')return reply(id,{data:(params.cwds||[]).map(cwd=>({cwd,skills:[],errors:[]}))});
 if(method==='thread/start'){
  const threadId='persistent-'+(++saved.counter);saved.threads[threadId]={cwd:params.cwd,model:params.model,config:params.config||{},dynamicTools:params.dynamicTools||[],ephemeral:params.ephemeral===true,turns:0,compactions:0,items:[]};write();return reply(id,{thread:{id:threadId,cwd:params.cwd,ephemeral:params.ephemeral===true},model:params.model});
 }
 if(method==='thread/read'||method==='thread/resume'){
  const thread=saved.threads[params.threadId];if(!thread||thread.ephemeral)return fail(id,'Fixture has no persistent thread.');
  if(method==='thread/resume'&&params.config){thread.config={...thread.config,...params.config};write();}
  return reply(id,{thread:{id:params.threadId,cwd:thread.cwd,model:thread.model,ephemeral:false},model:thread.model});
 }
 if(method==='thread/inject_items'){
  if(++imports===Number(option('fail-import')))return fail(id,'Fixture import rejected.');
  saved.threads[params.threadId].items.push(...params.items);write();return reply(id,{});
 }
 if(method==='thread/compact/start'||method==='turn/start'){
  if(method==='thread/compact/start'&&process.argv.includes('--fail-compact'))return fail(id,'Fixture compaction rejected.');
  const turnId='operation-'+(++saved.counter),compact=method==='thread/compact/start';active.set(params.threadId,{turnId,timer:null});
  reply(id,compact?{}:{turn:{id:turnId}});notice('turn/started',{threadId:params.threadId,turn:{id:turnId,status:'inProgress'}});
  if(!compact||!process.argv.includes('--hold-compact'))active.get(params.threadId).timer=setTimeout(()=>complete(params.threadId,turnId,compact),compact?30:5);
  return;
 }
 if(method==='turn/interrupt'){
  const operation=active.get(params.threadId);if(operation){clearTimeout(operation.timer);active.delete(params.threadId);notice('turn/completed',{threadId:params.threadId,turn:{id:operation.turnId,status:'interrupted',items:[]}});}return reply(id,{});
 }
 if(method==='thread/unsubscribe'){
  if(process.argv.includes('--fail-unsubscribe'))return fail(id,'Fixture unload failed.');
  if(saved.threads[params.threadId]?.ephemeral){delete saved.threads[params.threadId];write();}return reply(id,{});
 }
 reply(id,{});
});
