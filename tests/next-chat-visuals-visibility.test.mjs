import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisualWorkspace} from '../public/next/chat/visuals.mjs';
test('empty visuals reserve no chat scroll space during pending, failed, or switched loads',async()=>{
 const section={setAttribute(){},replaceChildren(){},remove(){}};
 const mount={ownerDocument:{createElement:()=>section},append(){}};
 let owner='first',resolve,reject;
 const api=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});
 const view=createVisualWorkspace({mount,api,getConversationId:()=>owner});
 assert.equal(section.hidden,true);
 let pending=view.refresh();assert.equal(section.hidden,true);reject(Error('offline'));await pending;assert.equal(section.hidden,true);
 pending=view.refresh();resolve({artifacts:[]});await pending;assert.equal(section.hidden,true);
 // Same-owner refresh retains existing content while loading or failing.
 section.hidden=false;pending=view.refresh(true);assert.equal(section.hidden,false);reject(Error('offline'));await pending;assert.equal(section.hidden,false);
 // A previously populated conversation must not leave an empty visible shell.
 section.hidden=false;owner='second';pending=view.refresh();assert.equal(section.hidden,true);reject(Error('offline'));await pending;assert.equal(section.hidden,true);
 pending=view.refresh();resolve({artifacts:[]});await pending;assert.equal(section.hidden,true);view.destroy();
});
