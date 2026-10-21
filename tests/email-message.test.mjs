import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmailMessage } from '../lib/email-message.mjs';

const message = (headers, body) => [...headers, '', body].join('\r\n');
const multipart = (type, parts, boundary = 'blackice-fixture') => message([`Content-Type: multipart/${type}; boundary="${boundary}"`], parts.map(part => `--${boundary}\r\n${part}\r\n`).join('') + `--${boundary}--\r\n`);

test('plain reader decodes folded headers and address names while retaining body line breaks', () => {
  const result = parseEmailMessage(message(['Subject: =?UTF-8?B?UsOpc3Vtw6k=?=', ' =?UTF-8?Q?_=E2=9C=93?=', 'From: "Doe, Iris" <iris@example.invalid>', 'To: Alice <alice@example.invalid>, bob@example.invalid', 'Cc: Team: one@example.invalid, two@example.invalid;', 'Reply-To: =?UTF-8?Q?Support_Team?= <reply@example.invalid>', 'Date: Tue, 01 Oct 2024 12:00:00 +0000'], 'First line\r\nSecond line — intact.'));
  assert.equal(result.subject, 'Résumé ✓');
  assert.deepEqual(result.from, [{ name: 'Doe, Iris', email: 'iris@example.invalid' }]);
  assert.equal(result.to.length, 2); assert.equal(result.cc.length, 2);
  assert.deepEqual(result.replyTo, [{ name: 'Support Team', email: 'reply@example.invalid' }]);
  assert.equal(result.text, 'First line\nSecond line — intact.');
  assert.equal(result.truncated, false); assert.deepEqual(result.warnings, []);
});

test('base64 and quoted printable bodies honor declared encodings and soft line breaks', () => {
  const base64 = parseEmailMessage(message(['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'], Buffer.from('Résumé — preserved.').toString('base64')));
  assert.equal(base64.text, 'Résumé — preserved.');
  const quoted = parseEmailMessage(message(['Content-Type: text/plain; charset=ISO-8859-1', 'Content-Transfer-Encoding: quoted-printable'], 'caf=E9 =\r\ncontinuation=0Anew line'));
  assert.equal(quoted.text, 'café continuation\nnew line');
});

test('unencoded message text already carried by JSON remains Unicode despite a legacy charset declaration', () => {
  for (const encoding of ['', '7bit', '8bit', 'binary']) {
    const headers = ['Content-Type: text/plain; charset=ISO-8859-1', ...(encoding ? [`Content-Transfer-Encoding: ${encoding}`] : [])];
    const result = parseEmailMessage(message(headers, 'A readable café — already Unicode.'));
    assert.equal(result.text, 'A readable café — already Unicode.', encoding || 'absent transfer encoding');
    assert.deepEqual(result.warnings, []);
  }
});

test('multipart alternatives prefer plain text and avoid duplicate HTML versions', () => {
  const result = parseEmailMessage(multipart('alternative', [message(['Content-Type: text/html'], '<p>HTML version</p>'), message(['Content-Type: text/plain'], 'Plain version')]));
  assert.equal(result.text, 'Plain version'); assert.deepEqual(result.warnings, []);
});

test('HTML-only previews strip active elements, decode entities, and never retain URLs from attributes', () => {
  const result = parseEmailMessage(message(['Content-Type: text/html; charset=UTF-8'], '<html><head><style>secret-style</style></head><body><p>Hello &amp; welcome &#x1F642;.</p><script>privateScript()</script><svg><text>secret-vector</text></svg><a href="https://private.invalid/tracker">Visible label</a><img src="https://private.invalid/pixel"><div>Second&nbsp;line</div></body></html>'));
  assert.match(result.text, /Hello & welcome 🙂\./); assert.match(result.text, /Visible label/); assert.match(result.text, /Second line/);
  assert.doesNotMatch(result.text, /secret|privateScript|https:|<script|<img/);
  assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /HTML was converted/);
});

test('HTML conversion consumes quoted greater-than signs without leaking attribute text into the body', () => {
  const result = parseEmailMessage(message(['Content-Type: text/html'], '<p title="1 > 0">Readable body.</p><a title=\'2 > 1\' href="https://private.invalid/secret>value">Visible label</a><div data-value="< >">Last line.</div>'));
  assert.equal(result.text, 'Readable body.\nVisible label\nLast line.');
  assert.doesNotMatch(result.text, /private|secret|value|[<>]/);
});

test('HTML conversion tolerates malformed, unknown entities without inherited property lookup', () => {
  const result = parseEmailMessage(message(['Content-Type: text/html'], '<p>&constructor; &madeup; &#0; &#x110000;</p><script>unclosed active text'));
  assert.equal(result.text, '&constructor; &madeup; � �');
});

test('mixed MIME shows readable body and attachment metadata only, with RFC2231 names', () => {
  const result = parseEmailMessage(multipart('mixed', [message(['Content-Type: text/plain'], 'The body.'), message(['Content-Type: application/pdf', "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", 'Content-Transfer-Encoding: base64'], Buffer.from('PDF fixture bytes').toString('base64')), message(['Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"'], 'Attachment-only private text') ]));
  assert.equal(result.text, 'The body.');
  assert.deepEqual(result.attachments, [{ filename: 'résumé.pdf', contentType: 'application/pdf', size: 17 }, { filename: 'notes.txt', contentType: 'text/plain', size: 28 }]);
  assert.doesNotMatch(JSON.stringify(result), /Attachment-only private/);
});

test('continued encoded attachment filename and semicolons inside quoted values survive', () => {
  const result = parseEmailMessage(multipart('mixed', [message(['Content-Type: application/octet-stream', "Content-Disposition: attachment; filename*0*=UTF-8''long%20; filename*1*=r%C3%A9sum%C3%A9.bin", 'Content-Transfer-Encoding: base64'], 'AQID'), message(['Content-Type: image/png', 'Content-Disposition: inline; filename="figure; 1.png"', 'Content-Transfer-Encoding: base64'], 'AAAA')]));
  assert.deepEqual(result.attachments.map(item => item.filename), ['long résumé.bin', 'figure; 1.png']);
  assert.equal(result.attachments[0].size, 3); assert.equal(result.text, '');
});

test('nested mixed/alternative bodies and inline images preserve useful display text', () => {
  const result = parseEmailMessage(multipart('mixed', [multipart('alternative', [message(['Content-Type: text/plain'], 'Preferred body'), message(['Content-Type: text/html'], '<p>HTML copy</p>')], 'alternative-inner'), message(['Content-Type: image/png', 'Content-Transfer-Encoding: base64'], 'AAAA')], 'mixed-outer'));
  assert.equal(result.text, 'Preferred body'); assert.equal(result.attachments.length, 1); assert.equal(result.attachments[0].contentType, 'image/png');
});

test('related MIME selects the declared root body without mixing in auxiliary text resources', () => {
  const raw = multipart('related', [
    message(['Content-Type: text/plain', 'Content-ID: <resource>'], 'Auxiliary resource text must not become a reply quote.'),
    message(['Content-Type: text/html', 'Content-ID: <body-root>'], '<p>Actual readable message.</p>'),
    message(['Content-Type: image/png', 'Content-ID: <image>', 'Content-Transfer-Encoding: base64'], 'AAAA'),
  ]).replace('boundary="blackice-fixture"', 'boundary="blackice-fixture"; start="<body-root>"');
  const result = parseEmailMessage(raw);
  assert.equal(result.text, 'Actual readable message.');
  assert.equal(result.attachments.length, 1); assert.equal(result.attachments[0].contentType, 'image/png');
  assert.doesNotMatch(JSON.stringify(result), /Auxiliary resource/);
});

test('related MIME defaults only to its first part and discloses an explicitly missing root', () => {
  const raw = multipart('related', [message(['Content-Type: text/plain'], 'First body.'), message(['Content-Type: text/plain', 'Content-ID: <resource>'], 'Resource text.')]);
  assert.equal(parseEmailMessage(raw).text, 'First body.');
  const missing = parseEmailMessage(raw.replace('boundary="blackice-fixture"', 'boundary="blackice-fixture"; start="<missing>"'));
  assert.equal(missing.text, ''); assert.match(missing.warnings.join(' '), /missing body part/);
});

test('malformed base64 and unknown charset yield bounded honest warnings', () => {
  const broken = parseEmailMessage(message(['Content-Type: text/plain', 'Content-Transfer-Encoding: base64'], 'not!!base64'));
  assert.equal(broken.text, ''); assert.match(broken.warnings.join(' '), /malformed base64/);
  const charset = parseEmailMessage(message(['Content-Type: text/plain; charset=unsupported-blackice'], 'Plain fallback'));
  assert.equal(charset.text, 'Plain fallback'); assert.match(charset.warnings.join(' '), /unsupported character set/);
});

test('unknown transfer encoding is not displayed as if decoded successfully', () => {
  const result = parseEmailMessage(message(['Content-Transfer-Encoding: x-unknown'], 'unknown-encoded-data'));
  assert.equal(result.text, ''); assert.match(result.warnings.join(' '), /unsupported transfer encoding/);
});

test('failed transfer decoding never falls back to parsing an undecoded multipart body', () => {
  for (const encoding of ['base64', 'x-unknown']) {
    const raw = multipart('mixed', [message(['Content-Type: text/plain'], 'Undecoded child must not be displayed.')]);
    const result = parseEmailMessage(raw.replace('\r\n\r\n', `\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`));
    assert.equal(result.text, '', encoding); assert.deepEqual(result.attachments, []);
    assert.match(result.warnings.join(' '), /malformed base64|unsupported transfer encoding/);
  }
});

test('message without complete MIME framing remains available with a warning', () => {
  const result = parseEmailMessage('Malformed message text without a header separator');
  assert.match(result.text, /Malformed message/); assert.match(result.warnings.join(' '), /separator/);
});

test('large previews and excessive nested parts are explicitly shortened', () => {
  const large = parseEmailMessage(message(['Subject: Large'], 'x'.repeat(250000)));
  assert.equal(large.text.length, 200000); assert.equal(large.truncated, true); assert.match(large.warnings.join(' '), /shortened/);
  let nested = message(['Content-Type: text/plain'], 'Deep body');
  for (let i = 0; i < 20; i++) nested = multipart('mixed', [nested], `boundary-${i}`);
  const result = parseEmailMessage(nested); assert.equal(result.truncated, true); assert.match(result.warnings.join(' '), /nesting/);
});

test('malformed HTML delimiter runs and oversized headers remain bounded and disclose limits', () => {
  const malformed = parseEmailMessage(message(['Content-Type: text/html'], '<'.repeat(250000)));
  assert.equal(malformed.text.length, 200000); assert.equal(malformed.truncated, true);
  const headers = parseEmailMessage(message(['Subject: ' + 'x'.repeat(70000)], 'Readable body'));
  assert.equal(headers.subject, ''); assert.equal(headers.text, 'Readable body'); assert.equal(headers.truncated, true);
});

test('header injection characters in decoded sender data cannot create new recipient entries', () => {
  const result = parseEmailMessage(message(['From: =?UTF-8?Q?Name=0D=0ABcc:_other=40example.invalid?= <real@example.invalid>', 'Reply-To: bad-address, good@example.invalid'], 'Body'));
  assert.equal(result.from.length, 1); assert.equal(result.from[0].email, 'real@example.invalid'); assert.doesNotMatch(result.from[0].name, /[\r\n]/);
  assert.deepEqual(result.replyTo, [{ name: null, email: 'good@example.invalid' }]);
});
