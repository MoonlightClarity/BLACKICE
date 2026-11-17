/**
 * Read-only Skills catalog. Saved knowledge and
 * native Codex discoveries have different execution semantics; never merge
 * their "present", "enabled" or "loaded into this turn" states.
 */
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { KNOWLEDGE_LIMITS } from './knowledge.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const limitText=(value,length=400)=>String(value??'').slice(0,length);
const same=(a,b)=>Boolean(a&&b&&(process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b)));
const digest=value=>createHash('sha256').update(process.platform==='win32'?value.toLowerCase():value).digest('hex');
const nativeId=skillPath=>'native:'+digest(path.resolve(skillPath));
/** Accept the browser's percent-encoded skill identifier, never a filesystem route. */
export function skillIdFromRequestPath(pathname) {
  if(typeof pathname!=='string'||!pathname.startsWith('/api/skills/'))return null;
  const segment=pathname.slice('/api/skills/'.length);
  if(!segment||segment.length>160||segment.includes('/'))return null;
  let id;try{id=decodeURIComponent(segment);}catch{return null;}
  return /^(?:saved:[A-Za-z0-9_-]+|native:[a-f0-9]{64})$/.test(id)?id:null;
}
const savedMeta=(entry,cwd)=>({id:'saved:'+entry.id,title:entry.title,summary:entry.summary,source:'saved',scope:entry.cwd?'workspace':'global',
  path:entry.cwd||null,revision:entry.revision,updatedAt:entry.updatedAt,provenance:entry.provenance?.source||'unknown',loaded:'not_verified',enabled:null,
  applicability:!entry.cwd?'in_scope':same(entry.cwd,cwd)?'in_scope':'other_workspace',
  appliesWhen:entry.cwd?'Only tasks in its saved working folder':'Any working folder',
  execution:'Discoverable through relay_skills search/read; not proof of automatic prompt insertion or task execution.'});
const nativeMeta=item=>({id:nativeId(item.path),title:limitText(item.name||path.basename(path.dirname(item.path)),120),
  summary:limitText(item.description||item.shortDescription||'',400),source:'codex',scope:'native_codex',path:item.path,revision:null,
  loaded:'not_loaded_in_blackice',enabled:false,applicability:'excluded_by_host',appliesWhen:'Not automatically applicable in BLACKICE Codex sessions',
  execution:'Codex reported this skill, but BLACKICE explicitly disables discovered ambient Codex skills per isolated-session configuration. Read-only inspection does not enable it.'});

export function createSkillsCatalog({knowledge,nativeSkills,defaultCwd}) {
  if(!knowledge||typeof knowledge.list!=='function'||typeof knowledge.get!=='function')throw fail('Knowledge store required.');
  if(typeof defaultCwd!=='string'||!path.isAbsolute(defaultCwd))throw fail('Default Skills folder must be absolute.');
  function folder(value) {
    if(value===undefined||value===null||value==='')return path.resolve(defaultCwd);
    if(typeof value!=='string'||value.length>2000||value.includes('\0')||!path.isAbsolute(value))throw fail('Choose an absolute working folder.');
    return path.resolve(value);
  }
  async function discoverNative(cwd,forceReload=false) {
    if(typeof nativeSkills!=='function')return {status:'unavailable',reason:'Codex skill discovery is not supported by this runtime.',entries:[]};
    try {
      const report=await nativeSkills(cwd,{forceReload});
      if(!plain(report)||!Array.isArray(report.skills))throw fail('Native Codex skill discovery returned an unreadable catalog.',503);
      if(report.available!==true)return {status:'unavailable',reason:limitText(report.reason||'Codex is not connected.',300),entries:[]};
      const seen=new Set(),items=[];
      for(const item of report.skills){
        if(typeof item?.path!=='string'||!path.isAbsolute(item.path)||item.path.length>4000)continue;
        const key=nativeId(item.path);if(seen.has(key))continue;seen.add(key);
        items.push(nativeMeta(item));
        if(items.length>=200)break;
      }
      return {status:report.errors?.length?'partial':'available',reason:report.errors?.length?limitText(report.errors.join('; '),300):null,entries:items,truncated:report.skills.length>200};
    } catch(error) {
      return {status:'error',reason:limitText(error?.message||'Codex skill discovery failed.',300),entries:[]};
    }
  }
  async function list({cwd:requestedCwd,query='',source='all',refresh=false}={}) {
    const cwd=folder(requestedCwd);
    if(typeof query!=='string'||query.length>KNOWLEDGE_LIMITS.queryChars)throw fail('Skill search must be at most 256 characters.');
    if(!['all','bundled','saved','codex'].includes(source))throw fail('Unknown skill source.');
    if(typeof refresh!=='boolean')throw fail('Invalid skill reload setting.');
    const term=query.trim().toLowerCase();
    const knowledgeEntries=source==='all'||source==='saved'?
      knowledge.list({kind:'skill',...(term?{query:term}:{}),limit:KNOWLEDGE_LIMITS.entries}).map(item=>savedMeta(item,cwd)):[];
    const native=source==='codex'?await discoverNative(cwd,refresh):{status:'not_requested',reason:null,entries:[]};
    const match=item=>!term||[item.title,item.summary,item.path,item.appliesWhen].some(value=>String(value||'').toLowerCase().includes(term));
    const entries=[...knowledgeEntries,...native.entries].filter(item=>item.source==='saved'||match(item)).sort((a,b)=>a.source.localeCompare(b.source)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
    return {cwd,entries,sources:{bundled:{status:'removed',count:0},saved:{status:'available',count:knowledgeEntries.length},codex:{status:native.status,reason:native.reason,count:native.entries.length}},
      truncated:!!native.truncated||knowledgeEntries.length>=KNOWLEDGE_LIMITS.entries,
      explanation:'A listed skill is not necessarily enabled or applied. Saved entries are searchable; BLACKICE ships no built-in skills; native Codex discoveries are disabled inside BLACKICE sessions.'};
  }
  async function detail({id,cwd:requestedCwd}={}) {
    const cwd=folder(requestedCwd);
    if(typeof id!=='string'||id.length>120)throw fail('Invalid skill identifier.',404);
    if(id.startsWith('saved:')){
      const entry=knowledge.get(id.slice(6));
      if(entry.kind!=='skill')throw fail('Skill not found.',404);
      return {...savedMeta(entry,cwd),content:entry.content};
    }
    if(id.startsWith('native:')){
      const discovery=await discoverNative(cwd);
      if(!['available','partial'].includes(discovery.status))throw fail(discovery.reason||'Codex skill discovery is unavailable.',503);
      const record=discovery.entries.find(item=>item.id===id);
      if(!record)throw fail('Native skill is no longer discoverable in this folder.',404);
      const fileStat=await stat(record.path);
      if(!fileStat.isFile()||fileStat.size>65536)throw fail('Native skill content is not an inspectable file of at most 64 KiB.',413);
      const content=await readFile(record.path,'utf8');
      if(content.includes('\0'))throw fail('Native skill is not plain text.',415);
      return {...record,content};
    }
    throw fail('Skill not found.',404);
  }
  return {list,detail};
}
