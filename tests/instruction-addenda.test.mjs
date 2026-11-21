import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKSPACE_INSTRUCTIONS,WORKSPACE_TOOL,FIND_FILES_TOOL} from '../lib/workspace-tools.mjs';
import {APPLICATION_INSTRUCTIONS,APPLICATION_TOOL} from '../lib/application-tools.mjs';
import {IDENTITY_INSTRUCTIONS,IDENTITY_TOOLS} from '../lib/identity.mjs';
import {BROWSER_SIGNIN_INSTRUCTIONS,BROWSER_SIGNIN_TOOL} from '../lib/browser-signin.mjs';
import {PROJECT_INSTRUCTIONS,PROJECT_TOOL} from '../lib/project-tools.mjs';
import {CONTROL_INSTRUCTIONS,CONTROL_TOOL} from '../lib/control-tools.mjs';
import {BROWSER_CREDENTIAL_INSTRUCTIONS,BROWSER_CREDENTIAL_TOOL} from '../lib/browser-credential-tools.mjs';

const addenda = [
  WORKSPACE_INSTRUCTIONS,APPLICATION_INSTRUCTIONS,IDENTITY_INSTRUCTIONS,
  BROWSER_SIGNIN_INSTRUCTIONS,PROJECT_INSTRUCTIONS,CONTROL_INSTRUCTIONS,BROWSER_CREDENTIAL_INSTRUCTIONS,
];

test('ordinary tool addenda remain a compact supplement to their exported schemas',()=>{
  for(const text of addenda) assert.equal(typeof text,'string');
  // This is a prompt-growth regression budget, never a runtime output or task limit.
  assert.ok(addenda.reduce((sum,text)=>sum+text.length,0)<=6500);
  for(const tool of [WORKSPACE_TOOL,FIND_FILES_TOOL,APPLICATION_TOOL,...IDENTITY_TOOLS,BROWSER_SIGNIN_TOOL,PROJECT_TOOL,CONTROL_TOOL,BROWSER_CREDENTIAL_TOOL]){
    assert.ok(tool.name && tool.inputSchema?.properties);
    assert.equal(tool.inputSchema.additionalProperties,false);
  }
});

test('ordinary addenda do not resurrect conflicting global policies or connector-only protocols',()=>{
  const text=addenda.join('\n');
  assert.doesNotMatch(text,/full quantitative planning contract|only the user may apply|quoted user statement|do not operate existing user windows/i);
  assert.doesNotMatch(WORKSPACE_INSTRUCTIONS,/For direct connector calls|blackice_get_job|same connection|requestId/);
  assert.match(APPLICATION_INSTRUCTIONS,/compatibility list does not limit other attached adapters/);
});

test('condensation retains the actual action contracts for identity, restoration and staged projects',()=>{
  assert.deepEqual(IDENTITY_TOOLS[0].inputSchema.properties.action.enum,['read']);
  assert.equal(APPLICATION_TOOL.inputSchema.properties.expectedTextSha256.pattern,'^[a-f0-9]{64}$');
  assert.ok(APPLICATION_TOOL.inputSchema.properties.action.enum.includes('restore_document'));
  for(const action of ['start','retry_task','review_task']) assert.ok(PROJECT_TOOL.inputSchema.properties.action.enum.includes(action));
  assert.match(PROJECT_INSTRUCTIONS,/review_task[^.]*paused review[^.]*start resumes[^.]*without repeating delivery/);
  assert.equal(BROWSER_CREDENTIAL_TOOL.inputSchema.properties.expectedRevision.minimum,0);
  assert.match(IDENTITY_INSTRUCTIONS,/fixed SOUL snapshot[^.]*current USER profile/);
});
