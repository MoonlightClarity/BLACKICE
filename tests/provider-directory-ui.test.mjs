import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createProviderDirectoryUI } from '../public/next/workspaces/settings-provider-directory.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){for(let n=0;n<100;n++){if(fn())return;await settle();}throw Error('Model API search did not settle.');}
const supported={id:'builtin:groq',name:'Groq',source:'supported',preset:'groq',supported:true,
  providerId:'groq',authentication:'keyed',documentationUrl:'https://console.groq.com/docs',
  description:'Reviewed Chat Completions adapter',modelCount:null,zeroPriceModels:null,toolModels:null,
  protocol:'compatible',protocolLabel:'OpenAI Chat Completions',compatibility:'reviewed-adapter'};
const indexed={id:'index:outsider',name:'External Inference',source:'models.dev',preset:null,supported:false,
  providerId:'outsider',baseUrl:'https://models.example.org/v1',authentication:'keyed',
  documentationUrl:'https://models.example.org/docs',referenceUrl:'https://models.dev/providers/outsider/',
  description:'Index reports OpenAI compatibility',modelCount:21,zeroPriceModels:2,toolModels:4,
  protocol:'compatible',protocolLabel:'Index-reported OpenAI compatibility',compatibility:'index-reported-compatible'};
const unsupported={id:'index:native',name:'Unverified Native',source:'models.dev',preset:null,supported:false,
  providerId:'native',authentication:'unverified',documentationUrl:'https://native.example/docs',
  description:'Unverified native endpoint',modelCount:4,zeroPriceModels:0,toolModels:null,
  protocol:'unverified',protocolLabel:'API protocol not verified for BLACKICE',compatibility:'unverified'};

async function create(t,{hold}={}){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperty(prototype,'type',{get:type.get,set(value){this.setAttribute('type',value);}});
  prototype.replaceChildren=function(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.rawText='';this.markup='';this.append(...children);};
  const calls=[],chosen=[];
  const api=async(route,method='GET',body,options)=>{
    calls.push({route,method,body,options});
    if(!route.startsWith('/api/provider-directory?'))throw Error('Directory tried an unrelated API '+route);
    if(hold)return hold;
    const params=new URL(route,'http://localhost').searchParams;
    const source=params.get('source')||'all',auth=params.get('auth')||'any';
    const all=[supported,indexed,unsupported].filter(x=>(source==='all'||source==='supported'&&x.supported||source==='index'&&!x.supported)
      &&(auth==='any'||x.authentication===auth));
    return {total:all.length,offset:Number(params.get('offset')||0),limit:30,hasMore:false,items:all,
      indexCheckedAt:'2026-11-06T15:00:00Z',indexStale:false,warning:null};
  };
  const ui=createProviderDirectoryUI({mount:dom.mount,api,onChoose:x=>chosen.push(x)});
  t.after(()=>ui.destroy());ui.enter();
  return {...dom,ui,calls,chosen,async open(){const d=dom.$('#next-provider-directory-directory');d.open=true;await d.dispatch('toggle');await until(()=>dom.$('[data-directory-choose]')||/failed/i.test(dom.$('#next-provider-directory-status')?.textContent||''));if(!dom.$('[data-directory-choose]'))throw Error('Search did not produce a selectable result: '+dom.$('#next-provider-directory-status')?.textContent);}};
}

test('searches independent keyed and keyless model API services and separates reviewed from external',async t=>{
  const f=await create(t);await f.open();
  assert.equal(f.calls.length,1);
  assert.match(f.$('#next-provider-directory-results').textContent,/External Inference/);
  assert.match(f.$('#next-provider-directory-results').textContent,/Unverified Native/);
  assert.equal(f.$('#next-provider-directory-results').querySelectorAll('[data-directory-choose]').length,2);
  assert.equal(f.$('#next-provider-directory-results').querySelector('[data-directory-choose="index:native"]'),null,
    'Unsupported native protocols cannot open a fake compatible connection');
  await f.click('[data-directory-choose="builtin:groq"]');
  await f.click('[data-directory-choose="index:outsider"]');
  assert.deepEqual(f.chosen.map(x=>x.id),['builtin:groq','index:outsider']);
  assert.ok(f.calls.every(x=>x.method==='GET'&&x.route.startsWith('/api/provider-directory?')));
  assert.match(f.$('#next-provider-directory-status').textContent,/not provider-side live availability/i);
});

test('model-provider search passes authentication filters and cancels outstanding searches on navigation',async t=>{
  const f=await create(t);await f.open();
  f.$('#next-provider-directory-auth').value='keyed';
  await f.$('#next-provider-directory-auth').dispatch('change');
  await until(()=>f.calls.length===2&&!f.$('#next-provider-directory-search').disabled);
  assert.equal(new URL(f.calls[1].route,'http://localhost').searchParams.get('auth'),'keyed');
  assert.equal(f.$('#next-provider-directory-results').querySelector('[data-directory-choose="index:native"]'),null);
  f.ui.leave();
  assert.equal(f.$('#next-provider-directory-query').disabled,false);
});

test('a failed provider index request does not silently claim a successful discovery',async t=>{
  const f=await create(t,{hold:Promise.reject(new Error('External index inaccessible'))});
  const d=f.$('#next-provider-directory-directory');d.open=true;await d.dispatch('toggle');
  await until(()=>/failed/i.test(f.$('#next-provider-directory-status').textContent));
  assert.match(f.$('#next-provider-directory-status').textContent,/inaccessible/);
  assert.equal(f.$('#next-provider-directory-results').querySelectorAll('[data-directory-choose]').length,0);
});
