/** Tool behavior for an independently configured read-only runtime. */
const reads = Object.freeze({
  relay_workspace: ['list', 'read', 'search', 'patch_history'],
  relay_files: ['list', 'read', 'search', 'image', 'read_bytes'],
  relay_apps: ['status', 'inspect', 'screenshot', 'get_text', 'read_document'],
  relay_windows: ['apps', 'status', 'windows', 'receipt', 'dialogs', 'inspect', 'get_text'],
  relay_memory: ['search', 'read'], relay_skills: ['search', 'read'], relay_history: ['search', 'read'],
  relay_credentials: ['list'],
  relay_email: ['status', 'mailboxes', 'list', 'search', 'read', 'drafts', 'get_draft', 'deliveries', 'get_delivery'],
  // Unknown remote tool effects cannot be made read-only by a provider hint.
  relay_connections: ['connections', 'tools'],
  // Navigation and observation stay within the host-enforced task tab scope.
  // Form input, clicks, script-like keys, uploads and credential fills are denied.
  relay_browser: ['tabs', 'open', 'navigate', 'snapshot', 'read', 'screenshot', 'scroll', 'wait', 'back', 'forward', 'reload', 'close', 'downloads', 'suspend'],
  relay_identity: ['read'], relay_prompts: ['list', 'read', 'history'],
  relay_project: ['describe', 'list', 'get', 'ontology', 'methods', 'get_method', 'capabilities'],
  relay_control: ['describe', 'catalog', 'workflow_get', 'observe_get', 'execution_get', 'runtime_get', 'operations_list', 'job_get'],
  relay_desktop: ['windows', 'inspect', 'screenshot'],
});

export function readOnlyToolDenial(call, canWrite = true) {
  if (canWrite !== false) return null;
  let args;
  try { args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments; } catch {}
  // Plan progress is independently constrained by the saved ownership scope.
  if (call?.name === 'relay_task' || call?.name === 'relay_browser_signin' || reads[call?.name]?.includes(args?.action)) return null;
  const message = 'This agent runtime is configured read-only. Inspect and report; file writes, commands, browser input, local email drafts and external connected-tool calls are unavailable. Plan progress remains limited to the assigned scope.';
  return { success: false, code: 'TASK_PLAN_READ_ONLY', contentItems: [{ type: 'inputText', text: JSON.stringify({ code: 'TASK_PLAN_READ_ONLY', message, actionDispatched: false }) }] };
}
