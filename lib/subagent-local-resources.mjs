import {isIP} from 'node:net';
/** Detect when independent inference workers would contend for one host's resources. */
export function modelUsesLocalResources(model='',endpoint=''){
 const provider=String(model||'').split('::')[0].trim().toLowerCase();
 if(/^(ollama|lmstudio|lm-studio|llamacpp|llama\.cpp|koboldcpp|local|local-models|jan|text-generation-webui)$/.test(provider))return true;
 try{
  const host=new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(host==='localhost'||host.endsWith('.local'))return true;
  const family=isIP(host);
  if(family===4){
   const [a,b]=host.split('.').map(Number);
   return a===127||a===10||a===192&&b===168||a===172&&b>=16&&b<=31||host==='0.0.0.0';
  }
  if(family===6)return host==='::1'||host.startsWith('fc')||host.startsWith('fd')||/^fe[89ab]/.test(host);
 }catch{}
 return false;
}
