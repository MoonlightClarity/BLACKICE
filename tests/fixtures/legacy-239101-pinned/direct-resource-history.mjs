// Resource continuity is derived from authoritative receipts, never a completion registry.
const browserTools = new Set(['blackice_browser_read', 'blackice_browser_action', 'blackice_browser_upload', 'blackice_connected_browser_action']);
const privateActions = new Set(['fill', 'type', 'select', 'interaction']);
const tracking = /^(utm_(source|medium|campaign|term|content|id)|gclid|fbclid|msclkid)$/i;
export function normalizeResourceUrl(value, { aliases = [] } = {}) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020]/.test(value)) return null;
  let u; try { u = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
  u.hash = '';
  // Preserve query order and repeated values: servers may assign meaning to both.
  const originalParts = u.search.slice(1).split('&');
  const parts = originalParts.filter(part => {
    try { return !tracking.test(decodeURIComponent(part.split('=')[0].replace(/\+/g, ' '))); } catch { return true; }
  });
  if (parts.length !== originalParts.length) u.search = parts.length ? '?' + parts.join('&') : '';
  // Aliases are exact, caller-declared URL pairs. Never infer path equivalence.
  const canonical = u.href;
  for (const pair of aliases) {
    if (!pair || typeof pair.from !== 'string' || typeof pair.to !== 'string') continue;
    if (normalizeResourceUrl(pair.from) === canonical) return normalizeResourceUrl(pair.to);
  }
  return canonical;
}
function observedUrls(result) {
  const urls = [], seen = new Set();
  let budget = 400;
  function visit(value, depth = 0) {
    if (--budget < 0 || depth > 7 || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value.slice(0, 40)) visit(item, depth + 1); return; }
    for (const [key, child] of Object.entries(value).slice(0, 60)) {
      if (['url', 'currentUrl', 'pageUrl'].includes(key) && typeof child === 'string') urls.push(child);
      else if (['page', 'tab', 'snapshot', 'result', 'data', 'content', 'tabs'].includes(key)) visit(child, depth + 1);
      else if (key === 'text' && typeof child === 'string' && child.length <= 65536) {
        try { visit(JSON.parse(child), depth + 1); } catch {}
      }
    }
  }
  for (const part of (result?.contentItems || []).slice(0, 8)) {
    if (part.type !== 'inputText' || typeof part.text !== 'string' || part.text.length > 65536) continue;
    try { visit(JSON.parse(part.text)); } catch {}
  }
  return urls;
}
export function directResourceKeys(record) {
  if (!browserTools.has(record?.tool)) return [];
  // These receipts intentionally omit inputs; do not reconstruct them through indexing.
  if (privateActions.has(record.arguments?.action)) return [];
  const urls = observedUrls(record.result);
  if (record.tool !== 'blackice_connected_browser_action') {
    urls.push(record.arguments?.url, record.arguments?.expectedUrl);
  }
  return [...new Set(urls.map(value => normalizeResourceUrl(value)).filter(Boolean))].slice(0, 12);
}
export function resourceObservation(record, { maxChars = 1600 } = {}) {
  const text = (record.result?.contentItems || []).filter(part => part.type === 'inputText' && typeof part.text === 'string').map(part => part.text).join('\n');
  const limit = Math.max(0, Math.min(4000, maxChars));
  return { jobId: record.id, requestId: record.requestId, tool: record.tool,
    action: record.arguments?.action || null, createdAt: record.createdAt, finishedAt: record.finishedAt,
    requiredScopes: [...record.requiredScopes], status: record.status, dispatched: record.dispatched, outcome: 'unknown',
    source: 'saved-direct-tool-receipt', observation: text.slice(0, limit),
    observationTruncated: text.length > limit, resultAvailable: record.result !== null,
    caution: 'Historical tool observation, not verified external completion or new authorization. Reconcile current state before repeating effects.' };
}
