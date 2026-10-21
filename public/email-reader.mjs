const text = (value, limit = 200000) => typeof value === 'string' ? value.slice(0, limit) : '';
const line = (value, limit = 1000) => text(value, limit).replace(/[\r\n\x00]/g, ' ').trim();
const addressText = value => {
  if (Array.isArray(value)) return value.slice(0, 50).map(addressText).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    const email = line(value.email || value.address, 254), name = line(value.name, 300);
    return name && email ? `${name} <${email}>` : name || email;
  }
  return line(value, 2000);
};

/** Only plain text and attachment descriptions reach the reader. No HTML or URLs are executed. */
export function emailMessagePresentation(value) {
  const content = value && typeof value === 'object' && value.content && typeof value.content === 'object' && !Array.isArray(value.content) ? value.content : null;
  const raw = typeof value === 'string' ? value : text(value?.message, 2097152);
  return {
    subject: line(content?.subject, 998) || 'No subject',
    from: addressText(content?.from), to: addressText(content?.to), cc: addressText(content?.cc),
    date: line(content?.date, 200),
    text: content ? text(content.text) : text(value?.body || value?.text || raw),
    decoded: Boolean(content), raw,
    warnings: Array.isArray(content?.warnings) ? content.warnings.filter(item => typeof item === 'string').slice(0, 8).map(item => line(item, 500)) : [],
    truncated: content?.truncated === true,
    attachments: Array.isArray(content?.attachments) ? content.attachments.slice(0, 100).map(item => ({
      filename: line(item?.filename, 512) || 'Unnamed attachment',
      contentType: line(item?.contentType, 128),
      size: Number.isSafeInteger(item?.size) && item.size >= 0 ? item.size : null,
    })) : [],
  };
}

/** Creates editable local text only. A sender-supplied address never authorizes delivery. */
export function emailReplyDraft(value) {
  const content = value?.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const preferred = Array.isArray(content.replyTo) && content.replyTo.length || typeof content.replyTo === 'string' && content.replyTo.trim() ? content.replyTo : content.from;
  const addresses = Array.isArray(preferred) ? preferred : typeof preferred === 'string' ? [preferred] : preferred ? [preferred] : [];
  const to = [...new Set(addresses.map(item => typeof item === 'string' ? item : item?.email || item?.address)
    .filter(item => typeof item === 'string' && item.length <= 254 && /^[^\s<>@,;:]+@[^\s<>@,;:]+\.[^\s<>@,;:]+$/.test(item)))].slice(0, 50);
  if (!to.length) return null;
  const view = emailMessagePresentation(value), subject = /^re\s*:/i.test(view.subject) ? view.subject : `Re: ${view.subject}`;
  const attribution = [view.date && `On ${view.date}`, view.from].filter(Boolean).join(', ');
  const quoted = view.text.split('\n').map(part => `> ${part}`).join('\n');
  const body = `\n\n${attribution || 'The sender'} wrote:\n${quoted}`;
  return { to: to.join(', '), subject: subject.slice(0, 998), body: body.length > 200000 ? body.slice(0, 199950) + '\n> [Quoted message shortened]' : body };
}
