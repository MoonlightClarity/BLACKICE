/** Match the configured HTTPS authority and its exact default-port spelling. */
export function matchesHttpsAuthority(authority, publicUrl) {
  if (typeof authority !== 'string' || publicUrl.protocol !== 'https:') return false;
  return authority === publicUrl.host
    || (publicUrl.port === '' && authority === publicUrl.host + ':443');
}
