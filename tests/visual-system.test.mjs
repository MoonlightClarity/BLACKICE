import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {iconSymbols, renderIcon} from '../public/icon-symbols.mjs';

const get = relative => readFile(new URL('../' + relative, import.meta.url), 'utf8');

// Scan values outside comments and balanced functions/strings; a semicolon in
// a URL must not turn a later declaration into an unchecked surface.
function backgrounds(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const matches = [], expression = /(?<![\w-])background(?:-color)?\s*:\s*/g;
  let match;
  while ((match = expression.exec(css))) {
    const start = expression.lastIndex;
    let end = start, depth = 0, quote = '';
    for (; end < css.length; end++) {
      const char = css[end];
      if (quote) { if (char === '\\') end++; else if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (depth === 0 && (char === ';' || char === '}')) break;
    }
    matches.push(css.slice(start, end).replace(/\s*!important\s*$/, '').trim());
    expression.lastIndex = end + 1;
  }
  return matches;
}

test('application surfaces keep gradients and editable artwork while native dropdowns use a readable opaque palette', async () => {
  const html = await get('public/index.html');
  const files = [...new Set([...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(match => match[1]).concat('/browser-tree.css'))];
  assert.ok(files.length > 0);
  for (const filename of files) {
    const css = await get('public' + filename);
    // Platform-rendered select popups need real background colors; gradient
    // images do not paint their native option surface. Keep that exception
    // confined to the named select layer and its two checked palette colors.
    const native = css.match(/@layer blackice-native-selects\s*\{([\s\S]*)\}\s*$/);
    if (native) {
      assert.equal(filename, '/conversation-layout.css');
      const rules = [...native[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      assert.ok(rules.length >= 4);
      for (const rule of rules) {
        const selectors = rule[1].split(',').map(value => value.trim());
        assert.ok(selectors.every(selector => selector === 'html[data-blackice-ui]' || /^html\[data-blackice-ui\] body\b/.test(selector) && /\bselect\b/.test(selector)), 'Only native dropdowns may use the opaque palette');
        for (const value of backgrounds(rule[2])) assert.ok(['#11212b', '#14212a'].includes(value), 'Keep the native dropdown palette explicit');
      }
      assert.match(native[1], /select option/); assert.match(native[1], /select optgroup/); assert.match(native[1], /option:disabled/);
    }
    for (const value of backgrounds(native ? css.slice(0, native.index) : css)) {
      assert.ok(/^(?:none|transparent|inherit|unset|initial|revert)$/.test(value) || /(?:gradient|url)\(/.test(value), `${filename} has an authored flat surface: ${value}`);
      assert.doesNotMatch(value, /url\([^)]*(?:\.png|\.jpe?g|\.webp|data:)/i, `${filename} must use editable geometry for artwork`);
    }
    assert.doesNotMatch(css, /\[role=(?:"button"|button)\](?!:where\(:not\(svg,svg \*\)\))/, `${filename} must not apply HTML control transforms to SVG map nodes`);
  }
});

test('the wordmark and native mark are editable geometry with one shared icon source', async () => {
  const [wordmark, mark, native, app] = await Promise.all(['public/assets/blackice-wordmark.svg','public/assets/relay-mark.svg','desktop/icon.svg','public/app.js'].map(get));
  assert.equal(mark, native, 'the native and workspace mark come from the same vector source');
  for (const svg of [wordmark, mark]) {
    assert.match(svg, /<svg\b/); assert.match(svg, /<path\b/); assert.match(svg, /<title\b[^>]*>BLACKICE/);
    assert.doesNotMatch(svg, /<image\b|<script\b|<foreignObject\b|<text\b|\bhref\s*=|data:|@import/i);
    const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    for (const reference of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.has(reference[1]), `missing SVG reference ${reference[1]}`);
  }
  assert.match(app, /import\('\/icon-symbols\.mjs'\)/);
  assert.match(app, /workspace-wordmark-label">BLACKICE<\/span>/);
});

test('icons preserve meaningful geometry, decorative semantics and bounded sizes', () => {
  for (const name of ['agent','mail','plan','workflow','clock','folder','eye','settings','plus','close','play','stop']) {
    assert.ok(Object.hasOwn(iconSymbols, name), `${name} is a first-class icon`);
    const svg = renderIcon(name, 18);
    assert.match(svg, /width="18" height="18"/);
    assert.match(svg, /aria-hidden="true" focusable="false"/);
    assert.match(svg, /(?:<path\b|<rect\b|<circle\b)/);
    assert.doesNotMatch(svg, /<image\b|<script\b|on\w+\s*=/i);
  }
  assert.equal(renderIcon('unknown'), renderIcon('agent'));
  assert.equal(renderIcon('constructor'), renderIcon('agent'));
  assert.equal(renderIcon('plan', Infinity), renderIcon('plan', 16));
  assert.equal(renderIcon('plan', '"><script>'), renderIcon('plan', 16));
});
