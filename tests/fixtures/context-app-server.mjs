import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ id, result });
const notice = (method, params) => send({ method, params });
const threads = new Map(); let counter = 0;
function complete(threadId, turnId, text, compact = false) {
  const saved = threads.get(threadId); saved.turns++;
  const item = compact ? { type: 'contextCompaction', id: 'compaction-' + turnId } : { type: 'agentMessage', id: 'message-' + turnId, text };
  notice('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
  notice('item/completed', { threadId, turnId, item });
  notice('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: saved.turns * 20, outputTokens: saved.turns * 5, totalTokens: saved.turns * 25 }, last: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }, modelContextWindow: 828400 } });
  notice('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [item] } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line); if (id === undefined) return;
  if (method === 'initialize') return reply(id, {});
  if (method === 'account/read') return reply(id, { account: { type: 'chatgpt', planType: 'test' }, requiresOpenaiAuth: true });
  if (method === 'model/list') return reply(id, { data: [{ id: 'fixture', model: 'fixture', isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null });
  if (method === 'thread/start') { const threadId = 'context-' + ++counter; threads.set(threadId, { config: params.config, turns: 0, injected: [], ephemeral:params.ephemeral===true }); return reply(id, { thread: { id: threadId, ...(params.ephemeral===true?{ephemeral:true}:{}) }, model: 'fixture' }); }
  if (method === 'thread/resume') { if (params.config) threads.get(params.threadId).config = params.config; return reply(id, { thread: { id: params.threadId }, model: 'fixture' }); }
  if (method === 'thread/inject_items') { threads.get(params.threadId).injected.push(...params.items); return reply(id,{}); }
  if (method === 'turn/start') { const turnId = 'turn-' + ++counter; reply(id, { turn: { id: turnId } }); return complete(params.threadId, turnId, JSON.stringify({ config: threads.get(params.threadId).config ?? null })); }
  if (method === 'thread/compact/start') { if(process.argv.includes('--fail-compact'))return send({id,error:{code:-32000,message:'Fixture compaction unavailable.'}}); reply(id, {}); return setTimeout(() => complete(params.threadId, 'compact-' + ++counter, '', true), 10); }
  reply(id, {});
});
