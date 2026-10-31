import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFamily } from '../public/next/chat/reader-model.mjs';
import { paintHistory } from '../public/next/chat/render.mjs';

function fakeTimeline() {
  const document = {
    createElement(tagName) { return element(tagName); },
    createDocumentFragment() { return element('#fragment'); },
  };
  function element(tagName) {
    const node = {
      tagName, ownerDocument: document, className: '', dataset: {}, attributes: {},
      children: [], _text: '',
      classList: { add() {} },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) {
        this.children = children.flatMap(child => child.tagName === '#fragment' ? child.children : [child]);
        this._text = '';
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener() {},
      querySelectorAll(selector) {
        assert.equal(selector, 'details[data-disclosure-id]');
        return this.children.flatMap(child => descendants(child, node => node.tagName === 'details' && node.dataset.disclosureId !== undefined));
      },
    };
    Object.defineProperty(node, 'textContent', {
      get() { return this._text + this.children.map(child => child.textContent).join(''); },
      set(value) { this._text = String(value ?? ''); this.children = []; },
    });
    Object.defineProperty(node, 'innerHTML', {
      set(value) { this._html = String(value); this._text = ''; this.children = []; },
      get() { return this._html ?? ''; },
    });
    return node;
  }
  return element('main');
}
function descendants(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => descendants(child, predicate))];
}
const savedRun = (id, input, attachmentIds) => ({
  id, taskId: 'conversation', createdAt: '2026-10-25T12:00:00Z',
  status: 'completed', settled: true, input, attachmentIds,
  workflow: { nodes: [] }, nodes: {}, events: [], output: '',
});

test('saved attachment IDs survive the background chat projection without leaking binary content', () => {
  const source = savedRun('one', 'Review these', ['file_one', 'file_two']);
  const { runs } = projectFamily({ runs: [source] });
  assert.deepEqual(runs[0].attachmentIds, ['file_one', 'file_two']);
  assert.deepEqual(source.attachmentIds, ['file_one', 'file_two']);
  assert.deepEqual(projectFamily({ runs: [savedRun('old', 'Hello')] }).runs[0].attachmentIds, []);
});

test('sent user messages display full saved attachment filenames and keep unrelated files out', () => {
  const run = savedRun('one', 'Review the source documents', ['file_one', 'file_two']);
  const metadata = new Map([
    ['file_one', { name: 'quarterly-report.pdf' }],
    ['file_two', { name: 'notes & <review>.txt' }],
    ['file_unused', { name: 'unrelated-secret.txt' }],
  ]);
  const timeline = fakeTimeline();
  paintHistory({ timeline }, projectFamily({ runs: [run] }).runs, {
    getAttachment: id => metadata.get(id),
  });
  const files = descendants(timeline, node => node.className === 'next-message-file');
  assert.deepEqual(files.map(node => node.textContent), [
    '📎 quarterly-report.pdf', '📎 notes & <review>.txt',
  ]);
  assert.equal(files[1].title, 'notes & <review>.txt');
  const group = descendants(timeline, node => node.className === 'next-message-files')[0];
  assert.equal(group.attributes['aria-label'], '2 attached files');
  assert.doesNotMatch(timeline.textContent, /file_one|file_two|unrelated-secret\.txt/);
});

test('unavailable metadata is explicit, retries do not duplicate old file labels, and new turns show new files', () => {
  const original = savedRun('first', 'Analyze report', ['file_one']);
  const retry = { ...savedRun('retry', 'Analyze report', ['file_one']), retryOf: 'first', createdAt: '2026-10-25T12:01:00Z' };
  const followup = { ...savedRun('followup', 'Now compare this', ['file_missing', 'file_two']), createdAt: '2026-10-25T12:02:00Z' };
  const timeline = fakeTimeline();
  paintHistory({ timeline }, projectFamily({ runs: [original, retry, followup] }).runs, {
    getAttachment: id => ({ file_one: { name: 'first.pdf' }, file_two: { name: 'second.pdf' } })[id],
  });
  const files = descendants(timeline, node => node.className === 'next-message-file');
  assert.deepEqual(files.map(node => node.textContent), [
    '📎 first.pdf', '📎 Filename unavailable', '📎 second.pdf',
  ]);
  assert.equal(descendants(timeline, node => node.dataset.role === 'user').length, 2);
  assert.doesNotMatch(timeline.textContent, /file_missing/);
});
