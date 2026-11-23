#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {loadJobSearchHistory,triageJobSearchCandidates} from '../lib/jobsearch-batch-triage.mjs';

function fail(message){process.stderr.write(message+'\n');process.exitCode=2;}
const args=process.argv.slice(2);
const option=name=>{const idx=args.indexOf(name);return idx>=0?args[idx+1]:null;};
const history=option('--history');
const candidates=option('--candidates');
if(!history||!candidates||!path.isAbsolute(history)||!path.isAbsolute(candidates)){
  fail('Usage: node scripts/jobsearch-batch-triage.mjs --history <absolute Application History folder> --candidates <absolute JSON array file>');
} else {
  try{
    const raw=await readFile(candidates,'utf8');
    if(raw.length>2*1024*1024)throw new Error('Candidate batch too large.');
    const input=JSON.parse(raw.replace(/^\uFEFF/,''));
    const index=await loadJobSearchHistory(history);
    process.stdout.write(JSON.stringify(triageJobSearchCandidates(index,input),null,2)+'\n');
  }catch(error){fail('Batch triage failed without changing application history: '+String(error?.message||error));}
}