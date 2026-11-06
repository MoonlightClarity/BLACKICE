import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const url = value => { try { const parsed = new URL(value); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null; parsed.hash = ''; return parsed.href; } catch { return null; } };

/** Native form encoding identity. No field values are retained in the journal. */
export function urlencodedFormPayloadDigest(postData) {
  if (typeof postData !== 'string' || postData.length > 524288) return null;
  let pairs;
  try { pairs = postData ? postData.split('&').map(part => {
    const position = part.indexOf('='), name = position < 0 ? part : part.slice(0, position), value = position < 0 ? '' : part.slice(position + 1);
    return [decodeURIComponent(name.replace(/\+/g, ' ')), decodeURIComponent(value.replace(/\+/g, ' '))];
  }) : []; } catch { return null; }
  if (pairs.length > 500 || pairs.some(([name, value]) => name.length > 512 || value.length > 32768)) return null;
  return hash(pairs);
}

export function validNativeSubmissionObservation(value) {
  try { return value?.version === 1 && value.transport === 'document-post' && id(value.operationId) && sha(value.effectKey)
    && sha(value.payloadDigest) && sha(value.requestPayloadDigest) && id(value.sourceDocumentId)
    && id(value.sourceLoaderId) && id(value.documentId) && value.documentId !== value.sourceDocumentId && id(value.frameId) && id(value.loaderId) && value.loaderId !== value.sourceLoaderId
    && id(value.requestId) && value.responseComplete === true && value.method === 'POST' && url(value.requestUrl) === value.requestUrl
    && value.destinationKey === 'destination:' + value.requestUrl && url(value.responseUrl) === value.responseUrl
    && Number.isInteger(value.responseStatus) && value.responseStatus >= 100 && value.responseStatus <= 599
    && Array.isArray(value.redirects) && value.redirects.length <= 10
    && value.redirects.every(item => url(item?.url) === item.url && typeof item.method === 'string' && Number.isInteger(item.status))
    && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 6000; } catch { return false; }
}

/** Host-only observations from the actual CDP request, response and current frame loader. */
export class BrowserSubmissionObservations {
  constructor(saved = []) {
    this.pending = new Map();
    this.completed = (Array.isArray(saved) ? saved : []).filter(validNativeSubmissionObservation).slice(-64).map(value => structuredClone(value));
  }
  arm({ operationId, commit, sourceFrameId, sourceLoaderId, sourceDocumentId }) {
    if (!id(operationId) || !id(sourceFrameId) || !id(sourceLoaderId) || !id(sourceDocumentId)
      || commit?.method !== 'POST' || commit.enctype !== 'application/x-www-form-urlencoded'
      || !['_self', ''].includes(commit.target) || !sha(commit.requestPayloadDigest) || !sha(commit.effectKey) || !sha(commit.payloadDigest)
      || commit.documentKey !== 'document:' + sourceDocumentId || !commit.destinationKey?.startsWith('destination:')
      || url(commit.destinationKey.slice(12)) !== commit.destinationKey.slice(12)) return false;
    if (this.pending.has(operationId)) return true;
    if (this.pending.size >= 64) return false;
    this.pending.set(operationId, { operationId, commit: structuredClone(commit), sourceFrameId, sourceLoaderId, sourceDocumentId,
      request: null, response: null, loaded: false, redirects: [], ambiguous: false });
    return true;
  }
  observe(method, params) {
    if (method === 'Network.requestWillBeSent') {
      const request = params?.request;
      if (!request || params.type !== 'Document' || !id(params.requestId) || !id(params.loaderId) || !id(params.frameId)) return;
      const existing = [...this.pending.values()].filter(item => item.request?.requestId === params.requestId);
      if (params.redirectResponse && existing.length) {
        for (const item of existing) {
          if (item.redirects.length >= 10 || params.loaderId !== item.request.loaderId || params.frameId !== item.sourceFrameId
            || !url(request.url) || !Number.isInteger(params.redirectResponse.status)) { item.ambiguous = true; continue; }
          item.redirects.push({ url: url(request.url), method: request.method, status: params.redirectResponse.status });
          item.response = null; item.loaded = false;
        }
        return;
      }
      if (request.method !== 'POST') return;
      const contentType = Object.entries(request.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
      if (typeof contentType !== 'string' || !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) return;
      const requestUrl = url(request.url), payload = urlencodedFormPayloadDigest(request.postData);
      const matches = [...this.pending.values()].filter(item => item.sourceFrameId === params.frameId && item.sourceLoaderId !== params.loaderId
        && item.commit.destinationKey === 'destination:' + requestUrl && item.commit.requestPayloadDigest === payload);
      if (matches.length !== 1) { for (const item of matches) item.ambiguous = true; return; }
      const item = matches[0];
      if (item.request && item.request.requestId !== params.requestId) { item.ambiguous = true; return; }
      item.request = { requestId: params.requestId, loaderId: params.loaderId, requestUrl, requestPayloadDigest: payload };
    } else if (method === 'Network.responseReceived') {
      for (const item of this.pending.values()) if (item.request?.requestId === params?.requestId) {
        if (params.type !== 'Document' || params.loaderId !== item.request.loaderId || !url(params.response?.url)
          || !Number.isInteger(params.response?.status)) { item.ambiguous = true; continue; }
        item.response = { responseUrl: url(params.response.url), responseStatus: params.response.status };
      }
    } else if (method === 'Network.loadingFinished') {
      for (const item of this.pending.values()) if (item.request?.requestId === params?.requestId) item.loaded = true;
    } else if (method === 'Network.loadingFailed') {
      for (const item of this.pending.values()) if (item.request?.requestId === params?.requestId) item.ambiguous = true;
    }
  }
  current({ frameId, loaderId, documentId, url: documentUrl }) {
    const actualUrl = url(documentUrl);
    for (const [operationId, item] of this.pending) {
      if (item.ambiguous || !item.request || !item.response || !item.loaded || frameId !== item.sourceFrameId
        || loaderId !== item.request.loaderId || actualUrl !== item.response.responseUrl || !id(documentId)) continue;
      const value = { version: 1, transport: 'document-post', operationId, effectKey: item.commit.effectKey,
        destinationKey: item.commit.destinationKey, payloadDigest: item.commit.payloadDigest, requestPayloadDigest: item.request.requestPayloadDigest,
        sourceDocumentId: item.sourceDocumentId, sourceLoaderId: item.sourceLoaderId, documentId, frameId, loaderId,
        requestId: item.request.requestId, responseComplete: true, method: 'POST', requestUrl: item.request.requestUrl, ...item.response, redirects: item.redirects };
      if (validNativeSubmissionObservation(value)) {
        this.completed.push(value); this.completed = this.completed.slice(-64); this.pending.delete(operationId);
      }
    }
    return this.completed.filter(item => item.documentId === documentId && item.frameId === frameId && item.loaderId === loaderId && item.responseUrl === actualUrl).map(value => structuredClone(value));
  }
  saved() { return this.completed.map(value => structuredClone(value)); }
}
