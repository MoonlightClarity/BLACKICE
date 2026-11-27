// Preserve actionable field identities in durable diagnostics without retaining their answers.
export function retainedBrowserText(tool, text) {
  if (tool !== 'relay_browser') return text;
  let page;
  try { page = JSON.parse(text); } catch { return text; }
  if (!Array.isArray(page?.frames)) return text;
  let changed = false;
  for (const frame of page.frames) {
    for (const field of frame?.elements || []) {
      if (!field || typeof field !== 'object' || !Object.hasOwn(field, 'value')) continue;
      if (field.type === 'password' || /one.time|verification code|security code|\botp\b/i.test(field.name || '')) {
        delete field.value;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(page) : text;
}
