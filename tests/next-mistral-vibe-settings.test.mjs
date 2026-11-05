import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createSubscriptionModelSettings} from '../public/next/workspaces/settings-subscriptions.mjs';
import {chatOptionChoices,validateChatOptions} from '../public/next/chat/options-model.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;return{promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};};
const native=extra=>({id:'mistral-vibe',name:'Mistral Vibe Code',type:'subscription-cli',installed:true,connected:false,authenticated:false,available:false,models:[],defaultModel:null,cliVersion:'fixture-version',lastError:null,loginState:'idle',...extra});
const status=value=>({codex:{connected:true,authenticated:true},defaultModel:'gpt-6-luna',defaultModelSelection:'gpt-6-luna',models:[{id:'gpt-6-luna',available:true}],subscriptionProviders:[value]});
const exactModel={id:'fixture-vibe-model/2026:exact',name:'Fixture Vibe model'};
function fixture(t,{initial=status(native()),hook}={}){
  const dom=planningDOM(t),calls=[],updates=[],lifecycle={entered:0,left:0},state={status:initial};
  dom.mount.replaceChildren=function(...nodes){for(const child of [...this.children])child.remove();this.textContent='';this.append(...nodes);};
  const api=async(route,method='GET',body)=>{
    const call={route,method,body};calls.push(call);
    const custom=hook?.(call,state);if(custom!==undefined)return custom;
    if(route==='/api/status')return structuredClone(state.status);
    throw Error('Unexpected native account request: '+route);
  };
  const panel=createSubscriptionModelSettings({mount:dom.mount,api,onStatus:value=>updates.push(value)},({mount})=>{
    const input=dom.element('input');input.id='fixture-api-draft';input.value='Keep my API draft';mount.append(input);
    return{enter(){lifecycle.entered++;},leave(){lifecycle.left++;},destroy(){}};
  });
  t.after(()=>panel.destroy());panel.enter();
  return{...dom,panel,state,calls,updates,lifecycle,writes:()=>calls.filter(call=>call.method!=='GET')};
}

test('native Mistral account settings are separate from optional API keys and opening them is read-only',async t=>{
  const f=fixture(t);await settle();
  const card=f.$('#next-mistral-vibe'),apis=f.$('#next-connect-another-endpoint');
  assert.equal(card.querySelector('h2').textContent,'Mistral Vibe Code');
  assert.match(card.textContent,/native account connection is separate from Mistral API keys/);
  assert.equal(card.querySelector('input'),null);assert.equal(card.querySelector('a'),null);
  assert.match(apis.querySelector('summary').textContent,/Optional API connections/);
  assert.equal(apis.contains(card),false);assert.equal(f.$('#next-mistral-vibe-login').disabled,false);
  assert.match(f.$('#next-mistral-vibe-status').textContent,/Sign in to your Mistral account/);
  assert.equal(f.$('#next-mistral-vibe-catalog').hidden,true);assert.deepEqual(f.writes(),[]);
  f.panel.focusProvider('mistral-vibe');assert.equal(f.document.activeElement,card);
  f.panel.leave();f.panel.enter();await settle();assert.equal(f.$('#fixture-api-draft').value,'Keep my API draft');
  assert.equal(f.lifecycle.entered,2);assert.equal(f.lifecycle.left,1);assert.deepEqual(f.writes(),[]);
});

test('explicit account login and refresh use native routes and expose only the exact reported catalog',async t=>{
  const waiting=status(native({loginState:'waiting'})),ready=status(native({connected:true,authenticated:true,available:true,loginState:'complete',models:[exactModel],defaultModel:exactModel.id}));
  const f=fixture(t,{hook:(call,state)=>{
    if(call.route==='/api/subscriptions/mistral-vibe/login'){state.status=waiting;return{provider:waiting.subscriptionProviders[0],status:waiting,login:{state:'waiting'},browserTabId:'fixture-contained-tab'};}
    if(call.route==='/api/subscriptions/mistral-vibe/refresh'){state.status=ready;return{provider:ready.subscriptionProviders[0],status:ready};}
  }});await settle();
  await f.click('#next-mistral-vibe-login');
  assert.match(f.$('#next-mistral-vibe-status').textContent,/Complete sign-in in BLACKICE/);
  assert.equal(f.$('#next-mistral-vibe-login').disabled,true);assert.equal(f.$('#next-mistral-vibe-catalog').hidden,true);
  await f.click('#next-mistral-vibe-refresh');
  assert.match(f.$('#next-mistral-vibe-status').textContent,/Ready.*1 model reported/);
  assert.deepEqual(f.$('#next-mistral-vibe-models').children.map(node=>node.textContent),['Fixture Vibe model · '+exactModel.id]);
  assert.equal(f.$('#next-mistral-vibe-catalog').hidden,false);
  assert.deepEqual(f.writes().map(call=>[call.route,call.method,call.body]),[
    ['/api/subscriptions/mistral-vibe/login','POST',{}],['/api/subscriptions/mistral-vibe/refresh','POST',{}],
  ]);
  assert.deepEqual(f.updates,[waiting,ready]);assert.equal(f.state.status.defaultModelSelection,'gpt-6-luna');
  assert.equal(f.$('#fixture-api-draft').value,'Keep my API draft');
  assert.equal(f.calls.some(call=>/models\/default|providers|browser\/open/.test(call.route)),false);
});

test('fresh runtime status beats a stale account read, while installed, auth and catalog readiness stay distinct',async t=>{
  const gate=deferred();const f=fixture(t,{hook:call=>call.route==='/api/status'?gate.promise:undefined});
  const ready=status(native({connected:true,authenticated:true,available:true,models:[exactModel]}));f.panel.updateStatus(ready);
  gate.resolve(status(native({installed:false})));await settle();
  assert.match(f.$('#next-mistral-vibe-status').textContent,/Ready/);assert.match(f.$('#next-mistral-vibe-models').textContent,/fixture-vibe-model\/2026:exact/);
  f.panel.updateStatus(status(native({installed:false,lastError:'Install the official CLI.'})));
  assert.match(f.$('#next-mistral-vibe-status').textContent,/not installed/);assert.equal(f.$('#next-mistral-vibe-login').disabled,true);
  await f.click('#next-mistral-vibe-login');assert.deepEqual(f.writes(),[]);
  f.panel.updateStatus(status(native({connected:true,authenticated:true,available:false})));
  assert.match(f.$('#next-mistral-vibe-status').textContent,/no model catalog/);assert.doesNotMatch(f.$('#next-mistral-vibe-status').textContent,/Ready/);
  assert.equal(f.$('#next-mistral-vibe-catalog').hidden,true);assert.equal(f.$('#next-mistral-vibe-refresh').disabled,false);
});

test('pending login cannot duplicate across navigation and a destroyed panel ignores its late result',async t=>{
  const gate=deferred();const f=fixture(t,{hook:call=>call.route==='/api/subscriptions/mistral-vibe/login'?gate.promise:undefined});await settle();
  const clicking=f.click('#next-mistral-vibe-login');await settle();
  assert.equal(f.writes().length,1);f.panel.leave();f.panel.enter();await settle();
  await f.click('#next-mistral-vibe-login');assert.equal(f.writes().length,1);assert.equal(f.$('#next-mistral-vibe-login').disabled,true);
  f.panel.destroy();gate.resolve({status:status(native({connected:true,authenticated:true,available:true,models:[exactModel]}))});await clicking;
  assert.deepEqual(f.updates,[]);assert.equal(f.writes().length,1);
});

test('native login errors remain actionable without changing API drafts or retrying automatically',async t=>{
  const f=fixture(t,{hook:call=>{if(call.route==='/api/subscriptions/mistral-vibe/login')throw Error('Account sign-in could not start. Refresh and try again.');}});await settle();
  await f.click('#next-mistral-vibe-login');
  assert.match(f.$('#next-mistral-vibe-error').textContent,/sign-in could not start/);assert.equal(f.$('#next-mistral-vibe-error').hidden,false);
  assert.equal(f.$('#next-mistral-vibe-login').disabled,false);assert.equal(f.$('#fixture-api-draft').value,'Keep my API draft');
  await settle();assert.equal(f.writes().length,1);assert.deepEqual(f.updates,[]);
});

test('reported Vibe reasoning choices and exact model alias remain selectable without inventing other levels',()=>{
  const alias='mistral-medium-3.5',id='mistral-vibe::'+alias;
  const model={id,model:alias,providerId:'mistral-vibe',displayName:'Mistral Medium 3.5',description:'mistral-vibe-cli-latest',available:true,
    defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'none',description:'Off'},{reasoningEffort:'high',description:'High'}],
    contextWindowTokens:202144,contextWindowSource:'runtime-reported'};
  const info={...status(native({authenticated:true,connected:true,available:true,models:[{...model,id:alias}]})),models:[model]};
  const choices=chatOptionChoices(info,{model:id,effort:'none'});
  assert.deepEqual(choices.models.map(item=>item.id),['default',id]);
  assert.equal(choices.models.find(item=>item.id===id).disabled,false);
  assert.deepEqual(choices.efforts.map(item=>item.id),['default','none','high']);
  assert.ok(choices.efforts.every(item=>!item.disabled&&item.verified));
  assert.equal(validateChatOptions(info,{model:id,effort:'none'}).model,id);
  assert.equal(validateChatOptions(info,{model:id,effort:'high'}).effort,'high');
  assert.throws(()=>validateChatOptions(info,{model:id,effort:'medium'}),/does not offer Medium reasoning/);
  assert.throws(()=>validateChatOptions(info,{model:id,effort:'off'}),/valid reasoning level/);
  assert.equal(info.defaultModelSelection,'gpt-6-luna');
});
