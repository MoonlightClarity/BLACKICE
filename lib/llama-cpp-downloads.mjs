// Discover official binary assets only. Downloading is a separate user gesture;
// this module never downloads, extracts, installs, or executes a runtime.
export const LLAMA_RELEASES = 'https://github.com/ggml-org/llama.cpp/releases';
const API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10';
const error = message => Object.assign(new Error(message), {status: 502, code: 'LLAMA_DOWNLOAD_CATALOG_UNAVAILABLE'});
export async function llamaCppDownloads(fetchImpl = globalThis.fetch) {
  let response;
  try { response = await fetchImpl(API, {headers: {accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(10000), redirect: 'error'}); }
  catch { throw error('Official llama.cpp downloads could not be checked. Try again or use the official releases page.'); }
  if (!response.ok) throw error('Official llama.cpp downloads returned HTTP ' + response.status + '. Try again or use the official releases page.');
  let releases;
  try { releases = await response.json(); } catch { throw error('Official llama.cpp release metadata was unreadable.'); }
  if (!Array.isArray(releases)) throw error('Official llama.cpp release metadata was unexpected.');
  // Stable tags can be pointers with no binaries; choose the newest published
  // release carrying actual runtime archives, and show its exact tag.
  for (const release of releases.slice(0, 10)) {
    if (release.draft || typeof release.tag_name !== 'string') continue;
    const assets = (Array.isArray(release.assets) ? release.assets : []).slice(0, 200).flatMap(asset => {
      const name = asset?.name;
      if (typeof name !== 'string' || name.length > 200 || !/^(?:cudart-)?llama-[a-z0-9._-]+\.(?:zip|tar\.gz)$/i.test(name)) return [];
      let url; try { url = new URL(asset.browser_download_url); } catch { return []; }
      const prefix = '/ggml-org/llama.cpp/releases/download/' + encodeURIComponent(release.tag_name) + '/';
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || url.pathname !== prefix + encodeURIComponent(name)) return [];
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0) return [];
      return [{name, url: url.href, sizeBytes: asset.size, dependency: name.startsWith('cudart-'), sha256: /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7) : null}];
    });
    if (assets.some(asset => !asset.dependency)) return {tag: release.tag_name, prerelease: release.prerelease === true, releasesUrl: LLAMA_RELEASES, assets};
  }
  throw error('No supported binary archives were found in recent official releases. Use the official releases page.');
}
