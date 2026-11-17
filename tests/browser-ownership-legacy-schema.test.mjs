import test from 'node:test';
import assert from 'node:assert/strict';
import {ownershipChange} from '../lib/browser-ownership.mjs';
const old={taskId:'old',nodeId:'agent',runId:'r'},next={taskId:'new',nodeId:'agent',runId:'s'};
const key=JSON.stringify(['old','agent','r']);
const tab={tabId:'t',url:'https://example.test/',documentId:'t:1',owner:old,adoption:{eligible:true,runId:'r',status:'completed'}};
const args={action:'take_ownership',tabId:'t',expectedUrl:tab.url,expectedDocumentId:tab.documentId};
test('legacy key keeps exact identity and rejects conflicting or wrong keys',()=>{
 assert.deepEqual(ownershipChange({...args,destinationOwnerKey:key},{tabs:[tab]},next).owner,next);
 assert.deepEqual(ownershipChange({...args,destinationOwnerKey:key,expectedOwnerKey:key},{tabs:[tab]},next).owner,next);
 assert.throws(()=>ownershipChange({...args,destinationOwnerKey:key,expectedOwnerKey:'different'},{tabs:[tab]},next));
 assert.throws(()=>ownershipChange({...args,destinationOwnerKey:'different'},{tabs:[tab]},next));
 assert.throws(()=>ownershipChange({...args,destinationOwnerKey:key,destination:'task'},{tabs:[tab]},next));
 assert.throws(()=>ownershipChange({...args,destinationOwnerKey:key},{tabs:[{...tab,adoption:{eligible:false}}]},next));
});
