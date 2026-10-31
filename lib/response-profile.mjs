/** Narrow analytical-worker controls. These are not a global native tool allowlist. */
const invalid=(message,code='PLANNING_RESPONSE_PROFILE_UNSUPPORTED')=>Object.assign(new Error(message),{code,status:503});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// shell_tool is the command capability gate. unified_exec only selects the
// backend and recent native runtimes normalize it to true even when shell
// tools are disabled; requiring that implementation flag to be false rejects
// valid analytical sessions without establishing any additional restriction.
export const PLANNING_RESPONSE_DISABLED_FEATURES=Object.freeze([
  'shell_tool','shell_snapshot','browser_use','browser_use_external','browser_use_full_cdp_access',
  'computer_use','in_app_browser','in_app_chat','in_app_local_automation','image_generation','view_image',
  'multi_agent','multi_agent_v2','apps','remote_plugin','plugins','hooks','code_mode_host','code_mode',
  'code_mode_only','skill_search','skill_mcp_dependency_install','tool_suggest','workspace_dependencies',
  'goals','sleep_tool','memories','request_permissions_tool','default_mode_request_user_input','standalone_web_search'
]);
const requiredFeatures=Object.freeze(['shell_tool','browser_use','browser_use_external','computer_use',
  'in_app_browser','in_app_chat','in_app_local_automation','multi_agent','apps','remote_plugin','plugins','hooks','code_mode_host','workspace_dependencies']);

export function planningResponseFeatureConfig(features){
  if(!Array.isArray(features))throw invalid('The native runtime did not report its feature controls. No module turn was started.');
  const available=new Map(features.map(feature=>[feature?.name,feature]));
  for(const name of requiredFeatures){const feature=available.get(name);if(!feature||feature.stage==='removed'||typeof feature.enabled!=='boolean')
    throw invalid('The native runtime cannot confirm the '+name+' control required by analytical modules. No module turn was started.');}
  const disabled=PLANNING_RESPONSE_DISABLED_FEATURES.filter(name=>available.has(name)&&available.get(name).stage!=='removed');
  return {disabled,config:{web_search:'disabled',model_reasoning_summary:'none',
    ...Object.fromEntries(disabled.map(name=>['features.'+name,false]))}};
}

export function verifyPlanningResponseBoundary(thread,features,disabled){
  if(thread?.sandbox?.type!=='readOnly'||thread.sandbox.networkAccess===true||thread.approvalPolicy!=='never')
    throw invalid('The native runtime did not confirm a read-only, network-restricted module sandbox with no permission escalation. No module turn was started.');
  const actual=new Map((features||[]).map(feature=>[feature?.name,feature]));
  for(const name of disabled)if(actual.get(name)?.enabled!==false||actual.get(name)?.stage==='removed')
    throw invalid('The native runtime did not apply the '+name+' restriction. No module turn was started.');
  return {profile:'planning-response',native:true,sandbox:'read-only',networkAccess:false,approvalPolicy:'never',
    ambientGmail:false,ambientPlugins:false,ambientMcp:false,ambientSkills:false,attachedTools:0,
    disabledFeatures:[...disabled],structuredOutput:'native-output-schema',
    limitation:'This verifies the declared native feature controls and sandbox, not a universal zero-tool allowlist. Only the actual public structured response is attached to the module.'};
}

export function validateResponseOnlyOptions(options={}){
  if(options.responseOnly!==undefined&&typeof options.responseOnly!=='boolean')throw invalid('responseOnly must be boolean.','INVALID_RESPONSE_PROFILE');
  if(!options.responseOnly)return;
  if(options.threadId||options.continuity||options.onBeforeFinal||options.dynamicTools!==undefined&&(!Array.isArray(options.dynamicTools)||options.dynamicTools.length))
    throw invalid('Analytical modules require a fresh thread without attached action tools, imported history or automatic final-review continuations.','INVALID_RESPONSE_PROFILE');
  if(options.sandbox!==undefined&&options.sandbox!=='read-only')throw invalid('Analytical modules cannot request a writable native sandbox.','INVALID_RESPONSE_PROFILE');
}

export function normalizeOutputSchema(value){
  if(value===undefined)return undefined;
  if(!object(value)||value.type!=='object')throw invalid('Structured output needs an object JSON schema.','INVALID_OUTPUT_SCHEMA');
  let size=0;
  const walk=(entry,depth=0)=>{
    if(depth>24)throw invalid('Structured output schema is too deeply nested.','INVALID_OUTPUT_SCHEMA');
    if(entry===null||typeof entry==='boolean'||typeof entry==='number'&&Number.isFinite(entry))return entry;
    if(typeof entry==='string'){size+=entry.length;return entry;}
    if(Array.isArray(entry))return entry.map(item=>walk(item,depth+1));
    if(object(entry))return Object.fromEntries(Object.entries(entry).map(([key,item])=>{
      if(['__proto__','constructor','prototype','$ref','$dynamicRef'].includes(key))throw invalid('Structured output schemas must be self-contained.','INVALID_OUTPUT_SCHEMA');
      size+=key.length;if(size>60000)throw invalid('Structured output schema is too large.','INVALID_OUTPUT_SCHEMA');
      return [key,walk(item,depth+1)];
    }));
    throw invalid('Structured output schema contains an unsupported value.','INVALID_OUTPUT_SCHEMA');
  };
  const result=walk(value);if(JSON.stringify(result).length>60000)throw invalid('Structured output schema is too large.','INVALID_OUTPUT_SCHEMA');return result;
}
