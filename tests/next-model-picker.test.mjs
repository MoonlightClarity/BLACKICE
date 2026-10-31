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
function fixture(t,{models=catalog,selected='default',hidden=[]}={}){
  const dom=planningDOM(t),select=dom.element('select');select.id='test-model';dom.mount.append(select);
  const choices=[{id:'default',label:'Automatic'},...models.map(item=>({id:item.id,label:item.displayName,disabled:item.available===false}))];
  if(!choices.some(item=>item.id===selected))choices.push({id:selected,label:selected,disabled:true});
  for(const item of choices){const option=dom.element('option');option.setAttribute('value',item.id);option.textContent=item.label;select.append(option);}select.value=selected;
  const changes=[];select.dispatchEvent=event=>{void select.dispatch(event.type,{target:select},true);return true;};select.addEventListener('change',()=>changes.push(select.value));
  const picker=createGroupedModelPicker({select});let status={providers,models,runtimeSettings:{hiddenModelProviders:hidden}};
  picker.update({models:choices,status,selected});t.after(()=>picker.destroy());
  const panel=()=>dom.document.querySelector('#test-model-picker'),trigger=()=>dom.$('.next-model-picker-trigger');
  return{...dom,select,picker,changes,choices,panel,trigger,
    rows:()=>panel().querySelectorAll('[data-model-value]'),groups:()=>panel().querySelectorAll('details'),
    async open(){await trigger().dispatch('click',{},true);},
    async query(value){const input=panel().querySelector('input[type="search"]');input.value=value;await input.dispatch('input',{},true);},
    async filter(name,checked){const input=panel().querySelector(`[data-model-filter="${name}"]`);input.checked=checked;await input.dispatch('change',{},true);},
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

test('search, explicit free and capability filters, and context ordering affect discovery without choosing a model',async t=>{
  const f=fixture(t);await f.open();await f.query('Alpha');
  assert.deepEqual(f.groups().map(group=>group.dataset.modelProvider),['alpha']);assert.ok(f.groups()[0].open);
  const sort=f.panel().querySelector('select');sort.value='context-desc';await sort.dispatch('change',{},true);
  assert.deepEqual(f.rows().map(row=>row.dataset.modelValue),['alpha::paid-high','alpha::free-vision','alpha::free-low','alpha::unknown']);
  await f.filter('freeOnly',true);assert.deepEqual(f.rows().map(row=>row.dataset.modelValue),['alpha::free-vision','alpha::free-low']);
  assert.equal(f.panel().querySelector('[data-model-value="default"]'),null,'Automatic is not classified as free.');
  await f.filter('toolsOnly',true);await f.filter('visionOnly',true);
  assert.deepEqual(f.rows().map(row=>row.dataset.modelValue),['alpha::free-vision']);
  assert.equal(f.select.value,'default');assert.deepEqual(f.changes,[]);
  await f.rows()[0].dispatch('click',{},true);assert.equal(f.select.value,'alpha::free-vision');assert.deepEqual(f.changes,['alpha::free-vision']);
});

test('hiding a provider retains the active selection and native hidden flags remain separate',async t=>{
  const native={id:'native-hidden',providerId:'codex',displayName:'Native hidden',available:true,hidden:true};
  const f=fixture(t,{models:[...catalog,native],selected:'alpha::free-low'});await f.open();await f.expand('alpha');
  f.update({runtimeSettings:{hiddenModelProviders:['alpha']}});
  assert.equal(f.select.value,'alpha::free-low');assert.deepEqual(f.changes,[]);
  assert.match(f.trigger().textContent,/free-low/);assert.match(f.trigger().textContent,/Hidden provider/);
  assert.equal(f.groups().some(group=>group.dataset.modelProvider==='alpha'),false);
  assert.equal(f.groups().some(group=>group.dataset.modelProvider==='codex'),true,'Native catalog hidden flag does not hide its provider.');
  await f.expand('codex');assert.ok(f.rows().some(row=>row.dataset.modelValue==='native-hidden'));
});

test('unavailable or missing selected models stay selected while discovery updates',async t=>{
  const f=fixture(t,{selected:'retired::old'});await f.open();f.update({runtimeSettings:{hiddenModelProviders:['retired']}});
  assert.equal(f.select.value,'retired::old');assert.match(f.trigger().textContent,/retired::old/);assert.match(f.trigger().textContent,/Unavailable/);assert.deepEqual(f.changes,[]);
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

test('model evidence links are outside the selection button and do not switch the active model',async t=>{
  const sourced=model('alpha::referenced',{contextWindowTokens:400000,contextWindowSource:'model-reference',contextWindowObservedAt:'2026-10-30T12:00:00Z',contextWindowEvidence:{label:'Official catalog',modelId:'underlying-model',url:'https://models.example/model',endpointSpecific:false}});
  const f=fixture(t,{models:[sourced],selected:'default'});await f.open();await f.expand('alpha');
  const row=f.panel().querySelector('[data-model-value="alpha::referenced"]'),link=f.panel().querySelector('[data-model-source]');
  assert.match(row.textContent,/400,000 tokens · Model reference · Official catalog · Endpoint unconfirmed/);assert.match(row.textContent,/Observed 2026-10-30 12:00:00 UTC/);
  assert.equal(link.getAttribute('href'),'https://models.example/model');assert.equal(link.closest('button'),null);assert.equal(link.getAttribute('rel'),'noopener noreferrer');
  await link.dispatch('click',{},true);assert.equal(f.select.value,'default');assert.deepEqual(f.changes,[]);assert.equal(f.panel().hidden,false);
  await row.dispatch('click',{},true);assert.equal(f.select.value,'alpha::referenced');assert.deepEqual(f.changes,['alpha::referenced']);
});

test('runtime windows distinguish the current default and supported maximum while hidden native models remain available',async t=>{
  const hidden={id:'native-hidden',displayName:'Native hidden',providerId:'codex',hidden:true,available:true,contextWindowTokens:196000,contextWindowSource:'runtime-reported',runtimeDefaultContextWindowTokens:196000,maxContextWindowTokens:1000000};
  const candidate={id:'native-candidate',displayName:'Candidate',available:false,source:'runtime-candidate'};
  const choices=chatOptionChoices({models:[hidden,candidate],codex:{connected:true,authenticated:true}},{model:'native-hidden'});
  assert.ok(choices.models.some(model=>model.id==='native-hidden'));assert.equal(choices.models.find(model=>model.id==='native-candidate').disabled,true,'Unavailable candidates can be displayed but cannot be selected.');
  const f=fixture(t,{models:[hidden],selected:'native-hidden'});await f.open();await f.expand('codex');const row=f.panel().querySelector('[data-model-value="native-hidden"]');
  assert.match(row.textContent,/Context window: 196,000 tokens · Runtime reported/);assert.match(row.textContent,/Runtime default context: 196,000/);assert.match(row.textContent,/Maximum supported context: 1,000,000/);assert.match(row.textContent,/Hidden by Codex/);
  assert.equal(row.disabled,false);assert.equal(f.select.value,'native-hidden');assert.deepEqual(f.changes,[]);
});
