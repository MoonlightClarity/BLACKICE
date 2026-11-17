import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {CodexRuntime,blackiceSessionConfig} from '../lib/codex.mjs';

const cwd=path.resolve(process.cwd(),'fixture-skills-workspace');
const nativePath=path.join(cwd,'.skills','test','SKILL.md');
const make=()=>new CodexRuntime({resolveCommand:()=>process.execPath,nativeModelMetadata:false,isolatedHistory:true});
test('native skill inspection does not start Codex or any model worker when disconnected',async()=>{
  const runtime=make();
  runtime.start=()=>{throw Error('No model/start is permitted during a catalog read');};
  runtime._request=()=>{throw Error('No transport read while disconnected');};
  const result=await runtime.inspectSkills(cwd);
  assert.equal(result.available,false);assert.deepEqual(result.skills,[]);
  assert.equal(runtime.child,null);
});
test('connected native skill inspection makes one read-only skills/list request scoped to exact folder',async()=>{
  const runtime=make();runtime.child={};runtime.info.connected=true;
  let requests=0;
  runtime.start=()=>{throw Error('No model/start is permitted during a catalog read');};
  runtime._request=async(method,params,timeout)=>{
    requests++;assert.equal(method,'skills/list');
    assert.deepEqual(params,{cwds:[cwd],forceReload:false});
    assert.ok(timeout<=10000);
    return {data:[{cwd,skills:[{path:nativePath,name:'Native test',description:'Native only'}],errors:[]}]};
  };
  const result=await runtime.inspectSkills(cwd);
  assert.equal(requests,1);assert.equal(result.available,true);
  assert.deepEqual(result.skills,[{path:nativePath,name:'Native test',description:'Native only'}]);
  assert.equal(runtime.threads.size,0);
});
test('explicit native Refresh revalidates on read-only transport without starting a turn',async()=>{
  const runtime=make();runtime.child={};runtime.info.connected=true;
  runtime.start=()=>{throw Error('No model/start permitted');};
  runtime._request=async(method,params)=>{
    assert.equal(method,'skills/list');assert.equal(params.forceReload,true);
    return {data:[{cwd,skills:[],errors:[]}]};
  };
  const result=await runtime.inspectSkills(cwd,{forceReload:true});
  assert.equal(result.available,true);assert.equal(runtime.threads.size,0);
});
test('native inspection treats invalid transport output as an error, not an empty catalog',async()=>{
  const runtime=make();runtime.child={};runtime.info.connected=true;
  runtime._request=async()=>({data:[{cwd,skills:'not-an-array',errors:[]}]});
  await assert.rejects(runtime.inspectSkills(cwd),{code:'CODEX_SKILLS_UNAVAILABLE'});
  await assert.rejects(runtime.inspectSkills('relative/path'),{code:'CODEX_SKILLS_INVALID_CWD'});
});
test('isolated BLACKICE session excludes discovered ambient Codex skills without persisting config changes',()=>{
  const original={config:{skills:{config:[{path:nativePath,enabled:true}]},plugins:{},mcp_servers:{}}};
  const discovery={data:[{cwd,skills:[{path:nativePath}],errors:[]}]};
  const before=structuredClone(original);
  const override=blackiceSessionConfig(original,discovery,cwd);
  assert.deepEqual(original,before,'effective user config was not rewritten');
  assert.deepEqual(override['skills.config'],[{path:nativePath,enabled:true},{path:nativePath,enabled:false}]);
  assert.equal(override['features.apps'],false);
});
