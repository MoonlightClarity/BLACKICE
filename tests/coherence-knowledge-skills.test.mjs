import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {KnowledgeStore} from '../lib/knowledge.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {createKnowledgeWorkspace} from '../public/next/workspaces/knowledge.mjs';
import {createSkillsWorkspace} from '../public/next/workspaces/skills.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
const until=async p=>{const end=Date.now()+5000;while(Date.now()<end){if(p())return;await new Promise(r=>setTimeout(r,10));}throw Error('Coherence workflow did not settle');};
async function setup(t,kind='memory'){
 const dom=planningDOM(t),proto=Object.getPrototypeOf(dom.mount),type=Object.getOwnPropertyDescriptor(proto,'type');Object.defineProperty(proto,'type',{get:type.get,set(v){this.setAttribute('type',v);}});
 proto.replaceChildren=function(...c){for(const x of this.children)x.parentElement=null;this.children=[];this.rawText='';this.markup='';this.append(...c);};
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-coherence-ui-')),cwd=path.join(dir,'project'),store=await new KnowledgeStore({dataDir:dir}).init();
 const original=await store.upsert({id:'entry',kind,title:'Original entry',content:'Original content',cwd},{source:'agent',nodeId:'learning-fixture'});
 let discoveries=0;const catalog=createSkillsCatalog({knowledge:store,defaultCwd:cwd,nativeSkills:async()=>{discoveries++;return {available:true,skills:[{name:'Excluded skill',path:path.join(dir,'excluded','SKILL.md')}]};}});
 const calls=[],events=new Set(),api=async(route,method='GET',body)=>{calls.push({route,method,body});const u=new URL(route,'http://test'),q=u.searchParams,id=u.pathname.split('/')[3];
 if(u.pathname==='/api/knowledge/folders')return method==='GET'?store.folders():store.organize(body);
 if(u.pathname==='/api/skills')return catalog.list({source:q.get('source')||'all',query:q.get('query')||'',cwd:q.get('cwd')||cwd});
 if(u.pathname.startsWith('/api/skills/'))return catalog.detail({id:decodeURIComponent(id),cwd});
 if(u.pathname==='/api/knowledge')return method==='GET'?store.list({kind:q.get('kind')||undefined,query:q.get('query')||'',source:q.get('source')||'all',...(q.has('folderId')?{folderId:q.get('folderId')}:{})}):store.upsert(body,{source:'user'});
 if(u.pathname.endsWith('/history'))return store.history(id);
 if(u.pathname.endsWith('/restore'))return store.restore(id,body.revision,{source:'user'},{expectedRevision:body.expectedRevision});
 if(method==='DELETE')return store.remove(id,{expectedRevision:body.expectedRevision});
 return store.get(id);
 };
 const factory=kind==='skill'?createSkillsWorkspace:createKnowledgeWorkspace;
 const workspace=factory({mount:dom.mount,api,events:{subscribe(f){events.add(f);return()=>events.delete(f);}},onNavigate(){throw Error('Skills must not navigate to Knowledge');}});
 t.after(async()=>{workspace.destroy();await store.writeChain;await rm(dir,{recursive:true,force:true});});workspace.enter();
 return {...dom,store,original,calls,workspace,events,discoveries:()=>discoveries};
}
test('manual organization creates, files, filters, renames and removes folders without changing content or applicability',async t=>{
 const f=await setup(t);await until(()=>f.$('[data-knowledge-id="entry"]'));await f.click('[data-knowledge-id="entry"]');await until(()=>f.$('#next-knowledge-content').value==='Original content');
 const before=f.store.get('entry'),history=f.store.history('entry');
 await until(()=>!f.$('#next-knowledge-folder-create').disabled);await f.input('#next-knowledge-folder-name','Research');await f.click('#next-knowledge-folder-create');await until(()=>f.$('#next-knowledge-file-in').children.length===2);
 const folders=await f.store.folders(),id=folders.folders[0].id;f.$('#next-knowledge-file-in').value=id;await f.$('#next-knowledge-file-in').dispatch('change');for(const listener of f.events)listener({type:'knowledge.updated'});await new Promise(r=>setTimeout(r,260));assert.equal(f.$('#next-knowledge-file-in').value,id,'Unrelated refresh preserves pending folder destination');await f.click('#next-knowledge-file-move');await until(()=>f.store.list({folderId:id}).length===1);
 assert.deepEqual(f.store.get('entry'),before);assert.deepEqual(f.store.history('entry'),history);
 const folderButton=f.$('#next-knowledge-folders').children.find(x=>x.textContent==='Research');await f.click(folderButton);await until(()=>f.calls.some(x=>x.route.includes('folderId='+id)));
 await f.input('#next-knowledge-folder-name','Project decisions');await f.click('#next-knowledge-folder-rename');await until(()=>f.$('#next-knowledge-folders').textContent.includes('Project decisions'));
 await f.click('#next-knowledge-folder-remove');await until(()=>f.$('#next-knowledge-file-in').children.length===1);assert.equal(f.store.list({folderId:''}).length,1);assert.deepEqual(f.store.get('entry'),before);
 f.$('#next-knowledge-source').value='user';await f.$('#next-knowledge-source').dispatch('change');await until(()=>f.$('#next-knowledge-list-note').textContent==='0 of 0 entries shown.');assert.equal(f.$('#next-knowledge-filter-note').hidden,false);
 f.$('#next-knowledge-source').value='learned';await f.$('#next-knowledge-source').dispatch('change');await until(()=>f.$('[data-knowledge-id="entry"]'));
 assert.equal(f.$('#next-knowledge-filter-note').hidden,true);assert.equal(f.$('#next-knowledge-kind').closest('label').hidden,true);
});
test('Skills edits and creates in place, preserves draft on re-entry, and external discovery is opt-in only',async t=>{
 const f=await setup(t,'skill');await until(()=>f.$('[data-skill-id="saved:entry"]'));assert.equal(f.discoveries(),0);
 await f.click('[data-skill-id="saved:entry"]');await until(()=>!f.$('#skills-edit').hidden);await f.click('#skills-edit');await until(()=>f.$('#skills-editor-content').value==='Original content');
 await f.input('#skills-editor-content','Edited skill content');f.workspace.leave();f.workspace.enter();assert.equal(f.$('#skills-editor-content').value,'Edited skill content');
 await f.$('#skills-editor-form').dispatch('submit',{preventDefault(){}});await until(()=>f.store.get('entry').revision===2);assert.equal(f.store.get('entry').cwd,f.original.cwd);
 await until(()=>!f.$('#skills-editor-new').disabled);await f.click('#skills-back');await f.click('#skills-new');await f.input('#skills-editor-title','New skill');await f.input('#skills-editor-content','New procedure');await f.$('#skills-editor-form').dispatch('submit',{preventDefault(){}});await until(()=>f.store.list({kind:'skill'}).length===2);
 await f.click('#skills-back');await until(()=>!f.$('#skills-refresh').disabled);await f.click('#skills-external');await until(()=>f.$('#skills-status').textContent.includes('1 disabled external discoveries'));assert.ok(f.discoveries()>0);assert.equal(f.$('#skills-list').querySelectorAll('button').length,1);
 await f.click('#skills-normal');await until(()=>f.$('[data-skill-id="saved:entry"]'));assert.equal(f.$('#skills-list').textContent.includes('Excluded skill'),false);
});

test('save, Trash and restore immediately release folder controls without refresh',async t=>{
 const f=await setup(t);await until(()=>f.$('[data-knowledge-id="entry"]'));await f.click('[data-knowledge-id="entry"]');await until(()=>f.$('#next-knowledge-content').value==='Original content');
 await f.input('#next-knowledge-content','Saved content');await f.$('#next-knowledge-form').dispatch('submit',{preventDefault(){}});await until(()=>f.store.get('entry').revision===2);await until(()=>!f.$('#next-knowledge-new').disabled);
 assert.equal(f.$('#next-knowledge-folder-create').disabled,false);assert.equal(f.$('#next-knowledge-file-move').disabled,false);
 await f.input('#next-knowledge-folder-name','After save');await f.click('#next-knowledge-folder-create');await until(()=>f.$('#next-knowledge-file-in').children.length===2);
 let folders=await f.store.folders(),id=folders.folders[0].id;f.$('#next-knowledge-file-in').value=id;await f.$('#next-knowledge-file-in').dispatch('change');await f.click('#next-knowledge-file-move');await until(()=>!f.$('#next-knowledge-delete').disabled);assert.equal(f.store.list({folderId:id}).length,1);
 await f.click('#next-knowledge-delete');await until(()=>!f.$('#next-knowledge-recover').hidden&&!f.$('#next-knowledge-recover').disabled);
 assert.equal(f.$('#next-knowledge-folder-create').disabled,false);assert.equal(f.$('#next-knowledge-file-move').disabled,true,'Trash cannot be filed');
 await f.input('#next-knowledge-folder-name','After Trash');await f.click('#next-knowledge-folder-create');await until(()=>f.$('#next-knowledge-file-in').children.length===3);await until(()=>!f.$('#next-knowledge-recover').disabled);
 await f.click('#next-knowledge-recover');await until(()=>f.$('#next-knowledge-recover').hidden&&!f.$('#next-knowledge-new').disabled);
 assert.equal(f.$('#next-knowledge-folder-create').disabled,false);assert.equal(f.$('#next-knowledge-file-move').disabled,false);
 folders=await f.store.folders();id=folders.folders.find(x=>x.name==='After Trash').id;f.$('#next-knowledge-file-in').value=id;await f.$('#next-knowledge-file-in').dispatch('change');await f.click('#next-knowledge-file-move');await until(()=>f.store.list({folderId:id}).length===1);assert.equal(f.store.get('entry').content,'Saved content');assert.equal(f.store.get('entry').cwd,f.original.cwd);
});

test('external removal of selected folder resets filter while keeping unsaved draft',async t=>{
 const f=await setup(t);await until(()=>f.$('[data-knowledge-id="entry"]'));await f.click('[data-knowledge-id="entry"]');await until(()=>f.$('#next-knowledge-content').value==='Original content');
 await until(()=>!f.$('#next-knowledge-folder-create').disabled);await f.input('#next-knowledge-folder-name','Temporary');await f.click('#next-knowledge-folder-create');await until(()=>f.$('#next-knowledge-file-in').children.length===2);
 let folders=await f.store.folders(),id=folders.folders[0].id;await f.store.organize({action:'move',expectedRevision:folders.revision,folderId:id,entryIds:['entry']});await f.click(f.$('#next-knowledge-folders').children.find(x=>x.textContent==='Temporary'));await until(()=>f.calls.some(x=>x.route.includes('folderId='+id)));
 await f.input('#next-knowledge-content','Unsaved draft');folders=await f.store.folders();await f.store.organize({action:'remove',expectedRevision:folders.revision,folderId:id});for(const listener of f.events)listener({type:'knowledge.updated'});
 await until(()=>!f.$('#next-knowledge-folders').textContent.includes('Temporary'));await until(()=>f.calls.filter(x=>x.route.startsWith('/api/knowledge?')).at(-1)?.route.includes('folderId=')===false);
 assert.equal(f.$('#next-knowledge-folders').children[0].getAttribute('aria-pressed'),'true');assert.equal(f.$('#next-knowledge-folder-name').value,'');assert.equal(f.$('#next-knowledge-folder-rename').disabled,true);assert.equal(f.$('#next-knowledge-folder-remove').disabled,true);assert.equal(f.$('#next-knowledge-content').value,'Unsaved draft');assert.equal(f.store.get('entry').content,'Original content');
});
