#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {BlackiceBridgeClient,resolveBlackiceURL,createBridgeMCPHTTPServer,readBridgeInput,validateBridgeToken} from '../lib/chatgpt-bridge-client.mjs';

export const BRIDGE_HELP=`BLACKICE ChatGPT bridge

  node scripts/chatgpt-bridge.mjs status
  node scripts/chatgpt-bridge.mjs list [--status pending|completed|cancelled|all]
  node scripts/chatgpt-bridge.mjs get REQUEST_ID
  node scripts/chatgpt-bridge.mjs request --input-file request.json
  node scripts/chatgpt-bridge.mjs complete REQUEST_ID --revision 1 --answer-file answer.txt
  node scripts/chatgpt-bridge.mjs complete REQUEST_ID --revision 1 --stdin
  node scripts/chatgpt-bridge.mjs cancel REQUEST_ID --revision 1
  node scripts/chatgpt-bridge.mjs mcp
  node scripts/chatgpt-bridge.mjs serve --port 8791 --token-file bridge-token.txt [--public-url https://your-host/mcp]

BLACKICE must be open. --url http://127.0.0.1:PORT overrides desktop discovery.
A local-command connector such as Avalon can run status/list/get and complete.
Write the actual answer to a UTF-8 file, then pass that file to complete.
For completion, keep the id and revision from get. Identical retries are safe; a different
answer or a cancelled request is rejected. Never claim completion before confirmation.

mcp uses newline-delimited JSON-RPC over stdio. serve explicitly starts a loopback HTTP
MCP adapter; expose /mcp through your HTTPS tunnel and configure its bearer token in the
connector. BLACKICE_BRIDGE_TOKEN is an alternative to --token-file. This adapter never
uses an OpenAI API key and does not initiate or wake a ChatGPT conversation.
`;
const problem=message=>{throw new Error(message);};
export function parseBridgeArguments(argv){
  const command=argv[0]||'help',args=[],options={};
  for(let index=1;index<argv.length;index++){
    const item=argv[index];
    if(!item.startsWith('--')){args.push(item);continue;}
    const key=item.slice(2);
    if(!['url','status','limit','offset','revision','answer-file','input-file','stdin','port','token-file','public-url'].includes(key))problem(`Unknown option ${item}.`);
    if(Object.hasOwn(options,key))problem(`Supply ${item} only once.`);
    if(key==='stdin'){options[key]=true;continue;}
    const value=argv[++index];if(!value||value.startsWith('--'))problem(`${item} needs a value.`);options[key]=value;
  }
  return {command,args,options};
}
function number(value,label,{minimum=0}={}){if(!/^\d+$/.test(value||''))problem(`${label} must be a whole number.`);const result=Number(value);if(!Number.isSafeInteger(result)||result<minimum)problem(`${label} is out of range.`);return result;}
function allow(options,keys){for(const key of Object.keys(options))if(key!=='url'&&!keys.includes(key))problem(`--${key} is not supported for this command.`);}
function id(args){if(args.length!==1||!/^[a-zA-Z0-9_-]{1,120}$/.test(args[0]))problem('Supply the exact request id returned by BLACKICE.');return args[0];}
const json=value=>process.stdout.write(JSON.stringify(value,null,2)+'\n');

export async function runBridgeCLI(argv=process.argv.slice(2)){
  const {command,args,options}=parseBridgeArguments(argv);
  if(['help','--help','-h'].includes(command)){process.stdout.write(BRIDGE_HELP);return;}
  if(!['status','list','get','request','complete','cancel','mcp','serve'].includes(command))problem('Choose a bridge command from --help.');
  const client=new BlackiceBridgeClient({url:await resolveBlackiceURL({url:options.url})});
  if(command==='status'){allow(options,[]);if(args.length)problem('status takes no request id.');const result=await client.request('/api/chatgpt-bridge');json({bridge:result.status,url:client.url});return;}
  if(command==='list'){allow(options,['status','limit','offset']);if(args.length)problem('list takes no request id.');const query=new URLSearchParams({status:options.status||'pending',...(options.limit?{limit:String(number(options.limit,'limit',{minimum:1}))}:{}),...(options.offset?{offset:String(number(options.offset,'offset'))}:{})});json(await client.request('/api/chatgpt-bridge/requests?'+query));return;}
  if(command==='get'){allow(options,[]);json(await client.request('/api/chatgpt-bridge/requests/'+id(args)));return;}
  if(command==='request'){
    allow(options,['input-file','stdin']);if(args.length||Boolean(options['input-file'])===Boolean(options.stdin))problem('Use exactly one of --input-file or --stdin for a JSON request.');
    const input=await readBridgeInput(options['input-file']);let payload;try{payload=JSON.parse(input.replace(/^\uFEFF/,''));}catch{problem('The request input must be valid UTF-8 JSON.');}
    json(await client.request('/api/chatgpt-bridge/requests',{method:'POST',body:payload}));return;
  }
  if(command==='complete'||command==='cancel'){
    allow(options,command==='complete'?['revision','answer-file','stdin']:['revision']);const requestId=id(args),revision=number(options.revision,'revision',{minimum:1});
    let answer;
    if(command==='complete'){if(Boolean(options['answer-file'])===Boolean(options.stdin))problem('Use exactly one of --answer-file or --stdin for the actual answer.');answer=(await readBridgeInput(options['answer-file'],{maximum:1024*1024})).replace(/^\uFEFF/,'');}
    json(await client.request(`/api/chatgpt-bridge/requests/${requestId}/${command}`,{method:'POST',body:{revision,...(answer===undefined?{}:{answer})}}));return;
  }
  if(command==='mcp'){
    allow(options,[]);if(args.length)problem('mcp takes no request id.');
    process.stdin.setEncoding('utf8');let buffer='';
    // Sequential admission prevents a completion overtaking its request retrieval.
    for await(const chunk of process.stdin){buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)>3*1024*1024)problem('MCP input exceeds 3 MiB.');let boundary;
      while((boundary=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,boundary).trim();buffer=buffer.slice(boundary+1);if(!line)continue;let message,result;
        try{message=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON.'}})+'\n');continue;}
        try{result=await client.rpc(message);}catch(error){result={jsonrpc:'2.0',id:typeof message?.id==='string'||typeof message?.id==='number'?message.id:null,error:{code:-32000,message:error.message}};}
        if(result!==null)process.stdout.write(JSON.stringify(result)+'\n');
      }
    }
    if(buffer.trim())problem('MCP messages must end with a newline.');return;
  }
  allow(options,['port','token-file','public-url']);if(args.length)problem('serve takes no request id.');
  const token=validateBridgeToken(options['token-file']?(await readFile(options['token-file'],'utf8')).trim():process.env.BLACKICE_BRIDGE_TOKEN);
  const adapter=createBridgeMCPHTTPServer({client,token,port:options.port?number(options.port,'port',{minimum:1024}):8791,publicURL:options['public-url']});
  const url=await adapter.listen();process.stderr.write(`BLACKICE MCP bridge listening at ${url}\n`);
  const stop=async()=>{await adapter.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)runBridgeCLI().catch(error=>{process.stderr.write(`BLACKICE bridge: ${error.message}\n`);process.exitCode=1;});
