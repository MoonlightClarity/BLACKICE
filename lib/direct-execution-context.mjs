import { createHash } from 'node:crypto';

const NAME = 'blackice_execution_context';
const MAX_CHARS = 16000;
const requestId = { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$' };
const expectedHash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const readFields = {
  offset: { type: 'integer', minimum: 0, description: 'Character offset from nextOffset. Continuation pages require expectedHash.' },
  maxChars: { type: 'integer', minimum: 2, maximum: MAX_CHARS, default: 12000 },
  expectedHash,
};
const branch = (action, fields = {}, required = []) => ({
  type: 'object', additionalProperties: false,
  properties: { requestId, action: { const: action }, ...fields },
  required: ['requestId', 'action', ...required],
});
const schema = {
  type: 'object', required: ['requestId', 'action'],
  oneOf: [
    branch('instructions', readFields),
    branch('identity', { kind: { enum: ['soul', 'user'] }, ...readFields }, ['kind']),
    branch('skill_search', {
      query: { type: 'string', maxLength: 2000, default: '' },
      offset: { type: 'integer', minimum: 0, maximum: 11000, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
    }),
    branch('skill_read', { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' }, ...readFields }, ['id']),
  ],
};
const allowed = {
  instructions: ['offset', 'maxChars', 'expectedHash'],
  identity: ['kind', 'offset', 'maxChars', 'expectedHash'],
  skill_search: ['query', 'offset', 'limit'],
  skill_read: ['id', 'offset', 'maxChars', 'expectedHash'],
};
const hash = content => createHash('sha256').update(content).digest('hex');
const fail = (message, code = 'EXECUTION_CONTEXT_INVALID', status = 400, details = {}) =>
  Object.assign(new Error(message), { code, status, ...details });
const check = signal => signal?.throwIfAborted();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const splitsPair = (content, offset) => offset > 0 && offset < content.length
  && /[\uD800-\uDBFF]/.test(content[offset - 1]) && /[\uDC00-\uDFFF]/.test(content[offset]);

function validate(args) {
  if (!plain(args) || typeof args.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(args.requestId)
    || !Object.hasOwn(allowed, args.action)) throw fail('Use a declared context action and stable requestId.');
  const keys = new Set(['requestId', 'action', ...allowed[args.action]]);
  if (Object.keys(args).some(key => !keys.has(key))) throw fail('Unexpected fields for this context action.');
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) throw fail('Use a nonnegative integer offset.');
  if (args.action === 'skill_search') {
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 2000)
      || (args.offset ?? 0) > 11000
      || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50))
      throw fail('Use a query up to 2000 characters, offset up to 11000 and limit from 1 to 50.');
    return;
  }
  if (args.action === 'identity' && !['soul', 'user'].includes(args.kind)) throw fail('Choose identity kind soul or user.');
  if (args.action === 'skill_read' && (typeof args.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(args.id))) throw fail('Use a returned skill ID.');
  if (args.maxChars !== undefined && (!Number.isSafeInteger(args.maxChars) || args.maxChars < 2 || args.maxChars > MAX_CHARS))
    throw fail('Use maxChars from 2 to 16000.');
  if (args.expectedHash !== undefined && (typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash)))
    throw fail('Use the complete content SHA-256 returned by the earlier page.');
  if ((args.offset ?? 0) > 0 && args.expectedHash === undefined) throw fail('Continuation pages require the earlier expectedHash.');
}

function document(record, source) {
  if (!record || typeof record.content !== 'string') throw fail('The context store returned no readable content.', 'EXECUTION_CONTEXT_UNAVAILABLE', 503);
  const warning = typeof record.warning === 'string' && record.warning ? record.warning : undefined;
  return {
    content: record.content,
    source: { ...source, revision: record.revision, hash: hash(record.content),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
      ...(record.sourceHash ? { sourceHash: record.sourceHash } : {}),
      ...(record.sourceChars !== undefined ? { sourceCharacters: record.sourceChars } : {}),
      ...(record.projection ? { projection: record.projection } : {}),
      ...(record.excludedLearnedEntries !== undefined ? { excludedLearnedEntries: record.excludedLearnedEntries } : {}) },
    availability: record.provenance?.source === 'unavailable' ? 'unavailable' : warning ? 'fallback' : 'available',
    ...(warning ? { warning } : {}),
  };
}

function page(value, args) {
  const { content, ...metadata } = value, offset = args.offset ?? 0;
  if (args.expectedHash !== undefined && args.expectedHash !== value.source.hash)
    throw fail('Context changed. Read offset 0 with a fresh requestId before continuing.', 'EXECUTION_CONTEXT_CHANGED', 409, {
      current: { source: value.source, totalCharacters: content.length },
    });
  if (offset > content.length || splitsPair(content, offset)) throw fail('Offset must be within the content and must not split a Unicode surrogate pair.');
  let end = Math.min(content.length, offset + (args.maxChars ?? 12000));
  if (splitsPair(content, end)) end--;
  if (offset < content.length && end <= offset) throw fail('This page would not advance. Use maxChars of at least 2.');
  return {
    ...metadata, content: content.slice(offset, end), offset, returnedCharacters: end - offset,
    totalCharacters: content.length, truncated: offset !== 0 || end < content.length,
    nextOffset: end < content.length ? end : null,
  };
}

const unavailable = label => fail(label + ' is unavailable in this runtime.', 'EXECUTION_CONTEXT_UNAVAILABLE', 503);

/** Read the existing effective stores. This adapter never owns or closes them. */
export function createDirectExecutionContextTool({ instructionSettings, identity, skillsCatalog } = {}) {
  async function instructions() {
    if (typeof instructionSettings?.read !== 'function') throw unavailable('Saved Instructions');
    const record = await instructionSettings.read();
    return document(record, { kind: 'common-instructions', label: 'Config / Instructions', origin: record?.source });
  }
  return {
    definition: {
      name: NAME,
      description: 'Read BLACKICE saved execution context without changing it. instructions reads the actual saved common Instructions, including an intentionally empty value. identity with kind soul or user reads owner behavior or enduring personal facts and preferences through the native context projection. skill_search finds effective skill metadata; an empty query browses, and skill_read loads one returned id including owner edits. Listed skills have not yet been read or applied. Read relevant context before treating it as missing; current user directions still govern.\nContent pages return complete-content hash, revision, observedAt and nextOffset. Continue with offset:nextOffset and expectedHash from that page. Use a new requestId for a fresh observation; identical requestId and arguments recover the original saved result, which may be older. Returns jobId; read blackice_get_job until settled. Context reads are not prerequisites for operational tool admission.',
      scope: 'read', requiredScopes: ['read'], mutating: false, inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async execute(args, { signal } = {}) {
      validate(args); check(signal);
      let result;
      if (args.action === 'skill_search') {
        if (typeof skillsCatalog?.list !== 'function') throw unavailable('The effective skill catalog');
        const found = await skillsCatalog.list({ query: args.query ?? '', source: 'all', offset: args.offset ?? 0, limit: args.limit ?? 12 });
        if (!Array.isArray(found?.entries)) throw unavailable('The effective skill catalog');
        const { entries, ...metadata } = found;
        result = { ...metadata, entries: entries.map(({ content, ...entry }) => entry) };
      } else {
        let value;
        if (args.action === 'instructions') value = await instructions();
        else if (args.action === 'identity') {
          if (typeof identity?.readForContext !== 'function') throw unavailable('Identity context');
          const record = await identity.readForContext(args.kind);
          value = document(record, { kind: 'identity', identityKind: args.kind, label: record?.fileName || (args.kind === 'soul' ? 'SOUL.md' : 'USER.md'), origin: record?.provenance?.source });
        } else {
          if (typeof skillsCatalog?.detail !== 'function') throw unavailable('The effective skill catalog');
          const record = await skillsCatalog.detail({ id: args.id });
          value = document(record, { kind: 'skill', id: record?.id || args.id, label: record?.title || args.id, origin: record?.source,
            ...(record?.provenance ? { provenance: record.provenance } : {}) });
        }
        result = page(value, args);
      }
      check(signal);
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({
        version: 1, action: args.action, observedAt: new Date().toISOString(), ...result,
      }) }] };
    },
    async discoveryInstructions() {
      try {
        const value = await instructions(), characters = value.content.length;
        const status = characters === 0 ? 'empty' : characters <= MAX_CHARS ? 'included' : 'paginated';
        return {
          metadata: { version: 1, tool: NAME, instructions: { status, ...value.source, characters } },
          text: status === 'paginated'
            ? 'The saved Instructions exceed the discovery bound. Read blackice_execution_context action:"instructions" and follow nextOffset with expectedHash to retrieve the complete text; no partial policy was included here.'
            : value.content,
        };
      } catch (error) {
        const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'EXECUTION_CONTEXT_UNAVAILABLE';
        return { metadata: { version: 1, tool: NAME, instructions: { status: 'unavailable', code } },
          text: 'Saved Instructions could not be read. The context tool can report the current failure; other tools remain callable.' };
      }
    },
  };
}
