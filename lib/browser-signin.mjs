/**
 * A durable, nonintrusive website sign-in blocker reported by the agent.
 * Reporting this state never opens a window, collects credentials, or retries.
 */
export const BROWSER_VERIFICATION_GUIDANCE = 'Browser verification: a provider script, branding badge (including a reCAPTCHA badge), or hidden frame alone is not an active challenge. If the normal form controls are enabled and no challenge is shown, use those controls for the authorized task. Report a verification blocker only when the page shows a visible challenge or the site response explicitly requires verification that must be completed before proceeding. If that happens, leave the page for the user when needed; do not solve or bypass the challenge by guessing, and check the outcome before repeating any submit.';

export const BROWSER_SIGNIN_TOOL = Object.freeze({
  type: 'function',
  name: 'relay_browser_signin',
  description: 'Record a remaining sign-in, verification, or website-permission blocker after inspecting the selected site and using authorized supported credential or email-verification workflows. This only records a resumable blocker inside BLACKICE; it never opens or focuses a browser, prompts for credentials, or continues the website action. Identify the actual unsupported prerequisite in the contained BLACKICE profile; keep all website actions in that browser. ' + BROWSER_VERIFICATION_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      site: { type: 'string', maxLength: 600, description: 'The public HTTPS origin or URL of the site that needs the user to act. Do not include credentials, URL queries, or fragments.' },
      reason: { type: 'string', enum: ['sign-in', 'verification', 'permission'], description: 'The obstacle observed on the website.' },
      evidence: { type: 'string', enum: ['login-redirect', 'login-form', 'verification-page', 'permission-message'], description: 'The type of evidence observed. Do not include page content, private text, passwords, or tokens.' },
    },
    required: ['site', 'reason', 'evidence'],
    additionalProperties: false,
  },
});
export const BROWSER_SIGNIN_INSTRUCTIONS = "\n\nWEBSITE SIGN-IN REPORTING\nrelay_browser_signin records a remaining blocker; it does not authenticate, focus a window or resume the website action. First inspect the contained browser and use available credential or email routes. If social login fails, try a visible email alternative. A saved email address alone proves neither an existing site account nor mailbox access. Credential helpers are optional; ordinary browser controls remain available.\nReport the observed prerequisite using the public HTTPS site, matching reason and evidence, without secrets. A recorded blocker pauses site-changing actions on that origin. Read-only inspection, tab handback and independent sites remain available. Inspect the destination after authentication; a sent code does not prove verification. Keep passwords, codes and authentication links out of public notes.\n";
const fail = message => ({success:false,contentItems:[{type:'inputText',text:message}]});
const success = data => ({success:true,contentItems:[{type:'inputText',text:JSON.stringify(data)}]});
const hostnameValid = host => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) && host.length <= 253 && /^[a-z]{2,63}$/.test(host.split('.').at(-1)) && !['local','localhost','internal','test','invalid'].includes(host.split('.').at(-1));
export function normalizeBrowserSignIn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['site','reason','evidence'].includes(key))
      || typeof value.site !== 'string' || value.site.length > 600
      || !['sign-in','verification','permission'].includes(value.reason)
      || !['login-redirect','login-form','verification-page','permission-message'].includes(value.evidence)) throw new Error('Report only a supported website sign-in blocker.');
  // Keep the observed prerequisite type separate from the requested action.
  // An hCaptcha or other verification page is not evidence of a login form.
  const kinds = { 'sign-in': ['login-redirect','login-form'], verification: ['verification-page'], permission: ['permission-message'] };
  if (!kinds[value.reason].includes(value.evidence)) throw new Error('The reported website blocker reason does not match its observed evidence.');
  let url;
  try { url = new URL(value.site); } catch { throw new Error('Choose a public HTTPS website.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.port && url.port !== '443' || !hostnameValid(host)
      || url.origin.length > 300) throw new Error('Use a public HTTPS website without credentials, query, or fragment.');
  return { origin:url.origin,hostname:host,reason:value.reason,evidence:value.evidence };
}

// A website blocker is scoped to the observed prerequisite, not a blanket
// ban on inspecting browser state or returning a tab to the person. Nothing
// here marks a CAPTCHA solved, authenticates an account, or replays a submit.
const BROWSER_OBSERVATIONS = new Set(['tabs','snapshot','read','screenshot','downloads','diagnostics','take_ownership','transfer_ownership']);
const publicOrigin = value => { try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.origin : null; } catch { return null; } };
export function browserBlockerInterruption(blocker, args, status) {
  if (blocker?.status !== 'awaiting-user') return null;
  const action = args?.action;
  if (BROWSER_OBSERVATIONS.has(action) || action === 'protection' && (!args.operation || args.operation === 'status')) return null;
  if (action === 'open' && publicOrigin(args.url) && publicOrigin(args.url) !== blocker.origin) return null;
  // Independent already-observed contained pages remain usable. Unknown
  // targets remain paused; the browser driver still enforces tab ownership.
  if (args?.tabId && Array.isArray(status?.tabs)) {
    const tab = status.tabs.find(item => item.tabId === args.tabId);
    const origin = publicOrigin(tab?.url);
    if (origin && origin !== blocker.origin) return null;
  }
  if (blocker.reason === 'verification') return 'Website verification was reported for ' + blocker.hostname
    + '. Site-changing actions on this challenge remain paused. Inspect the current site or transfer the tab to the person; do not bypass verification or replay an unconfirmed Submit.';
  if (blocker.reason === 'permission') return 'Website permission is required for ' + blocker.hostname
    + '. Browser actions are paused on that site until the permission is resolved; read-only inspection and ownership transfer remain available.';
  return 'Website sign-in was reported for ' + blocker.hostname
    + '. Browser actions are paused on that site until real authentication is completed; read-only inspection and ownership transfer remain available.';
}
/** Read-only recognition of a real alternative to a social-login dialog. */
export function observedEmailAuthAlternative(snapshot) {
  const elements = [...(snapshot?.frames || []).flatMap(frame => frame?.elements || []),
    ...(snapshot?.elements || []), ...(snapshot?.controls || [])];
  const labelIsEmailRoute = /^(?:(?:continue|sign[ -]?in|log[ -]?in|sign[ -]?up|use|choose|register)(?: (?:with|via|using|by))? (?:your |an? )?e-?mail(?: (?:address|instead|link))?|e-?mail(?: (?:sign[ -]?in|log[ -]?in|login|option|instead))?)$/i;
  for (const element of elements) {
    const label = typeof element?.name === 'string' ? element.name.trim() : '';
    if (element?.disabled === true || !['button','link'].includes(element?.role)
      || !labelIsEmailRoute.test(label) || typeof element?.ref !== 'string' || !element.ref) continue;
    return { kind: 'email-sign-in', tabId: snapshot?.tabId || null, label: label.slice(0,100) };
  }
  // LinkedIn-style dialogs commonly start with an "Email or phone" field
  // rather than a distinct "Continue with email" button. Only suggest the
  // address when that field is still empty and this is visibly an auth form.
  const field = elements.find(element => element?.disabled !== true &&
    ['textbox','input'].includes(element?.role || element?.tag?.toLowerCase()) &&
    /^(?:e-?mail(?: address| or phone)?|phone or e-?mail)$/i.test(String(element?.name || '').trim()) &&
    (element?.value === undefined || String(element.value).trim() === ''));
  const authControl = elements.some(element => ['button','link'].includes(element?.role) &&
    /^(?:sign[ -]?in|log[ -]?in)$/i.test(String(element?.name || '').trim()));
  const passwordField = elements.some(element => element?.type === 'password' ||
    /^(?:password|passcode)$/i.test(String(element?.name || '').trim()));
  if (field && (authControl || passwordField))
    return { kind: 'email-sign-in', tabId: snapshot?.tabId || null, label: String(field.name).trim().slice(0,100) };
  return null;
}
export function createBrowserSignInHandler({signal,report,browser='neo',inspectEmailAlternative}={}) {
  if(typeof report!=='function')throw new Error('Browser sign-in reporting is not configured.');
  if(!['neo','relay'].includes(browser))throw new Error('Browser sign-in reporting requires a known task browser.');
  return async function handle(call,{signal:toolSignal}={}){
    if(signal?.aborted||toolSignal?.aborted)return fail('Sign-in reporting was cancelled.');
    if(call?.name!==BROWSER_SIGNIN_TOOL.name)return fail('Unknown browser sign-in tool.');
    let data;
    try{data=normalizeBrowserSignIn(typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments)}
    catch(e){return fail(e.message||'Invalid browser sign-in report.')}
    if(signal?.aborted||toolSignal?.aborted)return fail('Sign-in reporting was cancelled.');
    const contained=browser==='relay';
    if(contained && data.reason==='sign-in' && typeof inspectEmailAlternative==='function'){
      let alternate=null;
      try{alternate=await inspectEmailAlternative(data,{signal:toolSignal||signal});}catch{}
      if(alternate?.kind==='email-sign-in'){
        // No blocker was recorded. This is an observed, reversible next step,
        // never proof of authentication or permission to replay a submission.
        return success({recorded:false,browser:'relay',site:data.hostname,
          emailSignInAvailable:true,optionLabel:alternate.label,tabId:alternate.tabId,
          action:'The current contained page has an email sign-in alternative. Recover the already verified account email from the saved user profile, resume, or prior application; inspect fresh page controls and use this email option before treating social login as a human blocker. Check credentials and an authorized mailbox only if the site requests them. Do not invent a password, treat email ownership as verified, bypass CAPTCHA, or repeat an uncertain Submit.'});
      }
    }
    await report({...data,...(contained?{browser:'relay'}:{})});
    const action = !contained ? 'The selected Neo profile needs human interaction in its native browser. Report the exact next step, then re-inspect prior effects before any submit or publish action.'
      : data.reason === 'verification' ? 'Website verification was reported, not sign-in. Inspect and transfer the contained tab through BLACKICE; the challenge still requires supported verification. Do not bypass the challenge or replay any uncertain submission. Continue independent preparation without connecting Chrome or another external browser.'
      : data.reason === 'permission' ? 'Website permission was reported. Read-only inspection and tab handback remain available in the BLACKICE contained browser. Do not assume approval or replay the blocked action.'
      : 'The contained profile is paused for actual sign-in; the user can sign in inside Observe. Read-only inspection and tab handback remain available. Keep all website work in the BLACKICE contained browser. Complete independent preparation and report the exact remaining prerequisite without connecting Chrome or another external browser. Inspect prior effects before any submit or publish action.';
    return success({recorded:true,site:data.hostname,reason:data.reason,...(contained?{browser:'relay'}:{}),action});
  };
}
