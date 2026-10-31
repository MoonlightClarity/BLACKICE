const invalid = () => Object.assign(new Error('Use an observed contained tab, its exact HTTPS origin and current page identity for provider key setup.'), { code: 'PROVIDER_KEY_SOURCE_INVALID', status: 400 });
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);

/** Values contain source identities only. API-key bytes never enter this contract. */
export function providerKeyTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['inspect', 'click_inspect', 'import'].includes(value.action)
    || Object.keys(value).some(key => !['action', 'browser', 'tabId', 'origin', 'expectedUrl', 'expectedDocumentId', 'ref'].includes(key))
    || value.browser !== 'relay' || !text(value.tabId, 200) || value.tabId.startsWith('firefox:') || !text(value.origin, 2000) || !text(value.expectedUrl, 20000)
    || value.expectedDocumentId !== undefined && !text(value.expectedDocumentId, 200) || value.ref !== undefined && !text(value.ref, 500)) throw invalid();
  if (value.action !== 'inspect' && (!value.expectedDocumentId || !value.ref) || value.action === 'inspect' && value.ref !== undefined) throw invalid();
  let origin, page;
  try { origin = new URL(value.origin); page = new URL(value.expectedUrl); } catch { throw invalid(); }
  if (origin.protocol !== 'https:' || origin.origin !== value.origin || origin.username || origin.password || page.protocol !== 'https:'
    || page.origin !== origin.origin || page.username || page.password) throw invalid();
  return { ...value };
}

export function providerKeyFailure(cause, { clickDispatched = false, importAttempted = false } = {}) {
  const allowed = new Set(['PROVIDER_CHANGED', 'PROVIDER_BUSY', 'PROVIDER_SECRET_STORAGE_UNAVAILABLE', 'DIRECT_AUTH_REQUIRED', 'DIRECT_SCOPE_REQUIRED', 'BROWSER_TAB_OWNERSHIP', 'BROWSER_HUMAN_CHAT_RESERVED', 'PROVIDER_KEY_SOURCE_INVALID', 'PROVIDER_KEY_SOURCE_CHANGED', 'PROVIDER_KEY_SOURCE_EMPTY', 'PROVIDER_KEY_SOURCE_UNAVAILABLE']);
  const code = cause?.name === 'AbortError' || cause?.code === 'ABORT_ERR' ? 'ABORT_ERR' : allowed.has(cause?.code) ? cause.code : 'PROVIDER_KEY_SETUP_UNCONFIRMED';
  const message = code === 'PROVIDER_CHANGED' ? 'This provider connection changed. Inspect its saved configuration before another import.'
    : code === 'PROVIDER_BUSY' ? 'Stop this provider’s active agents before changing its configuration.'
      : code === 'PROVIDER_SECRET_STORAGE_UNAVAILABLE' ? 'Encrypted provider storage is unavailable. No API key was accepted.'
        : code === 'PROVIDER_KEY_SOURCE_EMPTY' ? 'The selected source no longer contains the inspected API key. Inspect the protected fields again.'
          : code === 'PROVIDER_KEY_SOURCE_INVALID' ? invalid().message
            : 'Provider key setup could not be confirmed. Inspect the saved provider and protected source before continuing; do not repeat a possibly completed key-generation click.';
  return Object.assign(new Error(message), { code, status: Number.isInteger(cause?.status) ? cause.status : 409,
    actionDispatched: clickDispatched ? null : false, importAttempted, ...(code === 'ABORT_ERR' ? { name: 'AbortError' } : {}) });
}
