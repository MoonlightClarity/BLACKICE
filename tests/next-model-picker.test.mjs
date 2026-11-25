import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createGroupedModelPicker} from '../public/next/core/model-picker.mjs';
import {connectionDefaultModels} from '../public/connection-models.mjs';
import {chatOptionChoices,validateChatOptions} from '../public/next/chat/options-model.mjs';
import {paintModels} from '../public/next/chat/render.mjs';

const providers=[{id:'zeta',name:'Zeta API'},{id:'alpha',name:'Alpha API'}];
const model=(id,extra={})=>({id,providerId:id.split('::')[0],displayName:id.split('::')[1],available:true,...extra});
const free={freeVariant:true,pricingSource:'provider-reported',pricing:{prompt:'0',completion:'0'}};
const catalog=[
  model('alpha::free-low',{contextWindowTokens:32000,...free,supportsTools:true,inputModalities:['text']}),
  model('alpha::paid-high',{contextWindowTokens:256000,pricing:{prompt:'0.01',completion:'0.02'},supportsTools:true,inputModalities:['text','image']}),
  model('alpha::free-vision',{contextWindowTokens:128000,...free,supportsTools:true,inputModalities:['text','image']}),
  model('alpha::unknown',{contextWindowTokens:null,supportsTools:false}),
  model('zeta::other',{contextWindowTokens:64000,...free,supportsTools:false}),
];
function fixture(t,{models=catalog,selected='default',hidden=[],modelProviders=providers,subscriptionProviders=[],onEnableProvider,onSetupProvider,api}={}){
  const dom=planningDOM(t),select=dom.element('select');select.id='test-model';dom.mount.append(select);
  const choices=[{id:'default',label:'Automatic'},...models.map(item=>({id:item.id,label:item.displayName,disabled:item.available===false}))];
  if(!choices.some(item=>item.id===selected))choices.push({id:selected,label:selected,disabled:true});
  for(const item of choices){const option=dom.element('option');option.setAttribute('value',item.id);option.textContent=item.label;select.append(option);}select.value=selected;
  const changes=[];select.dispatchEvent=event=>{void select.dispatch(event.type,{target:select},true);return true;};select.addEventListener('change',()=>changes.push(select.value));
  let status={providers:modelProviders,subscriptionProviders,models,runtimeSettings:{hiddenModelProviders:hidden}};
  const picker=createGroupedModelPicker({select,api,onSetupProvider,onEnableProvider:onEnableProvider&&(async id=>{
    const fresh=await onEnableProvider(id);
    if(fresh){status={...status,...fresh};for(const choice of choices){const metadata=(status.models||[]).find(model=>model.id===choice.id);if(metadata)choice.disabled=metadata.available===false;}picker.update({models:choices,status,selected:select.value});}
    return fresh;
  })});
  picker.update({models:choices,status,selected});t.after(()=>picker.destroy());
  const panel=()=>dom.document.querySelector('#test-model-picker'),trigger=()=>dom.$('.next-model-picker-trigger');
  return{...dom,select,picker,changes,choices,panel,trigger,
    rows:()=>panel().querySelectorAll('[data-model-value]'),groups:()=>panel().querySelectorAll('details[data-model-provider]'),
    async open(){await trigger().dispatch('click',{},true);},
    async query(value){const input=panel().querySelector('input[type="search"]');input.value=value;await input.dispatch('input',{},true);},
    async expand(id){const group=panel().querySelector(`details[data-model-provider="${id}"]`);assert.ok(group,'Provider group exists: '+id);group.open=true;await group.dispatch('toggle');},
    update(next={}){status={...status,...next};picker.update({models:choices,status,selected:select.value});},
  };
}


test('hidden-provider restore section starts collapsed and preserves deliberate expansion only while open',async t=>{
 const f=fixture(t,{hidden:['alpha'],api:async()=>({hiddenModelProviders:[]})});
 await f.open();
 let hidden=f.panel().querySelector('details.next-model-picker-hidden');
 assert.ok(hidden,'hidden provider controls are discoverable');
 assert.equal(hidden.open,false,'hidden provider section must not be expanded initially');
 assert.equal(hidden.querySelector('[data-provider-action="restore"]').dataset.providerId,'alpha');
 hidden.open=true;
 await hidden.dispatch('toggle',{},true);
 f.update({providers:[...providers,{id:'extra',name:'Extra'}]});
 hidden=f.panel().querySelector('details.next-model-picker-hidden');
 assert.equal(hidden.open,true,'a deliberate expansion should persist through a picker repaint');
 f.picker.close();
 await f.open();
 hidden=f.panel().querySelector('details.next-model-picker-hidden');
 assert.equal(hidden.open,false,'each fresh picker opening resets hidden providers to collapsed');
 assert.deepEqual(f.changes,[],'inspecting hidden providers must not change the selected model');
});

test('provider groups are sorted and collapsed initially, with bounded rows added only when opened',async t=>{
  const many=Array.from({length:121},(_,index)=>model('alpha::model-'+String(index).padStart(3,'0')));
  const f=fixture(t,{models:[model('zeta::first'),...many]});await f.open();
  assert.deepEqual(f.groups().map(group=>group.dataset.modelProvider),['alpha','zeta']);
  assert.ok(f.groups().every(group=>group.open===false));assert.deepEqual(f.rows().map(row=>row.dataset.modelValue),['default']);
  await f.expand('alpha');assert.equal(f.rows().filter(row=>row.dataset.modelValue!=='default').length,80);
  await f.panel().querySelector('[data-model-more="alpha"]').dispatch('click',{},true);
  assert.equal(f.rows().filter(row=>row.dataset.modelValue!=='default').length,121);
  assert.equal(f.select.value,'default');assert.deepEqual(f.changes,[]);
  await f.panel().dispatch('keydown',{key:'Escape',target:f.panel()},true);
  assert.equal(f.panel().hidden,true);assert.equal(f.document.activeElement,f.trigger());
  await f.open();assert.ok(f.groups().every(group=>!group.open),'Reopening starts with collapsed providers.');
});

test('name and provider search retain alphabetical choices without capability filters or limit ordering',async t=>{
  const f=fixture(t);await f.open();await f.query('Alpha');
  assert.deepEqual(f.groups().map(group=>group.dataset.modelProvider),['alpha']);assert.ok(f.groups()[0].open);
  assert.equal(f.panel().querySelector('select'),null);assert.equal(f.panel().querySelector('input[type="checkbox"]'),null);
  assert.deepEqual(f.rows().map(row=>row.dataset.modelValue),['alpha::free-low','alpha::free-vision','alpha::paid-high','alpha::unknown']);
  await f.query('unknown');assert.deepEqual(f.rows().map(row=>row.dataset.modelValue),['alpha::unknown'],'A model without tools or reported limits remains discoverable.');
  assert.equal(f.select.value,'default');assert.deepEqual(f.changes,[]);
  await f.rows()[0].dispatch('click',{},true);assert.equal(f.select.value,'alpha::unknown');assert.deepEqual(f.changes,['alpha::unknown']);
});

test('hiding a provider retains the active selection and native hidden flags remain separate',async t=>{
  const native={id:'native-hidden',providerId:'codex',displayName:'Native hidden',available:true,hidden:true};
  const f=fixture(t,{models:[...catalog,native],selected:'alpha::free-low'});await f.open();await f.expand('alpha');
  f.update({runtimeSettings:{hiddenModelProviders:['alpha']}});
  assert.equal(f.select.value,'alpha::free-low');assert.deepEqual(f.changes,[]);
  assert.match(f.trigger().textContent,/free-low/);assert.match(f.trigger().textContent,/Alpha API/);assert.doesNotMatch(f.trigger().textContent,/Hidden provider/);
  assert.equal(f.groups().some(group=>group.dataset.modelProvider==='alpha'),false);
  assert.equal(f.groups().some(group=>group.dataset.modelProvider==='codex'),true,'Native catalog hidden flag does not hide its provider.');
  await f.expand('codex');assert.ok(f.rows().some(row=>row.dataset.modelValue==='native-hidden'));
});

test('unavailable or missing selected models stay selected while discovery updates',async t=>{
  const f=fixture(t,{selected:'retired::old'});await f.open();f.update({runtimeSettings:{hiddenModelProviders:['retired']}});
  assert.equal(f.select.value,'retired::old');assert.match(f.trigger().textContent,/retired::old/);assert.deepEqual(f.changes,[]);
  const choices=chatOptionChoices({models:[{id:'offline',available:false}]},{model:'offline'});
  assert.ok(choices.models.some(row=>row.id==='offline'&&row.disabled));assert.equal(choices.selected.model,'offline');
  const missing=chatOptionChoices({models:[]},{model:'saved-but-missing'});
  assert.ok(missing.models.some(row=>row.id==='saved-but-missing'&&row.disabled),'Missing selected model gets a retained unavailable option.');
});

test('identical status paints preserve search input and group focus without dispatching changes',async t=>{
  const f=fixture(t);await f.open();await f.query('Alpha');const input=f.panel().querySelector('input[type="search"]');input.focus();
  const group=f.groups()[0];for(let i=0;i<10;i++)f.update({execution:{activeCount:i}});
  assert.equal(f.panel().querySelector('input[type="search"]'),input);assert.equal(input.value,'Alpha');assert.equal(f.document.activeElement,input);assert.equal(f.groups()[0],group);assert.deepEqual(f.changes,[]);
  f.picker.destroy();assert.equal(f.select.hidden,false);assert.equal(f.document.querySelector('#test-model-picker'),null);
});

test('Chat paints retain unavailable and missing native values instead of selecting the default',()=>{
  const ownerDocument={createDocumentFragment(){return{children:[],append(node){this.children.push(node);}};},createElement(){return{value:'',textContent:'',disabled:false};}};
  const select={ownerDocument,options:[],value:'offline',replaceChildren(fragment){this.options=fragment.children;this.value=this.options[0]?.value||'';},setAttribute(){}};
  paintModels({model:select},{models:[{id:'offline',available:false}]},{model:'offline'});assert.equal(select.value,'offline');
  paintModels({model:select},{models:[]},{model:'saved-but-missing'});assert.equal(select.value,'saved-but-missing');
  paintModels({model:select},{models:[{id:'hidden::selected',available:true}],runtimeSettings:{hiddenModelProviders:['hidden']}},{model:'hidden::selected'});assert.equal(select.value,'hidden::selected');
});

test('picker shows model names and providers without capability, pricing or context details',async t=>{
  const sourced=model('alpha::referenced',{contextWindowTokens:400000,maxOutputTokens:64000,contextWindowSource:'model-reference',contextWindowObservedAt:'2026-10-30T12:00:00Z',contextWindowEvidence:{label:'Official catalog',modelId:'underlying-model',url:'https://models.example/model',endpointSpecific:false},supportsTools:true,inputModalities:['text','image'],...free});
  const f=fixture(t,{models:[sourced],selected:'default'});await f.open();await f.expand('alpha');
  const row=f.panel().querySelector('[data-model-value="alpha::referenced"]');
  assert.equal(row.textContent,'referenced');assert.match(f.groups()[0].querySelector('summary').textContent,/Alpha API/);
  assert.equal(f.panel().querySelector('[data-model-details]'),null);assert.equal(f.panel().querySelector('a'),null);
  assert.doesNotMatch(f.panel().textContent,/context|output|Tools|Vision|Free only|Official catalog|Details|Observed|Limits unknown/i);
  assert.equal(f.select.value,'default');assert.deepEqual(f.changes,[]);
  await row.dispatch('click',{},true);assert.equal(f.select.value,'alpha::referenced');assert.deepEqual(f.changes,['alpha::referenced']);
  assert.equal(f.trigger().querySelector('.next-model-picker-title').textContent,'referenced');assert.equal(f.trigger().querySelector('.next-model-picker-subtitle').textContent,'Alpha API');
});

test('native hidden models remain selectable and unavailable models retain accessible reasons without extra metadata',async t=>{
  const hidden={id:'native-hidden',displayName:'Native hidden',providerId:'codex',hidden:true,available:true,contextWindowTokens:196000,contextWindowSource:'runtime-reported',runtimeDefaultContextWindowTokens:196000,maxContextWindowTokens:1000000};
  const candidate={id:'native-candidate',displayName:'Candidate',providerId:'codex',available:false,source:'runtime-candidate',availabilityReason:'This model is not available for the current connection.'};
  const choices=chatOptionChoices({models:[hidden,candidate],codex:{connected:true,authenticated:true}},{model:'native-hidden'});
  assert.ok(choices.models.some(model=>model.id==='native-hidden'));assert.equal(choices.models.find(model=>model.id==='native-candidate').disabled,true,'Unavailable candidates can be displayed but cannot be selected.');
  const f=fixture(t,{models:[hidden,candidate],selected:'native-hidden'});await f.open();await f.expand('codex');const row=f.panel().querySelector('[data-model-value="native-hidden"]');
  assert.equal(row.textContent,'Native hidden✓');assert.equal(row.querySelector('small'),null);
  assert.equal(row.disabled,false);assert.equal(f.select.value,'native-hidden');assert.deepEqual(f.changes,[]);
  const unavailable=f.panel().querySelector('[data-model-value="native-candidate"]');assert.equal(unavailable.disabled,true);assert.equal(unavailable.textContent,'Candidate');assert.equal(unavailable.getAttribute('aria-description'),candidate.availabilityReason);
  await unavailable.dispatch('click',{},true);assert.equal(f.select.value,'native-hidden');assert.deepEqual(f.changes,[]);
});

test('keyboard navigation and focus survive discovery updates with exact model IDs preserved',async t=>{
  const f=fixture(t,{models:[model('alpha::one'),model('alpha::two')]});await f.open();await f.query('Alpha');
  const summary=f.groups()[0].querySelector('summary'),row=f.panel().querySelector('[data-model-value="alpha::one"]');
  summary.focus();await f.panel().dispatch('keydown',{key:'ArrowDown',target:summary},true);assert.equal(f.document.activeElement,row);
  f.update({models:[model('alpha::one',{contextWindowTokens:128000,supportsTools:false}),model('alpha::two')]});
  const updated=f.panel().querySelector('[data-model-value="alpha::one"]');assert.equal(f.document.activeElement,updated);assert.equal(updated.textContent,'one');
  await f.panel().dispatch('keydown',{key:'ArrowDown',target:updated},true);assert.equal(f.document.activeElement.dataset.modelValue,'alpha::two');
  await updated.dispatch('click',{},true);assert.equal(f.select.value,'alpha::one');assert.deepEqual(f.changes,['alpha::one']);
});

test('disabled credential-ready API models offer one explicit enable action and preserve the selection until it succeeds',async t=>{
  const id='openrouter_free::vendor/exact:free',disabled=model(id,{available:false}),other=model('zeta::other');
  const provider={id:'openrouter_free',name:'OpenRouter',enabled:false,credentialsReady:true,models:[{id:'vendor/exact:free'}]},calls=[];
  let resolve;const pending=new Promise(done=>{resolve=done;});
  const f=fixture(t,{models:[disabled,other],selected:other.id,modelProviders:[provider,...providers],onEnableProvider:async value=>{calls.push(value);return pending;}});
  await f.open();await f.expand(provider.id);
  const row=f.panel().querySelector('[data-model-value="'+id+'"]');
  assert.equal(row.disabled,false);assert.match(row.textContent,/Enable connection/);assert.deepEqual(calls,[]);
  const selecting=row.dispatch('click',{},true);
  assert.deepEqual(calls,[id]);assert.equal(f.select.value,other.id);assert.deepEqual(f.changes,[]);
  await row.dispatch('click',{},true);assert.equal(calls.length,1,'Pending activation is not duplicated.');
  resolve({providers:[{...provider,enabled:true},...providers],models:[{...disabled,available:true},other]});await selecting;
  assert.equal(f.select.value,id);assert.deepEqual(f.changes,[id]);assert.equal(f.panel().hidden,true);
});

test('failed activation retains the exact saved chat model and reports a recoverable error',async t=>{
  const provider={id:'alpha',name:'Alpha API',enabled:false,credentialsReady:true,models:[{id:'candidate'}]},candidate=model('alpha::candidate',{available:false}),other=model('zeta::other');
  const f=fixture(t,{models:[candidate,other],selected:other.id,modelProviders:[provider,...providers.filter(p=>p.id!=='alpha')],onEnableProvider:async()=>{throw Error('Connection changed. Refresh Models settings.');}});
  await f.open();await f.expand('alpha');await f.panel().querySelector('[data-model-value="alpha::candidate"]').dispatch('click',{},true);
  assert.equal(f.select.value,other.id);assert.deepEqual(f.changes,[]);assert.equal(f.panel().hidden,false);
  assert.match(f.panel().querySelector('[role="status"]').textContent,/Connection changed/);
});

test('closing and reopening the picker during activation cannot change a later selection',async t=>{
  const provider={id:'alpha',name:'Alpha API',enabled:false,credentialsReady:true,models:[{id:'candidate'}]},candidate=model('alpha::candidate',{available:false}),other=model('zeta::other');
  let resolve;const pending=new Promise(done=>{resolve=done;});
  const f=fixture(t,{models:[candidate,other],selected:other.id,modelProviders:[provider,...providers.filter(p=>p.id!=='alpha')],onEnableProvider:()=>pending});
  await f.open();await f.expand('alpha');const selecting=f.panel().querySelector('[data-model-value="alpha::candidate"]').dispatch('click',{},true);
  f.picker.close();await f.open();
  resolve({providers:[{...provider,enabled:true},...providers.filter(p=>p.id!=='alpha')],models:[{...candidate,available:true},other]});await selecting;
  assert.equal(f.select.value,other.id);assert.deepEqual(f.changes,[]);
});

test('missing API credentials remain diagnosed without enabling a connection or rewriting the selected model',async t=>{
  const candidate=model('alpha::candidate',{available:false,availabilityReason:'Add API credentials in Settings > Models.'}),provider={id:'alpha',name:'Alpha API',enabled:false,credentialsReady:false,models:[{id:'candidate'}]};
  let calls=0;const f=fixture(t,{models:[candidate],selected:candidate.id,modelProviders:[provider],onEnableProvider:async()=>{calls++;}});
  await f.open();await f.expand('alpha');const row=f.panel().querySelector('[data-model-value="alpha::candidate"]');
  assert.equal(row.disabled,true);assert.match(row.getAttribute('aria-description'),/credentials.*Settings/);
  await row.dispatch('click',{},true);assert.equal(calls,0);assert.equal(f.select.value,candidate.id);assert.deepEqual(f.changes,[]);
});

const vibeProvider=extra=>({id:'mistral-vibe',name:'Mistral Vibe Code',type:'subscription-cli',installed:true,authenticated:false,available:false,models:[],...extra});

test('Google account rows select exact variants and stale Mistral setup is absent',async t=>{
  const id='google-account::gemini-3.8-flash-';
  const rows=['high','medium','low'].map(level=>model(id+level,{providerId:'google-account',displayName:'Gemini '+level,providerType:'subscription-cli',supportsReasoningSelection:false,fixedEffort:level}));
  const account={id:'google-account',name:'Google account',type:'subscription-cli',available:true,models:rows};
  const f=fixture(t,{models:rows,selected:rows[0].id,subscriptionProviders:[account,vibeProvider()],onSetupProvider:()=>assert.fail('Retired setup action.')});
  for(const item of rows){await f.open();await f.query('Gemini');const row=f.rows().find(r=>r.dataset.modelValue===item.id);assert.ok(row);await row.dispatch('click',{},true);assert.equal(f.select.value,item.id);}
  await f.open();await f.query('Mistral');
  assert.equal(f.panel().querySelector('[data-model-setup-provider="mistral-vibe"]'),null);
});

test('a deleted API does not appear as a raw-ID group, default or historical model label', async t => {
  const api='api_66f1dcbb06d7', removed=model(api+'::example'), active=model('alpha::working');
  const f=fixture(t,{models:[removed,active],selected:removed.id,modelProviders:[...providers,{id:api,name:'Venice'}]});
  await f.open();
  assert.match(f.trigger().textContent,/Venice/);
  const status={providers,models:[active],defaultModel:removed.id,defaultModelSelection:removed.id,defaultModelAvailable:false};
  const chat=chatOptionChoices(status,{model:removed.id});
  f.picker.update({models:chat.models,status,selected:chat.selected.model});
  assert.match(f.trigger().textContent,/API connection removed/);
  assert.doesNotMatch(f.trigger().textContent,new RegExp(api));
  assert.equal(f.groups().some(group=>group.dataset.modelProvider===api),false);
  assert.deepEqual(f.changes,[],'Removing a provider must not select another route or change the saved chat.');
  const missing=connectionDefaultModels(status).find(item=>item.value===removed.id);
  assert.equal(missing.disabled,true);
  assert.doesNotMatch(missing.label,new RegExp(api));
  assert.doesNotMatch(chat.defaultInfo.label,new RegExp(api));
  assert.throws(()=>validateChatOptions(status,{model:'default'}),/connection was removed/);
  assert.throws(()=>validateChatOptions(status,{model:removed.id}),/connection was removed/);
  assert.equal(validateChatOptions(status,{model:active.id}).model,active.id);
});

test('picker hides and restores a provider directly without changing its selected model; refresh uses live endpoint',async t=>{
  const calls=[];let hidden=[];
  const api=async(route,method,body)=>{calls.push({route,method,body});if(route.includes('visibility')){hidden=body.hidden?[body.providerId]:[];return {hiddenModelProviders:hidden};}return {catalogAvailable:true};};
  const f=fixture(t,{selected:'alpha::free-low',api});await f.open();
  const action=(id,name)=>f.panel().querySelector('[data-provider-id="'+id+'"][data-provider-action="'+name+'"]');
  // The fixture DOM has limited compound selector support; match controls by dataset.
  const control=(id,name)=>Array.from(f.panel().querySelectorAll('[data-provider-action]')).find(node=>node.dataset.providerId===id&&node.dataset.providerAction===name);
  await control('alpha','refresh').dispatch('click',{},true);
  assert.deepEqual(calls.at(-1),{route:'/api/providers/alpha/models',method:'POST',body:{refresh:true,limit:1}});
  await control('alpha','hide').dispatch('click',{},true);
  assert.equal(f.groups().some(g=>g.dataset.modelProvider==='alpha'),false);assert.equal(f.select.value,'alpha::free-low');assert.deepEqual(f.changes,[]);
  await control('alpha','restore').dispatch('click',{},true);
  assert.equal(f.groups().some(g=>g.dataset.modelProvider==='alpha'),true);
  await control('codex','refresh').dispatch('click',{},true);
  assert.equal(calls.at(-1).route,'/api/codex/models?refresh=true');assert.deepEqual(f.changes,[]);
});

test('a delayed visibility response cannot undo newer settings from another window',async t=>{
  let release;const response=new Promise(resolve=>release=resolve);const api=()=>response;
  const f=fixture(t,{selected:'alpha::free-low',hidden:['alpha','zeta'],api});await f.open();
  const control=Array.from(f.panel().querySelectorAll('[data-provider-action]')).find(node=>node.dataset.providerId==='alpha'&&node.dataset.providerAction==='restore');
  const pending=control.dispatch('click',{},true);
  f.update({runtimeSettings:{hiddenModelProviders:['zeta']}});
  f.update({runtimeSettings:{hiddenModelProviders:[]}});
  release({hiddenModelProviders:['zeta']});await pending;
  assert.deepEqual(f.groups().map(group=>group.dataset.modelProvider),['alpha','zeta']);
  assert.equal(f.select.value,'alpha::free-low');assert.deepEqual(f.changes,[]);
});
