// Reproducible, multi-file diagnostic evidence for the event-replay coding benchmark.
// The 21 code acceptance checks are unchanged; this extends evidence workload only.
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const diagnoses=[
  ['independent-stream-id',
   'CONFIRMED: the same event id in stream A and stream B denotes two independent records, each sequence 1.',
   'DISCARDED HYPOTHESIS: the global event ID cache is intentionally shared across all streams.'],
  ['idempotency-vs-version',
   'CONFIRMED: a duplicate event must be recognized before checking stale expectedVersion; it returns the original committed record.',
   'DISCARDED HYPOTHESIS: any stale expectedVersion must reject a duplicate.'],
  ['failure-commit-order',
   'CONFIRMED: an apply callback that rejects must not commit its event; the next retry must succeed.',
   'DISCARDED HYPOTHESIS: append-before-apply is safe because callbacks never reject.'],
  ['concurrent-per-stream-queue',
   'CONFIRMED: same-stream concurrent operations serialize by invocation order, while different streams execute independently.',
   'DISCARDED HYPOTHESIS: a global mutex is required to make all streams safe.'],
  ['exclusive-cursor-validation',
   'CONFIRMED: read after cursor is exclusive; negative cursor or nonpositive read limit must reject, never silently truncate.',
   'DISCARDED HYPOTHESIS: cursor zero is invalid and limit zero should return an empty list.'],
  ['immutable-event-payloads',
   'CONFIRMED: caller payload, committed payload and returned read/lookup payloads must not share mutable references.',
   'DISCARDED HYPOTHESIS: structuredClone is unnecessary because callers never mutate their inputs.'],
  ['validation-before-apply',
   'CONFIRMED: missing payload and negative expectedVersion must be rejected before StreamProcessor invokes apply.',
   'DISCARDED HYPOTHESIS: an invalid event may enter apply as long as append eventually rejects.'],
  ['recovery-and-linked-evidence',
   'CONFIRMED: failures in a queued event must not poison the queue; a later event can commit, and duplicates apply once.',
   'DISCARDED HYPOTHESIS: a failed stream queue must stay rejected until process restart.'],
];
const compactName=(i)=>'diagnostics/trace-'+String(i+1).padStart(2,'0')+'.log';

export async function makeLongEvidence(write,root){
 const names=[],detail=[];
 for(let i=0;i<diagnoses.length;i++){
  const [kind,confirmed,misleading]=diagnoses[i];
  const name=compactName(i);
  names.push(name);
  const records=[
   'EVENT-REPLAY / FORENSIC TRIAL '+String(i+1).padStart(2,'0')+' / '+kind,
   '2026-11-23T00:00:00Z SCOPE: archived tool observations; do not infer correctness from a single line.',
   '2026-11-23T00:00:01Z CONFIDENCE: evidence is noisy; only CONCLUSIVE lines are authoritative.',
  ];
  for(let n=0;n<250;n++){
   const id=n+i*250,phase=(n%7),stream=['A','B','C','D'][n%4];
   records.push(
    '2026-11-23T'+String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')+
    ':13Z run='+String(i+1).padStart(2,'0')+' sample='+String(id).padStart(5,'0')+
    ' stream='+stream+' observedVersion='+((id*13+17)%97)+
    ' callbackLatencyMs='+((id*7)%113)+' retryEpoch='+phase+
    ' signal=overlapping-provider-trace state=provisional decision=needs-correlation evidenceWindow='+((id*37)%1009)+
    ' sourceSymbol='+['ledger.append','ledger.read','processor.process','ledger.lookup'][n%4]
   );
   if(n===71)records.push('2026-11-23T00:24:04Z '+misleading);
   if(n===145)records.push('2026-11-23T00:44:31Z NOT YET VERIFIED: a previous assistant summary contradicted one observed callback; inspect final reconciliation.');
  }
  const last='2026-11-23T04:'+String(42+i).padStart(2,'0')+':59Z CONCLUSIVE / '+kind+': '+confirmed;
  records.push(last);
  await write(name,records.join('\n')+'\n');
  detail.push({file:name,kind,conclusive:last,bytes:Buffer.byteLength(records.join('\n')+'\n','utf8')});
 }
 const previous=await readFile(path.join(root,'README.md'),'utf8');
 const appendix=[
  '',
  '## Required incident-audit protocol',
  'Before claiming the incident diagnosis is complete, inspect the archived diagnostic shards below.',
  'Each shard covers one independent regression or rejected hypothesis. They are not interchangeable.',
  'The early repeated observations are noisy; the conclusive record is near the end of each source.',
  'You may use workspace read with startLine/lineCount, exact search, or a small local script to process them.',
  'Use whichever method is most efficient, but ground your implementation in their actual evidence.',
  'Do not trust an old assistant summary or the first contradictory hypothesis in a shard.',
  'Keep the public source/test APIs unchanged and verify the final code, including invalid-event side effects.',
  'The incident review is part of the task. Do not write a prose-only diagnosis instead of fixing code.',
  '',
  ...names.map(name=>'- '+name),
  '',
 ].join('\n');
 await write('README.md',previous+appendix);
 await write('diagnostics/INDEX.md',[
  '# EVENT-REPLAY Diagnostic archive',
  'Eight independent provider-forensics traces, one per failure class.',
  'The relevant conclusion for each class appears after the repeated observations near the tail.',
  'The first 150 lines are intentionally not conclusive; correlate before editing.',
  ...names.map((name,index)=>String(index+1)+'. '+name+' — '+diagnoses[index][0]),
  'Efficient command-line inspection is allowed and may reduce model-visible output. That is a valid strategy.',
 ].join('\n')+'\n');
 return{files:names,bytes:detail.reduce((sum,row)=>sum+row.bytes,0),details:detail};
}
