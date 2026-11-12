/** Directory is an explicit On/Off control. Delegation always uses the application default. */
export const DIRECTORY_MODES=Object.freeze(['on','off']);
export const SUBAGENT_MODES=Object.freeze(['default']);
const LEGACY_SUBAGENT_MODES=Object.freeze(['default','on','off']);
const DIRECTORY_PREFIX=/^\s*(?:@directory|\/directory|@shadowdancer)\s+/i;
const invalid=name=>Object.assign(new Error('Invalid '+name+' choice.'),{status:400,code:'EXECUTION_MODE_INVALID'});
function choice(value,valid,name){if(value===undefined)return undefined;if(typeof value!=='string'||!valid.includes(value))throw invalid(name);return value;}
// Compatibility input is resolved at admission; new saved runs never contain Auto.
export function directoryModeOf(value){return value==='auto'?'on':choice(value,DIRECTORY_MODES,'Directory On/Off');}
// Retired conversation switches are accepted only to normalize the next admission.
// Historical run snapshots stay unchanged.
export function subagentsModeOf(value){return choice(value,LEGACY_SUBAGENT_MODES,'subagent')===undefined?undefined:'default';}
export function executionModesFrom(value,prior=null){
 const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 const previous=prior&&typeof prior==='object'?prior:{};
 return {
  directoryMode:directoryModeOf(source.directoryMode)??directoryModeOf(previous.directoryMode)??(DIRECTORY_PREFIX.test(String(source.task||source.input||''))?'on':'off'),
  subagentsMode:subagentsModeOf(source.subagentsMode)??subagentsModeOf(previous.subagentsMode)??'default'
 };
}
export function usesDirectory(message,mode){
 if(mode===undefined||mode==='auto')return DIRECTORY_PREFIX.test(String(message||''));
 directoryModeOf(mode);return mode==='on';
}
export function directoryInput(message,mode){
 if(mode!==undefined)directoryModeOf(mode);
 const source=String(message||'');
 return mode==='on'&&!DIRECTORY_PREFIX.test(source)?'/directory '+source:source;
}
export function assertCompatibleDirectoryMode(message,mode){
 if(mode!==undefined)directoryModeOf(mode);
 if(mode==='off'&&DIRECTORY_PREFIX.test(String(message||'')))throw Object.assign(new Error('Directory is Off. Remove the /directory command or switch Directory On.'),{status:400,code:'DIRECTORY_DISABLED'});
}
export function subagentsEnabledFor(appSetting,mode='default'){subagentsModeOf(mode);return appSetting===true;}
