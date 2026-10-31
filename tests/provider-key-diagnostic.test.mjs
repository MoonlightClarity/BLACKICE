import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { providerKeyDiagnosticPage } from '../desktop/provider-key-diagnostic.mjs';

const SECRET = 'synthetic_key_source_token_938751239012';
const origin = 'https://provider.example', expectedUrl = `${origin}/keys`;
function fixture() {
  const elements = [], window = { origin, location: { href: expectedUrl }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  const document = { defaultView: window, querySelectorAll: () => elements };
  window.top = window;
  const context = vm.createContext({ window, location: { origin }, origin, document });
  const add = (tagName, options = {}) => {
    const { attributes = {}, ...rest } = options;
    const element = { tagName, ownerDocument: document, isConnected: true, childElementCount: 0, childNodes: [], textContent: '',
      getBoundingClientRect: () => ({ width: 100, height: 20 }), closest: () => null,
      getAttribute: key => attributes[key] ?? null, hasAttribute: key => Object.hasOwn(attributes, key), ...rest };
    elements.push(element); return element;
  };
  return { add, context, run: args => vm.runInContext(`(${providerKeyDiagnosticPage.toString()})(${JSON.stringify({ origin, expectedUrl, ...args })})`, context) };
}
const publicJSON = result => { const text = JSON.stringify(result); assert.equal(text.includes(SECRET), false); return JSON.parse(text); };

test('pure diagnostic describes nested direct key text and editable password without returning text or values', () => {
  const page = fixture();
  page.add('DIV', { textContent: `${SECRET} Copy`, childElementCount: 1, childNodes: [{ nodeType: 3, textContent: SECRET }, { nodeType: 1, textContent: 'Copy' }] });
  page.add('INPUT', { type: 'password', value: SECRET, attributes: { 'aria-label': SECRET, placeholder: SECRET } });
  page.add('OUTPUT', { textContent: SECRET, childNodes: [{ nodeType: 3, textContent: SECRET }] });
  const result = publicJSON(page.run());
  assert.equal(result.valid, true); assert.equal(result.textCandidates.length, 2);
  assert.deepEqual(result.textCandidates.map(value => [value.tag, value.directTokenCount]), [['div', 1], ['output', 1]]);
  assert.equal(result.fields[0].type, 'password'); assert.equal(result.fields[0].valueShape, 'token_shaped');
});

test('diagnostic returns fixed control classes and validity flags, never validation messages or raw bounds', () => {
  const page = fixture();
  page.add('BUTTON', { textContent: 'Copy API key', attributes: { title: 'Copy API key', 'data-clipboard-text': SECRET } });
  page.add('BUTTON', { textContent: SECRET, attributes: { 'aria-label': SECRET, title: SECRET } });
  page.add('INPUT', { type: 'number', value: '0', validationMessage: SECRET, attributes: { 'aria-label': 'Credit limit', min: '0', max: SECRET, step: '0.01' }, validity: { valid: false, rangeUnderflow: true, customError: true }, checkValidity() { throw Error('must not fire events'); } });
  const result = publicJSON(page.run());
  assert.equal(result.controls[0].kind, 'copy'); assert.equal(result.controls[0].clipboardAttributePresent, true);
  assert.equal(result.controls[1].kind, 'other');
  assert.equal(result.fields[0].min, 0); assert.equal(result.fields[0].max, null); assert.equal(result.fields[0].step, 0.01);
  assert.equal(result.fields[0].validity.rangeUnderflow, true); assert.equal(result.fields[0].category, 'limit');
});

test('diagnostic exact-origin and page guards fail before examining page content', () => {
  const page = fixture(); page.context.document.querySelectorAll = () => { throw Error(SECRET); };
  assert.deepEqual(publicJSON(page.run({ expectedUrl: `${origin}/other` })), { valid: false });
  assert.deepEqual(publicJSON(page.run({ origin: 'https://other.example' })), { valid: false });
});

test('masked displays are classified without being treated as a visible key', () => {
  const page = fixture(); page.add('SPAN', { textContent: 'sk-or-v1-****hidden****' });
  const result = publicJSON(page.run()); assert.equal(result.textCandidates[0].textShape, 'masked'); assert.equal(result.textCandidates[0].directTokenCount, 0);
});
