'use strict';
const b=require('./native-build-common.cjs'),source=require('./final-source.cjs'),pin=require('./build-inputs.json');
const {fs,p,read,hash,identity,save,once,run}=b;
const [action,root,arg,cache]=process.argv.slice(2);
if(!p.isAbsolute(root||''))throw Error('Absolute new owned build root required');
const inputFile=p.join(root,'fresh-inputs.json');
function archiveReader(){
 const windows=process.env.SystemRoot||process.env.windir;
 if(!p.isAbsolute(windows||''))throw Error('WINDOWS_SYSTEM_ROOT_REQUIRED');
 const file=p.join(windows,'System32','tar.exe');
 if(!fs.existsSync(file))throw Error('WINDOWS_ARCHIVE_READER_REQUIRED');
 return file;
}
function inputs(){
 const value=read(inputFile);
 if(value.sourceCommit!==pin.source.commit||value.buildInputs.sha256!==identity(p.join(__dirname,'build-inputs.json')).sha256)throw Error('PINNED_INPUTS_CHANGED');
 return value;
}
function initialize(){
 if(!p.isAbsolute(arg||'')||cache&&!p.isAbsolute(cache))throw Error('Explicit original Vulkan DLL directory and optional absolute archive cache required');
 const manifest=p.join(p.dirname(arg),'manifest.json'),dll=read(manifest);
 if(dll.pin.sourceCommit!=='b1b770d90'||dll.pin.release!=='b12359')throw Error('ORIGINAL_DLL_RELEASE_PIN');
 if(fs.existsSync(inputFile)){
  const value=inputs();if(value.originalDllDirectory!==arg||value.archiveCache!==(cache??null)||value.originalDllManifest.sha256!==identity(manifest).sha256)throw Error('BUILD_ROOT_ALREADY_BOUND');
  console.log(JSON.stringify({initialized:true,existing:true,inputs:identity(inputFile)}));return;
 }
 if(fs.existsSync(root)&&fs.readdirSync(root).length)throw Error('NEW_EMPTY_BUILD_ROOT_REQUIRED');
 fs.mkdirSync(root,{recursive:true});
 save(inputFile,{schema:'blackice.minicpm.fresh-build-inputs.v1',at:new Date().toISOString(),sourceCommit:pin.source.commit,
  buildInputs:identity(p.join(__dirname,'build-inputs.json')),originalDllDirectory:arg,originalDllManifest:identity(manifest),archiveCache:cache??null,
  historicalReceiptsRequired:false,modelStarted:false});
 console.log(JSON.stringify({initialized:true,inputs:identity(inputFile)}));
}
function asset(){
 const input=inputs(),item=arg==='source'?{...pin.source,name:'source'}:pin.assets.find(x=>x.name===arg);
 if(!item?.sha256||!item.bytes)throw Error('PINNED_ASSET_NAME_REQUIRED');
 const file=p.join(root,'downloads',item.filename);fs.mkdirSync(p.dirname(file),{recursive:true});
 if(!fs.existsSync(file)&&input.archiveCache){
  const cached=p.join(input.archiveCache,item.filename),found=identity(cached);
  if(found.sha256!==item.sha256||found.bytes!==item.bytes)throw Error('ARCHIVE_CACHE_PIN:'+item.name);
  fs.copyFileSync(cached,file,fs.constants.COPYFILE_EXCL);const fd=fs.openSync(file,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }
 if(!fs.existsSync(file))run(root,'fetch-'+arg,process.execPath,[p.join(__dirname,'prepare-build.cjs'),'fetch',root,arg]);
 const archive=identity(file);if(archive.sha256!==item.sha256||archive.bytes!==item.bytes)throw Error('ARCHIVE_PIN:'+arg);
 const record=p.join(root,'receipts','fresh-asset-'+arg+'.json');
 if(fs.existsSync(record)){
  const saved=read(record);if(saved.archive.sha256!==archive.sha256)throw Error('EXTRACT_RECEIPT_DRIFT');
  if(arg==='source')verifyUpstream();
  console.log(JSON.stringify({asset:arg,existing:true,receipt:identity(record)}));return;
 }
 let target;
 if(arg==='source'){
  const directory=p.join(root,'upstream');target=p.join(directory,'llama.cpp-'+pin.source.commit);
  if(fs.existsSync(target))throw Error('UNRECONCILED_SOURCE_EXTRACTION');
  fs.mkdirSync(directory,{recursive:true});run(root,'extract-source',archiveReader(),['-xf',file,'-C',directory]);
  const inventory=source.inventory(target);if(inventory.length<100)throw Error('SOURCE_ARCHIVE_INCOMPLETE');
  save(p.join(root,'upstream-inventory.json'),{schema:'blackice.minicpm.upstream-inventory.v1',archive,target,files:inventory});
 }else{
  // Windows bsdtar reads the pinned 7z self-extractor as an archive. Do not
  // execute its GUI/SFX program: its interactive lifetime is not extraction proof.
  const tools=p.join(root,'tools'),directory=arg==='ninja'?p.join(tools,'ninja'):tools;
  target=arg==='w64devkit'?p.join(tools,'w64devkit'):arg==='cmake'?p.join(tools,'cmake-4.5.1-windows-x86_64'):p.join(directory,'ninja.exe');
  if(fs.existsSync(target))throw Error('UNRECONCILED_TOOL_EXTRACTION:'+target);
  fs.mkdirSync(directory,{recursive:true});
  const reader=archiveReader(),listing=run(root,'list-'+arg,reader,['-tf',file]);
  const entries=listing.stdout.split(/\r?\n/).filter(Boolean);
  if(!entries.length||entries.some(x=>/^[/\\]|^[A-Za-z]:/.test(x)||x.split(/[/\\]/).includes('..')))throw Error('UNSAFE_ARCHIVE_PATH');
  const extracted=run(root,'extract-'+arg,reader,['-xf',file,'-C',directory]);
  if(!fs.existsSync(target))throw Error('EXTRACTION_TARGET_MISSING');
  save(p.join(root,'receipts','extract-'+arg+'.json'),{schema:'blackice.minicpm.fresh-tool-extract.v1',archive,target,
   reader:identity(reader),entries:entries.length,entryListingSha256:hash(listing.stdout),listingCommand:listing.receiptPath,extractionCommand:extracted.receiptPath});
 }
 save(record,{schema:'blackice.minicpm.fresh-asset.v1',at:new Date().toISOString(),archive,target,pin:item.sha256,modelStarted:false});
 console.log(JSON.stringify({asset:arg,receipt:identity(record)}));
}
function verifyUpstream(){
 const input=read(p.join(root,'upstream-inventory.json'));
 if(input.archive.sha256!==pin.source.sha256||identity(input.archive.path).sha256!==pin.source.sha256)throw Error('UPSTREAM_ARCHIVE_DRIFT');
 if(JSON.stringify(source.inventory(input.target))!==JSON.stringify(input.files))throw Error('PRISTINE_SOURCE_DRIFT');
 return input;
}
function prepare(){
 const input=inputs(),upstream=verifyUpstream();
 for(const item of pin.assets){const record=read(p.join(root,'receipts','fresh-asset-'+item.name+'.json'));if(record.archive.sha256!==item.sha256)throw Error('TOOL_ARCHIVE_PIN');}
 if(fs.existsSync(p.join(root,'receipts/import-boundary.json')))throw Error('BUILD_ALREADY_PREPARED_USE_SOURCE_OR_BUILD_ACTIONS');
 const target=p.join(root,'source','llama.cpp-'+pin.source.commit);
 if(fs.existsSync(target)){
  if(JSON.stringify(source.inventory(target))!==JSON.stringify(upstream.files))throw Error('UNRECONCILED_PREPARED_SOURCE');
 }else fs.cpSync(upstream.target,target,{recursive:true,errorOnExist:true,force:false,dereference:false});
 const toolReceipt=p.join(root,'receipts/source-toolchain.json');
 if(fs.existsSync(toolReceipt))once(p.join(root,'source-history','source-toolchain-'+identity(toolReceipt).sha256+'.json'),fs.readFileSync(toolReceipt));
 run(root,'verify-source-and-tools',process.execPath,[p.join(__dirname,'prepare-build.cjs'),'verify-source',root]);
 run(root,'import-original-dlls',process.execPath,[p.join(__dirname,'build.cjs'),'imports',root,input.originalDllDirectory]);
 const current=b.state(root);b.mathFiles(current.original,current.bin);
 console.log(JSON.stringify({prepared:true,toolchain:identity(p.join(root,'receipts/source-toolchain.json')),imports:identity(p.join(root,'receipts/import-boundary.json'))}));
}
function sources(){
 const current=b.state(root),upstream=verifyUpstream(),file=p.join(root,'source-state.json');
 const previous=fs.existsSync(file)?read(file):null;
 const plan=source.derive(upstream.target);
 if(previous){
  once(p.join(root,'source-history',identity(file).sha256+'.json'),fs.readFileSync(file));
  const oldEquivalence=p.join(root,'source-equivalence.json');
  if(fs.existsSync(oldEquivalence))once(p.join(root,'source-history','equivalence-'+identity(oldEquivalence).sha256+'.json'),fs.readFileSync(oldEquivalence));
 }
 source.materialize(plan,upstream.target,current.source,previous?.content??null);
 const value={schema:'blackice.minicpm.fresh-source-state.v1',at:new Date().toISOString(),sourceCommit:pin.source.commit,
  contentSha256:plan.contentSha256,content:plan.content,sourceTools:b.sourceTools(),historicalReceiptsRequired:false,modelStarted:false};
 save(file,value);console.log(JSON.stringify({complete:true,sourceState:identity(file),contentSha256:plan.contentSha256,
  allFiles:plan.content.entries.length,replaced:plan.content.replacedFiles.length,copied:plan.content.copiedFiles.length,deleted:plan.content.deletedFiles}));
}
function equivalence(){
 const current=b.requireSource(root),archive=p.join(root,'downloads',pin.source.filename);
 if(identity(archive).sha256!==pin.source.sha256)throw Error('SOURCE_ARCHIVE_PIN');
 const directory=p.join(root,'source-proof-'+Date.now());fs.mkdirSync(directory);
 run(root,'independent-source-extract',archiveReader(),['-xf',archive,'-C',directory]);
 const target=p.join(directory,'llama.cpp-'+pin.source.commit),plan=source.derive(target);
 source.apply(plan,target);
 if(plan.contentSha256!==current.sourceState.contentSha256||JSON.stringify(plan.content)!==JSON.stringify(current.sourceState.content))throw Error('INDEPENDENT_SOURCE_EQUIVALENCE_FAILED');
 source.verify(plan.content,current.source);
 const result={schema:'blackice.minicpm.fresh-source-equivalence.v1',at:new Date().toISOString(),complete:true,
  sourceArchive:identity(archive),independentSource:target,contentSha256:plan.contentSha256,sourceState:identity(p.join(root,'source-state.json')),
  allFiles:plan.content.entries.length,replacedFiles:plan.content.replacedFiles,copiedFiles:plan.content.copiedFiles,deletedFiles:plan.content.deletedFiles,
  historicalReceiptsRequired:false,modelStarted:false};
 save(p.join(root,'source-equivalence.json'),result);console.log(JSON.stringify({complete:true,allFiles:result.allFiles,receipt:identity(p.join(root,'source-equivalence.json'))}));
}
function configure(){b.requireSource(root);const r=run(root,'configure',process.execPath,[p.join(__dirname,'build.cjs'),'configure',root]);console.log(JSON.stringify({configured:true,receipt:r.receiptPath,stdout:r.stdout.slice(-1800)}));}
function buildStep(){
 const current=b.requireSource(root);
 run(root,'regenerate',current.ready.tools.ninja.path,['-C',current.build,'-j','2','build.ninja']);
 const pending=run(root,'pending',current.ready.tools.ninja.path,['-C',current.build,'-n','llama-server']);
 const targets=[...pending.stdout.matchAll(/Building (?:CXX|C) object ([^\r\n]+\.obj)/g)].map(x=>x[1]);
 const focus=target=>/\/(?:blackice-trace|server-context|main)\.cpp\.obj$/.test(target);
 const ordered=[...targets.filter(focus),...targets.filter(x=>!focus(x))];
 const selected=ordered.length>3?ordered.slice(0,3):[];
 const before=selected.length?null:b.buildInputs(b.requireSource(root));
 // A fresh completion binding requires an observed real link. Preserve and
 // remove only the owned, unfrozen executable so an existing/no-op output
 // cannot establish new provenance after a recipe/source change.
 const previousExecutable=selected.length?null:b.preserveForRelink(current);
 const built=run(root,'build',current.ready.tools.ninja.path,['-C',current.build,'-j','2',...(selected.length?selected:['llama-server'])]);
 let completedBuild=null;
 if(!selected.length){
  const noPending=run(root,'post-link-pending',current.ready.tools.ninja.path,['-C',current.build,'-n','llama-server']);
  completedBuild=b.completeBuild(root,before,built,noPending);
 }
 console.log(JSON.stringify({selected,remainingObjects:selected.length?targets.length-selected.length:0,linked:selected.length===0,
  completedBuild,previousExecutable,receipt:built.receiptPath,stdout:built.stdout.slice(-2500),stderr:built.stderr.slice(-1500)}));
}
if(action==='init')initialize();
else if(action==='asset')asset();
else if(action==='prepare')prepare();
else if(action==='sources')sources();
else if(action==='equivalence')equivalence();
else if(action==='configure')configure();
else if(action==='build-step')buildStep();
else require('./fresh-build-gates.cjs').execute(action,root,arg);
