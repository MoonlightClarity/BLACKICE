import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFamily } from '../public/next/chat/reader-model.mjs';
import { mergeChatRunUpdate } from '../public/next/chat/model.mjs';
import { chatRunError, paintHistory } from '../public/next/chat/render.mjs';

// A small DOM fixture exercises the same plain-text chat renderer used by the app.
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
      append(...children) {
        for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); }
      },
      insertBefore(child, before) {
        child.remove(); child.parentElement = this;
        const index = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(index, 0, child);
      },
      remove() {
        if (this.parentElement) {
          const siblings = this.parentElement.children;
          siblings.splice(siblings.indexOf(this), 1);
          this.parentElement = null;
        }
      },
      replaceChildren(...children) {
        this.children = children.flatMap(child => child.tagName === '#fragment' ? child.children : [child]);
        this._text = '';
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener() {},
      querySelectorAll(selector) {
        assert.equal(selector, 'details[data-disclosure-id]');
        return this.children.flatMap(child => descendants(child, item => item.tagName === 'details' && item.dataset.disclosureId !== undefined));
      },
    };
    Object.defineProperty(node, 'childNodes', { get() { return this.children; } });
    Object.defineProperty(node, 'lastChild', { get() { return this.children.at(-1); } });
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
const savedRun = (id, overrides = {}) => ({
  id, taskId: id, input: 'Diagnose this failure', createdAt: '2026-11-06T20:16:41Z',
  status: 'failed', settled: true, output: '', events: [], attachmentIds: [],
  workflow: { nodes: [{ id: 'agent', type: 'agent' }] },
  nodes: { agent: { status: 'failed' } },
  ...overrides,
});
const errors = timeline => descendants(timeline, node => node.className === 'next-chat-run-error');

test('saved provider error message and code display in the chat after background projection', () => {
  const actual = 'Groq: Request too large: TPM limit 8000, requested 24001. Try again.';
  const source = savedRun('groq', { error: actual, errorCode: 'PROVIDER_RATE_LIMIT' });
  const projected = projectFamily({ runs: [source] }).runs[0];
  assert.equal(projected.error, actual);
  assert.equal(projected.errorCode, 'PROVIDER_RATE_LIMIT');
  const timeline = fakeTimeline();
  paintHistory({ timeline }, [projected]);
  const [alert] = errors(timeline);
  assert.ok(alert, 'show a visible error, not just a failed badge');
  assert.equal(alert.attributes.role, 'alert');
  assert.ok(alert.textContent.includes(actual), 'preserve the real provider response');
  assert.ok(alert.textContent.includes('PROVIDER_RATE_LIMIT'));
  assert.match(timeline.textContent, /PROVIDER_RATE_LIMIT/, 'the error remains visible regardless of the available recovery controls');
});

test('tool and internal failures use the same error surface; node details are preserved', () => {
  const source = savedRun('tool', { nodes: { agent: { status: 'failed', error: 'Tool returned HTTP 502', errorCode: 'TOOL_FAILED' } } });
  const projected = projectFamily({ runs: [source] }).runs[0];
  assert.equal(projected.nodes.agent.error, 'Tool returned HTTP 502');
  assert.equal(projected.nodes.agent.errorCode, 'TOOL_FAILED');
  const timeline = fakeTimeline();
  paintHistory({ timeline }, [projected]);
  assert.match(errors(timeline)[0].textContent, /Tool returned HTTP 502/);
  assert.match(errors(timeline)[0].textContent, /TOOL_FAILED/);
});

test('generic fallback remains informative and successful runs do not show failure messages', () => {
  const failed = savedRun('missing');
  assert.equal(chatRunError(failed).message, 'This operation failed without a recorded error message.');
  const completed = savedRun('ok', { status: 'completed', nodes: { agent: { status: 'completed' } } });
  const timeline = fakeTimeline();
  paintHistory({ timeline }, projectFamily({ runs: [completed] }).runs);
  assert.equal(errors(timeline).length, 0);
});

test('live run updates carry errors and repaint the current turn without a page reload', () => {
  const before = projectFamily({ runs: [savedRun('live', { status: 'running', nodes: { agent: { status: 'running' } } })] }).runs[0];
  const updated = mergeChatRunUpdate(before, {
    id: 'live', status: 'failed', settled: true, error: 'API returned unexpected HTML <script>alert(1)</script>',
    errorCode: 'PROVIDER_PROTOCOL',
    nodes: { agent: { status: 'failed', error: 'API returned unexpected HTML <script>alert(1)</script>' } },
  });
  const timeline = fakeTimeline();
  paintHistory({ timeline }, [updated]);
  const [alert] = errors(timeline);
  assert.ok(alert.textContent.includes('<script>alert(1)</script>'), 'display the actual text');
  assert.equal(alert.children.some(node => node.tagName === 'script'), false, 'never interpret diagnostic text as HTML');
  assert.match(alert.textContent, /PROVIDER_PROTOCOL/);

  updated.error = 'Revised final diagnostic';
  paintHistory({ timeline }, [updated]);
  assert.match(errors(timeline)[0].textContent, /Revised final diagnostic/, 'changed errors invalidate the cached turn');
});
