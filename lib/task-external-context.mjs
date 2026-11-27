import { retainedBrowserText } from './browser-retained-text.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DEFAULT_THRESHOLD_BYTES = 12000;
const DEFAULT_PAGE_BYTES = 4096;
const MAX_PAGE_BYTES = 8192;
const PAGEABLE = new Set(['relay_workspace', 'relay_find_files', 'relay_browser', 'relay_history', 'relay_agents', 'relay_files', 'relay_directory_action']);
const READ_ACTIONS = new Set(['read', 'search', 'find', 'list', 'snapshot', 'tabs', 'get', 'patch_history']);
const isWorkspaceCommand = (call,args) => call?.name==='relay_workspace' && args?.action==='run';
const VIEW_FIELDS = ['path', 'cwd', 'startLine', 'endLine', 'nextStartLine', 'nextPage', 'truncated', 'exitCode', 'timedOut', 'query', 'matchMode', 'searchDomain', 'searchScopeNotice'];
const firstChars = (value, length) => Array.from(value).slice(0, length).join('');
const lastChars = (value, length) => Array.from(value).slice(-length).join('');
/** Preview *content*, not the escaped JSON wrapper; logs often put the diagnosis last. */
export function externalResultPreview(text) {
  let payload;
  try { payload = JSON.parse(text); } catch {}
  const obj = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const key = obj && ['content', 'stdout', 'stderr', 'text', 'preview'].find(field => typeof obj[field] === 'string' && obj[field].length > 500);
  const source = key ? obj[key] : text;
  const size = Array.from(source).length;
  const head = firstChars(source, 280), tail = size > 400 ? lastChars(source, 480) : '';
  const metadata = obj ? Object.fromEntries(VIEW_FIELDS.filter(field => obj[field] !== undefined).map(field => [field, typeof obj[field] === 'string' ? obj[field].slice(0, 200) : obj[field]])) : {};
  return { ...(key ? {contentField: key} : {}), ...metadata,
    head, ...(tail ? {tail} : {}), omittedMiddle: Math.max(0, size - (tail ? 760 : 280)),
    warning: 'Head and tail are previews, not complete evidence. Retrieve original pages for precise claims.' };
}
const error = (message, code = 'CONTEXT_ARCHIVE_INVALID') => Object.assign(new Error(message), { code });
const output = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const digestFor = (taskId, toolName, contents) => createHash('sha256').update(taskId).update('\0').update(toolName).update('\0').update(contents).digest('hex');
const referenceFor = digest => [digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join('-');
const searchCallTemplate = reference => ({tool:'relay_context_page',arguments:{action:'search',reference,needle:'<target text>'}});
const searchCallHint = 'Use searchCallTemplate; replace needle with target text. Search returns exact matching text.';

// Include exact actionable control identities with a paged browser result.
// This is an explicitly partial observation, not a new DOM inspection.
export function compactBrowserObservation(text) {
  let page;try{page=JSON.parse(text);}catch{return null;}
  if(!page||page.protectedContent===true||page.pendingInteraction||page.navigationUnsettled||!Array.isArray(page.frames)
    ||typeof page.tabId!=='string'||typeof page.documentId!=='string'||typeof page.url!=='string')return null;
  if(page.tabId.length>200||page.documentId.length>200||page.url.length>2000)return null;
  const projected={tabId:page.tabId,documentId:page.documentId,url:page.url,frames:[],partial:true,
    notice:'Bounded subset of exact observed controls. Values and options are omitted; use the archive for those and other controls. Reinspect if the document or control changes.'};
  const candidates=[];
  for(let i=0;i<Math.min(30,page.frames.length);i++){
    const frame=page.frames[i];if(!Array.isArray(frame?.elements)||typeof frame.frame!=='string'||frame.frame.length>200)continue;
    for(const e of frame.elements.slice(0,400)){
      if(!e||typeof e.ref!=='string'||e.ref.length>200||typeof e.name!=='string'||e.name.length>300||e.disabled===true)continue;
      const priority=e.uploadOnly||e.type==='file'?0:['input','textarea','select'].includes(e.tag)?1:['button','combobox','checkbox','radio'].includes(e.role)?2:e.role==='link'?3:4;
      if(priority===4)continue;
      const control={ref:e.ref,name:e.name};for(const key of ['role','tag','type','required','disabled','uploadOnly','hidden','checked','expanded']){const value=e[key];if(typeof value==='boolean'||typeof value==='string'&&value.length<=100)control[key]=value;}
      candidates.push({i,priority,control});
    }
  }
  candidates.sort((a,b)=>a.priority-b.priority||a.i-b.i);
  const frames=new Map();let remaining=5200-Buffer.byteLength(JSON.stringify(projected),'utf8'),count=0;
  for(const {i,control} of candidates){if(count>=24)break;const cost=Buffer.byteLength(JSON.stringify(control),'utf8')+8+(frames.has(i)?0:250);if(cost>remaining)continue;
    if(!frames.has(i))frames.set(i,{frame:page.frames[i].frame,elements:[]});frames.get(i).elements.push(control);remaining-=cost;count++;
  }
  if(!count)return null;
  projected.frames=[...frames.values()];return projected;
}


// Successful field-edit results include a complete repeated page snapshot.
// Keep the original response in the task archive and preserve the exact
// operation receipt and current identity in a small model-facing projection.
// Never project a submission, navigation, authentication or pending dialog.
export function compactBrowserFieldReceipt(call,text) {
  if(call?.namespace||call?.name!=='relay_browser')return null;
  let args=call.arguments??call.input??{},page;
  try {if(typeof args==='string')args=JSON.parse(args);page=JSON.parse(text);}catch{return null;}
  if(!['fill','select'].includes(args?.action)||typeof args.ref!=='string'||!page||!Array.isArray(page.frames)||page.protectedContent||page.pendingInteraction||
     page.navigationUnsettled||page.navigationError||page.inputWarning||page.frameErrors?.length||page.actionDispatched===false||typeof page.tabId!=='string'||
     page.tabId!==args.tabId||typeof page.documentId!=='string'||typeof page.url!=='string'||
     (args.expectedUrl!==undefined&&args.expectedUrl!==page.url)||(args.expectedDocumentId!==undefined&&args.expectedDocumentId!==page.documentId))return null;
  const receipt=page.receipt;
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))return null;
  // Preserve the driver receipt verbatim only for the bounded native field
  // operation shape. Never shorten a non-field or potentially consequential receipt.
  const keys=Object.keys(receipt);
  if(args.action==='fill'?(receipt.filled!==true||keys.some(k=>!['filled','characters','input'].includes(k)))
      :(keys.some(k=>!['selected','value','label','input'].includes(k))||!Object.hasOwn(receipt,'selected')))return null;
  if(Buffer.byteLength(JSON.stringify(receipt),'utf8')>1000)return null;
  const found=page.frames.flatMap(frame=>(Array.isArray(frame?.elements)?frame.elements:[]).filter(e=>e?.ref===args.ref).map(e=>({frame:frame.frame,e})));
  if(found.length!==1)return null;
  const {frame,e}=found[0]; if(e.type==='password'||typeof frame!=='string')return null;
  const field={ref:e.ref};for(const k of ['name','role','tag','type','required','disabled','checked','value']) {
    const v=e[k];if(typeof v==='boolean'||typeof v==='string'&&v.length<=512)field[k]=v;
  }
  return {tabId:page.tabId,documentId:page.documentId,url:page.url,receipt,frames:[{frame,elements:[field]}],partial:true,
    notice:'The tool returned a field-edit receipt and the exact observed field on the same page. Other controls, options and page text remain in the archived original. This is not a submission receipt.'};
}

// One closed action contract drives both provider generation and host validation.
// Root properties remain visible for compatible clients; the disjoint branches
// are also supported by BLACKICE's qualified Qwen3 XML tool grammar.
const CONTEXT_ACTIONS=Object.freeze({
  read:{required:[],optional:['reference','offset','maxBytes']},
  list:{required:[],optional:['limit']},
  search:{required:['needle'],optional:['reference','startOffset','limit']},
});
const CONTEXT_FIELDS={
      action: { type: 'string', enum: ['read', 'list', 'search'] },
      reference: { type: 'string', description: 'Exact archive UUID from the previous result, NOT a filename, path, runtime ID or tool-call ID. May be omitted only when this run has exposed exactly one archive.' },
      offset: { type: 'integer', minimum: 0, description: 'UTF-8 byte offset from a search match or a previous page nextOffset; zero starts from the beginning.' },
      maxBytes: { type: 'integer', minimum: 512, maximum: MAX_PAGE_BYTES },
      limit: { type: 'integer', minimum: 1 },
      needle: { type: 'string', minLength: 1, description: 'REQUIRED for action search: literal text to locate inside the archive, not a filename. Search does not accept offset; use startOffset for continuation.' },
      startOffset: { type: 'integer', minimum: 0, description: 'UTF-8 byte position to resume a bounded search.' },
};
const contextAllowed=definition=>['action',...definition.required,...definition.optional];
const contextVariants=Object.entries(CONTEXT_ACTIONS).map(([name,definition])=>({
  type:'object',additionalProperties:false,
  required:['action',...definition.required],
  properties:Object.fromEntries(contextAllowed(definition).map(key=>[key,
    key==='action'?{type:'string',const:name}:CONTEXT_FIELDS[key]])),
}));

/** Keep the original host result unchanged until the complete text is durably stored. */
export const EXTERNAL_CONTEXT_TOOL = Object.freeze({
  type: 'function',
  name: 'relay_context_page',
  description: 'Retrieve omitted text from an EXTERNAL CONTEXT RECORD (externalContext:true). Use this tool for archived tool-result contents, not filename search or a new source-file read. For search supply action:search and needle (literal target text); copy the exact archive UUID as reference, or omit reference only when one archive has been exposed in this run. Search returns the first matching passage, offsets and an exact matchedReadCallTemplate. If the current task requires a separate read, use that template; otherwise the verified passage can suffice. sourceContinuation refers to source bytes beyond the archive. This only reads the current task.',
  inputSchema: {
    type:'object',additionalProperties:false,required:['action'],
    properties:CONTEXT_FIELDS,oneOf:contextVariants,
  },
});

export const EXTERNAL_CONTEXT_INSTRUCTIONS =
  'Large read-only tool outputs and repeated successful ordinary form-field snapshots may be replaced with EXTERNAL CONTEXT RECORD references. Field edits retain their exact receipt and observed field; the original remains available. ' +
  'These references retain the returned tool text outside the model context for this task. ' +
  'For an exact target phrase or diagnosis, FIRST use relay_context_page search with reference and needle (copy the searchCallTemplate and substitute the actual needle). Search returns firstMatchEvidence containing exact archived text and matchedReadCallTemplate for a separate read. Perform that read if explicitly requested; otherwise use additional pages only when needed. Never pass needle to a read call. A filename/path search does not inspect file contents, and a failed archive lookup is not a no-match result. ' +
  'A browserObservation is a bounded subset of actual returned controls and page identity. Use its current exact references directly instead of rereading the archive merely to find them. Retrieve omitted controls, values or evidence when needed. A preview is not complete evidence; retrieve relevant archived pages. Use read and nextOffset for sequential coverage or list for recent references. Shell-command outputs may also be archived, but the command exitCode, timeout, signal and capture-truncation fields remain authoritative and visible. Archives retain only bytes already returned by the tool, never omitted bytes. If a complete archive search has no match and sourceContinuation is present, continue the original relay_workspace read from that next source line. For claims of full source coverage, read any omitted source pages even if a match was found. ' +
  'UTF-8 offsets are bytes. Host Directory receipts and task state are unchanged by paging.';

export function eligibleExternalContextCall(call) {
  if (!call || call.namespace || !PAGEABLE.has(call.name)) return false;
  let args = call.arguments ?? call.input ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return false; }
  }
  return args && typeof args === 'object' && (READ_ACTIONS.has(args.action) || isWorkspaceCommand(call,args) ||
    (call.name === 'relay_find_files' && typeof args.query === 'string' && args.query.trim().length > 0));
}

function originalWorkspaceCommandResult(call,text){
 let args=call?.arguments??call?.input??{};
 try{if(typeof args==='string')args=JSON.parse(args);}catch{return null;}
 if(!isWorkspaceCommand(call,args)||typeof text!=='string')return null;
 let body;
 try{body=JSON.parse(text);}catch{return null;}
 if(!body||typeof body!=='object'||Array.isArray(body)||
    body.command!==args.command||typeof body.cwd!=='string'||
    typeof body.stdout!=='string'||typeof body.stderr!=='string'||
    typeof body.timedOut!=='boolean'||typeof body.truncated!=='boolean'||
    !(body.exitCode===null||Number.isInteger(body.exitCode))||
    !(body.signal===null||typeof body.signal==='string'))return null;
 return body;
}

function excerptShellStream(text,streamName){
 const codepoints=Array.from(text);
 if(codepoints.length<=850)return text;
 const head=codepoints.slice(0,300).join(''),tail=codepoints.slice(-450).join('');
 return '[ARCHIVED '+streamName.toUpperCase()+' EXCERPT; NOT COMPLETE OUTPUT]\n'+
   head+'\n[... '+(codepoints.length-750)+' characters omitted ...]\n'+tail;
}

function archivedWorkspaceCommandView(shell,saved){
 const {stdout,stderr,...metadata}=shell;
 return {
  ...metadata,
  stdout:excerptShellStream(stdout,'stdout'),
  stderr:excerptShellStream(stderr,'stderr'),
  externalContext:true,reference:saved.reference,bytes:saved.bytes,
  tool:'relay_workspace',action:'run',searchCallTemplate:searchCallTemplate(saved.reference),
  outputIsExcerpt:true,
  originalStdoutBytes:Buffer.byteLength(stdout,'utf8'),
  originalStderrBytes:Buffer.byteLength(stderr,'utf8'),
  archiveCaptureTruncated:shell.truncated,
  nextAction:searchCallHint+' Use relay_context_page read for the complete captured command JSON. The command, exitCode, signal, timedOut and truncated fields above are the ORIGINAL host outcomes and remain authoritative. If truncated=true, the lower-level command capture already omitted bytes that this archive cannot restore.',
 };
}

function integer(value, fallback, lower, upper) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < lower || value > upper) throw error('Invalid context page limit or offset.');
  return value;
}

export class TaskExternalContextStore {
  constructor({ dataDir, taskId, thresholdBytes = DEFAULT_THRESHOLD_BYTES, visibleResultBudgetBytes = 0, forcePageBytes = 65536, compactFieldEdits = false } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !TASK_ID.test(taskId || '')) throw error('A task identity and absolute data directory are required.');
    if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes < 1) throw error('Invalid external context threshold.');
    if(!Number.isSafeInteger(visibleResultBudgetBytes)||visibleResultBudgetBytes<0||visibleResultBudgetBytes>32*1024*1024)throw error('Invalid visible-result budget.');
    if(!Number.isSafeInteger(forcePageBytes)||forcePageBytes<thresholdBytes||forcePageBytes>32*1024*1024)throw error('Invalid large-result cutoff.');
    this.root = path.join(dataDir, 'task-external-context', taskId);
    this.taskId = taskId;
    this.thresholdBytes = thresholdBytes;
    this.visibleResultBudgetBytes=visibleResultBudgetBytes;
    this.forcePageBytes=forcePageBytes;
    this.compactFieldEdits=compactFieldEdits===true;
    this.exposedBytes=0;
    this.pendingSaves = new Map();
    this.exposedReferences = new Set();
  }

  file(reference, extension) {
    if (typeof reference !== 'string' || !ID.test(reference)) throw error('Invalid external context reference: use the archive UUID, not a filename or runtime ID.');
    return path.join(this.root, reference + extension);
  }

  async save(text, toolName) {
    const digest=digestFor(this.taskId,toolName,text),reference=referenceFor(digest);
    const inFlight=this.pendingSaves.get(reference);
    if(inFlight)return inFlight;
    const work=this.saveUnique({text,toolName,digest,reference});
    this.pendingSaves.set(reference,work);
    try{return await work;}
    finally{if(this.pendingSaves.get(reference)===work)this.pendingSaves.delete(reference);}
  }

  async saveUnique({text,toolName,digest,reference}) {
    const contentPath=this.file(reference,'.txt'),metadataPath=this.file(reference,'.json');
    const bytes=Buffer.byteLength(text,'utf8');
    await fs.mkdir(this.root,{recursive:true});
    const reuse=async()=>{
      const saved=await this.metadata(reference);
      if(saved.sha256!==digest||saved.bytes!==bytes||saved.tool!==toolName)
        throw error('Content-addressed context metadata does not match the original result.','CONTEXT_ARCHIVE_CORRUPT');
      const existing=await fs.readFile(contentPath,'utf8');
      if(existing!==text)throw error('Content-addressed context text has changed.','CONTEXT_ARCHIVE_CORRUPT');
      return{reference,bytes};
    };
    try{return await reuse();}
    catch(cause){if(cause.code!=='CONTEXT_ARCHIVE_NOT_FOUND')throw cause;}
    let created=false;
    try{
      try{
        await fs.writeFile(contentPath,text,{encoding:'utf8',flag:'wx'});
        created=true;
      }catch(cause){
        if(cause.code!=='EEXIST')throw cause;
        // Another writer may have published the content but not the metadata yet.
        // Never replace it, assume success, or delete another writer's file.
        for(let attempt=0;attempt<15;attempt++){
          try{return await reuse();}
          catch(error){if(error.code!=='CONTEXT_ARCHIVE_NOT_FOUND')throw error;}
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        throw error('Concurrent context archive did not settle; retain the full tool result.','CONTEXT_ARCHIVE_UNAVAILABLE');
      }
      await fs.writeFile(metadataPath,JSON.stringify({
        version:1,taskId:this.taskId,reference,tool:toolName,bytes,
        sha256:digest,createdAt:new Date().toISOString(),
      }),{encoding:'utf8',flag:'wx'});
      return{reference,bytes};
    }catch(cause){
      if(created)await Promise.allSettled([fs.rm(contentPath,{force:true}),fs.rm(metadataPath,{force:true})]);
      throw cause;
    }
  }

  async archiveResult(call, result) {
    if (result?.success !== true || !Array.isArray(result?.contentItems)) return result;
    const eligible=eligibleExternalContextCall(call);
    const fieldEdit=this.compactFieldEdits&&result.contentItems.length===1&&result.contentItems[0]?.type==='inputText'?compactBrowserFieldReceipt(call,result.contentItems[0].text):null;
    if(!eligible&&!fieldEdit)return result;
    const items = [...result.contentItems];
    const originalBytes=items.filter(item=>item?.type==='inputText'&&typeof item.text==='string').reduce((sum,item)=>sum+Buffer.byteLength(item.text,'utf8'),0);
    let charged=0,changed=false;
    const exposedReferences=[];
    let argumentsValue=call?.arguments??call?.input??{};
    try{if(typeof argumentsValue==='string')argumentsValue=JSON.parse(argumentsValue);}catch{argumentsValue={};}
    const shellCall=isWorkspaceCommand(call,argumentsValue);
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item?.type !== 'inputText' || typeof item.text !== 'string') continue;
        const bytes = Buffer.byteLength(item.text, 'utf8');
        const originalShell=shellCall?originalWorkspaceCommandResult(call,item.text):null;
        if(shellCall&&!originalShell){this.exposedBytes+=bytes;charged+=bytes;continue;}
        const compactField=fieldEdit&&bytes>Math.max(3000,Buffer.byteLength(JSON.stringify(fieldEdit),'utf8')+1000);
        if(!compactField&&(fieldEdit||bytes<=this.thresholdBytes||(bytes<this.forcePageBytes&&this.exposedBytes+bytes<=this.visibleResultBudgetBytes))){
          this.exposedBytes+=bytes;charged+=bytes;continue;
        }
        // Reserve a bounded pointer budget before asynchronous archival so concurrent
        // calls cannot all spend the same remaining visible-output allowance.
        const pointerReservation=Math.min(bytes,2048);
        this.exposedBytes+=pointerReservation;charged+=pointerReservation;
        const retained = retainedBrowserText(call.name, item.text);
        const saved = await this.save(retained, call.name);
        exposedReferences.push(saved.reference);
        if(compactField){
          items[index]={...item,text:JSON.stringify({...fieldEdit,externalContext:true,reference:saved.reference,bytes:saved.bytes,searchCallTemplate:searchCallTemplate(saved.reference),nextAction:'Use the exact field receipt above; inspect other controls only as needed. Retrieve the original result using relay_context_page or take a fresh snapshot before acting on changed controls.'})};
        }else if(originalShell){
          items[index]={...item,text:JSON.stringify(archivedWorkspaceCommandView(originalShell,saved))};
        }else{
        const preview = externalResultPreview(retained);
        const browserObservation=call.name==='relay_browser'&&['snapshot','read'].includes(argumentsValue.action)?compactBrowserObservation(item.text):null;
        const sourceContinuation=call.name==='relay_workspace'&&preview.truncated===true&&typeof preview.path==='string'&&Number.isInteger(preview.nextStartLine)&&preview.nextStartLine>0
          ? {tool:'relay_workspace',action:'read',path:preview.path,startLine:preview.nextStartLine}
          : null;
        items[index] = { ...item, text: JSON.stringify({
          externalContext: true, reference: saved.reference, bytes: saved.bytes,
          tool: call.name, contentIndex: index, searchCallTemplate:searchCallTemplate(saved.reference), preview,
          ...(browserObservation?{browserObservation}:{}),
          ...(sourceContinuation?{sourceContinuation}:{}),
          nextAction: browserObservation?'Use the included exact browser controls and document identity directly when still current. For a needed omitted control, field value or evidence, use relay_context_page search: '+searchCallHint+' Read additional pages only if needed.':sourceContinuation?'The original workspace result was truncated. FIRST use relay_context_page search. '+searchCallHint+' Continue at sourceContinuation for unsearched source.':'FIRST use relay_context_page search. '+searchCallHint+' Read further pages if needed.',
        }) };
        }
        const pointerBytes=Buffer.byteLength(items[index].text,'utf8');
        this.exposedBytes+=pointerBytes-pointerReservation;charged+=pointerBytes-pointerReservation;
        changed = true;
      }
    } catch {
      // All original blocks remain model-visible on failure. Count the bytes not
      // yet charged, preserving increments from other concurrent calls.
      this.exposedBytes+=originalBytes-charged;
      // Do not discard evidence or remove a shared, already-published archive.
      // A failed archive keeps the complete original tool response.
      return result;
    }
    for(const reference of exposedReferences)this.exposedReferences.add(reference);
    return changed ? { ...result, contentItems: items } : result;
  }

  async metadata(reference) {
    const metadataPath = this.file(reference, '.json');
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); }
    catch (cause) {
      if (cause.code === 'ENOENT') throw error('Context reference is absent from this task.', 'CONTEXT_ARCHIVE_NOT_FOUND');
      throw error('Could not read the saved context metadata.', 'CONTEXT_ARCHIVE_UNAVAILABLE');
    }
    if (metadata?.version !== 1 || metadata.taskId !== this.taskId || metadata.reference !== reference ||
        !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 ||
        metadata.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(metadata.sha256)) throw error('Saved context metadata is invalid.', 'CONTEXT_ARCHIVE_CORRUPT');
    return metadata;
  }

  async read({ reference, offset = 0, maxBytes = DEFAULT_PAGE_BYTES } = {}) {
    const metadata = await this.metadata(reference);
    const start = integer(offset, 0, 0, metadata.bytes);
    const requested = integer(maxBytes, DEFAULT_PAGE_BYTES, 1);
    const handle = await fs.open(this.file(reference, '.txt'), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== metadata.bytes) throw error('Stored text changed since it was saved.', 'CONTEXT_ARCHIVE_CORRUPT');
      if(metadata.sha256){const source=await fs.readFile(this.file(reference,'.txt'),'utf8');
        if(digestFor(this.taskId,metadata.tool,source)!==metadata.sha256)throw error('Stored context text no longer matches its durable receipt.','CONTEXT_ARCHIVE_CORRUPT');}
      const capacity = Math.min(requested + 4, stat.size - start);
      const buffer = Buffer.alloc(capacity);
      const { bytesRead } = await handle.read(buffer, 0, capacity, start);
      if (bytesRead && (buffer[0] & 0xc0) === 0x80) throw error('Offset splits a UTF-8 character. Use the prior page nextOffset.');
      let length = Math.min(requested, bytesRead), text = '';
      if (length) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (length) {
          try { text = decoder.decode(buffer.subarray(0, length)); break; }
          catch { length--; }
        }
        if (!length) throw error('Unable to decode the saved context page.', 'CONTEXT_ARCHIVE_CORRUPT');
      }
      const nextOffset = start + length;
      return {
        reference, tool: metadata.tool, bytes: metadata.bytes, offset: start, nextOffset,
        complete: nextOffset === metadata.bytes, text,
      };
    } finally { await handle.close(); }
  }

  async search({ reference, needle, startOffset = 0, limit = 8 } = {}) {
    const metadata = await this.metadata(reference);
    if (typeof needle !== 'string' || !needle.length) throw error('Supply a short, nonempty literal search needle.');
    const pattern = Buffer.from(needle, 'utf8');
    const from = integer(startOffset, 0, 0, metadata.bytes);
    const wanted = integer(limit, 8, 1);
    const handle = await fs.open(this.file(reference, '.txt'), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== metadata.bytes) throw error('Stored text changed since it was saved.', 'CONTEXT_ARCHIVE_CORRUPT');
      let position = from, scanned = 0, tail = Buffer.alloc(0);
      const matches = [];
      while (position < metadata.bytes && matches.length < wanted) {
        const count = Math.min(64 * 1024, metadata.bytes - position);
        const bytes = Buffer.alloc(count);
        const { bytesRead } = await handle.read(bytes, 0, count, position);
        if (!bytesRead) break;
        const combined = Buffer.concat([tail, bytes.subarray(0, bytesRead)]);
        const base = position - tail.length;
        for (let index = 0; matches.length < wanted;) {
          const found = combined.indexOf(pattern, index);
          if (found === -1) break;
          if (base + found >= from) matches.push({ offset: base + found });
          index = found + 1;
        }
        position += bytesRead;
        scanned += bytesRead;
        tail = combined.subarray(Math.max(0, combined.length - pattern.length + 1));
      }
      const complete = position >= metadata.bytes && matches.length < wanted;
      const nextScanOffset = complete ? null : matches.length === wanted
        ? matches.at(-1).offset + 1
        : Math.max(from, position - pattern.length + 1);
      // Verify the archive through the existing exact-page reader before returning
      // search evidence (including a no-match result). The excerpt is raw archived
      // text, not a generated summary. No second model tool call is required for
      // the common single-match lookup.
      const readArgs={action:'read',reference,offset:matches[0]?.offset??0,maxBytes:Math.max(512,pattern.length+256)};
      const page = await this.read(readArgs);
      if(matches.length&&!page.text.startsWith(needle))
        throw error('Search match changed before evidence retrieval.','CONTEXT_ARCHIVE_CORRUPT');
      return { reference, bytes: metadata.bytes, needle, startOffset: from,
        matches, scannedBytes: scanned, nextScanOffset, complete,
        ...(matches.length?{firstMatchEvidence:page,matchedReadCallTemplate:{tool:'relay_context_page',arguments:readArgs}}:{}),
        nextAction:matches.length
          ? 'firstMatchEvidence is exact archived text. If the task explicitly requests a separate read, call matchedReadCallTemplate now. Otherwise use other offsets or nextScanOffset only as needed.'
          : complete
            ? (from===0?'No literal match in the archived returned bytes. This does not prove absence in omitted original source.':'No literal match in the remainder of this archive from startOffset; earlier bytes are not covered by this call.')
            : 'No match in this bounded scan. Continue search with nextScanOffset before concluding absence.' };
    } finally { await handle.close(); }
  }

  async list({ limit = 10 } = {}) {
    const count = integer(limit, 10, 1);
    let files;
    try { files = (await fs.readdir(this.root)).filter(name => ID.test(name.slice(0, -5)) && name.endsWith('.json')); }
    catch (cause) {
      if (cause.code === 'ENOENT') return { taskId: this.taskId, items: [] };
      throw cause;
    }
    const rows = await Promise.all(files.map(async name => {
      try { return await this.metadata(name.slice(0, -5)); } catch { return null; }
    }));
    return { taskId: this.taskId, items: rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, count) };
  }

  async handle(call) {
    let args = call?.arguments ?? call?.input ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return { success: false, code: 'CONTEXT_ARCHIVE_INVALID', contentItems: [{ type: 'inputText', text: 'Invalid context tool arguments.' }] }; }
    }
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw error('Supply context action arguments as an object.');
      // Model-facing result pages must fit the bounded tool contract; the archived store and exact search remain unbounded.
      const requestedMaxBytes = args.action==='read'&&Number.isSafeInteger(args.maxBytes)&&args.maxBytes>MAX_PAGE_BYTES ? args.maxBytes:null;
      if(requestedMaxBytes!==null)args={...args,maxBytes:MAX_PAGE_BYTES};
      if(typeof args.action!=='string'||!Object.hasOwn(CONTEXT_ACTIONS,args.action))
        throw error('Choose context action read, search or list.');
      const definition=CONTEXT_ACTIONS[args.action],permitted=contextAllowed(definition);
      const ignored = Object.keys(args).filter(name => !permitted.includes(name));
      if (ignored.length) {
        const help = args.action === 'read' && ignored.includes('needle')
          ? 'Use action "search" with reference and needle, then action "read" with reference and returned match offset.'
          : args.action === 'search' && ignored.includes('offset')
            ? 'Use startOffset to resume a search. Use offset only for read.'
            : 'Send only fields used by the selected action.';
        throw error('Context action '+args.action+' does not accept '+ignored.join(', ')+'. '+help);
      }
      for(const name of definition.required)
        if(!Object.hasOwn(args,name))throw error('Context action '+args.action+' requires '+name+'. Supply the exact literal target text.');
      for(const name of Object.keys(args)){
        if(name==='action')continue;
        const value=args[name],rule=CONTEXT_FIELDS[name];
        if(rule.type==='string'){
          if(typeof value!=='string'||(rule.minLength!==undefined&&value.length<rule.minLength)||
             (rule.maxLength!==undefined&&value.length>rule.maxLength))
            throw error('Invalid '+name+' for context action '+args.action+'.');
        }else if(rule.type==='integer'&&(!Number.isSafeInteger(value)||
          (rule.minimum!==undefined&&value<rule.minimum)||(rule.maximum!==undefined&&value>rule.maximum)))
          throw error('Invalid '+name+' for context action '+args.action+'.');
      }
      if (args.action === 'list') return output(await this.list(args));
      // Omission is safe only for the unique archive actually exposed by this
      // store in this run. Never replace an explicit invalid or foreign ID.
      const reference=args.reference===undefined&&this.exposedReferences.size===1
        ? this.exposedReferences.values().next().value : args.reference;
      if(reference===undefined)throw error('Supply the exact archive reference (no unique current archive); use action list to discover references.');
      if (args.action === 'read') {
        const page=await this.read({...args,reference});
        return output(requestedMaxBytes===null?page:{...page,limitAdjusted:true,requestedMaxBytes,effectiveMaxBytes:MAX_PAGE_BYTES,
          nextAction:page.complete?'The archived result is complete.':'Continue read using the returned nextOffset; this page was bounded to the model tool budget.'});
      }
      if (args.action === 'search') return output(await this.search({...args,reference}));
      throw error('Choose context action read, search or list.');
    } catch (cause) {
      const code=cause.code||'CONTEXT_ARCHIVE_UNAVAILABLE';
      const message=String(cause.message||'Context read failed.');
      const refs=[...this.exposedReferences];
      const recovery=refs.length===1
        ? 'Current exposed archive: '+refs[0]+'. For content lookup call relay_context_page with '+JSON.stringify(searchCallTemplate(refs[0]).arguments)+' (replace the needle placeholder).'
        : 'Use relay_context_page with {"action":"list"} to obtain task archive references. If none are returned, stop querying invented archive IDs. Use relay_files for task attachments or relay_identity read for USER.md and SOUL.md.';
      return { success:false,code,
        contentItems:[{type:'inputText',text:message+' This unsuccessful lookup is NOT evidence of absence. '+(code==='CONTEXT_ARCHIVE_INVALID'||code==='CONTEXT_ARCHIVE_NOT_FOUND'?recovery:'Do not rely on the unavailable or corrupt archive.')}] };
    }
  }
}
