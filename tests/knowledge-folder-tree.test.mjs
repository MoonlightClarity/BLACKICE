import test from 'node:test';import assert from 'node:assert/strict';
import {knowledgeFolderTree,knowledgeFolderOptions,compactKnowledgePreview} from '../public/next/workspaces/knowledge-model.mjs';
test('folder tree supports legacy roots, nested paths, missing parents and defensive cycles',()=>{
 const folders=[{id:'a',name:'Research'},{id:'b',name:'Jobs',parentId:'a'},{id:'c',name:'Notes',parentId:'b'}];
 assert.equal(knowledgeFolderTree(folders)[0].children[0].children[0].id,'c');assert.deepEqual(knowledgeFolderOptions(folders).map(x=>x.path),['Research','Research / Jobs','Research / Jobs / Notes']);assert.equal(folders[0].children,undefined);
 assert.equal(knowledgeFolderTree([{id:'a',parentId:'b'},{id:'b',parentId:'a'}]).length,2);assert.equal(knowledgeFolderTree([{id:'a',parentId:'missing'}]).length,1);
});
test('compact preview normalizes whitespace without mutating content',()=>{assert.equal(compactKnowledgePreview('  two\n lines  '),'two lines');assert.equal(compactKnowledgePreview('x'.repeat(400)).length,110);assert.equal(compactKnowledgePreview(null),'');});
