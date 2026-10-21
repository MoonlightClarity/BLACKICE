const text = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const amount = value => Number.isSafeInteger(value) && value >= 0;
const unique = (items, key) => {
  const counts = new Map();
  for (const item of items) counts.set(item[key], (counts.get(item[key]) || 0) + 1);
  return items.filter(item => counts.get(item[key]) === 1);
};

/** Only verified private sessions are actionable. Terminal receipts remain visible as history. */
export function applicationSessionModel(status = {}, selectedId = null) {
  if (!status || typeof status !== 'object') status = {};
  const supportedApps = unique((Array.isArray(status.supportedApps) ? status.supportedApps : []).filter(app => identity(app?.appId)), 'appId').map(app => ({ appId: app.appId, name: text(app.name, 200) || app.appId, description: text(app.description, 400), available: app.available !== false, reason: text(app.reason, 800) }));
  const isolated = status.isolation === 'hidden-desktop' && status.physicalInput === false && status.foregroundPolicy === 'isolated-desktop';
  const available = status.available === true && isolated;
  const sessions = unique((Array.isArray(status.sessions) ? status.sessions : []).filter(session => identity(session?.id) && (session.isolated === true || ['closed', 'failed', 'interrupted'].includes(session.state))), 'id').map(session => ({ id: session.id, isolated: session.isolated === true, name: text(session.name, 200) || 'Application session', appId: text(session.appId, 200), applicationName: text(session.applicationName, 200), state: text(session.state, 40) || 'unknown', reason: text(session.reason || session.error, 800), output: text(session.output || session.stderr, 6000), controlsAvailable: session.controlsAvailable === true, busy: session.busy === true, diagnostics: applicationSessionDiagnostics(session.diagnostics), lastSavedDocument: applicationSavedDocument(session.lastSavedDocument) }));
  const documents = unique((Array.isArray(status.documents) ? status.documents : []).map(applicationSavedDocument).filter(Boolean), 'id');
  const documentStorage = { healthy: status.documentStorage?.healthy === true, error: text(status.documentStorage?.error, 800), count: documents.length, maxDocuments: amount(status.documentStorage?.maxDocuments) ? status.documentStorage.maxDocuments : null };
  const selected = sessions.find(session => session.id === selectedId) || (!selectedId ? sessions.find(session => session.id === status.activeSessionId) || sessions.at(-1) : null) || null;
  const blocked = status.acceptingActions === false || status.recovery?.required === true;
  const reason = blocked ? text(status.recovery?.message || status.reason, 800) || 'Application sessions are not accepting actions. Inspect the last result before continuing.' : !available ? text(status.reason, 800) || 'Isolated application sessions are not available in this BLACKICE runtime.' : selectedId && !selected ? 'That isolated session is no longer available. Choose another session.' : '';
  return { available, supportedApps, sessions, selected, blocked, compatibility: applicationCompatibilityModel(status.compatibility), busy: status.busy === true || sessions.some(session => session.busy), reason, documents, documentStorage };
}

/** Saved text is an immutable BLACKICE document, independent of a live Windows session. */
export function applicationSavedDocument(value) {
  if (!identity(value?.id) || !hash(value.sha256) || !amount(value.bytes) || !amount(value.characters) || !identity(value.source?.sessionId) || !identity(value.source?.appId)) return null;
  return { id: value.id, title: text(value.title, 200) || 'Saved text', createdAt: text(value.createdAt, 100), sha256: value.sha256, bytes: value.bytes, characters: value.characters, source: { sessionId: value.source.sessionId, appId: value.source.appId, applicationName: text(value.source.applicationName, 200) } };
}

export function applicationSavedText(value, expectedDocument) {
  const metadata = applicationSavedDocument(value?.document), content = value?.document?.text ?? value?.text;
  if (!metadata || metadata.id !== expectedDocument?.id || metadata.sha256 !== expectedDocument.sha256 || typeof content !== 'string' || content.length !== metadata.characters || content.length > 10000 || new TextEncoder().encode(content).length !== metadata.bytes) return null;
  return { ...metadata, text: content };
}

export function applicationEditorVersion(value, sessionId) {
  const editor = value?.editor, content = value?.editorText ?? value?.text;
  if (value?.sessionId !== sessionId || !identity(editor?.ref) || !hash(editor.sha256) || !amount(editor.characters) || !amount(editor.bytes) || typeof content !== 'string' || content.length !== editor.characters || content.length > 10000 || new TextEncoder().encode(content).length !== editor.bytes) return null;
  return { sessionId, ref: editor.ref, sha256: editor.sha256, characters: editor.characters, bytes: editor.bytes, text: content };
}

/** Frames must belong to the selected private session and contain an actual bounded bitmap. */
export function applicationSessionFrame(value, sessionId) {
  if (value?.sessionId !== sessionId) return null;
  const width = value.width ?? value.image?.width, height = value.height ?? value.image?.height;
  const imageUrl = value.imageUrl ?? (value.image?.mimeType && value.image?.data ? `data:${value.image.mimeType};base64,${value.image.data}` : null);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || typeof imageUrl !== 'string' || imageUrl.length > 16 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageUrl)) return null;
  return { sessionId, width, height, imageUrl, capturedAt: text(value.capturedAt, 100), windowId: text(value.windowId, 200) };
}

/** Control names and output are observations, not trusted markup or stored field values. */
export function applicationSessionDocument(value, sessionId) {
  if (value?.sessionId !== sessionId || !Array.isArray(value.controls)) return null;
  const candidates = value.controls.filter(control => identity(control?.ref));
  const controls = unique(candidates, 'ref').slice(0, 200).filter(control => control.enabled === true && control.disabled !== true).map(control => ({ ref: control.ref, name: text(control.name, 300) || text(control.role, 80) || 'Application control', role: text(control.role, 80), writable: control.writable === true, invokable: control.invokable === true }));
  return { sessionId, controls, text: text(value.text, 24000), observedAt: text(value.observedAt, 100), windowId: text(value.windowId, 200), reason: text(value.reason, 800) };
}


export function applicationSessionDiagnostics(value) {
  if(value?.version!==1)return null;
  const count=key=>Number.isSafeInteger(value[key])&&value[key]>=0?value[key]:null;
  return {phase:text(value.phase,80),processes:count('jobTotalProcesses'),active:count('jobActiveProcesses'),windows:count('visibleOwnedWindows'),closed:value.closed===true,cleanupConfirmed:value.closed===true&&value.allObservedProcessesExited===true&&value.jobActiveProcesses===0&&value.diagnosticsIncomplete!==true&&!value.processListTruncated&&!value.windowsTruncated,complete:value.diagnosticsIncomplete!==true&&!value.processListTruncated&&!value.windowsTruncated,exitCodes:[...new Set((Array.isArray(value.processes)?value.processes:[]).filter(p=>p.state==='exited'&&Number.isSafeInteger(p.exitCode)).map(p=>p.exitCode))].slice(0,12)};
}
export function applicationCompatibilityModel(value) {
  if(!value||!Array.isArray(value.apps))return null;
  return {testedAt:text(value.testedAt,40),system:text(value.system,120),scope:text(value.scope,600),note:text(value.note,800),apps:value.apps.slice(0,20).filter(app=>identity(app.id)&&['verified','blocked','not_admitted'].includes(app.result)).map(app=>({id:app.id,name:text(app.name,100),version:text(app.version,60),result:app.result,detail:text(app.detail,700)}))};
}
