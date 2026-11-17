import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityGuidance } from '../lib/tool-routing.mjs';
import { BROWSER_INSTRUCTIONS } from '../lib/browser.mjs';
import { BROWSER_CREDENTIAL_INSTRUCTIONS } from '../lib/browser-credential-tools.mjs';
import { BROWSER_SIGNIN_INSTRUCTIONS } from '../lib/browser-signin.mjs';

test('attached credential routing is optional and does not override ordinary account-form guidance', () => {
  for (const planningMode of ['on', 'off']) {
    const routing = capabilityGuidance([{name:'relay_browser'}, {name:'relay_credentials'}, {name:'relay_browser_signin'}], {planningMode});
    assert.match(routing, /optional account-continuity helper, not a preferred or mandatory browser route/);
    assert.match(routing, /ordinary browser controls remain available/);
    assert.doesNotMatch(routing, /For an authorized signup, use the attached credential tool/);
    assert.match(routing, /do not generate a replacement password or reset the account/);
    for (const guidance of [routing,BROWSER_INSTRUCTIONS,BROWSER_CREDENTIAL_INSTRUCTIONS,BROWSER_SIGNIN_INSTRUCTIONS]) {
      assert.doesNotMatch(guidance, /never put plaintext passwords|Password text never belongs|Password secrecy applies to every account|use the attached relay_credentials capability when available/);
    }
  }
});

test('credential playbook is absent when the helper is not actually attached', () => {
  const routing = capabilityGuidance([{name:'relay_browser'}], {planningMode:'off'});
  assert.doesNotMatch(routing, /relay_credentials:|optional account-continuity helper/);
});
