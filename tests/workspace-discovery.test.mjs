import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {createWorkspaceToolHandler,WORKSPACE_INSTRUCTIONS,WORKSPACE_TOOL} from '../lib/workspace-tools.mjs';
const call=arguments_=>({name:'relay_workspace',arguments:arguments_});
const parsed=r=>{assert.equal(r.success,true,r.contentItems?.[0]?.text);return JSON.parse(r.contentItems[0].text);};
const quote=s=>process.platform==='win32'?"'"+s.replaceAll("'","''")+"'":"'"+s.replaceAll("'","'\\''")+"'";
test('blank profile does not prevent bounded command discovery and reading outside workspace',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-discovery-')),cwd=path.join(root,'work'),outside=path.join(root,'Synced Career Files');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(cwd);await mkdir(outside);await writeFile(path.join(cwd,'USER.md'),'');await writeFile(path.join(outside,'Synthetic Resume.txt'),'Synthetic resume fixture: systems analysis.');
 const h=createWorkspaceToolHandler({cwd}),first=parsed(await h(call({action:'list'})));
 assert.equal(first.entries.some(x=>x.name.includes('Resume')),false);assert.equal(first.discovery.parentDirectory,root);assert.equal(first.discovery.homeDirectory,homedir());assert.match(first.discovery.scope,/only the selected/);
 const parent=parsed(await h(call({action:'list',path:first.discovery.parentDirectory,depth:0})));
 const candidate=parent.entries.find(x=>x.type==='directory'&&x.name.includes('Career'));assert.ok(candidate);
 const command=process.platform==='win32'?`Get-ChildItem -LiteralPath ${quote(candidate.path)} -File -Filter '*Resume*' | Select-Object -ExpandProperty FullName`:`find ${quote(candidate.path)} -maxdepth 1 -type f -name '*Resume*'`;
 const discovered=parsed(await h(call({action:'run',command})));assert.equal(discovered.exitCode,0);const file=discovered.stdout.trim();assert.equal(file,path.join(outside,'Synthetic Resume.txt'));
 assert.match(parsed(await h(call({action:'read',path:file}))).content,/systems analysis/);assert.equal(await readFile(path.join(cwd,'USER.md'),'utf8'),'');
});
test('model guidance describes existing command discovery without requiring profile facts or new permissions',async()=>{
 assert.match(WORKSPACE_INSTRUCTIONS,/not a filesystem sandbox/);assert.match(WORKSPACE_INSTRUCTIONS,/bounded filename discovery with list or run/);assert.match(WORKSPACE_INSTRUCTIONS,/search searches file contents, not filenames/);assert.match(WORKSPACE_INSTRUCTIONS,/rather than assuming a username/);assert.match(WORKSPACE_INSTRUCTIONS,/do not crawl the entire computer/);
 assert.deepEqual(WORKSPACE_TOOL.inputSchema.properties.action.enum,['list','read','write','patch','patch_history','undo_patch','search','run']);
 const engine=await readFile(new URL('../lib/engine.mjs',import.meta.url),'utf8');assert.match(engine,/WORKSPACE_INSTRUCTIONS/);
});
