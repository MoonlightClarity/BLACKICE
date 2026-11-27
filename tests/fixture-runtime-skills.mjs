import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createRuntimeWorkspace} from '../public/next/workspaces/runtime.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {SkillFolderStore} from '../lib/skill-folders.mjs';

export async function waitFor(check,label='Runtime state'){
 for(let i=0;i<200;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error(label+' did not settle');
}
export function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
export function mountRuntime(t,api){
 const dom=planningDOM(t),ui=createRuntimeWorkspace({mount:dom.mount,api});
 t.after(()=>ui.destroy());ui.enter();return {...dom,ui};
}
export async function expandRuntime(f,id){
 const button=f.mount.querySelectorAll('[data-toggle-category]').find(node=>node.dataset.toggleCategory===id);
 assert.ok(button,'Category exists: '+id);
 if(button.getAttribute('aria-expanded')!=='true')await f.click(button);
}
export async function selectRuntimeSkill(f,skill){
 await f.input('#runtime-search',skill.title);
 await waitFor(()=>f.$('[data-runtime-item="skill:'+skill.id+'"]'),'visible matching skill');
 await f.click('[data-runtime-item="skill:'+skill.id+'"]');
 await waitFor(()=>f.$('#runtime-text').value===skill.content,'selected skill body');
 await f.input('#runtime-search','');
}
export async function runtimeSkillsFixture(t){
 const dataDir=await mkdtemp(path.join(tmpdir(),'runtime-skill-lifecycle-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const catalog=createSkillsCatalog({dataDir}),folders=new SkillFolderStore({dataDir,skillExists:id=>catalog.has(id)});
 t.after(async()=>{await catalog.close();await folders.close();});
 const alpha=await catalog.create({value:{content:'# Alpha fixture\n\nSaved alpha instructions.\n'}});
 const beta=await catalog.create({value:{content:'# Beta fixture\n\nSaved beta instructions.\n'}});
 let hook=null;const calls=[];
 const api=async(route,method='GET',value)=>{
  const call={route,method,value};calls.push(call);
  if(hook){const response=await hook(call);if(response!==undefined)return response;}
  const url=new URL(route,'http://fixture');
  if(route==='/api/runtime/organization')return method==='GET'?folders.read():folders.mutate(value);
  if(route==='/api/execution-layers')return {revision:0,layers:[{id:'core',title:'System instructions',text:'Fixture core',enabled:true,role:'developer'}]};
  if(route==='/api/tool-descriptions')return {revision:0,tools:[]};
  if(route.startsWith('/api/instructions/core'))return {content:'Fixture core',revision:0,hash:'fixture-core'};
  if(url.pathname==='/api/skills'){
   if(method==='POST')return catalog.create({value});
   return catalog.list({source:url.searchParams.get('source')||'all',offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||200)});
  }
  const parts=url.pathname.split('/'),id=decodeURIComponent(parts[3]||'');
  if(parts[2]==='skills'){
   if(parts[4]==='restore')return catalog.restore({id,value});
   if(method==='GET')return catalog.detail({id});
   if(method==='POST')return catalog.save({id,value});
   if(method==='DELETE')return catalog.delete({id,value});
  }
  throw Error('Unexpected fixture route '+method+' '+route);
 };
 const f=mountRuntime(t,api);
 await waitFor(()=>f.$('#runtime-text').value==='Fixture core','Runtime initial load');
 return {...f,dataDir,catalog,folders,calls,alpha,beta,setHook(value){hook=value;}};
}
