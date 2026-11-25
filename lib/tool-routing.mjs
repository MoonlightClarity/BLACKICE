import {planningModeOf} from './planning-policy.mjs';

export const browserTaskIntent = text => typeof text === 'string' &&
  (/https?:\/\/|www\.|\b(linkedin|website|browser|online|webpage|web page|internet|web search|publish|posting|post on|post to|job search|job applications?|sign[ -]?in|log[ -]?in|sign[ -]?up|signup|account creation|email verification)\b/i.test(text) ||
   /\bapply(?:ing)?\b.{0,100}\b(?:jobs?|roles?|positions?|applications?)\b/i.test(text));

// The schema specifies mechanics. Developer routing only resolves ambiguous
// capabilities; it must not duplicate task behavior or create approval gates.
const notes=Object.freeze({
  relay_browser:'Use the contained browser; tabs identifies current owned pages. An empty task-owned tabs list is not sign-out. For stale refs with no input sent, take a fresh snapshot and retry. BROWSER_TAB_NOT_FOUND means refresh tabs before reading or input. Never replay an uncertain dispatch.',
  relay_workspace:'Use supplied absolute paths directly; the working folder is not a search boundary. Read or edit the intended original, not a convenient match. Verify writes and command exit codes.',
  relay_find_files:'Locate an unknown file by name or path, not file content. If the intended source is not established and more coverage is useful, continue with the same query and returned cursor. Stop discovery once the needed source is established.',
  relay_context_page:'Retrieve archived text from an EXTERNAL CONTEXT RECORD; for a literal target use search and its recorded reference.',
  relay_code:'Save or check actual source code only; a successful write is not proof of correct behavior.',
  relay_control:'Manage saved settings and workflows; not file content or archived observations. Check revision and action receipts.',
  relay_agents:'Control saved agent conversations by actual run ID and state; admission is not completion.',
  relay_skills:'Read the current owner-edited version on demand. Skill metadata or a brief is not the full body or permission to stop.',
  relay_history:'Read saved prior run data; it is not a current browser observation or external result.',
  relay_identity:'Read the current saved profile and revision; do not infer unsupported facts.',
  relay_files:'Read actual conversation attachments; use workspace for local files.',
  relay_browser_signin:'Use the current browser sign-in, credential and verification routes. A sent code is not login confirmation.',
  relay_credentials:"This helper is optional; ordinary browser forms remain available. Account recovery follows the user's request.",
  relay_apps:'Use current app session state. Save the requested output to its destination; a recovery snapshot does not replace it.',
  relay_windows:'Inspect current Windows UI automation refs and use only advertised actions.',
  relay_desktop:'Inspect current supported controls; physical pointer and keyboard input are not exposed.',
  relay_project:'Read current project revision and execution receipts. A saved plan does not perform work.',
  relay_prompts:'Read the selected template and revision when needed. Render supplies editable task text; templates do not impose new task requirements.',
  relay_delegate:'Delegate independent work when useful and reconcile the actual result; delegated claims are not proof.',
  relay_outcome_feedback:'Read only the current independent assessment; this is feedback, not task data.'
});
const actionsOf=t=>t?.inputSchema?.properties?.action?.enum||[];
const has=(t,key)=>Boolean(t?.inputSchema?.properties?.[key]);
export function capabilityGuidance(tools,{planningMode='on',executionGuardrails=false,planningContractVersion}={}){
  planningModeOf(planningMode);
  if(typeof executionGuardrails!=='boolean')throw new TypeError('Execution guardrails must be Boolean.');
  const attached=Array.isArray(tools)?tools.filter(t=>typeof t?.name==='string'):[];
  const names=new Set(attached.map(t=>t.name));
  const mode=planningMode==='off'?'Automatic planning is off. Plan writes and method lookups are optional unless requested.'
    :executionGuardrails?'Forced planning uses the attached contract and host preconditions.'
    :'Planning is Advisory. Tool use does not wait for planning.';
  const rows=[];
  for(const tool of attached){
    const actions=actionsOf(tool);
    let note=notes[tool.name]||'Use the attached schema and verify the returned outcome.';
    if(tool.name==='relay_workspace'){
      if(names.has('relay_find_files'))note+=' Use relay_find_files when the required path is unknown.';
      else if(actions.includes('find'))note+=' Use action find when the required path is unknown.';
      if(actions.includes('search'))note+=' For literal text inside a known file, use action search with path and query.';
      if(names.has('relay_context_page'))note+=' If a result is an EXTERNAL CONTEXT RECORD, retrieve its omitted text with relay_context_page instead of treating its ID as a file.';
    }
    if(tool.name==='relay_find_files'){
      if(names.has('relay_workspace'))note+=' Search inside a known file with relay_workspace action search.';
      if(names.has('relay_context_page'))note+=' For omitted text in an EXTERNAL CONTEXT RECORD use relay_context_page search, not this tool.';
    }
    if(tool.name==='relay_browser'){
      if(!actions.includes('snapshot'))note=note.replace(' For stale refs with no input sent, take a fresh snapshot and retry.','');
      if(actions.includes('take_ownership')){
        const props=['tabId','expectedOwnerKey','expectedUrl','expectedDocumentId'];
        if(props.every(k=>has(tool,k)))note+=' To take_ownership, Pass tabId unchanged, ownerKey as expectedOwnerKey, url as expectedUrl, and documentId as expectedDocumentId to take_ownership.';
        else note+=' For take_ownership use the identity fields actually listed for take_ownership.';
        if(actions.includes('tabs')&&has(tool,'query'))note+=' Find stopped task pages with tabs query:"stopped-task-recovery".';
      }
    }
    if(tool.name==='relay_task'){
      note=planningMode==='off'?'The outline is optional. Read the current revision before an edit.'
        :planningContractVersion===14&&tool.inputSchema?.properties?.contract?.properties?.contractVersion?.enum?.includes(2)
          ?'Use the current canonical contract revision and stable task IDs.'
          :'Read current task state. A plan is not execution.';
      if(has(tool,'expectedRevision'))note+=' Use the current expectedRevision.';
      if(actions.includes('focus'))note+=' focus moves the work cursor.';
      if(actions.includes('assess'))note+=' assess records a judgment.';
      if(executionGuardrails&&planningMode!=='off'&&has(tool,'external'))note+=' This attached external contract requires prepare/attempt before dispatch.';
    }
    rows.push(tool.name+': '+note);
  }
  return '\n\nBLACKICE TOOL ROUTING\n'+mode+'\nATTACHED TOOLS\n'+[...names].join(', ')+(rows.length?'\nADAPTER NOTES\n'+rows.join('\n'):'');
}
