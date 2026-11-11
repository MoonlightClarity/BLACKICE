import { planningSchemaIssues } from './planning-schema-diagnostics.mjs';
import { PLANNING_BROWSER_LIMITS } from '../public/planning-browser-model.mjs';

const DEFAULT_ISSUES = 128, DEFAULT_CHARS = 24000, MAX_DEPTH = 64, MAX_NODES = 20000;
const LIMITATION = 'This diagnostic inventory reached a bound or could not inspect every shape. The complete output schema and original validation diagnostic still apply; repair the entire response.';
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const unfence = output => String(output).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
const displayKey = (path, key) => /^[A-Za-z][A-Za-z0-9]*$/.test(key) ? path + '.' + key : path + '[' + JSON.stringify(key) + ']';
const matches = (value, rule) => !rule.type || (Array.isArray(rule.type) ? rule.type : [rule.type])
  .some(type => type === typeOf(value) || type === 'integer' && Number.isSafeInteger(value));
const discriminatorMatches = (value, rule) => {
  if (own(rule, 'const') && value !== rule.const || rule.enum && !rule.enum.includes(value)) return false;
  if (typeOf(value) !== 'object') return true;
  return Object.entries(rule.properties || {}).every(([key, child]) => !own(value, key) ||
    !own(child, 'const') && !child.enum || discriminatorMatches(value[key], child));
};
function branch(value, rule) {
  if (!rule?.anyOf) return rule;
  const shaped = rule.anyOf.filter(candidate => matches(value, candidate));
  const discriminated = shaped.filter(candidate => discriminatorMatches(value, candidate));
  const candidates = discriminated.length ? discriminated : shaped;
  if (candidates.length === 1) return branch(value, candidates[0]);
  if (!candidates.length) return null;
  // Match the diagnostic walker, not an acceptance decision. Ambiguous shape
  // alternatives remain described by the full output schema.
  const ranked = candidates.map(candidate => ({ candidate, issues: planningSchemaIssues(value, candidate, { maxIssues: DEFAULT_ISSUES + 1 }).length }));
  const best = Math.min(...ranked.map(item => item.issues));
  const selected = ranked.filter(item => item.issues === best);
  return selected.length === 1 ? branch(value, selected[0].candidate) : null;
}
function atPath(value, schema, path) {
  if (!/^response(?:\.[A-Za-z][A-Za-z0-9]*|\[\d+\])*$/.test(path)) return null;
  const parts = [...path.matchAll(/\.([A-Za-z][A-Za-z0-9]*)|\[(\d+)\]/g)].map(match => match[1] ?? Number(match[2]));
  let rule = schema, item = value;
  for (const part of parts) {
    rule = branch(item, rule);
    if (!rule) return null;
    rule = typeof part === 'number' ? rule.items : rule.properties?.[part];
    if (!rule) return null;
    item = own(item, part) ? item[part] : undefined;
  }
  return { value: item, rule: branch(item, rule) || rule };
}
function compactContract(rule) {
  const result = {};
  for (const key of ['type', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'])
    if (own(rule, key)) result[key] = rule[key];
  if (typeof rule.pattern === 'string') result.pattern = rule.pattern.slice(0, 300);
  if (Array.isArray(rule.enum)) {
    const values = rule.enum.filter(value => ['string', 'number', 'boolean'].includes(typeof value) || value === null);
    if (values.length <= 20 && JSON.stringify(values).length <= 2400) result.enum = values;
    else result.enumReference = 'Use the complete enum in the full output schema (' + values.length + ' values).';
  }
  return result;
}

/** Duplicate diagnostics only. Never deduplicate, select a value, or accept output. */
function duplicateIssues(text, maxIssues) {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/g) || [];
  let cursor = 0, nodes = 0, complete = true;
  const issues = [], add = issue => { if (issues.length < maxIssues) issues.push(issue); else complete = false; };
  const read = (path, depth = 0) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw Error('bounded');
    const token = tokens[cursor++];
    if (token === '{') {
      const seen = new Set();
      if (tokens[cursor] === '}') { cursor++; return; }
      for (;;) {
        const key = JSON.parse(tokens[cursor++]);
        if (tokens[cursor++] !== ':') throw Error('syntax');
        const memberPath = displayKey(path, key);
        if (seen.has(key)) add({ path: memberPath,
          message: 'Duplicate JSON member. Its occurrences may conflict. Return exactly one evidence-supported value for this member; do not rely on first-value or last-value parsing.' });
        seen.add(key);
        read(memberPath, depth + 1);
        const separator = tokens[cursor++];
        if (separator === '}') return;
        if (separator !== ',') throw Error('syntax');
      }
    }
    if (token === '[') {
      if (tokens[cursor] === ']') { cursor++; return; }
      let index = 0;
      for (;;) {
        if (index >= 200) complete = false; // The schema diagnostic walker inspects only the first 200 items.
        read(path + '[' + index++ + ']', depth + 1);
        const separator = tokens[cursor++];
        if (separator === ']') return;
        if (separator !== ',') throw Error('syntax');
      }
    }
    if (token === undefined || ['}', ']', ':', ','].includes(token)) throw Error('syntax');
  };
  try { read('response'); if (cursor !== tokens.length) complete = false; } catch { complete = false; }
  return { issues, complete };
}

/** Bounded schema facts for the existing full-response repair turn. No values are supplied by the host. */
export function planningFullRepairInventory(output, schema, { maxIssues = DEFAULT_ISSUES, maxChars = DEFAULT_CHARS } = {}) {
  if (!Number.isSafeInteger(maxIssues) || maxIssues < 1 || maxIssues > DEFAULT_ISSUES ||
      !Number.isSafeInteger(maxChars) || maxChars < 64 || maxChars > DEFAULT_CHARS) throw new RangeError('Use bounded diagnostic inventory limits.');
  const includeNotice = JSON.stringify({ complete: false, issues: [], limitation: LIMITATION }).length <= maxChars;
  const envelope = (issues, complete) => ({ complete, issues, ...(!complete && includeNotice ? { limitation: LIMITATION } : {}) });
  const limitedFailure = message => {
    const issues = [{ path: 'response', message }];
    return envelope(JSON.stringify(envelope(issues, false)).length <= maxChars ? issues : [], false);
  };
  if (typeof output !== 'string' || output.length > PLANNING_BROWSER_LIMITS.responseChars)
    return limitedFailure('The previous output exceeds the response text bound or is not text. Return one complete bounded JSON response matching the full schema.');
  const text = unfence(output);
  let value;
  try { value = JSON.parse(text); } catch {
    return limitedFailure('The previous output is not parseable JSON. Return one complete JSON object matching the full schema, with each member written exactly once.');
  }
  const duplicates = duplicateIssues(text, maxIssues + 1);
  const schemaIssues = planningSchemaIssues(value, schema, { maxIssues: maxIssues + 1 });
  const candidates = [...duplicates.issues, ...schemaIssues.map(issue => {
    const location = atPath(value, schema, issue.path);
    if (!location) return issue;
    const { value: item, rule } = location;
    const missing = typeOf(item) === 'object' ? (rule.required || []).filter(key => !own(item, key)) : [];
    const missingFields = issue.message.startsWith('Missing fields:') ? missing.map(field => ({
      field, contract: compactContract(rule.properties?.[field] || {})
    })) : [];
    const contract = compactContract(rule);
    let message = issue.message;
    if (Array.isArray(contract.enum)) message += ' Allowed values: ' + JSON.stringify(contract.enum) + '.';
    if (missingFields.length) {
      const enumFields = missingFields.filter(field => Array.isArray(field.contract.enum));
      for (const field of enumFields) message += ' ' + field.field + ' must be one of ' + JSON.stringify(field.contract.enum) + '.';
    }
    return { path: issue.path, message, ...(missingFields.length ? { missingFields } : {}),
      ...(Object.keys(contract).length && !missingFields.length ? { contract } : {}) };
  })];
  let complete = duplicates.complete && duplicates.issues.length <= maxIssues && schemaIssues.length <= maxIssues;
  const issues = [];
  for (const candidate of candidates) {
    if (issues.length >= maxIssues || JSON.stringify(envelope([...issues, candidate], false)).length > maxChars) {
      complete = false; break;
    }
    issues.push(candidate);
  }
  if (issues.length !== candidates.length) complete = false;
  return envelope(issues, complete);
}
