'use strict';
// Creates one owned qualification profile. It does not launch an app or model.
// The same profile must be retained across all fresh benchmark tasks.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const config = {
  "schema": "blackice.native-candidate-preparation.v1",
  "candidateRoot": "C:\\Users\\user\\Documents\\Codex\\BLACKICE-minicpm-agent-tools-20261122",
  "profileDir": "C:\\Users\\user\\Documents\\Codex\\BLACKICE-minicpm-resume-evidence-20261121\\postmerge-20261121\\quality-settings-01\\NQ1-native-qualification-01\\profile",
  "receiptDir": "C:\\Users\\user\\Documents\\Codex\\BLACKICE-minicpm-resume-evidence-20261121\\postmerge-20261121\\quality-settings-01\\NQ1-native-qualification-01\\receipts",
  "primaryProfile": "C:\\Users\\user\\AppData\\Roaming\\Relay",
  "modelId": "MiniCPM-V-4.7-1B-heretic-Q4_K_S",
  "modelFile": "C:\\Users\\user\\AppData\\Roaming\\Relay\\data\\models\\MiniCPM-V-4.7-1B-heretic-Q4_K_S.gguf",
  "modelSha256": "0c91d961f2eb27e8b32bbcdbae45bcdc06002e55022c6ee66ba3bf4ce347116a",
  "llamaExecutable": "C:\\Users\\user\\AppData\\Local\\Programs\\BLACKICE\\resources\\llama.cpp\\vulkan\\llama-server.exe",
  "llamaSha256": "38c5affb81c9a8f88f5538c7d11bc445e13bc46a2c6eda05694b8b31a8d45995",
  "rawElectron": "C:\\Users\\user\\Documents\\Codex\\BLACKICE-integration-24073-20261121\\node_modules\\electron\\dist\\electron.exe",
  "nativeModel": "gpt-6-luna"
};
const hash = value => createHash('sha256').update(value).digest('hex');
async function pin(file) {
  const digest=createHash('sha256'); for await(const chunk of fs.createReadStream(file)) digest.update(chunk);
  return {path:file,bytes:fs.statSync(file).size,sha256:digest.digest('hex')};
}
async function main() {
  assert.equal(process.argv.length,2,'Preparation has one fixed owned target; no path overrides.');
  assert(!fs.existsSync(config.profileDir),'Owned profile already exists; inspect the saved preparation before retry.');
  const receiptFile=path.join(config.receiptDir,'prepared.json');
  assert(!fs.existsSync(receiptFile),'Preparation receipt already exists.');
  assert.notEqual(path.resolve(config.primaryProfile).toLowerCase(),path.resolve(config.profileDir).toLowerCase());
  assert(fs.statSync(config.rawElectron).isFile());
  const model=await pin(config.modelFile),runtime=await pin(config.llamaExecutable);
  assert.equal(model.sha256,config.modelSha256,'Original model identity changed.');
  assert.equal(runtime.sha256,config.llamaSha256,'Stock runtime identity changed.');
  const primaryFiles=['providers.json','runtime-settings.json','llama-cpp-settings.json'].map(name=>path.join(config.primaryProfile,'data',name));
  const primaryBefore=[];for(const file of primaryFiles)if(fs.existsSync(file))primaryBefore.push(await pin(file));
  const selectedSource=JSON.parse(fs.readFileSync(path.join(config.primaryProfile,'data','llama-cpp-settings.json'),'utf8'));
  assert.equal(selectedSource.version,1);
  const existing=selectedSource.settings;
  assert.equal(path.resolve(existing.modelPaths[config.modelId]).toLowerCase(),path.resolve(config.modelFile).toLowerCase());
  const settings={...existing,executablePath:config.llamaExecutable,modelsDirectory:'',
    modelPaths:{[config.modelId]:config.modelFile},
    modelOverrides:{[config.modelId]:structuredClone(existing.modelOverrides[config.modelId]||{})}};
  const projector=settings.modelOverrides[config.modelId].mmprojPath;
  const projectorPin=projector?await pin(projector):null;
  const sourceFiles=['lib/provider-output-policy.mjs','lib/provider-store.mjs','lib/runtime-settings.mjs','lib/llama-cpp-settings.mjs','lib/llama-cpp-launch-config.mjs'];
  const sourceBefore=[];for(const relative of sourceFiles)sourceBefore.push(await pin(path.join(config.candidateRoot,relative)));
  const [{ProviderStore},{LlamaCppSettingsStore},{RuntimeSettingsStore}]=await Promise.all([
    import(pathToFileURL(path.join(config.candidateRoot,'lib/provider-store.mjs')).href),
    import(pathToFileURL(path.join(config.candidateRoot,'lib/llama-cpp-settings.mjs')).href),
    import(pathToFileURL(path.join(config.candidateRoot,'lib/runtime-settings.mjs')).href)
  ]);
  fs.mkdirSync(path.dirname(config.profileDir),{recursive:true});
  fs.mkdirSync(config.profileDir);
  fs.mkdirSync(config.receiptDir,{recursive:true});
  const dataDir=path.join(config.profileDir,'data');
  const llama=await new LlamaCppSettingsStore({dataDir}).init();
  await llama.update({expectedRevision:0,settings});
  const providers=new ProviderStore({dataDir});await providers.init();
  await providers.setDefaultModel(config.nativeModel);
  await providers.save({id:'local_llamacpp',name:'Local llama.cpp',preset:'llamacpp',type:'compatible',
    baseUrl:'http://127.0.0.1:8080/v1',enabled:true,models:[config.modelId],maxSteps:null,
    outputTokenPolicy:'provider-default',apiKey:''});
  const reloaded=new ProviderStore({dataDir});await reloaded.init();
  assert.equal(reloaded.defaultModel,config.nativeModel);
  const local=reloaded.configs.get('local_llamacpp');
  assert.equal(local.outputTokenPolicy,'provider-default');assert.equal(local.maxSteps,null);
  assert.deepEqual(local.models.map(model=>model.id),[config.modelId]);
  const runtimeSettings=await new RuntimeSettingsStore({dataDir}).init();
  const defaults=runtimeSettings.get();
  assert.equal(defaults.defaultEffort,'default');
  assert.equal(defaults.defaultContext.preset,'model');
  assert(defaults.defaultContext.windowTokens==null);
  assert.equal(defaults.defaultContext.autoCompact,true);
  assert.equal(defaults.runTimeoutMs,null);
  const primaryAfter=[];for(const record of primaryBefore)primaryAfter.push(await pin(record.path));
  assert.deepEqual(primaryAfter,primaryBefore,'Primary settings changed during preparation; inspect ownership before qualification.');
  const sourceAfter=[];for(const relative of sourceFiles)sourceAfter.push(await pin(path.join(config.candidateRoot,relative)));
  assert.deepEqual(sourceAfter,sourceBefore,'Preparation source changed during execution.');
  const savedFiles=[];for(const name of ['providers.json','llama-cpp-settings.json'])savedFiles.push(await pin(path.join(dataDir,name)));
  const record={schema:config.schema,preparedAt:new Date().toISOString(),status:'prepared',appStarted:false,modelInference:false,
    profileDir:config.profileDir,candidateRoot:config.candidateRoot,rawElectron:config.rawElectron,
    profileReusedAcrossTasks:true,contextIsolationEvidence:false,
    selectedModels:{local:'local_llamacpp::'+config.modelId,native:config.nativeModel},
    nativeDefaults:{context:defaults.defaultContext,effort:defaults.defaultEffort,serviceTier:defaults.defaultServiceTier,
      runTimeoutMs:defaults.runTimeoutMs,providerIdleTimeoutMs:defaults.providerIdleTimeoutMs},
    localOutputTokenPolicy:local.outputTokenPolicy,localMaxSteps:local.maxSteps,
    llamaSettings:llama.snapshot(),model,runtime,projector:projectorPin,
    sourceBefore,sourceAfter,primaryBefore,primaryAfter,savedFiles};
  const bytes=Buffer.from(JSON.stringify(record,null,2)+'\n');fs.writeFileSync(receiptFile,bytes,{flag:'wx'});
  assert(fs.readFileSync(receiptFile).equals(bytes));
  console.log(JSON.stringify({status:'prepared',profileDir:config.profileDir,receipt:{path:receiptFile,bytes:bytes.length,sha256:hash(bytes)},
    nativeDefaults:record.nativeDefaults,localOutputTokenPolicy:record.localOutputTokenPolicy,
    primarySettingsUnchanged:true,appStarted:false,modelInference:false}));
}
main().catch(error=>{console.error(JSON.stringify({status:'preparation-failed',name:error.name,code:error.code||null,message:error.message}));process.exitCode=1;});
