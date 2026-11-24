import { spawn } from 'node:child_process';
import { AccountAcpConnection } from './account-acp-protocol.mjs';
import { createAccountToolBridge } from './account-acp-tools.mjs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

export const GOOGLE_ACCOUNT = 'google-account';
const prefix = 'google_account_';
const threadPattern = /^google_account_(gemini-[a-z0-9.-]+)_([0-9a-f-]{36})$/i;

export function savedGoogleModel(threadId) {
  if (!threadId?.startsWith(prefix)) return undefined;
  const match = threadPattern.exec(threadId);
  if (!match) throw Error('Invalid Google account conversation ID.');
  return GOOGLE_ACCOUNT + '::' + match[1];
}

export function googlePickerRows(catalog) {
  if (catalog?.source !== 'Google Antigravity') return [];
  return catalog.models.map(({id, name}) => ({
    id: GOOGLE_ACCOUNT + '::' + id, model: GOOGLE_ACCOUNT + '::' + id,
    displayName: name, providerId: GOOGLE_ACCOUNT, providerName: 'Google account',
    providerType: 'subscription-cli', available: true, supportsReasoningSelection: false,
    fixedEffort: /-(high|medium|low)$/.exec(id)?.[1], supportsImages: false, supportsTools: false
  }));
}

async function executable() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installed = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    try { await access(installed); return installed; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return 'agy';
}

export async function runGoogleAgent(options) {
  if (options.serviceTier && options.serviceTier !== 'default') throw Error('Gemini uses the standard service tier.');
  if (options.inputImages?.length || options.benchmarkTrace || (options.hostOnlyTools && options.sandbox !== 'read-only'))
    throw Error('This Google account route supports ordinary text conversations.');
  const signal = options.timeoutMs ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : options.signal;
  const isolated = options.hostOnlyTools || options.responseOnly;
  const cwd = isolated ? await mkdtemp(path.join(tmpdir(),'blackice-google-review-')) : options.cwd || process.cwd();
  const turnId = randomUUID();
  const effort = /-(low|medium|high)$/.exec(options.model)?.[1] || 'default';
  const meta = {turnId, model:GOOGLE_ACCOUNT + '::' + options.model, providerId:GOOGLE_ACCOUNT, effort};
  const emit = event => options.onEvent?.({...meta,...event,at:new Date().toISOString()});
  let connection, bridge, sessionId, text = '', accepting = false;
  try {
    if (options.dynamicTools?.length) bridge = await createAccountToolBridge({
      tools:options.dynamicTools, signal, onToolCall:options.onToolCall,
      onToolResultDelivered:options.onToolResultDelivered, onEvent:emit
    });
    const args = ['acp'];
    if (isolated) {
      const agent = 'blackice-review-' + turnId;
      const folder = path.join(cwd,'.agents','agents');
      await mkdir(folder,{recursive:true});
      const tools = (bridge?.toolBindings || []).map(row => 'mcp_blackice_' + row.nativeName.split('.').at(-1));
      await writeFile(path.join(folder,agent+'.md'), ['---','name: '+agent,'description: Isolated BLACKICE outcome reviewer',
        'tools: '+JSON.stringify(tools),'mainAgent: true','subagent: false','commandExecutionPolicy: off','---',
        'Assess only the supplied evidence using the requested output format.'].join('\n'));
      args.push('--agent',agent);
    }
    connection = new AccountAcpConnection({command:await executable(), cwd, env:process.env,
      spawnImpl:(file,unused,settings) => spawn(file,args,settings),
      onRequest:async (method,params) => {
        if (method !== 'session/request_permission') throw Error('Unsupported Antigravity client operation.');
        const title = params.toolCall?.title || '';
        const owned = accepting && params.sessionId === sessionId && bridge?.toolBindings.some(binding => title === binding.nativeName || title === binding.nativeName.split('.').at(-1));
        const option = params.options?.find(item => item.kind === (owned ? 'allow_once' : 'reject_once'));
        return option ? {outcome:{outcome:'selected',optionId:option.optionId}} : {outcome:{outcome:'cancelled'}};
      }
    });
    connection.on('notification', ({method,params}) => {
      if (!accepting || method !== 'session/update' || params.sessionId !== sessionId) return;
      const update = params.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += update.content.text;
    });
    await connection.initialize({signal});
    const prior = options.threadId && threadPattern.exec(options.threadId)?.[2];
    const session = await connection.request(prior ? 'session/load' : 'session/new', {
      cwd, mcpServers:bridge ? [bridge.server] : [], ...(prior ? {sessionId:prior} : {})
    }, {signal});
    sessionId = prior || session.sessionId;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw Error('Invalid Antigravity session ID.');
    if (!session.models?.availableModels?.some(row => row.modelId === options.model)) throw Error('The selected model is unavailable in this Google session.');
    await connection.request('session/set_model',{sessionId,modelId:options.model},{signal});
    meta.threadId = prefix + options.model + '_' + sessionId;
    emit({type:'thread',resumed:Boolean(prior)});
    const mapping = bridge?.toolBindings.map(row => row.name+' = '+row.nativeName.split('.').at(-1)).join('\n');
    let prompt = [options.developerInstructions,options.outputSchema && 'Return only JSON matching this schema: '+JSON.stringify(options.outputSchema),mapping && 'Attached BLACKICE tools (host name = MCP tool):\n'+mapping,options.prompt].filter(Boolean).join('\n\n');
    for (;;) {
      text = ''; accepting = true;
      const result = await connection.request('session/prompt',{sessionId,prompt:[{type:'text',text:prompt}]},{signal,timeoutMs:null});
      accepting = false;
      await bridge?.settle();
      if (result.stopReason !== 'end_turn' || !text.trim()) throw Error('Google session ended without a complete answer ('+result.stopReason+').');
      const output = text.trim();
      const review = await options.onBeforeFinal?.({...meta,output,signal,usage:result.usage});
      if (review?.continue) {
        if (!review.prompt?.trim()) throw Error('Final review returned an empty continuation.');
        prompt = review.prompt; continue;
      }
      emit({type:'message',phase:'final_answer',text:output,itemId:turnId});
      return {...meta,output,usage:result.usage};
    }
  } finally {
    accepting = false;
    try { await connection?.close(); } finally {
      try { await bridge?.close(); } finally { if (isolated) await rm(cwd,{recursive:true,force:true,maxRetries:3}); }
    }
  }
}
