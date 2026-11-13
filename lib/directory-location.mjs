/** Stable per-conversation Directory locations. Existing histories are never moved. */
import path from 'node:path';
import {lstatSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const ID=/^[A-Za-z0-9_-]{1,120}$/;
const fail=message=>Object.assign(Error(message),{code:'DIRECTORY_LOCATION',status:409});
export function assertDirectoryLocationPath(value){
  const absolute=path.resolve(value),parsed=path.parse(absolute);let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    try{if(lstatSync(current).isSymbolicLink())throw Object.assign(fail('Directory locations cannot traverse symbolic links or junctions.'),{code:'SHADOWDANCER_PATH'});}
    catch(error){if(error.code==='ENOENT')return;throw error;}
  }
}
function scope(cwd,id){
  if(typeof cwd!=='string'||!path.isAbsolute(cwd)||!ID.test(id||''))throw fail('Use an absolute workspace and a valid conversation ID.');
  const workspace=path.resolve(cwd);
  return {workspace,file:path.join(workspace,'.blackice','directory-locations',id+'.json'),
    legacy:path.join(workspace,'.shadowdancer',id),fresh:path.join(workspace,'.blackice','directory',id)};
}
function exists(file){try{lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function checked(cwd,root){
  if(typeof root!=='string'||!path.isAbsolute(root)||/[\x00-\x1f]/.test(root))throw fail('Use an absolute Directory root.');
  const value=path.resolve(root),relative=path.relative(value,cwd);
  if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw fail('Directory root cannot contain the workspace.');
  const metadata=path.join(cwd,'.blackice','directory-locations');
  if(value===metadata||value.startsWith(metadata+path.sep)||metadata.startsWith(value+path.sep))throw fail('Directory root cannot overlap location metadata.');
  assertDirectoryLocationPath(value);return value;
}
export function resolveDirectoryRoot(cwd,id,explicitRoot){
  const {workspace,file,legacy,fresh}=scope(cwd,id);assertDirectoryLocationPath(file);
  let saved;
  try{saved=JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw fail('Directory location record is unreadable: '+e.message);}
  if(saved){
    if(saved.version!==1||saved.conversationId!==id)throw fail('Invalid Directory location record.');
    const root=checked(workspace,saved.root);
    if(explicitRoot!==undefined&&checked(workspace,explicitRoot)!==root)throw fail('Conversation already has a different Directory location.');
    return root;
  }
  const hasLegacy=exists(legacy),hasFresh=exists(fresh);
  if(hasLegacy&&hasFresh)throw fail('Both legacy and current Directory histories exist; repair the location record before continuing.');
  const established=hasLegacy?legacy:hasFresh?fresh:null;
  if(explicitRoot!==undefined){
    const root=checked(workspace,explicitRoot);
    if(established&&root!==path.resolve(established))throw fail('Existing Directory history must retain its location.');
    return root;
  }
  return checked(workspace,established||fresh);
}
/** Persist before the first write, including when adopting a legacy history. */
export function registerDirectoryRoot(cwd,id,explicitRoot){
  const {file}=scope(cwd,id),root=resolveDirectoryRoot(cwd,id,explicitRoot);
  assertDirectoryLocationPath(file);mkdirSync(path.dirname(file),{recursive:true});
  try{writeFileSync(file,JSON.stringify({version:1,conversationId:id,root})+'\n',{flag:'wx'});}
  catch(e){if(e.code!=='EEXIST')throw e;}
  const recorded=resolveDirectoryRoot(cwd,id);
  if(recorded!==root)throw fail('Another writer selected a different Directory location.');
  return recorded;
}
export function directoryLocation({cwd,conversationId}){return {root:resolveDirectoryRoot(cwd,conversationId),workspace:cwd};}
