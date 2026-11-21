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
 assert.match(entry.content,/next useful action/);
 assert.match(entry.content,/6 AM EST.*normally means November 20/);
 assert.match(entry.content,/explicitly dated cutoff[\s\S]*host-bound deadline/);
 assert.match(entry.content,/Resuming an expired Goal does not move its deadline/);
 assert.match(entry.content,/Ask only for a missing choice that materially changes/);
 assert.match(entry.content,/same topic or wording alone does not resume an old Goal/);
 assert.match(entry.content,/does not establish that background execution exists/);
 assert.match(entry.content,/identify the intended Alex/);
 assert.match(entry.content,/When corrected, update the affected step and retain valid work/);
});

test('intent guidance distinguishes transferable experience from the work the user wants next',async()=>{
 const query='transferable experience versus target work';
 const {entries}=await invoke({action:'search',query,limit:5});
 assert.equal(entries[0]?.id,id,query);
 assert.ok(!Object.hasOwn(entries[0],'content'));
 const {entry}=await invoke({action:'read',id});
 assert.equal(entry.provenance.revision,'clarity-20261121');
 assert.match(entry.content,/leave old work or replace an approach/);
 assert.match(entry.content,/regular duties and outputs/);
 assert.match(entry.content,/past work as evidence of transferable ability/);
 assert.match(entry.content,/does not exclude an entire industry or tool/);
 assert.match(entry.content,/pricing briefs[\s\S]*graded training data/);
 assert.match(entry.content,/compare options by their regular duties and outputs/);
});
