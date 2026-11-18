import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
test('current headless smoke imports existing journeys without retired Knowledge authoring',async()=>{
 const url=new URL('./next-headless-smoke.mjs',import.meta.url),source=await readFile(url,'utf8');
 for(const match of source.matchAll(/from ['"](\.[^'"]+)['"]/g))await access(new URL(match[1],url));
 assert.doesNotMatch(source,/exerciseKnowledgeManagement|fixture\.knowledge\(|knowledgeStore|next-knowledge-management-journey/);
 for(const name of ['exerciseCronjobs','exerciseWorkflowManager','exerciseVisualPlanning','exerciseTaskManagement','exerciseIdentitySettings','exerciseProviderSettings','exerciseConnectionSettings','exerciseConnectionImportSettings'])assert.ok(source.includes('await '+name+'('),name+' journey retained');
});
