import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const RELEASE_SKILL_FILE = fileURLToPath(new URL('./release-skills.mjs', import.meta.url));
/** Narrow structured-file guard. Not a shell sandbox or an owner-authentication boundary. */
export function managedContextPaths({dataDir,identity}={}) {
 const fallback = name => typeof dataDir === 'string' && dataDir ? path.join(path.resolve(dataDir),name) : undefined;
 const files=[RELEASE_SKILL_FILE,fallback('skills-folders.json')].filter(Boolean);
 return [...new Set([identity?.directory||fallback('identity'),fallback('skill-edits'),...files.flatMap(file=>[file,file+'.bak',file+'.lock'])].filter(Boolean).map(file=>path.resolve(file)))];
}
