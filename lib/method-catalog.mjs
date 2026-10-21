import { createHash } from 'node:crypto';

export const METHOD_CATALOG_LIMITS = Object.freeze({ queryChars: 500, pageSize: 20, maxPageSize: 40, maxOffset: 10000, metadataChars: 40000 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'METHOD_CATALOG_ERROR', status = 400) => Object.assign(new Error(message), { code, status });
const text = (value, label, max, required = true) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || required && !value.trim()) throw fail(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
  return value.trim();
};
const identifier = (value, label) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw fail(`${label} must contain 1 to 100 letters, numbers, underscores or hyphens.`); return value; };
const list = (value, label, maximum, length = 1000, convert) => {
  if (!Array.isArray(value) || value.length > maximum) throw fail(`${label} must have at most ${maximum} entries.`);
  const result = value.map(item => convert ? convert(item, label) : text(item, label, length));
  if (new Set(result.map(item => JSON.stringify(item))).size !== result.length) throw fail(`${label} must not contain duplicates.`);
  return result;
};
export const METHOD_CATALOG_FIELDS = Object.freeze(['domain', 'cluster', 'phases', 'outputs', 'aliases', 'tags', 'whenToUse', 'prerequisites', 'avoidWhen', 'effort', 'evidence', 'recommendedNext', 'useBefore', 'useAfter', 'alternatives', 'references']);
const schemaTexts = (maxItems, maxLength) => ({ type: 'array', maxItems, items: { type: 'string', minLength: 1, maxLength } });
const schemaIds = maxItems => ({ type: 'array', maxItems, items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' } });
export const METHOD_CATALOG_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, properties: {
  domain: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' }, cluster: { type: 'string', minLength: 1, maxLength: 160 },
  phases: schemaIds(12), outputs: schemaTexts(20, 100), aliases: schemaTexts(30, 300), tags: schemaTexts(30, 100),
  whenToUse: { type: 'string', minLength: 1, maxLength: 2000 }, prerequisites: schemaTexts(20, 1000), avoidWhen: schemaTexts(20, 1000),
  effort: { type: 'string', enum: ['quick', 'moderate', 'extended'] }, evidence: { type: 'string', enum: ['light', 'moderate', 'substantial'] },
  recommendedNext: schemaIds(20), useBefore: schemaIds(20), useAfter: schemaIds(20), alternatives: schemaIds(20),
  references: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['label', 'href'], properties: { label: { type: 'string', minLength: 1, maxLength: 300 }, href: { type: 'string', minLength: 1, maxLength: 2000, description: 'HTTP(S) source URL without credentials.' } } } }
} });

/** Optional discovery metadata belongs to the authored definition. It never
 * changes execution status or makes a method independently verified. */
export function validateMethodCatalog(value) {
  if (!object(value)) throw fail('Method catalog metadata must be an object.');
  const unknown = Object.keys(value).find(key => !METHOD_CATALOG_FIELDS.includes(key));
  if (unknown) throw fail(`Unsupported method catalog field: ${unknown}.`);
  const result = {};
  if (value.domain !== undefined) result.domain = identifier(value.domain, 'Method domain');
  for (const [key, max] of [['cluster', 160], ['whenToUse', 2000]]) if (value[key] !== undefined) result[key] = text(value[key], `Method ${key}`, max);
  for (const [key, max, chars] of [['phases', 12, 100], ['outputs', 20, 100], ['aliases', 30, 300], ['tags', 30, 100], ['prerequisites', 20, 1000], ['avoidWhen', 20, 1000]]) {
    if (value[key] !== undefined) result[key] = list(value[key], `Method ${key}`, max, chars, key === 'phases' ? identifier : undefined);
  }
  for (const [key, allowed] of [['effort', ['quick', 'moderate', 'extended']], ['evidence', ['light', 'moderate', 'substantial']]]) if (value[key] !== undefined) {
    if (!allowed.includes(value[key])) throw fail(`Method ${key} must be ${allowed.join(', ')}.`);
    result[key] = value[key];
  }
  for (const key of ['recommendedNext', 'useBefore', 'useAfter', 'alternatives']) if (value[key] !== undefined) result[key] = list(value[key], `Method ${key}`, 20, 100, identifier);
  if (value.references !== undefined) result.references = list(value.references, 'Method references', 20, 0, item => {
    if (!object(item) || Object.keys(item).some(key => !['label', 'href'].includes(key))) throw fail('A method reference needs only a label and an HTTP(S) URL.');
    const label = text(item.label, 'Reference label', 300), href = text(item.href, 'Reference URL', 2000);
    let url; try { url = new URL(href); } catch { throw fail('A method reference needs an HTTP(S) URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail('A method reference needs an HTTP(S) URL without credentials.');
    return { label, href };
  });
  if (JSON.stringify(result).length > METHOD_CATALOG_LIMITS.metadataChars) throw fail('Method discovery metadata exceeds its 40,000 character limit.');
  return result;
}

const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stopWords = new Set('a an and are as at be by can could do for from help how i in into is it me my of on or our should some that the their this to use using want we what when which with would you'.split(' '));
const terms = value => [...new Set(normalize(value).split(/\s+/).filter(word => word && !stopWords.has(word)))];
const collate = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const label = value => String(value).replace(/[-_]+/g, ' ').replace(/(^|\s)\p{L}/gu, character => character.toUpperCase());
const domainOf = method => method.catalog?.domain || method.taskType || 'general';
const phasesOf = method => method.catalog?.phases?.length ? method.catalog.phases : [...new Set((method.steps || []).map(step => step.type).filter(Boolean))];
const compact = value => value.length > 300 ? { description: value.slice(0, 299).replace(/[\uD800-\uDBFF]$/, '') + '…', descriptionTruncated: true } : { description: value, descriptionTruncated: false };

export function methodCatalogSummary(method) {
  const metadata = method.catalog || {};
  return {
    id: method.id, name: method.name, ...compact(method.description || ''), taskType: method.taskType,
    revision: method.revision, origin: method.origin, verification: method.verification,
    stepCount: method.steps?.length || 0, ...(method.outline ? { outlineNodeCount: method.outline.steps.length } : {}),
    catalog: { domain: domainOf(method), phases: phasesOf(method), outputs: metadata.outputs || [], ...(metadata.cluster ? { cluster: metadata.cluster } : {}), ...(metadata.effort ? { effort: metadata.effort } : {}), ...(metadata.evidence ? { evidence: metadata.evidence } : {}) },
    ...(method.provenance ? { attributed: true } : {})
  };
}

export function normalizeMethodSearch(value = {}) {
  if (!object(value)) throw fail('Method search options must be an object.');
  const allowed = ['query', 'domain', 'phase', 'output', 'effort', 'evidence', 'limit', 'offset', 'catalogRevision'];
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw fail(`Unsupported method search field: ${unknown}.`);
  const result = { query: value.query === undefined ? '' : text(value.query, 'Method query', METHOD_CATALOG_LIMITS.queryChars, false), limit: value.limit ?? METHOD_CATALOG_LIMITS.pageSize, offset: value.offset ?? 0 };
  for (const key of ['domain', 'phase', 'output', 'effort', 'evidence']) if (value[key] !== undefined && value[key] !== '') result[key] = text(value[key], `Method ${key} filter`, 100);
  if (!Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > METHOD_CATALOG_LIMITS.maxPageSize) throw fail(`Method limit must be 1 to ${METHOD_CATALOG_LIMITS.maxPageSize}.`);
  if (!Number.isSafeInteger(result.offset) || result.offset < 0 || result.offset > METHOD_CATALOG_LIMITS.maxOffset) throw fail(`Method offset must be 0 to ${METHOD_CATALOG_LIMITS.maxOffset}.`);
  if (value.catalogRevision !== undefined) {
    if (typeof value.catalogRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogRevision)) throw fail('Use the exact catalogRevision returned by method search.');
    result.catalogRevision = value.catalogRevision;
  }
  if (result.offset && !result.catalogRevision) throw fail('Continue method search with its catalogRevision to avoid mixing changed pages.', 'METHOD_CATALOG_CONFLICT', 409);
  return result;
}

const searchable = method => ({
  name: normalize(method.name), aliases: (method.catalog?.aliases || []).map(normalize),
  description: normalize([method.description, method.catalog?.whenToUse].filter(Boolean).join(' ')),
  taxonomy: normalize([domainOf(method), method.taskType, method.catalog?.cluster, ...phasesOf(method), ...(method.catalog?.tags || []), ...(method.catalog?.outputs || [])].filter(Boolean).join(' ')),
  inputs: normalize([...(method.inputs || []).flatMap(input => [input.label, input.description]), ...(method.catalog?.prerequisites || [])].join(' ')),
  steps: normalize((method.steps || []).flatMap(step => [step.title, step.instructions, step.result, ...(step.checks || [])]).join(' '))
});

/** Build a deterministic local index. Scores are lexical retrieval, never a
 * claim that a technique is suitable, correct, validated, or executable here. */
export function createMethodSearchIndex(methods) {
  if (!Array.isArray(methods)) throw fail('Method search requires the saved definition list.');
  const ids = new Set();
  for (const method of methods) { if (!object(method) || typeof method.id !== 'string' || ids.has(method.id)) throw fail('Method search requires unique saved method IDs.'); ids.add(method.id); }
  const sorted = [...methods].sort((a, b) => collate(a.id, b.id));
  // Include the actual authored definitions so an updated built-in adapter or
  // metadata change invalidates pagination even when its numeric revision did
  // not change. Custom revisions and deletions are covered by the same digest.
  const catalogRevision = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  const entries = sorted.map(method => ({ method, index: searchable(method) }));
  const facet = getter => {
    const counts = new Map();
    for (const method of sorted) for (const value of new Set(getter(method).filter(Boolean))) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts].map(([id, count]) => ({ id, label: label(id), count })).sort((a, b) => collate(a.label, b.label));
  };
  const facets = { domains: facet(method => [domainOf(method)]), phases: facet(phasesOf), outputs: facet(method => method.catalog?.outputs || []), effort: facet(method => [method.catalog?.effort]), evidence: facet(method => [method.catalog?.evidence]) };
  return Object.freeze({
    catalogRevision,
    search(value = {}) {
      const options = normalizeMethodSearch(value);
      if (options.catalogRevision && options.catalogRevision !== catalogRevision) throw fail('The method catalog changed. Restart this search from offset zero before combining pages.', 'METHOD_CATALOG_CONFLICT', 409);
      const queryTerms = terms(options.query), phrase = normalize(options.query), matches = [];
      for (const entry of entries) {
        const { method, index } = entry, metadata = method.catalog || {};
        if (options.domain && domainOf(method) !== options.domain || options.phase && !phasesOf(method).includes(options.phase) || options.output && !(metadata.outputs || []).includes(options.output) || options.effort && metadata.effort !== options.effort || options.evidence && metadata.evidence !== options.evidence) continue;
        const fields = new Set(); let score = 0, matched = 0;
        for (const term of queryTerms) {
          let best = 0;
          for (const [field, weight] of [['name', 12], ['aliases', 12], ['description', 6], ['taxonomy', 5], ['inputs', 3], ['steps', 1]]) {
            const values = Array.isArray(index[field]) ? index[field] : [index[field]];
            if (values.some(value => value.split(' ').some(word => word === term || term.length >= 4 && word.startsWith(term)))) { fields.add(field); best = Math.max(best, weight); }
          }
          if (best) { matched++; score += best; }
        }
        if (queryTerms.length && !matched) continue;
        // Strong multi-term coverage wins over a stray occurrence in a long
        // procedure. Partial matches remain available with explicit coverage.
        if (queryTerms.length) score += 30 * matched / queryTerms.length;
        if (phrase && index.name === phrase) score += 200;
        else if (phrase && index.aliases.includes(phrase)) score += 180;
        else if (phrase && index.name.includes(phrase)) score += 80;
        matches.push({ method, score, match: { matchedTerms: matched, totalTerms: queryTerms.length, fields: [...fields] } });
      }
      matches.sort((a, b) => b.score - a.score || Number(b.method.origin === 'custom') - Number(a.method.origin === 'custom') || collate(normalize(a.method.name), normalize(b.method.name)) || collate(a.method.id, b.method.id));
      const page = matches.slice(options.offset, options.offset + options.limit), nextOffset = options.offset + page.length < matches.length ? options.offset + page.length : null;
      return {
        catalogRevision, query: options.query, filters: Object.fromEntries(['domain', 'phase', 'output', 'effort', 'evidence'].filter(key => options[key]).map(key => [key, options[key]])),
        totalMethods: methods.length, total: matches.length, offset: options.offset, limit: options.limit, nextOffset,
        methods: page.map(item => ({ ...methodCatalogSummary(item.method), ...(queryTerms.length ? { match: item.match } : {}) })),
        facets: structuredClone(facets),
        note: 'Search is local lexical retrieval, not a suitability or verification score. Descriptions are excerpts; read a matching method by its exact ID and revision for complete prerequisites, steps, outputs, checks and provenance. Empty results mean no lexical match, not that the task is impossible. Adapt, combine relevant phases, or build a new method when the catalog does not fit.'
      };
    }
  });
}
