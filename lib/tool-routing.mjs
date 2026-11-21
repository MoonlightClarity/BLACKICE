import { planningModeOf } from './planning-policy.mjs';

export const browserTaskIntent = text => typeof text === 'string' && (/https?:\/\/|www\.|\b(linkedin|website|browser|online|webpage|web page|internet|web search|publish|posting|post on|post to|job search|job applications?|sign[ -]?in|log[ -]?in|sign[ -]?up|signup|account creation|email verification)\b/i.test(text) || /\bapply(?:ing)?\b.{0,100}\b(?:jobs?|roles?|positions?|applications?)\b/i.test(text));

// Only adapter distinctions that are easy to confuse belong here. The actual
// schemas describe operations; SOUL/skills own behavior and task procedures.
const playbooks = {
  relay_agents: 'Inspect actual saved runs and revisions when controlling agents. A start receipt confirms admission, not completion. Preserve the same shared execution state.',
  relay_windows: 'Normal Windows apps use the account\'s real profiles. Inspect current windows and accessibility refs. Launch receipts retain requestId; recover that receipt before starting another copy. Launch/manage does not request focus; applications may still activate their windows.',
  relay_apps: 'Compatibility app sessions isolate windows, not files or accounts. Use status and current controls. Save the requested file at its actual destination; an optional BLACKICE recovery snapshot does not replace it. Ending a session discards unsaved state.',
  relay_project: 'Read the current project and revision when editing it. A saved plan does not execute; inspect actual run results after starting authorized work.',
  relay_control: 'Read actual catalog IDs and workflow revision before editing. Observe presentation fields supply labels/focus, not live evidence. Inspect deployment and trigger receipts.',
  relay_find_files: 'Locate local filenames/paths with a nonempty literal query. Continue the same query with its returned cursor; an empty page is not a completed search. Check searchComplete, skippedCount, coverage and errors. Open promising paths with relay_workspace read.',
  relay_workspace: 'Operate on local files and commands. Read PDF, DOCX and XLSX directly. Locate a missing path before retrying ENOENT; relay_files only covers attachments. Patch exact text and check exit codes plus resulting files. A persistent preview needs a detached launcher, logs, an owned PID and a stop command; verify its URL.',
  relay_desktop: 'Inspect the selected window and use its advertised accessibility actions/current refs. Physical pointer/keyboard input is not implemented by this adapter. Native actions can change foreground state.',
  relay_browser: 'Open or reuse a relevant contained-browser page. An empty task-owned tabs list is not sign-out. Use search, filters or pagination beyond the first view; inspect a new tab opened by an action. For stale refs with no input sent, take a fresh snapshot and retry.',
  relay_files: 'Read attachments using their actual IDs and needed pages/search. Request image pixels for visual inspection. Local files use relay_workspace, not attachment IDs.',
  relay_prompts: 'Read the selected template and revision when using or editing it. Render supplies editable task text; templates do not impose new task requirements.',
  relay_credentials: 'Use saved credentials for the intended account and origin. This helper is optional; ordinary browser forms remain available. Save new credentials when supported. Account recovery follows the user\'s request. Keep secret values out of notes and reports.',
  relay_browser_signin: 'Use available sign-in, saved-credential and email-verification routes before declaring a login blocker. A sent-code notice does not verify an account. Name the exact unavailable credential/challenge when progress is blocked.',
  relay_memory: 'Read relevant saved facts. Use the available change actions for requested updates and preserve their actual revision/host requirements. Do not save guesses as user facts.',
  relay_skills: 'Read relevant task procedures and use the current owner-edited version. Apply the user\'s request over conflicting skill defaults. Update a skill when requested using available actions; ordinary work does not require skill maintenance.',
  relay_history: 'Use the history operations actually present in this schema for relevant prior context or diagnosis.',
  relay_identity: 'Read profile information when needed for the task. The supplied snapshot identifies its active revision. Use available read/edit capabilities; do not assume the tool can write identity files.',
  relay_delegate: 'Delegate independent work within the task\'s model and scope. Inspect actual findings and receipts; a worker\'s claim alone does not verify its result.'
};

const actionsOf = tool => tool?.inputSchema?.properties?.action?.enum || [];

export function capabilityGuidance(tools, { planningMode = 'on', executionGuardrails = false, planningContractVersion } = {}) {
  planningModeOf(planningMode);
  if (typeof executionGuardrails !== 'boolean') throw new TypeError('Execution guardrails must be true or false.');
  const attached = Array.isArray(tools) ? tools : [];
  const names = new Set(attached.map(tool => tool.name));
  const mode = planningMode === 'off'
    ? 'Automatic planning is off. Plan writes and method lookups are optional unless requested.'
    : executionGuardrails
      ? 'Forced planning is selected. Use its actual contract and host preconditions; preserve current revisions and completed work.'
      : 'Planning is Advisory. Tool use does not wait for plan reads, decomposition, activation or reviews.';
  const rows = [];
  for (const tool of attached) {
    const actions = actionsOf(tool);
    let guidance = playbooks[tool.name];
    if (tool.name === 'relay_task') {
      guidance = planningMode === 'off'
        ? 'The outline is optional. Read its current revision when editing; merge conflicts without losing saved work.'
        : planningContractVersion === 14 && tool.inputSchema?.properties?.contract?.properties?.contractVersion?.enum?.includes(2)
          ? 'Use stable work-item IDs and the current canonical contract revision. The host journals operations/evidence; change plan only for material intent/scope/criterion changes.'
          : 'Use the current outline and expectedRevision; update after material progress. A saved plan is working state, not completed execution.';
      if (actions.includes('focus')) guidance += ' focus moves the work cursor.';
      if (actions.includes('assess')) guidance += ' assess records a judgment, not mechanical evidence.';
      if (actions.includes('describe')) guidance += ' Use describe when an actual schema question needs resolving.';
      if (executionGuardrails && planningMode !== 'off' && tool.inputSchema?.properties?.external) guidance += ' This attached external contract requires prepare/attempt before dispatch; reconcile and confirm actual destination outcomes.';
    }
    if (!guidance) continue;
    if (tool.name === 'relay_workspace') guidance += names.has('relay_find_files')
      ? ' Use relay_find_files when the required path is unknown.'
      : actions.includes('find') ? ' Use action find when the required path is unknown.' : ' Locate paths with the available list/search/run operations.';
    if (tool.name === 'relay_workspace' && !names.has('relay_files')) guidance = guidance.replace('; relay_files only covers attachments', '');
    if (tool.name === 'relay_find_files' && !names.has('relay_workspace')) guidance = guidance.replace(' Open promising paths with relay_workspace read.', ' This tool returns paths, not file contents.');
    if (tool.name === 'relay_files' && !names.has('relay_workspace')) guidance = guidance.replace(' Local files use relay_workspace, not attachment IDs.', ' Unattached local files are outside this attachment catalog.');
    if (tool.name === 'relay_windows') guidance += actions.includes('apps') && tool.inputSchema?.properties?.appId
      ? ' Discover installed apps with apps and launch the observed appId.'
      : tool.inputSchema?.properties?.executable || tool.inputSchema?.properties?.windowId ? ' Use the executable/windowId fields actually present in this schema.' : '';
    if (['relay_apps', 'relay_desktop'].includes(tool.name) && names.has('relay_windows')) guidance += ' Prefer attached relay_windows for normal Windows app work.';
    if (tool.name === 'relay_browser' && actions.includes('take_ownership')) guidance += ' For deliberate recovery of a specific past page, use tabs query:"stopped-task-recovery" and take_ownership with its exact tab ID, ownerKey, URL and document ID.';
    if (tool.name === 'relay_history' && !actions.includes('search') && !actions.includes('read')) guidance += ' This attached schema does not provide Past Chats search/read; use its supported diagnostics.';
    if (tool.name === 'relay_delegate' && tool.inputSchema?.properties?.tasks?.items?.properties?.readOnly) guidance += ' readOnly:true enforces read-only work; omission inherits the parent boundary. Reconcile contextChangedSinceStart with current user directions.';
    rows.push(`${tool.name}: ${guidance}`);
  }
  return '\n\nBLACKICE TOOL ROUTING\n' + mode + '\nATTACHED TOOLS\n' + [...names].join(', ') + (rows.length ? '\nADAPTER NOTES\n' + rows.join('\n') : '');
}
