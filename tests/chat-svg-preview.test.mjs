import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/editor-model.mjs';
import { safeSvgPreview, SVG_PREVIEW_LIMIT } from '../public/svg-preview.mjs';
import { bindChatSvgPreviews } from '../public/next/chat/svg-previews.mjs';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><text x="2" y="20">Hello &amp; goodbye</text></svg>';
const ticks=String.fromCharCode(96).repeat(3);
const fence = (source, lang='svg', close=true) => ticks+lang+'\n'+source+(close?'\n'+ticks:'');
const preview = source => renderMarkdown(source,{svgPreviews:true});
const escape = s => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('Chat SVG opt-in is isolated; valid closed SVG/XML/plain fences retain their extracted source',()=>{
 for(const lang of ['svg','SVG','xml','']) {
  const input=fence(svg,lang), output=preview(input);
  assert.ok(!renderMarkdown(input).includes('<img'));
  assert.ok(output.includes('src="'+escape(safeSvgPreview(svg))+'"'));
  assert.ok(output.includes('>'+escape(svg)+'</code>'));
  assert.match(output, /<details class="chat-svg-source"><summary>SVG source<\/summary>/);
  assert.match(output,/data-copy-svg/); assert.ok(!output.includes('<svg'));
 }
});
test('standalone raw SVG and XML declaration blocks preview without swallowing prose',()=>{
 const raw='<?xml version="1.0"?>\n'+svg;
 const out=preview('Before\n\n'+raw+'\n\nAfter');
 assert.match(out,/<p>Before<\/p><figure/);assert.match(out,/<\/figure><p>After<\/p>/);
 assert.ok(out.includes(escape(safeSvgPreview(raw))));
 const inline='An example '+svg+' after';assert.equal(preview(inline),renderMarkdown(inline));
 assert.match(preview('<svg xmlns="http://www.w3.org/2000/svg"/>'),/<img/);
});
test('unsafe, incomplete, unsupported, oversized or mislabelled SVG stays original escaped Markdown',()=>{
 const bad=['<svg>',svg.replace('</svg>',''),svg.replace('xmlns="http://www.w3.org/2000/svg"',''),svg.replace('</svg>','<script>alert(1)</script></svg>'),svg.replace('</svg>','<image href="https://example.invalid/a"/></svg>'),svg.replace('</svg>','<foreignObject><div>x</div></foreignObject></svg>'),svg.replace('</svg>','<animate attributeName="x"/></svg>'),svg.replace('<text ','<text onclick="bad()" '),svg.replace('</svg>','<rect fill="url(https://example.invalid/a)"/></svg>'),svg.replace('</svg>','<text>'+ 'x'.repeat(SVG_PREVIEW_LIMIT)+'</text></svg>')];
 for(const raw of bad)for(const input of [raw,fence(raw)])assert.equal(preview(input),renderMarkdown(input));
 for(const input of [fence(svg,'svg',false),fence(svg,'svg-extra'),fence(svg,'html'),fence(svg,'javascript'),ticks+'svg extra\n'+svg+'\n'+ticks])assert.equal(preview(input),renderMarkdown(input));
});
test('ordinary Markdown, artifacts, nested lists and streaming prefixes remain inert or unchanged',()=>{
 const options={resolveArtifact:()=>({taskId:'task',artifactId:'file'})};
 for(const input of ['# Header\n\n- **Bold**\n  - nested\n\n[web](https://example.com)',fence('console.log(1)','js'),'<script>bad()</script>','[local](./file.svg)',ticks[0]+svg+ticks[0]])assert.equal(renderMarkdown(input,{...options,svgPreviews:true}),renderMarkdown(input,options));
 for(let i=0;i<svg.length;i++)assert.ok(!preview(svg.slice(0,i)).includes('<img'));
 assert.equal((preview(fence(svg)+'\n\n'+fence(svg)).match(/<img /g)||[]).length,2);
 const crlf=fence(svg).replaceAll('\n','\r\n'); assert.equal(preview(crlf),preview(fence(svg)));
});
test('large raw diagrams are bounded and rendered once without broadening the validator',()=>{
 const source='<svg xmlns="http://www.w3.org/2000/svg">\n'+Array(1000).fill('<rect width="1"/>').join('\n')+'\n</svg>';
 const started=performance.now();assert.match(preview(source),/<img /);assert.ok(performance.now()-started<1500);
});
function bindingFixture(copy) {
 const events={}, status={setAttribute(){},textContent:''}, source={textContent:svg}, button={disabled:false,after(){},addEventListener:(type,fn)=>events.click=fn};
 const details={open:false,querySelector:selector=>selector==='[data-copy-svg]'?button:source};
 const image={complete:false,naturalWidth:0,hidden:false,addEventListener:(type,fn)=>events.error=fn};
 const figure={querySelector:selector=>selector==='img'?image:details};
 bindChatSvgPreviews({querySelectorAll:()=>[figure],ownerDocument:{createElement:()=>status}},{copy});return {events,status,source,button,details,image};
}
test('source Copy is exact, repeatable and only confirms successful writes',async()=>{
 const copied=[],f=bindingFixture(async value=>copied.push(value));await f.events.click();await f.events.click();
 assert.deepEqual(copied,[svg,svg]);assert.equal(f.status.textContent,'Copied SVG source.');assert.equal(f.button.disabled,false);
 const bad=bindingFixture(async()=>{throw Error('private exception');});await bad.events.click();assert.match(bad.status.textContent,/Copy is unavailable/);assert.ok(!bad.status.textContent.includes('private'));assert.equal(bad.button.disabled,false);
});
test('failed image decoding reveals source without losing copy controls',()=>{
 const f=bindingFixture(async()=>{});f.events.error();assert.equal(f.image.hidden,true);assert.equal(f.details.open,true);assert.match(f.status.textContent,/Preview unavailable/);assert.equal(f.source.textContent,svg);
});

test('repeated malformed raw roots cannot restart unbounded scans',()=>{
 const source=Array(5000).fill('<svg>').join('\n'), started=performance.now();
 assert.equal(preview(source),renderMarkdown(source)); assert.ok(performance.now()-started<300);
});
