import test from 'node:test';
import assert from 'node:assert/strict';

import {planShadowdancerRebuild,parseRebuildRequest} from '../lib/shadowdancer-rebuild.mjs';

test('rebuild command grammar requires explicit saved source and optional revision',()=>{
 assert.deepEqual(parseRebuildRequest('REBUILD_FROM: original-run'),{sourceRunId:'original-run'});
 assert.deepEqual(parseRebuildRequest('REBUILD_FROM: original-run\nEDIT_REVISION: edit-00001'),{
  sourceRunId:'original-run',expectedEditId:'edit-00001'
 });
 assert.equal(parseRebuildRequest('REBUILD_FROM: ../other'),null);
});
