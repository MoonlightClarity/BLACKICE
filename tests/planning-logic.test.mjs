import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANNING_LOGIC_LIMITS, normalizePlanningFacts, normalizePlanningLiteral, normalizePlanningExpression, normalizePlanningBranch, evaluatePlanningExpression, evaluatePlanningBranch } from '../lib/planning-logic.mjs';
import { normalizePlanningOperation, normalizePlanningReconciliation, normalizeTaskPlan, taskPlanProgress, taskPlanAvailability } from '../lib/task-plan.mjs';
import { bindWorkflowPlan } from '../lib/planning-runtime.mjs';

const fact = (id, value) => ({ id, value, ...(value === null ? {} : { evidence: `Observed ${id} = ${value}.` }) });
const action = (id, fields = {}) => ({ id, kind: 'action', title: `Inspect ${id}`, parentId: null, status: 'pending', doneWhen: `The ${id} observation is recorded.`, ...fields });
const branch = (id, expression, then, otherwise, fields = {}) => ({ id, kind: 'choice', title: `Decide ${id}`, parentId: null, status: 'pending', branch: { if: expression, then, else: otherwise }, ...fields });
const simple = (value = true, fields = {}) => ({ plan: { facts: [fact('available', value)] }, steps: [branch('route', { fact: 'available' }, 'read', 'discover', fields), action('read', { parentId: 'route' }), action('discover', { parentId: 'route' }), action('finish')] });
const normalize = (value, previous = {}, actor = {}) => normalizeTaskPlan(value, { previous, actor });
const update = (state, id, patch) => normalize({ plan: state.plan, steps: state.steps.map(step => step.id === id ? { ...step, ...patch } : step) }, state);
const operation = { kind: 'tool', target: 'The source document', tool: 'relay_workspace', action: 'read' };
const snapshot = (step, reason = 'Recheck the earlier observation against the corrected input.') => ({ attempt: step.attempt || 1, status: step.status, at: '2026-10-29T12:00:00.000Z', reason, ...Object.fromEntries(['result', 'note', 'doneWhen', 'evidence', 'blockedReason', 'skipReason', 'operation', 'reconciliation'].filter(key => step[key] !== undefined).map(key => [key, step[key]])) });
const comparison = (left, op, right) => ({ compare: { left, op, right } });
const literal = value => ({ value });
const reference = id => ({ fact: id });

test('recursive Boolean evaluation preserves unknown and implements all three-valued truth tables', () => {
  const values = [true, false, null];
  for (const a of values) {
    assert.equal(evaluatePlanningExpression({ not: { fact: 'a' } }, [fact('a', a)]), a === null ? null : !a);
    for (const b of values) {
      const facts = [fact('a', a), fact('b', b)];
      assert.equal(evaluatePlanningExpression({ and: [{ fact: 'a' }, { fact: 'b' }] }, facts), a === false || b === false ? false : a === null || b === null ? null : true);
      assert.equal(evaluatePlanningExpression({ or: [{ fact: 'a' }, { fact: 'b' }] }, facts), a === true || b === true ? true : a === null || b === null ? null : false);
      for (const c of values) {
        const expression = { and: [{ fact: 'a' }, { not: { or: [{ fact: 'b' }, { fact: 'c' }] } }] };
        const inner = b === true || c === true ? false : b === null || c === null ? null : true;
        const expected = a === false || inner === false ? false : a === null || inner === null ? null : true;
        assert.equal(evaluatePlanningExpression(expression, [...facts, fact('c', c)]), expected);
      }
    }
  }
  assert.equal(evaluatePlanningExpression(true), true);
  assert.equal(evaluatePlanningExpression(false), false);
  assert.equal(evaluatePlanningExpression({ not: { fact: 'not_observed' } }), null);
});

test('only relevant missing observations are requested and unknown never chooses ELSE', () => {
  const conditional = expression => ({ if: expression, then: 'yes', else: 'no' });
  assert.deepEqual(evaluatePlanningBranch(conditional({ not: { fact: 'missing' } })), { value: null, missingFactIds: ['missing'], selectedChildId: null });
  assert.deepEqual(evaluatePlanningBranch(conditional({ and: [{ fact: 'missing' }, false] })), { value: false, missingFactIds: [], selectedChildId: 'no' });
  assert.deepEqual(evaluatePlanningBranch(conditional({ or: [{ fact: 'missing' }, true] })), { value: true, missingFactIds: [], selectedChildId: 'yes' });
  assert.deepEqual(evaluatePlanningBranch(conditional({ and: [{ fact: 'first' }, { not: { fact: 'first' } }, { fact: 'second' }] })), { value: null, missingFactIds: ['first', 'second'], selectedChildId: null });
});

test('facts require actual evidence for known values and expressions reject malformed or unbounded input', () => {
  assert.deepEqual(normalizePlanningFacts([{ id: 'unknown', value: null }]), [{ id: 'unknown', value: null }]);
  for (const facts of [[{ id: 'a', value: true }], [{ id: 'a', value: false, evidence: '  ' }], [{ id: 'a', value: {}, evidence: 'An object is not a supported scalar observation.' }], [fact('a', true), fact('a', false)], [{ ...fact('a', true), fabricated: true }]]) assert.throws(() => normalizePlanningFacts(facts), { code: 'INVALID_TASK_PLAN' });
  const cycle = {}; cycle.not = cycle;
  let deep = { fact: 'a' }; for (let i = 0; i < PLANNING_LOGIC_LIMITS.depth; i++) deep = { not: deep };
  for (const expression of [null, 'a && b', {}, [], { and: [] }, { or: 'a' }, { not: true, fact: 'a' }, { xnor: [true, false] }, { fact: 'bad id' }, cycle, deep, { and: Array(PLANNING_LOGIC_LIMITS.nodes + 1).fill(true) }]) assert.throws(() => normalizePlanningExpression(expression), { code: 'INVALID_TASK_PLAN' });
  for (const value of [{ if: true, then: 'a', else: 'a' }, { if: true, then: 'a' }, { if: true, then: 'a', else: 'b', extra: false }]) assert.throws(() => normalizePlanningBranch(value), { code: 'INVALID_TASK_PLAN' });
});

test('known facts automatically select branches, enforce eligibility, and complete only actual selected work', () => {
  let state = normalize(simple(true));
  assert.equal(state.steps[0].selectedChildId, 'read');
  assert.equal(state.steps.find(step => step.id === 'discover').status, 'pending', 'A condition does not manufacture an action result.');
  assert.deepEqual(taskPlanAvailability(state).ready, ['read']);
  assert.equal(taskPlanAvailability(state).byId.discover.state, 'unselected');
  assert.throws(() => update(state, 'discover', { status: 'active' }), /Choose this branch/);
  assert.throws(() => normalize(simple(true, { selectedChildId: 'discover' })), /contradicts/);
  state = update(state, 'read', { status: 'done', evidence: 'Read the requested source and recorded its actual contents.' });
  assert.equal(state.steps[0].status, 'done');
  assert.deepEqual(taskPlanAvailability(state).ready, ['finish']);
  assert.deepEqual(taskPlanProgress(state).conditionallySkipped, ['discover']);
  state = update(state, 'finish', { status: 'done', evidence: 'The final response includes the observed result.' });
  const progress = taskPlanProgress(state);
  assert.equal(progress.done, 2); assert.equal(progress.skipped, 1); assert.equal(progress.unresolvedBranches, 0); assert.equal(progress.complete, true);
  assert.equal(state.steps.find(step => step.id === 'discover').evidence, undefined);
});

test('unknown predicates block both paths and a nested IF is evaluated only within the selected outer path', () => {
  let state = normalize(simple(null));
  assert.equal(state.steps[0].selectedChildId, undefined);
  assert.deepEqual(taskPlanAvailability(state).ready, []);
  assert.equal(taskPlanAvailability(state).byId.discover.state, 'awaiting-choice');
  assert.deepEqual(taskPlanAvailability(state).byId.discover.condition.missingFactIds, ['available']);
  assert.equal(taskPlanProgress(state).complete, false);
  assert.throws(() => normalize(simple(null, { selectedChildId: 'discover' })), /unknown facts select neither/);
  const nested = { plan: { facts: [fact('outer', false)] }, steps: [branch('outer_choice', { fact: 'outer' }, 'inner_choice', 'fallback'), branch('inner_choice', { not: { fact: 'unknown_inner' } }, 'first', 'second', { parentId: 'outer_choice' }), action('first', { parentId: 'inner_choice' }), action('second', { parentId: 'inner_choice' }), action('fallback', { parentId: 'outer_choice' })] };
  state = normalize(nested);
  assert.deepEqual(taskPlanAvailability(state).ready, ['fallback']);
  assert.equal(taskPlanAvailability(state).byId.first.state, 'unselected', 'An irrelevant inner unknown cannot block the selected outer alternative.');
  assert.equal(taskPlanProgress(state).awaitingChoice.length, 0);
  assert.equal(taskPlanProgress(state).current.id, 'fallback');
  state = update(state, 'fallback', { status: 'done', evidence: 'The fallback result was checked.' });
  assert.equal(taskPlanProgress(state).complete, true);
  assert.equal(taskPlanProgress(state).skipped, 2);
});

test('root choices support Boolean branches and serialized reads derive selections without mutation', () => {
  const input = { planVersion: 1, plan: { layout: 'choice', facts: [fact('a', false)], branch: { if: { fact: 'a' }, then: 'yes', else: 'no' } }, steps: [action('yes', { dependsOn: [] }), action('no', { dependsOn: [] })] };
  const before = structuredClone(input);
  assert.deepEqual(taskPlanAvailability(input).ready, ['no']);
  assert.deepEqual(input, before);
  const state = normalize(input);
  assert.equal(state.plan.selectedChildId, 'no');
  assert.deepEqual(taskPlanProgress(state).conditionallySkipped, ['yes']);
  assert.throws(() => normalize({ ...input, plan: { ...input.plan, layout: 'sequence' } }), /Only a choice/);
  assert.throws(() => normalize({ ...input, steps: [...input.steps, action('third')] }), /two direct child paths/);
  assert.throws(() => normalize({ ...input, plan: { ...input.plan, branch: { if: true, then: 'missing', else: 'no' } } }), /direct child/);
});

test('facts may reselect unattempted work but cannot erase attempted branch outcomes without explicit revisit', () => {
  let state = normalize(simple(true));
  state = normalize({ plan: { facts: [fact('available', false)] }, steps: state.steps }, state);
  assert.equal(state.steps[0].selectedChildId, 'discover', 'A saved derived selection must not prevent a fresh observed decision.');
  state = update(state, 'discover', { status: 'done', evidence: 'The alternate source was discovered and checked.' });
  const changed = { plan: { facts: [fact('available', true)] }, steps: state.steps.map(step => step.id === 'discover' ? { ...step, status: 'pending' } : { ...step, ...(step.kind === 'choice' ? { status: 'pending' } : {}) }) };
  assert.throws(() => normalize(changed, state), { code: 'TASK_PLAN_REVISIT_REQUIRED' });
  const old = state.steps.find(step => step.id === 'discover');
  const revisited = changed.steps.find(step => step.id === 'discover');
  revisited.attempt = 2; revisited.pastAttempts = [snapshot(old)]; delete revisited.evidence;
  const next = normalize(changed, state, { revisitedStepIds: ['discover'] });
  assert.equal(next.steps[0].selectedChildId, 'read');
  assert.equal(next.steps.find(step => step.id === 'discover').pastAttempts[0].evidence, old.evidence);
  assert.deepEqual(taskPlanAvailability(next).ready, ['read']);
});

test('operation contracts are single precise objects and changed operations cannot reuse completion evidence', () => {
  assert.deepEqual(normalizePlanningOperation(operation), operation);
  assert.deepEqual(normalizePlanningOperation({ kind: 'reasoning', target: 'Compare the two observed totals.' }), { kind: 'reasoning', target: 'Compare the two observed totals.' });
  for (const value of [[operation], { ...operation, tool: 'arbitrary' }, { ...operation, target: ' ' }, { kind: 'reasoning', target: 'Calculate', action: 'run' }, { ...operation, operations: [] }]) assert.throws(() => normalizePlanningOperation(value), { code: 'INVALID_TASK_PLAN' });
  const state = normalize({ steps: [action('read', { operation, status: 'done', evidence: 'The source observation was recorded.' })] });
  assert.throws(() => update(state, 'read', { operation: { ...operation, target: 'A different source' } }), /actual evidence/);
});

test('revisiting an earlier input can switch a downstream Boolean branch while preserving its invalidated result', () => {
  const original = simple(true);
  original.steps.unshift(action('source', { status: 'done', evidence: 'The original input reported the source available.' }));
  let previous = normalize(original);
  previous = update(previous, 'read', { status: 'done', evidence: 'Read the original source and recorded its contents.' });
  previous = update(previous, 'finish', { status: 'done', evidence: 'Reported the original source result.' });
  const ids = previous.steps.filter(step => step.kind === 'action').map(step => step.id);
  const steps = previous.steps.map(step => {
    if (step.kind !== 'action') return { ...step, status: 'pending' };
    const next = { ...step, attempt: 2, pastAttempts: [snapshot(step)], status: step.id === 'source' || step.status === 'pending' ? 'pending' : 'blocked' };
    delete next.evidence;
    if (next.status === 'blocked') next.blockedReason = 'The source observation changed; reassess its previous dependent result.';
    return next;
  });
  const next = normalize({ plan: { facts: [fact('available', false)] }, steps }, previous, { revisitedStepIds: ids });
  const oldPath = next.steps.find(step => step.id === 'read');
  assert.equal(next.steps.find(step => step.id === 'route').selectedChildId, 'discover');
  assert.equal(oldPath.status, 'pending');
  assert.equal(oldPath.blockedReason, undefined);
  assert.equal(oldPath.pastAttempts[0].evidence, 'Read the original source and recorded its contents.');
  assert.equal(taskPlanAvailability(next).byId.read.state, 'unselected');
  assert.equal(next.steps.find(step => step.id === 'finish').status, 'blocked');
  assert.deepEqual(taskPlanAvailability(next).ready, ['source']);
});

test('only revisit can append runtime attempt history, and later plan replacements cannot erase or forge it', () => {
  const first = normalize({ steps: [action('read', { operation, status: 'done', evidence: 'The original source was read.' })] });
  const old = first.steps[0], pending = { ...old, status: 'pending', attempt: 2, pastAttempts: [snapshot(old)] }; delete pending.evidence;
  const revisited = normalize({ steps: [pending] }, first, { revisitedStepIds: ['read'] });
  assert.equal(revisited.steps[0].attempt, 2);
  assert.equal(revisited.steps[0].evidence, undefined);
  const stripped = { ...revisited.steps[0] }; delete stripped.attempt; delete stripped.pastAttempts;
  const saved = normalize({ steps: [stripped] }, revisited);
  assert.deepEqual(saved.steps[0].pastAttempts, revisited.steps[0].pastAttempts);
  assert.equal(saved.steps[0].attempt, 2);
  const forged = normalize({ steps: [{ ...stripped, attempt: 99, pastAttempts: [] }] }, revisited);
  assert.deepEqual(forged.steps[0].pastAttempts, revisited.steps[0].pastAttempts);
  assert.equal(forged.steps[0].attempt, 2);
  assert.throws(() => normalize({ steps: [action('new', { attempt: 2, pastAttempts: [] })] }), /not authored/);
  assert.throws(() => normalize({ steps: [{ ...pending, pastAttempts: [{ ...snapshot(old), evidence: 'Invented success' }] }] }, first, { revisitedStepIds: ['read'] }), /preserve the actual prior attempt/);
});

test('legacy text conditions and manually selected choices retain their existing completion rules', () => {
  let state = normalize({ steps: [{ id: 'legacy', kind: 'choice', title: 'Choose the supported path', status: 'pending', selectedChildId: 'one' }, action('one', { parentId: 'legacy', condition: 'The source can be read.' }), action('two', { parentId: 'legacy', condition: 'A replacement is needed.' })] });
  state = update(state, 'one', { status: 'done', evidence: 'Read the source.' });
  assert.equal(taskPlanProgress(state).complete, false);
  assert.equal(taskPlanProgress(state).unresolvedBranches, 1);
  state = update(state, 'two', { status: 'skipped', skipReason: 'The existing source succeeded.' });
  assert.equal(taskPlanProgress(state).complete, true);
});

test('ELIF clauses execute in order, select the first true path, and never jump over an unknown condition', () => {
  const cases = { if: reference('first'), then: 'first_path', elif: [{ if: reference('second'), then: 'second_path' }, { if: reference('third'), then: 'third_path' }], else: 'fallback' };
  for (const [values, selected, clause, index] of [
    [[true, true, true], 'first_path', 'if', 0],
    [[false, true, true], 'second_path', 'elif', 1],
    [[false, false, true], 'third_path', 'elif', 2],
    [[false, false, false], 'fallback', 'else', 3],
    [[null, true, true], null, null, 0],
    [[false, null, true], null, null, 1],
    [[false, false, null], null, null, 2]
  ]) {
    const outcome = evaluatePlanningBranch(cases, ['first', 'second', 'third'].map((id, i) => fact(id, values[i])));
    assert.equal(outcome.selectedChildId, selected);
    assert.equal(outcome.matchedClause, clause);
    assert.equal(outcome.clauseIndex, index);
    assert.equal(outcome.value, selected === null ? null : selected !== 'fallback');
  }
  assert.throws(() => normalizePlanningBranch({ ...cases, elif: [{ if: true, then: 'fallback' }] }), /different child paths/);
  assert.throws(() => normalizePlanningBranch({ ...cases, elif: [{ if: true, then: 'second_path', else: 'unsupported' }] }), /exactly if and then/);
  assert.throws(() => normalizePlanningBranch({ ...cases, elif: Array(PLANNING_LOGIC_LIMITS.elif + 1).fill({ if: true, then: 'same' }) }), /at most/);
});

test('typed facts distinguish unknown from observed None and use Python truthiness', () => {
  for (const [value, expected] of [[true, true], [false, false], [0, false], [-0, false], [0.5, true], [-5, true], ['', false], ['false', true], [[], false], [[false], true]]) {
    assert.equal(evaluatePlanningExpression(reference('observed'), [fact('observed', value)]), expected);
  }
  const isNone = comparison(reference('optional'), 'is', literal(null));
  assert.equal(evaluatePlanningExpression(isNone, [fact('optional', null)]), null);
  const knownNone = { id: 'optional', value: null, known: true, evidence: 'The response explicitly contains None.' };
  assert.equal(evaluatePlanningExpression(isNone, [knownNone]), true);
  assert.equal(evaluatePlanningExpression(reference('optional'), [knownNone]), false);
  assert.equal(evaluatePlanningExpression(isNone, [{ id: 'optional', value: 4, known: false }]), null);
  assert.equal(evaluatePlanningExpression(isNone, [fact('optional', 4)]), false);
  assert.throws(() => normalizePlanningFacts([{ id: 'optional', value: null, known: true }]), /nonempty evidence/);
  assert.throws(() => normalizePlanningFacts([{ ...knownNone, known: 'true' }]), /known flag/);
  for (const value of [Infinity, NaN, -Infinity, {}, [[1]], Array(PLANNING_LOGIC_LIMITS.array + 1).fill(1), 'x'.repeat(PLANNING_LOGIC_LIMITS.string + 1)]) assert.throws(() => normalizePlanningLiteral(value), { code: 'INVALID_TASK_PLAN' });
  assert.deepEqual(normalizePlanningLiteral([null, true, false, 3.5, 'observed']), [null, true, false, 3.5, 'observed']);
});

test('all comparison operators implement typed Python-style scalar, membership and list comparisons', () => {
  const cases = [
    [2, '==', 2, true], [2, '!=', 2, false], [2, '<', 3, true], [2, '<=', 2, true], [3, '>', 2, true], [3, '>=', 3, true],
    [3, '==', '3', false], [true, '==', 1, true], [false, '==', 0, true], [true, 'is', 1, false], [false, 'is not', 0, true],
    [null, 'is', null, true], [false, 'is', false, true], [true, 'is not', false, true], [4, 'is', null, false], [[], 'is not', null, true],
    ['fix', 'in', ['read', 'fix', 'check'], true], ['write', 'not in', ['read', 'fix'], true], [true, 'in', [0, 1], true],
    ['foo', 'in', 'foobar', true], ['BAR', 'not in', 'foobar', true], ['', 'in', 'anything', true],
    [[1, true, null], '==', [1, 1, null], true], [[1, 2], '!=', [1, 3], true], [[1, 2], '<', [1, 3], true],
    [[1], '<', [1, 0], true], [['a', 1], '<=', ['a', 1], true], ['𐀀', '>', '\uE000', true]
  ];
  for (const [left, op, right, expected] of cases) assert.equal(evaluatePlanningExpression(comparison(literal(left), op, literal(right))), expected, `${JSON.stringify(left)} ${op} ${JSON.stringify(right)}`);
  const typed = { and: [comparison(reference('count'), '>=', literal(3)), comparison(reference('state'), 'in', literal(['ready', 'checked'])), { not: comparison(reference('excluded'), '==', literal(true)) }] };
  assert.equal(evaluatePlanningExpression(typed, [fact('count', 4), fact('state', 'ready'), fact('excluded', false)]), true);
  assert.equal(evaluatePlanningExpression(typed, [fact('count', null), fact('state', 'ready'), fact('excluded', false)]), null);
  for (const invalid of [{ compare: { left: literal(1), op: '===', right: literal(1) } }, { compare: { left: { value: 1, fact: 'mixed' }, op: '==', right: literal(1) } }, { compare: { left: 1, op: '==', right: literal(1) } }, { compare: { left: literal(1), op: '==', right: literal(1), evaluate: 'code' } }]) assert.throws(() => normalizePlanningExpression(invalid), { code: 'INVALID_TASK_PLAN' });
});

test('invalid comparison types return an actionable unknown and cannot silently choose a later ELIF or ELSE', () => {
  for (const expression of [comparison(literal('5'), '<', literal(10)), comparison(literal(null), '>=', literal(0)), comparison(literal(1), 'in', literal('123')), comparison(literal(1), 'not in', literal(null)), comparison(literal([1, 'a']), '<', literal([1, 2])), comparison(literal('a'), 'is', literal('a'))]) {
    const conditional = { if: expression, then: 'first', elif: [{ if: true, then: 'second' }], else: 'otherwise' };
    const evaluated = evaluatePlanningBranch(conditional);
    assert.equal(evaluated.value, null); assert.equal(evaluated.selectedChildId, null); assert.ok(evaluated.diagnostics[0].length > 20);
    assert.equal(evaluated.clauseIndex, 0);
    assert.equal(evaluatePlanningExpression({ not: expression }), null);
    assert.equal(evaluatePlanningExpression({ and: [expression, false] }), false);
    assert.equal(evaluatePlanningExpression({ or: [expression, true] }), true);
  }
  const state = normalize({ plan: { layout: 'choice', branch: { if: comparison(literal('5'), '<', literal(10)), then: 'yes', else: 'no' } }, steps: [action('yes'), action('no')] });
  assert.deepEqual(taskPlanAvailability(state).ready, []);
  assert.match(taskPlanAvailability(state).byId.no.reason, /Correct the observation types/);
  assert.equal(taskPlanAvailability(state).byId.no.condition.value, null);
});

test('Boolean XOR supports nesting and unknown without silently performing integer bitwise arithmetic', () => {
  for (const a of [true, false, null]) for (const b of [true, false, null]) {
    assert.equal(evaluatePlanningExpression({ xor: [reference('a'), reference('b')] }, [fact('a', a), fact('b', b)]), a === null || b === null ? null : a !== b);
  }
  assert.equal(evaluatePlanningExpression({ xor: [true, true, true] }), true);
  assert.equal(evaluatePlanningExpression({ not: { xor: [{ and: [true, false] }, { or: [false, true] }] } }), false);
  assert.equal(evaluatePlanningExpression({ xor: [comparison(literal(3), '>', literal(1)), comparison(literal('a'), 'in', literal(['a', 'b']))] }), false);
  const invalid = evaluatePlanningBranch({ if: { xor: [reference('number'), true] }, then: 'yes', else: 'no' }, [fact('number', 5)]);
  assert.equal(invalid.value, null); assert.match(invalid.diagnostics[0], /XOR is Boolean only/);
  assert.throws(() => normalizePlanningExpression({ xor: [] }), /nonempty/);
});

test('ordered ELIF integrates with nested readiness, completion and exact direct-child validation', () => {
  const condition = { if: comparison(reference('score'), '>=', literal(90)), then: 'high', elif: [{ if: { and: [comparison(reference('score'), '>=', literal(70)), { not: reference('excluded') }] }, then: 'inspect' }, { if: comparison(reference('score'), '>=', literal(50)), then: 'low' }], else: 'fallback' };
  const input = { plan: { facts: [fact('score', 75), fact('excluded', false), fact('cached', false)] }, steps: [{ id: 'route', title: 'Choose the score path', kind: 'choice', branch: condition }, action('high', { parentId: 'route' }), branch('inspect', reference('cached'), 'cached_path', 'fresh_path', { parentId: 'route' }), action('cached_path', { parentId: 'inspect' }), action('fresh_path', { parentId: 'inspect' }), action('low', { parentId: 'route' }), action('fallback', { parentId: 'route' }), action('finish')] };
  let state = normalize(input);
  assert.equal(state.steps.find(step => step.id === 'route').selectedChildId, 'inspect');
  assert.equal(state.steps.find(step => step.id === 'inspect').selectedChildId, 'fresh_path');
  assert.deepEqual(taskPlanAvailability(state).ready, ['fresh_path']);
  assert.equal(taskPlanAvailability(state).byId.route.condition.matchedClause, 'elif');
  assert.throws(() => update(state, 'low', { status: 'active' }), /Choose this branch/);
  state = update(state, 'fresh_path', { status: 'done', evidence: 'The fresh observation matched the selected score path.' });
  assert.deepEqual(taskPlanAvailability(state).ready, ['finish']);
  state = update(state, 'finish', { status: 'done', evidence: 'The selected path result was reported.' });
  assert.equal(taskPlanProgress(state).complete, true);
  assert.equal(taskPlanProgress(state).skipped, 4);
  assert.throws(() => normalize({ ...input, steps: input.steps.filter(step => step.id !== 'low') }), /every direct child path/);
  assert.throws(() => normalize({ ...input, steps: [...input.steps, action('extra', { parentId: 'route' })] }), /every direct child path/);
});

test('reconciliation records require a done observation and remain in preserved attempt history', () => {
  const reconciliation = { callId: 'run-1:call_7', outcome: 'absent', evidence: 'The subsequent source read confirms the attempted record is absent.' };
  assert.deepEqual(normalizePlanningReconciliation(reconciliation), reconciliation);
  for (const invalid of [{ ...reconciliation, callId: 'bad id' }, { ...reconciliation, outcome: 'maybe' }, { ...reconciliation, evidence: '' }, { ...reconciliation, extra: true }]) assert.throws(() => normalizePlanningReconciliation(invalid), { code: 'INVALID_TASK_PLAN' });
  assert.throws(() => normalize({ steps: [action('inspect', { reconciliation })] }), /Only a done action/);
  const state = normalize({ steps: [action('inspect', { operation, status: 'done', evidence: 'The requested inspection confirmed absence.', reconciliation })] });
  const old = state.steps[0], pending = { ...old, status: 'pending', attempt: 2, pastAttempts: [snapshot(old)] };
  delete pending.evidence; delete pending.reconciliation;
  const next = normalize({ steps: [pending] }, state, { revisitedStepIds: ['inspect'] });
  assert.equal(next.steps[0].reconciliation, undefined);
  assert.deepEqual(next.steps[0].pastAttempts[0].reconciliation, reconciliation);
});

test('binding a shared workflow preserves an existing completed root algorithm under its history group', () => {
  const source = normalize({ plan: { layout: 'choice', facts: [fact('score', 75)], branch: { if: comparison(reference('score'), '>=', literal(90)), then: 'high', elif: [{ if: comparison(reference('score'), '>=', literal(70)), then: 'middle' }], else: 'fallback' } }, steps: [action('high'), action('middle', { status: 'done', evidence: 'The middle path source was read and checked.' }), action('fallback')] });
  const workflow = { planning: { shared: true, coordinatorNodeId: 'coordinator' }, nodes: [{ id: 'coordinator', type: 'agent', name: 'Coordinator', prompt: 'Check the requested output.' }], edges: [] };
  const next = bindWorkflowPlan(source, workflow, { runId: 'next-run' });
  assert.equal(next.plan.layout, 'parallel');
  assert.equal(next.plan.branch, undefined);
  assert.equal(next.plan.selectedChildId, undefined);
  const history = next.steps.find(step => step.id === 'prior-plan');
  assert.deepEqual(history.branch, source.plan.branch);
  assert.equal(history.selectedChildId, 'middle');
  assert.equal(history.status, 'done');
  assert.equal(next.steps.find(step => step.id === 'middle').status, 'done');
  assert.equal(next.steps.find(step => step.id === 'middle').evidence, 'The middle path source was read and checked.');
  assert.equal(next.steps.find(step => step.id === 'middle').attempt, undefined, 'preserving an old algorithm does not create another work attempt');
  assert.equal(taskPlanAvailability(next).byId.high.state, 'unselected');
  assert.equal(taskPlanAvailability(next).byId['agent-coordinator-work'].state, 'ready');
  const changed = structuredClone(next);
  changed.plan.facts = [fact('score', 99)];
  changed.plan.branch = null;
  changed.plan.selectedChildId = null;
  delete changed.steps.find(step => step.id === 'prior-plan').selectedChildId;
  for (const step of changed.steps) if (step.kind !== 'action') step.status = 'pending';
  assert.throws(() => normalize(changed, source), { code: 'TASK_PLAN_REVISIT_REQUIRED' }, 'the relocation exception cannot change the old completed branch');
});

test('workflow wrapping explicitly clears a selected legacy root choice without restoring its old selection at the new root', () => {
  const source = normalize({ plan: { layout: 'choice', selectedChildId: 'used' }, steps: [action('used', { status: 'done', evidence: 'The selected result was checked.' }), action('unused', { status: 'skipped', skipReason: 'The other path produced the result.' })] });
  const next = bindWorkflowPlan(source, { planning: { shared: true, coordinatorNodeId: 'coordinator' }, nodes: [{ id: 'coordinator', type: 'agent', name: 'Coordinator', prompt: 'Check the final output.' }], edges: [] }, { runId: 'next-run' });
  assert.equal(next.plan.selectedChildId, undefined);
  assert.equal(next.steps.find(step => step.id === 'prior-plan').selectedChildId, 'used');
  assert.equal(next.steps.find(step => step.id === 'used').status, 'done');
});
