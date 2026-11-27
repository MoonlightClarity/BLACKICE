import { browserCredentialTarget, containedBrowserAvailable } from './browser.mjs';
import { createHash } from 'node:crypto';
import { connectorBrowserOwner } from './connector-browser-owner.mjs';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const fields = {
  origin: { ...text(2000), description: 'Exact HTTPS origin, without path, query, fragment or embedded credentials.' },
  loginOrigin: { ...text(2000), description: "Exact HTTPS SSO login origin for the selected saved account, for example https://login.example.com. associate stores or removes this origin; fill then uses it as origin." },
  operation: { type: 'string', enum: ['allow', 'remove'] },
  username: { type: 'string', maxLength: 320 }, label: { type: 'string', maxLength: 160 },
  requestId: { ...text(100), pattern: '^[A-Za-z0-9_-]+$', description: "Stable ID for one credential action. Reuse it with identical inputs to recover an uncertain result." },
  length: { type: 'integer', minimum: 16, maximum: 128 },
  password: { ...text(1024), description: "Password supplied to save/update. list and generate do not return password text." },
  expectedRevision: { type: 'integer', minimum: 0, description: 'Current vaultRevision returned by list. A stale revision never overwrites newer data.' },
  credentialId: text(200), revision: { type: 'integer', minimum: 1 },
  browser: { type: 'string', enum: ['relay'], default: 'relay', description: 'The contained BLACKICE browser. Fill defaults to relay when browser is omitted.' }, tabId: text(200), expectedUrl: text(20000), expectedDocumentId: text(200),
  passwordRef: text(500), confirmationRef: text(500), usernameRef: text(500),
  intent: {type:'string',enum:['login','signup']}, submitRef:text(500),
};
const actionFields = {
  associate: ['origin', 'username', 'credentialId', 'revision', 'loginOrigin', 'operation', 'requestId', 'expectedRevision'],
  list: ['origin'], save: ['origin', 'username', 'label', 'password', 'requestId', 'expectedRevision'], update: ['origin', 'username', 'label', 'password', 'requestId', 'expectedRevision', 'credentialId', 'revision'], generate: ['origin', 'username', 'label', 'requestId', 'length'],
  fill: ['origin', 'credentialId', 'revision', 'browser', 'tabId', 'expectedUrl', 'expectedDocumentId', 'passwordRef', 'confirmationRef', 'usernameRef'],
  authenticate: ['origin','credentialId','revision','browser','tabId','expectedUrl','expectedDocumentId','passwordRef','confirmationRef','usernameRef','intent','submitRef','requestId'],
};
const required = { list: ['origin'], generate: ['origin', 'requestId'], fill: ['origin', 'credentialId', 'revision', 'browser', 'tabId', 'expectedUrl', 'expectedDocumentId', 'passwordRef'] };
required.associate = actionFields.associate;
required.save = ['origin', 'password', 'requestId', 'expectedRevision'];
required.update = [...required.save, 'credentialId', 'revision'];
required.authenticate = [...required.fill,'intent','submitRef','requestId'];
const fail = (message, code = 'BROWSER_CREDENTIAL_VALIDATION') => Object.assign(new Error(message), { code });
const invalidCredentialFields = (message, fieldNames) => Object.assign(fail(message), { fieldNames });
const check = signal => { if (signal?.aborted) throw fail('Credential operation was cancelled.', 'ABORT_ERR'); };
const receipt = data => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] });
const metadata = value => Object.fromEntries(['credentialId', 'revision', 'origin', 'username', 'label', 'source', 'createdAt', 'updatedAt', 'loginOrigins'].filter(key => Object.hasOwn(value || {}, key)).map(key => [key, value[key]]));

function normalize(action, value) {
  if (['fill','authenticate'].includes(action) && value && typeof value === 'object' && !Array.isArray(value) && value.browser === undefined) value = { ...value, browser: 'relay' };
  if (!Object.hasOwn(actionFields, action) || !value || typeof value !== 'object' || Array.isArray(value))
    throw fail('Choose a declared credential action.');
  const missing = required[action].filter(key => value[key] === undefined);
  if (missing.length) throw invalidCredentialFields('Supply the required credential fields.', missing);
  if (Object.keys(value).some(key => !actionFields[action].includes(key)))
    throw fail('Remove fields outside this credential action.');
  for (const [key, field] of Object.entries(fields)) {
    if (value[key] === undefined) continue;
    if (field.enum && !field.enum.includes(value[key]))
      throw invalidCredentialFields('Use a supported value for this credential field.', [key]);
    if (field.type === 'string' && (typeof value[key] !== 'string' || value[key].length > field.maxLength || value[key].length < (field.minLength || 0) || /[\u0000-\u001f\u007f]/.test(value[key])) || field.type === 'integer' && (!Number.isSafeInteger(value[key]) || value[key] < field.minimum || field.maximum && value[key] > field.maximum)) throw invalidCredentialFields('A credential field is invalid or outside its supported bounds.', [key]);
  }
  if (value.requestId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(value.requestId)) throw invalidCredentialFields('Use a stable credential request ID of letters, digits, underscores or hyphens.', ['requestId']);
  let site;
  try { site = new URL(value.origin); } catch { throw invalidCredentialFields('Use the exact HTTPS origin of the credential, without a path.', ['origin']); }
  if (site.protocol !== 'https:' || site.username || site.password || value.origin !== site.origin)
    throw invalidCredentialFields('Use the exact HTTPS origin of the credential, without a path.', ['origin']);
  if (action === 'authenticate') { const {intent,submitRef,requestId,...fill}=value; if(!['login','signup'].includes(intent)) throw fail('Choose login or signup.'); return {...browserCredentialTarget(fill),intent,submitRef,requestId}; }
  if (action === 'fill') return browserCredentialTarget(value);
  return { ...value };
}

export const BROWSER_CREDENTIAL_TOOL = Object.freeze({
  type: 'function', name: 'relay_credentials',
  description: "Manage saved website credentials for one exact HTTPS origin.\nlist returns account metadata, credentialId/revision and vaultRevision. generate stores a new password and returns its ID, not password text.\nsave stores a supplied password; update replaces a selected credential. Both need expectedRevision from list and requestId; update also needs credentialId/revision. Omitted username/label preserves it; \"\" clears it. Vault changes do not change the website password.\nassociate adds/removes loginOrigin for the selected account. For fill on that SSO page, pass the associated loginOrigin as origin and the returned revision.\nfill takes credentialId/revision, tabId, expectedUrl, expectedDocumentId and passwordRef; it fills fields without submitting. authenticate adds intent, submitRef and requestId, then submits one same-origin HTTPS POST login/signup. Inspect the destination to see whether sign-in succeeded. Reuse the same requestId and arguments after an uncertain mutation.",
  inputSchema: {
    type: 'object', properties: { action: { type: 'string', enum: Object.keys(actionFields) }, ...fields },
    required: ['action', 'origin'], additionalProperties: false,
    oneOf: Object.entries(actionFields).map(([action, names]) => ({
      type: 'object', additionalProperties: false,
      required: ['action', ...required[action].filter(key => key !== 'browser')],
      properties: { action: { type: 'string', const: action }, ...Object.fromEntries(names.map(key => [key, fields[key]])) },
    })),
  },
});

export const BROWSER_CREDENTIAL_INSTRUCTIONS = "\n\nWEBSITE CREDENTIALS\nCredential helpers are optional; ordinary browser controls remain available. list supplies vaultRevision for save/update/associate. fill uses the account's credentialId/revision and current browser refs. After associate, fill with origin set to the associated loginOrigin and revision set to the returned revision. Changing the saved account/password clears its SSO associations.\ngenerate stores a password; fill does not submit; authenticate submits the supported same-origin HTTPS POST form. Check the destination for sign-in success. Keep the same requestId and inputs when recovering an uncertain mutation.\n";

async function run(action, input, { vault, browser, ownerId, browserOwner, signal, beforeDispatch }) {
  // Validation happens before vault access or form input. Only this boundary
  // can prove the credential operation was not dispatched.
  let args;
  try { args = normalize(action, input); }
  catch (cause) { if (cause?.code === 'BROWSER_CREDENTIAL_VALIDATION') cause.actionDispatched = false; throw cause; }
  check(signal);
  const status = await vault?.status?.(); check(signal);
  if (status?.available !== true || status?.healthy === false) throw fail('Protected credential storage is unavailable. No credential action ran.', 'BROWSER_CREDENTIAL_UNAVAILABLE');
  if (beforeDispatch) await beforeDispatch({ signal, action }); check(signal);
  if (action === 'list') {
    const entries = await vault.list({ origin: args.origin }); check(signal);
    if (beforeDispatch) await beforeDispatch({ signal, action }); check(signal);
    return { origin: args.origin, vaultRevision: status.revision, credentials: entries.filter(entry => entry.origin === args.origin || entry.loginOrigins?.includes(args.origin)).map(metadata) };
  }

  if (action === 'associate') {
    if (typeof ownerId !== 'string' || !ownerId || typeof beforeDispatch !== 'function') throw fail('Association requires trusted authorization.', 'BROWSER_CREDENTIAL_ASSOCIATION_AUTHORITY');
    const { expectedRevision, ...association } = args;
    const value = await vault.associate(association, { source: 'agent', ownerId: 'tool_' + createHash('sha256').update(ownerId).digest('hex'), expectedRevision, signal, beforeCommit: beforeDispatch }); check(signal);
    return { ...metadata(value), vaultRevision: value.vaultRevision, existing: value.existing === true, associated: args.operation === 'allow', passwordReturned: false };
  }
  if (action === 'save' || action === 'update') {
    if (typeof ownerId !== 'string' || !ownerId || typeof beforeDispatch !== 'function') throw fail('Authorized agent saves require a trusted request owner and current authorization.', 'BROWSER_CREDENTIAL_SAVE_AUTHORITY');
    const trustedOwner = 'tool_' + createHash('sha256').update(ownerId).digest('hex');
    const { expectedRevision, ...saved } = args;
    const value = await vault.save(saved, { source: 'agent', ownerId: trustedOwner, expectedRevision, signal, beforeCommit: beforeDispatch }); check(signal);
    return { ...metadata(value), vaultRevision: value.vaultRevision, existing: value.existing === true, saved: true, passwordReturned: false };
  }
  if (action === 'generate') {
    if (typeof ownerId !== 'string' || !ownerId) throw fail('A trusted credential request owner is required.');
    const trustedOwner = 'tool_' + createHash('sha256').update(ownerId).digest('hex');
    const value = await vault.generate({ ...args, username: args.username || '' }, { ownerId: trustedOwner, signal, ...(beforeDispatch ? { beforeCommit: beforeDispatch } : {}) }); check(signal);
    return { ...metadata(value), vaultRevision: value.vaultRevision, existing: value.existing === true, saved: true, passwordReturned: false };
  }
  if (!containedBrowserAvailable(browser?.status?.()) || typeof browser.fillCredential !== 'function') throw fail('The contained credential browser is unavailable.', 'BROWSER_CREDENTIAL_UNAVAILABLE');
  if(action==='authenticate') {
    if(typeof ownerId!=='string'||!ownerId||typeof browser.authenticateCredential!=='function'||typeof beforeDispatch!=='function') throw fail('Scoped authentication is unavailable.','BROWSER_CREDENTIAL_AUTH_AUTHORITY');
    const trustedOwner='auth_'+createHash('sha256').update(ownerId||'').digest('hex');
    return browser.authenticateCredential(args,{vault,owner:browserOwner,ownerId:trustedOwner,signal,source:'agent',beforeDispatch});
  }
  return browser.fillCredential(args, { vault, owner: browserOwner, signal, source: 'agent', beforeDispatch });
}

export function createBrowserCredentialToolHandler({ vault, browser, ownerId, browserOwner, signal, onEvent = () => {}, beforeDispatch } = {}) {
  return async (call, context = {}) => {
    const signals = [signal, context.signal].filter(Boolean), active = signals.length ? AbortSignal.any(signals) : undefined;
    let started = false;
    try {
      check(active);
      if (call?.name !== BROWSER_CREDENTIAL_TOOL.name) throw fail('Unknown credential tool.');
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('Use declared credential arguments.');
      const { action, ...input } = args;
      onEvent({ type: 'browser.credential', action: ['list', 'generate', 'save', 'update', 'associate', 'fill', 'authenticate'].includes(action) ? action : 'invalid' });
      started = true;
      return receipt(await run(action, input, { vault, browser, ownerId, browserOwner, signal: active, beforeDispatch }));
    } catch (error) {
      const saveErrors = { CREDENTIAL_ACCOUNT_MISMATCH: 'The selected saved account does not match origin and username. List the original account and use its exact credential ID; do not substitute another account on the same SSO host.', CREDENTIAL_ORIGIN_MISMATCH: 'This account has no association for that login origin. For an authorized SSO redirect, associate the selected account with the exact destination, then fill using the returned revision.', CREDENTIAL_REVISION_CONFLICT: 'Saved credentials changed. List the site again and review its current vaultRevision and credential revision before saving.', CREDENTIAL_EXISTS: 'This site and username already have a saved login. List the site and use update with the exact credential revision if replacement is intended.', CREDENTIAL_REQUEST_CONFLICT: 'This requestId was used with different inputs. Recover the earlier result before starting a new save.' };
      const saveError = saveErrors[error?.code];
      if (saveError && !active?.aborted) return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ code: error.code, error: saveError }) }] };
      // Only this preparation error establishes that filling/dispatch never began.
      // Do not generalize this recovery to uncertain renderer or network errors.
      if (error?.code === 'BROWSER_CREDENTIAL_AUTH_UNSUPPORTED' && !active?.aborted)
        return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({
          code: error.code, submissionRequested: false,
          error: 'This helper cannot submit this form. Use credential fill, then ordinary browser controls for additional fields and submission. No authentication submission was attempted.'
        }) }] };
      const code = active?.aborted ? 'ABORT_ERR' : /^BROWSER_CREDENTIAL_[A-Z_]+$/.test(error?.code || '') ? error.code : 'BROWSER_CREDENTIAL_FAILED';
      const rejectedBeforeDispatch = !started || error?.code === 'BROWSER_CREDENTIAL_VALIDATION' && error.actionDispatched === false;
      const fieldNames = rejectedBeforeDispatch && error?.fieldNames;
      const noDispatch = rejectedBeforeDispatch || code === 'BROWSER_CREDENTIAL_USERNAME_UNAVAILABLE' && error.actionDispatched === false;
      const text = fieldNames ? error.message : rejectedBeforeDispatch
        ? 'The credential request was rejected by validation before storage or browser submission. Correct its declared fields and use a fresh stable request ID when changing those inputs.'
        : active?.aborted ? 'Credential operation was cancelled. Inspect the current page before repeating.'
          : code === 'BROWSER_CREDENTIAL_USERNAME_UNAVAILABLE'
            ? 'The saved account has no username. Fill that field separately or select an account that includes it.'
            : code === 'BROWSER_CREDENTIAL_FILL_UNCONFIRMED'
              ? 'Credential filling could not be confirmed. Inspect the current fields before retrying. This fill operation requested no submission.'
              : 'The credential operation could not be completed safely. Inspect its durable receipt and current page before retrying; do not assume an authentication submission was absent.';
      return {success:false,code,...(noDispatch?{actionDispatched:false}:{}),
        contentItems:[{type:'inputText',text:JSON.stringify({code,error:text,
          ...(fieldNames?{fields:fieldNames}:{}),...(noDispatch?{actionDispatched:false}:{})})}]};
    }
  };
}

export function createDirectBrowserCredentialTools({ vault, browser, reauthorize, resolveBrowserConversationOwner } = {}) {
  if (typeof reauthorize !== 'function') throw fail('Direct credential tools require fresh host authorization.');
  return ['list', 'generate', 'save', 'update', 'associate', 'fill', 'authenticate'].map(action => {
    const scope = action === 'list' ? 'browser:read' : 'browser:write';
    const allowed = [...new Set(['requestId', ...actionFields[action], ...(['fill','authenticate'].includes(action) ? ['conversationId'] : [])])];
    return {
      definition: {
        name: 'blackice_credentials_' + action,
        description: action === 'associate' ? "Add or remove one exact SSO loginOrigin for a saved credential. Requires origin, username, credentialId/revision, expectedRevision from list, operation and requestId. For fill, pass the associated loginOrigin as origin and the returned revision. The password is not copied or returned." : ['save','update'].includes(action) ? "Store a supplied website password in the local vault using expectedRevision from list and a stable requestId. update also needs credentialId/revision. This changes the vault entry, not the website password, and does not submit a form." : action === 'authenticate' ? "Fill the selected credential revision and submit one same-origin HTTPS POST login/signup. Use current field refs, submitRef, intent and requestId. Reuse identical inputs after uncertainty; inspect the destination to check whether authentication succeeded." : action === 'list' ? "List saved account metadata and vaultRevision for one exact HTTPS origin. Password text is omitted." : action === 'generate' ? "Generate and store an encrypted password for origin using a stable requestId. Returns credentialId/revision without password text. Reuse the same ID and inputs after an uncertain result." : "Fill the selected credentialId/revision into current password fields on origin. Supply tabId, expectedUrl, expectedDocumentId and passwordRef. This fills fields without submitting and returns no password text.",
        scope, requiredScopes: [scope], mutating: action !== 'list',
        annotations: { readOnlyHint: action === 'list', destructiveHint: false, idempotentHint: true, openWorldHint: ['fill','authenticate'].includes(action) },
        inputSchema: { type: 'object', properties: Object.fromEntries(allowed.map(key => [key, key === 'conversationId' ? { ...text(200), description: 'Use the same saved conversationId as the browser calls for this tab.' } : fields[key]])), required: [...new Set(['requestId', ...required[action]])], additionalProperties: false },
      },
      async execute(value, { client, signal } = {}) {
        const resolveOwner = async () => {
          if (value?.conversationId === undefined) return connectorBrowserOwner(client?.id);
          if (!['fill','authenticate'].includes(action) || typeof resolveBrowserConversationOwner !== 'function') throw fail('The selected browser conversation is unavailable.', 'BROWSER_CREDENTIAL_VALIDATION');
          const owner = await resolveBrowserConversationOwner(value.conversationId);
          if (!owner?.taskId || !owner.conversationId || owner.nodeId !== 'conversation') throw fail('The selected browser conversation is unavailable.', 'BROWSER_CREDENTIAL_VALIDATION');
          return { ...owner, allowUserTabs: false };
        };
        const authorize = async ({ signal: active = signal } = {}) => { check(active); await reauthorize(client, { scopes: [scope], signal: active }); if (value?.conversationId !== undefined) await resolveOwner(); check(active); };
        await authorize();
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || typeof value.requestId !== 'string' || !value.requestId || value.requestId.length > 100) throw fail('Use declared direct credential arguments.');
        const input = { ...value }; if (!['generate','save','update','associate','authenticate'].includes(action)) delete input.requestId;
        delete input.conversationId;
        const handler = createBrowserCredentialToolHandler({ vault, browser, ownerId: typeof client?.id === 'string' ? 'oauth:' + client.id : '', browserOwner: await resolveOwner(), signal, beforeDispatch: authorize });
        return handler({ name: BROWSER_CREDENTIAL_TOOL.name, arguments: { action, ...input } });
      },
    };
  });
}
