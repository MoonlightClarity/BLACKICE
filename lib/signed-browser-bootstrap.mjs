import { createHash } from 'node:crypto';
import { ATTACHMENT_LIMITS, inspectAttachment } from './attachments.mjs';

const EXTENSION_ID = 'pjimfkbpehlcllblajnpfamdfjhhlgkc';
const EXTENSION_NAME = 'BrowserOS neo';
const PREF = 'browseros.automation_never_steals_focus';
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Execute through Neo's documented MCP run/browser.cdp interface, never through
// a second debugging endpoint. The extension owns the existing browser profile.
const extensionExpression = `
(async () => {
  if (chrome.runtime.id !== ${JSON.stringify(EXTENSION_ID)} || chrome.runtime.getManifest().name !== ${JSON.stringify(EXTENSION_NAME)}) return {version:1,ready:false,code:'UNTRUSTED_EXTENSION'};
  const call = (owner, method, ...args) => new Promise((resolve,reject) => owner[method](...args, value => {
    if (chrome.runtime.lastError) reject(new Error('Native browser operation failed.')); else resolve(value);
  }));
  const pref = await call(chrome.browserOS,'getPref',${JSON.stringify(PREF)});
  if (pref?.key !== ${JSON.stringify(PREF)} || pref.type !== 'boolean' || pref.value !== true) return {version:1,ready:false,code:'FOCUS_POLICY_DISABLED'};
  const existing = await call(chrome.windows,'getAll',{populate:false});
  if (!Array.isArray(existing)) return {version:1,ready:false,code:'INVALID_WINDOW_INVENTORY'};
  if (existing.length) return {version:1,ready:true,created:false,policyVerified:true};
  // A native OS window can foreground despite an inactive creation request.
  // Never create, close, restore, or otherwise mutate one during task startup.
  return {version:1,ready:false,created:false,policyVerified:true,code:'NATIVE_WINDOW_REQUIRED'};
})()`;

export const BACKGROUND_WINDOW_BOOTSTRAP_CODE = `
const targets = await browser.cdp('Target.getTargets');
const workers = (targets?.targetInfos || []).filter(target => ['service_worker','background_page'].includes(target.type) && typeof target.url === 'string' && target.url.startsWith('chrome-extension://${EXTENSION_ID}/'));
if (!workers.length) return {version:1,ready:false,code:'EXTENSION_UNAVAILABLE'};
const attached = await browser.cdp('Target.attachToTarget',{targetId:workers[0].targetId,flatten:true});
if (!attached?.sessionId) return {version:1,ready:false,code:'EXTENSION_UNAVAILABLE'};
try {
  const evaluated = await browser.cdp('Runtime.evaluate',{expression:${JSON.stringify(extensionExpression)},awaitPromise:true,returnByValue:true},attached.sessionId);
  if (evaluated?.exceptionDetails) return {version:1,ready:false,code:'NATIVE_API_UNAVAILABLE'};
  return evaluated?.result?.value || {version:1,ready:false,code:'NATIVE_API_UNAVAILABLE'};
} finally {
  try { await browser.cdp('Target.detachFromTarget',{sessionId:attached.sessionId}); } catch {}
}`;

const reasons = {
  UNTRUSTED_EXTENSION: 'BrowserOS neo could not verify its own background extension. No browser window was opened.',
  FOCUS_POLICY_DISABLED: 'BrowserOS neo requires its never-steal-focus setting before background tasks can start. Its settings were preserved.',
  EXTENSION_UNAVAILABLE: 'BrowserOS neo is connected, but its native background extension is not ready. Retry the task when it reconnects.',
  INVALID_WINDOW_INVENTORY: 'BrowserOS neo could not check its existing windows. They were left untouched.',
  NATIVE_WINDOW_REQUIRED: 'BrowserOS neo has no existing native browser window. BLACKICE will not open one automatically. Use the contained BLACKICE browser in Observe to work without opening Neo, or explicitly open your signed-in Neo window yourself before choosing Neo.',
  NATIVE_API_UNAVAILABLE: 'BrowserOS neo could not check its existing native browser workspace.',
};

function runValue(result) {
  if (!object(result) || result.isError) return null;
  if (object(result.structuredContent)) return result.structuredContent;
  for (const item of result.content || []) if (item?.type === 'text' && typeof item.text === 'string' && item.text.length <= 16384) {
    try { const parsed = JSON.parse(item.text); if (object(parsed)) return parsed; } catch {}
  }
  return null;
}

/** Read-only native admission. No task or passive check creates or changes a window. */
export async function prepareSignedBrowserWindow({ connections, status, signal, timeoutMs = 8000 } = {}) {
  const client = connections?.clients?.get?.(status?.connectionId);
  const run = client?.tools?.find(tool => tool.name === 'run' && tool.inputSchema?.properties?.code?.type === 'string');
  // An unverified SDK must not bypass the native focus-policy prerequisite.
  if (!run || !/browser\.cdp\s*\(/.test(run.description || '')) return { ready: false, supported: false, created: false, reason: 'BrowserOS neo cannot verify its background focus policy with this tool catalog. Update or reconnect BrowserOS neo before starting a browser task.' };
  const budget = Math.max(100, Math.min(15000, timeoutMs));
  const active = AbortSignal.any([AbortSignal.timeout(budget), ...(signal ? [signal] : [])]);
  if (active.aborted) return { ready: false, supported: true, created: false, reason: 'Background browser preparation was cancelled.' };
  try {
    const result = await client.call('run', { code: BACKGROUND_WINDOW_BOOTSTRAP_CODE, ...(run.inputSchema.properties.timeout ? { timeout: budget } : {}) }, { signal: active });
    const envelope = runValue(result), value = envelope?.ok === true ? envelope.value : null;
    if (active.aborted) throw new Error('Cancelled.');
    if (value?.version === 1 && value.ready === true && value.policyVerified === true && value.created === false) return { ready: true, supported: true, created: false, policyVerified: true };
    if (value?.version === 1 && value.code === 'NATIVE_WINDOW_REQUIRED' && value.policyVerified === true) return { ready: false, supported: true, created: false, policyVerified: true, code: value.code, reason: reasons.NATIVE_WINDOW_REQUIRED };
    return { ready: false, supported: true, created: false, reason: reasons[value?.code] || reasons.NATIVE_API_UNAVAILABLE };
  } catch {
    return { ready: false, supported: true, created: false, reason: active.aborted ? 'Background browser preparation was cancelled or its readiness deadline was reached.' : reasons.NATIVE_API_UNAVAILABLE };
  }
}

/** Compatibility inventory check only; use captureSignedBrowserScreenshot for capture. */
export async function prepareSignedBrowserScreenshot({ connections, connectionId, arguments: args = {}, signal } = {}) {
  const blocked = reason => ({ ready: false, reason: `${reason} Use fresh DOM or accessibility evidence to verify the result. Do not resend a publication because screenshot proof failed.` });
  if (!Number.isSafeInteger(args.page) || args.page < 0) return blocked('Background screenshot requires an observed page id.');
  if (args.fullPage === true) return blocked('Background screenshots require a bounded viewport; full-page capture is disabled.');
  const size = args.size ?? { width: 1024, height: 768 };
  if (!object(size) || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 1920 || size.height > 1200) return blocked('Background screenshot size must fit within 1920 by 1200 pixels.');
  const client = connections?.clients?.get?.(connectionId);
  const run = client?.tools?.find(tool => tool.name === 'run' && tool.inputSchema?.properties?.code?.type === 'string' && /browser\.pages\.list\s*\(/.test(tool.description || ''));
  if (!run) return blocked('BrowserOS neo cannot verify the screenshot target window through its documented SDK.');
  const code = `const pages=await browser.pages.list();const page=Array.isArray(pages)?pages.find(item=>item.pageId===${args.page}):null;if(!Number.isSafeInteger(page?.windowId))return {version:1,ready:false,code:'UNKNOWN_WINDOW'};const inventory=await browser.windows({action:'list'});const window=inventory?.windows?.find(item=>item.windowId===page.windowId);return {version:1,ready:window?.isActive===false&&window?.bounds?.windowState==='normal',code:window?.bounds?.windowState==='minimized'?'MINIMIZED_WINDOW':'UNSAFE_WINDOW'};`;
  const active = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
  try {
    const result = await connections.call(connectionId, 'run', { code, ...(run.inputSchema.properties.timeout ? { timeout: 5000 } : {}) }, { signal: active });
    const envelope = runValue(result), value = envelope?.ok === true ? envelope.value : null;
    if (active.aborted || value?.version !== 1 || value.ready !== true) return blocked(value?.code === 'MINIMIZED_WINDOW' ? 'Screenshot was blocked because its browser window is minimized. BLACKICE will not restore or activate it.' : 'Screenshot was blocked because its browser window is not confirmed normal and inactive.');
    return { ready: true, arguments: { ...args, fullPage: false, size: { width: size.width, height: size.height } } };
  } catch { return blocked('BrowserOS neo could not verify the screenshot target window.'); }
}

// Leave room for the MCP envelope beneath its 12 MiB transport limit.
const CAPTURE_BYTES = Math.min(ATTACHMENT_LIMITS.fileBytes, 8 * 1024 * 1024);
const CAPTURE_BASE64 = Math.ceil(CAPTURE_BYTES / 3) * 4;
const captureFailure = message => Object.assign(new Error(`${message} Use fresh DOM or accessibility evidence instead; do not repeat a publication because screenshot proof failed.`), { code: 'BROWSER_BACKGROUND_CAPTURE' });

function captureOptions(args) {
  if (!object(args) || !Number.isSafeInteger(args.page) || args.page < 0 || args.page > 0xffffffff) throw captureFailure('Background screenshot requires an observed page id.');
  if (args.fullPage != null && args.fullPage !== false) throw captureFailure('Full-page capture is disabled for background screenshots.');
  if (args.annotate != null && args.annotate !== false) throw captureFailure('Background capture does not add page overlays.');
  const size = args.size ?? { width: 1024, height: 768 }, format = args.format ?? 'jpeg', quality = args.quality ?? 80;
  if (!object(size) || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 1920 || size.height > 1200) throw captureFailure('Background screenshot size must fit within 1920 by 1200 pixels.');
  if (!['jpeg', 'png', 'webp'].includes(format) || !Number.isInteger(quality) || quality < 0 || quality > 100) throw captureFailure('Choose PNG, JPEG or WebP with a whole-number quality from zero to 100.');
  if (args.session !== undefined && (typeof args.session !== 'string' || !args.session.length || args.session.length > 2000)) throw captureFailure('The BrowserOS session handle is invalid.');
  return { page: args.page, size: { width: size.width, height: size.height }, format, quality, ...(args.session !== undefined ? { session: args.session } : {}) };
}

/** Only validated scalar options enter this fixed broker program. No agent code runs here. */
function captureCode(options) {
  return `
const requested=${JSON.stringify({ page: options.page, size: options.size, format: options.format, quality: options.quality })};
const pages=await browser.pages.list();
const matches=Array.isArray(pages)?pages.filter(item=>item.pageId===requested.page):[];
const page=matches.length===1?matches[0]:null;
if(!page||page.ownership!=='mine'||!Number.isSafeInteger(page.windowId)||typeof page.targetId!=='string'||!page.targetId||page.targetId.length>200)return {version:1,ready:false,code:'UNKNOWN_TARGET'};
const safeWindow=async()=>{
  const inventory=await browser.windows({action:'list'});
  const windows=Array.isArray(inventory?.windows)?inventory.windows.filter(item=>item.windowId===page.windowId):[];
  return windows.length===1&&windows[0].isActive===false&&windows[0].bounds?.windowState==='normal';
};
const safeTarget=async()=>{
  const currentPages=await browser.pages.list();
  const current=Array.isArray(currentPages)?currentPages.filter(item=>item.pageId===requested.page):[];
  return current.length===1&&current[0].targetId===page.targetId&&current[0].windowId===page.windowId&&current[0].ownership==='mine'&&await safeWindow();
};
if(!(await safeWindow()))return {version:1,ready:false,code:'UNSAFE_WINDOW'};
const attached=await browser.cdp('Target.attachToTarget',{targetId:page.targetId,flatten:true});
if(typeof attached?.sessionId!=='string'||!attached.sessionId)return {version:1,ready:false,code:'ATTACH_FAILED'};
try {
  const metrics=await browser.cdp('Page.getLayoutMetrics',{},attached.sessionId);
  const viewport=metrics?.cssVisualViewport;
  if(!viewport||![viewport.pageX,viewport.pageY,viewport.clientWidth,viewport.clientHeight].every(Number.isFinite)||viewport.pageX<0||viewport.pageY<0||viewport.clientWidth<1||viewport.clientHeight<1)return {version:1,ready:false,code:'INVALID_VIEWPORT'};
  // The viewport is in CSS pixels; capture output uses device pixels. Read the
  // page's scale without resizing or changing its device metrics.
  const ratioResult=await browser.cdp('Runtime.evaluate',{expression:'window.devicePixelRatio',returnByValue:true},attached.sessionId);
  const ratio=ratioResult?.result?.value;
  if(ratioResult?.exceptionDetails||!Number.isFinite(ratio)||ratio<0.25||ratio>8)return {version:1,ready:false,code:'INVALID_SCALE'};
  const clip={x:viewport.pageX,y:viewport.pageY,width:Math.min(requested.size.width,Math.floor(viewport.clientWidth)),height:Math.min(requested.size.height,Math.floor(viewport.clientHeight)),scale:1/ratio};
  if(!(await safeTarget()))return {version:1,ready:false,code:'TARGET_CHANGED'};
  const image=await browser.cdp('Page.captureScreenshot',{format:requested.format,...(requested.format==='jpeg'?{quality:requested.quality}:{}),fromSurface:true,captureBeyondViewport:false,clip},attached.sessionId);
  if(typeof image?.data!=='string'||!image.data.length||image.data.length>${CAPTURE_BASE64})return {version:1,ready:false,code:'INVALID_IMAGE'};
  if(!(await safeTarget()))return {version:1,ready:false,code:'TARGET_CHANGED'};
  return {version:1,ready:true,page:requested.page,windowId:page.windowId,format:requested.format,data:image.data};
} finally {
  try { await browser.cdp('Target.detachFromTarget',{sessionId:attached.sessionId}); } catch {}
}`;
}

// Screenshots are larger than the small readiness envelopes accepted by runValue.
// Bound text before parsing and still validate the decoded image independently.
function captureRunValue(result) {
  if (!object(result) || result.isError) return null;
  if (object(result.structuredContent)) return result.structuredContent;
  for (const item of (result.content || []).slice(0, 8)) if (item?.type === 'text' && typeof item.text === 'string' && item.text.length <= CAPTURE_BASE64 + 8192) {
    try { const parsed = JSON.parse(item.text); if (object(parsed)) return parsed; } catch {}
  }
  return null;
}

/** Capture without Neo's restore-capable screenshot wrappers or any window mutation. */
export async function captureSignedBrowserScreenshot({ connections, connectionId, arguments: args = {}, signal, timeoutMs = 8000 } = {}) {
  const options = captureOptions(args), client = connections?.clients?.get?.(connectionId);
  const run = client?.tools?.find(tool => tool.name === 'run' && tool.inputSchema?.properties?.code?.type === 'string' && /browser\.cdp\s*\(/.test(tool.description || '') && /browser\.pages\.list\s*\(/.test(tool.description || ''));
  if (!run || typeof connections?.call !== 'function') throw captureFailure('BrowserOS neo cannot provide the fixed background capture protocol. Update or reconnect it.');
  const budget = Number.isFinite(timeoutMs) ? Math.max(100, Math.min(15000, Math.floor(timeoutMs))) : 8000;
  const active = AbortSignal.any([AbortSignal.timeout(budget), ...(signal ? [signal] : [])]);
  const cancelled = () => Object.assign(captureFailure('Background capture was cancelled or reached its deadline.'), { name: 'AbortError', code: 'ABORT_ERR' });
  if (active.aborted) throw cancelled();
  try {
    const result = await connections.call(connectionId, 'run', { code: captureCode(options), ...(run.inputSchema.properties.timeout ? { timeout: budget } : {}), ...(options.session !== undefined ? { session: options.session } : {}) }, { signal: active });
    if (active.aborted) throw cancelled();
    const envelope = captureRunValue(result), value = envelope?.ok === true ? envelope.value : null;
    if (value?.version !== 1 || value.ready !== true || value.page !== options.page || !Number.isSafeInteger(value.windowId) || value.format !== options.format) throw captureFailure('BrowserOS neo could not verify the page and its normal inactive window for capture.');
    const data = value.data;
    if (typeof data !== 'string' || !data.length || data.length > CAPTURE_BASE64 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw captureFailure('Background capture returned invalid image data.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > CAPTURE_BYTES || bytes.toString('base64') !== data) throw captureFailure('Background capture returned invalid image data.');
    const info = inspectAttachment(`background.${options.format}`, bytes);
    if (info.kind !== 'image' || info.mime !== `image/${options.format}` || info.width > options.size.width || info.height > options.size.height) throw captureFailure('Background capture did not match its requested image bounds or format.');
    if (active.aborted) throw cancelled();
    return { content: [{ type: 'image', mimeType: info.mime, data }], structuredContent: { backgroundCapture: { page: options.page, windowId: value.windowId, mimeType: info.mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: info.width, height: info.height, fullPage: false, method: 'fixed-cdp-viewport' } } };
  } catch (cause) {
    if (active.aborted) throw cancelled();
    if (cause.code === 'BROWSER_BACKGROUND_CAPTURE') throw cause;
    throw captureFailure('BrowserOS neo could not complete its nonactivating background capture.');
  }
}
