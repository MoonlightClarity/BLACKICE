import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';

test('repository mode exposes workspace tools in each fresh directory context and records file edits',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-sd-repo-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const repo=path.join(cwd,'repo');
  await mkdir(path.join(repo,'src'),{recursive:true});
  await writeFile(path.join(repo,'src','logic.mjs'),'export function score(){return 0;}\n');
  const calls=[];
  const runtime={
    async runAgent(opts){
      calls.push(opts);
      assert.equal(opts.cwd,repo);
      const current=JSON.parse(opts.prompt.split('CURRENT_DIRECTORY:\n')[1].split(/\nREPOSITORY (?:MODE|SYNTHESIS):/)[0]);
      const label=current.label;
      if(label==='integration'){
        assert.equal(opts.dynamicTools,undefined);
        assert.equal(opts.onToolCall,undefined);
        assert.equal(opts.sandbox,'read-only');
      }else{
        assert.equal(opts.dynamicTools[0].name,'relay_workspace');
        assert.equal(typeof opts.onToolCall,'function');
        assert.equal(opts.sandbox,['work','repair','repository-review'].includes(label)?'danger-full-access':'read-only');
      }
      if(label==='decompose')return {output:JSON.stringify({atomic:true,reason:'One bounded patch'})};
      if(label==='work'){
        const read=await opts.onToolCall({name:'relay_workspace',arguments:{action:'read',path:'src/logic.mjs'}});
        assert.equal(read.success,true);
        const patch=await opts.onToolCall({name:'relay_workspace',arguments:{action:'patch',path:'src/logic.mjs',oldText:'return 0;',newText:'return 42;'}});
        assert.equal(patch.success,true,JSON.stringify(patch));
        return {output:JSON.stringify({status:'complete',nextAction:'',finding:'logic.mjs now returns 42',candidate_answer:'Reviewed local patch',uncertainty:''})};
      }
      if(label==='repository-review'){
        const res=await opts.onToolCall({name:'relay_workspace',arguments:{action:'read',path:'src/logic.mjs'}});
        assert.equal(res.success,true);
        return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Review inspected modified logic.mjs',candidate_answer:'Source edit verified by read',uncertainty:''})};
      }
      if(label==='integration'){
        assert.equal(opts.onToolCall,undefined,'repository synthesis is read-only and tool-free');
        return {output:JSON.stringify({answer:'Stored host verification covers the current repository change',used_refs:['module:1','verification:final','review:repository']})};
      }
      throw Error('Unexpected '+label);
    }
  };
  const reasoner=new ShadowdancerDirectory({cwd,conversationId:'repo-context',runId:'repo-run',model:'gpt-6-luna',runtime});
  const output=await reasoner.run('/directory Repair the logic module and run verification.\nREPOSITORY_ROOT: '+repo);
  assert.match(await readFile(path.join(repo,'src','logic.mjs'),'utf8'),/return 42/);
  assert.equal(calls.length,3);
  assert.equal(output.stats.calls,3);
  assert.equal(output.stats.resets,3);
  assert.equal(output.stats.modelSynthesisCallsSkipped,1);
  assert.equal(output.stats.verificationStatus,'unavailable');
  assert.deepEqual(output.repositoryAudit.changedFiles,['src/logic.mjs']);
  assert.equal(output.repositoryAudit.verifiedBy,'host-file-hashes');
  assert.match(output.answer,/Repository audit \(host-observed\): Changed files within the recorded source inventory:/);
  assert.equal(output.stats.integrationGroups,1);
  const root=path.join(cwd,'.shadowdancer','repo-context','runs','repo-run');
  const toolFile=path.join(root,'modules','1','tools','0002.json');
  const json=JSON.parse(await readFile(toolFile,'utf8'));
  assert.equal(json.tool,'relay_workspace');
  const requirements=JSON.parse(await readFile(path.join(cwd,'.shadowdancer','repo-context','conversation','context','requirements.json'),'utf8'));
  assert.equal(requirements.repositoryRoot,repo);
  const final=JSON.parse(await readFile(output.finalPath,'utf8'));
  assert.deepEqual(final.referencedResults.map(x=>x.ref),['module:1','verification:final','review:repository']);
  const audited=JSON.parse(await readFile(path.join(root,'integration','repository-audit.json'),'utf8'));
  assert.deepEqual(audited.changedFiles,['src/logic.mjs']);
});

test('repository host index rejects mismatched source-linked evidence',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-host-index-ref-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const repo=path.join(cwd,'repo');
 await mkdir(path.join(repo,'src'),{recursive:true});
 await writeFile(path.join(repo,'src','score.mjs'),'export function score(){return 42;}\n');
 const engine=new ShadowdancerDirectory({cwd,conversationId:'invalid-ref-chat',runId:'invalid-ref-run',
  model:'remote::test',runtime:{async runAgent(){throw Error('Unexpected provider call')}}});
 engine.repoRoot=repo;
 await engine.open();
 const fake=path.join(engine.turnRoot,'modules','1','result.json');
 await mkdir(path.dirname(fake),{recursive:true});
 await writeFile(fake,JSON.stringify({ref:'module:other',finding:'wrong reference'})+'\n');
 engine.allRefs=[{ref:'module:1',kind:'module',path:fake}];
 await assert.rejects(()=>engine.integrate(),{code:'DIRECTORY_INTEGRATION_REFERENCE'});
});

test('a repository single-function task edits real files and publishes an audited report, not source text',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-repo-single-function-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const repo=path.join(cwd,'repo');
 await mkdir(path.join(repo,'src'),{recursive:true});
 await mkdir(path.join(repo,'tests'),{recursive:true});
 await writeFile(path.join(repo,'package.json'),JSON.stringify({type:'module'}));
 await writeFile(path.join(repo,'src','score.mjs'),'export function score(){return 0;}\n');
 await writeFile(path.join(repo,'tests','score.test.mjs'),
   "import test from 'node:test';import assert from 'node:assert/strict';import {score} from '../src/score.mjs';test('score returns 42',()=>assert.equal(score(),42));");
 await writeFile(path.join(repo,'tests','requirement-coverage.json'),
   JSON.stringify({version:1,mappings:[{requirementId:'R001',testFile:'tests/score.test.mjs',case:'score returns 42'}]}));
 const phases=[];
 const runtime={async runAgent(opts){
  const view=JSON.parse(opts.prompt.split('CURRENT_DIRECTORY:\n')[1].split(/\nREPOSITORY (?:MODE|SYNTHESIS):/)[0]);
  phases.push(view.label);
  if(view.label==='work'){
   const patch=await opts.onToolCall({name:'relay_workspace',arguments:{
     action:'patch',path:'src/score.mjs',oldText:'return 0;',newText:'return 42;'
   }});
   assert.equal(patch.success,true);
   return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Changed score from 0 to 42'})};
  }
  if(view.label==='integration'){
   assert.deepEqual(view.payload.required_refs,['module:1','verification:final']);
   return {output:JSON.stringify({answer:'Updated src/score.mjs; verified host test',
     used_refs:['module:1','verification:final']})};
  }
  throw Error('Unexpected model phase '+view.label);
 }};
 const controller=new ShadowdancerDirectory({cwd,conversationId:'named-repo',runId:'named-run',model:'gpt-6-luna',runtime});
 const response=await controller.run('/directory Implement exactly one JavaScript function named score that returns 42.\nREPOSITORY_ROOT: '+repo);
 assert.deepEqual(phases,['work']);
 assert.equal(response.stats.modelSynthesisCallsSkipped,1);
 assert.equal(response.stats.testsPassed,1);
 assert.equal(response.stats.explicitlyTestCovered,1);
 assert.match(response.answer,/Changed files within the recorded source inventory: src\/score.mjs/);
 assert.match(await readFile(path.join(repo,'src','score.mjs'),'utf8'),/return 42/);
 const final=JSON.parse(await readFile(response.finalPath,'utf8'));
 assert.equal(final.status,'test_evidence_covered');
 assert.equal(final.testsPassed,1);
 assert.equal(final.unknownRequirements,0);
});
test('host integration avoids the entire grouped model synthesis tree',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-host-index-grouping-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const repo=path.join(cwd,'repo');
 await mkdir(path.join(repo,'src'),{recursive:true});
 await writeFile(path.join(repo,'src','logic.mjs'),'export const enabled=true;\n');
 let providerCalls=0;
 const engine=new ShadowdancerDirectory({cwd,conversationId:'many-refs',runId:'many-refs-run',
  model:'remote::test',runtime:{async runAgent(){providerCalls++;throw Error('Unexpected model synthesis')}}});
 engine.repoRoot=repo;
 await engine.open();
 for(let i=1;i<=5;i++){
  const file=path.join(engine.turnRoot,'modules',String(i),'result.json');
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify({ref:'module:'+i,kind:'module',finding:'Saved result '+i})+'\n');
  engine.allRefs.push({ref:'module:'+i,kind:'module',path:file});
 }
 const result=await engine.integrate();
 assert.equal(providerCalls,0);
 assert.equal(engine.stats.modelSynthesisCallsSkipped,3,
  'Five refs at group size three would require two first-round turns and one final turn');
 assert.equal(engine.stats.hostIntegration,true);
 const saved=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.equal(saved.integrationAuthority,'host_source_reference_index');
 assert.deepEqual(saved.referencedResults.map(x=>x.ref),['module:1','module:2','module:3','module:4','module:5']);
 const index=JSON.parse(await readFile(path.join(engine.integrations,'host-index.json'),'utf8'));
 assert.equal(index.references.length,5);
 assert.ok(index.references.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)));
});

test('ordinary directory inference has no repository tools and stays read-only',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-sd-no-repo-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const runtime={async runAgent(opts){assert.equal(opts.dynamicTools,undefined);assert.equal(opts.onToolCall,undefined);assert.equal(opts.sandbox,'read-only');throw Error('intentional stop')}};
  const controller=new ShadowdancerDirectory({cwd,conversationId:'normal',runId:'normal',model:'gpt-6-luna',runtime});
  await assert.rejects(controller.run('/directory Explain a simple constant.'),/intentional stop/);
});
