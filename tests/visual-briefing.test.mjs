import test from 'node:test';
import assert from 'node:assert/strict';
import {compileVisual,VISUAL_COMPOSITION_EXAMPLE} from '../public/visual-document.mjs';
import {compileVisual as previous} from '../public/visual-document-renderer-labels-3.mjs';
import {VISUAL_DESIGN_GUIDE} from '../lib/visual-design-guide.mjs';

test('briefing presentation adds a visible heading without moving analytical geometry',()=>{
 const old=previous(VISUAL_COMPOSITION_EXAMPLE),current=compileVisual(VISUAL_COMPOSITION_EXAMPLE);
 assert.deepEqual(current.document,old.document);assert.equal(current.text,old.text);
 assert.match(current.svg,/viewBox="0 -\d+ /);assert.match(current.svg,/font-weight="bold"/);assert.match(current.svg,/font-family="Arial, sans-serif"/);
 assert.deepEqual([...current.svg.matchAll(/<line[^>]*x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)].map(m=>m.slice(1)),[...old.svg.matchAll(/<line[^>]*x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)].map(m=>m.slice(1)));
});
test('custom graphics keep their exact styling and mixed regions retain author content',()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="10" y="30" fill="#53627a">Custom</text></svg>';
 assert.equal(compileVisual({version:2,kind:'custom',title:'Custom',summary:'A custom graphic',svg}).svg,svg);
 const mixed=compileVisual({...VISUAL_COMPOSITION_EXAMPLE,regions:[{label:'Custom',summary:'A custom inset',svg}]});assert.match(mixed.svg,/<text x="10" y="30" fill="#53627a">Custom<\/text>/);
});
test('design guidance supports problem-specific composition and custom SVG instead of a template requirement',()=>{
 assert.match(VISUAL_DESIGN_GUIDE.intent,/Make the visual the user requested/);
 assert.match(VISUAL_DESIGN_GUIDE.composition.join('\n'),/does not require BLACKICE colors, a particular illustration style or a fixed layout/);
 assert.match(VISUAL_DESIGN_GUIDE.custom,/Author a complete static SVG with explicit dimensions and viewBox/);
 assert.match(VISUAL_DESIGN_GUIDE.intent,/Use an optional visual when its spatial form helps the reader understand the answer/);
 assert.match(VISUAL_DESIGN_GUIDE.review,/Use preview to inspect the rendered result/);
});
