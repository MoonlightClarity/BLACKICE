import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {interfaceReloadInput,bindInterfaceReloadShortcuts} from '../desktop/interface-reload-shortcut.mjs';
test('Ctrl+R, F5 and Ctrl+Shift+R refresh the interface',()=>{
 for(const input of [{type:'keyDown',key:'r',control:true},{type:'keyDown',key:'R',control:true,shift:true},{type:'keyDown',key:'F5'},{type:'keyDown',code:'F5'}])assert.equal(interfaceReloadInput(input),true,JSON.stringify(input));
 for(const input of [{type:'keyUp',key:'F5'},{type:'keyDown',key:'r'},{type:'keyDown',key:'r',alt:true,control:true},{type:'keyDown',key:'F5',isAutoRepeat:true},{type:'keyDown',key:'F5',control:true},{type:'keyDown',key:'Escape'}])assert.equal(interfaceReloadInput(input),false,JSON.stringify(input));
});
test('native handler reloads only explicit keys and can be detached',()=>{
 const contents=new EventEmitter();let reloads=0,prevented=0;
 contents.reloadIgnoringCache=()=>{reloads++};
 const detach=bindInterfaceReloadShortcuts(contents);
 for(const input of [{type:'keyDown',key:'r',control:true},{type:'keyDown',key:'F5'},{type:'keyDown',key:'r'}])contents.emit('before-input-event',{preventDefault(){prevented++}},input);
 assert.equal(reloads,2);assert.equal(prevented,2);
 detach();contents.emit('before-input-event',{preventDefault(){prevented++}},{type:'keyDown',key:'F5'});
 assert.equal(reloads,2);
});
test('main native window binds shortcut; Chat includes a visible reload control',async()=>{
 const [main,frame,chat]=await Promise.all([readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8'),readFile(new URL('../public/next/chat/render.mjs',import.meta.url),'utf8'),readFile(new URL('../public/next/chat/chat.mjs',import.meta.url),'utf8')]);
 assert.match(main,/bindInterfaceReloadShortcuts\(contents\)/);
 assert.match(frame,/id="next-chat-reload-ui"/);
 assert.match(chat,/next-chat-reload-ui[\s\S]*location\.reload\(\)/);
});