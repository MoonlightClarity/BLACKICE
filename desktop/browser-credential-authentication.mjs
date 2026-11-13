// Renderer helper: returns only structure, never credential values.
export function credentialAuthenticationForm(key, args, dispatch = false) {
  try {
    const state = globalThis[key], doc = document;
    if (!state || state.document !== doc || location.origin !== args.origin || top.location.origin !== args.origin) return { valid: false };
    const fields = [args.passwordRef, args.confirmationRef, args.usernameRef].filter(Boolean).map(ref => state.elements.get(ref));
    const submit = state.elements.get(args.submitRef), password = fields[0], form = password?.form;
    if (!form?.isConnected || !submit?.isConnected || submit.form !== form || !['BUTTON','INPUT'].includes(submit.tagName) || submit.type !== 'submit'
      || submit.disabled || submit.matches(':disabled') || fields.some(field => !field?.isConnected || field.form !== form || field.disabled || field.readOnly || field.ownerDocument !== doc)) return { valid: false };
    const rect = submit.getBoundingClientRect(), style = getComputedStyle(submit);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return { valid: false };
    const action = new URL(submit.hasAttribute('formaction') ? submit.formAction : form.action, location.href);
    const method = (submit.hasAttribute('formmethod') ? submit.formMethod : form.method).toUpperCase();
    const target = submit.hasAttribute('formtarget') ? submit.formTarget : form.target;
    if (action.origin !== args.origin || action.protocol !== 'https:' || action.username || action.password || method !== 'POST' || !['','_self'].includes(target)) return { valid: false };
    // This first supported shape is solely credentials. Additional visible choices
    // or commitments require a distinct reviewed operation, not an auth shortcut.
    for (const field of form.elements) {
      if (fields.includes(field) || field === submit || field.disabled || field.matches(':disabled') || ['submit','button','reset','hidden'].includes(field.type)) continue;
      return { valid: false };
    }
    if (args.intent === 'login' && (args.confirmationRef || password.autocomplete !== 'current-password')) return { valid: false };
    if (args.intent === 'signup' && password.autocomplete !== 'new-password') return { valid: false };
    state.authenticationForms ||= new Map();
    const prior = state.authenticationForms.get(args.requestId);
    const binding = { form, submit, fields, action: action.href, method, target };
    if (!prior) {
      if (dispatch) return { valid: false };
      state.authenticationForms.set(args.requestId, binding);
    } else if (prior.form !== form || prior.submit !== submit || prior.action !== binding.action || prior.method !== method || prior.target !== target || prior.fields.length !== fields.length || prior.fields.some((field,index)=>field !== fields[index]) || prior.used) return { valid: false };
    if (!dispatch) return { valid: true, method, origin: action.origin, intent: args.intent };
    const saved = state.authenticationForms.get(args.requestId);
    saved.used = true; // consume before page code, even if its listener throws
    HTMLFormElement.prototype.requestSubmit.call(form, submit);
    return { valid: true, submissionRequested: true };
  } catch { return { valid: false }; }
}
