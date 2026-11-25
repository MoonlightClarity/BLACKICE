// Check links in retained first-party documentation. No history/status manifest.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const documents=tracked.filter(p=>p.endsWith('.md')&&!p.startsWith('lib/vendor/')&&!p.startsWith('tests/fixtures/')&&!p.startsWith('verification/')&&fs.existsSync(path.join(root,p)));
const failures=[];
let checked=0;
for(const p of documents){
  const file=path.join(root,p);
  const source=fs.readFileSync(file,'utf8').replace(/^(\s*)(\x60{3}|~~~)[^\n]*\r?\n[\s\S]*?^\1\2\s*$/gm,'');
  const links=[...source.matchAll(/!?\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']+["'])?\)/g)].map(m=>m[1]??m[2]);
  links.push(...[...source.matchAll(/^\s*\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map(m=>m[1]??m[2]));
  for(const raw of links){
    if(/^(?:#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw))continue;
    let rel=raw.split(/[?#]/,1)[0];
    if(!rel)continue;
    try{rel=decodeURIComponent(rel);}catch{failures.push(p+': invalid link '+raw);continue;}
    const target=path.resolve(path.dirname(file),rel);
    checked++;
    if(!target.startsWith(root+path.sep)&&target!==root)failures.push(p+': link escapes repo '+raw);
    else if(!fs.existsSync(target))failures.push(p+': missing '+raw);
  }
}
if(failures.length){
  for(const f of failures)console.error('DOCS ERROR: '+f);
  console.error(failures.length+' broken links');
  process.exitCode=1;
}else console.log('Documentation links OK:',documents.length,'files,',checked,'local targets.');
