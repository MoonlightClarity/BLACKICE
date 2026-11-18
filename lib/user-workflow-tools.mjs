export const USER_WORKFLOW_TOOL = {
  type: 'function', name: 'relay_user_workflow',
  description: 'Read explicitly user-approved reusable workflows when relevant to the current request. List approved definitions, read one, then execute with its exact revision to select its instructions for this task. Execute is read-only: it returns the approved definition, does not start another run or claim completion, and grants no additional permissions. Draft, save, edit, approve and delete are human-only operations; never generate or generalize workflows from conversations automatically.',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'read', 'execute'] },
    id: { type: 'string' },
    expectedRevision: { type: 'integer', minimum: 1 },
  }, required: ['action'], additionalProperties: false },
};
const result = (value, success = true, code) => ({ success, ...(code ? { code } : {}),
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
export function createUserWorkflowToolHandler({ workflows, runId = null }) {
  return async call => {
    if (call?.name !== USER_WORKFLOW_TOOL.name) return null;
    try {
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
          Object.keys(args).some(key => !['action', 'id', 'expectedRevision'].includes(key)) ||
          !['list', 'read', 'execute'].includes(args.action))
        return result({ error: 'Only list, read, and execute of approved user workflows are available. Model mutation is not permitted.' }, false, 'USER_WORKFLOW_ACTION_DENIED');
      if (!workflows) return result({ error: 'User workflows are unavailable.' }, false, 'USER_WORKFLOW_UNAVAILABLE');
      if (args.action === 'list') {
        if (args.id !== undefined || args.expectedRevision !== undefined) return result({ error: 'List takes no workflow ID or revision.' }, false, 'USER_WORKFLOW_INVALID');
        return result({ workflows: await workflows.list({ includeDrafts: false }) });
      }
      if (args.action === 'read') {
        if (args.expectedRevision !== undefined) return result({ error: 'Read returns the current approved revision.' }, false, 'USER_WORKFLOW_INVALID');
        const workflow = await workflows.read(args.id);
        if (workflow.status !== 'approved') return result({ error: 'This workflow is not user-approved.' }, false, 'USER_WORKFLOW_NOT_APPROVED');
        return result({ workflow });
      }
      return result({ ...await workflows.execute(args.id, { expectedRevision: args.expectedRevision }), runId });
    } catch (error) { return result({ error: error.message }, false, error.code || 'USER_WORKFLOW_INVALID'); }
  };
}
