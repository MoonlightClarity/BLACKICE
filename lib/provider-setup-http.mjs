const tools = Object.freeze({ read: 'blackice_provider_read', configure: 'blackice_provider_configure', import_key: 'blackice_provider_import_key' });
const failure = message => ({ status: 400, body: { error: message, code: 'PROVIDER_SETUP_ARGUMENTS' } });

/** Called only after the server's existing local-session/Origin checks. */
export async function providerSetupHTTP({ directExecution, client, pathname, method, remote = false, value, query = new URLSearchParams() } = {}) {
  const command = pathname === '/api/providers/setup', job = /^\/api\/providers\/setup\/jobs\/(direct_[a-f0-9]{64})$/.exec(pathname || '');
  if (!command && !job) return null;
  if (remote) return { status: 403, body: { error: 'Use the authenticated provider tools for remote setup.', code: 'PROVIDER_SETUP_LOCAL_SESSION_REQUIRED' } };
  if (command) {
    if (method !== 'POST') return { status: 405, body: { error: 'Use POST for provider setup commands.' } };
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['tool', 'arguments'].includes(key)) || !Object.hasOwn(tools, value.tool)
      || !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) return failure('Choose read, configure, or import_key and its declared arguments.');
    return { status: 200, body: await directExecution.call(tools[value.tool], value.arguments, client) };
  }
  if (method !== 'GET') return { status: 405, body: { error: 'Use GET to inspect a provider setup job.' } };
  const offset = Number(query.get('offset') || 0), limit = Number(query.get('limit') || 50000);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50000) return failure('Use a nonnegative offset and a result limit from 1 to 50000.');
  return { status: 200, body: await directExecution.getJob(job[1], client, { offset, limit, includeImages: false }) };
}
