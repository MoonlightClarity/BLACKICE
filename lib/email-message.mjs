// Bounded MIME preview. It never executes HTML, resolves URLs, or writes attachments.
const MAX_HEADER = 65536, MAX_TEXT = 200000, MAX_PARTS = 128, MAX_DEPTH = 16;
const cleanLine = value => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
const namedEntities = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bull: '•', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™' });
function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]{1,8}|#\d{1,10}|[a-z]{2,12});/gi, (whole, entity) => {
    if (entity[0] !== '#') return Object.hasOwn(namedEntities, entity.toLowerCase()) ? namedEntities[entity.toLowerCase()] : whole;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}
function decodeBytes(bytes, charset, warn) {
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
  catch { warn('An unsupported character set was displayed using UTF-8.'); return bytes.toString('utf8'); }
}
function quotedPrintable(value) {
  const input = value.replace(/=\r?\n/g, ''), bytes = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '=' && /^[\da-f]{2}$/i.test(input.slice(i + 1, i + 3))) { bytes.push(parseInt(input.slice(i + 1, i + 3), 16)); i += 2; }
    else { const code = input.codePointAt(i); bytes.push(...Buffer.from(String.fromCodePoint(code), 'utf8')); if (code > 0xffff) i++; }
  }
  return Buffer.from(bytes);
}
function base64Bytes(value, warn) {
  const input = value.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 === 1) { warn('A malformed base64 part could not be decoded.'); return null; }
  return Buffer.from(input, 'base64');
}
function decodeHeader(value, warn) {
  // Adjacent encoded words are one logical header value (RFC 2047).
  return cleanLine(String(value || '').replace(/(=\?[^?\s]+\?[bq]\?[^?]*\?=)[ \t]+(?==\?[^?\s]+\?[bq]\?)/gi, '$1')
    .replace(/=\?([^?\s]{1,80})\?([bq])\?([^?]{0,8192})\?=/gi, (whole, charset, encoding, content) => {
      const bytes = encoding.toLowerCase() === 'b' ? base64Bytes(content, warn) : quotedPrintable(content.replace(/_/g, ' '));
      return bytes ? decodeBytes(bytes, charset, warn) : whole;
    }));
}
function splitMessage(raw, warn) {
  const separator = /\r?\n\r?\n/.exec(raw);
  if (!separator) { warn('The message has no complete header/body separator.'); return { headers: new Map(), body: raw }; }
  const headerText = raw.slice(0, separator.index), headers = new Map();
  if (headerText.length > MAX_HEADER) { warn('Oversized message headers were shortened.'); return { headers, body: raw.slice(separator.index + separator[0].length), limited: true }; }
  for (const line of headerText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const match = /^([!#$%&'*+\-.^_`|~\da-z]+):[ \t]*(.*)$/i.exec(line);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (!headers.has(name)) headers.set(name, match[2]);
    else if (['to', 'cc', 'from', 'reply-to'].includes(name)) headers.set(name, `${headers.get(name)}, ${match[2]}`);
  }
  return { headers, body: raw.slice(separator.index + separator[0].length) };
}
function mimeType(value, defaultType = 'text/plain') {
  const input = String(value || defaultType), parts = []; let quoted = false, escaped = false, start = 0;
  for (let i = 0; i < input.length; i++) {
    if (escaped) { escaped = false; continue; }
    if (input[i] === '\\' && quoted) { escaped = true; continue; }
    if (input[i] === '"') quoted = !quoted;
    if (input[i] === ';' && !quoted) { parts.push(input.slice(start, i)); start = i + 1; }
  }
  parts.push(input.slice(start));
  const type = parts.shift().trim().toLowerCase(), parameters = new Map();
  for (const part of parts) {
    const index = part.indexOf('='); if (index < 1) continue;
    const key = part.slice(0, index).trim().toLowerCase(); let val = part.slice(index + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!parameters.has(key)) parameters.set(key, val);
  }
  return { type, parameters };
}
function filenameParameter(parameters, key, warn) {
  let encoded = parameters.get(`${key}*`), fallback = parameters.get(key);
  if (encoded === undefined && (parameters.has(`${key}*0*`) || parameters.has(`${key}*0`))) {
    let value = '', isEncoded = false;
    for (let i = 0; i < 32; i++) {
      const starred = parameters.get(`${key}*${i}*`), plain = parameters.get(`${key}*${i}`);
      if (starred === undefined && plain === undefined) break;
      isEncoded ||= starred !== undefined; value += starred ?? plain;
    }
    if (isEncoded) encoded = value; else fallback = value;
  }
  if (encoded !== undefined) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(encoded);
    if (match) {
      const bytes = []; for (let i = 0; i < match[2].length; i++) {
        if (match[2][i] === '%' && /^[\da-f]{2}$/i.test(match[2].slice(i + 1, i + 3))) { bytes.push(parseInt(match[2].slice(i + 1, i + 3), 16)); i += 2; }
        else bytes.push(...Buffer.from(match[2][i]));
      }
      return cleanLine(decodeBytes(Buffer.from(bytes), match[1], warn)).slice(0, 512);
    }
    warn('An attachment filename used an unsupported parameter encoding.');
  }
  return decodeHeader(fallback || '', warn).slice(0, 512);
}
function addresses(value, warn) {
  const input = String(value || ''), entries = []; let quoted = false, escaped = false, angle = 0, comment = 0, start = 0;
  for (let i = 0; i <= input.length; i++) {
    const char = input[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && (quoted || comment)) { escaped = true; continue; }
    if (char === '"' && !comment) quoted = !quoted;
    if (!quoted) {
      if (char === '(') comment++;
      else if (char === ')' && comment) comment--;
      else if (!comment && char === '<') angle++;
      else if (!comment && char === '>') angle = Math.max(0, angle - 1);
    }
    if (i === input.length || !quoted && !angle && !comment && (char === ',' || char === ';')) { entries.push(input.slice(start, i)); start = i + 1; if (entries.length >= 50) break; }
  }
  return entries.flatMap(part => {
    const pair = /^(.*?)<([^<>]+)>\s*(?:\([^)]*\))?$/.exec(part.trim());
    let email, name;
    if (pair) { email = cleanLine(pair[2]); name = decodeHeader(pair[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1'), warn); }
    else { email = cleanLine(part.replace(/\([^)]*\)/g, '').replace(/^.*?:\s*(?=[^:]*@)/, '')); name = ''; }
    if (!email || email.length > 254 || !/^[^\s<>(),;:@]+@[^\s<>(),;:@]+$/.test(email)) return [];
    return [{ name: name || null, email }];
  });
}
function htmlText(html) {
  const hidden = new Set(['script', 'style', 'head', 'title', 'template', 'svg', 'math', 'iframe', 'object', 'noscript']);
  const blocks = new Set(['p', 'div', 'br', 'hr', 'li', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol']);
  let output = '', suppressed = null, cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) { if (!suppressed) output += html.slice(cursor); break; }
    if (!suppressed) output += html.slice(cursor, start);
    if (html.startsWith('<!--', start)) { const end = html.indexOf('-->', start + 4); if (end < 0) break; cursor = end + 3; continue; }
    // A quoted attribute may contain >; it is still part of the tag, not body text.
    let end = start + 1, quote = null;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === html.length) end = -1;
    if (end < 0) { if (!suppressed) output += html.slice(start); break; }
    const value = html.slice(start, end + 1); cursor = end + 1;
    const tag = /^<\s*(\/?)\s*([a-z][\da-z:-]*)\b[\s\S]*>$/i.exec(value);
    if (tag) {
      const name = tag[2].toLowerCase(), closing = Boolean(tag[1]);
      if (suppressed) { if (closing && name === suppressed) suppressed = null; continue; }
      if (!closing && hidden.has(name)) { suppressed = name; continue; }
      if (blocks.has(name)) output += '\n'; else if (name === 'td' || name === 'th') output += '\t';
      continue;
    }
    if (!suppressed) output += value;
  }
  return decodeEntities(output).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function multipart(body, boundary, warn) {
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) { warn('A multipart message has an invalid or missing boundary.'); return []; }
  const opening = `--${boundary}`, closing = `${opening}--`, parts = []; let current = null, ended = false;
  for (const line of body.split(/\r?\n/)) {
    const marker = line.replace(/[ \t]+$/, '');
    if (marker === opening || marker === closing) {
      if (current) parts.push(current.join('\r\n'));
      current = marker === closing ? null : [];
      if (marker === closing) { ended = true; break; }
      if (parts.length >= MAX_PARTS) { warn('The message contains more MIME parts than this preview can display.'); break; }
    } else if (current) current.push(line);
  }
  if (current?.length) parts.push(current.join('\r\n'));
  if (!ended) warn('The multipart message has no closing boundary.');
  return parts;
}

/** Decode a bounded RFC 5322 message into plain display text, retaining raw text at the caller. */
export function parseEmailMessage(raw) {
  const warnings = [], seenWarnings = new Set(); let truncated = false, count = 0;
  const warn = message => { if (!seenWarnings.has(message) && warnings.length < 12) { warnings.push(message); seenWarnings.add(message); } };
  if (typeof raw !== 'string') raw = '';
  if (raw.length > 2097152) { raw = raw.slice(0, 2097152); truncated = true; warn('The message exceeded the preview input limit.'); }
  const root = splitMessage(raw, warn), attachments = [];
  function decodePart(part, depth = 0) {
    if (part.limited) truncated = true;
    if (++count > MAX_PARTS || depth > MAX_DEPTH) { truncated = true; warn('The message contains more MIME nesting or parts than this preview can display.'); return { text: '', html: false }; }
    const type = mimeType(part.headers.get('content-type'));
    const disposition = mimeType(part.headers.get('content-disposition'), 'inline');
    const filename = filenameParameter(disposition.parameters, 'filename', warn) || filenameParameter(type.parameters, 'name', warn);
    const isAttachment = disposition.type === 'attachment' || Boolean(filename) || !type.type.startsWith('multipart/') && !['text/plain', 'text/html'].includes(type.type);
    const encoding = (part.headers.get('content-transfer-encoding') || '').trim().toLowerCase();
    const transferEncoded = encoding === 'base64' || encoding === 'quoted-printable';
    let bytes;
    if (encoding === 'base64') bytes = base64Bytes(part.body, warn);
    else if (encoding === 'quoted-printable') bytes = quotedPrintable(part.body);
    else if (['', '7bit', '8bit', 'binary'].includes(encoding)) bytes = Buffer.from(part.body, 'utf8');
    else { warn('A MIME part uses an unsupported transfer encoding.'); bytes = null; }
    if (isAttachment) {
      if (attachments.length < 100) attachments.push({ filename: filename || '', contentType: type.type, size: bytes?.length ?? null });
      else { truncated = true; warn('Additional attachments were omitted from this preview.'); }
      return { text: '', html: false };
    }
    if (type.type.startsWith('multipart/')) {
      if (!bytes) return { text: '', html: false };
      // MIME multipart boundaries describe the transfer-decoded entity.
      const entities = multipart(transferEncoded ? bytes.toString('utf8') : part.body, type.parameters.get('boundary'), warn).map(value => splitMessage(value, warn));
      const parts = entities.map(value => decodePart(value, depth + 1));
      if (type.type === 'multipart/alternative') return parts.find(value => !value.html && value.text.trim()) || parts.find(value => value.text.trim()) || { text: '', html: false };
      if (type.type === 'multipart/related') {
        // Other parts are resources of this body, not additional message text.
        const start = type.parameters.get('start');
        const index = start === undefined ? 0 : entities.findIndex(value => value.headers.get('content-id')?.trim() === start.trim());
        if (index < 0) warn('The multipart message references a missing body part.');
        return parts[index] || { text: '', html: false };
      }
      return { text: parts.map(value => value.text).filter(Boolean).join('\n\n'), html: parts.some(value => value.html && value.text) };
    }
    if (!bytes) return { text: '', html: false };
    // Unencoded UTF-8 text already survived the CLI's JSON transport; encoded bytes
    // still use their declared charset, including Windows-1252 and ISO-8859-1.
    const charset = type.parameters.get('charset');
    if (!transferEncoded && charset) {
      try { new TextDecoder(charset); }
      catch { warn('An unsupported character set was displayed using UTF-8.'); }
    }
    const decoded = transferEncoded ? decodeBytes(bytes, charset, warn) : part.body;
    return { text: type.type === 'text/html' ? htmlText(decoded) : decoded, html: type.type === 'text/html' };
  }
  const body = decodePart(root);
  if (body.html) warn('HTML was converted to plain text; remote images and links were not loaded.');
  let text = body.text.replace(/\r\n?/g, '\n').replace(/\x00/g, '');
  if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; warn('The readable message was shortened; raw source remains available.'); }
  return {
    subject: decodeHeader(root.headers.get('subject'), warn).slice(0, 998),
    from: addresses(root.headers.get('from'), warn), to: addresses(root.headers.get('to'), warn), cc: addresses(root.headers.get('cc'), warn), replyTo: addresses(root.headers.get('reply-to'), warn),
    date: decodeHeader(root.headers.get('date'), warn).slice(0, 200), text, attachments, warnings, truncated,
  };
}
