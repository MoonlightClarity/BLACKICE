import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSvgPreview, SVG_PREVIEW_LIMIT } from '../public/svg-preview.mjs';

const svg = content => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">${content}</svg>`;

test('complete static SVG becomes only an encoded image URL with its exact source preserved', () => {
  const source = svg('<defs><linearGradient id="glow"><stop stop-color="#fff"/></linearGradient></defs><rect width="80" height="80" fill="url(#glow)"/><text style="font-size:12px;fill:#fff">A &amp; B</text>');
  const url = safeSvgPreview(source);
  assert.match(url, /^data:image\/svg\+xml;charset=utf-8,/); assert.equal(decodeURIComponent(url.split(',').slice(1).join(',')), source);
  assert.doesNotMatch(url, /[<>"\n]/);
  assert.ok(safeSvgPreview(`<?xml version="1.0" encoding="UTF-8"?>\n${svg('<!-- an ordinary source comment --><circle r="12"/>')}`));
  assert.ok(safeSvgPreview(svg('<defs><path id="shape" d="M0 0L10 10"/></defs><use href="#shape"/>')));
});

test('scripts, events, navigation, external resources and XML indirection never receive a preview', () => {
  const rejected = [
    svg('<script>alert(1)</script>'), svg('<foreignObject><div>HTML</div></foreignObject>'), svg('<rect onload="alert(1)"/>'),
    svg('<image href="https://example.test/tracker"/>'), svg('<use href="https://example.test/shape.svg#x"/>'), svg('<use href="&#104;ttps://example.test/x"/>'),
    svg('<use href="//example.test/x"/>'), svg('<use href="data:image/svg+xml,anything"/>'), svg('<a href="#x"><text>Link</text></a>'),
    svg('<rect fill="url(https://example.test/x)"/>'), svg('<rect style="fill:url(https://example.test/x)"/>'),
    svg('<rect style="fill:u\\72l(https://example.test/x)"/>'), svg('<rect style="background-image:image-set(\'https://example.test/x\' 1x)"/>'),
    svg('<style>@import "https://example.test/x";</style>'), svg('<style>@font-face{src:url(https://example.test/x)}</style>'),
    svg('<animate attributeName="href" to="https://example.test/x"/>'), svg('<set attributeName="href" to="https://example.test/x"/>'),
    svg('<g xml:base="https://example.test/"><use href="#shape"/></g>'), svg('<g xmlns="http://www.w3.org/1999/xhtml"/>'),
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///private">]>' + svg('<text>&xxe;</text>'),
    '<?xml-stylesheet href="https://example.test/x"?>' + svg('<rect/>'), svg('<text>&unknown;</text>'),
    svg('<rect title="bad & broken"/>'),
  ];
  for (const source of rejected) assert.equal(safeSvgPreview(source), null, source);
});

test('incomplete or malformed SVG falls back to source and UTF-8 byte size is bounded', () => {
  for (const source of ['', '<svg>', svg('<g>'), svg('<path></rect>'), svg('<rect width=12/>'), svg('<rect width="1" width="2"/>'), svg('') + svg(''), '<svg><rect/></svg>', svg('<rect title="unfinished/>')]) assert.equal(safeSvgPreview(source), null, source);
  const valid = svg('<rect width="1"/>'), exact = valid + ' '.repeat(SVG_PREVIEW_LIMIT - Buffer.byteLength(valid));
  assert.ok(safeSvgPreview(exact)); assert.equal(safeSvgPreview(exact + ' '), null);
  const utf8 = svg(`<text>${'界'.repeat(12000)}</text>`); assert.ok(utf8.length < SVG_PREVIEW_LIMIT); assert.equal(safeSvgPreview(utf8), null);
  assert.equal(safeSvgPreview(svg('<g>'.repeat(65) + '</g>'.repeat(65))), null);
});
