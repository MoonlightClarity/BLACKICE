import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutRelationshipLabels,boxesOverlap,relationshipTextBox} from '../public/visual-label-layout.mjs';
import {compileVisual} from '../public/visual-document.mjs';
const label=(text='Relation')=>({id:0,text,legend:'a -> b: '+text,x:40,y:75});
test('tiny canvas chooses an unobstructed full box or expands a complete legend',()=>{
 const obstacles=[{x:0,y:0,width:80,height:50},{x:0,y:100,width:80,height:50}];
 const result=layoutRelationshipLabels({width:200,height:150,labels:[label()],obstacles});
 assert.equal(result.placements.length,1);
 for(const p of result.placements){assert.ok(p.x>=0&&p.x+p.width<=200&&p.y+p.height<=result.height);assert.ok(!obstacles.some(o=>boxesOverlap(p,o)));}
});
test('obstacles, other labels and opaque custom regions are never covered',()=>{
 const obstacles=[{x:0,y:0,width:200,height:150}];
 const labels=[label('First'),{...label('Second'),id:1}];
 const r=layoutRelationshipLabels({width:200,height:150,labels,obstacles});
 assert.ok(r.legend&&r.height>150);
 assert.equal(r.placements.length,2);
 assert.ok(!boxesOverlap(...r.placements));
 assert.equal(r.placements[0].rows.map(r=>r.text).join(''),'a -> b: First');
});
test('full Unicode, uncertainty, newlines and long text survive bounded wrapping',()=>{
 const text='Wide WWW \u4e2d\u6587 \ud83e\uddea e\u0301 (uncertain)\n'+'x'.repeat(100);
 const box=relationshipTextBox(text,184);
 assert.equal(box.rows.map(r=>r.text).join(''),text.replaceAll('\n',''));
 for(const r of box.rows)assert.ok(r.width<=168);
 assert.deepEqual(box,relationshipTextBox(text,184));
});
test('no-space result is explicit rather than silently clipping or dropping text',()=>{
 assert.throws(()=>layoutRelationshipLabels({width:200,height:1990,labels:[label()],obstacles:[{x:0,y:0,width:200,height:1990}]}),/Split the visual; no text was omitted/);
});
test('pinned overlapping items remain unchanged and custom SVG stays opaque',()=>{
 const input={version:2,kind:'composed',title:'Pinned',summary:'Opaque',width:400,height:200,items:[{id:'a',label:'A',x:0,y:0,width:80,height:50},{id:'b',label:'B',x:20,y:20,width:80,height:50}],links:[{from:'a',to:'b',label:'Relation'}],regions:[{id:'r',label:'Opaque',summary:'Opaque',x:200,y:0,width:100,height:100,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="0" y="50">opaque original</text></svg>'}]};
 const saved=structuredClone(input),r=compileVisual(input);assert.deepEqual(input,saved);assert.deepEqual(r.document.items,saved.items);assert.equal(r.document.regions[0].svg,saved.regions[0].svg);assert.match(r.svg,/>opaque original</);
 const custom={version:2,kind:'custom',title:'Custom',summary:'Original',svg:saved.regions[0].svg};assert.equal(compileVisual(custom).svg,custom.svg);
});

test('fallback legends disambiguate duplicate names and expose edge keys',()=>{
 const doc={version:2,kind:'composed',title:'Same names',summary:'Distinct identities',width:200,height:150,items:[{id:'left',label:'Same',x:0,y:0,width:80,height:50},{id:'right',label:'Same',x:120,y:100,width:80,height:50}],links:[{from:'left',to:'right',label:'Long relationship that cannot fit inline',uncertain:true}]};
 const r=compileVisual(doc),visible=[...r.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m=>m[1]).join('');
 assert.match(visible,/R1:/);assert.match(visible,/\[left(?:\]| @)/);assert.match(visible,/\[right(?:\]| @)/);
});
test('a short visible edge key is tried before an honest no-marker fallback',()=>{
 const full={...label('Very long text '.repeat(5)),key:'R1',legend:'R1: full text',fallbackLegend:'R1: endpoints at positions; no inline marker fits'};
 const r=layoutRelationshipLabels({width:200,height:150,labels:[full],obstacles:[{x:0,y:0,width:80,height:50},{x:0,y:100,width:80,height:50}]});
 assert.ok(r.placements.some(p=>p.kind==='marker'&&p.rows[0].text==='R1'));
 const blocked=layoutRelationshipLabels({width:200,height:150,labels:[full],obstacles:[{x:0,y:0,width:200,height:150}]});
 assert.equal(blocked.placements[0].rows.map(r=>r.text).join(''),full.fallbackLegend);
});

test('word wrapping preserves spaces and keeps fitting words together',()=>{
 const text='Small words should stay whole.';
 const box=relationshipTextBox(text,100);
 assert.equal(box.rows.map(r=>r.text).join(''),text);
 for(const word of text.split(' '))assert.ok(box.rows.some(r=>r.text.includes(word)),word);
});

test('a whitespace break rechecks the remaining long Unicode word before appending',()=>{
 const text=' WW'+'中'.repeat(11),box=relationshipTextBox(text,184);
 assert.equal(box.rows.map(row=>row.text).join(''),text);
 assert.ok(box.rows.every(row=>row.width<=168));
 assert.ok(box.width<=184);
});
