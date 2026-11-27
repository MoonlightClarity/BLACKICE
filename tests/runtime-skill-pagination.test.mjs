import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeWorkspace,readRuntimeSkillPages} from '../public/next/workspaces/runtime.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
const until=async fn=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Runtime UI did not settle');};
const rows=n=>Array.from({length:n},(_,i)=>({id:'user-fixture-'+i,title:'Method '+String(i).padStart(4,'0'),revision:2,source:'bundled',catalog:'installed',description:'Method purpose '+i}));
const paged=(entries,version='one')=>(route)=>{const u=new URL(route,'http://test'),offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||200);const page=entries.slice(offset,offset+limit),nextOffset=offset+page.length<entries.length?offset+page.length:null;return {entries:page,totalMatches:entries.length,nextOffset,truncated:nextOffset!==null,catalogVersion:version};};

test('Runtime traverses all metadata pages beyond11000 and preserves deleted-source routing',async()=>{
 const calls=[],entries=rows(12001),get=paged(entries);
 const result=await readRuntimeSkillPages(async route=>{calls.push(route);return get(route);},{source:'deleted'});
 assert.equal(result.entries.length,12001);assert.equal(result.entries.at(-1).id,'user-fixture-12000');
 assert.ok(calls.some(route=>route.includes('offset=11800')));assert.ok(calls.every(route=>new URL(route,'http://test').searchParams.get('source')==='deleted'));
 assert.equal(result.truncated,false);assert.equal(result.nextOffset,null);
});
test('Runtime rejects changed, overlapping, stalled and incomplete metadata pages',async()=>{
 const base={entries:rows(2),totalMatches:3,nextOffset:2,catalogVersion:'one',truncated:true};
 for(const [name,next] of [
  ['changed',{entries:[rows(3)[2]],totalMatches:3,nextOffset:null,catalogVersion:'two'}],
  ['overlapping',{entries:[rows(3)[1]],totalMatches:3,nextOffset:null,catalogVersion:'one'}],
  ['stalled',{entries:[],totalMatches:3,nextOffset:2,catalogVersion:'one'}],
  ['incomplete',{entries:[],totalMatches:3,nextOffset:null,catalogVersion:'one'}]
 ]){
  let n=0;await assert.rejects(readRuntimeSkillPages(async()=>n++?next:base),/changed|overlapping|continuation|before all/,name);
 }
 let calls=0;assert.equal(await readRuntimeSkillPages(async()=>{calls++;return base;},{isCurrent:()=>false}),null);assert.equal(calls,1);
});

test('Runtime bounds rendered skill rows, preserves drafts while paging and opens a deep skill',async t=>{
 const dom=planningDOM(t),entries=rows(1055),calls=[],get=paged(entries);
 const organization={revision:1,folders:[{id:'large-library',name:'Large library',parentId:'runtime:skill'}],assignments:Object.fromEntries(entries.map(row=>[row.id,'large-library']))};
 const api=async(route,method='GET',value)=>{
  calls.push({route,method,value});const u=new URL(route,'http://test');
  if(route==='/api/execution-layers')return {revision:0,layers:[{id:'core',title:'System instructions',text:'CORE',enabled:true,role:'developer'}]};
  if(route==='/api/tool-descriptions')return {revision:0,tools:[]};
  if(route.startsWith('/api/instructions/core'))return {content:'CORE',revision:0,hash:'fixture'};
  if(route==='/api/runtime/organization')return organization;
  if(u.pathname==='/api/skills')return u.searchParams.get('source')==='deleted'?{entries:[],totalMatches:0,nextOffset:null,catalogVersion:'one'}:get(route);
  if(u.pathname.startsWith('/api/skills/')){const row=entries.find(x=>x.id===decodeURIComponent(u.pathname.slice(12)));assert.ok(row);return {...row,content:'# '+row.title+'\n\nBODY '+row.id};}
  throw Error('Unexpected '+route);
 };
 const ui=createRuntimeWorkspace({mount:dom.mount,api});t.after(()=>ui.destroy());ui.enter();
 await until(()=>dom.$('#runtime-status').textContent.includes('1056 runtime sources'));
 assert.equal(Array.from(dom.mount.querySelectorAll('[data-runtime-item]')).filter(node=>node.dataset.runtimeItem.startsWith('skill:')).length,0,'collapsed library creates no hidden skill rows');
 assert.equal(calls.filter(x=>x.route.startsWith('/api/skills/')).length,0,'metadata browse never fetches bodies');
 await dom.click('[data-toggle-category="large-library"]');
 assert.equal(Array.from(dom.mount.querySelectorAll('[data-runtime-item]')).filter(node=>node.dataset.runtimeItem.startsWith('skill:')).length,50);
 const next='[data-runtime-page="large-library"][data-page-direction="next"]',previous='[data-runtime-page="large-library"][data-page-direction="previous"]';
 await dom.click(next);assert.ok(dom.$('[data-runtime-item="skill:user-fixture-50"]'));
 await dom.click('[data-runtime-item="skill:user-fixture-51"]');await until(()=>dom.$('#runtime-text').value.includes('BODY user-fixture-51'));
 assert.match(dom.$('#runtime-source').textContent,/Installed library/);
 await dom.input('#runtime-text','Uncommitted exact draft\r\n');await dom.click(next);await dom.click(previous);
 assert.equal(dom.$('#runtime-text').value,'Uncommitted exact draft\r\n');
 await dom.click('[data-toggle-category="large-library"]');assert.equal(Array.from(dom.mount.querySelectorAll('[data-runtime-item]')).filter(node=>node.dataset.runtimeItem.startsWith('skill:')).length,0);
 await dom.input('#runtime-search','Method 1054');assert.equal(Array.from(dom.mount.querySelectorAll('[data-runtime-item]')).filter(node=>node.dataset.runtimeItem.startsWith('skill:')).length,1);
 await dom.click('[data-runtime-item="skill:user-fixture-1054"]');await until(()=>dom.$('#runtime-text').value.includes('BODY user-fixture-1054'));
 await dom.input('#runtime-search','');ui.openSkillId('user-fixture-1054');await until(()=>dom.$('[data-runtime-item="skill:user-fixture-1054"]'));
 assert.ok(Array.from(dom.mount.querySelectorAll('[data-runtime-item]')).filter(node=>node.dataset.runtimeItem.startsWith('skill:')).length<=50);
 assert.ok(calls.every(x=>x.method==='GET'),'navigation and paging must not mutate skills');
});

test('First Principles entry point defaults to Runtime General methods',async t=>{
 const {createSkillLibrary}=await import('../lib/skill-library.mjs');
 const entry=await createSkillLibrary().metadata('library-fp-first-principles');
 const dom=planningDOM(t),api=async route=>{
  if(route==='/api/execution-layers')return {revision:0,layers:[{id:'core',title:'System instructions',text:'CORE',enabled:true,role:'developer'}]};
  if(route==='/api/tool-descriptions')return {revision:0,tools:[]};
  if(route.startsWith('/api/instructions/core'))return {content:'CORE',revision:0,hash:'fixture'};
  if(route==='/api/runtime/organization')return {revision:0,folders:[],assignments:{}};
  if(route==='/api/skills')return {entries:[entry],totalMatches:1,nextOffset:null};
  if(route==='/api/skills?source=deleted')return {entries:[],totalMatches:0,nextOffset:null};
  throw Error('Unexpected '+route);
 };
 const ui=createRuntimeWorkspace({mount:dom.mount,api});t.after(()=>ui.destroy());ui.enter();
 await until(()=>dom.$('#runtime-status').textContent.includes('2 runtime sources'));
 const general=dom.mount.querySelectorAll('[data-runtime-category]').find(node=>node.dataset.runtimeCategory==='category:General methods');
 assert.ok(general);const button=general.querySelector('[data-toggle-category]');
 assert.match(button.textContent,/General methods \(1\)/);await dom.click(button);
 const current=dom.mount.querySelectorAll('[data-runtime-category]').find(node=>node.dataset.runtimeCategory==='category:General methods');
 assert.ok(current.querySelector('[data-runtime-item="skill:library-fp-first-principles"]'));
});
