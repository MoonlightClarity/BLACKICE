import {connectorBrowserOwner} from './connector-browser-owner.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
export const DIRECT_JOB_LIMITS = Object.freeze({ jobs: 1000, requestBytes: 128 * 1024, recordBytes: 8 * 1024 * 1024, resultBytes: 4 * 1024 * 1024 });
export const DIRECT_JOB_STATES = Object.freeze(['queued', 'awaiting_input', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted']);
export const directJobTerminal = value => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(typeof value === 'string' ? value : value?.status);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'DIRECT_JOB_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const clone = value => structuredClone(value);
const timestamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const jobId = value => typeof value === 'string' && /^direct_[a-f0-9]{64}$/.test(value);
const principal = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const dead = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
/** A canonical request digest rejects changed arguments behind an idempotency key. */
export function directRequestDigest(value) {
  const canonical = item => {
    if (item === null || ['string', 'boolean'].includes(typeof item)) return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (object(item)) return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
    throw fail('Direct action requests must contain ordinary JSON values.');
  };
  let encoded;
  try { encoded = canonical(value); } catch (error) { if (error.code) throw error; throw fail('Direct action request is too deeply nested.'); }
  if (Buffer.byteLength(encoded) > DIRECT_JOB_LIMITS.requestBytes) throw fail('Direct action request exceeds 128 KiB.', 'DIRECT_JOB_TOO_LARGE', 413);
  return hash(encoded);
}

function validateRecord(value, id) {
  if (!object(value) || value.version !== 1 || !jobId(value.id) || value.id !== id || !principal(value.ownerId) || !requestId(value.requestId)
      || value.id !== `direct_${hash(`${value.ownerId}\0${value.requestId}`)}` || !/^[a-f0-9]{64}$/.test(value.requestDigest)
      || typeof value.tool !== 'string' || !object(value.arguments) || !Array.isArray(value.requiredScopes) || value.requiredScopes.some(scope => typeof scope !== 'string')
      || !DIRECT_JOB_STATES.includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.dispatched !== 'boolean'
      || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || typeof value.transientArguments !== 'boolean' || !object(value.client)
      || value.client.id !== value.ownerId || !Array.isArray(value.client.scopes) || !object(value.effects)) throw fail('A saved direct job is invalid.', 'DIRECT_JOB_STORAGE', 503);
  if (value.interaction !== null && (!object(value.interaction) || typeof value.interaction.id !== 'string' || !['browser', 'javascript_dialog', 'http_auth', 'file_chooser', 'sign_in', 'verification', 'permission'].includes(value.interaction.kind))) throw fail('A saved direct interaction is invalid.', 'DIRECT_JOB_STORAGE', 503);
  if (value.status === 'awaiting_input' && !value.interaction) throw fail('A saved direct interaction is missing.', 'DIRECT_JOB_STORAGE', 503);
  if (value.storedRequestDigest !== directRequestDigest({ tool: value.tool, arguments: value.arguments }) || !value.transientArguments && value.requestDigest !== value.storedRequestDigest) throw fail('A saved direct request has changed.', 'DIRECT_JOB_STORAGE', 503);
  return value;
}

// This projection deliberately has no arguments, client or result payload. Full
// version-1 receipts remain authoritative on disk and are hydrated on demand.
function metadata(value) {
  return { id: value.id, ownerId: value.ownerId, requestId: value.requestId, tool: value.tool,
    browserConversationId: value.arguments?.conversationId ?? value.browserConversationId ?? null,
    action: value.arguments?.action ?? value.action ?? (value.tool === 'blackice_run_command' ? 'run' : null),
    status: value.status, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt,
    startedAt: value.startedAt, finishedAt: value.finishedAt, dispatched: value.dispatched,
    effects: clone(value.effects), error: clone(value.error), interaction: clone(value.interaction), requiredScopes: [...value.requiredScopes],
    resultAvailable: Object.hasOwn(value, 'resultAvailable') ? value.resultAvailable : value.result !== null };
}


/** Indexed receipt storage. Startup reads unfinished records only, never historical payloads. */
export class DirectExecutionJobs {
  constructor({dataDir, io=fs, maxJobs=DIRECT_JOB_LIMITS.jobs, onStartupDiagnostics=null}={}) {
    if(typeof dataDir!=='string'||!path.isAbsolute(dataDir)) throw fail('Direct jobs need an absolute data directory.');
    if(!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>DIRECT_JOB_LIMITS.jobs) throw fail('Use a supported direct-job limit.');
    this.directory=path.join(dataDir,'direct-execution-jobs'); this.databaseFile=path.join(dataDir,'direct-execution.sqlite');
    this.leaseFile=path.join(this.directory,'executor.lock'); this.io=io; this.maxJobs=maxJobs;
    this.token=randomUUID(); this.hasLease=false; this.closed=false; this.ready=null; this.tail=Promise.resolve(); this.storageError=null;
    this.startup={phase:null,retryable:false}; this.onStartupDiagnostics=onStartupDiagnostics; this.db=null;
  }
  async ensureDirectory() {
    await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await this.io.lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('The direct-job directory must be an ordinary local directory.', 'DIRECT_JOB_STORAGE', 503);
  }
  async publishLease(file = this.leaseFile) {
    const temporary = `${file}.${randomUUID()}.tmp`; let handle;
    try {
      handle = await this.io.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token: this.token })); await handle.sync();
      await this.io.link(temporary, file); if (file === this.leaseFile) this.hasLease = true;
    } finally { await handle?.close(); await this.io.rm(temporary, { force: true }).catch(() => {}); }
  }
  async readLease(file = this.leaseFile) {
    const info = await this.io.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw fail('Direct execution storage is locked by an unrecognized owner.', 'DIRECT_JOB_LOCKED', 503);
    const raw = await this.io.readFile(file, 'utf8'); let owner;
    try { owner = JSON.parse(raw); } catch { throw fail('Direct execution storage is locked by an unrecognized owner.', 'DIRECT_JOB_LOCKED', 503); }
    if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || owner.token.length > 120) throw fail('Direct execution storage is locked by an unrecognized owner.', 'DIRECT_JOB_LOCKED', 503);
    return { owner, raw };
  }
  async acquireLease(file = this.leaseFile, depth = 0) {
    if (depth > 8) throw fail('Direct execution ownership recovery needs local review.', 'DIRECT_JOB_LOCKED', 503);
    try { await this.publishLease(file); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const { owner, raw } = await this.readLease(file);
    if (!dead(owner.pid)) throw fail('Another BLACKICE process owns direct execution. Close that process before enabling this connector.', 'DIRECT_JOB_LOCKED', 503);
    // A hard-link claim ensures only one contender removes this exact stale lease.
    const claim = `${file}.reclaim-${hash(raw)}`;
    await this.acquireLease(claim, depth + 1);
    try {
      if ((await this.io.readFile(file, 'utf8')) !== raw || !dead(owner.pid)) throw fail('Direct execution ownership changed. Retry connector startup.', 'DIRECT_JOB_LOCKED', 503);
      await this.io.unlink(file); await this.publishLease(file);
    } catch (error) {
      if (error.code === 'EEXIST') throw fail('Direct execution ownership is being recovered. Retry connector startup.', 'DIRECT_JOB_LOCKED', 503);
      throw error;
    } finally {
      const current = await this.readLease(claim);
      if (current.owner.pid === process.pid && current.owner.token === this.token) await this.io.unlink(claim);
    }
  }
  async assertLease() {
    if (!this.hasLease) throw fail('Direct execution storage has no owner.', 'DIRECT_JOB_STORAGE', 503);
    let owner;
    try { ({ owner } = await this.readLease()); } catch { throw fail('Direct execution storage ownership could not be verified.', 'DIRECT_JOB_STORAGE', 503); }
    if (owner.pid !== process.pid || owner.token !== this.token) throw fail('Direct execution storage ownership changed.', 'DIRECT_JOB_STORAGE', 503);
  }
  async releaseLease() {
    if (!this.hasLease) return;
    try { const { owner } = await this.readLease(); if (owner.pid === process.pid && owner.token === this.token) await this.io.unlink(this.leaseFile); }
    finally { this.hasLease = false; }
  }

  init(){ if(this.closed)return Promise.reject(fail('Direct execution storage is closed.','DIRECT_JOB_CLOSED',503)); return this.ready ||= this.initialize(); }
  async initialize(){
    const started=performance.now();let recovered=0;
    try{
      this.startup.phase='lease';await this.ensureDirectory();await this.acquireLease();
      // Explicit offline import is required. Never silently forget old request IDs.
      try { await this.io.stat(this.databaseFile); }
      catch(error){if(error.code!=='ENOENT')throw error;
        const names=await this.io.readdir(this.directory);
        if(names.some(name=>/^direct_[a-f0-9]{64}\.json$/.test(name)||name.includes('manifest')))
          throw fail('Existing receipts require explicit offline SQLite import; original records were preserved.','DIRECT_JOB_IMPORT_REQUIRED',503);
      }
      this.db=new DatabaseSync(this.databaseFile); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      const version=this.db.prepare('PRAGMA user_version').get().user_version;
      if(version!==0&&version!==1)throw fail('Unsupported receipt database version.','DIRECT_JOB_STORAGE',503);
      this.db.exec(SCHEMA);
      this.startup.phase='recovery';
      this.transaction(()=>{
        const pending=this.db.prepare('SELECT id FROM jobs WHERE terminal=0').all();
        for(const {id} of pending){
          const record=this.read(id);const at=timestamp();
          this.write({...record,status:'interrupted',revision:record.revision+1,updatedAt:at,finishedAt:at,interaction:null,
            effects:{possible:record.dispatched&&record.mutating,confirmed:false},
            error:{code:'DIRECT_JOB_RESTARTED',message:record.dispatched?'BLACKICE restarted before the final result was saved. Inspect effects; the action was not replayed.':'BLACKICE restarted before dispatch. The action was not replayed.'}});
          recovered++;
        }
      });
      this.startup.phase='ready';return this;
    }catch(error){this.storageError=error;this.startup.phase='failed';this.db?.close();this.db=null;await this.releaseLease();throw error;}
    finally{try{Promise.resolve(this.onStartupDiagnostics?.({component:'system',event:'direct_jobs_startup',outcome:this.startup.phase,durationMs:Math.round(performance.now()-started),recovered,historicalPayloadsRead:0,storage:'sqlite'})).catch(()=>{});}catch{}}
  }
  transaction(operation){this.db.exec('BEGIN IMMEDIATE');try{const value=operation();this.db.exec('COMMIT');return value;}catch(error){try{this.db.exec('ROLLBACK');}catch{}if(error.code==='ERR_SQLITE_ERROR'){this.storageError=fail('Receipt transaction failed. Reopen storage before dispatching more work.','DIRECT_JOB_STORAGE',503);throw this.storageError;}throw error;}}
  read(id,ownerId){
    if(!jobId(id))throw fail('Use a valid direct job ID.');
    const row=this.db.prepare('SELECT j.owner_id,p.body FROM jobs j LEFT JOIN payloads p ON p.id=j.id WHERE j.id=?').get(id);
    if(!row||ownerId!==undefined&&row.owner_id!==ownerId)throw fail('This direct job is unavailable.','DIRECT_JOB_NOT_FOUND',404);
    try{if(typeof row.body!=='string')throw Error('Missing payload');return JSON.parse(row.body);}catch(error){this.storageError=fail('Saved receipt payload could not be read. Existing data was preserved.','DIRECT_JOB_STORAGE',503);throw this.storageError;}
  }
  write(record){
    validateRecord(record,record.id);
    const body=JSON.stringify(record);if(Buffer.byteLength(body)>DIRECT_JOB_LIMITS.recordBytes)throw fail('Receipt exceeds its storage limit.','DIRECT_JOB_TOO_LARGE',413);
    const meta=JSON.stringify(metadata(record));
    this.db.prepare('INSERT INTO jobs(id,owner_id,request_id,request_digest,status,terminal,created_at,metadata,browser_owner) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,terminal=excluded.terminal,metadata=excluded.metadata,browser_owner=excluded.browser_owner').run(record.id,record.ownerId,record.requestId,record.requestDigest,record.status,Number(directJobTerminal(record)),record.createdAt,meta,record.arguments?.conversationId||connectorBrowserOwner(record.ownerId).taskId);
    this.db.prepare('INSERT INTO payloads(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id,body);
  }
  serialized(operation){
    if(this.closed)return Promise.reject(fail('Direct execution storage is closed.','DIRECT_JOB_CLOSED',503));
    const pending=this.tail.catch(()=>{}).then(async()=>{await this.init();if(this.storageError)throw this.storageError;await this.assertLease();return operation();});this.tail=pending;return pending;
  }
  get(id,{ownerId}={}){return this.serialized(()=>this.read(id,ownerId));}
  filter({ownerId,status,unfinishedOnly=false}={}){
    if(ownerId!==undefined&&!principal(ownerId)||status!==undefined&&!DIRECT_JOB_STATES.includes(status)||typeof unfinishedOnly!=='boolean')throw fail('Use a supported direct-job filter.');
    const where=[],args=[];if(ownerId!==undefined){where.push('owner_id=?');args.push(ownerId);}if(status!==undefined){where.push('status=?');args.push(status);}if(unfinishedOnly)where.push('terminal=0');
    return {sql:where.length?' WHERE '+where.join(' AND '):'',args};
  }
  ownerSnapshot({ownerTaskId,unfinishedOnly=false,activeIds=[]}){
    if(this.closed||this.storageError||this.startup.phase!=='ready')throw fail('Direct lifecycle is unavailable.','DIRECT_JOB_STORAGE',503);
    const args=[ownerTaskId];let where=' WHERE browser_owner=?';
    if(unfinishedOnly){where+=' AND (terminal=0';if(activeIds.length){where+=' OR id IN ('+activeIds.map(()=>'?').join(',')+')';args.push(...activeIds);}where+=')';}
    return this.db.prepare('SELECT metadata FROM jobs'+where+' ORDER BY created_at,id').all(...args).map(row=>JSON.parse(row.metadata));
  }
  snapshot(options={}){return this.serialized(()=>{const f=this.filter(options);return this.db.prepare('SELECT metadata FROM jobs'+f.sql+' ORDER BY created_at DESC,id DESC').all(...f.args).map(row=>JSON.parse(row.metadata));});}
  counts({ownerId}={}){return this.serialized(()=>{const f=this.filter({ownerId});const total=this.db.prepare('SELECT count(*) AS n FROM jobs'+f.sql).get(...f.args).n;const active=this.filter({ownerId,unfinishedOnly:true});return {total,unfinished:this.db.prepare('SELECT count(*) AS n FROM jobs'+active.sql).get(...active.args).n};});}
  listMetadata(options={}){return this.list({...options,metadataOnly:true});}
  list({ownerId,status,offset=0,limit=40,metadataOnly=false}={}){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||typeof metadataOnly!=='boolean')return Promise.reject(fail('Use a supported direct-job filter.'));
    return this.serialized(()=>{const f=this.filter({ownerId,status});const total=this.db.prepare('SELECT count(*) AS n FROM jobs'+f.sql).get(...f.args).n;
      const rows=this.db.prepare('SELECT id,metadata FROM jobs'+f.sql+' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(...f.args,limit,offset);
      return {jobs:rows.map(row=>metadataOnly?JSON.parse(row.metadata):this.read(row.id)),total,offset,limit,nextOffset:offset+limit<total?offset+limit:null};});
  }
  findRequest({ownerId,requestId:requestedId,requestDigest}){
    if(!principal(ownerId)||!requestId(requestedId)||!/^[a-f0-9]{64}$/.test(requestDigest))return Promise.reject(fail('Use a valid direct request identity and digest.'));
    return this.serialized(()=>{const row=this.db.prepare('SELECT id,request_digest FROM jobs WHERE owner_id=? AND request_id=?').get(ownerId,requestedId);if(!row)return null;
      if(row.request_digest!==requestDigest)throw fail('This requestId belongs to different action arguments.','DIRECT_REQUEST_CONFLICT',409);return this.read(row.id);});
  }
  admit({ownerId,requestId:requestedId,tool,arguments:args,requiredScopes,client,mutating,interaction=null,originalRequestDigest,transientArguments=false}){
    if(!principal(ownerId)||!requestId(requestedId)||typeof tool!=='string'||!object(args)||!object(client)||client.id!==ownerId||!Array.isArray(requiredScopes)||typeof mutating!=='boolean')return Promise.reject(fail('Use a valid direct action request.'));
    const storedRequestDigest=directRequestDigest({tool,arguments:args}),requestDigest=originalRequestDigest||storedRequestDigest;
    return this.serialized(()=>this.transaction(()=>{
      const existing=this.db.prepare('SELECT id,request_digest FROM jobs WHERE owner_id=? AND request_id=?').get(ownerId,requestedId);
      if(existing){if(existing.request_digest!==requestDigest)throw fail('This requestId belongs to different action arguments.','DIRECT_REQUEST_CONFLICT',409);return {created:false,job:this.read(existing.id)};}
      if(this.db.prepare('SELECT count(*) AS n FROM jobs WHERE terminal=0').get().n>=this.maxJobs)throw fail('Finish or cancel pending work before admitting another action.','DIRECT_JOB_LIMIT',503);
      const at=timestamp();const record={version:1,id:'direct_'+hash(ownerId+'\0'+requestedId),ownerId,requestId:requestedId,requestDigest,storedRequestDigest,transientArguments,tool,arguments:clone(args),requiredScopes:clone(requiredScopes),client:clone(client),mutating,interaction:clone(interaction),status:interaction?'awaiting_input':'queued',revision:1,createdAt:at,updatedAt:at,startedAt:null,finishedAt:null,dispatched:false,effects:{possible:false,confirmed:false},result:null,error:null};
      this.write(record);return {created:true,job:record};
    }));
  }
  update(id,updater,{expectedRevision}={}){
    if(typeof updater!=='function')return Promise.reject(fail('Direct job update requires an operation.'));
    return this.serialized(()=>this.transaction(()=>{const current=this.read(id);if(expectedRevision!==undefined&&current.revision!==expectedRevision)throw Object.assign(fail('This direct job changed.','DIRECT_JOB_CONFLICT',409),{currentRevision:current.revision});
      const change=updater(clone(current));if(change===null)return current;if(!object(change))throw fail('Invalid direct job update.');
      for(const key of ['id','ownerId','requestId','requestDigest','storedRequestDigest','transientArguments','tool','arguments','requiredScopes','client','createdAt','mutating'])if(Object.hasOwn(change,key))throw fail('Cannot change admitted request fields.');
      const next={...current,...change,revision:current.revision+1,updatedAt:timestamp()};
      if(directJobTerminal(current)&&!directJobTerminal(next)&&this.db.prepare('SELECT count(*) AS n FROM jobs WHERE terminal=0').get().n>=this.maxJobs)throw fail('Too many unfinished jobs.','DIRECT_JOB_LIMIT',503);
      this.write(next);return next;
    }));
  }
  async close(){this.closed=true;await this.tail.catch(()=>{});await this.ready?.catch(()=>{});this.db?.close();this.db=null;await this.releaseLease();}
}
export const SCHEMA=`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,request_id TEXT NOT NULL,request_digest TEXT NOT NULL,status TEXT NOT NULL,terminal INTEGER NOT NULL,created_at TEXT NOT NULL,metadata TEXT NOT NULL,browser_owner TEXT NOT NULL,UNIQUE(owner_id,request_id));
CREATE INDEX IF NOT EXISTS jobs_browser_owner ON jobs(browser_owner,terminal,created_at);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(terminal) WHERE terminal=0;
CREATE INDEX IF NOT EXISTS jobs_owner_created ON jobs(owner_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS payloads(id TEXT PRIMARY KEY REFERENCES jobs(id),body TEXT NOT NULL);
PRAGMA user_version=1;`;
