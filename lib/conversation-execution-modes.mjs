/**
 * Independent conversation controls for directory reasoning and delegation.
 * Defaults preserve legacy opt-in /directory and application subagent settings.
 */
export const DIRECTORY_MODES=Object.freeze(['auto','on','off']);
export const SUBAGENT_MODES=Object.freeze(['default','on','off']);
const DIRECTORY_PREFIX=/^\s*(?:@directory|\/directory|@shadowdancer)\s+/i;
const invalid=(name)=>Object.assign(new Error('Invalid '+name+' choice.'),{
  status:400,code:'EXECUTION_MODE_INVALID'
});
function choice(value,valid,name){
 if(value===undefined)return undefined;
 if(typeof value!=='string'||!valid.includes(value))throw invalid(name);
 return value;
}
export function directoryModeOf(value){return choice(value,DIRECTORY_MODES,'directory reasoning');}
export function subagentsModeOf(value){return choice(value,SUBAGENT_MODES,'subagent');}
export function executionModesFrom(value,prior=null){
 const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 const previous=prior&&typeof prior==='object'?prior:{};
 return {
  directoryMode:directoryModeOf(source.directoryMode)??directoryModeOf(previous.directoryMode)??'auto',
  subagentsMode:subagentsModeOf(source.subagentsMode)??subagentsModeOf(previous.subagentsMode)??'default'
 };
}
export function usesDirectory(message,mode='auto'){
 directoryModeOf(mode);
 return mode==='on'||mode==='auto'&&DIRECTORY_PREFIX.test(String(message||''));
}
export function directoryInput(message,mode='auto'){
 directoryModeOf(mode);
 const source=String(message||'');
 if(mode==='on'&&!DIRECTORY_PREFIX.test(source))return '/directory '+source;
 return source;
}
export function assertCompatibleDirectoryMode(message,mode='auto'){
 directoryModeOf(mode);
 if(mode==='off'&&DIRECTORY_PREFIX.test(String(message||'')))throw Object.assign(
  new Error('Directory reasoning is Off. Remove the /directory command or switch Directory to Auto or On.'),
  {status:400,code:'DIRECTORY_DISABLED'});
}
export function subagentsEnabledFor(appSetting,mode='default'){
 subagentsModeOf(mode);
 return mode==='on'?true:mode==='off'?false:appSetting===true;
}
