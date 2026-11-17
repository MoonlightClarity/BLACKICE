import test from 'node:test';import assert from 'node:assert/strict';
import {restoreBrowserCollections} from '../lib/browser-collections.mjs';
import {browserCollectionTree} from '../public/next/workspaces/browser-folders.mjs';
test('old profiles and malformed hierarchy remain readable',()=>{
 assert.equal(restoreBrowserCollections(undefined).size,0);
 const f=restoreBrowserCollections([{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'},{id:'c',name:'C',parentId:'missing'}]);
 assert.equal(f.get('a').parentId,null);assert.equal(f.get('c').parentId,null);
 const tree=browserCollectionTree([...f.values()],[{tabId:'t',collectionId:'b'},{tabId:'u',collectionId:'gone'}]);
 assert.equal(tree.roots[0].children[0].tabs[0].tabId,'t');assert.equal(tree.loose[0].tabId,'u');
});
