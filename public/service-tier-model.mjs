import { reasoningModel } from './reasoning-model.mjs';
import { isChatModeModel } from './model-routes.mjs';

/** Fast is a separate, advertised native service tier; it does not change reasoning. */
export function serviceTierSupport(status = {}, selection = 'default', tier = 'default') {
  if (tier === undefined || tier === null || tier === 'default') return { available: true, verified: true, error: '' };
  if (tier !== 'fast') return { available: false, verified: true, error: 'Choose Standard or Fast mode.' };
  const resolved = selection === 'default' ? status.defaultModel : selection === 'codex' ? (status.codex || status).defaultModel : selection;
  const model = reasoningModel(status, selection);
  if (isChatModeModel(selection, status) || String(resolved || '').includes('::') || model?.providerId && model.providerId !== 'codex') return { available: false, verified: true, error: 'Fast mode is available only for supported Codex models.' };
  const hasServiceTiers = model?.serviceTiers !== undefined;
  const advertised = hasServiceTiers ? model.serviceTiers : model?.additionalSpeedTiers;
  const tiers = Array.isArray(advertised) ? advertised.map(item => typeof item === 'string' ? item : item?.id) : [];
  // Codex advertises the Fast service as "priority"; BLACKICE keeps "fast" as
  // its authored choice. External providers were excluded above.
  const available = tiers.includes('fast') || hasServiceTiers && tiers.includes('priority');
  return { available, verified: hasServiceTiers || Array.isArray(model?.additionalSpeedTiers), error: available ? '' : 'Fast mode is not reported for this model. Choose Standard or another model.' };
}
