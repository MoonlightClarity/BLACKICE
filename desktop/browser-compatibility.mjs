import { fileURLToPath } from 'node:url';

const extensionDirectory = fileURLToPath(new URL('./browser-compatibility/', import.meta.url));
const loads = new WeakMap();

// The extension belongs only to the caller's contained session. Cache its
// readiness across driver lifecycles; do not retry an uncertain installation.
export function loadBrowserCompatibility(browserSession) {
  let ready = loads.get(browserSession);
  if (!ready) {
    let timer;
    const loaded = Promise.resolve().then(() => browserSession.extensions.loadExtension(extensionDirectory));
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Contained browser compatibility loading timed out.')), 10000); });
    ready = Promise.race([loaded, deadline]).catch(cause => {
      throw Object.assign(new Error('The contained browser compatibility extension could not be loaded. Remote pages remain blocked; repair the installation and restart BLACKICE.', { cause }), { code: 'BROWSER_COMPATIBILITY_UNAVAILABLE', actionDispatched: false });
    }).finally(() => clearTimeout(timer));
    loads.set(browserSession, ready);
  }
  return ready;
}
