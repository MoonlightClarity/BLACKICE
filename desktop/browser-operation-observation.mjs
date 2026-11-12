/**
 * These functions execute in the observed page through the contained browser.
 * They are host-only adapter helpers, not model-callable browser actions.
 */
export async function inspectObservedFormControl(el, state, args) {
  if (!el?.isConnected) return { kind: 'opaque' };
  if (args.hostRecoveryInspection === true) {
    // Host-only observation: no focus, DOM events, form serialization or input.
    // Password/credential controls deliberately have no reviewable snapshot.
    if (el.type === 'password' || state?.credentialFields?.has(el) || !globalThis.crypto?.subtle) return { ref: args.ref, kind: 'opaque' };
    const details = await inspectObservedFormControl(el, state, { ...args, hostRecoveryInspection: false });
    try {
      state.recoveryNodes ||= new WeakMap(); state.nextRecoveryNode ||= 0;
      const identity = node => { if (!node) return null; if (!state.recoveryNodes.has(node)) state.recoveryNodes.set(node, 'node-' + (++state.nextRecoveryNode)); return state.recoveryNodes.get(node); };
      const nodeId = identity(el);
      const stateOf = () => {
        if (!el.isConnected || el.type === 'password' || state?.credentialFields?.has(el)) throw Error('Changed protected control');
        const attributes = [...el.attributes].filter(item => item.name !== 'style').map(item => [item.name, item.value]).sort(([a],[b]) => a.localeCompare(b));
        const form = el.form ? { id: identity(el.form), action: el.form.action, method: el.form.method, target: el.form.target, enctype: el.form.enctype } : null;
        const snapshot = { nodeId, tag: el.tagName, attributes, value: typeof el.value === 'string' ? el.value : null,
          text: String(el.textContent || ''), checked: Boolean(el.checked), disabled: Boolean(el.disabled), readOnly: Boolean(el.readOnly), form,
          options: el.tagName === 'SELECT' ? [...el.options].map(option => [option.value, option.selected, option.disabled, option.text]) : null };
        const serialized = JSON.stringify(snapshot);
        if (attributes.length > 128 || serialized.length > 65536) throw Error('Control snapshot bound');
        return serialized;
      };
      const before = stateOf();
      const stateDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(before)))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (before !== stateOf()) throw Error('Control changed during inspection');
      return { ...details, recovery: { version: 1, nodeId, stateDigest, tag: el.tagName, type: String(el.type || ''),
        label: String(el.getAttribute?.('aria-label') || el.getAttribute?.('name') || el.getAttribute?.('title') || el.textContent || '').trim().slice(0, 200) } };
    } catch { return { ref: args.ref, kind: 'opaque' }; }
  }
  const basic = { ref: args.ref };
  const submit = ['BUTTON', 'INPUT'].includes(el.tagName) && ['submit', 'image'].includes(el.type);
  if (!submit || !['click', 'press'].includes(args.action) || args.action === 'press' && args.key !== 'Enter') {
    if (el.tagName === 'A' && el.href) return { ...basic, kind: 'link', href: el.href };
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !['submit', 'image', 'button'].includes(el.type))
      return { ...basic, kind: 'field' };
    return { ...basic, kind: 'opaque' };
  }
  const form = el.form;
  if (!form?.isConnected || el.type === 'image' || !globalThis.crypto?.subtle
    || [...form.elements].some(field => field.type === 'password' || state?.credentialFields?.has(field))) return { ...basic, kind: 'opaque' };
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  const textHash = value => hash(new TextEncoder().encode(JSON.stringify(value)));
  try {
    // Reading FormData(form) fires a page formdata event. Inspect native controls
    // directly instead: descriptor preparation must never dispatch page code.
    const fields = [];
    for (const field of form.elements) {
      if (!['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'FIELDSET', 'OUTPUT'].includes(field.tagName)) return { ...basic, kind: 'opaque' };
      if (!field.name || field.disabled || field.matches?.(':disabled') || ['FIELDSET', 'OUTPUT'].includes(field.tagName)) continue;
      if (['button', 'reset', 'submit', 'image'].includes(field.type)) {
        if (field === el && field.type === 'submit') fields.push([field.name, field.value]);
        continue;
      }
      if (['checkbox', 'radio'].includes(field.type) && !field.checked) continue;
      if (field.tagName === 'SELECT') {
        for (const option of field.options) if (option.selected && !option.disabled && !(option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled))
          fields.push([field.name, option.value]);
      } else if (field.type === 'file') {
        for (const file of field.files || []) fields.push([field.name, file]);
      } else fields.push([field.name, String(field.value ?? '')]);
      if (field.getAttribute?.('dirname')) fields.push([field.getAttribute('dirname'), getComputedStyle(field).direction === 'rtl' ? 'rtl' : 'ltr']);
    }
    if (fields.length > 500) return { ...basic, kind: 'opaque' };
    const payload = [], strings = new Map(), attachmentDigests = [];
    let textSize = 0, fileSize = 0;
    for (const [name, value] of fields) {
      if (name.length > 256) return { ...basic, kind: 'opaque' };
      if (typeof value === 'string') {
        textSize += value.length;
        if (textSize > 131072 || value.length > 16384) return { ...basic, kind: 'opaque' };
        payload.push([name, value]); const previous = strings.get(name) || []; previous.push(value); strings.set(name, previous);
      } else {
        fileSize += value.size;
        if (value.size > 33554432 || fileSize > 67108864 || attachmentDigests.length >= 20) return { ...basic, kind: 'opaque' };
        const fileDigest = await hash(await value.arrayBuffer());
        attachmentDigests.push(fileDigest);
        payload.push([name, { name: value.name, size: value.size, type: value.type, sha256: fileDigest }]);
      }
    }
    const identityDigests = [];
    for (const [name, values] of strings) if (values.length === 1) identityDigests.push({ name, digest: await textHash(values[0]) });
    state.formIds ||= new WeakMap(); state.nextFormId ||= 0;
    if (!state.formIds.has(form)) state.formIds.set(form, 'form-' + (++state.nextFormId));
    const action = el.hasAttribute('formaction') ? el.formAction : form.action;
    const method = String(el.hasAttribute('formmethod') ? el.formMethod : form.method || 'get').toUpperCase();
    const enctype = String(el.hasAttribute('formenctype') ? el.formEnctype : form.enctype || 'application/x-www-form-urlencoded').toLowerCase();
    const target = String(el.hasAttribute('formtarget') ? el.formTarget : form.target || '_self');
    let navigationUrl;
    if (['GET', 'HEAD'].includes(method)) {
      const destination = new URL(action, location.href), query = new URLSearchParams();
      for (const [name, value] of fields) query.append(name, typeof value === 'string' ? value : value.name);
      destination.search = query.toString(); navigationUrl = destination.href;
    }
    const requestPayloadDigest = method === 'POST' && enctype === 'application/x-www-form-urlencoded' && attachmentDigests.length === 0
      ? await textHash(payload.map(([name, value]) => [name.replace(/\r\n|\r|\n/g, '\r\n'), value.replace(/\r\n|\r|\n/g, '\r\n')])) : undefined;
    return { ...basic, kind: ['GET', 'HEAD'].includes(method) ? 'form-navigation' : method === 'POST' ? 'form-submit' : 'opaque',
      form: { id: state.formIds.get(form), action, method, enctype, target, submitLabel: String(el.getAttribute?.('aria-label') || el.innerText || el.textContent || el.value || '').trim().slice(0, 200), ...(navigationUrl ? { navigationUrl } : {}),
        payloadDigest: await textHash({ method, enctype, target, payload }), payloadSource: 'observed-native-controls', attachmentDigests, identityDigests,
        ...(requestPayloadDigest ? { requestPayloadDigest } : {}) } };
  } catch { return { ...basic, kind: 'opaque' }; }
}

export function observePageReceiptRecords(bindings) {
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const pointer = (value, path) => {
    if (path === '') return value;
    if (typeof path !== 'string' || !path.startsWith('/') || /~(?:[^01]|$)/.test(path)) return undefined;
    for (const key of path.slice(1).split('/').map(value => value.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (!value || typeof value !== 'object' || !own(value, key)) return undefined;
      value = value[key];
    }
    return value;
  };
  const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))
    && String(value).trim() && String(value).length <= 2048 ? String(value) : null;
  // This complete selected-record fact is independent of the model's binding.
  // Never truncate it: an incomplete fact cannot distinguish a fresh receipt.
  const recordSource = (format, record) => {
    try {
      let nodes = 0;
      const bounded = (value, depth = 0) => {
        if (++nodes > 2048 || depth > 12) throw new Error('Receipt source limit');
        if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.length <= 8192) return value;
        if (!value || typeof value !== 'object') throw new Error('Invalid receipt source');
        const keys = Object.keys(value);
        if (keys.length > 256 || keys.some(key => key.length > 256)) throw new Error('Receipt source limit');
        return Array.isArray(value) ? value.map(item => bounded(item, depth + 1))
          : Object.fromEntries(keys.sort().map(key => [key, bounded(value[key], depth + 1)]));
      };
      let value = record;
      if (format === 'dom') {
        if (!record.attributes || record.attributes.length > 256 || typeof record.innerText !== 'string') return undefined;
        value = { attributes: Object.fromEntries([...record.attributes].filter(item => item.name.startsWith('data-')).map(item => [item.name, item.value])),
          text: record.innerText.replace(/\s+/g, ' ').trim() };
      }
      const serialized = JSON.stringify({ format, record: bounded(value), version: 1 });
      return serialized.length <= 16384 ? serialized : undefined;
    } catch { return undefined; }
  };
  const output = [];
  let json, jsonRead = false;
  for (const binding of (Array.isArray(bindings) && bindings.length<=320 ? bindings : [])) {
    try {
      let records;
      if (['dom', 'dom-text'].includes(binding.format)) {
        records = [...document.querySelectorAll(binding.record)];
      } else if (binding.format === 'json') {
        if (!jsonRead) {
          jsonRead = true;
          const body = document.body?.innerText || '';
          if (body.length <= 1048576) try { json = JSON.parse(body); } catch {}
        }
        const value = pointer(json, binding.record);
        records = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
      } else continue;
      if (records.length > 100) { output.push({ records: [], overflow: true }); continue; }
      const values = records.map(record => {
        if (binding.format === 'dom-text') {
          const style = getComputedStyle(record), box = record.getBoundingClientRect();
          const status = String(record.innerText ?? record.textContent ?? '').replace(/\s+/g, ' ').trim();
          const visible = record.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && (box.width > 0 || box.height > 0);
          return { status, ...(!visible || records.length !== 1 || !status || status.length > 200 ? { ambiguous: true } : {}) };
        }
        const field = name => scalar(binding.format === 'dom' ? record.getAttribute(name) : pointer(record, name));
        const status = field(binding.status), outcomeId = field(binding.outcomeId);
        const destination = binding.destination ? field(binding.destination) : undefined;
        const prior = binding.prior ? field(binding.prior.field) : undefined;
        const identityValues = (binding.identity || []).map(identity => ({ name: identity.formField, field: identity.field, value: field(identity.field) }));
        const source = recordSource(binding.format, record);
        return { status, outcomeId, ...(binding.destination ? { destination } : {}), ...(binding.prior ? { prior } : {}), identityValues,
          ...(source ? { recordSource: source } : {}),
          ...(!status || !outcomeId || binding.destination && !destination || binding.prior && prior === null || identityValues.some(item => item.value === null) ? { ambiguous: true } : {}) };
      });
      output.push({ records: values });
    } catch { output.push({ records: [], unavailable: true }); }
  }
  return output;
}
