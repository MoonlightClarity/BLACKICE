import path from 'node:path';
/** Narrow structured-file guard. Not a shell sandbox or an owner-authentication boundary. */
export function managedContextPaths({dataDir,identity,knowledge,learning}={}) {
 const fallback = name => typeof dataDir === 'string' && dataDir ? path.join(path.resolve(dataDir),name) : undefined;
 const files=[knowledge?.file||fallback('knowledge.json'),knowledge?.approvalsFile||fallback('knowledge-approvals.json'),knowledge?.organizationFile||fallback('knowledge-folders.json'),learning?.file||fallback('learning.json')].filter(Boolean);
 return [...new Set([identity?.directory||fallback('identity'),knowledge?.lockDirectory,...files.flatMap(file=>[file,file+'.bak',file+'.lock'])].filter(Boolean).map(file=>path.resolve(file)))];
}
