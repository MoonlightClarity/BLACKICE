import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createGroupedModelPicker} from '../public/next/core/model-picker.mjs';
import {chatOptionChoices} from '../public/next/chat/options-model.mjs';
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
function fixture(t,{models=catalog,selected='default',hidden=[],modelProviders=providers,subscriptionProviders=[],onEnableProvider,onSetupProvider}={}){
  const dom=planningDOM(t),select=dom.element('select');select.id='test-model';dom.mount.append(select);
  const choices=[{id:'default',label:'Automatic'},...models.map(item=>({id:item.id,label:item.displayName,disabled:item.available===false}))];
  if(!choices.some(item=>item.id===selected))choices.push({id:selected,label:selected,disabled:true});
  for(const item of choices){const option=dom.element('option');option.setAttribute('value',item.id);option.textContent=item.label;select.append(option);}select.value=selected;
  const changes=[];select.dispatchEvent=event=>{void select.dispatch(event.type,{target:select},true);return true;};select.addEventListener('change',()=>changes.push(select.value));
  let status={providers:modelProviders,subscriptionProviders,models,runtimeSettings:{hiddenModelProviders:hidden}};
  const picker=createGroupedModelPicker({select,onSetupProvider,onEnableProvider:onEnableProvider&&(async id=>{
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

test('all three account catalog choices remain selectable with distinct model metadata and reasoning',async t=>{
  // These exact public identities and reasoning lists come from the account
  // catalog. Medium retains the already-saved alias proven by that catalog.
  const reported=[
    model('mistral-vibe::mistral-large-4-0',{displayName:'Mistral Large 4',providerType:'subscription-cli',supportsTools:true,inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]}),
    model('mistral-vibe::mistral-medium-3.5',{displayName:'Mistral Medium 3.5',providerType:'subscription-cli',supportsTools:true,inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'none'},{reasoningEffort:'high'}]}),
    model('mistral-vibe::zai-glm-5-3-flash',{displayName:'GLM 5.3 Flash (Mistral Hosted)',providerType:'subscription-cli',supportsTools:true,inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'},{reasoningEffort:'max'}]}),
  ];
  const provider=vibeProvider({authenticated:true,available:true,defaultModel:'mistral-large-4-0',models:reported.map(item=>({...item,id:item.id.slice('mistral-vibe::'.length)}))});
  const status={models:reported,subscriptionProviders:[provider],defaultModel:'gpt-6-luna',defaultModelSelection:'gpt-6-luna'},before=structuredClone(status);
  const f=fixture(t,{models:reported,selected:reported[1].id,subscriptionProviders:[provider],onSetupProvider:()=>assert.fail('Ready native catalog must not become setup.')});
  f.update(status);await f.open();await f.query('Mistral');
  assert.equal(f.groups().length,1);assert.match(f.groups()[0].querySelector('summary').textContent,/Mistral Vibe Code.*3 models/);
  assert.deepEqual(new Set(f.rows().map(row=>row.dataset.modelValue)),new Set(reported.map(item=>item.id)));
  assert.equal(f.rows().every(row=>row.disabled===false),true);
  assert.equal(f.panel().querySelector('[data-model-more]'),null);assert.equal(f.panel().querySelector('[data-model-setup-provider]'),null);
  assert.equal(f.select.value,'mistral-vibe::mistral-medium-3.5','A catalog refresh keeps the saved Medium alias even when the native default is Large.');assert.deepEqual(f.changes,[]);
  const expectedEfforts=[['default','low','medium','high'],['default','none','high'],['default','low','high','max']];
  for(let index=0;index<reported.length;index++){
    const item=reported[index],choices=chatOptionChoices(status,{model:item.id});
    assert.deepEqual(choices.models.filter(choice=>choice.id.startsWith('mistral-vibe::')).map(choice=>choice.id),reported.map(model=>model.id));
    assert.equal(choices.models.find(choice=>choice.id===item.id).disabled,false);
    assert.deepEqual(choices.efforts.map(choice=>choice.id),expectedEfforts[index]);
    assert.equal(choices.efforts.every(choice=>choice.disabled===false&&choice.verified===true),true);
    if(f.panel().hidden)await f.open();await f.query('Mistral');
    const row=f.rows().find(row=>row.dataset.modelValue===item.id);await row.dispatch('click',{},true);
    assert.equal(f.select.value,item.id);assert.equal(f.changes.at(-1),item.id);
    assert.equal(f.trigger().querySelector('.next-model-picker-title').textContent,item.displayName);
    assert.equal(f.trigger().querySelector('.next-model-picker-subtitle').textContent,'Mistral Vibe Code');
  }
  const unsupported=chatOptionChoices(status,{model:reported[1].id,effort:'max'}).efforts.find(choice=>choice.id==='max');
  assert.equal(unsupported.disabled,true,'Medium does not inherit the hosted model’s reasoning choices.');
  // Deliberately varied synthetic capabilities ensure availability is not
  // filtered or inferred from tools, vision, or an absent reasoning control.
  const varied=reported.map((item,index)=>index===0?{...item,supportsTools:false,inputModalities:['text']}:index===2?{...item,supportsReasoningSelection:false}:item);
  assert.deepEqual(chatOptionChoices({...status,models:varied},{model:reported[2].id}).efforts.map(choice=>choice.id),['default']);
  f.update({models:varied});await f.open();await f.query('Mistral');
  assert.equal(f.rows().length,3);assert.equal(f.rows().every(row=>row.disabled===false),true);
  f.update({...status,models:[...reported].reverse()});assert.equal(f.select.value,reported[2].id);
  assert.deepEqual(f.changes,reported.map(item=>item.id));assert.deepEqual(status,before,'Selection and metadata paints do not mutate the default or catalog.');
});



test('Mistral setup is a keyboard reachable native connection action, never a model choice',async t=>{
  const setup=[],f=fixture(t,{selected:'alpha::free-low',subscriptionProviders:[vibeProvider()],onSetupProvider:id=>setup.push(id)});
  await f.open();await f.query('Mistral');
  const action=f.panel().querySelector('[data-model-setup-provider="mistral-vibe"]');
  assert.ok(action);assert.match(action.textContent,/Set up Mistral Vibe Code/);assert.match(action.textContent,/Native account connection/);
  assert.deepEqual(f.rows(),[]);assert.equal(f.select.children.some(option=>option.value==='mistral-vibe'),false);
  const search=f.panel().querySelector('input[type="search"]');search.focus();
  await f.panel().dispatch('keydown',{key:'ArrowDown',target:search},true);assert.equal(f.document.activeElement,action);
  await action.dispatch('click',{},true);assert.deepEqual(setup,['mistral-vibe']);
  assert.equal(f.select.value,'alpha::free-low');assert.deepEqual(f.changes,[]);assert.equal(f.panel().hidden,true);
});

test('an authenticated Vibe catalog has exact selectable model identities and its native provider name',async t=>{
  const exact=model('mistral-vibe::fixture/model-2026:exact',{displayName:'Fixture Vibe model'});
  const f=fixture(t,{models:[exact],subscriptionProviders:[vibeProvider({authenticated:true,available:true,models:[{id:'fixture/model-2026:exact'}]})],onSetupProvider:()=>assert.fail('Connected model is not a setup action.')});
  await f.open();await f.query('Mistral');
  assert.equal(f.panel().querySelector('[data-model-setup-provider]'),null);
  assert.match(f.groups()[0].querySelector('summary').textContent,/Mistral Vibe Code/);
  assert.deepEqual(f.rows().map(row=>row.dataset.modelValue),[exact.id]);
  await f.rows()[0].dispatch('click',{},true);
  assert.equal(f.select.value,exact.id);assert.deepEqual(f.changes,[exact.id]);assert.equal(f.trigger().querySelector('.next-model-picker-subtitle').textContent,'Mistral Vibe Code');
});

test('native setup actions respect hidden providers and failed navigation preserves the saved model',async t=>{
  const f=fixture(t,{selected:'alpha::free-low',hidden:['mistral-vibe'],subscriptionProviders:[vibeProvider()],onSetupProvider:()=>{throw Error('Settings could not open.');}});
  await f.open();assert.equal(f.panel().querySelector('[data-model-setup-provider]'),null);
  f.update({runtimeSettings:{hiddenModelProviders:[]}});await f.query('Mistral');
  const action=f.panel().querySelector('[data-model-setup-provider]');action.focus();
  f.update({subscriptionProviders:[vibeProvider({loginState:'waiting'})]});
  assert.equal(f.document.activeElement.dataset.modelSetupProvider,'mistral-vibe');
  await f.document.activeElement.dispatch('click',{},true);
  assert.match(f.panel().querySelector('[role="status"]').textContent,/Settings could not open/);
  assert.equal(f.panel().hidden,false);assert.equal(f.select.value,'alpha::free-low');assert.deepEqual(f.changes,[]);
});
