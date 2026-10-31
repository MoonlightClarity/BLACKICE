import test from 'node:test';
import assert from 'node:assert/strict';
import {planningResponseFeatureConfig,verifyPlanningResponseBoundary} from '../lib/response-profile.mjs';

// Captured capability names from the real 0.166.0-alpha.5.1 no-turn probe.
// That runtime normalizes unified_exec back to true in a thread whose shell
// capability is disabled. It is an implementation selector, not another tool.
const names=['shell_tool','unified_exec','shell_snapshot','browser_use','browser_use_external','browser_use_full_cdp_access',
  'computer_use','in_app_browser','in_app_chat','in_app_local_automation','image_generation','view_image',
  'multi_agent','multi_agent_v2','apps','remote_plugin','plugins','hooks','code_mode_host','code_mode','code_mode_only',
  'skill_search','skill_mcp_dependency_install','tool_suggest','workspace_dependencies','goals','sleep_tool','memories',
  'request_permissions_tool','default_mode_request_user_input','standalone_web_search'];
const catalog=()=>names.map(name=>({name,enabled:true,stage:'stable'}));
const thread={sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never'};
const scoped=()=>names.map(name=>({name,enabled:name==='unified_exec',stage:'stable'}));

test('native normalized exec backend does not reject an analytically isolated thread',()=>{
  const profile=planningResponseFeatureConfig(catalog());
  const result=verifyPlanningResponseBoundary(thread,scoped(),profile.disabled);
  assert.equal(result.profile,'planning-response');
  assert.ok(result.disabledFeatures.includes('shell_tool'));
  assert.equal(result.disabledFeatures.includes('unified_exec'),false,'do not claim a normalized implementation flag is disabled');
  assert.equal(profile.config['features.shell_tool'],false);
  assert.equal(profile.config['features.unified_exec'],undefined,'request the capability control rather than an ineffective backend override');
});

test('analytical shell control does not depend on an obsolete exec implementation flag',()=>{
  const available=catalog().filter(feature=>feature.name!=='unified_exec');
  const profile=planningResponseFeatureConfig(available);
  assert.doesNotThrow(()=>verifyPlanningResponseBoundary(thread,scoped().filter(feature=>feature.name!=='unified_exec'),profile.disabled));
});

test('an enabled shell capability still prevents an analytical turn',()=>{
  const profile=planningResponseFeatureConfig(catalog());
  const features=scoped().map(feature=>({...feature,enabled:feature.name==='shell_tool'}));
  assert.throws(()=>verifyPlanningResponseBoundary(thread,features,profile.disabled),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
});

test('a missing effective shell capability cannot be inferred from the exec backend flag',()=>{
  const profile=planningResponseFeatureConfig(catalog());
  assert.throws(()=>verifyPlanningResponseBoundary(thread,scoped().filter(feature=>feature.name!=='shell_tool'),profile.disabled),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
});

test('the exec normalization exception does not suppress unrelated capability failures',()=>{
  const profile=planningResponseFeatureConfig(catalog());
  for(const name of ['browser_use','apps','computer_use']){
    const features=scoped().map(feature=>feature.name===name?{...feature,enabled:true}:feature);
    assert.throws(()=>verifyPlanningResponseBoundary(thread,features,profile.disabled),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
  }
});

test('sandbox and approval confirmation remain required for the internal analytical profile',()=>{
  const profile=planningResponseFeatureConfig(catalog());
  for(const invalid of [{sandbox:{type:'workspaceWrite',networkAccess:false},approvalPolicy:'never'},
    {sandbox:{type:'readOnly',networkAccess:true},approvalPolicy:'never'},
    {sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'on-request'}]){
    assert.throws(()=>verifyPlanningResponseBoundary(invalid,scoped(),profile.disabled),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
  }
});
