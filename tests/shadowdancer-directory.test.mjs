import test from 'node:test';
import assert from 'node:assert/strict';

import { isShadowdancerRequest, parseShadowdancerRequest, runShadowdancerDirectory, ShadowdancerDirectory } from '../lib/shadowdancer-directory.mjs';

test('opt-in command is explicit, and SOURCE is separated from user request', () => {
  assert.equal(isShadowdancerRequest('/directory List codes'),true);
  assert.equal(isShadowdancerRequest('@directory List codes'),true);
  assert.equal(isShadowdancerRequest('@shadowdancer List codes'),true);
  assert.equal(isShadowdancerRequest('ordinary chat'),false);
  const parsed=parseShadowdancerRequest('/directory List all codes\nSOURCE:\nPage one\nPage two');
  assert.equal(parsed.request,'List all codes');
  assert.equal(parsed.material,'Page one\nPage two');
});
