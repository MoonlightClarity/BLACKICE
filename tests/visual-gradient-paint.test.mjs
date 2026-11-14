import test from 'node:test';import assert from 'node:assert/strict';
import {visualSvgUrl,compileVisual} from '../public/visual-document.mjs';
const wrap=body=>`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150">${body}</svg>`;
const gradient='<defs><linearGradient id="metal" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0" stop-color="#dde2df"/><stop offset="1" stop-color="#65777c"/></linearGradient></defs>';
test('bounded local paint preserves exact custom SVG and supports radial transparency',()=>{
 for(const svg of [wrap(gradient+'<rect width="200" height="150" fill="url(#metal)"/>'),wrap('<defs><radialGradient id="light"><stop offset="0" stop-color="#fff" stop-opacity="0.4"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><circle cx="80" cy="70" r="50" fill="url(#light)"/>')]){
  assert.ok(visualSvgUrl(svg));assert.equal(compileVisual({version:2,kind:'custom',title:'Material',summary:'Local gradient study',svg}).svg,svg);
 }
});
test('gradient profile rejects external, inherited, unresolved, ambiguous and recursive paint',()=>{
 const bodies=[
  gradient+'<rect fill="url(https://example.com/a)"/>',gradient+'<rect fill="url(#missing)"/>',
  gradient+'<rect id="metal" fill="url(#metal)"/>',gradient+gradient,
  gradient.replace('id="metal"','id="metal" href="#other"'),
  gradient.replace('id="metal"','id="metal" gradientTransform="scale(100000000)"'),
  '<defs><linearGradient id="metal"><stop offset="0" stop-color="url(#metal)"/><stop offset="1"/></linearGradient></defs>',
  gradient+'<rect filter="url(#metal)"/>',gradient+'<rect fill="u&#114;l(#missing)"/>',
  gradient.replace('x1="0%"','x1="1e100"'),gradient.replace('offset="1"','offset="2"'),
  gradient.replace('offset="0"','offset="0.9"').replace('offset="1"','offset="0.2"'),
  '<linearGradient id="metal"><stop offset="0"/><stop offset="1"/></linearGradient>',
  '<defs><linearGradient id="metal">'+Array.from({length:17},(_,i)=>`<stop offset="${i/16}"/>`).join('')+'</linearGradient></defs>'
 ];
 for(const body of bodies)assert.equal(visualSvgUrl(wrap(body)),null,body);
});
test('legacy flat SVGs and text entities still render without paint definitions',()=>{
 assert.ok(visualSvgUrl(wrap('<rect fill="#abc" width="30" height="20"/><text x="10" y="40">A &amp; B</text>')));
 assert.equal(visualSvgUrl(wrap('<use href="#x"/>')),null);
 assert.equal(visualSvgUrl(wrap('<filter id="x"/>')),null);
});
