#!/usr/bin/env node
/**
 * Detect Git identities that accidentally assign BLACKICE project work to
 * someone else's GitHub account. Scoped to new commits: the published history
 * already contains one known misattributed commit that must be repaired in a
 * separate, coordinated history-rewrite operation.
 */
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const OWNER_EMAIL='325637566+moonlightclarity@users.noreply.github.com';
const WRONG_EMAIL='blackice@users.noreply.github.com';
const NOREPLY_DOMAIN='@users.noreply.github.com';

export function invalidProjectIdentity(name,email){
  const n=String(name??'').trim().toLowerCase();
  const e=String(email??'').trim().toLowerCase();
  return e===WRONG_EMAIL || n==='blackice'&&e.endsWith(NOREPLY_DOMAIN)&&e!==OWNER_EMAIL;
}

const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024}).trimEnd();
const zeroSha=value=>/^0{40,64}$/.test(String(value||''));

export function checkAttribution(base,head='HEAD'){
  if(!head||/^[^\w./-]/.test(head))throw Error('Provide a valid HEAD ref.');
  let range;
  if(base&&!zeroSha(base)){
    range=base+'..'+head;
  }else{
    // For new branches, check the new tip, not every historical commit.
    try{git('rev-parse','--verify',head+'^');range=head+'^..'+head;}
    catch{range=head;}
  }
  const shas=git('rev-list','--no-abbrev-commit',range).split(/\r?\n/).filter(Boolean);
  const invalid=[];
  for(const sha of shas){
    const [authorName,authorEmail,committerName,committerEmail]=git('show','-s','--format=%an%n%ae%n%cn%n%ce',sha).split(/\r?\n/);
    if(invalidProjectIdentity(authorName,authorEmail))invalid.push({sha,role:'author',name:authorName,email:authorEmail});
    if(invalidProjectIdentity(committerName,committerEmail))invalid.push({sha,role:'committer',name:committerName,email:committerEmail});
  }
  return {range,examined:shas.length,invalid};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const {range,examined,invalid}=checkAttribution(process.argv[2],process.argv[3]||'HEAD');
    for(const row of invalid)console.error('Invalid '+row.role+' on '+row.sha+': '+row.name+' <'+row.email+'>');
    if(invalid.length){
      console.error("\nBLACKICE project work must not use an unrelated GitHub account's noreply address.\nUse: git config user.name MoonlightClarity\n     git config user.email 325637566+MoonlightClarity@users.noreply.github.com\nCorrect unpublished commits before pushing; coordinate any rewrite of published history.");
      process.exitCode=1;
    }else console.log('Attribution check passed ('+examined+' new commits, range '+range+').');
  }catch(error){console.error('Cannot verify commit attribution: '+error.message);process.exitCode=1;}
}
