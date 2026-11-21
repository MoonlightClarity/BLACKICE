import {CHATGPT_BRIDGE_TOOLS,dispatchChatGPTBridgeTool} from './chatgpt-bridge.mjs';

export const CHATGPT_BRIDGE_PROTOCOL_VERSION='2025-06-18';
export const CHATGPT_BRIDGE_INSTRUCTIONS="Process bridge tasks in ChatGPT Chat Mode with the configured connector. Keep the user's Chat Mode choice. For a handoff naming a request, read that ID with blackice_get_request; use list only to find a request or browse the queue. Carry out the task covered by the user's handoff and existing instructions. Existing authorization covers repeats of those same steps, so reuse it after an interruption. If a required tool or access is unavailable, report the exact missing capability and the work still pending. Save the answer with blackice_complete_request using the current id and revision, then report the observed save result. Saving an answer does not execute it or start another conversation.";
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const error=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});

/** Stateless, bounded MCP request/response transport. No model or API client runs here. */
export async function handleChatGPTBridgeRPC(store,message){
  if(!object(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||
    Object.keys(message).some(key=>!['jsonrpc','id','method','params'].includes(key))||
    message.params!==undefined&&!object(message.params))return error(null,-32600,'Invalid JSON-RPC request.');
  const hasId=Object.hasOwn(message,'id');
  if(hasId&&!(typeof message.id==='string'||typeof message.id==='number'&&Number.isFinite(message.id)))return error(null,-32600,'Use a string or finite numeric request id.');
  if(!hasId){
    if(['notifications/initialized','notifications/cancelled'].includes(message.method))return null;
    return error(null,-32600,'A request id is required for this method.');
  }
  const id=message.id,params=message.params||{};
  let result;
  switch(message.method){
    case 'initialize':
      if(typeof params.protocolVersion!=='string'||!object(params.capabilities)||!object(params.clientInfo)||typeof params.clientInfo.name!=='string'||typeof params.clientInfo.version!=='string')return error(id,-32602,'Initialize with protocolVersion, capabilities and clientInfo.');
      result={protocolVersion:CHATGPT_BRIDGE_PROTOCOL_VERSION,capabilities:{tools:{listChanged:false}},serverInfo:{name:'blackice-chatgpt-bridge',version:'1.0.0'},instructions:CHATGPT_BRIDGE_INSTRUCTIONS};break;
    case 'ping':result={};break;
    case 'tools/list':
      if(params.cursor!==undefined)return error(id,-32602,'The bridge returns its complete tool catalog without a cursor.');
      result={tools:CHATGPT_BRIDGE_TOOLS};break;
    case 'tools/call':
      if(typeof params.name!=='string'||params.arguments!==undefined&&!object(params.arguments)||Object.keys(params).some(key=>!['name','arguments','_meta'].includes(key)))return error(id,-32602,'Call a bridge tool with its name and argument object.');
      result=await dispatchChatGPTBridgeTool(store,params.name,params.arguments||{});break;
    default:return error(id,-32601,'Method not found.');
  }
  return {jsonrpc:'2.0',id,result};
}
