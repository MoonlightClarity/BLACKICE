import test from 'node:test';
import assert from 'node:assert/strict';
import {folderRows,folderPath,descendants} from '../public/next/core/folder-tree.mjs';
test('nested folders retain sibling order and expose paths without mutating input',()=>{
 const folders=[{id:'a',name:'Career',parentId:null},{id:'b',name:'Research',parentId:'a'},{id:'c',name:'Other',parentId:null},{id:'d',name:'Boards',parentId:'b'}],before=structuredClone(folders);
 assert.deepEqual(folderRows(folders).map(({id,depth,path})=>({id,depth,path})),[{id:'a',depth:0,path:'Career'},{id:'b',depth:1,path:'Career / Research'},{id:'d',depth:2,path:'Career / Research / Boards'},{id:'c',depth:0,path:'Other'}]);
 assert.equal(folderPath(folders,'d'),'Career / Research / Boards');
 assert.deepEqual([...descendants(folders,'b')],['b','d']);
 assert.deepEqual(folders,before);
});
test('malformed unreachable nodes cannot recurse indefinitely',()=>{
 const folders=[{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'}];
 assert.deepEqual(folderRows(folders),[]);assert.equal(descendants(folders,'a').size,2);
});
