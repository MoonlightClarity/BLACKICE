import { CHATGPT_SCOPES } from './chatgpt-mcp-protocol.mjs';

const CREDENTIAL_ERRORS = new Set(['CHATGPT_AUTH_REQUIRED', 'CHATGPT_ACCESS_REVOKED', 'DIRECT_AUTH_REQUIRED']);
const SCOPE_ERRORS = new Set(['CHATGPT_SCOPE_REQUIRED', 'DIRECT_SCOPE_REQUIRED']);

/** A connection challenge is distinct from a website/tool returning HTTP 401 or 403. */
export class ChatGPTGrantChallenge extends Error {
  constructor(message, { code, kind, scopes, bearerError, status, result } = {}) {
    super(message);
    Object.assign(this, { code, kind, scopes: [...scopes], bearerError, status, result });
  }
}

const credentialStatus = req => req.headers.authorization !== undefined ? 401 : 200;
const validClient = client => client && typeof client.id === 'string' && Array.isArray(client.scopes);

/** Reuses the existing OAuth grant; initialization and ordinary requests never create approval state. */
export class ChatGPTGrantAdmission {
  constructor(oauth) { this.oauth = oauth; }

  async authenticate(req, scopes) {
    const client = await this.oauth.authenticateRequest(req);
    if (!validClient(client)) {
      throw new ChatGPTGrantChallenge('Connect your BLACKICE account to use this tool.', {
        code: 'CHATGPT_AUTH_REQUIRED',
        kind: req.headers.authorization !== undefined ? 'invalidBearerChallenges' : 'linkingChallenges',
        scopes, bearerError: 'invalid_token', status: credentialStatus(req),
      });
    }
    if (scopes.some(scope => !client.scopes.includes(scope))) {
      throw new ChatGPTGrantChallenge('Grant the required BLACKICE permissions to use this tool.', {
        code: 'CHATGPT_SCOPE_REQUIRED', kind: 'scopeChallenges', scopes,
        bearerError: 'insufficient_scope', status: 200,
      });
    }
    return client;
  }

  async revalidate(req, client, scopes) {
    const current = this.oauth.getClient
      ? await this.oauth.getClient(client.id) : await this.oauth.authenticateRequest(req);
    if (!validClient(current) || current.id !== client.id) {
      const result = { error: 'This connection no longer has the required permissions.', code: 'CHATGPT_ACCESS_REVOKED' };
      throw new ChatGPTGrantChallenge(result.error, {
        code: result.code, kind: 'authorizationLostChallenges', scopes,
        bearerError: 'invalid_token', status: credentialStatus(req), result,
      });
    }
    if (scopes.some(scope => !current.scopes.includes(scope))) {
      const result = {
        error: 'This connection no longer has all permissions required by the action.',
        code: 'CHATGPT_SCOPE_REQUIRED', requiredScopes: [...scopes],
      };
      throw new ChatGPTGrantChallenge(result.error, {
        code: result.code, kind: 'scopeChallenges', scopes,
        bearerError: 'insufficient_scope', status: 200, result,
      });
    }
    return current;
  }

  fromToolError(error, req, requiredScopes, result) {
    const credentialFailure = error.status === 401 && CREDENTIAL_ERRORS.has(error.code);
    const scopeFailure = error.status === 403 && SCOPE_ERRORS.has(error.code);
    if (!credentialFailure && !scopeFailure) return null;
    const scopes = [...new Set([
      ...requiredScopes,
      ...(Array.isArray(error.requiredScopes) ? error.requiredScopes : []),
      ...(error.scope ? [error.scope] : []),
    ])].filter(scope => CHATGPT_SCOPES.includes(scope));
    return new ChatGPTGrantChallenge(error.message, {
      code: error.code,
      kind: credentialFailure ? 'authorizationLostChallenges' : 'scopeChallenges',
      scopes, bearerError: credentialFailure ? 'invalid_token' : 'insufficient_scope',
      status: credentialFailure ? credentialStatus(req) : 200, result,
    });
  }
}
