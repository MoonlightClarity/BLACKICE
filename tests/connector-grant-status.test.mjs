import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createGeminiConnectorSettings} from '../public/next/workspaces/settings-gemini-connector.mjs';
import {createClaudeConnectorSettings} from '../public/next/workspaces/settings-claude-connector.mjs';
for(const [name,factory] of [['Google',createGeminiConnectorSettings],['Claude',createClaudeConnectorSettings]]){
 for(const available of [true,false])test(name+' distinguishes saved access from live availability: '+available,async t=>{
  const dom=planningDOM(t),calls=[];
  const panel=factory({mount:dom.mount,api:async(route,method='GET')=>{calls.push({route,method});return {available,oauth:{healthy:true,grants:[{kind:'mcp',label:name,id:'fixture'}],requests:[]}};}});
  t.after(()=>panel.destroy());panel.enter();await new Promise(r=>setImmediate(r));
  assert.ok(dom.mount.textContent.includes(name+': '+(available?'Access approved; verify tools in the app':'Unavailable')));
  assert.deepEqual(calls,[{route:'/api/chatgpt-connector',method:'GET'}]);
 });
}
