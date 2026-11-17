/** Public, discoverable action contract for the connector's project-management write tool.
 * The direct host supports this bounded JSON Schema subset, including oneOf/const.
 * Each branch specifies the exact revision and value fields; the ledger remains
 * the stateful authority for existence, revisions, ownership and lifecycle.
 */
const ident = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]{1,100}$' };
const requiredText = maxLength => ({ type: 'string', minLength: 1, maxLength });
const optionalText = maxLength => ({ type: 'string', maxLength });
const rev = { type: 'integer', minimum: 1 };
const enumOf = (...values) => ({ type: 'string', enum: values });
const nullableIdent = { anyOf: [ident, { type: 'null' }] };
const ids = (maxItems = 100) => ({ type: 'array', items: ident, maxItems, uniqueItems: true });
const authority = enumOf('source', 'unit', 'integration', 'packaged', 'live_worker', 'external');
const epistemic = enumOf('observed', 'derived', 'inferred', 'unknown');
const outcome = enumOf('pass', 'fail', 'unknown');
const object = (properties, required = [], extra = {}) =>
  ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const valueOf = (properties, required = [], extra = {}) => object(properties, required, extra);
const requestId = { type:'string', minLength:1, maxLength:120,
  pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$',
  description:'Stable request ID under one OAuth grant; inspect a prior uncertain job before retry.' };
const mutationId = { ...ident,
  description:'Stable grant-scoped mutation ID: identical reuse dedupes, divergent reuse conflicts.' };
const common = { requestId, mutationId, projectId:ident, itemId:ident,
  expectedProjectRevision:rev, expectedItemRevision:rev, expectedSourceRevision:rev };
const action = (actionName, needed, value) => ({
  type: 'object', required: ['requestId','mutationId','action', ...needed, 'value'],
  properties: { requestId, mutationId, action: { const: actionName },
    ...Object.fromEntries(needed.map(field => [field, common[field]])), value },
  additionalProperties: false,
  description: actionName + ': required ' + ['requestId','mutationId','action', ...needed, 'value'].join(', '),
});
const project = ['projectId'], item = ['projectId', 'itemId'];
const revisionProject = [...project, 'expectedProjectRevision'];
const revisionItem = [...item, 'expectedItemRevision'];

const projectValue = { name: requiredText(160), objective: requiredText(6000) };
const registerValue = { id: ident, label: requiredText(160), scope: requiredText(3000),
  kind: enumOf('human', 'agent'), actorId: ident };
const itemValue = {
  title: requiredText(220), scope: requiredText(3000), requirements: requiredText(4000),
  ownerId: nullableIdent, dependsOn: ids(), verificationTarget: authority,
};
const sourceValue = { id: ident, text: requiredText(12000), reference: optionalText(1000) };
const evidenceValue = {
  id: ident, claim: requiredText(300), epistemic, authority, outcome,
  sourceId: ident, sourceRevision: rev, requirementRevision: rev, note: optionalText(2000),
};
const readyDisposition = enumOf('not_ready', 'blocked', 'out_of_scope', 'contradicted');

export const SWARM_ACTION_NAMES = Object.freeze([
  'create_project', 'edit_project', 'archive_project', 'trash_project', 'restore_project', 'register_worker', 'propose_item', 'edit_item',
  'transition', 'record_source', 'record_evidence', 'resolve_failure',
  'request_ready', 'decide_ready', 'record_integration',
]);

const branches = [
  action('create_project', [], valueOf({ id: ident, ...projectValue }, ['id','name','objective'])),
  action('edit_project', revisionProject, valueOf(projectValue, [], { minProperties: 1 })),
  ...['archive_project', 'trash_project', 'restore_project'].map(name => action(name, revisionProject, valueOf({}))),
  action('register_worker', revisionProject, valueOf(registerValue, ['id','label','scope'])),
  action('propose_item', revisionProject,
    valueOf({ id: ident, ...itemValue }, ['id','title','scope','requirements'])),
  action('edit_item', revisionItem, valueOf(itemValue, [], { minProperties: 1 })),
  action('transition', revisionItem, valueOf({
    phase: enumOf('proposed','queued','accepted','completed'), reference: optionalText(2000),
    note: optionalText(2000),
  }, ['phase'])),
  action('transition', revisionItem, valueOf({
    phase: { const: 'delivered' }, reference: requiredText(2000), note: optionalText(2000),
  }, ['phase','reference'])),
  // Source creation and source revision update have different optimistic locks.
  // Providing both locks fails the enclosing exactly-one-branch condition.
  action('record_source', revisionProject, valueOf(sourceValue, ['id','text'])),
  action('record_source', [...project,'expectedSourceRevision'],
    valueOf(sourceValue, ['id','text'])),
  action('record_evidence', item, valueOf(evidenceValue,
    ['id','claim','epistemic','authority','outcome','sourceId','sourceRevision','requirementRevision'])),
  action('resolve_failure', item, valueOf({
    evidenceId: ident, replacementId: ident, reason: requiredText(2000),
  }, ['evidenceId','replacementId','reason'])),
  action('request_ready', revisionItem, valueOf({ note: requiredText(2000) }, ['note'])),
  action('decide_ready', revisionItem, valueOf({
    disposition: { const: 'approved' }, reason: requiredText(2000),
    evidenceIds: { ...ids(), minItems: 1 },
  }, ['disposition','reason','evidenceIds'])),
  action('decide_ready', revisionItem, valueOf({
    disposition: readyDisposition, reason: requiredText(2000), evidenceIds: ids(),
  }, ['disposition','reason'])),
  action('record_integration', revisionItem, valueOf({
    status: { const: 'recorded' }, reference: requiredText(2000), note: optionalText(2000),
  }, ['status','reference'])),
  action('record_integration', revisionItem, valueOf({
    status: enumOf('proposed','rejected'), reference: optionalText(2000), note: optionalText(2000),
  }, ['status'])),
];

// This root shape is checked before oneOf, so branch alternatives cannot admit
// unsupported top-level keys. Host-side stateful validation still applies.
export const swarmWriteInputSchema = object({
  requestId: { type:'string', minLength:1, maxLength:120,
    pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$',
    description:'Stable transport request ID under this authenticated OAuth grant; inspect a previous job before retrying.' },
  mutationId: { ...ident, description:'Stable grant-scoped mutation ID; identical reuse dedupes, divergent reuse conflicts.' },
  action: enumOf(...SWARM_ACTION_NAMES),
  projectId: ident, itemId: ident,
  expectedProjectRevision: rev, expectedItemRevision: rev, expectedSourceRevision: rev,
  value: { type: 'object', description:'Exact action-specific payload required by the oneOf discriminator below.' },
}, ['requestId','mutationId','action'], {
  oneOf: branches,
  description: 'A Swarm project-management ledger change, not worker execution. Match exactly one action schema. OAuth client/grant identifies the caller, not the individual ChatGPT chat. Worker delivery/readiness remain reported claims.',
});
