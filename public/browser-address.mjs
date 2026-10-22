const invalidAddress = () => new TypeError('Enter a website address, such as example.com or https://example.com.');

// The address fields and browser commands use the same URL rules. Add a scheme
// only when one was omitted; leave the entered hostname for ordinary DNS lookup.
export function normalizeBrowserAddress(value) {
  const address = typeof value === 'string' ? value.trim() : value instanceof URL ? value.href : '';
  if (!address) throw invalidAddress();
  let url;
  try {
    // A dotted hostname or localhost followed by a numeric port is an address,
    // even though URL() initially interprets the text before ':' as a scheme.
    const hostPort = /^(?:localhost\.?|[^\s/?#:]+\.[^\s/?#:]+):\d+(?=[/?#]|$)/i.test(address);
    if (/^[a-z][a-z\d+.-]*:/i.test(address) && !hostPort) url = new URL(address);
    else {
      if (/^[/?#]/.test(address) && !address.startsWith('//')) throw invalidAddress();
      const authority = address.startsWith('//') ? address : `//${address}`;
      url = new URL(`https:${authority}`);
      const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
      const localOrIP = hostname === 'localhost' || hostname.endsWith('.localhost') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith('[');
      // Parse from the original address again so an explicitly entered :443 is
      // retained when the inferred scheme is HTTP rather than HTTPS.
      if (localOrIP) url = new URL(`http:${authority}`);
    }
  } catch { throw invalidAddress(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Browser pages must use HTTP or HTTPS without embedded credentials.');
  return url.href;
}
