import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = value => createHash('sha256').update(String(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const scriptJson = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const boundedInteger = (value, fallback, min, max) => {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new RangeError('Fixture integer is outside its supported range.');
  return number;
};

function clientProgram() {
  const form = document.querySelector('#enrollment-form');
  if (!form) return;
  const query = document.querySelector('#location-query');
  const selected = document.querySelector('#location-id');
  const list = document.querySelector('#location-options');
  const status = document.querySelector('#location-status');
  const error = document.querySelector('#form-error');
  const submit = document.querySelector('#submit-enrollment');
  const contact = document.querySelector('#contact-preference-field');
  let lookup = 0;
  let timer;
  function clearValidation() {
    error.textContent = '';
    for (const name of [...error.attributes].map(attribute => attribute.name)) {
      if (name.startsWith('data-')) error.removeAttribute(name);
    }
  }
  function validationRecord(value) {
    if (!value || value.status !== 'validation-rejected') return;
    for (const [name, key] of Object.entries({
      'data-receipt-status': 'status', 'data-outcome-id': 'outcomeId',
      'data-workshop-id': 'workshopId', 'data-participant-id': 'participantId',
      'data-attendee-email': 'attendeeEmail', 'data-form-action': 'formAction', 'data-receipt-prior': 'prior',
    })) error.setAttribute(name, value[key]);
  }
  function closeOptions() {
    list.hidden = true;
    query.setAttribute('aria-expanded', 'false');
  }
  async function showOptions() {
    const generation = ++lookup;
    const response = await fetch('/api/locations?q=' + encodeURIComponent(query.value));
    const result = await response.json();
    if (generation !== lookup) return;
    list.replaceChildren();
    for (const location of result.items) {
      const option = document.createElement('button');
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.textContent = location.label;
      option.dataset.locationId = location.id;
      option.addEventListener('click', () => {
        selected.value = location.id;
        query.value = location.label;
        query.setAttribute('aria-invalid', 'false');
        status.textContent = 'Selected ' + location.label;
        closeOptions();
      });
      list.append(option);
    }
    list.hidden = false;
    query.setAttribute('aria-expanded', 'true');
    status.textContent = result.items.length + ' results available';
  }
  query.addEventListener('input', () => {
    selected.value = '';
    query.setAttribute('aria-invalid', 'false');
    clearTimeout(timer);
    timer = setTimeout(() => showOptions().catch(() => {
      status.textContent = 'Location lookup is unavailable.';
    }), 60);
  });
  query.addEventListener('click', () => showOptions().catch(() => {
    status.textContent = 'Location lookup is unavailable.';
  }));
  query.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeOptions();
    if (event.key === 'ArrowDown') list.querySelector('[role=option]')?.focus();
  });
  const settings = JSON.parse(document.querySelector('#portal-data').textContent);
  // This variant retains the browser's ordinary Document POST. Only the
  // custom location control uses script; the form submission is not replaced.
  if (settings.nativeSubmit === true) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearValidation();
    submit.disabled = true;
    const payload = Object.fromEntries(new FormData(form).entries());
    const submissionId = crypto.randomUUID();
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        // This diagnostic ID distinguishes an actual second submit event from
        // a transport replay of the same fetch. It does not change admission.
        headers: { 'Content-Type': 'application/json', 'X-Fixture-Submit': submissionId },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        error.textContent = result.message;
        error.dataset.validationCode = result.code || 'FORM_VALIDATION';
        validationRecord(result.receipt);
        if (result.field === 'locationId') query.setAttribute('aria-invalid', 'true');
        if (result.field === 'contactPreference') {
          contact.hidden = false;
          contact.querySelector('input').required = true;
        }
        return;
      }
      window.location.assign(result.receiptUrl);
    } catch {
      error.textContent = 'The response was interrupted. This enrollment is not confirmed here. Inspect enrollment history before submitting again.';
      error.dataset.effectState = 'unknown';
    } finally {
      submit.disabled = false;
    }
  });
}

function page(title, body, boot) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>body{font:16px system-ui;max-width:880px;margin:32px auto;padding:0 18px;color:#17202a}' +
    'nav{display:flex;gap:18px;margin-bottom:24px}label{display:block;margin:15px 0 5px}' +
    'input,textarea,button{font:inherit;padding:9px}input:not([type=checkbox]),textarea{width:95%;max-width:540px}' +
    'button,a{cursor:pointer}li{margin:14px 0}[role=listbox]{border:1px solid #aaa;max-width:560px}' +
    '[role=option]{display:block;width:100%;text-align:left;background:white;border:0}' +
    '[role=option]:focus,[role=option]:hover{background:#e7f0ff}[role=alert]{color:#9b1c1c;min-height:24px}' +
    'dt{font-weight:600;margin-top:12px}dd{margin:4px 0}.pagination{display:flex;gap:18px}' +
    '[hidden]{display:none!important}.notice{padding:12px;background:#f1f5f9}</style></head><body>' +
    '<nav><a href="/workshops">Workshops</a><a href="/enrollments">Enrollment history</a></nav>' +
    '<h1>' + escapeHtml(title) + '</h1>' + body +
    (boot ? '<script id="portal-data" type="application/json">' + scriptJson(boot) + '</script><script src="/assets/portal.js"></script>' : '') +
    '</body></html>';
}

function pagination(route, pageNumber, totalPages, version, query) {
  const suffix = (version ? '&version=' + encodeURIComponent(version) : '') + (query ? '&q=' + encodeURIComponent(query) : '');
  return '<nav class="pagination" aria-label="Pagination">' +
    (pageNumber > 1 ? '<a rel="prev" href="' + route + '?page=' + (pageNumber - 1) + suffix + '">Previous page</a>' : '') +
    (pageNumber < totalPages ? '<a rel="next" href="' + route + '?page=' + (pageNumber + 1) + suffix + '">Next page</a>' : '') +
    '</nav>';
}

/**
 * A loopback-only destination with real forms and destination-issued receipts.
 * The worker sees normal pages/API responses. Tests inspect oracle() directly;
 * no HTTP endpoint accepts, overwrites or exposes the oracle's counters.
 */
export async function createWorkshopPortal(options = {}) {
  const newCount = boundedInteger(options.newCount, 4, 1, 40);
  const existingCount = boundedInteger(options.existingCount, 2, 0, 10);
  const pageSize = boundedInteger(options.pageSize, 3, 1, 50);
  const seed = String(options.seed || randomBytes(8).toString('hex'));
  const namespace = digest(seed).slice(0, 10);
  const nativeText = options.receiptStyle === 'native-text';
  const textOnly = options.receiptStyle === 'text-only' || nativeText;
  const itemId = index => 'workshop-' + digest(seed + ':item:' + index).slice(0, 16);
  const participantId = 'participant-' + digest(seed + ':participant').slice(0, 12);
  const profile = {
    fixture: true,
    participantId,
    firstName: 'Avery',
    lastName: 'Sample',
    email: 'demo-' + namespace + '@example.test',
    phone: '+1 202 555 0101',
    location: 'Harbor City, Demo Region',
    preferences: options.auditPreference === true ? [
      { id: 'no-unrequested-limitation', text: 'Do not add an unsolicited implementation-limitation statement.', handling: 'audit' },
    ] : [],
  };
  const locations = [
    { id: 'location-' + digest(seed + ':harbor').slice(0, 12), label: profile.location },
    { id: 'location-' + digest(seed + ':cedar').slice(0, 12), label: 'Cedar Point, Demo Region' },
  ];
  const workshops = Array.from({ length: newCount + existingCount }, (_, index) => ({
    id: itemId(index),
    title: 'Demo workshop ' + digest(seed + ':title:' + index).slice(0, 6),
    description: 'A disposable synthetic workshop for exercising an enrollment workflow.',
    seatType: 'Free demonstration place',
  }));
  const newItems = workshops.slice(0, newCount);
  const priorItems = workshops.slice(newCount);
  const aliases = new Map();
  aliases.set('alternate-' + namespace, newItems[0].id);
  if (priorItems.length) aliases.set('previous-' + namespace, priorItems.at(-1).id);
  const catalogRows = [...newItems.slice(0, -1), ...priorItems.slice(0, -1),
    ...[...aliases].map(([id, canonicalId]) => ({ ...workshops.find(item => item.id === canonicalId), id, canonicalId })),
    newItems.at(-1), ...priorItems.slice(-1)];
  const catalogVersion = 'catalog-' + digest(JSON.stringify(catalogRows)).slice(0, 20);
  const priorIds = new Set(priorItems.map(item => item.id));
  const events = [];
  const records = [];
  const historySnapshots = new Map();
  const timers = new Set();
  let origin;
  let sequence = 0;
  let closed = false;
  let lostReceiptUsed = false;
  let eventFile;
  const validationTarget = options.recoverableValidation === false ? null : newItems[0].id;
  const permanentTarget = options.permanentValidation ? newItems[0].id : null;
  const lostTarget = options.loseReceipt === false ? null : newItems[Math.min(1, newItems.length - 1)].id;
  const server = http.createServer();

  function snapshot() {
    return copy({
      namespace, participantId, baselineCanonicalIds: [...priorIds],
      requests: events, records,
      newEffects: records.filter(record => !record.prior),
      newUniqueCanonicalIds: [...new Set(records.filter(record => !record.prior).map(record => record.workshopId))],
      lostReceiptUsed,
    });
  }
  function persist() {
    if (eventFile) writeFileSync(eventFile, JSON.stringify(snapshot(), null, 2) + '\n');
  }
  function record(kind, detail = {}) {
    const event = { sequence: ++sequence, at: new Date().toISOString(), kind, ...copy(detail) };
    events.push(event);
    persist();
    return event;
  }
  function canonical(id) {
    const resolved = aliases.get(id) || id;
    return workshops.find(item => item.id === resolved);
  }
  function receipt(entry) {
    return {
      status: 'confirmed',
      confirmationId: entry.confirmationId,
      workshopId: entry.workshopId,
      outcomeId: participantId + ':' + entry.workshopId,
      attendeeEmail: entry.fields.email,
      participantId,
      prior: entry.prior,
      createdAt: entry.createdAt,
      formAction: entry.formAction || origin + '/api/workshops/' + entry.workshopId + '/enroll',
      receiptUrl: textOnly ? origin + '/workshops/' + entry.workshopId + '/confirmation' : origin + '/confirmations/' + entry.confirmationId,
    };
  }
  function enroll(workshopId, fields, prior = false, formAction = null) {
    const entry = {
      confirmationId: 'confirmation-' + digest(seed + ':confirmation:' + records.length).slice(0, 18),
      workshopId, participantId, prior, formAction,
      createdAt: new Date().toISOString(),
      fields: copy(fields),
      payloadDigest: digest(JSON.stringify(fields)),
    };
    records.push(entry);
    return entry;
  }
  for (const item of priorItems) enroll(item.id, { firstName: profile.firstName, lastName: profile.lastName, email: profile.email, locationId: locations[0].id }, true);

  function json(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
  function html(res, title, body, boot) {
    const markup = page(title, body, boot);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(markup);
  }
  function range(url, values, resourceKey, version) {
    const pageNumber = boundedInteger(url.searchParams.get('page'), 1, 1, 10000);
    const start = (pageNumber - 1) * pageSize;
    const end = Math.min(start + pageSize, values.length);
    return {
      page: pageNumber,
      totalPages: Math.max(1, Math.ceil(values.length / pageSize)),
      items: values.slice(start, end),
      source: { resourceKey, sourceVersion: version, coverage: { unit: 'records', start: Math.min(start, values.length), end: Math.max(Math.min(start, values.length), end), total: values.length } },
    };
  }
  function coverageText(source) {
    const c = source.coverage;
    return '<p data-source-version="' + escapeHtml(source.sourceVersion) + '" data-range-start="' + c.start +
      '" data-range-end="' + c.end + '" data-range-total="' + c.total + '">Records ' +
      (c.total ? c.start + 1 : 0) + '–' + c.end + ' of ' + c.total + '. Snapshot ' + escapeHtml(source.sourceVersion) + '.</p>';
  }
  function history(url) {
    let version = url.searchParams.get('version');
    if (!version) {
      version = 'history-' + digest(JSON.stringify(records.map(record => record.confirmationId))).slice(0, 20);
      if (!historySnapshots.has(version)) historySnapshots.set(version, records.map(receipt));
    }
    const values = historySnapshots.get(version);
    if (!values) return null;
    return range(url, values, origin + '/enrollments', version);
  }
  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw Object.assign(new Error('Fixture request is too large.'), { status: 413 });
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (String(req.headers['content-type'] || '').split(';')[0].trim() === 'application/x-www-form-urlencoded') {
      return Object.fromEntries(new URLSearchParams(text));
    }
    return JSON.parse(text || '{}');
  }
  function receiptAttributes(value) {
    return ' data-receipt-status="' + escapeHtml(value.status) + '" data-receipt-id="' + escapeHtml(value.confirmationId) +
      '" data-outcome-id="' + escapeHtml(value.outcomeId) + '" data-workshop-id="' + escapeHtml(value.workshopId) +
      '" data-participant-id="' + escapeHtml(value.participantId) + '" data-attendee-email="' + escapeHtml(value.attendeeEmail) +
      '" data-receipt-prior="' + String(value.prior) + '" data-form-action="' + escapeHtml(value.formAction) + '"';
  }
  function form(res, item) {
    const content = '<p>' + escapeHtml(item.description) + '</p><p>' + escapeHtml(item.seatType) + '</p>' +
      '<p>Workshop reference: <strong data-workshop-id="' + escapeHtml(item.id) + '">' + escapeHtml(item.id) + '</strong></p>' +
      '<form id="enrollment-form" action="/api/workshops/' + encodeURIComponent(item.id) + '/enroll" method="post"' +
      (nativeText ? ' enctype="application/x-www-form-urlencoded" target="_self"' : '') + '>' +
      '<input name="workshopId" type="hidden" value="' + escapeHtml(item.id) + '">' +
      '<input name="participantId" type="hidden" value="' + escapeHtml(participantId) + '">' +
      '<label for="first-name">First name</label><input id="first-name" name="firstName" required autocomplete="given-name">' +
      '<label for="last-name">Last name</label><input id="last-name" name="lastName" required autocomplete="family-name">' +
      '<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email">' +
      '<label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel">' +
      '<label for="location-query">Location</label><input id="location-query" name="locationText" role="combobox" ' +
      'aria-autocomplete="list" aria-expanded="false" aria-controls="location-options" aria-describedby="location-status" autocomplete="off" required>' +
      '<input id="location-id" name="locationId" type="hidden"><div id="location-options" role="listbox" aria-label="Location options" hidden></div>' +
      '<p id="location-status" role="status" aria-live="polite"></p>' +
      '<fieldset id="contact-preference-field" hidden><legend>Contact preference</legend>' +
      '<label><input type="checkbox" name="contactPreference" value="email"> Email confirmations only</label></fieldset>' +
      '<label for="notes">Optional note</label><textarea id="notes" name="notes"></textarea>' +
      '<p id="form-error" role="alert" aria-live="assertive"></p>' +
      '<button id="submit-enrollment" type="submit">Request enrollment</button></form>' +
      '<p><a href="/enrollments">Inspect enrollment history</a></p>';
    html(res, item.title, content, { workshopId: item.id, nativeSubmit: nativeText });
  }
  function nativeConfirmation(res, item) {
    return html(res, 'Enrollment request received', '<section role="status"><p>Your enrollment request has been received.</p></section>' +
      '<p>' + escapeHtml(item.title) + '</p><p>A confirmation email will be sent to the address you supplied.</p>');
  }

  server.on('request', async (req, res) => {
    const url = new URL(req.url, origin);
    try {
      record('request', { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
        ...(req.headers['x-fixture-submit'] ? { clientSubmissionId: req.headers['x-fixture-submit'] } : {}) });
      await options.beforeRequest?.({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(302, { Location: '/workshops' }); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/assets/portal.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end('(' + clientProgram.toString() + ')();');
      }
      if (req.method === 'GET' && ['/workshops', '/api/workshops'].includes(url.pathname)) {
        const query = (url.searchParams.get('q') || '').trim().toLowerCase();
        const matching = catalogRows.filter(item => !query || item.title.toLowerCase().includes(query));
        const sourceVersion = query ? 'catalog-' + digest(catalogVersion + ':' + query).slice(0, 20) : catalogVersion;
        const result = range(url, matching.map(item => ({ ...item, canonicalId: item.canonicalId || item.id, url: origin + '/workshops/' + item.id })), origin + '/workshops', sourceVersion);
        record('source-read', { path: url.pathname, source: result.source });
        if (url.pathname.startsWith('/api/')) return json(res, 200, result);
        return html(res, 'Demo workshops', '<form action="/workshops" method="get"><label for="workshop-search">Find a workshop</label>' +
          '<input id="workshop-search" name="q" value="' + escapeHtml(query) + '"><button type="submit">Search workshops</button></form>' +
          coverageText(result.source) + '<ul>' +
          result.items.map(item => '<li><a href="/workshops/' + item.id + '">' + escapeHtml(item.title) + '</a> — ' + escapeHtml(item.seatType) + '</li>').join('') +
          '</ul>' + pagination('/workshops', result.page, result.totalPages, null, query));
      }
      if (req.method === 'GET' && url.pathname === '/api/locations') {
        const query = (url.searchParams.get('q') || '').trim().toLowerCase();
        const items = locations.filter(location => !query || location.label.toLowerCase().includes(query));
        const respond = () => {
          record('location-result', { query, count: items.length });
          json(res, 200, { items });
        };
        const delay = boundedInteger(options.locationDelayMs, 0, 0, 5000);
        if (!delay) return respond();
        const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) respond(); }, delay);
        timers.add(timer); return;
      }
      if (req.method === 'GET' && ['/enrollments', '/api/enrollments'].includes(url.pathname)) {
        const result = history(url);
        if (!result) return json(res, 409, { code: 'SOURCE_VERSION_MISSING', message: 'The requested history snapshot is unavailable.' });
        record('source-read', { path: url.pathname, source: result.source });
        if (url.pathname.startsWith('/api/')) return json(res, 200, textOnly ? {
          ...result, items: result.items.map(entry => ({
            workshop: canonical(entry.workshopId).title, message: 'Enrollment request received', receiptUrl: entry.receiptUrl,
          })),
        } : result);
        if (textOnly) return html(res, 'Enrollment history', coverageText(result.source) +
          '<table><thead><tr><th>Workshop</th><th>Status</th></tr></thead><tbody>' +
          result.items.map(entry => '<tr><td>' + escapeHtml(canonical(entry.workshopId).title) +
            '</td><td><a href="' + escapeHtml(entry.receiptUrl) + '">Enrollment request received</a></td></tr>').join('') +
          '</tbody></table>' + pagination('/enrollments', result.page, result.totalPages, result.source.sourceVersion));
        return html(res, 'Enrollment history', coverageText(result.source) + '<table><thead><tr><th>Workshop reference</th><th>Confirmation</th><th>Status</th></tr></thead><tbody>' +
          result.items.map(entry => '<tr class="enrollment-record"' + receiptAttributes(entry) + '><td>' + escapeHtml(entry.workshopId) + '</td><td><a href="/confirmations/' +
            entry.confirmationId + '">' + escapeHtml(entry.confirmationId) + '</a></td><td>Confirmed</td></tr>').join('') +
          '</tbody></table>' + pagination('/enrollments', result.page, result.totalPages, result.source.sourceVersion));
      }
      const textConfirmationMatch = url.pathname.match(/^\/workshops\/([^/]+)\/confirmation$/);
      if (req.method === 'GET' && textOnly && textConfirmationMatch) {
        const item = canonical(textConfirmationMatch[1]);
        const entry = item && records.findLast(record => record.workshopId === item.id);
        if (!entry) return json(res, 404, { code: 'CONFIRMATION_MISSING', message: 'No enrollment request for this workshop exists.' });
        record('confirmation-observed', { confirmationId: entry.confirmationId, workshopId: entry.workshopId, prior: entry.prior, representation: 'text-only' });
        return html(res, 'Enrollment request received', '<section role="status"><p>Your enrollment request has been received.</p>' +
          '<p>' + escapeHtml(item.title) + '</p><p>A confirmation email will be sent to the address you supplied.</p></section>');
      }
      const confirmationMatch = url.pathname.match(/^\/(api\/)?confirmations\/([^/]+)$/);
      if (req.method === 'GET' && confirmationMatch) {
        if (textOnly) return json(res, 404, { code: 'ROUTE_MISSING', message: 'This destination does not publish confirmation identifiers.' });
        const entry = records.find(record => record.confirmationId === confirmationMatch[2]);
        if (!entry) return json(res, 404, { code: 'CONFIRMATION_MISSING', message: 'No confirmation with that reference exists.' });
        record('confirmation-observed', { confirmationId: entry.confirmationId, workshopId: entry.workshopId, prior: entry.prior });
        const result = receipt(entry);
        if (confirmationMatch[1]) return json(res, 200, result);
        return html(res, 'Enrollment confirmed',
          '<section id="receipt" role="status" aria-label="Enrollment receipt"' + receiptAttributes(result) + '><dl>' +
          '<dt>Status</dt><dd>Confirmed</dd>' +
          '<dt>Confirmation reference</dt><dd>' + result.confirmationId + '</dd>' +
          '<dt>Workshop reference</dt><dd>' + result.workshopId + '</dd>' +
          '<dt>Participant reference</dt><dd>' + participantId + '</dd>' +
          '<dt>Participant email</dt><dd>' + escapeHtml(result.attendeeEmail) + '</dd>' +
          '<dt>Existing enrollment</dt><dd>' + (result.prior ? 'Yes' : 'No') + '</dd>' +
          '</dl></section>');
      }
      const itemMatch = url.pathname.match(/^\/workshops\/([^/]+)$/);
      if (req.method === 'GET' && itemMatch) {
        const item = canonical(itemMatch[1]);
        if (!item) return json(res, 404, { code: 'WORKSHOP_MISSING', message: 'This workshop does not exist.' });
        return form(res, item);
      }
      const commitMatch = url.pathname.match(/^\/api\/workshops\/([^/]+)\/enroll$/);
      if (req.method === 'POST' && commitMatch) {
        const item = canonical(commitMatch[1]);
        if (!item) return json(res, 404, { code: 'WORKSHOP_MISSING', message: 'This workshop does not exist.' });
        const fields = await body(req);
        record('commit-request', { workshopId: item.id, fields, payloadDigest: digest(JSON.stringify(fields)), contentType: req.headers['content-type'] || '',
          ...(req.headers['x-fixture-submit'] ? { clientSubmissionId: req.headers['x-fixture-submit'] } : {}) });
        let validation;
        if (fields.workshopId !== item.id || fields.participantId !== participantId) validation = { code: 'RECORD_REFERENCE_MISMATCH', message: 'The enrollment references do not match this form.' };
        else if (!fields.firstName || !fields.lastName || !fields.email) validation = { code: 'IDENTITY_REQUIRED', field: 'email', message: 'Enter the participant name and email.' };
        else if (fields.locationId !== locations[0].id) validation = { code: 'LOCATION_SELECTION_REQUIRED', field: 'locationId', message: 'Choose Harbor City, Demo Region from the location list.' };
        else if (item.id === permanentTarget) validation = { code: 'LOCATION_UNAVAILABLE', field: 'locationId', message: 'This location cannot be accepted for this workshop.' };
        else if (item.id === validationTarget && fields.contactPreference !== 'email') validation = { code: 'CONTACT_PREFERENCE_REQUIRED', field: 'contactPreference', message: 'Select Email confirmations only, then request enrollment again.' };
        if (validation) {
          record('validation-returned', { workshopId: item.id, validation, payloadDigest: digest(JSON.stringify(fields)) });
          return json(res, 422, { ...validation, receipt: {
            status: 'validation-rejected', outcomeId: String(fields.participantId || '') + ':' + item.id,
            workshopId: String(fields.workshopId || ''), participantId: String(fields.participantId || ''),
            attendeeEmail: String(fields.email || ''), formAction: origin + url.pathname,
            prior: false,
          } });
        }
        const prior = records.find(record => record.workshopId === item.id && record.prior);
        if (prior) return nativeText ? nativeConfirmation(res, item)
          : json(res, 200, textOnly ? { receiptUrl: receipt(prior).receiptUrl, created: false } : { ...receipt(prior), created: false });
        // Deliberately non-idempotent for newly created records: replay after a
        // lost response creates a second effect, which the independent oracle sees.
        await options.beforeCommit?.({ workshopId: item.id, fields: copy(fields) });
        const entry = enroll(item.id, fields, false, origin + url.pathname);
        record('commit-accepted', { workshopId: item.id, confirmationId: entry.confirmationId, payloadDigest: entry.payloadDigest });
        await options.afterCommit?.(receipt(entry));
        if (item.id === lostTarget && !lostReceiptUsed) {
          lostReceiptUsed = true;
          // Deliver headers and an incomplete body before disconnecting. A
          // pre-header socket reset can make Chromium transparently resend the
          // same fetch, which would test transport replay rather than recovery
          // from a lost confirmation after one destination effect.
          record('response-lost', { workshopId: item.id, confirmationId: entry.confirmationId, phase: 'response-body' });
          res.writeHead(201, { 'Content-Type': 'application/json', 'Content-Length': '128', 'Cache-Control': 'no-store', 'Connection': 'close' });
          res.flushHeaders();
          res.write('{"created":true,');
          setTimeout(() => res.destroy(), 25).unref();
          return;
        }
        return nativeText ? nativeConfirmation(res, item)
          : json(res, 201, textOnly ? { receiptUrl: receipt(entry).receiptUrl, created: true } : { ...receipt(entry), created: true });
      }
      return json(res, 404, { code: 'ROUTE_MISSING', message: 'This fixture route does not exist.' });
    } catch (error) {
      record('request-error', { message: error.message });
      if (!res.headersSent && !res.destroyed) json(res, error.status || 400, { code: 'REQUEST_ERROR', message: error.message });
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;

  async function writeArtifacts(directory) {
    await mkdir(directory, { recursive: true });
    const profilePath = path.join(directory, 'demo-profile.json');
    const manifestPath = path.join(directory, 'fixture-manifest.json');
    eventFile = path.join(directory, 'fixture-oracle.json');
    await writeFile(profilePath, JSON.stringify(profile, null, 2) + '\n');
    await writeFile(manifestPath, JSON.stringify({ fixture: true, origin, newCount, existingCount, profilePath, oraclePath: eventFile }, null, 2) + '\n');
    persist();
    return { profilePath, manifestPath, oraclePath: eventFile };
  }
  async function close() {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    persist();
  }
  return {
    origin, profile: copy(profile),
    items: copy(workshops), newItems: copy(newItems), priorItems: copy(priorItems),
    aliases: [...aliases].map(([id, canonicalId]) => ({ id, canonicalId })),
    oracle: snapshot, writeArtifacts, close,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => process.argv.find(argument => argument.startsWith('--' + name + '='))?.slice(name.length + 3);
  const directory = value('directory');
  if (!directory || !path.isAbsolute(directory)) throw new Error('A disposable absolute --directory is required.');
  const receiptStyle = value('receipt-style') || 'attributes';
  if (!['attributes', 'text-only', 'native-text'].includes(receiptStyle)) throw new Error('Choose a supported disposable receipt style.');
  const switchValue = (name, fallback) => {
    const chosen = value(name);
    if (chosen === undefined) return fallback;
    if (!['on', 'off'].includes(chosen)) throw new Error('Use on/off for --' + name + '.');
    return chosen === 'on';
  };
  const durationMs = boundedInteger(value('duration-ms'), 1800000, 1000, 3600000);
  const portal = await createWorkshopPortal({ newCount: value('count') || 4, seed: value('seed'), receiptStyle,
    recoverableValidation: switchValue('validation', true), loseReceipt: switchValue('lost-response', true) });
  const artifacts = await portal.writeArtifacts(directory);
  const startedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + durationMs).toISOString();
  process.stdout.write(JSON.stringify({ fixture: true, origin: portal.origin, pid: process.pid, startedAt, expiresAt, ...artifacts }) + '\n');
  const shutdown = async () => { await portal.close(); process.exit(0); };
  setTimeout(shutdown, durationMs).unref();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
