import { TASK_ACCURACY_FIELDS } from '../public/task-viability-model.mjs';

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const typeMatches = (value, type) => type === typeOf(value) || type === 'integer' && Number.isSafeInteger(value);
const shapeMatches = (value, schema) => !schema.type || (Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => typeMatches(value, type));
const discriminatorMatches = (value, schema) => {
  if (schema.const !== undefined && value !== schema.const || schema.enum && !schema.enum.includes(value)) return false;
  if (typeOf(value) !== 'object') return true;
  return Object.entries(schema.properties || {}).every(([key, child]) => !Object.hasOwn(value, key) ||
    child.const === undefined && !child.enum || discriminatorMatches(value[key], child));
};

/** Bounded repair hints for the declared schema, not an acceptance validator.
 * Keep host parsers authoritative. Never coerce, truncate, invent or remove a field.
 */
export function planningSchemaIssues(value, schema, { path = 'response', maxIssues = 12 } = {}) {
  const inspect = (item, rule, where, depth = 0) => {
    const issues = [], add = message => { if (issues.length < maxIssues) issues.push({ path: where, message }); };
    const append = children => { for (const issue of children) if (issues.length < maxIssues) issues.push(issue); };
    if (!rule || depth > 64) return issues;
    if (!shapeMatches(item, rule)) {
      add('Expected ' + (Array.isArray(rule.type) ? rule.type.join(' or ') : rule.type) + '.');
      return issues;
    }
    if (rule.anyOf) {
      const shapes = rule.anyOf.filter(branch => shapeMatches(item, branch));
      const discriminated = shapes.filter(branch => discriminatorMatches(item, branch));
      const candidates = (discriminated.length ? discriminated : shapes).map(branch => inspect(item, branch, where, depth + 1));
      // JSON integers have JS type "number"; do not reject a valid nullable integer.
      if (!candidates.length) add('Use one of the declared JSON shapes.');
      else if (!candidates.some(candidate => candidate.length === 0)) append(candidates.reduce((best, next) => next.length < best.length ? next : best));
    }
    if (Object.hasOwn(rule, 'const') && item !== rule.const) add('Use the declared constant ' + JSON.stringify(rule.const) + '.');
    if (rule.enum && !rule.enum.includes(item)) { add('Use one of the declared values or captured identifiers.'); return issues; }
    const type = typeOf(item);
    if (type === 'object') {
      const missing = (rule.required || []).filter(key => !Object.hasOwn(item, key));
      const extra = Object.keys(item).filter(key => rule.additionalProperties === false && !Object.hasOwn(rule.properties || {}, key));
      if (missing.length) {
        const requiredText = missing.filter(key => rule.properties?.[key]?.type === 'string' && rule.properties[key].minLength > 0);
        add('Missing fields: ' + missing.join(', ') + '.' + (requiredText.length ? ' These fields require nonempty text: ' + requiredText.join(', ') + '.' : ''));
      }
      if (extra.length) add('Unexpected fields: ' + extra.slice(0, 20).join(', ') + '.');
      for (const [key, child] of Object.entries(rule.properties || {})) {
        if (issues.length >= maxIssues) break;
        if (Object.hasOwn(item, key)) append(inspect(item[key], child, where + '.' + key, depth + 1));
      }
      // This mode-dependent host rule is not representable by the conservative
      // structured-output subset without duplicating the entire accuracy object.
      if (item.mode === 'bounded_estimate' && TASK_ACCURACY_FIELDS.every(key => rule.required?.includes(key)) &&
          typeof item.tolerance === 'string' && !item.tolerance.trim() && issues.length < maxIssues) {
        issues.push({ path: where + '.tolerance', message: 'A bounded_estimate requires nonempty tolerance text describing the permitted deviation.' });
      }
    } else if (type === 'array') {
      if (Number.isInteger(rule.minItems) && item.length < rule.minItems) add('This array needs at least ' + rule.minItems + ' item' + (rule.minItems === 1 ? '' : 's') + '.');
      if (Number.isInteger(rule.maxItems) && item.length > rule.maxItems) add(rule.maxItems === 0 ? 'This array must be empty: no corresponding captured references exist.' : 'This array permits at most ' + rule.maxItems + ' items.');
      if (rule.uniqueItems && new Set(item.map(child => JSON.stringify(child))).size !== item.length) add('This array must not contain duplicate items.');
      for (let index = 0; index < Math.min(item.length, 200) && issues.length < maxIssues; index++) append(inspect(item[index], rule.items, where + '[' + index + ']', depth + 1));
    } else if (type === 'string') {
      if (Number.isInteger(rule.minLength) && item.length < rule.minLength) add('Use nonempty text' + (rule.minLength > 1 ? ' of at least ' + rule.minLength + ' characters' : '') + '.');
      if (Number.isInteger(rule.maxLength) && item.length > rule.maxLength) add('Use at most ' + rule.maxLength + ' characters; this field has ' + item.length + '.');
      if (rule.pattern && !new RegExp(rule.pattern, 'u').test(item)) {
        if (item.includes('\0')) add('Do not include null characters in this text.');
        else if (!item.trim()) {
          if (!(rule.minLength && !item.length)) add('Use nonempty text containing a non-whitespace character.');
        } else add('Use text matching the declared pattern ' + rule.pattern + '.');
      }
    } else if (type === 'number') {
      if (!Number.isFinite(item)) add('Use a finite number.');
      if (Number.isFinite(rule.minimum) && item < rule.minimum) add('Use a number at least ' + rule.minimum + '.');
      if (Number.isFinite(rule.maximum) && item > rule.maximum) add('Use a number at most ' + rule.maximum + '.');
    }
    return issues;
  };
  return inspect(value, schema, path);
}
