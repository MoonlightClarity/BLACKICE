import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AttachmentStore, createAttachmentToolHandler } from '../lib/attachments.mjs';
import { attachmentResourceKey } from '../lib/operation-descriptors.mjs';
import { repairLocalReadArguments } from '../lib/local-read-argument-repair.mjs';
import { validateFileSearchCall } from '../lib/file-search-contract.mjs';

test('recorded attachment filename and stem calls resolve to actual task evidence', async t => {
  const dataDir=await fs.mkdtemp(path.join(tmpdir(),'relay-resume-repair-'));
  const store=await new AttachmentStore({dataDir}).init();
  t.after(async()=>{await store.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const a=await store.importBytes({name:'Candidate_Resume.txt',bytes:Buffer.from('Example resume evidence')});
  const b=await store.importBytes({name:'Foreign.txt',bytes:Buffer.from('Unrelated')});
  const handler=createAttachmentToolHandler({store,attachmentIds:[a.id],cwd:dataDir});
  const call=(attachmentId,action='read')=>({name:'relay_files',arguments:{action,attachmentId}});
  for(const ref of [a.id,'Candidate_Resume.txt','Candidate_Resume']){
    const descriptor=await handler.describeOperation(call(ref));
    assert.equal(descriptor.effect,'observe');
    assert.equal(descriptor.resources[0].key,attachmentResourceKey(a.sha256));
    let admitted;
    const result=await handler(call(ref),{onOperationDispatch:d=>{admitted=d;}});
    assert.equal(admitted.resources[0].key,attachmentResourceKey(a.sha256));
    assert.equal(result.success,true);
    const body=JSON.parse(result.contentItems[0].text);
    assert.equal(body.attachment.id,a.id);
    assert.match(JSON.stringify(body),/Example resume evidence/);
  }
  for(const ref of [b.id,b.name,'Foreign','USER.md','../Candidate_Resume.txt','unknown']){
    await assert.rejects(handler(call(ref)),{code:'ATTACHMENT_NOT_IN_TASK_SCOPE',actionDispatched:false});
  }
  await assert.rejects(handler(call(a.name,'export')),{code:'ATTACHMENT_NOT_IN_TASK_SCOPE'});
  const c=await store.importBytes({name:'Candidate_Resume.txt',bytes:Buffer.from('Distinct version')});
  const ambiguous=createAttachmentToolHandler({store,attachmentIds:[a.id,c.id]});
  for(const ref of [a.name,'Candidate_Resume'])await assert.rejects(ambiguous(call(ref)),{code:'ATTACHMENT_NOT_IN_TASK_SCOPE'});
  assert.equal((await ambiguous(call(a.id))).success,true);
});

test('only exact recorded local framing leak is corrected; strict validation is retained',()=>{
  for(const query of ['resume','Job','employer','OBerry']){
    const args={query:query+'\n</</parameter>\n<parameter=path>\n/',match:'name',extensions:[]};
    assert.throws(()=>validateFileSearchCall(args),{code:'FILE_SEARCH_ARGUMENT_INVALID'});
    const fixed=repairLocalReadArguments('relay_find_files',args);
    assert.deepEqual(validateFileSearchCall(fixed),{query,path:'/',match:'name',extensions:[]});
    assert.notEqual(fixed,args);
    assert.equal(repairLocalReadArguments('relay_workspace',args),args);
    for(const extra of [{path:'somewhere'},{roots:['elsewhere']},{cursor:'x'},{unrecognized:true}]){
      const malformed={...args,...extra};
      assert.equal(repairLocalReadArguments('relay_find_files',malformed),malformed);
    }
  }
  for(const query of ['resume','resume\njob','resume\n</</parameter>\n<parameter=path>\n/other']){
    const args={query};assert.equal(repairLocalReadArguments('relay_find_files',args),args);
  }
});
