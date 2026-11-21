/** Pure validation of an attached native tool's action discriminator.
 * This runs before Action Directory reserves or dispatches an operational call.
 * Tool handlers remain authoritative for action-specific inputs and effects.
 */
export function toolActionDenial(call, tools) {
  if (call?.namespace) return null;
  const tool = tools.find(item => item.name === call?.name && !item.namespace);
  const schema = tool?.inputSchema;
  const actions = schema?.properties?.action?.enum;
  if (!Array.isArray(actions)) return null;
  let args;
  try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; }
  catch { return denial('TOOL_ARGUMENTS_INVALID', tool.name, actions, 'Supply a JSON object matching this tool schema.'); }
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return denial('TOOL_ARGUMENTS_INVALID', tool.name, actions, 'Supply a JSON object matching this tool schema.');
  if (!Object.hasOwn(args, 'action') && !schema.required?.includes('action')) return null;
  if (actions.includes(args.action)) return null;
  let message = tool.name + ' does not support this action. Use one of: ' + actions.join(', ') + '.';
  const directory = tools.find(item => item.name === 'relay_directory_action' && !item.namespace);
  if (tool.name === 'relay_workspace' && directory?.inputSchema?.properties?.action?.enum?.includes(args.action))
    message += ' Use relay_directory_action with action ' + JSON.stringify(args.action) + ' for the task action outline.';
  if (tool.name === 'relay_agents') message = 'relay_agents has no such action. Use list or get to inspect saved runs. Use relay_workspace read for a local file.';
  return denial(tool.name === 'relay_agents' ? 'NATIVE_AGENT_ACTION_INVALID' : 'TOOL_ACTION_INVALID', tool.name, actions, message);
}
function denial(code, tool, allowedActions, message) {
  return { success: false, code, actionDispatched: false,
    contentItems: [{ type: 'inputText', text: JSON.stringify({ code, tool, actionDispatched: false, allowedActions, message }) }] };
}
