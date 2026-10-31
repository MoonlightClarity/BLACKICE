// Bounded app-server protocol fixture. It never opens a network connection or runs a model.
import readline from 'node:readline';

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const notice = (method, params) => send({ method, params });
const threads = new Map();
const ephemeralSupport = !process.argv.includes('--no-ephemeral');
const omitEphemeral = process.argv.includes('--omit-ephemeral');
const approvals = new Map();
let nextThread = 1;
let nextTurn = 1;
let heldInitialize;
let heldThreadOpen, heldStartOnce = false, heldResumeOnce = false;
let fixtureAccount = { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'test' }, requiresOpenaiAuth: true };
let fixtureModels = [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', description: 'No model calls', isDefault: true, hidden: false, inputModalities: ['text', 'image'], supportedReasoningEfforts: (process.argv.includes('--reasoning-levels') ? ['medium', 'max', 'ultra'] : ['medium']).map(reasoningEffort => ({ reasoningEffort, description: 'Fixture' })), defaultReasoningEffort: 'medium' }];
let catalogError = null, holdCatalog = false, unsupportedHidden = false;
const heldCatalog = [];
const askApproval = (threadId, turnId, stale = false) => {
  const approvalId = `${stale ? 'stale-approval' : 'fixture-approval'}-${turnId}`;
  approvals.set(approvalId, { threadId, turnId, stale });
  send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: {
    threadId, turnId: stale ? 'previous-turn' : turnId, itemId: `command-${turnId}`, kind: 'command', command: 'fixture read-only action', cwd: process.cwd(), startedAtMs: Date.now(), reason: 'Test approval routing',
  } });
};
const complete = (threadId, turnId, text, status = 'completed') => {
  const item = { id: `message-${turnId}`, type: 'agentMessage', text };
  notice('item/started', { threadId, turnId, item });
  notice('item/agentMessage/delta', { threadId, turnId, itemId: item.id, delta: text });
  notice('item/completed', { threadId, turnId, item });
  const turns = threads.get(threadId).turnCount || 1;
  notice('thread/tokenUsage/updated', {
    threadId, turnId,
    tokenUsage: { total: { inputTokens: 12 * turns, outputTokens: 8 * turns, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 20 * turns }, last: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, modelContextWindow: 10000 },
  });
  notice('turn/completed', { threadId, turn: { id: turnId, status, items: [item], error: null } });
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (!request.method) {
    const approval = approvals.get(request.id);
    if (approval) {
      approvals.delete(request.id);
      const decision = request.result?.decision;
      if (approval.mode === 'userInput') {
        complete(approval.threadId, approval.turnId, JSON.stringify(request.result));
        return;
      }
      if (approval.mode === 'permissions') {
        complete(approval.threadId, approval.turnId, JSON.stringify(request.result));
        return;
      }
      if (approval.mode === 'dynamicTool') {
        complete(approval.threadId, approval.turnId, JSON.stringify(request.result));
        return;
      }
      if (approval.stale) {
        if (decision !== 'decline') complete(approval.threadId, approval.turnId, 'ERROR: stale approval was accepted');
        else askApproval(approval.threadId, approval.turnId);
        return;
      }
      complete(approval.threadId, approval.turnId, `Approval decision: ${JSON.stringify(decision)}`);
    }
    return;
  }
  const { id, method, params = {} } = request;
  if (id === undefined) return;
  switch (method) {
    case 'initialize':
      if (process.argv.includes('--hold-initialize')) heldInitialize = { id, result: { userAgent: 'fake-codex/1.0.0', platformFamily: 'test', platformOs: process.platform } };
      else reply(id, { userAgent: process.argv.includes('--native-user-agent') ? 'blackice/0.163.0 (Windows 10.0.19045; x86_64) unknown (blackice; fixture)' : 'fake-codex/1.0.0', platformFamily: 'test', platformOs: process.platform });
      break;
    case 'fixture/releaseInitialize':
      if (heldInitialize) { reply(heldInitialize.id, heldInitialize.result); heldInitialize = null; }
      reply(id, {});
      break;
    case 'fixture/releaseThreadOpen': {
      const threadId = heldThreadOpen?.result?.thread?.id;
      if (heldThreadOpen) { reply(heldThreadOpen.id, heldThreadOpen.result); heldThreadOpen = null; }
      reply(id, { threadId });
      break;
    }
    case 'fixture/threadState':
      reply(id, { threads: [...threads].map(([threadId, value]) => ({ threadId, ephemeral: value.ephemeral, turnCount: value.turnCount || 0 })) });
      break;
    case 'fixture/catalog':
      if (params.models !== undefined) fixtureModels = params.models;
      if (params.account !== undefined) fixtureAccount = params.account;
      if (params.error !== undefined) catalogError = params.error;
      if (params.hold !== undefined) holdCatalog = params.hold;
      if (params.unsupportedHidden !== undefined) unsupportedHidden = params.unsupportedHidden;
      reply(id, {});
      if (params.notify) notice('account/updated', { authMode: fixtureAccount.account?.type || null, planType: fixtureAccount.account?.planType || null });
      break;
    case 'fixture/releaseCatalog':
      holdCatalog = false;
      for (const message of heldCatalog.splice(0)) send(message);
      reply(id, {});
      break;
    case 'account/read':
      reply(id, fixtureAccount);
      break;
    case 'config/read':
      reply(id, { config: { plugins: {}, mcp_servers: {}, skills: { config: [] } } });
      break;
    case 'skills/list':
      reply(id, { data: (params.cwds || []).map(cwd => ({ cwd, skills: [], errors: [] })) });
      break;
    case 'model/list': {
      if (unsupportedHidden && params.includeHidden !== undefined) { send({ id, error: { code: -32602, message: 'unknown field `includeHidden` in model/list parameters' } }); break; }
      if (catalogError) { send({ id, error: catalogError }); break; }
      const models = params.includeHidden === true ? fixtureModels : fixtureModels.filter(model => !model.hidden);
      const offset = Number(params.cursor || 0), limit = Math.min(100, params.limit || 100);
      const message = { id, result: { data: models.slice(offset, offset + limit), nextCursor: offset + limit < models.length ? String(offset + limit) : null } };
      if (holdCatalog) heldCatalog.push(message); else send(message);
      break;
    }
    case 'thread/start': {
      const threadId = `fixture-thread-${nextThread++}`;
      const ephemeral = params.ephemeral === true && ephemeralSupport && !omitEphemeral;
      threads.set(threadId, { dynamicTools: params.dynamicTools || [], ephemeral });
      const result = { thread: { id: threadId, turns: [], ...(!omitEphemeral ? { ephemeral } : {}) }, model: params.model || 'fixture-model', cwd: params.cwd, approvalPolicy: params.approvalPolicy, sandbox: params.sandbox };
      if (!heldStartOnce && process.argv.includes('--hold-first-thread-start')) { heldStartOnce = true; heldThreadOpen = { id, result }; }
      else reply(id, result);
      break;
    }
    case 'thread/resume': {
      if (!threads.has(params.threadId)) { send({ id, error: { code: -32602, message: 'Saved conversation not found.' } }); break; }
      if (params.approvalPolicy !== 'never' || params.sandbox !== 'danger-full-access' || params.excludeTurns !== true) { send({ id, error: { code: -32602, message: 'Resume must retain direct execution.' } }); break; }
      const result = { thread: { id: params.threadId, turns: [] }, model: params.model || 'fixture-model' };
      if (!heldResumeOnce && process.argv.includes('--hold-first-thread-resume')) { heldResumeOnce = true; heldThreadOpen = { id, result }; }
      else reply(id, result);
      break;
    }
    case 'turn/start': {
      const threadId = params.threadId;
      const turnId = `fixture-turn-${nextTurn++}`;
      const saved = threads.get(threadId) || {};
      threads.set(threadId, { ...saved, turnId, turnCount: (saved.turnCount || 0) + 1 });
      const prompt = (params.input || []).map(item => item.text || '').join('\n');
      if (!saved.firstPrompt) threads.get(threadId).firstPrompt = prompt;
      if (prompt.includes('STALL_TURN_START')) break;
      reply(id, { turn: { id: turnId, status: 'inProgress', items: [], error: null } });
      notice('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } });
      if (prompt.includes('DYNAMIC_TOOL')) {
        const toolId = `fixture-tool-${turnId}`;
        approvals.set(toolId, { threadId, turnId, mode: 'dynamicTool' });
        send({ id: toolId, method: 'item/tool/call', params: {
          threadId, turnId, callId: toolId, namespace: null, tool: 'relay_desktop', arguments: { action: 'screenshot' },
        } });
        break;
      }
      if (prompt.includes('WAIT_FOR_CANCEL')) break;
      if (prompt.includes('WAIT_FOR_STEER')) break;
      if (prompt.includes('FAIL_TURN')) {
        notice('turn/completed', { threadId, turn: { id: turnId, status: 'failed', items: [], error: { message: 'Deliberate fixture failure' } } });
        break;
      }
      if (prompt.includes('REQUEST_USER_INPUT')) {
        const approvalId = `fixture-input-${turnId}`;
        approvals.set(approvalId, { threadId, turnId, mode: 'userInput' });
        send({ id: approvalId, method: 'item/tool/requestUserInput', params: {
          threadId, turnId, itemId: `question-${turnId}`,
          questions: [{ id: 'direction', header: 'Direction', question: 'Choose the next step', options: [{ label: 'Inspect', description: 'Read the workspace' }, { label: 'Build', description: 'Make a change' }] }],
        } });
        break;
      }
      if (prompt.includes('REQUEST_PERMISSIONS')) {
        const approvalId = `fixture-permission-${turnId}`;
        approvals.set(approvalId, { threadId, turnId, mode: 'permissions' });
        send({ id: approvalId, method: 'item/permissions/requestApproval', params: {
          threadId, turnId, itemId: `permission-${turnId}`, reason: 'Need a limited permission for the fixture',
          permissions: { network: { enabled: true }, fileSystem: null },
        } });
        break;
      }
      if (prompt.includes('REQUEST_APPROVAL')) {
        askApproval(threadId, turnId);
        break;
      }
      if (prompt.includes('STALE_THEN_APPROVAL')) {
        askApproval(threadId, turnId, true);
        break;
      }
      if (prompt.includes('PROTOCOL_ERROR')) {
        notice('error', { threadId, turnId, error: { message: 'Fixture protocol error' }, willRetry: false });
        break;
      }
      complete(threadId, turnId, prompt.includes('READ_PRIOR') ? `Earlier message: ${threads.get(threadId).firstPrompt}` : `Fixture result for ${prompt}`);
      break;
    }
    case 'turn/interrupt': {
      reply(id, {});
      complete(params.threadId, params.turnId, 'Interrupted fixture turn', 'interrupted');
      break;
    }
    case 'turn/steer': {
      const thread = threads.get(params.threadId);
      if (!thread || thread.turnId !== params.expectedTurnId) { send({ id, error: { code: -32602, message: 'Active turn changed.' } }); break; }
      reply(id, { turnId: thread.turnId });
      complete(params.threadId, thread.turnId, `Direction received: ${params.input.map(item => item.text).join(' ')}`);
      break;
    }
    case 'thread/unsubscribe':
      if (threads.get(params.threadId)?.ephemeral) threads.delete(params.threadId);
      reply(id, {});
      break;
    case 'thread/archive':
      reply(id, {});
      break;
    default:
      reply(id, {});
  }
});
