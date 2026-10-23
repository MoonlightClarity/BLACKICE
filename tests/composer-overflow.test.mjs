import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = file => readFile(new URL('../public/' + file, import.meta.url), 'utf8');

test('composer secondary actions stay compact without wrapping their labels beneath the toolbar', async () => {
  const [css, ui] = await Promise.all([read('blackice-experience.css'), read('mission-ui.mjs')]);
  const layout = css.slice(css.lastIndexOf('/* Keep actual composer actions in one row.'));
  assert.match(layout, /\.conversation-compose-bar\s*\{\s*display:flex !important;\s*flex-wrap:nowrap !important;/);
  assert.match(layout, /#mission-capture-button,#mission-outline,#conversation-attach/);
  assert.match(layout, /white-space:nowrap/);
  assert.match(layout, /\.conversation-compose-bar > :is\(#mission-capture-button,#mission-outline,#conversation-attach\) > span\s*\{\s*display:none !important/);
  for (const label of ['Save message for later', 'Prompt templates', 'Attach files']) assert.ok(ui.includes('aria-label="' + label + '"'), label + ' remains accessible when visual text is hidden');
});

test('small windows fit Stop and Send beside the three icon-only actions', async () => {
  const css = await read('blackice-experience.css');
  const small = css.slice(css.lastIndexOf('@media (max-width:480px)'));
  assert.ok(small.startsWith('@media (max-width:480px)'));
  assert.match(small, /#conversation-stop[\s\S]*?min-width:34px !important/);
  assert.match(small, /#conversation-stop > span\s*\{\s*display:none !important/);
  assert.match(small, /#mission-start-button[\s\S]*?min-width:64px !important/);
  assert.match(small, /#mission-capture-button,#mission-outline,#conversation-attach[\s\S]*?flex-basis:34px !important/);
  // Minimum controls + five narrow gaps + horizontal toolbar padding.
  const minimum = 3 * 34 + 34 + 64 + 5 * 5 + 2 * 10;
  assert.ok(minimum <= 320, 'controls should fit a 320px content area while Stop is shown');
});
