import {createBridgeMCPHTTPServer} from './chatgpt-bridge-client.mjs';
import {handleChatGPTBridgeRPC} from './chatgpt-bridge-protocol.mjs';

const quote=(value,platform)=>platform==='win32'?`'${value.replaceAll("'","''")}'`:`'${value.replaceAll("'", "'\\''")}'`;

/** Optional MCP listener belongs to the app lifetime; settings never start a system service. */
export class ChatGPTBridgeConnection{
  constructor({settings,store,localURL,cliPath,available=()=>true,platform=process.platform}){
    this.settings=settings;this.store=store;this.localURL=localURL;this.cliPath=cliPath;this.available=available;this.platform=platform;
    this.listener=null;this.signature=null;this.lastError=null;this.closed=false;this.writeChain=Promise.resolve();
  }
  snapshot(){
    const config=this.settings.get(),health=this.settings.status();
    const command=`node ${quote(this.cliPath,this.platform)}`;
    const target=`--url ${quote(this.localURL(),this.platform)}`;
    const localUrl=`http://127.0.0.1:${config.port}/mcp`;
    const routeInstructions=config.mode==='connector'
      ?`Use a ChatGPT connector that can run a local command, such as Avalon. Configure its name here as ${config.connectorName}. Keep BLACKICE open. The bridge handoff tells that connector to run ${command} get REQUEST_ID ${target}, then save the answer using ${command} complete REQUEST_ID --revision REVISION --answer-file PATH ${target}. The connector needs access to this BLACKICE installation. No OpenAI API key is used by this handoff.`
      :`Enable the MCP connection and keep BLACKICE open. Forward only ${localUrl} through an HTTPS tunnel or reverse proxy. Enter its public /mcp URL here, then connect that URL in a ChatGPT connector named ${config.connectorName}, using the connection token from this panel as a bearer token. Refresh the connector's tools after connecting. For a local MCP host, copy the stdio configuration instead. Queue a task and send the handoff in ChatGPT; this connection does not initiate a ChatGPT conversation.`;
    const approvalInstructions=config.approvalMode==='confirm'
      ?'Each handoff asks ChatGPT to check the current conversation for explicit approval of the same steps for that exact request. Reuse known scoped approval and its retries without asking again. Only when that approval is absent should ChatGPT ask once before reading the request or using bridge tools.'
      :'Sending a handoff authorizes reading that exact request, performing its task within your existing instructions, and saving its answer. The handoff asks ChatGPT to reuse that approval for routine bridge steps and retries, and to ask if the scope changes.';
    const instructions=`${routeInstructions}\n\nKeep the handoff in ChatGPT Chat Mode using the configured connector. Do not request or suggest a move to Work Mode, and do not switch modes automatically. If a capability is missing, explain the exact blocker in Chat Mode. BLACKICE checks returned answers for requests to switch modes; a rejected answer leaves the request pending.\n\n${approvalInstructions} ChatGPT or your connector may still require a platform tool confirmation. BLACKICE cannot bypass that confirmation.`;
    return {
      config,health,
      local:{url:this.localURL(),cliPath:this.cliPath,nodeCommand:'node',platform:this.platform},
      connection:{enabled:config.enabled,listening:Boolean(this.listener),localUrl,error:this.lastError||health.error||null},
      setup:{instructions,stdioConfig:{mcpServers:{blackice:{command:'node',args:[this.cliPath,'mcp','--url',this.localURL()]}}},launchCommand:command,publicMcpUrl:config.publicMcpUrl},
    };
  }
  reconcile(){
    const operation=this.writeChain.then(async()=>{
      if(this.closed)return;
      const config=this.settings.get();
      const signature=JSON.stringify({enabled:config.enabled&&config.mode==='mcp'&&this.settings.status().healthy,port:config.port,publicMcpUrl:config.publicMcpUrl});
      if(this.signature===signature&&this.listener)return;
      if(this.listener){await this.listener.close();this.listener=null;}
      this.signature=null;this.lastError=null;
      if(!config.enabled||config.mode!=='mcp'||!this.settings.status().healthy)return;
      let listener;
      try{
        const token=await this.settings.token();
        listener=createBridgeMCPHTTPServer({token,port:config.port,publicURL:config.publicMcpUrl||undefined,client:{rpc:async message=>{
          if(!this.available()||this.closed)throw Object.assign(new Error('BLACKICE is closing for maintenance. Try again after it reopens.'),{status:503});
          if(!this.settings.status().healthy||!this.settings.get().enabled||this.settings.get().mode!=='mcp')throw Object.assign(new Error('The BLACKICE MCP connection is disabled or needs its settings repaired.'),{status:503});
          return handleChatGPTBridgeRPC(this.store,message);
        }}});
        await listener.listen();this.listener=listener;this.signature=signature;
      }catch(error){await listener?.close().catch(()=>{});this.lastError=error.code==='EADDRINUSE'?`Port ${config.port} is already in use. Choose another bridge port and save again.`:`The MCP connection could not start: ${error.message}`;}
    });
    this.writeChain=operation.catch(()=>{});return operation;
  }
  async close(){this.closed=true;await this.writeChain;await this.listener?.close();this.listener=null;this.signature=null;}
}
