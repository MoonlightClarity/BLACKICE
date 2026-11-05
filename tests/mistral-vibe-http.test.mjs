import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable,Writable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

class Runtime extends EventEmitter {
  constructor(){super();this.calls=[];this.provider={id:'mistral-vibe',name:'Mistral Vibe Code',installed:true,connected:false,authenticated:false,available:false,models:[],loginState:'idle'};}
  status(){return {connected:false,authenticated:false,activeTurns:0,models:this.provider.models.map(m=>({...m,id:'mistral-vibe::'+m.id})),subscriptionProviders:[this.provider],defaultModel:'original-codex'};}
  mistralVibeStatus(){return structuredClone(this.provider);}
  async refreshMistralVibe(options){this.calls.push({action:'refresh',options});this.provider={...this.provider,authenticated:true,connected:true,available:true,models:[{id:'actual-cli-alias',displayName:'CLI choice'}]};return this.mistralVibeStatus();}
  async beginMistralVibeLogin(){this.calls.push({action:'login'});this.provider.loginState='waiting';return {state:'waiting',url:'https://console.mistral.ai/fixture-native-login'};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){assert.fail('Account setup must not start inference.');}
}
class ResponseCapture extends Writable {
  constructor(){super();this.headers={};this.parts=[];this.statusCode=200;}
  setHeader(name,value){this.headers[name.toLowerCase()]=value;}
  writeHead(status,headers={}){this.statusCode=status;for(const [name,value]of Object.entries(headers))this.setHeader(name,value);this.headersSent=true;}
  _write(part,_encoding,done){this.parts.push(Buffer.from(part));done();}
}
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-vibe-native-http-')),runtime=new Runtime();
  const desktop=new EventEmitter();desktop.status=()=>({available:false,enabled:false});desktop.setEnabled=async()=>desktop.status();
  const app=await createHarnessServer({port:0,runtime,desktop,dataDir:path.join(directory,'data'),defaultCwd:path.join(directory,'workspace'),remoteAccess:false,autoAttachDesktop:false,emailExecutableHint:null});
  const browserCalls=[],tabs=[];
  app.browser.status=()=>({available:true,tabs});
  app.browser.perform=async(args,options)=>{browserCalls.push({args,options});const tabId=args.tabId||'fixture-native-login-tab';if(args.action==='open')tabs.push({tabId,url:args.url});return {tabId};};
  t.after(async()=>{app.endRestart();app.endMaintenance();await app.close();await rm(directory,{recursive:true,force:true});});
  const handler=app.server.listeners('request')[0];let cookie;
  const request=async(url,{body,method=body===undefined?'GET':'POST'}={})=>{
    const raw=body===undefined?undefined:JSON.stringify(body),req=Readable.from(raw===undefined?[]:[Buffer.from(raw)]);
    req.url=url;req.method=method;req.headers={host:'127.0.0.1:0',...(cookie?{cookie}:{}),...(raw===undefined?{}:{'content-type':'application/json','content-length':String(Buffer.byteLength(raw))})};
    const res=new ResponseCapture();await handler(req,res);const text=Buffer.concat(res.parts).toString();
    return {status:res.statusCode,data:res.headers['content-type']?.includes('application/json')?JSON.parse(text):text,headers:res.headers};
  };
  const home=await request('/');cookie=home.headers['set-cookie'].split(';')[0];
  return {runtime,request,app,browserCalls,tabs,directory};
}

test('native account status is read-only and refresh returns exact discovered models without changing the default',async t=>{
  const {runtime,request,browserCalls,directory}=await fixture(t);
  const before=await request('/api/subscriptions/mistral-vibe');
  assert.equal(before.status,200);assert.equal(before.data.provider.authenticated,false);
  assert.deepEqual(runtime.calls,[]);assert.deepEqual(browserCalls,[]);
  const result=await request('/api/subscriptions/mistral-vibe/refresh',{body:{}});
  assert.equal(result.status,200);assert.equal(result.data.provider.models[0].id,'actual-cli-alias');
  assert.equal(result.data.status.defaultModel,'original-codex');
  assert.deepEqual(runtime.calls,[{action:'refresh',options:{cwd:path.join(directory,'workspace')}}]);
  assert.deepEqual(browserCalls,[]);
});

test('native sign-in opens the official delegated address in BLACKICE and reuses only its own tab',async t=>{
  const {runtime,request,browserCalls}=await fixture(t);
  const first=await request('/api/subscriptions/mistral-vibe/login',{body:{}});
  assert.equal(first.status,200);assert.equal(first.data.browserTabId,'fixture-native-login-tab');
  assert.equal(first.data.login.state,'waiting');assert.equal(Object.hasOwn(first.data.login,'url'),false);
  assert.deepEqual(browserCalls,[{args:{action:'open',url:'https://console.mistral.ai/fixture-native-login'},options:{source:'user'}}]);
  await request('/api/subscriptions/mistral-vibe/login',{body:{}});
  assert.equal(browserCalls[1].args.action,'tab_select');
  assert.equal(runtime.status().defaultModel,'original-codex');
});

test('concurrent sign-in requests share one native attempt and one contained tab',async t=>{
  const {runtime,request,browserCalls}=await fixture(t);let release,calls=0;
  runtime.beginMistralVibeLogin=()=>{calls++;return new Promise(resolve=>{release=()=>resolve({state:'waiting',url:'https://console.mistral.ai/fixture-native-login'});});};
  const first=request('/api/subscriptions/mistral-vibe/login',{body:{}});
  const second=request('/api/subscriptions/mistral-vibe/login',{body:{}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  release();const results=await Promise.all([first,second]);
  assert.equal(results[0].data.browserTabId,results[1].data.browserTabId);
  assert.equal(browserCalls.length,1);
});

test('native routes do not accept API settings or start login on read',async t=>{
  const {runtime,request,browserCalls}=await fixture(t);
  for(const action of ['refresh','login']){
    assert.equal((await request('/api/subscriptions/mistral-vibe/'+action)).status,405);
    assert.equal((await request('/api/subscriptions/mistral-vibe/'+action,{body:{apiKey:'fixture-not-a-key'}})).status,400);
    assert.equal((await request('/api/subscriptions/mistral-vibe/'+action,{body:{model:'guessed'}})).status,400);
  }
  assert.deepEqual(runtime.calls,[]);assert.deepEqual(browserCalls,[]);
});

test('failed native sign-in can be retried and never opens an invalid address',async t=>{
  const {runtime,request,browserCalls}=await fixture(t);
  runtime.beginMistralVibeLogin=async()=>({state:'waiting',url:'http://insecure.invalid/auth'});
  const bad=await request('/api/subscriptions/mistral-vibe/login',{body:{}});
  assert.equal(bad.status,400);assert.deepEqual(browserCalls,[]);
  runtime.beginMistralVibeLogin=async()=>({state:'waiting',url:'https://console.mistral.ai/fixture-native-login'});
  const result=await request('/api/subscriptions/mistral-vibe/login',{body:{}});
  assert.equal(result.status,200);assert.equal(browserCalls.length,1);
});
