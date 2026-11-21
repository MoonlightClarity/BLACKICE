'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SOURCE_FILES}=require('./policy-contract.cjs');
const {SOURCE_LAYOUTS,FIXED_PINS,DEPENDENCIES,SOURCE_CANDIDATES,inspectPolicySourceVersions:inspect}=require('./policy-source-versions.cjs');
const final=SOURCE_LAYOUTS[2],integrated=SOURCE_LAYOUTS[4],candidates=[final,integrated];
function filesFor(layout=final){
 const files=Object.fromEntries(SOURCE_FILES.map(file=>[file,'1'.repeat(64)]));
 Object.assign(files,FIXED_PINS,layout.parents);
 for(const rule of DEPENDENCIES)if(rule.parentSha256s.includes(files[rule.parent]))files[rule.file]=rule.sha256;
 return files;
}
const codes=result=>[...result.missing,...result.conflicts].map(x=>x.code);
test('all five explicitly reviewed parent combinations qualify only their own dependencies',()=>{
 for(const layout of SOURCE_LAYOUTS){
  const result=inspect(filesFor(layout));
  assert.equal(result.complete,true,JSON.stringify(result));
  assert.equal(result.layout,layout.id);
  assert.equal(result.candidateSourceAvailable,candidates.includes(layout));
  assert.deepEqual(result.dependencies.map(x=>x.required),DEPENDENCIES.map(x=>candidates.includes(layout)));
 }
});
test('legacy composition descriptors retain their exact eight source fields',()=>{
 const expectedKeys=[...Object.keys(FIXED_PINS),...Object.keys(final.parents)].sort();
 for(const layout of SOURCE_LAYOUTS.filter(layout=>!candidates.includes(layout))){
  const files=filesFor(layout),result=inspect(files);
  assert.deepEqual(Object.keys(result.sourceFiles).sort(),expectedKeys);
  assert.deepEqual(result.requiredFiles,[...SOURCE_FILES]);
  assert.ok(result.dependencies.every(x=>x.status==='unobserved'&&x.observedSha256===null));
  for(const rule of DEPENDENCIES)files[rule.file]=rule.sha256;
  const withUnused=inspect(files);
  assert.equal(withUnused.complete,true);
  assert.deepEqual(withUnused.sourceFiles,result.sourceFiles);
  assert.ok(withUnused.dependencies.every(x=>x.status==='present-unused'));
 }
});
test('both reviewed candidates record and require the exact three imported helpers',()=>{
 for(const layout of candidates){
  const result=inspect(filesFor(layout));
  assert.equal(result.dependencies.length,3);
  for(const rule of DEPENDENCIES){
   assert.ok(SOURCE_CANDIDATES.includes(rule.file));
   assert.ok(result.requiredFiles.includes(rule.file));
   assert.equal(result.sourceFiles[rule.file],rule.sha256);
   assert.deepEqual(result.dependencies.find(x=>x.file===rule.file),{
    file:rule.file,parent:rule.parent,required:true,status:'present-required',
    observedSha256:rule.sha256,expectedSha256:rule.sha256
   });
  }
 }
});
test('missing and wrong helper identities fail for both complete reviewed parent tuples',()=>{
 for(const layout of candidates)for(const rule of DEPENDENCIES){
  const missing=filesFor(layout);delete missing[rule.file];
  const a=inspect(missing);assert.equal(a.complete,false);assert.equal(a.candidateSourceAvailable,false);
  assert.ok(codes(a).includes('required-prompt-source-dependency'));
  const wrong=filesFor(layout);wrong[rule.file]='f'.repeat(64);
  const b=inspect(wrong);assert.equal(b.complete,false);assert.equal(b.candidateSourceAvailable,false);
  assert.ok(codes(b).includes('unsupported-prompt-source-dependency'));
 }
});
test('coherent but unreviewed combinations of individually accepted parents are rejected',()=>{
 const parentNames=Object.keys(final.parents);
 const choices=parentNames.map(name=>[...new Set(SOURCE_LAYOUTS.map(x=>x.parents[name]))]);
 let accepted=0,rejected=0;
 for(const engine of choices[0])for(const workspace of choices[1])for(const directory of choices[2]){
  const files=filesFor();Object.assign(files,{[parentNames[0]]:engine,[parentNames[1]]:workspace,[parentNames[2]]:directory});
  const expected=SOURCE_LAYOUTS.some(layout=>parentNames.every(name=>layout.parents[name]===files[name]));
  const result=inspect(files);assert.equal(result.complete,expected,JSON.stringify(result));
  if(expected)accepted++;else{rejected++;assert.equal(result.layout,null);assert.ok(codes(result).includes('unsupported-prompt-source-combination'));}
 }
 assert.equal(accepted,5);assert.equal(rejected,15);
});
test('unknown parents and changed fixed composer dependencies fail explicitly',()=>{
 for(const name of [...Object.keys(final.parents),...Object.keys(FIXED_PINS)]){
  const files=filesFor();files[name]='f'.repeat(64);const result=inspect(files);
  assert.equal(result.complete,false);assert.ok(codes(result).includes('unsupported-prompt-composer-source'));
 }
});
test('legacy helper absence is reported only when independently observed',()=>{
 const files=filesFor(SOURCE_LAYOUTS[0]),absent=Object.fromEntries(DEPENDENCIES.map(x=>[x.file,false]));
 const result=inspect(files,absent);assert.equal(result.complete,true);assert.equal(result.candidateSourceAvailable,false);
 assert.ok(result.dependencies.every(x=>x.status==='observed-absent-unused'&&!x.required));
 assert.ok(inspect(files).dependencies.every(x=>x.status==='unobserved'));
 const finalMissing=filesFor();for(const rule of DEPENDENCIES)delete finalMissing[rule.file];
 const required=inspect(finalMissing,absent);assert.equal(required.complete,false);
 assert.ok(required.dependencies.every(x=>x.status==='observed-absent-required'&&x.required));
});
test('presence observations cannot contradict saved helper identities',()=>{
 for(const layout of SOURCE_LAYOUTS){
  const files=filesFor(layout),rule=DEPENDENCIES[0];files[rule.file]=rule.sha256;
  const presentButAbsent=inspect(files,{[rule.file]:false});
  assert.equal(presentButAbsent.complete,false);assert.ok(codes(presentButAbsent).includes('source-presence-conflict'));
  delete files[rule.file];const absentButPresent=inspect(files,{[rule.file]:true});
  assert.equal(absentButPresent.complete,false);assert.ok(codes(absentButPresent).includes('source-presence-conflict'));
  assert.equal(absentButPresent.dependencies[0].status,'observed-present-without-valid-hash');
 }
});
test('all baseline source identities remain mandatory for every supported layout',()=>{
 for(const layout of SOURCE_LAYOUTS)for(const file of SOURCE_FILES){
  const files=filesFor(layout);delete files[file];const result=inspect(files);
  assert.equal(result.complete,false);assert.ok(codes(result).includes('required-installed-source-identities-missing'));
 }
});

test('inherited hashes cannot substitute for serialized owned source identities',()=>{
 const valid=filesFor(),inherited=Object.create(valid);
 assert.deepEqual(Object.keys(inherited),[]);assert.equal(JSON.stringify(inherited),'{}');
 const result=inspect(inherited);assert.equal(result.complete,false);assert.equal(result.candidateSourceAvailable,false);
 assert.ok(codes(result).includes('required-installed-source-identities-missing'));
 const helpers=Object.fromEntries(DEPENDENCIES.map(rule=>[rule.file,valid[rule.file]]));
 const ownParents=Object.assign(Object.create(helpers),valid);
 for(const rule of DEPENDENCIES)delete ownParents[rule.file];
 assert.equal(inspect(ownParents).complete,false);
 const nullPrototype=Object.assign(Object.create(null),valid);
 assert.equal(inspect(nullPrototype).complete,true);
 const inheritedPresence=Object.create(Object.fromEntries(DEPENDENCIES.map(rule=>[rule.file,false])));
 assert.equal(inspect(valid,inheritedPresence).complete,true);
 assert.ok(inspect(filesFor(SOURCE_LAYOUTS[0]),inheritedPresence).dependencies.every(rule=>rule.status==='unobserved'));
});
test('unknown parent versions never label absent dependencies as known unused',()=>{
 const files=filesFor(SOURCE_LAYOUTS[0]),rule=DEPENDENCIES[0];
 files[rule.parent]='f'.repeat(64);
 const result=inspect(files,{[rule.file]:false}),dependency=result.dependencies.find(x=>x.file===rule.file);
 assert.equal(result.complete,false);assert.equal(dependency.required,null);
 assert.equal(dependency.status,'observed-absent-unreviewed-parent');assert.equal(dependency.expectedSha256,null);
});

test('reviewed installed browser-cwd variant requires its unchanged legacy tool parents',()=>{
 const layout=SOURCE_LAYOUTS.find(x=>x.id==='reviewed-installed-browser-cwd-2.40.72');
 assert.ok(layout);const files=filesFor(layout),presence=Object.fromEntries(DEPENDENCIES.map(x=>[x.file,false]));
 const result=inspect(files,presence);assert.equal(result.complete,true);assert.equal(result.layout,layout.id);
 assert.equal(result.candidateSourceAvailable,false);assert.equal(Object.keys(result.sourceFiles).length,8);
 assert.ok(result.dependencies.every(x=>x.required===false&&x.status==='observed-absent-unused'));
 for(const parent of ['lib/benchmark-workspace.mjs','lib/task-action-directory.mjs']){
  const mixed={...files,[parent]:final.parents[parent]};
  for(const rule of DEPENDENCIES)if(rule.parent===parent)mixed[rule.file]=rule.sha256;
  const rejected=inspect(mixed);assert.equal(rejected.complete,false);
  assert.ok(codes(rejected).includes('unsupported-prompt-source-combination'));
 }
});
