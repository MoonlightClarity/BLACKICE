import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = relative => readFile(new URL('../' + relative, import.meta.url), 'utf8');
const [planning, brand, controls, index] = await Promise.all([
  read('public/next/planning-browser.css'),
  read('public/next/brand.css'),
  read('public/next/controls.css'),
  read('public/next/index.html'),
]);

// These are source-contract checks. Rendered cascade, contrast, and system-color
// behavior are covered by planning-activity-headless.mjs with the shipped shell.
const withoutComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
function selectors(value) {
  const result = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if ('(['.includes(value[i])) depth++;
    if (')]'.includes(value[i])) depth--;
    if (value[i] === ',' && depth === 0) {
      result.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...result, value.slice(start).trim()];
}
function rule(css, selector) {
  for (const match of withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors(match[1].trim()).includes(selector)) continue;
    return Object.fromEntries(match[2].split(';').filter(value => value.includes(':')).map(value => {
      const colon = value.indexOf(':');
      return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
    }));
  }
  assert.fail('Missing stylesheet rule: ' + selector);
}
function media(css, feature) {
  const clean = withoutComments(css);
  const pattern = /@media\s*([^{}]+)\{/g;
  let match;
  while ((match = pattern.exec(clean))) {
    if (!match[1].replace(/\s/g, '').includes(feature)) continue;
    let depth = 1, end = pattern.lastIndex;
    for (; end < clean.length && depth; end++) {
      if (clean[end] === '{') depth++;
      if (clean[end] === '}') depth--;
    }
    assert.equal(depth, 0, 'Closed media block: ' + feature);
    return clean.slice(pattern.lastIndex, end - 1);
  }
  assert.fail('Missing accessibility media rule: ' + feature);
}
const roots = rule(brand, ':root');
const resolve = value => {
  assert.ok(value, 'Expected a color declaration.');
  for (let i = 0; i < 10 && value.includes('var('); i++) {
    value = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, token, fallback) => {
      assert.ok(roots[token] || fallback, 'Shared brand token exists: ' + token);
      return roots[token] || fallback;
    });
  }
  return value.replace(/\s+/g, '').toLowerCase();
};

test('Planning neutral surfaces use shared brand tokens instead of a private navy palette', () => {
  const neutralSurfaces = [
    '.planning-browser', '.pb-header', '.pb-rail', '.pb-tabs-row',
    '.pb-overview-status', '.pb-overview-finding', '.pb-canvas', '.pb-inspector',
    '.pb-more-menu', '.pb-stage-brief', '.pb-note', '.pb-create', '.pb-worker',
    '.pb-intent-panel', '.planning-browser .pb-progress-step',
  ];
  for (const selector of neutralSurfaces) {
    const declarations = rule(planning, selector);
    assert.match(declarations.background || declarations['background-color'] || '', /var\(--/,
      selector + ' uses a shared surface token.');
    for (const property of ['background', 'background-color', 'color', 'border', 'border-color']) {
      const value = declarations[property];
      if (!value) continue;
      assert.doesNotMatch(value, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i,
        selector + ' ' + property + ' does not hardcode its palette.');
      for (const token of value.matchAll(/var\((--[\w-]+)/g)) {
        assert.ok(roots[token[1]], selector + ' references a brand-owned token: ' + token[1]);
      }
    }
  }
  assert.match(rule(planning, '.planning-browser').color, /var\(--(?:text|text-primary)\)/);
  for (const color of ['#121820', '#151d27', '#243140', '#304258', '#bad8eb', '#d5eafa',
    '#25384a', '#182330', '#283e52', '#32485f']) {
    assert.ok(!planning.toLowerCase().includes(color), 'Removed Planning-only color: ' + color);
  }
});

test('Planning buttons share the existing BLACKICE graphite and silver material', () => {
  for (const [shared, local] of [
    ['button', '.planning-browser button'],
    ['button:hover:not(:disabled)', '.planning-browser button:hover:not(:disabled)'],
    ['.next-primary', '.planning-browser .pb-primary'],
    ['.next-primary:hover:not(:disabled)', '.planning-browser .pb-primary:hover:not(:disabled)'],
  ]) {
    const expected = rule(brand, shared), actual = rule(planning, local);
    assert.match(actual.background, /var\(--/, local + ' uses a shared background token.');
    assert.equal(resolve(actual.background), resolve(expected.background), local + ' matches shared material.');
  }
  assert.equal(resolve(rule(planning, '.planning-browser .pb-primary').color),
    resolve(rule(brand, '.next-primary').color), 'Silver buttons retain dark readable text.');
  // Extracting shared tokens must not recolor existing workspaces.
  assert.equal(resolve(rule(brand, 'button').background), 'linear-gradient(145deg,#2c333c,#1b2027)');
  assert.equal(resolve(rule(brand, '.next-primary').background), 'linear-gradient(135deg,#d2d7dd,#aeb8c3)');
  assert.equal(resolve(rule(brand, '.next-primary').color), '#151a21');
  assert.equal(resolve(rule(brand, '.next-chat-sidebar').background), 'linear-gradient(110deg,#09090aef,#141517e6)');
  assert.equal(resolve(rule(brand, '.next-chat-head').background), 'linear-gradient(100deg,#131415e8,#161719bd)');
  assert.equal(resolve(rule(brand, '.next-conversation[aria-current=true]').background),
    'linear-gradient(100deg,#4d505575,#27292c60)');
});

test('Planning fields and focus remain connected to the shared control palette', () => {
  const input = rule(planning, '.planning-browser .pb-input');
  assert.equal(input.background || input['background-color'], 'var(--next-control-background)');
  assert.equal(input.color, 'var(--next-control-foreground)');
  assert.match(planning, /:focus-visible\s*\{[^{}]*outline:\s*2px solid var\(--accent\)/);
  assert.equal(roots['--next-control-background'], '#0e1217');
  assert.equal(roots['--next-control-foreground'], '#e7ebef');
  assert.equal(roots['--next-control-selection-background'], '#424d5b');
  assert.equal(roots['--next-control-selection-foreground'], '#fafbfc');
  assert.match(rule(controls, 'select option').background || rule(controls, 'select option')['background-color'],
    /var\(--next-control-menu-background/);
});

test('Planning has explicit system-color states instead of depending on removed gradients and shadows', () => {
  const forced = media(planning, '(forced-colors:active)');
  assert.match(forced, /\bCanvas\b/);
  assert.match(forced, /\bCanvasText\b/);
  assert.match(forced, /\bButtonFace\b/);
  assert.match(forced, /\bButtonText\b/);
  assert.match(forced, /\bHighlight\b/);
  assert.match(forced, /\bHighlightText\b/);
  assert.match(forced, /\bGrayText\b/);
  assert.match(forced, /:focus-visible/);
  assert.match(forced, /aria-current/);
  assert.match(forced, /aria-selected/);
  assert.match(forced, /aria-pressed/);
  assert.match(forced, /(?:box-shadow|background-image):\s*none/);
  assert.equal(rule(forced, '.planning-browser')['forced-color-adjust'], 'auto',
    'System colors remain automatic across the workspace.');
  assert.doesNotMatch(planning.replace(forced, ''), /forced-color-adjust:\s*none/,
    'Opting out is confined to the forced-colors media query.');
  for (const match of forced.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/forced-color-adjust:\s*none/.test(match[2])) continue;
    for (const selector of selectors(match[1].trim())) {
      assert.match(selector, /\[aria-(?:current|selected|pressed)=(?:true|step|page)\]/,
        'Only a selected control opts out of automatic backplates.');
    }
    assert.match(match[2], /(?:^|;)\s*background:\s*Highlight\s*(?:;|$)/);
    assert.match(match[2], /(?:^|;)\s*color:\s*HighlightText\s*(?:;|$)/);
  }
  assert.match(forced, /:is\(strong,small,span\):not\(\.pb-pill\)\{color:HighlightText\}/,
    'Selected metadata has explicit system text while pills keep their own matched pair.');
  assert.doesNotMatch(forced, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.equal(rule(media(brand, '(forced-colors:active)'),
    '.next-conversation[aria-current=true] :is(span,small,strong)').color, 'HighlightText',
    'Shared selected Chat descendants remain readable when inheriting the targeted backplate opt-out.');
});

test('Planning preserves contrast, reduced-transparency and reduced-motion accommodations', () => {
  const contrast = media(planning, '(prefers-contrast:more)');
  const opaque = media(brand, '(prefers-reduced-transparency:reduce)');
  assert.match(contrast, /border-color:\s*var\(--accent\)/);
  assert.match(brand, /--next-sidebar-background:#141618;--next-header-background:#141618;--next-card-background:#141618/);
  assert.match(opaque, /background/);
  assert.doesNotMatch(opaque, /rgba?\(|#[\da-f]{8}\b|#[\da-f]{4}\b/i);
  assert.match(media(planning, '(prefers-reduced-motion:reduce)'), /transition:\s*none!important/);
});

test('The palette correction preserves the read-first Planning geometry and compact shell', () => {
  for (const [selector, properties] of [
    ['.planning-browser', { '--planning-navigation-version': '3', height: '100%', display: 'flex', 'flex-direction': 'column', overflow: 'hidden' }],
    ['.pb-layout', { display: 'grid', 'grid-template-columns': '250px minmax(0,1fr)', flex: '1' }],
    ['.pb-header', { padding: '12px 20px', display: 'flex' }],
    ['.pb-overview', { overflow: 'auto', padding: '24px 28px 36px' }],
    ['.pb-overview-columns', { 'grid-template-columns': 'minmax(320px,1.2fr) minmax(240px,1fr)', gap: '28px' }],
    ['.pb-content', { 'grid-template-columns': '260px minmax(0,1fr)', overflow: 'hidden' }],
    ['.pb-inspector', { padding: '26px 32px 50px', overflow: 'auto' }],
    ['.next-shell:has(.next-space:not([hidden]) .planning-browser)', { 'grid-template-rows': '64px minmax(0,1fr)' }],
    ['.next-shell:has(.next-space:not([hidden]) .planning-browser)>.next-topbar::after', { display: 'none' }],
  ]) {
    const actual = rule(planning, selector);
    for (const [property, value] of Object.entries(properties)) {
      assert.equal(actual[property], value, selector + ' preserves ' + property);
    }
  }
  for (const breakpoint of ['(min-width:1200px)', '(max-width:1100px)', '(max-width:800px)', '(max-width:600px)']) {
    media(planning, breakpoint);
  }
  assert.equal(rule(media(planning, '(max-width:800px)'), '.pb-rail').display, 'none');
  assert.equal(rule(media(planning, '(max-width:600px)'), '.pb-content')['flex-direction'], 'column');
});

test('The shipped cascade still loads Planning after shared brand and native controls', () => {
  const brandPosition = index.indexOf('href="/next/brand.css');
  const controlsPosition = index.indexOf('href="/next/controls.css');
  const planningPosition = index.indexOf('href="/next/planning-browser.css');
  assert.ok(brandPosition >= 0 && controlsPosition > brandPosition && planningPosition > controlsPosition);
});
