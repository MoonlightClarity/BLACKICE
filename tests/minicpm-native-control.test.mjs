import test from 'node:test';
import {classifyHistoricalSnapshot} from '../verification/minicpm-agent-tools-v2/historical-fixture-gate.mjs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {FROZEN}=require('../verification/minicpm-agent-tools-v2/native-control.cjs');
// Exact historical inputs were never part of the public source checkout.
// A completely absent snapshot is an explicit unexecuted integration test;
// a present but incomplete/corrupt snapshot must execute and fail its SHA pins.
const {available}=classifyHistoricalSnapshot(FROZEN.baseRoot);
if (!available) {
  test('Historical MiniCPM native-control benchmark requires original pinned 2026-11-20 snapshot', {skip:'Historical frozen source absent; no benchmark assertions executed or credited.'}, ()=>{});
} else {
  await import('./minicpm-native-control.historical.mjs');
}
