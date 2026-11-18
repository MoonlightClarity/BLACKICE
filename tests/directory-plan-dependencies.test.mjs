import test from 'node:test';
import assert from 'node:assert/strict';

import {resolveDirectoryDependencies as resolve} from '../lib/directory-plan-dependencies.mjs';


test('named siblings preserve dependencies alongside numeric IDs and explicit independence', () => {
  assert.deepEqual(resolve('1.1', [{id:'brief'}, {id:'asset',depends_on:['brief','1','1.1.1']}, {depends_on:[]}, {}]),
    [[],['1.1.1'],[],['1.1.3']]);
});

test('unknown, ambiguous, self, forward and malformed dependencies reject the split', () => {
  for (const steps of [
    [{id:'brief'}, {depends_on:['missing']}],
    [{id:'same'}, {id:'same'}],
    [{depends_on:['1']}],
    [{depends_on:['2']}, {}],
    [{id:'2'}, {}],
    [{}, {depends_on:'1'}],
    [{}, {depends_on:['1.1.1']}],
  ]) assert.equal(resolve('1',steps),null);
});
