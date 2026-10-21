// A small, release-reviewed set of exact IDs from OpenAI's public model docs.
// This is provenance for discovery, not an account entitlement list. Refreshing
// the native catalog never probes these IDs or changes a saved model selection.
const provenance = Object.freeze({
  url: 'https://learn.chatgpt.com/docs/models', title: 'OpenAI model documentation', checkedAt: '2026-10-18',
});
const current = (model, displayName) => ({ model, displayName, lifecycle: { state: 'current', note: 'Documented model; rollout, sign-in method and workspace access still apply.' } });
const retired = (model, displayName, date, note) => ({ model, displayName, lifecycle: { state: 'retired', date, note } });
const entries = [
  current('gpt-6.1-sol', 'GPT-6.1 Sol'),
  current('gpt-6-astra', 'GPT-6 Astra'),
  current('gpt-6-sol', 'GPT-6 Sol'),
  current('gpt-6-luna', 'GPT-6 Luna'),
  retired('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', '2026-09-14', 'OpenAI reports Spark retired from Codex. An explicit check can report the endpoint response; it does not restore the model.'),
  retired('gpt-5.5', 'GPT-5.5', '2026-10-14', 'Retired from Codex with ChatGPT sign-in. OpenAI says API-key sessions are unaffected.'),
  retired('gpt-5.4', 'GPT-5.4', '2026-08-31', 'Retired from Codex with ChatGPT sign-in. OpenAI says API-key sessions are unaffected.'),
  retired('gpt-5.4-mini', 'GPT-5.4 mini', '2026-08-31', 'Retired from Codex with ChatGPT sign-in. OpenAI says API-key sessions are unaffected.'),
  { model: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', lifecycle: { state: 'deprecated', note: 'OpenAI reports this model deprecated in Codex with ChatGPT sign-in.' } },
  { model: 'gpt-5.2', displayName: 'GPT-5.2', lifecycle: { state: 'deprecated', note: 'OpenAI reports this model deprecated in Codex with ChatGPT sign-in.' } },
];

export function documentedCodexModels() {
  return entries.map(entry => ({ id: entry.model, ...structuredClone(entry), source: 'documented', provenance: { ...provenance } }));
}

export function codexModelCandidates(advertised = [], access = {}) {
  return documentedCodexModels().filter(candidate => !advertised.some(model => model.id === candidate.model || model.model === candidate.model))
    .map(candidate => ({ ...candidate, access: Object.hasOwn(access, candidate.model) ? structuredClone(access[candidate.model]) : { state: 'unverified' } }));
}
