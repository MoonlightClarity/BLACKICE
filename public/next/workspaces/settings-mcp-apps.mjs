const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderMcpApps(current={},busy=false,message='') {
 const button=(action,label,id='')=>'<button type="button" data-mcp-action="'+action+'" data-mcp-id="'+escape(id)+'"'+(busy?' disabled':'')+'>'+label+'</button>';
 return '<section class="next-card"><h2>Connect another MCP app</h2><p class="next-help">Add the shared endpoint in your app, then approve its matching request here.</p><details><summary>Client compatibility and requirements</summary><p class="next-help">Use this shared endpoint in an app that supports Streamable HTTP, OAuth authorization code with PKCE S256, resource indicators, and dynamic client registration (RFC 7591). Registered callbacks currently require HTTPS. A listed brand is not required; compatibility still depends on the client.</p><p class="next-help">Clients using only local stdio, HTTP loopback callbacks, or arbitrary CIMD client URLs are not supported by this incoming connection. ChatGPT and Claude have specific CIMD support. To connect a tool server to BLACKICE instead, use Settings → Tools.</p></details><p>Shared MCP endpoint: <code>'+escape(current.endpoint||current.setup?.serverUrl||'Not prepared yet. Use the ChatGPT setup guide to prepare the shared endpoint.')+'</code></p>'+button('refresh','Check status')+'<p role="status">'+escape(message)+'</p></section>'
 +'<section class="next-card"><h3>Requests from all apps</h3><p class="next-help">Client names are supplied by apps, not verified identities. Check the callback and matching request code. Connecting grants full BLACKICE MCP access: files, browser, commands, and plans.</p>'
 +(current.oauth?.requests||[]).map(r=>'<article><strong>'+escape(r.clientLabel||'MCP client')+'</strong><p>Callback origin: '+escape(r.clientOrigin)+'<br>Code: <code>'+escape(r.displayCode)+'</code></p>'+button('approve','Connect with full BLACKICE access',r.id)+button('decline','Decline',r.id)+'</article>').join('')
 +(!(current.oauth?.requests||[]).length?'<p class="next-help">No pending requests. Start the connection in your app.</p>':'')+'</section>'
 +'<section class="next-card"><h3>Connected apps</h3>'+(current.oauth?.grants||[]).map(g=>'<article><strong>'+escape(g.label||'MCP client')+'</strong><p class="next-help">Connection: '+escape(g.id)+'</p>'+button('disconnect','Disconnect this app',g.id)+'</article>').join('')+(!(current.oauth?.grants||[]).length?'<p class="next-help">No active connections.</p>':'')+'</section>';
}
export function createMcpAppsSettings({mount,api,notify=()=>{}}) {
 let current={},active=false,destroyed=false,busy=false,loading=false,message='',timer,epoch=0;
 const render=()=>{if(active&&!destroyed)mount.innerHTML=renderMcpApps(current,busy||loading,message);};
 async function refresh() {
  if(!active||destroyed||busy||loading)return;
  const token=epoch;loading=true;
  try {const next=await api('/api/chatgpt-connector');if(token===epoch)current=next;}
  catch(e){if(token===epoch)message=e.message;}
  finally {loading=false;if(token===epoch)render();}
 }
 async function act(action,id) {
  if(!active||destroyed||busy||loading)return;
  if(action==='refresh')return refresh();
  if(!['approve','decline','disconnect'].includes(action))return;
  const token=epoch;busy=true;message='';render();
  try {
   const latest=await api('/api/chatgpt-connector');
   if(!active||destroyed||token!==epoch)return;
   // Never act on a record merely because a stale card remains visible.
   const record=(action==='disconnect'?latest.oauth?.grants:latest.oauth?.requests)?.find(x=>x.id===id);
   if(!record)throw Error('This connection or request changed. Refresh and review it again.');
   const suffix=action==='approve'?'approve-access':action==='decline'?'reject-access':'revoke';
   await api('/api/chatgpt-connector/'+suffix,'POST',{id,...(action==='approve'?{scopes:record.scopes||['read']}:{})});
   message=action==='approve'?'Access connected. Finish returning to the requesting app.':action==='decline'?'Request declined.':'This app disconnected. Other connections are unchanged.';
   current=await api('/api/chatgpt-connector');
  }catch(e){message=e.message;notify(message,true);}
  finally{busy=false;render();}
 }
 const click=e=>{const b=e.target.closest('[data-mcp-action]');if(b&&mount.contains(b))void act(b.dataset.mcpAction,b.dataset.mcpId);};
 mount.addEventListener('click',click);
 return {
  enter(){if(active||destroyed)return;active=true;epoch++;render();void refresh();timer=setInterval(()=>{if(document.visibilityState!=='hidden')void refresh();},10000);timer.unref?.();},
  leave(){active=false;epoch++;clearInterval(timer);},
  destroy(){active=false;destroyed=true;epoch++;clearInterval(timer);mount.removeEventListener('click',click);mount.replaceChildren();},
  updateStatus(){}
 };
}
