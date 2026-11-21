import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityGuidance } from '../lib/tool-routing.mjs';
import { BROWSER_INSTRUCTIONS, BROWSER_TOOL } from '../lib/browser.mjs';
import { BROWSER_CREDENTIAL_INSTRUCTIONS } from '../lib/browser-credential-tools.mjs';
import { BROWSER_SIGNIN_INSTRUCTIONS } from '../lib/browser-signin.mjs';

test('attached credential routing is optional and does not override ordinary account-form guidance', () => {
  for (const planningMode of ['on', 'off']) {
    const routing = capabilityGuidance([{name:'relay_browser'}, {name:'relay_credentials'}, {name:'relay_browser_signin'}], {planningMode});
    assert.match(routing, /helper is optional/);
    assert.match(routing, /ordinary browser forms remain available/);
    assert.doesNotMatch(routing, /For an authorized signup, use the attached credential tool/);
    assert.match(routing, /Account recovery follows the user's request/);
    for (const guidance of [routing,BROWSER_INSTRUCTIONS,BROWSER_CREDENTIAL_INSTRUCTIONS,BROWSER_SIGNIN_INSTRUCTIONS]) {
      assert.doesNotMatch(guidance, /never put plaintext passwords|Password text never belongs|Password secrecy applies to every account|use the attached relay_credentials capability when available/);
    }
  }
});

test('credential playbook is absent when the helper is not actually attached', () => {
  const routing = capabilityGuidance([{name:'relay_browser'}], {planningMode:'off'});
  assert.doesNotMatch(routing, /relay_credentials:|optional account-continuity helper/);
});

test('attached browser documents its operation without duplicating task-specific email or job skills',()=>{
 const guidance=BROWSER_TOOL.description;
 assert.match(guidance,/password_manager on an owned site tabId/);
 assert.match(guidance,/manager is optional; normal page controls remain available/);
 assert.match(guidance,/absolute local paths with the observed file input or chooser/);
 assert.doesNotMatch(guidance,/known webmail service|confirmed sender|Check Sent|relevant job boards|educated inference/);
});
