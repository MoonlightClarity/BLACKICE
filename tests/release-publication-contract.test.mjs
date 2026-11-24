// Independent, fast regression check for the maintainer's release behavior.
// Do not redefine the expected trigger to accommodate an unrequested downgrade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/publish-windows-release.yml', import.meta.url), 'utf8');
const documentation = readFileSync(new URL('../SIGNING-AND-RELEASE.md', import.meta.url), 'utf8');
const agentInstructions = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

const requiredTriggers = [
  'push:',
  'branches: [main]',
  "paths: ['.github/release-request.json']",
  'workflow_dispatch:',
];

function declaredTriggers(source) {
  const match = /^on:\r?\n([\s\S]*?)(?=^\S)/m.exec(source);
  assert.ok(match, 'Missing release-workflow event declaration');
  return match[1].trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

test('an explicit release-request push to main starts publication without manual dispatch', () => {
  assert.deepEqual(declaredTriggers(workflow), requiredTriggers,
    'The automatic release-request trigger and optional workflow_dispatch must be retained; ordinary source pushes must not publish');
});

test('the independent check detects the original November 17 manual-only regression', () => {
  const manualOnly = workflow.replace(
    /  push:\r?\n    branches: \[main\]\r?\n    paths: \['\.github\/release-request\.json'\]\r?\n/,
    '',
  );
  assert.notEqual(manualOnly, workflow, 'Test fixture must remove the actual push trigger');
  assert.notDeepEqual(declaredTriggers(manualOnly), requiredTriggers, 'Manual-only must be detected as a regression');

  const allSourcePushes = workflow.replace(
    "paths: ['.github/release-request.json']",
    "paths: ['**']",
  );
  assert.notDeepEqual(declaredTriggers(allSourcePushes), requiredTriggers,
    'Ordinary source pushes are not authorized release requests');
});

test('release documentation and developer instructions preserve the user-directed automation contract', () => {
  assert.match(documentation, /runs automatically when a push to `main` changes `\.github\/release-request\.json`/i);
  assert.match(documentation, /`workflow_dispatch` remains available as an optional manual path/i);
  assert.doesNotMatch(documentation,
    /runs only through \*\*Run workflow\*\*|started only with \*\*Run workflow\*\*|ordinary source pushes, including edits to/i);
  assert.match(agentInstructions, /release-request\.json` \*\*automatically starts\*\*/);
  assert.match(agentInstructions, /Do \*\*not\*\* remove or narrow the automatic trigger/);
});
