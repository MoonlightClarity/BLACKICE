import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export async function prepareSourceTestTemp({parent=os.tmpdir(),io=fs,env=process.env}={}){
 const lexical=path.resolve(parent),canonical=await io.realpath(lexical),ancestry=[];
 for(const start of [lexical,canonical]){
  let current=path.resolve(start);
  for(;;){const info=await io.lstat(current);
   if(!info.isDirectory()||info.isSymbolicLink())throw Error('Source test temp ancestry must contain ordinary directories: '+current);
   ancestry.push({path:current,link:false});const next=path.dirname(current);if(next===current)break;current=next;
  }
 }
 const directory=await io.mkdtemp(path.join(canonical,'blackice-source-suite-'));
 const info=await io.lstat(directory),resolved=await io.realpath(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||path.relative(directory,resolved)!=='')throw Error('Source test temporary directory changed during preparation.');
 env.TEMP=resolved;env.TMP=resolved;env.TMPDIR=resolved;
 return {lexical,canonical,directory:resolved,ancestry,policy:'Canonical isolated test fixtures only; production path guards unchanged.'};
}
