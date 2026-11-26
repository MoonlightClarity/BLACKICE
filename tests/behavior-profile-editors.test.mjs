import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createRuntimeWorkspace} from '../public/next/workspaces/runtime.mjs';
import {createIdentitySettings} from '../public/next/workspaces/settings-identity.mjs';

test('Runtime owns the Skills-style instruction/tool/skill editor rather than Config',t=>{
 const f=planningDOM(t),ui=createRuntimeWorkspace({mount:f.mount,
  api:async()=>{throw Error('No API calls until Runtime is entered.');}});
 t.after(()=>ui.destroy());
 for(const id of ['runtime-tree','runtime-editor','runtime-new-form','runtime-save','runtime-delete',
  'runtime-delete-confirm','runtime-restore','runtime-schema','runtime-source-label',
  'runtime-role','runtime-order','runtime-enabled','runtime-audits'])
  assert.ok(f.$('#'+id),'missing Runtime control '+id);
 assert.equal(f.$('#next-developer-layer-text'),null);
});
test('Config retains SOUL/USER editors but no instruction or tool-definition editor',t=>{
 const f=planningDOM(t),ui=createIdentitySettings({mount:f.mount,api:async()=>{}});
 t.after(()=>ui.destroy());
 assert.ok(f.$('#next-identity-soul'));
 assert.ok(f.$('#next-identity-user'));
 for(const id of ['next-identity-instructions','next-identity-tools','next-developer-layer-text',
  'next-execution-layers-editor','next-tool-description-content'])
  assert.equal(f.$('#'+id),null,'legacy Config control was not removed: '+id);
});
