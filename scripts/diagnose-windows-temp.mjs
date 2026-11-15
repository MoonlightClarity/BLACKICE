import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {BrowserProfileStore} from '../lib/browser-profile.mjs';
const lexical=os.tmpdir(),canonical=await fs.realpath(lexical);
const ancestry=[];let cursor=path.resolve(lexical);
for(;;){const st=await fs.lstat(cursor);ancestry.push({path:cursor,real:await fs.realpath(cursor),link:st.isSymbolicLink(),directory:st.isDirectory()});const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
const outcomes=[];
for(const [kind,parent] of [['lexical',lexical],['canonical',canonical]]){
 const dir=await fs.mkdtemp(path.join(parent,'blackice-path-probe-'));
 try{await new BrowserProfileStore({dataDir:path.join(dir,'store')}).init();outcomes.push({kind,dir,real:await fs.realpath(dir),passed:true});}
 catch(e){outcomes.push({kind,dir,real:await fs.realpath(dir),passed:false,code:e.code,message:e.message});}
}
const result={source:process.env.GITHUB_SHA,node:process.version,platform:process.platform,lexical,canonical,ancestry,outcomes,scope:'Disposable CI fixture only; production guards unchanged; no full suite'};
await fs.mkdir('verification/diagnostics',{recursive:true});
await fs.writeFile('verification/diagnostics/windows-temp-d463.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
