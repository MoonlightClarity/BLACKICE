import { serviceTierSupport } from '../public/service-tier-model.mjs';

/** Omission preserves the native or saved choice; Standard is an explicit reset. */
export function serviceTierOf(value) {
  if (value === undefined) return undefined;
  if (!['default', 'fast'].includes(value)) throw Object.assign(new Error('Choose Standard or Fast mode.'), { status: 400, code: 'INVALID_SERVICE_TIER' });
  return value;
}

export function assertServiceTier(status, model, value) {
  const tier = serviceTierOf(value), support = serviceTierSupport(status, model, tier);
  if (!support.available) throw Object.assign(new Error(support.error), { status: 400, code: 'FAST_MODE_UNAVAILABLE' });
  return tier;
}
