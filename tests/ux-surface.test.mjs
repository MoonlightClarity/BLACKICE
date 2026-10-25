import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderContextFields} from '../public/context-ui.mjs';
import {renderResponseDefaults} from '../public/response-defaults.mjs';

const get=relative=>readFile(new URL('../'+relative,import.meta.url),'utf8');

test('Signal Surface loads last and is whitelisted by the actual HTTP file server',async()=>{
 const html=await get('public/index.html');
 const server=await get('server.mjs');
 const styles=await get('public/relay-surface.css');
 assert.match(html, /href="\/relay-surface\.css"/);
 assert.ok(html.indexOf('href="/relay-surface.css"')>html.indexOf('href="/prompts.css"'));
 assert.match(server, /'relay-surface\.css'/);
 assert.match(styles, /@media\(min-width:980px\)/);
 assert.match(styles, /\.conversation-workspace \.conversation-sidebar\s*\{\s*display:flex/);
 assert.match(styles, /\.conversation-context-slot\{display:none\}/);
 assert.match(styles, /\.conversation-workspace\.show-context-diagnostics \.conversation-context-slot\{display:block\}/);
 assert.match(styles, /\.conversation-message-text p,/);
 assert.match(styles, /background:transparent!important/);
});

test('everyday context controls are automatic and advanced capacity remains optional',async()=>{
 const context=renderContextFields({preset:'model',autoCompact:true},{prefix:'review-context'});
 assert.match(context,/Automatically|managed automatically|Continuity is managed automatically/i);
 assert.ok(!context.includes('data-context-option="autoCompact"'));
 assert.match(context,/Advanced context capacity/);
 const settings=renderResponseDefaults({runtimeSettings:{defaultEffort:'default',defaultContext:{preset:'model',autoCompact:true},verbosity:'balanced',subagentsEnabled:true,maxSubagents:3}},{});
 assert.match(settings,/Agent preferences/);
 assert.match(settings,/Advanced context capacity/);
 assert.ok(!settings.includes('data-response-default="autoCompact"'));
 assert.match(settings,/routine context compaction automatically/);
 assert.match(settings,/Parallel workers/);
 assert.match(settings,/Response length/);
});

test('new identity markup is limited to presentation and keeps durable Relay identifiers',async()=>{
 const app=await get('public/app.js');
 const html=await get('public/index.html');
 const mission=await get('public/mission-ui.mjs');
 const server=await get('server.mjs');
 const navigation=app.match(/<nav\b(?=[^>]*\brole="tablist")(?=[^>]*\baria-label="Workspace mode")[^>]*>([\s\S]*?)<\/nav>/)?.[1];
 assert.ok(navigation,'the primary workspace destinations belong to a named tablist');
 const tabs=[...navigation.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([,markup,content])=>({label:content.match(/<span\b[^>]*class="[^"]*\bworkspace-tab-label\b[^"]*"[^>]*>([^<]+)<\/span>/)?.[1].trim(),attributes:Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,name,value])=>[name,value]))}));
 assert.equal(tabs.length,5,'Chat, Activity, Planning, Tasks and Settings are the five primary classic workspace tabs');
 assert.deepEqual(tabs.map(tab=>tab.attributes['data-mode']),['view','observe','planning','tasks','configure'],'primary tabs keep their stable identifiers and give Planning its own destination');
 for(const[mode,label,selected,tabIndex]of [['view','Chat','true','0'],['observe','Activity','false','-1'],['planning','Planning','false','-1'],['tasks','Tasks','false','-1'],['configure','Settings','false','-1']]){
  const tab=tabs.find(tab=>tab.attributes['data-mode']===mode);assert.ok(tab,`${label} has its own mode`);assert.equal(tab.label,label);assert.equal(tab.attributes.role,'tab');assert.equal(tab.attributes['aria-selected'],selected);assert.equal(tab.attributes.tabindex,tabIndex);
 }
 const menu=app.match(/<details class="workspace-menu">([\s\S]*?)<\/details>/)?.[1];assert.ok(menu,'advanced destinations retain the named Workspace menu');
 assert.match(menu,/<span class="workspace-menu-label">Advanced<\/span>\s*<button data-action="workflow">Workflow canvas<\/button>/,'the existing workflow identifier remains reachable as the Advanced canvas action');
 assert.match(app,/if\(action==='workflow'\)return selectWorkspaceMode\('workflow'\)/,'the Advanced action retains the existing workflow route');
 assert.match(app,/workspace-brand-meta/);
 assert.match(app,/<span class="workspace-wordmark-label">BLACKICE<\/span>/,'the vector wordmark retains accessible text');
 assert.match(app,/<img\b[^>]*src="\/assets\/blackice-wordmark\.svg"[^>]*aria-hidden="true"/,'decorative vector letters do not duplicate the accessible name');
 assert.match(mission,/conversation-new-top/);
 assert.match(mission,/aria-label="New chat"/);
 assert.match(mission,/show-context-diagnostics/);
 assert.match(mission,/conversation-starters/);
 assert.match(mission,/conversation-folder-chip/);
 assert.match(mission,/conversation-attach/);
 assert.match(mission,/Undo draft/);
 assert.match(mission,/Ask a question or assign a task/);
 assert.ok(server.includes("'composer-helpers.mjs'"));
 assert.match(html,/<title>BLACKICE/);
});
