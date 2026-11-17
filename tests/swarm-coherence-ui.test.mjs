import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile}from'node:fs/promises';
import {browserScopedCleanupMarkup,cleanupGroups}from'../public/next/workspaces/browser-scoped-cleanup-ui.mjs';
test('cleanup names its choice as tabs to review while preserving exact ownership groups',()=>{
 assert.match(browserScopedCleanupMarkup(),/Tabs to review/);
 assert.doesNotMatch(browserScopedCleanupMarkup(),/<label>Scope /);
 const owner={taskId:'task',nodeId:'node',label:'Research'};
 assert.deepEqual(cleanupGroups({tabs:[{conversationId:'c',owner},{conversationId:'other',owner},{conversationId:'c',purpose:'chat-mode',owner}]},'c'),[{taskId:'task',nodeId:'node',label:'Research',count:1}]);
});
test('Swarm uses shared surfaces and responsive readable work board',async()=>{
 const css=await readFile(new URL('../public/next/swarm.css',import.meta.url),'utf8');
 assert.match(css,/background:var\(--next-workspace-background\)/);
 assert.match(css,/grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,210px\),1fr\)\)/);
 assert.match(css,/\.swarm-input\{font-size:14px/);
 const source=await readFile(new URL('../public/next/workspaces/swarm.mjs',import.meta.url),'utf8');
 assert.match(source,/Project settings & team/);
 assert.match(source,/root.append\(setup\)/);
 assert.doesNotMatch(source,/REA adaptation|Not recursive task Planning/);
});
test('Swarm selection has a focusable detail and explicit return path; repeated task names are distinguished',async()=>{
 const source=await readFile(new URL('../public/next/workspaces/swarm.mjs',import.meta.url),'utf8');
 assert.match(source,/inspectingItem = true; render\(\)/);
 assert.match(source,/title.focus\(\{ preventScroll: true \}\)/);
 assert.match(source,/Back to work board/);
 assert.match(source,/event.key === 'Escape'/);
 assert.match(source,/original.focus\(\)/);
 assert.doesNotMatch(source,/OAuth grants are shared|No authenticated actor binding|Evidence authority needed/);
 const cleanup=await readFile(new URL('../public/next/workspaces/browser-scoped-cleanup-ui.mjs',import.meta.url),'utf8');
 assert.match(cleanup,/repeatedLabels.get\(group.label\) > 1/);
 assert.match(cleanup,/JSON.stringify\(\[group.taskId, group.nodeId\]\)/);
});
