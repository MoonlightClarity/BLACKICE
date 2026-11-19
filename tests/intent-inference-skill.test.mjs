import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalToolHandler } from '../lib/retrieval-tools.mjs';

const id='library-intent-inference';
const handler=createRetrievalToolHandler({cwd:process.cwd()});
async function invoke(args){
 const result=await handler({name:'relay_skills',arguments:args});
 assert.equal(result.success,true,JSON.stringify(result));
 return JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);
}

test('Intent Inference is discoverable for the motivating request without loading its body',async()=>{
 for(const query of ['Intent Inference','apply for jobs until 6 AM EST','resolve a time-only deadline','infer the deadline for this request','How should I handle an ambiguous request?']){
  const {entries}=await invoke({action:'search',query,limit:5});
  assert.equal(entries[0]?.id,id,query);
  assert.ok(entries.every(entry=>!Object.hasOwn(entry,'content')),query);
 }
 for(const query of ['Find three plausible analyst jobs.','Read the JSON file and count rows.','Correct the typo in this markdown file.']){
  const {entries}=await invoke({action:'search',query,limit:5});
  assert.ok(!entries.some(entry=>entry.id===id),query);
 }
});

test('the first-party skill can be opened and operationalizes temporal and non-temporal ambiguity',async()=>{
 const {entry}=await invoke({action:'read',id});
 assert.equal(entry.id,id); assert.equal(entry.provenance.kind,'first-party');
 assert.match(entry.content,/^# Intent Inference/m);
 assert.match(entry.content,/advisory method/);
 assert.match(entry.content,/6 AM EST on November 20/);
 assert.match(entry.content,/explicitly dated cutoff[\s\S]*host-bound deadline/);
 assert.match(entry.content,/Do not convert the fixed cutoff/);
 assert.match(entry.content,/ask the smallest discriminating question/);
 assert.match(entry.content,/do not apply, inherit the old cutoff/);
 assert.match(entry.content,/do not claim the work will keep running overnight/i);
 assert.match(entry.content,/two plausible Alexes/);
 assert.match(entry.content,/I meant just revise the summary/);
});

