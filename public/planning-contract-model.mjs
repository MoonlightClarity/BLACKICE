import { taskAccuracySchema, validateTaskAccuracy, TASK_ACCURACY_SCOPE_GUIDANCE } from './task-viability-model.mjs';

// Canonical intent contract. This pure module is shared by host validation and UI.
// Operation receipts and evidence never become model-authored plan fields.
export const PLAN_CONTRACT_VERSION = 2;
export const PLAN_CONTRACT_LIMITS = Object.freeze({ workItems: 80, criteria: 40, instructions: 80, resources: 32, operationScopes: 64, receiptBindings: 8, chars: 120000 });
export const CONTRACT_EFFECTS = Object.freeze(['observe', 'interact', 'commit', 'opaque']);
const clone = value => structuredClone(value);
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const fail = message => Object.assign(new Error(message), { code: 'TASK_CONTRACT_INVALID', status: 400 });
const identifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$' };
const textSchema = maxLength => ({ type: 'string', minLength: 1, maxLength });
const arraySchema = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const receiptBindingSchema = (properties, required) => ({ ...obj(properties, required), anyOf: [
  { properties: { confirmedValues: { minItems: 1 } } },
  { required: ['absentValues'], properties: { absentValues: { minItems: 1 } } },
] });
const structuredReceiptBindingSchema = receiptBindingSchema({
  version: { type: 'integer', const: 1 }, format: { type: 'string', enum: ['dom', 'json'] }, resourceKey: textSchema(2048),
  record: textSchema(512), status: textSchema(256), destination: textSchema(256), confirmedValues: arraySchema(textSchema(200), 20),
  absentValues: arraySchema(textSchema(200), 20), outcomeId: textSchema(256), history: { type: 'boolean' },
  prior: { ...obj({
    field: { ...textSchema(256), description: "Observed receipt field whose value identifies a pre-existing record." },
    values: { ...arraySchema(textSchema(200), 20, 1), description: "Observed values denoting pre-existing records, which are excluded from new outcome counts. Select values by their observed meaning; do not copy the current field value automatically." },
  }), description: "Identifies pre-existing records excluded from new outcome counts. Map the observed field and values that denote that prior status." },
  identity: arraySchema(obj({ field: textSchema(256), formField: textSchema(256) }), 20),
}, ['version', 'format', 'resourceKey', 'record', 'status', 'confirmedValues', 'outcomeId', 'history']);
const nativeTextReceiptBindingSchema = receiptBindingSchema({
  version: { type: 'integer', const: 1 }, format: { type: 'string', const: 'dom-text' }, resourceKey: textSchema(2048),
  record: textSchema(512), confirmedValues: arraySchema(textSchema(200), 20), absentValues: arraySchema(textSchema(200), 20),
  history: { type: 'boolean', const: false }, outcomeFields: { ...arraySchema(textSchema(256), 20, 1), uniqueItems: true },
}, ['version', 'format', 'resourceKey', 'record', 'confirmedValues', 'history', 'outcomeFields']);
export const CONTRACT_RECEIPT_BINDING_SCHEMA = Object.freeze({ anyOf: [structuredReceiptBindingSchema, nativeTextReceiptBindingSchema] });
export const PLAN_CONTRACT_SCHEMA = Object.freeze(obj({
  contractVersion: { type: 'integer', const: PLAN_CONTRACT_VERSION },
  goal: textSchema(4000),
  criteria: arraySchema({ ...obj({
    id: identifier,
    kind: { type: 'string', enum: ['observation', 'source-coverage', 'external-confirmation', 'judgment'], description: 'Select the host evidence mechanism: observation counts distinct observed resources; source-coverage certifies complete delivered ranges for one exact stable source; external-confirmation counts distinct new destination-confirmed effects; judgment assesses a semantic conclusion using cited host evidence. Use judgment for sufficiency, eligibility and comparisons.' },
    label: textSchema(200), description: textSchema(2000), accuracy: taskAccuracySchema(),
    resourceKey: { ...textSchema(2048), description: 'For source-coverage, identify one exact concrete source that produces a source version and delivered ranges; workspace: and origin: select scopes and are invalid coverage targets in new Plans. Observation and judgment may use a scope when retained host operation evidence proves membership. External confirmation names the destination resource established by observed receipts.' },
    targetCount: { type: 'integer', minimum: 1, maximum: 1000, description: 'Defaults to 1. Count units are distinct observed resources, one completely covered concrete source, distinct new destination-confirmed effects, or one supported judgment per distinct owning work item. This does not count entities mentioned within an observation. Newly authored source-coverage criteria permit only 1.' },
    receiptBinding: CONTRACT_RECEIPT_BINDING_SCHEMA,
    receiptBindings: { ...arraySchema(CONTRACT_RECEIPT_BINDING_SCHEMA, PLAN_CONTRACT_LIMITS.receiptBindings, 1), uniqueItems: true },
  }, ['id', 'kind', 'description']), not: { required: ['receiptBinding', 'receiptBindings'] } }, PLAN_CONTRACT_LIMITS.criteria, 1),
  workItems: arraySchema(obj({
    id: identifier, title: textSchema(200), objective: textSchema(4000), owner: identifier,
    resourceKeys: arraySchema(textSchema(2048), PLAN_CONTRACT_LIMITS.resources, 1),
    effects: { ...arraySchema({ type: 'string', enum: CONTRACT_EFFECTS }, CONTRACT_EFFECTS.length, 1), description: 'Declare task-authorized effects needed inside this work item\'s listed resources. Include observe for its own verification and recovery. Include opaque when authorized browser behavior cannot be classified before dispatch; this does not expand resource access or bypass dependencies, evidence requirements or uncertain-effect protection.' },
    dependsOn: arraySchema(identifier, PLAN_CONTRACT_LIMITS.workItems),
    criterionIds: arraySchema(identifier, PLAN_CONTRACT_LIMITS.criteria, 1),
    operationScopes: { ...arraySchema(obj({
      effect: { type: 'string', enum: CONTRACT_EFFECTS },
      resourceKeys: arraySchema(textSchema(2048), PLAN_CONTRACT_LIMITS.resources, 1),
      confirmationCriterionId: identifier,
    }, ['effect', 'resourceKeys']), PLAN_CONTRACT_LIMITS.operationScopes, 1), description: 'Assign each declared effect only to the listed work-item resources it needs. Each planned commit scope names the external-confirmation criterion owned by this work item. Other scopes omit confirmationCriterionId.' },
  }, ['id', 'title', 'objective', 'owner', 'resourceKeys', 'effects', 'dependsOn', 'criterionIds']), PLAN_CONTRACT_LIMITS.workItems, 1),
  instructions: arraySchema(obj({
    id: identifier, text: textSchema(4000), handling: { type: 'string', enum: ['preserve', 'audit'] },
  }), PLAN_CONTRACT_LIMITS.instructions),
}));
/** Model output requires every property; null marks an omitted optional field. */
export function planContractResponseSchema() {
  const visit = schema => {
    const result = clone(schema);
    if (object(schema.properties) && schema.type === 'object') {
      result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, field]) => {
        const mapped = visit(field);
        if (schema.required.includes(key) || mapped.anyOf?.some(branch => branch.type === 'null')) return [key, mapped];
        return [key, { anyOf: [mapped, { type: 'null' }] }];
      }));
      result.required = Object.keys(result.properties);
      // The host still enforces these conditions on the decoded contract.
      delete result.not;
      if (schema.anyOf?.every(branch => Object.keys(branch).every(key => key === 'properties' || key === 'required'))) delete result.anyOf;
    } else if (schema.anyOf) result.anyOf = schema.anyOf.map(visit);
    if (schema.items) result.items = visit(schema.items);
    return result;
  };
  return visit(PLAN_CONTRACT_SCHEMA);
}

/** Strip only declared optional null markers before ordinary plan validation. */
export function normalizePlanContractResponse(value, prerequisites = [], { requireBrowserReceipts = false, attachedReadScope, coordinator } = {}) {
  const decode = (item, schema) => {
    if (Array.isArray(item) && schema.items) return item.map(entry => decode(entry, schema.items));
    if (!object(item)) return item;
    // Receipt alternatives are distinguished by their format field.
    const branch = schema.anyOf?.find(candidate => {
      const format = candidate.properties?.format;
      return format && (format.const === item.format || format.enum?.includes(item.format));
    });
    if (branch) return decode(item, branch);
    if (!schema.properties) return item;
    return Object.fromEntries(Object.entries(item).flatMap(([key, entry]) => {
      const field = Object.hasOwn(schema.properties, key) ? schema.properties[key] : null;
      if (field && entry === null && !schema.required.includes(key)) return [];
      return [[key, field ? decode(entry, field) : entry]];
    }));
  };
  const decoded = decode(value, PLAN_CONTRACT_SCHEMA);
  if (prerequisites.length && Array.isArray(decoded?.criteria) && Array.isArray(decoded.workItems) &&
      decoded.workItems.every(item => Array.isArray(item?.effects) && Array.isArray(item.criterionIds) && Array.isArray(item.dependsOn))) {
    const committing = decoded.workItems.filter(item => item.effects.includes('commit') || item.effects.includes('opaque'));
    let generated;
    for (const required of prerequisites) {
      const index = decoded.criteria.findIndex(item => item?.id === required.id);
      if (!committing.length && index < 0 && !decoded.workItems.some(item => item.criterionIds.includes(required.id))) continue;
      const original = decoded.criteria[index];
      const criterion = { ...original, id: required.id, kind: 'judgment', label: required.label, description: required.description, targetCount: 1 };
      if (required.accuracy) criterion.accuracy = required.accuracy;
      else delete criterion.accuracy;
      if (index < 0) decoded.criteria.push(criterion);
      else decoded.criteria[index] = criterion;
      if (!committing.length) continue;
      let owner = decoded.workItems.find(item => !committing.includes(item) && item.effects.includes('observe') && item.criterionIds.includes(required.id));
      if (!owner) {
        if (!generated) {
          const basis = committing.find(item => item.criterionIds.includes(required.id)) || committing[0];
          const taken = new Set(decoded.workItems.map(item => item.id));
          let id = 'check-eligibility';
          for (let suffix = 2; taken.has(id); suffix++) id = 'check-eligibility-' + suffix;
          const typed = Object.hasOwn(basis, 'operationScopes');
          const readKeys = typed
            ? [...new Set(workItemOperationScopes(basis, 'observe').flatMap(scope => scope.resourceKeys))] : basis.resourceKeys;
          if (typed && !readKeys.length) throw fail('Give the eligibility prerequisite its own observation work item with resources for the saved conditions.');
          generated = { id, title: 'Check conditions before acting', objective: 'Assess the saved eligibility conditions from current relevant evidence.',
            owner: basis.owner, resourceKeys: readKeys, effects: ['observe'], dependsOn: [], criterionIds: [] };
          decoded.workItems.push(generated);
        }
        owner = generated;
        owner.criterionIds.push(required.id);
      }
      for (const item of committing) {
        item.criterionIds = item.criterionIds.filter(id => id !== required.id);
        if (!item.dependsOn.includes(owner.id)) item.dependsOn.push(owner.id);
      }
    }
  }
  if (requireBrowserReceipts && Array.isArray(decoded?.criteria) && Array.isArray(decoded.workItems)) {
    const judgments = new Set(decoded.criteria.filter(criterion => criterion?.kind === 'judgment').map(criterion => criterion.id));
    const byId = new Map(decoded.workItems.map(item => [item?.id, item]));
    for (const item of decoded.workItems) {
      if (!Array.isArray(item?.effects) || !item.effects.includes('observe') || !Array.isArray(item.dependsOn) ||
          !Array.isArray(item.resourceKeys)) continue;
      const pageScopes = workItemOperationScopes(item, 'commit').flatMap(scope => scope.resourceKeys)
        .filter(key => typeof key === 'string' && /^(?:origin|url):https?:\/\//.test(key));
      if (!pageScopes.length) continue;
      for (const id of item.dependsOn) {
        const prerequisite = byId.get(id);
        if (prerequisite?.owner !== item.owner || !Array.isArray(prerequisite.effects) ||
            prerequisite.effects.some(effect => effect === 'commit' || effect === 'opaque') || !prerequisite.effects.includes('observe') ||
            !Array.isArray(prerequisite.resourceKeys) || Object.hasOwn(prerequisite, 'operationScopes') ||
            !Array.isArray(prerequisite.criterionIds) || !prerequisite.criterionIds.some(id => judgments.has(id))) continue;
        const scopes = [...new Set([...prerequisite.resourceKeys, ...pageScopes, 'browser:relay'])];
        prerequisite.resourceKeys = scopes.slice(0, PLAN_CONTRACT_LIMITS.resources);
      }
    }
  }
  const attachedSetKey = attachedReadScope?.resourceKey;
  if (/^attachments:[a-f0-9]{64}$/.test(attachedSetKey || '') && Array.isArray(decoded?.workItems)) {
    const readers = decoded.workItems.filter(item => (item?.owner === 'coordinator' || coordinator && item?.owner === coordinator) &&
      Array.isArray(item.effects) && item.effects.includes('observe') && Array.isArray(item.resourceKeys));
    const readKeys = item => workItemOperationScopes(item, 'observe').flatMap(scope => scope.resourceKeys);
    const files = (attachedReadScope.files || []).filter(file => /^attachment:sha256:[a-f0-9]{64}$/.test(file?.resourceKey || ''));
    const exactFiles = new Set(files.map(file => file.resourceKey));
    const sourceReferences = new Map(files.filter(file => typeof file.id === 'string')
      .map(file => ['viability:attachment:' + file.id, file.resourceKey]));
    const fileCoverage = new Map();
    for (const criterion of Array.isArray(decoded.criteria) ? decoded.criteria : []) {
      if (criterion?.kind !== 'source-coverage') continue;
      const resourceKey = sourceReferences.get(criterion.resourceKey) || criterion.resourceKey;
      if (!exactFiles.has(resourceKey)) continue;
      criterion.resourceKey = resourceKey;
      fileCoverage.set(criterion.id, resourceKey);
    }
    // An explicitly named source belongs to the work that must establish its coverage.
    for (const item of readers) {
      const assigned = new Set(readKeys(item));
      if (assigned.has(attachedSetKey)) continue;
      const sources = new Set((Array.isArray(item.criterionIds) ? item.criterionIds : []).map(id => fileCoverage.get(id)));
      for (const key of sources) {
        if (!key || assigned.has(key)) continue;
        if (!item.resourceKeys.includes(key) && item.resourceKeys.length >= PLAN_CONTRACT_LIMITS.resources) continue;
        if (Object.hasOwn(item, 'operationScopes')) {
          const scope = workItemOperationScopes(item, 'observe').find(row => row.resourceKeys.length < PLAN_CONTRACT_LIMITS.resources);
          if (!scope) continue;
          scope.resourceKeys.push(key);
        }
        if (!item.resourceKeys.includes(key)) item.resourceKeys.push(key);
      }
    }
    const declared = new Set(readers.flatMap(readKeys));
    if (!declared.has(attachedSetKey)) {
      const staleKey = key => typeof key === 'string' && key.startsWith('attachment:sha256:') && !exactFiles.has(key);
      const hasUnscopedFile = [...exactFiles].some(key => !declared.has(key));
      const repair = hasUnscopedFile && readers.find(item => readKeys(item).some(staleKey));
      if (repair) {
        // Keep the declared reader and substitute the host's current read-only attachment set.
        const readScopes = Object.hasOwn(repair, 'operationScopes') ? workItemOperationScopes(repair, 'observe') : [];
        const otherKeys = new Set(Array.isArray(repair.operationScopes) ? repair.operationScopes
          .filter(scope => scope?.effect !== 'observe' && Array.isArray(scope?.resourceKeys)).flatMap(scope => scope.resourceKeys) : []);
        repair.resourceKeys = [...new Set([...repair.resourceKeys.filter(key => !staleKey(key) || otherKeys.has(key)), attachedSetKey])];
        for (const scope of readScopes) {
          if (scope.resourceKeys.some(staleKey)) {
            scope.resourceKeys = [...new Set([...scope.resourceKeys.filter(key => !staleKey(key)), attachedSetKey])];
          }
        }
      } else if (![...exactFiles].some(key => declared.has(key))) {
        const candidates = readers.filter(item => item.resourceKeys.includes(attachedSetKey) || item.resourceKeys.length < PLAN_CONTRACT_LIMITS.resources);
        const selected = candidates.find(item => !item.effects.includes('commit') && !item.effects.includes('opaque')) || candidates[0];
        if (selected) {
          if (!selected.resourceKeys.includes(attachedSetKey)) selected.resourceKeys.push(attachedSetKey);
          const scope = Object.hasOwn(selected, 'operationScopes') ? workItemOperationScopes(selected, 'observe')[0] : null;
          scope?.resourceKeys.push(attachedSetKey);
        }
      }
    }
  }
  return normalizePlanContract(decoded);
}

function keys(value, allowed, required, label) {
  if (!object(value)) throw fail(label + ' must be an object.');
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw fail(label + ' contains undeclared fields: ' + unknown.join(', ') + '.');
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (missing.length) throw fail(label + ' is missing: ' + missing.join(', ') + '.');
}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail(label + ' must be nonempty text of at most ' + max + ' characters.');
  return value.trim();
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) throw fail(label + ' must be a valid stable identifier.');
  return value;
}
function list(value, label, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw fail(label + ' must contain ' + min + ' to ' + max + ' entries.');
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) throw fail(label + ' must be unique.');
  return values;
}
export function workItemOperationScopes(item, effect) {
  if (!Array.isArray(item?.effects) || !item.effects.includes(effect)) return [];
  if (Object.hasOwn(item, 'operationScopes')) {
    return Array.isArray(item.operationScopes) ? item.operationScopes.filter(scope => scope?.effect === effect && Array.isArray(scope.resourceKeys)) : [];
  }
  return Array.isArray(item.resourceKeys) ? [{ effect, resourceKeys: item.resourceKeys }] : [];
}
export function receiptBindingsForCriterion(criterion) {
  if (criterion?.receiptBinding !== undefined && criterion?.receiptBindings !== undefined) return [];
  if (criterion?.receiptBindings !== undefined) return Array.isArray(criterion.receiptBindings) && criterion.receiptBindings.length>=1 && criterion.receiptBindings.length<=PLAN_CONTRACT_LIMITS.receiptBindings ? criterion.receiptBindings : [];
  return criterion?.receiptBinding ? [criterion.receiptBinding] : [];
}
function normalizeReceiptBinding(binding,resourceKey) {
      if (binding?.format === 'dom-text') {
        const required = ['version', 'format', 'resourceKey', 'record', 'confirmedValues', 'history', 'outcomeFields'];
        keys(binding, [...required, 'absentValues'], required, 'Native text receipt binding');
        if (binding.version !== 1 || binding.history !== false) throw fail('A native text receipt needs version 1 and history:false; the host must correlate an actual dispatched native form request.');
        const normalizedText = (value, label) => text(value, label, 200).replace(/\s+/gu, ' ');
        const normalized = { version: 1, format: 'dom-text', resourceKey: text(binding.resourceKey, 'Receipt resource', 2048),
          record: text(binding.record, 'Receipt record selector', 512),
          confirmedValues: unique(list(binding.confirmedValues, 'Confirmed texts', 20).map(value => normalizedText(value, 'Confirmed text')), 'Confirmed texts'),
          history: false, outcomeFields: unique(list(binding.outcomeFields, 'Observed outcome fields', 20, 1).map(value => text(value, 'Observed form control name', 256)), 'Observed outcome fields') };
        if (binding.absentValues !== undefined) normalized.absentValues = unique(list(binding.absentValues, 'Absent texts', 20).map(value => normalizedText(value, 'Absent text')), 'Absent texts');
        if (!normalized.confirmedValues.length && !normalized.absentValues?.length) throw fail('A receipt binding needs at least one observed confirmed or absent value.');
        if (normalized.absentValues?.some(value => normalized.confirmedValues.includes(value))) throw fail('A receipt text cannot mean both confirmed and absent.');
        if (resourceKey && resourceKey !== normalized.resourceKey) throw fail('The criterion and receipt binding must refer to the same resource.');
        return normalized;
      } else {
        const required = ['version', 'format', 'resourceKey', 'record', 'status', 'confirmedValues', 'outcomeId', 'history'];
        keys(binding, [...required, 'absentValues', 'prior', 'identity', 'destination'], required, 'Receipt binding');
        if (binding.version !== 1 || !['dom', 'json'].includes(binding.format) || typeof binding.history !== 'boolean') throw fail('Use a version 1 DOM or JSON receipt binding with explicit history semantics.');
        const normalized = { version: 1, format: binding.format, resourceKey: text(binding.resourceKey, 'Receipt resource', 2048), record: text(binding.record, 'Receipt record selector', 512),
          status: text(binding.status, 'Receipt status field', 256), confirmedValues: unique(list(binding.confirmedValues, 'Confirmed statuses', 20).map(value => text(value, 'Confirmed status', 200)), 'Confirmed statuses'),
          outcomeId: text(binding.outcomeId, 'Receipt identity field', 256), history: binding.history };
        if (binding.absentValues !== undefined) normalized.absentValues = unique(list(binding.absentValues, 'Absent statuses', 20).map(value => text(value, 'Absent status', 200)), 'Absent statuses');
        if (binding.destination !== undefined) normalized.destination = text(binding.destination, 'Receipt destination field', 256);
        if (!normalized.confirmedValues.length && !normalized.absentValues?.length) throw fail('A receipt binding needs at least one observed confirmed or absent value.');
        if (normalized.absentValues?.some(value => normalized.confirmedValues.includes(value))) throw fail('A receipt status cannot mean both confirmed and absent.');
        if (binding.prior !== undefined) { keys(binding.prior, ['field', 'values'], ['field', 'values'], 'Prior receipt marker'); normalized.prior = { field: text(binding.prior.field, 'Prior receipt field', 256), values: unique(list(binding.prior.values, 'Prior receipt values', 20, 1).map(value => text(value, 'Prior receipt value', 200)), 'Prior receipt values') }; }
        if (binding.identity !== undefined) normalized.identity = list(binding.identity, 'Receipt identity bindings', 20).map(value => { keys(value, ['field', 'formField'], ['field', 'formField'], 'Receipt identity binding'); return { field: text(value.field, 'Receipt identity field', 256), formField: text(value.formField, 'Observed form control name', 256) }; });
        if (resourceKey && resourceKey !== normalized.resourceKey) throw fail('The criterion and receipt binding must refer to the same resource.');
        return normalized;
      }
}
export function normalizePlanContract(value, { allowEpoch = false } = {}) {
  const required = ['contractVersion', 'goal', 'criteria', 'workItems', 'instructions'];
  keys(value, [...required, ...(allowEpoch ? ['planEpoch'] : [])], required, 'Canonical plan');
  if (value.contractVersion !== PLAN_CONTRACT_VERSION) throw fail('Use the explicitly supported canonical contractVersion 2.');
  if (value.planEpoch !== undefined && (!Number.isSafeInteger(value.planEpoch) || value.planEpoch < 1)) throw fail('The host planEpoch must be a positive integer.');
  const criteria = list(value.criteria, 'Criteria', PLAN_CONTRACT_LIMITS.criteria, 1).map(item => {
    keys(item, ['id', 'kind', 'label', 'description', 'accuracy', 'resourceKey', 'targetCount', 'receiptBinding', 'receiptBindings'], ['id', 'kind', 'description'], 'Criterion');
    if (!['observation', 'source-coverage', 'external-confirmation', 'judgment'].includes(item.kind)) throw fail('Choose a supported criterion kind.');
    const result = { id: id(item.id, 'Criterion ID'), kind: item.kind, description: text(item.description, 'Criterion description', 2000) };
    if (item.label !== undefined) result.label = text(item.label, 'Criterion label', 200);
    const accuracy = validateTaskAccuracy(item.accuracy); if (accuracy) result.accuracy = accuracy;
    if (item.resourceKey !== undefined) result.resourceKey = text(item.resourceKey, 'Criterion resource key', 2048);
    if (item.kind === 'source-coverage' && !result.resourceKey) throw fail('Source coverage requires an exact resourceKey.');
    if (item.targetCount !== undefined) {
      if (!Number.isSafeInteger(item.targetCount) || item.targetCount < 1 || item.targetCount > 1000) throw fail('targetCount must be an integer from 1 to 1000.');
      result.targetCount = item.targetCount;
    }
    if(item.receiptBinding!==undefined&&item.receiptBindings!==undefined)throw fail('Use receiptBinding or receiptBindings, not both.');
    if(item.receiptBinding!==undefined||item.receiptBindings!==undefined){
      if(item.kind!=='external-confirmation')throw fail('Only external-confirmation criteria declare receipt bindings.');
      if(item.receiptBinding!==undefined)result.receiptBinding=normalizeReceiptBinding(item.receiptBinding,result.resourceKey);
      else {result.receiptBindings=list(item.receiptBindings,'Receipt alternatives',PLAN_CONTRACT_LIMITS.receiptBindings,1).map(binding=>normalizeReceiptBinding(binding,result.resourceKey));unique(result.receiptBindings.map(binding=>JSON.stringify(binding)),'Receipt alternatives');}
    }
    return result;
  });
  unique(criteria.map(item => item.id), 'Criterion IDs');
  const criterionIds = new Set(criteria.map(item => item.id)), covered = new Set();
  const confirmationIds = new Set(criteria.filter(item => item.kind === 'external-confirmation').map(item => item.id));
  const workItems = list(value.workItems, 'Work items', PLAN_CONTRACT_LIMITS.workItems, 1).map(item => {
    const fields = ['id', 'title', 'objective', 'owner', 'resourceKeys', 'effects', 'dependsOn', 'criterionIds'];
    keys(item, [...fields, 'operationScopes'], fields, 'Work item');
    const resourceKeys = unique(list(item.resourceKeys, 'Resource keys', PLAN_CONTRACT_LIMITS.resources, 1).map(key => text(key, 'Resource key', 2048)), 'Resource keys');
    if (resourceKeys.some(key => key === '*' || key.includes('://*'))) throw fail('Use a bounded exact resource or adapter-declared ancestor key, not a wildcard.');
    const effects = unique([...list(item.effects, 'Allowed effects', CONTRACT_EFFECTS.length, 1)], 'Allowed effects');
    if (effects.some(effect => !CONTRACT_EFFECTS.includes(effect))) throw fail('Work items may name only supported operation effect classes.');
    const ids = unique(list(item.criterionIds, 'Work item criteria', PLAN_CONTRACT_LIMITS.criteria, 1).map(value => id(value, 'Covered criterion')), 'Covered criteria');
    for (const criterion of ids) { if (!criterionIds.has(criterion)) throw fail('Work item names an unknown criterion: ' + criterion + '.'); covered.add(criterion); }
    const result = { id: id(item.id, 'Work item ID'), title: text(item.title, 'Work item title', 200), objective: text(item.objective, 'Work item objective', 4000),
      owner: id(item.owner, 'Work item owner'), resourceKeys, effects,
      dependsOn: unique(list(item.dependsOn, 'Dependencies', PLAN_CONTRACT_LIMITS.workItems).map(value => id(value, 'Dependency ID')), 'Dependencies'), criterionIds: ids };
    if (Object.hasOwn(item, 'operationScopes')) {
      result.operationScopes = list(item.operationScopes, 'Operation scopes', PLAN_CONTRACT_LIMITS.operationScopes, 1).map(scope => {
        keys(scope, ['effect', 'resourceKeys', 'confirmationCriterionId'], ['effect', 'resourceKeys'], 'Operation scope');
        if (!effects.includes(scope.effect)) throw fail('An operation scope must use a declared work item effect.');
        const scopedKeys = unique(list(scope.resourceKeys, 'Operation scope resource keys', PLAN_CONTRACT_LIMITS.resources, 1)
          .map(key => text(key, 'Operation scope resource key', 2048)), 'Operation scope resource keys');
        if (scopedKeys.some(key => !resourceKeys.includes(key))) throw fail('Operation scopes must use declared work item resource keys.');
        if (scope.effect !== 'commit') {
          if (Object.hasOwn(scope, 'confirmationCriterionId')) throw fail('Only commit scopes may name a confirmation criterion.');
          return { effect: scope.effect, resourceKeys: scopedKeys };
        }
        const confirmationCriterionId = id(scope.confirmationCriterionId, 'Commit scope confirmation criterion');
        if (!ids.includes(confirmationCriterionId) || !confirmationIds.has(confirmationCriterionId)) {
          throw fail('A commit scope must name an external-confirmation criterion owned by its work item.');
        }
        return { effect: scope.effect, resourceKeys: scopedKeys, confirmationCriterionId };
      });
      if (effects.some(effect => !workItemOperationScopes(result, effect).length)) throw fail('Operation scopes must cover every declared work item effect.');
    }
    return result;
  });
  unique(workItems.map(item => item.id), 'Work item IDs');
  const byId = new Map(workItems.map(item => [item.id, item])), done = new Set(), visiting = [];
  const visit = key => {
    if (visiting.includes(key)) throw fail('Work item dependency cycle: ' + [...visiting.slice(visiting.indexOf(key)), key].join(' -> ') + '.');
    if (done.has(key)) return;
    const item = byId.get(key); if (!item) throw fail('Unknown work item dependency: ' + key + '.');
    visiting.push(key); for (const dependency of item.dependsOn) visit(dependency); visiting.pop(); done.add(key);
  };
  for (const item of workItems) visit(item.id);
  if (criteria.some(item => !covered.has(item.id))) throw fail('Every outcome criterion needs a work item.');
  const instructions = list(value.instructions, 'Instructions', PLAN_CONTRACT_LIMITS.instructions).map(item => {
    keys(item, ['id', 'text', 'handling'], ['id', 'text', 'handling'], 'Instruction');
    if (!['preserve', 'audit'].includes(item.handling)) throw fail('Instruction handling must be preserve or audit.');
    return { id: id(item.id, 'Instruction ID'), text: text(item.text, 'Instruction', 4000), handling: item.handling };
  });
  unique(instructions.map(item => item.id), 'Instruction IDs');
  const normalized = { contractVersion: PLAN_CONTRACT_VERSION, ...(value.planEpoch === undefined ? {} : { planEpoch: value.planEpoch }), goal: text(value.goal, 'Goal', 4000), criteria, workItems, instructions };
  if (JSON.stringify(normalized).length > PLAN_CONTRACT_LIMITS.chars) throw fail('The canonical plan exceeds its storage bound.');
  return normalized;
}
/** Validate new authoring only; historical normalization keeps prior contracts readable. */
export function validatePlanContractFeasibility(contract) {
  for (const criterion of contract.criteria) {
    const target = criterion.targetCount ?? 1;
    if (criterion.kind === 'source-coverage') {
      if (target > 1) throw fail('Source coverage criterion ' + criterion.id + ' requires one exact concrete source; targetCount must be omitted or 1. Use separate criteria for separate sources.');
      if (/^(?:workspace|origin):/i.test(criterion.resourceKey || '')) throw fail('Source coverage criterion ' + criterion.id + ' uses a scope selector. Choose the exact concrete source that produces a source version and delivered ranges; workspace: and origin: cannot establish source coverage.');
      if (/^viability:attachment:/.test(criterion.resourceKey || '')) throw fail('Source coverage criterion ' + criterion.id + ' needs the exact immutable resource key of an attached file. Choose the matching attachmentScope.files entry.');
    }
    if (criterion.kind !== 'judgment') continue;
    const workItems = new Set(contract.workItems.filter(item => item.criterionIds.includes(criterion.id)).map(item => item.id));
    if (target > workItems.size) throw fail('Judgment criterion ' + criterion.id + ' requires ' + target + ' assessments but only ' + workItems.size + ' work item(s) refer to it. Each work item contributes at most one assessment.');
  }
  return contract;
}
export const isPlanContractTask = state => state?.contract?.contractVersion === PLAN_CONTRACT_VERSION;
/** The host pins conditions on permission to commit independently of the work outline. */
export function assertCommitPrerequisites(contract, prerequisiteIds, expected = []) {
  if (!prerequisiteIds?.length) return;
  const committing = contract.workItems.filter(item => item.effects.includes('commit') || item.effects.includes('opaque'));
  if (!committing.length) return;
  for (const id of prerequisiteIds) {
    const criterion = contract.criteria.find(item => item.id === id);
    const required = expected.find(item => item.id === id);
    if (required && (criterion?.label !== required.label || criterion.description !== required.description ||
        JSON.stringify(criterion.accuracy) !== JSON.stringify(required.accuracy))) {
      throw fail('Include eligibility condition "' + id + '" on the prerequisite work item. BLACKICE carries its definition from Feasibility.');
    }
    const owners = contract.workItems.filter(item => item.criterionIds.includes(id));
    const owner = owners[0];
    if (criterion?.kind !== 'judgment' || (criterion.targetCount ?? 1) !== 1 || owners.length !== 1 ||
        !owner.effects.includes('observe') || committing.includes(owner) ||
        committing.some(item => !item.dependsOn.includes(owner.id))) {
      throw fail('Put prerequisite "' + id + '" on one observation work item without commit or opaque effects, and make every committing item wait for that work item.');
    }
  }
}
export function contractPlanProjection(value, sourceIds = []) {
  const contract = normalizePlanContract(value, { allowEpoch: true });
  return {
    acceptanceCriteria: contract.criteria.map(item => ({ id: item.id, label: item.label || item.description.slice(0, 200), description: item.description,
      verification: item.kind === 'external-confirmation' ? 'effect' : item.kind === 'judgment' ? 'response' : 'evidence',
      ...(item.accuracy ? { accuracy: clone(item.accuracy) } : {}) })),
    steps: contract.workItems.map(item => ({ id: item.id, label: item.title, description: item.objective, dependsOn: clone(item.dependsOn), criterionIds: clone(item.criterionIds), sourceIds: clone(sourceIds) })),
  };
}
export const CONTRACT_AUTHORING_GUIDANCE = "Choose criterion kinds by their actual evidence mechanism. observation counts distinct resources observed by the host; it does not count eligible items or facts mentioned inside a document. Use an evidence-backed judgment for semantic sufficiency, eligibility, comparisons and other conclusions; each owning work item contributes at most one judgment. source-coverage certifies complete delivered ranges for one exact concrete versioned source, with targetCount omitted or 1; workspace: and origin: are scope selectors, not coverage sources. external-confirmation counts distinct new destination-confirmed effects, excluding prior, absent, duplicate and unlinked records. Keep already-established workflow ownership, execution configuration and user authorization as captured constraints or instructions; do not invent a completion prerequisite to re-prove them unless the user expressly requests that verification. Preserve real task-relevant prerequisites and the complete inherited criteria. Declare only task-authorized effects within each work item's bounded resources. Include observe for its own verification and recovery. Include opaque when task-authorized browser behavior cannot be classified before dispatch; opaque does not expand resource access or bypass dependencies, evidence requirements or uncertain-effect protection."
  + " Use operationScopes to bind each effect to its specific resources, especially when one item combines local work, browsing or different destinations. For an intended external commitment, scope commit to that destination and name the owning external-confirmation criterion in confirmationCriterionId. Reading, preparing or locally recording information does not itself require an external confirmation."
  + " For task-authorized public research, give the owning work item observe and a concrete browser scope for the first useful source. Use an actual origin from the captured evidence or a real public search or first-party catalog entry point. A workspace scope covers local files only. The browser:relay scope covers tab inventory, while page content needs its own resource scope. If distinct observations are required, tie their criteria to the actual sources so unrelated reads cannot satisfy them. Keep suggested alternatives and exploratory leads optional. Open explicit HTTP(S) URLs and read or snapshot the pages for observation. When evidence identifies a needed new origin or narrower URL, materially revise that same work item with the exact resource, preserving prior IDs and evidence, then read the revised contract before using it. Research scope does not authorize form submissions, messages, or other commitments.";
export const CONTRACT_INSTRUCTIONS = "Use the accepted canonical work items. A work item permits cohesive interactions within its saved resources and effects; do not create or complete a plan node for each field or click. The host records actual operations automatically. Read or revise the plan only for material changes; change focus at work-item boundaries. Tool return is not external confirmation. Inspect actual results, keep uncertainty, and cite returned evidence IDs for judgments. Record ordinary audit findings without turning them into new authority barriers. Stop prevents further execution. Keep an effectful work item cohesive through its own authorized verification and recovery observations; include observe on that owning item when those reads are needed. An initial Plan may omit receipt bindings before the destination format is known. Use either legacy receiptBinding or receiptBindings with up to eight observed site/format alternatives under the SAME criterion and targetCount, never both. Omit criterion resourceKey for alternatives spanning different destination resources; each binding and work-item resource scope remain explicit. Conflicting matching variants are uncertainty, not first-match proof. For browser outcomes, inspect ordinary read/snapshot frames[].semanticRecords (observed selectors, attributes and visible text) and frames[].forms (form actions and actual control names). After an unconfirmed browser commitment and discovery of the visible receipt, use relay_task bind_receipt with the current revision, owning workItemId, criterionId and one observed receiptBinding. The scoped update preserves the goal, other criteria, owners and effects. Focus the owning item at the returned plan epoch and read the same response or actual history again. A read owned by a separate item cannot establish this criterion. DOM/JSON bindings need observed record/status/outcome/destination fields and identity mappings from receipt fields to actual submitted form-field names. dom-text requires a unique observed visible selector, exact normalized text, history:false and observed outcomeFields; only host-correlated native POST request/document evidence can support it, never arbitrary AJAX text. Use only observed status values. confirmedValues may be empty only with nonempty observed absentValues; this can reconcile a rejection but cannot count success. Extend the positive mapping only after observing a positive result. An existing binding does not make an unmapped response evidence: inspect, materially refine and re-observe. Keep an uncertain operation intact and do not repeat a conflicting write until the host proves absence; preserve confirmed outcomes without repetition. Empty history, an HTTP error or error prose alone does not prove absence. If the supported observations cannot establish a mapping, keep the uncertainty and explain that concrete limitation while continuing independent work." + ' ' + CONTRACT_AUTHORING_GUIDANCE + ' ' + TASK_ACCURACY_SCOPE_GUIDANCE;
