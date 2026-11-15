import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {DirectoryActionJournal} from '../lib/directory-action-journal.mjs';
import {estimateContextTokens} from '../lib/context.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'blackice-action-profile-'));
const journal=new DirectoryActionJournal(root),times=[];
for(let i=0;i<200;i++){
 const started=performance.now();const attempt=await journal.begin('fixture-'+i,{name:'relay_workspace',arguments:{action:'write',path:'synthetic-'+i}},{objective:'Create and verify synthetic records'});
 await journal.outcome(attempt,{success:true},{fixtureReceipt:i});times.push(performance.now()-started);
 if(i%20===0)await journal.note('note-'+i,{actionId:'record-group-'+Math.floor(i/20),objective:'Verify synthetic group',state:'Written; verification pending',nextAction:'Read back checksum',evidence:[attempt.id]});
}
const reads=[];let index;
for(let i=0;i<5;i++){const started=performance.now();index=await journal.read({limit:20});reads.push(performance.now()-started);}
const sorted=[...times].sort((a,b)=>a-b);
const result={kind:'synthetic-storage-and-retrieval-only',records:(await journal.events()).length,attempts:200,appendPairMedianMs:sorted[100],appendPairP95Ms:sorted[190],indexReadMs:reads,indexEstimatedTokens:estimateContextTokens(index),indexBytes:Buffer.byteLength(JSON.stringify(index)),limits:'No live model, no task completion claim. Warm process, unflushed cache, concurrent host load uncontrolled. Reader scans all event files; these costs must be evaluated at real task scale.',retainedFixture:root};
await writeFile(process.argv[2]||'action-profile.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
