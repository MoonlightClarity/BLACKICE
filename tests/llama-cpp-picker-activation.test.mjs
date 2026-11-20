import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createGroupedModelPicker} from '../public/next/core/model-picker.mjs';

function fixture(t,{onBeforeSelect,onOpenAvailability}={}) {
  const dom=planningDOM(t),select=dom.element('select');
  select.id='llama-picker-test';dom.mount.append(select);
  const options=[{id:'default',label:'Use default'}, {id:'local_llamacpp::small.gguf',label:'Small local'}];
  for(const option of options) {
    const child=dom.element('option');child.setAttribute('value',option.id);
    child.textContent=option.label;select.append(child);
  }
  select.value='default';
  const changes=[];
  select.dispatchEvent=event=>{void select.dispatch(event.type,{target:select},true);return true;};
  select.addEventListener('change',()=>changes.push(select.value));
  const picker=createGroupedModelPicker({select,onBeforeSelect,onOpenAvailability});
  const models=[{id:'default',label:'Use default'}, {id:'local_llamacpp::small.gguf',label:'Small local'}];
  const status={providers:[{id:'local_llamacpp',preset:'llamacpp',name:'Local llama.cpp'}],
    models:[{id:'local_llamacpp::small.gguf',providerId:'local_llamacpp',available:true}]};
  picker.update({models,status,selected:select.value});
  t.after(()=>picker.destroy());
  const panel=()=>dom.document.querySelector('#llama-picker-test-picker');
  const trigger=()=>dom.$('.next-model-picker-trigger');
  return {...dom,select,changes,picker,panel,trigger,
    async show() {
      await trigger().dispatch('click',{},true);
      const group=panel().querySelector('details[data-model-provider="local_llamacpp"]');
      group.open=true;await group.dispatch('toggle');
      return panel().querySelector('[data-model-value="local_llamacpp::small.gguf"]');
    },
  };
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('picker waits for readiness before committing exact selected local ID',async t=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const observed=[];
  const f=fixture(t,{onBeforeSelect:async model=>{observed.push(model.id);await gate;}});
  const row=await f.show();await row.dispatch('click',{},true);
  await settle();
  assert.deepEqual(observed,['local_llamacpp::small.gguf']);
  assert.equal(f.select.value,'default');
  assert.deepEqual(f.changes,[]);
  assert.match(f.panel().querySelector('.next-model-picker-summary').textContent,/Preparing/);
  release();await settle();
  assert.equal(f.select.value,'local_llamacpp::small.gguf');
  assert.deepEqual(f.changes,['local_llamacpp::small.gguf']);
});

test('activation error preserves prior selection and appears inside the picker',async t=>{
  const f=fixture(t,{onBeforeSelect:async()=>{throw Error('No matching llama-server binary');}});
  const row=await f.show();await row.dispatch('click',{},true);await settle();
  assert.equal(f.select.value,'default');
  assert.deepEqual(f.changes,[]);
  assert.match(f.panel().querySelector('.next-model-picker-summary').textContent,/No matching llama-server binary/);
  assert.equal(f.panel().hidden,false);
});

test('dismissing during activation prevents a late model switch',async t=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{onBeforeSelect:()=>gate});
  const row=await f.show();await row.dispatch('click',{},true);
  await settle();f.picker.close({restoreFocus:false});
  release();await settle();
  assert.equal(f.select.value,'default');
  assert.deepEqual(f.changes,[]);
});

test('a saved local model with a missing file cannot be selected; reopening detects its return', async t=>{
  let missing=true,activations=0;
  const f=fixture(t,{
    onBeforeSelect:async()=>{activations++;},
    onOpenAvailability:async()=>missing?{'local_llamacpp::small.gguf':'Model file is missing.'}:{},
  });
  await f.show();await settle();
  let row=f.panel().querySelector('[data-model-value="local_llamacpp::small.gguf"]');
  assert.equal(row.disabled,true);
  assert.match(row.textContent,/file is missing/);
  await row.dispatch('click',{},true);await settle();
  assert.equal(activations,0);
  assert.equal(f.select.value,'default');
  f.picker.close({restoreFocus:false});missing=false;
  await f.show();await settle();
  row=f.panel().querySelector('[data-model-value="local_llamacpp::small.gguf"]');
  assert.equal(row.disabled,false);
  await row.dispatch('click',{},true);await settle();
  assert.equal(activations,1);
});

test('an old file check cannot overwrite a newer open picker', async t=>{
  let resume,opens=0;
  const f=fixture(t,{onOpenAvailability:()=>++opens===1?new Promise(resolve=>{resume=resolve;}):Promise.resolve({})});
  await f.show();
  f.picker.close({restoreFocus:false});
  await f.show();await settle();
  resume({'local_llamacpp::small.gguf':'Model file is missing.'});await settle();
  assert.equal(f.panel().querySelector('[data-model-value="local_llamacpp::small.gguf"]').disabled,false);
});
