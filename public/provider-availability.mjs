/** Credential readiness is separate from the user's enabled/disabled choice. */
export function providerCredentialsReady(provider) {
  if (typeof provider?.credentialsReady === 'boolean') return provider.credentialsReady;
  return provider?.requiresApiKey === false || provider?.hasApiKey === true
    || (provider?.headerNames || []).some(name => /^(authorization|api-key|x-api-key)$/i.test(name));
}
export function readyDisabledProvider(status, modelId) {
  if (typeof modelId !== 'string' || /^(?:antigravity|qwen_code)::/.test(modelId)) return null;
  const delimiter = modelId.indexOf('::');
  if (delimiter < 1) return null;
  const id = modelId.slice(0, delimiter), model = modelId.slice(delimiter + 2);
  const provider = (status?.providers || []).find(item => item.id === id);
  return provider?.enabled === false && providerCredentialsReady(provider)
    && (provider.models || []).some(item => item.id === model) ? provider : null;
}
export async function enableProviderConnection(api, provider) {
  if (!provider || !providerCredentialsReady(provider)) throw Error('Add the required API credentials in Settings > Models.');
  if (!provider.updatedAt) throw Error('Refresh connections before enabling this provider.');
  return api('/api/providers/' + encodeURIComponent(provider.id) + '/enable', 'POST', { expectedUpdatedAt: provider.updatedAt });
}
export async function enableProviderForModel(api, status, modelId) {
  const provider = readyDisabledProvider(status, modelId);
  if (!provider) throw Error('Refresh the model list or set up this connection in Settings > Models.');
  await enableProviderConnection(api, provider);
  const fresh = await api('/api/status');
  const model = (fresh.models || []).find(item => (item.id || item.model) === modelId);
  if (model?.available !== true) throw Error(model?.availabilityReason || 'This model is still unavailable. Check its connection in Settings > Models.');
  return fresh;
}
