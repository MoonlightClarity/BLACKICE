import test from 'node:test';
import assert from 'node:assert/strict';
import {compileVisual} from '../public/visual-document.mjs';
const doc=version=>({version,kind:'composed',title:'Geometry',summary:'No invisible evidence',width:200,height:150});
for(const version of [1,2]){
 test('version '+version+' rejects invisible horizontal notes and top clipping',()=>{
  for(const note of [{text:'Evidence',x:500,y:20},{text:'Evidence',x:193,y:20},{text:'Evidence',x:20,y:0}]){
   assert.throws(()=>compileVisual({...doc(version),notes:[note]}),{code:'VISUAL_INVALID'});
  }
 });
 test('version '+version+' wraps note text to actual remaining canvas width',()=>{
  const result=compileVisual({...doc(version),notes:[{text:'One two three four five six seven eight nine',x:100,y:20}]});
  const rows=[...result.svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map(m=>m[1]);
  assert.ok(rows.length>1);
  assert.ok(rows.every(row=>Array.from(row).length<=12));
  assert.match(result.text,/One two three four five six seven eight nine/);
 });
 test('version '+version+' rejects note overflow after wrapping',()=>{
  assert.throws(()=>compileVisual({...doc(version),notes:[{text:'One two three four five six seven eight nine',x:100,y:130}]}),{code:'VISUAL_INVALID'});
 });
 test('version '+version+' rejects invalid grid widths',()=>{
  for(const x of [181,200,400])assert.throws(()=>compileVisual({...doc(version),grid:{x,y:10,columns:['A'],rows:[['B']]}}),{code:'VISUAL_INVALID'});
 });
}
test('automatic note layout expands canvas using actual wrapping',()=>{
 const result=compileVisual({version:2,kind:'composed',title:'Notes',summary:'Fits',width:200,notes:[{text:'word '.repeat(50).trim()}]});
 assert.ok(Number(result.svg.match(/height="(\d+)"/)[1])>150);
});
