import test from 'node:test';
import {EventEmitter} from 'node:events';
import {HarnessEngine} from '../lib/engine.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {createWorkspaceToolHandler,WORKSPACE_INSTRUCTIONS,WORKSPACE_TOOL,FIND_FILES_TOOL} from '../lib/workspace-tools.mjs';
const call=arguments_=>({name:'relay_workspace',arguments:arguments_});
const find=arguments_=>({name:'relay_find_files',arguments:arguments_});
const parsed=r=>{assert.equal(r.success,true,r.contentItems?.[0]?.text);return JSON.parse(r.contentItems[0].text);};
test('blank profile does not prevent native filename discovery and reading outside workspace',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-discovery-')),cwd=path.join(root,'work'),outside=path.join(root,'Synced Career Files');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(cwd);await mkdir(outside);await writeFile(path.join(cwd,'USER.md'),'');await writeFile(path.join(outside,'Synthetic Resume.txt'),'Synthetic resume fixture: systems analysis.');
 const h=createWorkspaceToolHandler({cwd}),first=parsed(await h(call({action:'list'})));
 assert.equal(first.entries.some(x=>x.name.includes('Resume')),false);assert.equal(first.discovery.parentDirectory,root);assert.equal(first.discovery.homeDirectory,homedir());assert.match(first.discovery.scope,/only the selected/);
 const parent=parsed(await h(call({action:'list',path:first.discovery.parentDirectory,depth:0})));
 const candidate=parent.entries.find(x=>x.type==='directory'&&x.name.includes('Career'));assert.ok(candidate);
 const discovered=parsed(await h(find({path:candidate.path,query:'Resume'})));assert.equal(discovered.searchComplete,true);const file=discovered.matches[0].path;assert.equal(file,path.join(outside,'Synthetic Resume.txt'));
 assert.match(parsed(await h(call({action:'read',path:file}))).content,/systems analysis/);assert.equal(await readFile(path.join(cwd,'USER.md'),'utf8'),'');
});
test('large Documents listing switches to native filename search from observed task context',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-large-discovery-')),cwd=path.join(root,'work'),documents=path.join(root,'Documents');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(cwd);await mkdir(documents);await writeFile(path.join(cwd,'USER.md'),'');
 await Promise.all(Array.from({length:350},(_,i)=>writeFile(path.join(documents,'A'+String(i).padStart(4,'0')+'.txt'),'Unrelated synthetic document')));
 await writeFile(path.join(documents,'Z Synthetic Resume.txt'),'Synthetic resume: verified outside large listing.');
 const first=createWorkspaceToolHandler({cwd});const initial=parsed(await first(call({action:'list'})));
 const parent=parsed(await first(call({action:'list',path:initial.discovery.parentDirectory})));
 const observed=parent.entries.find(x=>x.type==='directory'&&x.name==='Documents');assert.ok(observed);
 const listing=parsed(await first(call({action:'list',path:observed.path,limit:100})));
 assert.equal(listing.truncated,true);assert.equal(listing.entries.length,100);assert.ok(!listing.entries.some(x=>x.name.includes('Resume')));assert.match(listing.nextAction,/narrow filename search/);
 const oversized=parsed(await first(call({action:'list',path:observed.path,limit:300})));assert.equal(oversized.truncated,true);assert.match(oversized.nextAction,/narrow filename search/);assert.equal(oversized.path,observed.path);
 const checkpoint=JSON.parse(JSON.stringify({directory:listing.path,query:'Resume'}));
 const resumed=createWorkspaceToolHandler({cwd});const found=parsed(await resumed(find({path:checkpoint.directory,query:checkpoint.query})));
 assert.equal(found.searchComplete,true);const file=found.matches[0].path;assert.equal(file,path.join(documents,'Z Synthetic Resume.txt'));
 assert.match(parsed(await resumed(call({action:'read',path:file}))).content,/verified outside large listing/);assert.equal(await readFile(path.join(cwd,'USER.md'),'utf8'),'');
 assert.match(WORKSPACE_TOOL.description,/relay_find_files locates unknown filenames and paths/);assert.match(WORKSPACE_INSTRUCTIONS,/same query and returned cursor/);
});
test('model guidance exposes native filename discovery without profile facts or new permissions',async()=>{
 // Source-specific routing and search coverage remain; global policy no longer lives in this addendum.
 assert.match(WORKSPACE_TOOL.description,/[Aa]bsolute paths are supported/);
 assert.match(WORKSPACE_TOOL.description,/relay_find_files locates unknown filenames and paths/);
 assert.match(WORKSPACE_TOOL.description,/search matches one literal string inside files/);
 assert.match(FIND_FILES_TOOL.description,/searchComplete.*errors.*skippedCount.*roots/);
 assert.deepEqual(WORKSPACE_TOOL.inputSchema.properties.action.enum,['list','read','stat','write','append','patch','patch_history','undo_patch','search','run']);
 assert.equal(FIND_FILES_TOOL.name,'relay_find_files');assert.deepEqual(FIND_FILES_TOOL.inputSchema.required,['query']);
 const engine=await readFile(new URL('../lib/engine.mjs',import.meta.url),'utf8');assert.match(engine,/WORKSPACE_INSTRUCTIONS/);
});

test('a known absolute input and explicit search roots are independent of the working folder',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-file-scope-')),cwd=path.join(root,'work'),outside=path.join(root,'Documents'),missing=path.join(root,'Unavailable');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(cwd);await mkdir(outside);
 const file=path.join(outside,'scope-target.txt');await writeFile(file,'Readable input outside the output folder.');
 const h=createWorkspaceToolHandler({cwd,rgCommand:'blackice-no-such-rg-fixture'});
 assert.match(parsed(await h(call({action:'read',path:file}))).content,/outside the output folder/);
 const localMiss=await h(call({action:'read',path:'scope-target.txt'}));
 assert.equal(localMiss.success,false);assert.equal(JSON.parse(localMiss.contentItems[0].text).code,'ENOENT');
 const narrow=parsed(await h(find({query:'scope-target',roots:[cwd]})));
 assert.deepEqual(narrow.matches,[]);assert.equal(narrow.searchComplete,true);assert.deepEqual(narrow.roots,[cwd]);
 const broadened=parsed(await h(find({query:'scope-target',roots:[outside]})));
 assert.deepEqual(broadened.matches.map(x=>x.path),[file]);assert.deepEqual(broadened.roots,[outside]);
 const incomplete=parsed(await h(find({query:'scope-target',roots:[outside,missing]})));
 assert.equal(incomplete.scanComplete,true);assert.equal(incomplete.searchComplete,false);assert.equal(incomplete.cursor,null);
 assert.ok(incomplete.errors.some(x=>x.path===missing&&x.code==='ENOENT'));
 assert.match(incomplete.coverage,/Follow cursor while present/);assert.match(incomplete.coverage,/limit that claim to these roots/);
 assert.doesNotMatch(FIND_FILES_TOOL.description,/until searchComplete/);
 const contentMiss=parsed(await h(call({action:'search',query:'Readable input'})));
 assert.equal(contentMiss.path,cwd);assert.deepEqual(contentMiss.matches,[]);
 const contentFound=parsed(await h(call({action:'search',path:file,query:'Readable input'})));
 assert.equal(contentFound.path,file);assert.equal(contentFound.matches.length,1);
});

test('native delivery states file scope and can read a user-supplied path outside cwd',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-file-scope-delivery-')),cwd=path.join(root,'outputs'),outside=path.join(root,'inputs');
 let engine; t.after(async()=>{await engine?.close();await rm(root,{recursive:true,force:true});});
 await mkdir(cwd);await mkdir(outside);const file=path.join(outside,'known-source.txt');await writeFile(file,'Outside path was read through the delivered native tool.');
 let admissions=0;
 class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'file-scope-fixture',models:[{id:'file-scope-fixture',supportsTools:true}]};}
  async runAgent(options){
   admissions++;const workspace=options.dynamicTools.find(x=>x.name==='relay_workspace'),finder=options.dynamicTools.find(x=>x.name==='relay_find_files');
   assert.match(workspace.description,/working folder.*not a filesystem access boundary/);
   assert.match(finder.description,/cwd resolves relative roots; it does not confine/);
   assert.match(options.prompt+'\n'+options.developerInstructions,/output destination do not limit input discovery/);
   assert.equal(workspace.inputSchema.properties.path.type,'string');assert.ok(finder.inputSchema.properties.roots);
   options.onEvent?.({type:'thread',threadId:'file-scope-fixture-thread'});
   const read=parsed(await options.onToolCall(call({action:'read',path:file})));
   assert.equal(read.path,file);assert.match(read.content,/Outside path was read/);
   return{threadId:'file-scope-fixture-thread',output:'Read the supplied absolute source path.'};
  }
 }
 engine=await new HarnessEngine({runtime:new Runtime(),dataDir:path.join(root,'data'),defaultCwd:cwd}).init();
 const workflow={id:'file-scope-delivery',name:'File scope delivery',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'file-scope-fixture',prompt:'Read the supplied file.'},{id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
 const run=engine.startRun({workflow,input:'Read the source at '+file+'. Save any requested output under '+cwd+'.'});
 await engine.executions.get(run.id);assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);assert.equal(admissions,1);
});

test('a plausible workspace derivative is not proof of source identity; outside candidates stay discoverable',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-source-authority-')),cwd=path.join(root,'work'),personal=path.join(root,'Documents');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(cwd);await mkdir(personal);
 const derivative=path.join(cwd,'Synthetic Resume David AI.txt'),source=path.join(personal,'Synthetic Resume Thin.txt');
 await writeFile(derivative,'Historical task-specific derivative.');await writeFile(source,'Current designated application document.');
 const h=createWorkspaceToolHandler({cwd});
 const local=parsed(await h(call({action:'list'})));assert.ok(local.entries.some(x=>x.path===derivative));
 assert.match(WORKSPACE_TOOL.description,/listing hit is only a candidate/);
 const first=parsed(await h(find({query:'Synthetic Resume',roots:[cwd,personal],limit:1})));
 assert.equal(first.matches.length,1);assert.ok(first.cursor);assert.equal(first.searchComplete,false);
 assert.match(first.searchScopeNotice,/candidate paths, not proof of identity or authority/);
 assert.match(first.readHint,/Discovery order and workspace location confer no authority/);
 const second=parsed(await h(find({query:'Synthetic Resume',cursor:first.cursor,limit:10})));
 assert.deepEqual(new Set([...first.matches,...second.matches].map(x=>x.path)),new Set([derivative,source]));
 assert.match(parsed(await h(call({action:'read',path:source}))).content,/Current designated application document/);
 assert.match(FIND_FILES_TOOL.description,/not a preferred source of user information/);
 assert.match(WORKSPACE_INSTRUCTIONS,/Do not infer source authority from location/);
 assert.match(FIND_FILES_TOOL.inputSchema.properties.timeoutMs.description,/default 3000 ms/);
});
