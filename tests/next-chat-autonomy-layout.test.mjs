import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('dialog text input sizing excludes checkbox and radio controls',()=>{
 const css=read('public/next/chat-management.css');
 assert.match(css,/\.next-chat-management-dialog input:not\(\[type=checkbox\]\):not\(\[type=radio\]\)\{width:100%\}/);
 assert.doesNotMatch(css,/\.next-chat-management-dialog input\s*\{[^}]*width:100%/);
});
test('whitelist checkbox retains native fixed size and flexible readable label',()=>{
 const css=read('public/next/chat.css');
 assert.match(css,/\.next-chat-autonomy-model input\[type=checkbox\]\{[^}]*width:16px;[^}]*flex:0 0 16px/);
 assert.match(css,/\.next-chat-autonomy-model span\{min-width:0;flex:1;overflow-wrap:anywhere\}/);
 assert.match(css,/\.next-chat-autonomy-model input:focus-visible\{outline:/);
});
