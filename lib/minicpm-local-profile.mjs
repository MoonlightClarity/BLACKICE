import path from 'node:path';
import {promises as fs} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {prepareLocalModelProfileAssets, verifyLocalModelProfileAssetFile} from './local-model-profile-assets.mjs';
import {registerLocalModel, LOCAL_ENGINES} from './local-model-manager.mjs';
import {validateLlamaCppSettings} from './llama-cpp-launch-config.mjs';

const REVISION = 'c353e931b31f4bb6217b84ff99f0d1b6da93d97d';
const REPOSITORY = 'saidutta69/MiniCPM-V-4.7-1B-heretic';
const asset = (id, fileName, sizeBytes, sha256) => Object.freeze({id, fileName,
  url:'https://huggingface.co/' + REPOSITORY + '/resolve/' + REVISION + '/' + fileName, sizeBytes, sha256});
export const MINICPM_LOCAL_MODEL_ID = 'MiniCPM-V-4.7-1B-heretic-Q4_K_S';
export const MINICPM_LOCAL_ASSET_MANIFEST = Object.freeze({profileId:'minicpm-v4.7-1b-heretic-q4-k-s', version:REVISION,
  assets:Object.freeze([
    asset('model', MINICPM_LOCAL_MODEL_ID + '.gguf', 647960224, '0c91d961f2eb27e8b32bbcdbae45bcdc06002e55022c6ee66ba3bf4ce347116a'),
    asset('projector', 'MiniCPM-V-4.7-1B-heretic-mmproj-F16.gguf', 1108763232, '9e1672166a455f579b4a441590d93f13342a08ecc159719c8eb7a1eac101317f'),
  ])});

// Root supplies a reviewed native recipe after live qualification. Its absence
// keeps the product setup unavailable; it is never replaced by guessed settings.
export const QUALIFIED_MINICPM_LOCAL_PROFILE = null;

const SCHEMA = 'blackice.minicpm-local-setup.v1';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const fail = (message, code = 'LOCAL_PROFILE_ARGUMENTS', status = 400, extra = {}) => Object.assign(new Error(message), {code, status, ...extra});
const abort = signal => { if (signal?.aborted) throw fail('Local setup was cancelled.', 'LOCAL_PROFILE_CANCELLED', 499); };
const terminal = value => ['complete', 'failed', 'cancelled'].includes(value);
const intentPattern = /^[a-z0-9][a-z0-9_-]{7,79}$/i;
const requestKeys = ['intentId', 'profileId', 'expectedRevision', 'expectedLocalDefaultModel', 'expectedLocalDefaultInitialized'];

class MiniCPMLocalProfileSetup {
  constructor({manager, runtime, dataDir, qualifiedProfile = QUALIFIED_MINICPM_LOCAL_PROFILE,
    prepareAssets = prepareLocalModelProfileAssets, assetManifest = MINICPM_LOCAL_ASSET_MANIFEST} = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw TypeError('An absolute local profile data directory is required.');
    this.manager = manager; this.runtime = runtime; this.prepareAssets = prepareAssets;
    // The dependency is for trusted product definitions and tiny test fixtures;
    // it is never accepted from the HTTP request or user-editable settings.
    this.manifest = clone(assetManifest);
    if (!plain(this.manifest) || typeof this.manifest.profileId !== 'string' || typeof this.manifest.version !== 'string' ||
      !Array.isArray(this.manifest.assets) || this.manifest.assets.length !== 2 ||
      this.manifest.assets[0]?.id !== 'model' || this.manifest.assets[1]?.id !== 'projector') throw TypeError('Use the trusted model/projector manifest.');
    this.manifestDigest = digest(this.manifest);
    this.recipe = null;
    if (qualifiedProfile !== null) {
      if (!plain(qualifiedProfile) || Object.keys(qualifiedProfile).some(key => !['version', 'settings'].includes(key)) ||
        typeof qualifiedProfile.version !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(qualifiedProfile.version) ||
        !plain(qualifiedProfile.settings) || Object.hasOwn(qualifiedProfile.settings, 'mmprojPath')) throw TypeError('Use a trusted versioned native recipe without machine paths.');
      const settings = validateLlamaCppSettings({modelOverrides:{[MINICPM_LOCAL_MODEL_ID]:qualifiedProfile.settings}}).modelOverrides[MINICPM_LOCAL_MODEL_ID];
      this.recipe = {version:qualifiedProfile.version, settings};
    }
    this.directory = path.join(dataDir, 'local-model-profile-setups');
    this.latestPath = path.join(this.directory, 'latest.json');
    this.latest = null; this.ready = null; this.flight = null; this.closed = false;
  }

  capable() {
    return typeof this.manager?.llamaConfig === 'function' && typeof this.manager?.configureLlama === 'function' &&
      typeof this.runtime?.localDefaultModelPreference === 'function' && typeof this.runtime?.initializeLocalDefaultModel === 'function' &&
      typeof this.runtime?.listProviders === 'function' && typeof this.runtime?.saveProvider === 'function';
  }
  available() { return Boolean(this.recipe && this.capable() && !this.closed); }
  preference() { return this.runtime?.localDefaultModelPreference?.() || {model:null, initialized:true, eligible:false, reason:null}; }
  summary() {
    const preference = this.preference(), available = this.available();
    const provider = (this.runtime?.listProviders?.() || []).find(item => item.preset === 'llamacpp' && item.type === 'compatible' && item.baseUrl === LOCAL_ENGINES.llamacpp.baseUrl);
    return {profileId:this.manifest.profileId, displayName:'MiniCPM-V 4.7 1B heretic · Q4_K_S', available,
      providerId:provider?.id || 'local_llamacpp',
      downloadBytes:this.manifest.assets.reduce((sum, item) => sum + item.sizeBytes, 0),
      offerSetup:available && preference.model === null && preference.initialized === false};
  }
  status() {
    const value = this.summary(), preference = this.preference();
    const snapshot = this.manager?.llamaConfig?.();
    const receipt = this.latest ? clone(this.latest) : null;
    if (receipt?.status === 'running' && !this.flight) { receipt.status = 'interrupted'; receipt.outcomeUncertain = true; }
    return {...value, expectedRevision:snapshot?.revision ?? null, expectedLocalDefaultModel:preference.model,
      expectedLocalDefaultInitialized:preference.initialized, receipt};
  }
  async init() {
    return this.ready ||= (async () => {
      let latest;
      try { latest = JSON.parse(await fs.readFile(this.latestPath, 'utf8')); }
      catch (cause) { if (cause.code === 'ENOENT') return this; throw fail('Saved local setup status could not be read.', 'LOCAL_PROFILE_RECEIPT_UNREADABLE', 500); }
      if (!intentPattern.test(latest?.intentId || '')) throw fail('Saved local setup status is invalid.', 'LOCAL_PROFILE_RECEIPT_UNREADABLE', 500);
      this.latest = await this.readReceipt(latest.intentId);
      return this;
    })();
  }
  async readReceipt(intentId) {
    const filename = path.join(this.directory, intentId + '.json');
    let info;
    try { info = await fs.lstat(filename); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw fail('Saved local setup receipt is invalid.', 'LOCAL_PROFILE_RECEIPT_UNREADABLE', 500);
    let value;
    try { value = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch { throw fail('Saved local setup receipt could not be read.', 'LOCAL_PROFILE_RECEIPT_UNREADABLE', 500); }
    if (value?.schema !== SCHEMA || value.intentId !== intentId || !['running', 'complete', 'failed', 'cancelled'].includes(value.status) || typeof value.requestDigest !== 'string')
      throw fail('Saved local setup receipt is invalid.', 'LOCAL_PROFILE_RECEIPT_UNREADABLE', 500);
    return value;
  }
  async atomicJSON(filename, value) {
    const text = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(text) > 65536) throw fail('Local setup receipt exceeded its storage limit.', 'LOCAL_PROFILE_RECEIPT_WRITE', 500);
    await fs.mkdir(this.directory, {recursive:true});
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(temporary, text, {encoding:'utf8', flag:'wx'}); await fs.rename(temporary, filename); }
    finally { await fs.rm(temporary, {force:true}).catch(() => {}); }
  }
  async persist(receipt) {
    const value = {...clone(receipt), savedAt:new Date().toISOString()};
    await this.atomicJSON(path.join(this.directory, receipt.intentId + '.json'), value);
    this.latest = value; receipt.savedAt = value.savedAt;
    await this.atomicJSON(this.latestPath, {intentId:receipt.intentId});
  }
  validateRequest(value) {
    if (!plain(value) || Object.keys(value).some(key => !requestKeys.includes(key)) || requestKeys.some(key => !Object.hasOwn(value, key)) ||
      !intentPattern.test(value.intentId || '') || value.profileId !== this.manifest.profileId ||
      !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
      !(value.expectedLocalDefaultModel === null || typeof value.expectedLocalDefaultModel === 'string' && value.expectedLocalDefaultModel.length <= 600 && value.expectedLocalDefaultModel.includes('::')) ||
      typeof value.expectedLocalDefaultInitialized !== 'boolean') throw fail('Supply the current local setup expectations and a unique intent ID.');
    return Object.fromEntries(requestKeys.map(key => [key, value[key]]));
  }
  checkExpectations(request) {
    const config = this.manager.llamaConfig(), preference = this.preference();
    if (config.revision !== request.expectedRevision) throw fail('Local launch settings changed. Refresh before setting up this model.', 'LOCAL_LLAMA_SETTINGS_REVISION', 409);
    if (preference.model !== request.expectedLocalDefaultModel || preference.initialized !== request.expectedLocalDefaultInitialized)
      throw fail('The local preference changed. Existing choices were preserved.', 'LOCAL_DEFAULT_CONFLICT', 409);
    return config;
  }
  managedProvider() {
    const provider = this.runtime.listProviders().find(item => item.preset === 'llamacpp' && item.type === 'compatible' && item.baseUrl === LOCAL_ENGINES.llamacpp.baseUrl);
    if (provider && (provider.enabled === false || provider.endpoints?.chatCompletions))
      throw fail('The managed local connection is disabled or has a custom chat endpoint. Its settings were preserved.', 'LOCAL_MODEL_REGISTRATION_CONFLICT', 409);
    return provider;
  }
  setup(value, {signal} = {}) {
    // This is deliberately before init(), directory/receipt creation and every
    // asset or configuration operation. There is no prepare-only product flow.
    if (!this.available()) return Promise.reject(fail('MiniCPM local setup is unavailable.', 'LOCAL_PROFILE_UNAVAILABLE', 503));
    let request;
    try { request = this.validateRequest(value); } catch (cause) { return Promise.reject(cause); }
    const requestDigest = digest({request, manifest:this.manifestDigest, recipe:this.recipe});
    if (this.flight) {
      if (this.flight.intentId === request.intentId && this.flight.requestDigest === requestDigest) return this.flight.promise;
      return Promise.reject(fail('Another local setup is still running. Check its saved status.', 'LOCAL_PROFILE_BUSY', 409, {receipt:clone(this.latest)}));
    }
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const promise = this.execute(request, requestDigest, combined).finally(() => { if (this.flight?.promise === promise) this.flight = null; });
    this.flight = {intentId:request.intentId, requestDigest, controller, promise};
    return promise;
  }
  async execute(request, requestDigest, signal) {
    await this.init();
    const existing = await this.readReceipt(request.intentId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw fail('This setup intent belongs to different expectations.', 'LOCAL_PROFILE_INTENT_CONFLICT', 409, {receipt:existing});
      this.latest = existing;
      if (existing.status === 'complete') return clone(existing);
      if (!terminal(existing.status)) throw fail('The previous setup was interrupted. Inspect its saved stages before starting a new intent.', 'LOCAL_PROFILE_INTERRUPTED', 409,
        {receipt:{...existing, status:'interrupted', outcomeUncertain:true}});
      throw fail(existing.error?.message || 'The saved setup did not complete.', existing.error?.code || 'LOCAL_PROFILE_ERROR', existing.error?.status || 500, {receipt:existing});
    }
    const receipt = {schema:SCHEMA, intentId:request.intentId, profileId:this.manifest.profileId, recipeVersion:this.recipe.version,
      manifestSha256:this.manifestDigest, requestDigest, request:clone(request), startedAt:new Date().toISOString(), status:'running', stage:'admission',
      assets:[], assetPreparation:null, settings:null, registration:null, localDefault:null, limitations:[]};
    try {
      abort(signal);
      const config = this.checkExpectations(request); this.managedProvider();
      await this.persist(receipt);
      const settings = clone(config.settings), overrides = settings.modelOverrides || {}, modelPaths = settings.modelPaths || {};
      const hasOverride = Object.hasOwn(overrides, MINICPM_LOCAL_MODEL_ID), existingOverride = overrides[MINICPM_LOCAL_MODEL_ID];
      const configured = {model:Object.hasOwn(modelPaths, MINICPM_LOCAL_MODEL_ID) ? modelPaths[MINICPM_LOCAL_MODEL_ID] : null,
        projector:hasOverride && Object.hasOwn(existingOverride, 'mmprojPath') ? existingOverride.mmprojPath : null};
      receipt.stage = 'verify-configured'; await this.persist(receipt);
      // Both configured paths are checked before any canonical asset preparation.
      for (const asset of this.manifest.assets) if (configured[asset.id] !== null) {
        abort(signal);
        const verified = await verifyLocalModelProfileAssetFile({asset, filePath:configured[asset.id], signal});
        receipt.assets.push({...verified, source:'configured'}); await this.persist(receipt);
      }
      const unconfigured = this.manifest.assets.filter(asset => configured[asset.id] === null);
      if (unconfigured.length) {
        abort(signal);
        receipt.stage = 'prepare-assets'; await this.persist(receipt);
        const destination = settings.modelsDirectory || config.defaultModelsDirectory;
        if (settings.modelsDirectory) {
          const info = await fs.lstat(settings.modelsDirectory).catch(() => null);
          if (!info?.isDirectory() || info.isSymbolicLink()) throw fail('The configured models directory is unavailable. Its path was preserved.', 'LOCAL_LLAMA_MODELS_DIRECTORY_MISSING', 404);
        }
        const prepared = await this.prepareAssets({manifest:{...this.manifest, assets:unconfigured}, modelsDirectory:destination, signal});
        if (prepared?.status !== 'ready' || !Array.isArray(prepared.assets)) throw fail('Asset preparation did not confirm completion.', 'LOCAL_PROFILE_ASSET_RESULT', 502);
        receipt.assetPreparation = prepared;
        for (const asset of unconfigured) {
          const item = prepared.assets.find(entry => entry.id === asset.id);
          if (!item || !['reused', 'published'].includes(item.status) || item.observed?.sizeBytes !== asset.sizeBytes || item.observed?.sha256 !== asset.sha256)
            throw fail('An asset preparation receipt did not match the pinned identity.', 'LOCAL_PROFILE_ASSET_RESULT', 502);
          receipt.assets.push({...item, source:'managed'});
        }
        await this.persist(receipt);
      }
      abort(signal);
      // The long transfer cannot authorize applying a stale settings snapshot.
      this.checkExpectations(request); this.managedProvider();
      const verifiedModel = receipt.assets.find(item => item.id === 'model'), verifiedProjector = receipt.assets.find(item => item.id === 'projector');
      if (!verifiedModel || !verifiedProjector) throw fail('Both pinned model assets must be verified.', 'LOCAL_PROFILE_ASSET_RESULT', 502);
      settings.modelPaths = {...modelPaths};
      if (!Object.hasOwn(modelPaths, MINICPM_LOCAL_MODEL_ID)) settings.modelPaths[MINICPM_LOCAL_MODEL_ID] = verifiedModel.path;
      settings.modelOverrides = {...overrides};
      if (!hasOverride) settings.modelOverrides[MINICPM_LOCAL_MODEL_ID] = {...this.recipe.settings, mmprojPath:verifiedProjector.path};
      else {
        receipt.limitations.push('Existing per-model overrides were preserved; the supplied runtime defaults were not applied.');
        if (!existingOverride.mmprojPath) receipt.limitations.push('The projector is verified on disk, but the existing override does not configure it.');
      }
      receipt.stage = 'settings'; await this.persist(receipt); abort(signal);
      const changed = JSON.stringify(settings) !== JSON.stringify(config.settings);
      const saved = changed ? await this.manager.configureLlama({expectedRevision:request.expectedRevision, settings}) : config;
      receipt.settings = {status:changed ? 'saved' : 'unchanged', revision:saved.revision, modelPath:settings.modelPaths[MINICPM_LOCAL_MODEL_ID],
        overrideDisposition:hasOverride ? 'preserved-explicit' : 'initialized', profileApplied:!hasOverride,
        projectorConfigured:Boolean(settings.modelOverrides[MINICPM_LOCAL_MODEL_ID]?.mmprojPath)};
      await this.persist(receipt); abort(signal);
      receipt.stage = 'registration'; await this.persist(receipt); abort(signal);
      const provider = this.managedProvider();
      receipt.registration = provider?.models?.some(item => item.id === MINICPM_LOCAL_MODEL_ID)
        ? {status:'existing', providerId:provider.id, selection:provider.id + '::' + MINICPM_LOCAL_MODEL_ID}
        : {status:'saved', ...await registerLocalModel(this.runtime, 'llamacpp', MINICPM_LOCAL_MODEL_ID, {guarded:true})};
      await this.persist(receipt); abort(signal);
      receipt.stage = 'local-default'; await this.persist(receipt); abort(signal);
      if (!request.expectedLocalDefaultInitialized && request.expectedLocalDefaultModel === null) {
        await this.runtime.initializeLocalDefaultModel(receipt.registration.selection, {expectedLocalDefaultModel:null, expectedLocalDefaultInitialized:false});
        receipt.localDefault = {status:'initialized', ...this.preference()};
      } else receipt.localDefault = {status:'preserved', ...this.preference()};
      await this.persist(receipt);
      receipt.status = 'complete'; receipt.stage = 'complete'; receipt.finishedAt = new Date().toISOString();
      await this.persist(receipt); return clone(receipt);
    } catch (cause) {
      const error = typeof cause?.code === 'string' ? cause : fail('Local setup could not be completed.', 'LOCAL_PROFILE_ERROR', 500);
      const isCancelled = signal.aborted || /CANCELLED$/.test(error.code);
      receipt.status = isCancelled ? 'cancelled' : 'failed'; receipt.finishedAt = new Date().toISOString();
      receipt.error = {code:isCancelled ? 'LOCAL_PROFILE_CANCELLED' : error.code, status:isCancelled ? 499 : error.status || 500,
        message:String(isCancelled ? 'Local setup was cancelled.' : error.message || 'Local setup could not be completed.').slice(0, 1200)};
      if (error.verification) receipt.failedVerification = error.verification;
      if (error.receipt?.schema === 'blackice.local-model-profile-assets.v1') receipt.assetPreparation = error.receipt;
      try { await this.persist(receipt); }
      catch { receipt.persistenceError = 'The latest setup receipt could not be saved. Completed effects remain as reported.'; this.latest = clone(receipt); }
      throw fail(receipt.error.message, receipt.error.code, receipt.error.status, {receipt:clone(receipt)});
    }
  }
  async close() {
    this.closed = true;
    const flight = this.flight;
    if (flight) { flight.controller.abort(); await flight.promise.catch(() => {}); }
  }
}

export function createMiniCPMLocalProfileSetup(options) { return new MiniCPMLocalProfileSetup(options); }
