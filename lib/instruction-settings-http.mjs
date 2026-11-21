// The ordinary model/connector API exposes no Instructions mutation. This route
// is reached only after the server's local session, Host and Origin checks.
// Same-user unrestricted shell or frontend-development authority is a different
// boundary; an HTTP cookie is not proof of a physical human interaction.
export async function handleInstructionSettingsHttp({ req, res, pathname, store, body, json, mutate = action => action(), onChange = () => {} }) {
  const match = /^\/api\/instructions\/core(?:\/(versions)(?:\/(0|[1-9]\d*))?)?$/.exec(pathname);
  if (!match) return false;
  try {
  if (req.method === 'GET') {
    const value = match[2] !== undefined ? await store.readVersion(Number(match[2]))
      : match[1] ? await store.versions() : await store.read();
    json(res, 200, value); return true;
  }
  if (req.method !== 'PUT' || match[1]) { json(res, 405, { error: 'Read saved Instructions or save the current editor content.' }); return true; }
  if (Object.hasOwn(req.headers, 'x-blackice-remote')) {
    json(res, 403, { error: 'Edit Instructions in Config on this computer.', code: 'INSTRUCTIONS_LOCAL_REQUIRED' }); return true;
  }
  const value = await body(req);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['content', 'expectedRevision', 'expectedHash'].includes(key))) {
    json(res, 400, { error: 'Save content with its expectedRevision and expectedHash.', code: 'INSTRUCTIONS_INVALID' }); return true;
  }
  const record = await mutate(() => store.update(value));
  onChange({ revision: record.revision, hash: record.hash, source: record.source, characters: record.characters, updatedAt: record.updatedAt });
  json(res, 200, record); return true;
  } catch (error) {
    if (typeof error.code !== 'string' || !/^INSTRUCTIONS_[A-Z_]+$/.test(error.code)) throw error;
    json(res, error.status || 500, { error: error.message, code: error.code }); return true;
  }
}
