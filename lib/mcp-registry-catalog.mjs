const endpoint = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const plain = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const https = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
export async function searchMCPRegistry({ query = '', cursor = '', fetchImpl = globalThis.fetch } = {}) {
  if (typeof query !== 'string' || query.length > 256 || typeof cursor !== 'string' || cursor.length > 4096) throw Object.assign(Error('Use a shorter catalog search.'), {status:400});
  const url = new URL(endpoint); url.searchParams.set('limit', '20'); url.searchParams.set('version', 'latest');
  if (query.trim()) url.searchParams.set('search', query.trim()); if (cursor) url.searchParams.set('cursor', cursor);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept:'application/json' } });
  if (!response.ok) throw Object.assign(Error('The MCP Registry is unavailable. Try again later.'), {status:502});
  let raw = ''; const reader = response.body.getReader(); const decoder = new TextDecoder();
  try { while (true) { const part = await reader.read(); if (part.done) break; raw += decoder.decode(part.value, {stream:true}); if (raw.length > 2000000) throw Error('Registry response too large.'); } } finally { await reader.cancel().catch(()=>{}); }
  const value = JSON.parse(raw); if (!Array.isArray(value.servers)) throw Error('Invalid registry response.');
  return { source: endpoint, nextCursor: plain(value.metadata?.nextCursor,4096), servers: value.servers.slice(0,20).map(row => {
    const s = row?.server || {}; return { name:plain(s.name,300), title:plain(s.title,300), description:plain(s.description,1500), version:plain(s.version,100), website:https(s.websiteUrl) || https(s.repository?.url),
      endpoints: (Array.isArray(s.remotes)?s.remotes:[]).filter(r=>r?.type==='streamable-http').map(r=>https(r.url)).filter(Boolean).slice(0,5),
      packages:(Array.isArray(s.packages)?s.packages:[]).slice(0,5).map(p=>({type:plain(p?.registryType,40),name:plain(p?.identifier,300)})) };
  }) };
}
