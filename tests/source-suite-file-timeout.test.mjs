import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Windows source-suite root timeout exceeds its own longest allowed acceptance scenario', async () => {
  const [runner, acceptance] = await Promise.all([
    readFile(new URL('../scripts/source-suite-receipt.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./planning-workflow-acceptance.test.mjs', import.meta.url), 'utf8'),
  ]);
  const configured = runner.match(/const SOURCE_TEST_FILE_TIMEOUT_MS\s*=\s*(\d+);/);
  assert.ok(configured, 'Source-suite file timeout must be explicit and inspectable');
  const timeout = Number(configured[1]);
  assert.match(runner, /concurrency:\s*1,\s*timeout:\s*SOURCE_TEST_FILE_TIMEOUT_MS/,
    'The canonical test runner must actually use the declared file timeout');
  const allowances = [...acceptance.matchAll(/timeout:\s*configuration\.count\s*===\s*20\s*\?\s*(\d+)\s*:\s*(\d+)/g)]
    .flatMap(match => [Number(match[1]), Number(match[2])]);
  assert.ok(allowances.length > 0, 'Inspect the real acceptance fixture timeout contracts');
  assert.ok(timeout >= Math.max(...allowances) + 60000,
    'The full-file timeout must exceed each accepted child deadline with operational cleanup headroom');
  assert.ok(timeout <= 600000, 'A broken acceptance worker still needs a bounded outer deadline');
});