import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {CHATGPT_BRIDGE_PROTOCOL_VERSION} from './chatgpt-bridge-protocol.mjs';

const MAX_WIRE_BYTES=3*1024*1024;
// MCP returns both structured content and its text representation. JSON escaping
// can expand each; keep response capacity distinct from request admission.
const MAX_RESPONSE_BYTES=16*1024*1024;
const fault=(message,status=400,details={})=>Object.assign(new Error(message),{status,...details});
export function validateBlackiceURL(value){
  let url;try{url=new URL(value);}catch{throw fault('Choose the local URL shown by BLACKICE.');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw fault('The bridge connects only to a local BLACKICE server at http://127.0.0.1:PORT or http://localhost:PORT.');
  return url.origin;
}
export async function resolveBlackiceURL({url,env=process.env,profileDir}={}){
  if(url||env.BLACKICE_BRIDGE_URL)return validateBlackiceURL(url||env.BLACKICE_BRIDGE_URL);
  const profile=profileDir||path.join(env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),'Relay');
  try{
    const marker=path.join(profile,'desktop-runtime.json');
    if((await stat(marker)).size>16384)throw fault('BLACKICE runtime information is invalid. Reopen BLACKICE.');
    const runtime=JSON.parse(await readFile(marker,'utf8'));
    if(typeof runtime.url!=='string')throw fault('BLACKICE runtime information is incomplete. Reopen BLACKICE.');
    return validateBlackiceURL(runtime.url);
  }catch(error){if(error.code!=='ENOENT')throw fault('Could not read BLACKICE runtime information. Reopen BLACKICE or supply --url.');}
  return 'http://127.0.0.1:4317';
}
async function readBounded(stream,maximum=MAX_WIRE_BYTES){
  const chunks=[];let size=0;
  for await(const value of stream){const chunk=Buffer.from(value);size+=chunk.length;if(size>maximum)throw fault('The bridge response is too large.',413);chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}

/** Talks only to the user's already-running BLACKICE server. Cookies never leave loopback. */
export class BlackiceBridgeClient{
  constructor({url,fetchImpl=fetch,timeoutMs=15000}={}){this.url=validateBlackiceURL(url);this.fetch=fetchImpl;this.timeoutMs=timeoutMs;this.cookie=null;this.connecting=null;}
  async readLocal(route,options={},maximum=MAX_RESPONSE_BYTES){
    const mutation=!['GET','HEAD'].includes((options.method||'GET').toUpperCase()),controller=new AbortController();
    let timer,timedOut=false;
    const timeoutError=()=>fault(`Connector timed out while waiting for BLACKICE at ${this.url}. ${mutation?'The request may have been saved. Check its saved status before retrying; do not repeat the task automatically.':'Keep BLACKICE open, then try reading the saved status again.'}`,504,{code:'CHATGPT_BRIDGE_TIMEOUT',timedOut:true,uncertain:mutation});
    // Bound the entire transfer, including its body. A host timing out elsewhere
    // or a request staying pending is not evidence that this deadline expired.
    const transfer=(async()=>{
      const response=await this.fetch(new URL(route,this.url),{...options,redirect:'error',signal:controller.signal});
      return {response,text:await readBounded(response.body,maximum)};
    })();
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(timeoutError());},this.timeoutMs);});
    try{return await Promise.race([transfer,deadline]);}
    catch(error){
      if(timedOut)throw timeoutError();
      if(error?.status)throw Object.assign(error,{uncertain:mutation});
      const interrupted=error?.name==='AbortError';
      throw fault(`${interrupted?'The BLACKICE bridge request was interrupted.':`BLACKICE is not reachable at ${this.url}.`}${mutation?' The request may have been saved. Keep BLACKICE open and check its saved status before retrying; do not repeat the task automatically.':' Open BLACKICE and try reading the saved status again.'}`,503,{code:interrupted?'CHATGPT_BRIDGE_INTERRUPTED':'CHATGPT_BRIDGE_UNREACHABLE',timedOut:false,uncertain:mutation,cause:error});
    }finally{clearTimeout(timer);}
  }
  async connect(){
    if(this.cookie)return;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      const {response:health,text}=await this.readLocal('/health',{},16384);
      let value;try{value=JSON.parse(text);}catch{throw fault('The local address did not return a BLACKICE server.',503);}
      if(!health.ok||value.app!=='relay-agent-harness'||value.ok!==true)throw fault('The local address is not a ready BLACKICE server.',503);
      const {response:home}=await this.readLocal('/',{},256*1024);
      const name=`relay_session_${new URL(this.url).port||80}`;
      const cookie=home.headers.get('set-cookie')?.match(new RegExp(`(?:^|,\\s*)(${name}=[a-f0-9]{64})(?:;|$)`))?.[1];
      if(!home.ok||!cookie)throw fault('BLACKICE could not establish a local bridge session. Reopen the app.',503);
      this.cookie=cookie;
    })();
    try{await this.connecting;}finally{this.connecting=null;}
  }
  async request(route,{method='GET',body}={},retry=true){
    if(!/^\/api\/chatgpt-bridge(?:\/|$)/.test(route))throw fault('This client only exposes the BLACKICE ChatGPT bridge.');
    await this.connect();
    const {response,text}=await this.readLocal(route,{method,headers:{Cookie:this.cookie,Accept:'application/json',...(route==='/api/chatgpt-bridge/mcp'?{'MCP-Protocol-Version':CHATGPT_BRIDGE_PROTOCOL_VERSION}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.status===401&&retry){this.cookie=null;return this.request(route,{method,body},false);}
    if(response.status===202&&!text)return null;
    let value;try{value=JSON.parse(text);}catch{throw fault('BLACKICE returned an unreadable bridge response.',502);}
    if(!response.ok)throw fault(value.error||'BLACKICE could not complete the bridge request.',response.status);
    return value;
  }
  rpc(message){return this.request('/api/chatgpt-bridge/mcp',{method:'POST',body:message});}
}

function equal(first,second){const a=Buffer.from(first||''),b=Buffer.from(second||'');return a.length===b.length&&timingSafeEqual(a,b);}
export function validateBridgeToken(value){
  if(typeof value!=='string'||value.length<32||value.length>512||!/^[A-Za-z0-9._~+\/-]+={0,2}$/.test(value))throw fault('Supply a bridge bearer token of at least 32 characters using --token-file or BLACKICE_BRIDGE_TOKEN.');
  return value;
}
/** Optional authenticated HTTP adapter, started explicitly by its owner or their MCP host. */
export function createBridgeMCPHTTPServer({client,token,port=8791,publicURL}={}){
  validateBridgeToken(token);
  if(!Number.isInteger(port)||port<0||port>65535)throw fault('Choose a valid bridge port.');
  let publicOrigin;
  if(publicURL){const url=new URL(publicURL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['/','/mcp'].includes(url.pathname))throw fault('Use the HTTPS origin or /mcp URL of your tunnel.');publicOrigin=url.origin;}
  let boundPort=port;
  const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    const host=req.headers.host||'',allowed=new Set([`127.0.0.1:${boundPort}`,`localhost:${boundPort}`,...(publicOrigin?[new URL(publicOrigin).host]:[])]);
    if(!allowed.has(host))return reply(res,403,{error:'Unexpected bridge host.'});
    const origin=req.headers.origin;
    if(origin&&origin!==`http://${host}`&&origin!==publicOrigin)return reply(res,403,{error:'Unexpected bridge origin.'});
    if(req.headers['sec-fetch-site']==='cross-site')return reply(res,403,{error:'Cross-site requests are not accepted.'});
    if(req.url!=='/mcp')return reply(res,404,{error:'Use the /mcp endpoint.'});
    if(!equal(req.headers.authorization,`Bearer ${token}`))return reply(res,401,{error:'The bridge requires its bearer token.'});
    if(req.headers['mcp-protocol-version']&&req.headers['mcp-protocol-version']!==CHATGPT_BRIDGE_PROTOCOL_VERSION)return reply(res,400,{error:`Use MCP protocol ${CHATGPT_BRIDGE_PROTOCOL_VERSION} negotiated during initialize.`});
    if(req.method!=='POST'){res.setHeader('Allow','POST');return reply(res,405,{error:'This stateless MCP endpoint accepts POST requests.'});}
    if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return reply(res,415,{error:'Send application/json.'});
    let message;
    try{const text=await readBounded(req);try{message=JSON.parse(text);}catch{return reply(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON.'}});}
      const result=await client.rpc(message);
      if(result===null){res.writeHead(202,{'Cache-Control':'no-store'});return res.end();}
      return reply(res,200,result);
    }catch(error){return reply(res,error.status||503,{jsonrpc:'2.0',id:typeof message?.id==='string'||typeof message?.id==='number'?message.id:null,error:{code:-32000,message:error.message}});}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  return {server,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});boundPort=server.address().port;return `http://127.0.0.1:${boundPort}/mcp`;},async close(){server.closeAllConnections();if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}

export async function readBridgeInput(file,{stdin=process.stdin,maximum=MAX_WIRE_BYTES}={}){
  if(file){if((await stat(file)).size>maximum)throw fault('The supplied bridge input is too large.',413);return readFile(file,'utf8');}
  return readBounded(stdin,maximum);
}
