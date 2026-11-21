'use strict';
// Reviewed source combinations for policy delivery evidence. No filesystem access.
const {SOURCE_FILES,hash}=require('./policy-contract.cjs');
const freeze=value=>{for(const item of Object.values(value))if(item&&typeof item==='object')freeze(item);return Object.freeze(value);};
const PARENTS=Object.freeze(['lib/engine.mjs','lib/benchmark-workspace.mjs','lib/task-action-directory.mjs']);
const FIXED_PINS=freeze({
 'lib/identity.mjs':'00dcdf7884a7c89872d6be81950a1564a7f876209f62ee14bcd7fab25db64f2a',
 'lib/developer-instruction-budget.mjs':'adcbd6cdb99e43f9d61ca36f87bd63798aed10c3c0df6e8ed1fdef5460d1bfd2',
 'lib/directory-done-checklist.mjs':'d632dc480be7401ff06b5e329bc7dc9d00c85ffb699c7428282e3cc9120508e9',
 'lib/chat-intent-inference.mjs':'b0af856c3dbadf4ca6d43b38a2cbf947b691823295901b494b9ac258fbcee0ac',
 'public/mission-model.mjs':'fa7763eb85af6150867dad4b266085c5839b920eacadce26bbe228088e6b5051',
});
const SOURCE_LAYOUTS=freeze([
 {id:'installed-2.40.72',parents:{
  'lib/engine.mjs':'b21774d804c1763151967bbeaa4b58dbafd142f3bef58233b3183402a35fd99f',
  'lib/benchmark-workspace.mjs':'3bf76c83a06f9ef12733e2c1db75b36de9a4d83c96a79dd0f412ea64c6c7e41f',
  'lib/task-action-directory.mjs':'df7e4e94df0c217682ad2365c0297c94f20830fea5b15372d47874a4a5ac9ef4',
 }},
 {id:'reviewed-transport-candidate',parents:{
  'lib/engine.mjs':'ac5a339757cf7f9325021aa73d9f3c05a3e9f667399e66cd3ad346204fc0ff68',
  'lib/benchmark-workspace.mjs':'3bf76c83a06f9ef12733e2c1db75b36de9a4d83c96a79dd0f412ea64c6c7e41f',
  'lib/task-action-directory.mjs':'df7e4e94df0c217682ad2365c0297c94f20830fea5b15372d47874a4a5ac9ef4',
 }},
 {id:'reviewed-contract-deadline-candidate',parents:{
  'lib/engine.mjs':'4713ffebc612b0fbab42974b287ab72adfc3e5dd467fc4b7d88af91bbd10d2fc',
  'lib/benchmark-workspace.mjs':'d8b438677241fb91d9afd67f34dcf11aef382f608c1e459e9ac167852ddf0901',
  'lib/task-action-directory.mjs':'a3bb9be83dff4a02281289a6645cad850b5e30cf60c1a280f978ec58878c8e1a',
 }},
 {id:'reviewed-installed-browser-cwd-2.40.72',parents:{
  'lib/engine.mjs':'431cef0cfec6294ef41beadc5f41ce282ad2136689aab0264e5e267b3a7a0972',
  'lib/benchmark-workspace.mjs':'3bf76c83a06f9ef12733e2c1db75b36de9a4d83c96a79dd0f412ea64c6c7e41f',
  'lib/task-action-directory.mjs':'df7e4e94df0c217682ad2365c0297c94f20830fea5b15372d47874a4a5ac9ef4',
 }},
]);
const DEPENDENCIES=freeze([
 {parent:'lib/engine.mjs',parentSha256:SOURCE_LAYOUTS[2].parents['lib/engine.mjs'],
  file:'lib/benchmark-run-deadline.mjs',sha256:'49859c0efd7119ab8813dbb4aaa60243058d2357ea8640b8ff42863cb0472179'},
 {parent:'lib/benchmark-workspace.mjs',parentSha256:SOURCE_LAYOUTS[2].parents['lib/benchmark-workspace.mjs'],
  file:'lib/benchmark-workspace-contract.mjs',sha256:'038ae91d5548b174fe28376eefc5e80723a93864a71f238a1379c2dcea39f870'},
 {parent:'lib/task-action-directory.mjs',parentSha256:SOURCE_LAYOUTS[2].parents['lib/task-action-directory.mjs'],
  file:'lib/task-action-directory-tool-contract.mjs',sha256:'80cf808fec69bc938c87a877e5fdef99d019b2bc7a9bee73283ec1be18e2f918'},
]);
const SOURCE_CANDIDATES=Object.freeze([...new Set([...SOURCE_FILES,...Object.keys(FIXED_PINS),...PARENTS,...DEPENDENCIES.map(x=>x.file)])]);
const ownMap=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value)):{};
function inspectPolicySourceVersions(files,observedPresence={}){
 const f=ownMap(files),presenceFacts=ownMap(observedPresence),missing=[],conflicts=[],sourceFiles={};
 const add=(field,code,observed,expected,conflict=false)=>(conflict?conflicts:missing).push({field,code,observed:observed??null,...(expected===undefined?{}:{expected})});
 for(const file of SOURCE_FILES)if(!hash(f[file]))add(file,'required-installed-source-identities-missing',f[file]);
 for(const [file,expected]of Object.entries(FIXED_PINS)){
  sourceFiles[file]=f[file]??null;
  if(f[file]!==expected)add(file,'unsupported-prompt-composer-source',f[file],[expected],f[file]!==undefined);
 }
 for(const file of PARENTS){
  sourceFiles[file]=f[file]??null;
  const accepted=[...new Set(SOURCE_LAYOUTS.map(x=>x.parents[file]))];
  if(!accepted.includes(f[file]))add(file,'unsupported-prompt-composer-source',f[file],accepted,f[file]!==undefined);
 }
 const layout=SOURCE_LAYOUTS.find(x=>PARENTS.every(file=>x.parents[file]===f[file]));
 if(!layout)add('combination','unsupported-prompt-source-combination',Object.fromEntries(PARENTS.map(file=>[file,f[file]??null])),SOURCE_LAYOUTS.map(x=>({id:x.id,parents:x.parents})),PARENTS.every(file=>hash(f[file])));
 const requiredFiles=[...SOURCE_FILES],dependencies=[];
 for(const rule of DEPENDENCIES){
  const parentReviewed=SOURCE_LAYOUTS.some(layout=>layout.parents[rule.parent]===f[rule.parent]);
  const required=parentReviewed?f[rule.parent]===rule.parentSha256:null,observed=f[rule.file];
  const presence=presenceFacts[rule.file],usage=required===true?'required':required===false?'unused':'unreviewed-parent';
  let status=hash(observed)?'present-'+usage:'unobserved';
  if(presence===false)status='observed-absent-'+usage;
  else if(presence===true&&!hash(observed))status='observed-present-without-valid-hash';
  if((presence===false&&observed!==undefined)||(presence===true&&!hash(observed)))add(rule.file,'source-presence-conflict',presence,observed??null,true);
  if(required){
   requiredFiles.push(rule.file);sourceFiles[rule.file]=observed??null;
   if(observed===undefined)add(rule.file,'required-prompt-source-dependency',null,rule.sha256);
   else if(observed!==rule.sha256)add(rule.file,'unsupported-prompt-source-dependency',observed,rule.sha256,true);
  }
  dependencies.push({file:rule.file,parent:rule.parent,required,status,observedSha256:observed??null,expectedSha256:required?rule.sha256:null});
 }
 return {complete:!missing.length&&!conflicts.length,layout:layout?.id??null,candidateSourceAvailable:layout?.id==='reviewed-contract-deadline-candidate'&&!missing.length&&!conflicts.length,requiredFiles:[...new Set(requiredFiles)],sourceFiles,dependencies,missing,conflicts};
}
module.exports={SOURCE_LAYOUTS,FIXED_PINS,DEPENDENCIES,SOURCE_CANDIDATES,inspectPolicySourceVersions};
