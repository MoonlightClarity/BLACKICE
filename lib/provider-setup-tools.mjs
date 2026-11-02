import { connectorBrowserOwner } from './connector-browser-owner.mjs';
import { PROVIDER_PRESETS } from '../public/provider-catalog.mjs';
import { providerKeyTarget, providerKeyFailure } from './provider-key-contract.mjs';

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const requestId = { ...string(120), pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$', description: 'Stable identity for this exact action. Inspect its saved job after uncertainty; an identical same-ID retry never repeats the action.' };
const providerId = { ...string(40), pattern: '^[a-z][a-z0-9_-]{0,39}$' };
const schema = (properties, required = []) => ({ type: 'object', properties: { requestId, ...properties }, required: ['requestId', ...required], additionalProperties: false });
const definition = (name, description, scope, requiredScopes, inputSchema, mutating) => ({ name, description, scope, requiredScopes, inputSchema, mutating, annotations: { readOnlyHint: !mutating, destructiveHint: false, idempotentHint: true, openWorldHint: true } });
const receipt = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const fail = (message, code = 'PROVIDER_SETUP_ARGUMENTS') => Object.assign(new Error(message), { code, status: 400 });
const check = signal => { if (signal?.aborted) throw Object.assign(new Error('Provider setup cancelled. Inspect the saved connection before continuing.'), { name: 'AbortError', code: 'ABORT_ERR' }); };
const allowed = (value, fields) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw fail('Use only the declared fields for this provider setup action.'); };
const modelLimit = { anyOf: [{ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: 'null' }], description: 'A known model capacity in tokens, or null to explicitly mark it unknown. Omitted preserves a saved value. BLACKICE reports provider-supplied capacities separately from manually configured values.' };
const modelSchema = { type: 'object', properties: { id: string(256), displayName: string(160), contextWindowTokens: modelLimit, supportsTools: { type: 'boolean' }, maxOutputTokens: modelLimit }, required: ['id'], additionalProperties: false };
const configuration = { type: 'object', properties: { id: providerId, preset: { enum: PROVIDER_PRESETS.map(preset => preset.id) }, type: { enum: ['openai', 'anthropic', 'compatible'] }, name: string(100), baseUrl: string(20000), endpoints: { type: 'object', properties: { models: { ...string(2000), description: 'Optional same-origin root-relative model catalog path, such as /models.' }, chatCompletions: { ...string(2000), description: 'Optional same-origin root-relative Chat Completions path for the compatible protocol, such as /openai.' } }, additionalProperties: false, description: 'Omitted preserves saved paths; an explicit object replaces them, and {} restores standard paths. No full URLs, queries or fragments.' }, models: { type: 'array', items: modelSchema, maxItems: 200 }, enabled: { type: 'boolean' }, maxTokens: { type: 'integer', minimum: 1, maximum: 128000, description: 'Configured response output budget; this is separate from a model\'s advertised maximum output capacity.' }, maxSteps: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } }, required: ['id'], additionalProperties: false };
const configureFields = Object.keys(configuration.properties);

/** First-class provider setup uses the existing direct-job ledger and grants. */
export function createDirectProviderSetupTools({ runtime, browser, reauthorize, isEncryptionAvailable = () => false, browserOwnerForClient = client => connectorBrowserOwner(client.id) } = {}) {
  if (!runtime || !browser) return [];
  if (typeof reauthorize !== 'function' || typeof isEncryptionAvailable !== 'function' || typeof browserOwnerForClient !== 'function') throw fail('Provider setup requires the existing host authorization and secret-storage checks.');
  const authorize = async (client, scopes, signal) => { check(signal); await reauthorize(client, { scopes }); check(signal); };
  const encrypted = async signal => {
    check(signal);
    if (await isEncryptionAvailable() !== true || typeof runtime.store?.encryptSecret !== 'function' || typeof runtime.store?.decryptSecret !== 'function') throw Object.assign(new Error('Encrypted provider storage is unavailable. No API key was accepted.'), { code: 'PROVIDER_SECRET_STORAGE_UNAVAILABLE', status: 503 });
    check(signal);
  };
  return [
    {
      definition: definition('blackice_provider_read', 'Read sanitized API connections or a saved connection’s model catalog. Every model reports context-window and maximum-output capacities with provenance, or explicit unknown values; configured working/output budgets remain separate. Search, context/output sorting, minimum context, tools-only and vision-only filters apply to the full catalog before pagination. Catalog metadata includes provider-reported pricing strings and a freeVariant suffix indicator. freeOnly keeps models with complete reported zero pricing or an explicit reported free-access flag; incomplete or nonzero pricing is excluded. Anonymous free presets always apply this catalog filter. This does not prove account eligibility, available quota, future pricing or working tool calls. No API keys or header values are returned and no model inference starts.', 'read', ['read'], schema({ action: { enum: ['list', 'catalog'] }, providerId, query: { type: 'string', maxLength: 256 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, sort: { enum: ['name', 'context-desc', 'context-asc', 'output-desc'] }, minContextTokens: { anyOf: [{ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: 'null' }] }, toolsOnly: { type: 'boolean' }, freeOnly: { type: 'boolean' }, visionOnly: { type: 'boolean' }, refresh: { type: 'boolean' } }, ['action']), false),
      async execute(value, { client, signal } = {}) {
        await authorize(client, ['read'], signal);
        const { requestId: _requestId, action, providerId: id, ...options } = value;
        if (action === 'list') {
          allowed(value, ['requestId', 'action', 'providerId']); await runtime.store.init(); check(signal);
          const providers = runtime.listProviders(); return receipt({ providers: id ? providers.filter(item => item.id === id) : providers, modelStarted: false, providerTurns: false });
        }
        if (action !== 'catalog' || !id) throw fail('Catalog needs a saved providerId.');
        const catalog = await runtime.discoverModels(id, { ...options, signal }); check(signal);
        await authorize(client, ['read'], signal);
        return receipt({ ...catalog, modelAccessVerified: false, modelStarted: false, providerTurns: false });
      },
    },
    {
      definition: definition('blackice_provider_configure', 'Save or check a provider, or copy an existing BLACKICE key into this profile’s .env. Raw keys are not tool arguments. This leaves the app default unchanged; a catalog check does not prove inference.', 'commands:run', ['commands:run'], schema({ action: { enum: ['save', 'test', 'key_to_disk'] }, provider: configuration, providerId, expectedUpdatedAt: { anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }] } }, ['action']), true),
      async execute(value, { client, signal } = {}) {
        const scopes = ['commands:run']; await authorize(client, scopes, signal);
        if (value.action === 'test') {
          allowed(value, ['requestId', 'action', 'providerId']); if (!value.providerId) throw fail('Test needs a saved providerId.');
          const result = await runtime.testProvider(value.providerId, { signal }); check(signal); await authorize(client, scopes, signal);
          return receipt({ ...result, modelAccessVerified: false, modelStarted: false, providerTurns: false });
        }
        if (value.action === 'key_to_disk') {
          allowed(value, ['requestId', 'action', 'providerId', 'expectedUpdatedAt']);
          if (!value.providerId || !value.expectedUpdatedAt) throw fail('A saved provider and its current revision are required.');
          const result = await runtime.copySavedProviderKeyToDisk(value.providerId, { expectedUpdatedAt: value.expectedUpdatedAt, signal, beforeCommit: () => authorize(client, scopes, signal) });
          return receipt({ ...result, defaultChanged: false, modelStarted: false, providerTurns: false });
        }
        allowed(value, ['requestId', 'action', 'provider', 'expectedUpdatedAt']);
        if (value.action !== 'save' || !Object.hasOwn(value, 'expectedUpdatedAt')) throw fail('Save needs the exact saved updatedAt, or null for a new provider id.');
        allowed(value.provider, configureFields);
        const saved = await runtime.saveProvider(value.provider, { expectedUpdatedAt: value.expectedUpdatedAt, preserveDefault: true, signal, beforeCommit: () => authorize(client, scopes, signal) });
        return receipt({ provider: saved, defaultChanged: false, modelStarted: false, providerTurns: false });
      },
    },
    {
      definition: definition('blackice_provider_import_key', 'Inspect or import a provider API key from the contained browser. Import writes the profile .env by default; optional encrypted storage is supported. Key values are transferred by BLACKICE, not by tool arguments. Inference is tested separately.', 'commands:run', ['commands:run', 'browser:read', 'browser:write'], schema({ action: { enum: ['inspect', 'click_inspect', 'import'] }, storage: { enum: ['disk', 'encrypted'] }, tabId: string(200), origin: string(2000), expectedUrl: string(20000), expectedDocumentId: string(200), ref: string(500), providerId, expectedUpdatedAt: string(100) }, ['action', 'tabId', 'origin', 'expectedUrl']), true),
      async execute(value, { client, signal } = {}) {
        const scopes = ['commands:run', 'browser:read', 'browser:write'];
        await authorize(client, scopes, signal);
        const { requestId: _requestId, providerId: id, expectedUpdatedAt, storage: chosenStorage, ...source } = value;
        const storage = chosenStorage || 'disk';
        if (source.action === 'import') { if (!id || !expectedUpdatedAt) throw fail('Import needs a saved providerId and its current updatedAt.'); }
        else if (id !== undefined || expectedUpdatedAt !== undefined || chosenStorage !== undefined) throw fail('Inspect and click_inspect use only the observed browser source fields.');
        if (source.action === 'import' && storage === 'encrypted') await encrypted(signal);
        const target = providerKeyTarget({ ...source, browser: 'relay' });
        const beforeDispatch = async ({ signal: active = signal } = {}) => { await authorize(client, scopes, active); if (storage === 'encrypted' && target.action === 'import') await encrypted(active); };
        if (target.action === 'import') {
          await runtime.store.init(); check(signal);
          if (runtime.store.get(id)?.updatedAt !== expectedUpdatedAt) throw fail('This provider changed. Inspect its current saved configuration before importing.', 'PROVIDER_CHANGED');
        }
        try {
          const result = await browser.providerKeySource(target, { signal, owner: browserOwnerForClient(client), beforeDispatch,
            ...(target.action === 'import' ? { consume: async (apiKey, { signal: active = signal } = {}) => {
              const provider = storage === 'disk'
                ? (await runtime.writeDiskProviderKey(id, apiKey, { expectedUpdatedAt, signal: active, beforeCommit: () => beforeDispatch({ signal: active }) })).provider
                : await runtime.saveProvider({ id, apiKey }, { expectedUpdatedAt, requireEncrypted: true, preserveDefault: true, signal: active, beforeCommit: () => beforeDispatch({ signal: active }) });
              if (provider?.hasApiKey !== true || storage === 'disk' && provider.secretStorage !== 'file' || storage === 'encrypted' && provider.secretStorage !== 'encrypted') throw fail('Provider key import could not be confirmed.', 'PROVIDER_KEY_SETUP_UNCONFIRMED');
              return { imported: true, storage, provider, defaultChanged: false, modelStarted: false, providerTurns: false };
            } } : {}),
          });
          return receipt(result);
        } catch (cause) { throw providerKeyFailure(cause, { clickDispatched: cause?.actionDispatched === null || cause?.actionDispatched === true || target.action === 'click_inspect' && cause?.actionDispatched !== false, importAttempted: cause?.importAttempted === true }); }
      },
    },
  ];
}
