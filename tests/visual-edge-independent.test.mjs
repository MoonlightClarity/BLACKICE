import test from 'node:test';
import assert from 'node:assert/strict';
import {compileVisual} from '../public/visual-document.mjs';
const base={kind:'composed',title:'Boundary',summary:'Boundary check',width:200,height:150};

for(const version of [1,2]){
 test('v'+version+' accepts content that fits a small canvas and rejects out-of-bounds items',()=>{
  const item={id:'a',label:'Fits',x:10,y:20,width:80,height:50};
  assert.match(compileVisual({...base,version,items:[item],notes:[{text:'OK',x:100,y:100}]}).svg,/Fits/);
  assert.throws(()=>compileVisual({...base,version,items:[{...item,x:150}]}),{code:'VISUAL_INVALID'});
  assert.throws(()=>compileVisual({...base,version,items:[{...item,width:220}]}),{code:'VISUAL_INVALID'});
 });
 test('v'+version+' keeps relationship label coordinates on canvas',()=>{
  const input={...base,version,items:[{id:'a',label:'A',x:0,y:0,width:80,height:50},{id:'b',label:'B',x:0,y:100,width:80,height:50}],links:[{from:'a',to:'b',label:'Relation'}]};
  const svg=compileVisual(input).svg;
  const x=Number(svg.match(/<text x="([^"]+)"[^>]*>Relation<\/text>/)[1]);
  assert.ok(x>=0,`label starts outside canvas at x=${x}`);
 });
}
test('custom SVG remains available, and custom regions enforce their outer canvas bounds',()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="20"/></svg>';
 assert.equal(compileVisual({version:1,kind:'custom',title:'Custom',summary:'Circle',svg}).svg,svg);
 const region={id:'r',label:'Circle',summary:'Circle',svg,x:10,y:10,width:80,height:50};
 assert.match(compileVisual({...base,version:2,regions:[region]}).svg,/<circle/);
 assert.throws(()=>compileVisual({...base,version:2,regions:[{...region,x:150}]}),{code:'VISUAL_INVALID'});
 assert.throws(()=>compileVisual({...base,version:2,regions:[{...region,y:110}]}),{code:'VISUAL_INVALID'});
});

for(const version of [1,2])test('v'+version+' bounds full wrapped relationship labels at all canvas edges',()=>{
 for(const [x,y,horizontal] of [[0,0,false],[120,0,false],[0,0,true],[0,100,true]]){
  const input={...base,version,items:[{id:'a',label:'A',x,y,width:80,height:50},{id:'b',label:'B',x:horizontal?120:x,y:horizontal?y:100,width:80,height:50}],links:[{from:'a',to:'b',label:'Wide relationship '.repeat(5).trim(),uncertain:true}]};
  const svg=compileVisual(input).svg;
  const texts=[...svg.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*textLength="([^"]+)"[^>]*>([^<]*)<\/text>/g)];
  assert.ok(texts.length>1);
  const height=Number(svg.match(/<svg[^>]*height="([^"]+)"/)[1]);for(const [,px,py,length] of texts){assert.ok(+px>=0);assert.ok(+px+(+length)<=200);assert.ok(+py>=14);assert.ok(+py+4<=height);}
 }
});
