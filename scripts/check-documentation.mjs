// Check links in retained first-party documentation. No history/status manifest.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Reject only the known forms of accumulated development history, not useful guides,
// runtime skills, licensing, or test fixtures. Git history retains removed records.
export function obsoleteDocumentationPaths(paths) {
  return paths.filter(p =>
    /^RELEASE-NOTES-\d+(?:\.\d+){1,2}\.md$/i.test(p) ||
    p === 'docs/document-status.json' || p === 'docs/README.md' ||
    /^docs\/(?:history|research|verification|design)\//i.test(p) ||
    /^docs\/[^/]*[-_]20(?:\d{6}|\d{2}[-_]\d{2}[-_]\d{2})[^/]*\.(?:md|json)$/i.test(p) ||
    /^verification\/[^/]+\.(?:tap|jsonl)$/i.test(p) ||
    /^tests\/(?:retired|legacy)\//i.test(p)
  );
}

const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const documents=tracked.filter(p=>p.endsWith('.md')&&!p.startsWith('lib/vendor/')&&!p.startsWith('tests/fixtures/')&&!p.startsWith('verification/')&&fs.existsSync(path.join(root,p)));
const failures=obsoleteDocumentationPaths(tracked).map(p=>'obsolete tracked development material: '+p);
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
