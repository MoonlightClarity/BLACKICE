export const SVG_PREVIEW_LIMIT = 32 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg', XLINK_NS = 'http://www.w3.org/1999/xlink';
const ELEMENTS = new Set(['svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath', 'use', 'symbol', 'marker', 'pattern', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence']);
const STYLE_PROPERTIES = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'paint-order', 'vector-effect', 'stop-color', 'stop-opacity', 'clip-path', 'clip-rule', 'mask', 'filter', 'display', 'visibility']);
const INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u;
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
function entities(value) {
  let valid = true;
  const result = value.replace(/&([^;]*);/g, (_match, name) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }; if (Object.hasOwn(named, name)) return named[name];
    const numeric = /^#(?:x[0-9a-f]+|[0-9]+)$/i.test(name) ? Number.parseInt(name.slice(name[1]?.toLowerCase() === 'x' ? 2 : 1), name[1]?.toLowerCase() === 'x' ? 16 : 10) : NaN;
    if (!Number.isInteger(numeric) || numeric === 0 || numeric > 0x10ffff || numeric >= 0xd800 && numeric <= 0xdfff || numeric < 32 && ![9, 10, 13].includes(numeric)) { valid = false; return ''; }
    return String.fromCodePoint(numeric);
  });
  if (/&(?!(?:amp|lt|gt|quot|apos|#(?:x[0-9a-f]+|[0-9]+));)/i.test(value)) valid = false;
  return valid && !INVALID.test(result) ? result : null;
}
function localResources(value) {
  if (/[\\@]/.test(value)) return false;
  const stripped = value.replace(/url\(\s*(['"]?)(#[A-Za-z_][A-Za-z0-9_.:-]*)\1\s*\)/gi, '');
  return !/url\s*\(|image-set\s*\(|expression\s*\(/i.test(stripped);
}
function attributes(text) {
  const result = new Map(); let cursor = 0;
  while (cursor < text.length) {
    const whitespace = /^\s+/.exec(text.slice(cursor)); if (!whitespace) return null;
    cursor += whitespace[0].length; if (cursor === text.length) break;
    const name = NAME.exec(text.slice(cursor))?.[0]; if (!name || result.has(name)) return null;
    cursor += name.length; cursor += /^\s*/.exec(text.slice(cursor))[0].length;
    if (text[cursor++] !== '=') return null;
    cursor += /^\s*/.exec(text.slice(cursor))[0].length;
    const quote = text[cursor++]; if (quote !== '"' && quote !== "'") return null;
    const end = text.indexOf(quote, cursor); if (end === -1) return null;
    const raw = text.slice(cursor, end), value = entities(raw); cursor = end + 1;
    if (value === null || raw.includes('<') || /^on/i.test(name) || !localResources(value)) return null;
    if (name.includes(':') && !['xmlns:xlink', 'xlink:href', 'xml:space'].includes(name)) return null;
    if (name === 'xmlns' && value !== SVG_NS || name === 'xmlns:xlink' && value !== XLINK_NS || name === 'xml:space' && !['default', 'preserve'].includes(value)) return null;
    if (['href', 'xlink:href', 'src'].includes(name.toLowerCase()) && !FRAGMENT.test(value)) return null;
    if (name.toLowerCase() === 'style') for (const declaration of value.split(';').filter(part => part.trim())) {
      const colon = declaration.indexOf(':'), property = declaration.slice(0, colon).trim().toLowerCase(), content = declaration.slice(colon + 1).trim();
      if (colon < 0 || !STYLE_PROPERTIES.has(property) || !content || !/^[\p{L}\p{N}\s#%.,()'"+\-:]*$/u.test(content)) return null;
    }
    result.set(name, value);
  }
  return result;
}
/** Complete, static SVG only. Unsupported SVG stays available as escaped source. */
export function safeSvgPreview(source) {
  if (typeof source !== 'string' || source.length > SVG_PREVIEW_LIMIT || new TextEncoder().encode(source).length > SVG_PREVIEW_LIMIT || INVALID.test(source)) return null;
  let text = source.replace(/^\uFEFF/, '').trim();
  text = text.replace(/^<\?xml\s+version=(['"])1\.0\1(?:\s+encoding=(['"])UTF-8\2)?(?:\s+standalone=(['"])(?:yes|no)\3)?\s*\?>\s*/, '');
  const stack = []; let cursor = 0, root = false, count = 0;
  while (cursor < text.length) {
    const opening = text.indexOf('<', cursor), content = text.slice(cursor, opening === -1 ? undefined : opening);
    if (entities(content) === null || !stack.length && content.trim()) return null;
    if (opening === -1) { cursor = text.length; break; }
    if (text.startsWith('<!--', opening)) { const end = text.indexOf('-->', opening + 4); if (end === -1 || text.slice(opening + 4, end).includes('--')) return null; cursor = end + 3; continue; }
    if (text[opening + 1] === '!' || text[opening + 1] === '?') return null;
    let end = opening + 1, quote = null;
    for (; end < text.length; end++) { const char = text[end]; if (quote) { if (char === quote) quote = null; } else if (char === '"' || char === "'") quote = char; else if (char === '>') break; else if (char === '<') return null; }
    if (end === text.length || quote) return null;
    const tag = text.slice(opening + 1, end), closing = tag.startsWith('/'), selfClosing = tag.endsWith('/');
    const body = closing ? tag.slice(1) : selfClosing ? tag.slice(0, -1) : tag, name = NAME.exec(body)?.[0];
    if (!name || !ELEMENTS.has(name) || ++count > 2048) return null;
    if (closing) { if (selfClosing || body.slice(name.length).trim() || stack.pop() !== name) return null; }
    else {
      const values = attributes(body.slice(name.length)); if (!values) return null;
      if (!stack.length) { if (root || name !== 'svg' || values.get('xmlns') !== SVG_NS) return null; root = true; }
      if (!selfClosing) { stack.push(name); if (stack.length > 64) return null; }
    }
    cursor = end + 1;
  }
  if (!root || stack.length) return null;
  // A browser parser is an additional well-formedness check, never an HTML
  // rendering surface. Resource-bearing constructs have already been rejected.
  if (typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (document.querySelector('parsererror') || document.documentElement?.localName !== 'svg' || document.documentElement?.namespaceURI !== SVG_NS) return null;
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}
