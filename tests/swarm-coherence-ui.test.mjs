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
test('repeated browser task labels remain distinguished by their exact owner',async()=>{
 const cleanup=await readFile(new URL('../public/next/workspaces/browser-scoped-cleanup-ui.mjs',import.meta.url),'utf8');
 assert.match(cleanup,/repeatedLabels.get/);assert.match(cleanup,/JSON.stringify/);
});
