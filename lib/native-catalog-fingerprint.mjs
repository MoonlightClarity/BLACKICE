import {createHash} from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

// A provider thread keeps the definitions supplied at its creation. Include
// descriptions as well as argument schemas so instruction edits refresh it too.
export function nativeToolCatalogFingerprint(tools) {
  const definitions = [...new Set(tools.filter(Boolean).map(tool => JSON.stringify(canonical(tool))))].sort();
  return createHash('sha256').update(JSON.stringify({version:1,definitions})).digest('hex');
}
