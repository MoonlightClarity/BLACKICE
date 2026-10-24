import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_EMAIL_ATTACHMENTS = 20;
export const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const emailSha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => Object.assign(new Error(message), { code: 'EMAIL_COMPOSE_INVALID', status: 400 });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, max, header = false) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || header && /[\x00-\x1f\x7f]/.test(value)) throw fail(`${label} must be text of at most ${max} characters${header ? ' without header control characters' : ''}.`);
  return value;
};
export function emailRequestId(value, label = 'Message requestId') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw fail(`${label} must contain 1–100 letters, numbers, dashes or underscores.`);
  return value;
}
function address(value) {
  const result = text(value, 'Email address', 254, true).trim();
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(result)) throw fail('Use plain email addresses, without display names or header text.');
  return result;
}
const addresses = value => {
  const input = value === undefined ? [] : typeof value === 'string' ? [value] : value;
  if (!Array.isArray(input) || input.length > 50) throw fail('Use at most 50 addresses in each recipient field.');
  return input.map(address);
};
export function normalizeEmailComposition(input) {
  if (!plain(input) || Object.keys(input).some(key => !['requestId', 'from', 'to', 'cc', 'bcc', 'subject', 'body', 'attachments'].includes(key))) throw fail('Compose accepts requestId, from, to, cc, bcc, subject, body and attachment file paths.');
  const result = { requestId: emailRequestId(input.requestId), from: address(input.from), to: addresses(input.to), cc: addresses(input.cc), bcc: addresses(input.bcc), subject: text(input.subject ?? '', 'Subject', 998, true), body: text(input.body ?? '', 'Body', 256000) };
  if (!result.to.length && !result.cc.length && !result.bcc.length) throw fail('Choose at least one recipient.');
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > MAX_EMAIL_ATTACHMENTS) throw fail(`Choose at most ${MAX_EMAIL_ATTACHMENTS} attachment files.`);
  result.attachments = attachments.map(value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32767 || /[\x00-\x1f\x7f]/.test(value)) throw fail('Each attachment must be an explicit absolute file path.');
    return path.normalize(value);
  });
  return result;
}
const contentTypes = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.zip': 'application/zip', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export async function readEmailAttachments(paths, { signal } = {}) {
  let total = 0;
  const result = [];
  for (const filename of paths) {
    if (signal?.aborted) throw Object.assign(new Error('Email composition cancelled.'), { code: 'ABORT_ERR', status: 409 });
    const handle = await fs.open(filename, 'r').catch(() => { throw fail('An attachment file could not be opened. Check its selected path.'); });
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw fail('Each attachment must be a regular file.');
      if (stat.size > MAX_EMAIL_ATTACHMENT_BYTES - total) throw fail('Selected attachments exceed the 25 MiB total attachment limit.');
      const chunks = []; let length = 0;
      for (;;) {
        if (signal?.aborted) throw Object.assign(new Error('Email composition cancelled.'), { code: 'ABORT_ERR', status: 409 });
        const buffer = Buffer.alloc(Math.min(65536, MAX_EMAIL_ATTACHMENT_BYTES - total - length + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        length += bytesRead;
        if (total + length > MAX_EMAIL_ATTACHMENT_BYTES) throw fail('Selected attachments exceed the 25 MiB total attachment limit.');
        chunks.push(buffer.subarray(0, bytesRead));
      }
      const bytes = Buffer.concat(chunks); total += bytes.length;
      const fileName = path.basename(filename);
      result.push({ sourcePath: filename, fileName, size: bytes.length, sha256: emailSha256(bytes), contentType: contentTypes[path.extname(fileName).toLowerCase()] || 'application/octet-stream', bytes });
    } finally { await handle.close(); }
  }
  return result;
}
const base64 = bytes => Buffer.from(bytes).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
const subject = value => /^[\x20-\x7e]*$/.test(value) && value.length < 70 ? value : Array.from(value).reduce((parts, char) => {
  if (!parts.length || Buffer.byteLength(parts.at(-1) + char, 'utf8') > 42) parts.push(char); else parts[parts.length - 1] += char;
  return parts;
}, []).map(part => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join('\r\n ');
const filenameParameters = filename => {
  // Encode every byte, splitting only between complete RFC 2231 percent triplets.
  const encoded = [...Buffer.from(filename, 'utf8')].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  const segments = encoded.match(/.{1,54}/g) || [''];
  return segments.map((part, index) => `filename*${index}*=${index ? '' : "UTF-8''"}${part}`).join(';\r\n ');
};
export function buildEmailMime(message, attachments = []) {
  const boundary = `blackice_${message.id.replace(/-/g, '')}`;
  const headers = [`From: ${message.from}`, ...(['to', 'cc', 'bcc'].flatMap(key => message[key].length ? [`${key === 'to' ? 'To' : key === 'cc' ? 'Cc' : 'Bcc'}: ${message[key].join(',\r\n ')}`] : [])), `Subject: ${subject(message.subject)}`, `Date: ${new Date(message.createdAt).toUTCString()}`, `Message-ID: ${message.messageId}`, 'MIME-Version: 1.0'];
  const body = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(Buffer.from(message.body, 'utf8')), ''];
  if (!attachments.length) return `${[...headers, ...body].join('\r\n')}\r\n`;
  const parts = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...body];
  for (const attachment of attachments) parts.push(`--${boundary}`, `Content-Type: ${attachment.contentType}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment;\r\n ${filenameParameters(attachment.fileName)}`, '', base64(attachment.bytes), '');
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}
export function newEmailIdentity() {
  const id = randomUUID();
  return { id, messageId: `<${id}@blackice.local>`, createdAt: new Date().toISOString() };
}
