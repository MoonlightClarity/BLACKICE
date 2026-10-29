// Declarative Python-like conditions, never arbitrary executable Python or JS.
// Unknown observations stay unknown through NOT, comparisons and ordered ELIF.
export const PLANNING_LOGIC_LIMITS = Object.freeze({ facts: 200, depth: 24, nodes: 512, evidence: 2000, string: 2000, array: 200, elif: 198 });
export const PLANNING_COMPARISON_OPERATORS = Object.freeze(['==', '!=', '<', '<=', '>', '>=', 'in', 'not in', 'is', 'is not']);

const fail = message => Object.assign(new Error(message), { code: 'INVALID_TASK_PLAN', status: 400 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const identifier = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value))
    throw fail(`${label} must be a stable identifier of at most 120 letters, digits, underscores or hyphens.`);
  return value;
};

export function normalizePlanningLiteral(value) {
  const scalar = item => {
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && !item.includes('\0') && item.length <= PLANNING_LOGIC_LIMITS.string) return item;
    throw fail(`A planning value must be None/null, a Boolean, a finite number, text of at most ${PLANNING_LOGIC_LIMITS.string} characters, or a flat list of those values.`);
  };
  if (!Array.isArray(value)) return scalar(value);
  if (value.length > PLANNING_LOGIC_LIMITS.array) throw fail(`A planning list supports at most ${PLANNING_LOGIC_LIMITS.array} scalar values.`);
  return value.map(scalar);
}

export function normalizePlanningFacts(value) {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > PLANNING_LOGIC_LIMITS.facts)
    throw fail(`Planning facts must be an array of at most ${PLANNING_LOGIC_LIMITS.facts} observations.`);
  const seen = new Set();
  return value.map(fact => {
    if (!object(fact) || Object.keys(fact).some(key => !['id', 'value', 'known', 'evidence'].includes(key)))
      throw fail('A planning fact accepts only id, value, optional known and evidence.');
    const id = identifier(fact.id, 'Fact ID');
    if (seen.has(id)) throw fail('Planning fact IDs must be unique.');
    seen.add(id);
    const observation = normalizePlanningLiteral(fact.value);
    if (fact.known !== undefined && typeof fact.known !== 'boolean') throw fail('The optional fact known flag must be true or false.');
    const known = fact.known ?? observation !== null;
    let evidence;
    if (fact.evidence !== undefined) {
      if (typeof fact.evidence !== 'string' || fact.evidence.includes('\0') || fact.evidence.length > PLANNING_LOGIC_LIMITS.evidence)
        throw fail(`Fact evidence must be text of at most ${PLANNING_LOGIC_LIMITS.evidence} characters.`);
      evidence = fact.evidence.trim();
    }
    if (known && !evidence) throw fail('A known planning fact needs nonempty evidence of the observation; use null or known:false when unknown.');
    return { id, value: observation, ...(fact.known === undefined ? {} : { known: fact.known }), ...(evidence ? { evidence } : {}) };
  });
}

export function normalizePlanningExpression(value) {
  let count = 0;
  const ancestors = new Set();
  const consume = depth => {
    if (++count > PLANNING_LOGIC_LIMITS.nodes || depth > PLANNING_LOGIC_LIMITS.depth)
      throw fail(`A Boolean expression supports at most ${PLANNING_LOGIC_LIMITS.nodes} nodes and ${PLANNING_LOGIC_LIMITS.depth} nested levels.`);
  };
  const operand = (value, depth) => {
    consume(depth);
    if (!object(value) || Object.keys(value).length !== 1 || !own(value, 'fact') && !own(value, 'value')) throw fail('A comparison operand must be exactly {fact:id} or {value:literal}.');
    return own(value, 'fact') ? { fact: identifier(value.fact, 'Fact reference') } : { value: normalizePlanningLiteral(value.value) };
  };
  function visit(expression, depth) {
    consume(depth);
    if (expression === true || expression === false) return expression;
    if (!object(expression) || Object.keys(expression).length !== 1)
      throw fail('A Boolean expression must be true, false, or exactly one of fact, and, or, xor, not, compare.');
    if (ancestors.has(expression)) throw fail('A Boolean expression cannot contain a cycle.');
    ancestors.add(expression);
    const key = Object.keys(expression)[0];
    let normalized;
    if (key === 'fact') normalized = { fact: identifier(expression.fact, 'Fact reference') };
    else if (key === 'not') normalized = { not: visit(expression.not, depth + 1) };
    else if (['and', 'or', 'xor'].includes(key)) {
      const items = expression[key];
      if (!Array.isArray(items) || !items.length || items.length > PLANNING_LOGIC_LIMITS.nodes)
        throw fail('AND, OR and XOR require a nonempty bounded array of Boolean expressions.');
      normalized = { [key]: items.map(item => visit(item, depth + 1)) };
    } else if (key === 'compare') {
      const comparison = expression.compare;
      if (!object(comparison) || Object.keys(comparison).some(key => !['left', 'op', 'right'].includes(key)) || !PLANNING_COMPARISON_OPERATORS.includes(comparison.op)) throw fail('A comparison needs left, op and right with a supported Python-style comparison operator.');
      normalized = { compare: { left: operand(comparison.left, depth + 1), op: comparison.op, right: operand(comparison.right, depth + 1) } };
    } else throw fail('A Boolean expression supports only fact, and, or, xor, not, compare.');
    ancestors.delete(expression);
    return normalized;
  }
  return visit(value, 1);
}

export function normalizePlanningBranch(value) {
  if (!object(value) || Object.keys(value).some(key => !['if', 'then', 'elif', 'else'].includes(key)) || !own(value, 'if'))
    throw fail('A Boolean branch needs if, then, optional ordered elif clauses, and else.');
  const branch = { if: normalizePlanningExpression(value.if), then: identifier(value.then, 'IF child ID') };
  if (value.elif !== undefined) {
    if (!Array.isArray(value.elif) || value.elif.length > PLANNING_LOGIC_LIMITS.elif) throw fail(`ELIF must be an ordered array of at most ${PLANNING_LOGIC_LIMITS.elif} clauses.`);
    branch.elif = value.elif.map(clause => {
      if (!object(clause) || Object.keys(clause).some(key => !['if', 'then'].includes(key)) || !own(clause, 'if')) throw fail('Each ELIF clause needs exactly if and then.');
      return { if: normalizePlanningExpression(clause.if), then: identifier(clause.then, 'ELIF child ID') };
    });
  }
  branch.else = identifier(value.else, 'ELSE child ID');
  const paths = [branch.then, ...(branch.elif || []).map(clause => clause.then), branch.else];
  if (new Set(paths).size !== paths.length) throw fail('IF, ELIF and ELSE must identify different child paths.');
  return branch;
}

const known = fact => Boolean(fact && (fact.known ?? fact.value !== null));
const result = (value, missingFactIds = [], diagnostics = []) => ({ value, missingFactIds: [...new Set(missingFactIds)], ...(diagnostics.length ? { diagnostics: [...new Set(diagnostics)] } : {}) });
function resolveOperand(operand, facts) {
  if (own(operand, 'value')) return { known: true, value: operand.value, missingFactIds: [] };
  const fact = facts.get(operand.fact);
  return known(fact) ? { known: true, value: fact.value, missingFactIds: [] } : { known: false, missingFactIds: [operand.fact] };
}
const truth = value => Array.isArray(value) || typeof value === 'string' ? value.length > 0 : value !== null && value !== false && value !== 0;
const numeric = value => typeof value === 'number' || typeof value === 'boolean';
const typeName = value => value === null ? 'None' : Array.isArray(value) ? 'list' : typeof value === 'string' ? 'text' : typeof value === 'boolean' ? 'Boolean' : 'number';
function equal(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]));
  if (numeric(left) && numeric(right)) return Number(left) === Number(right);
  return left === right;
}
function order(left, right) {
  if (numeric(left) && numeric(right)) return { valid: true, value: Number(left) < Number(right) ? -1 : Number(left) > Number(right) ? 1 : 0 };
  if (typeof left === 'string' && typeof right === 'string') return order([...left].map(character => character.codePointAt(0)), [...right].map(character => character.codePointAt(0)));
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index++) if (!equal(left[index], right[index])) return order(left[index], right[index]);
    return { valid: true, value: left.length < right.length ? -1 : left.length > right.length ? 1 : 0 };
  }
  return { valid: false, message: `Ordering requires comparable numbers, text, or list elements; observed ${typeName(left)} and ${typeName(right)}. Correct the observation types or change the comparison.` };
}
function compare(comparison, facts) {
  const left = resolveOperand(comparison.left, facts), right = resolveOperand(comparison.right, facts), op = comparison.op;
  if (!left.known || !right.known) return result(null, [...left.missingFactIds, ...right.missingFactIds]);
  const a = left.value, b = right.value;
  if (op === '==' || op === '!=') return result(op === '==' ? equal(a, b) : !equal(a, b));
  if (op === 'is' || op === 'is not') {
    if (a !== null && b !== null && typeof a !== 'boolean' && typeof b !== 'boolean') return result(null, [], ['IS / IS NOT supports None or Boolean identity only. Use == / != to compare numbers, text or lists.']);
    return result(op === 'is' ? a === b : a !== b);
  }
  if (op === 'in' || op === 'not in') {
    let contains;
    if (Array.isArray(b)) contains = b.some(item => equal(a, item));
    else if (typeof a === 'string' && typeof b === 'string') contains = b.includes(a);
    else return result(null, [], [`IN / NOT IN requires a list on the right, or text on both sides; observed ${typeName(a)} and ${typeName(b)}. Correct the observation types or choose another comparison.`]);
    return result(op === 'in' ? contains : !contains);
  }
  const compared = order(a, b);
  if (!compared.valid) return result(null, [], [compared.message]);
  return result(op === '<' ? compared.value < 0 : op === '<=' ? compared.value <= 0 : op === '>' ? compared.value > 0 : compared.value >= 0);
}

function evaluate(expression, facts) {
  if (expression === true || expression === false) return result(expression);
  if (own(expression, 'fact')) {
    const value = resolveOperand(expression, facts);
    return value.known ? result(truth(value.value)) : result(null, value.missingFactIds);
  }
  if (own(expression, 'compare')) return compare(expression.compare, facts);
  if (own(expression, 'not')) {
    const evaluated = evaluate(expression.not, facts);
    return result(evaluated.value === null ? null : !evaluated.value, evaluated.missingFactIds, evaluated.diagnostics);
  }
  const operator = own(expression, 'and') ? 'and' : own(expression, 'or') ? 'or' : 'xor';
  const missing = [], diagnostics = []; let unknown = false, parity = false;
  for (const item of expression[operator]) {
    let evaluated;
    const bareFact = object(item) && own(item, 'fact') ? facts.get(item.fact) : null;
    if (operator === 'xor' && known(bareFact) && typeof bareFact.value !== 'boolean') evaluated = result(null, [], [`XOR is Boolean only; fact ${item.fact} contains ${typeName(bareFact.value)}. Compare it explicitly before XOR instead of applying integer bitwise arithmetic.`]);
    else evaluated = evaluate(item, facts);
    if (operator === 'and' && evaluated.value === false || operator === 'or' && evaluated.value === true) return result(evaluated.value);
    if (evaluated.value === null) unknown = true;
    else if (evaluated.value) parity = !parity;
    missing.push(...evaluated.missingFactIds); diagnostics.push(...(evaluated.diagnostics || []));
  }
  return result(unknown ? null : operator === 'xor' ? parity : operator === 'and', missing, diagnostics);
}

export function evaluatePlanningExpression(expression, facts = []) {
  return evaluate(normalizePlanningExpression(expression), new Map(normalizePlanningFacts(facts).map(fact => [fact.id, fact]))).value;
}

export function evaluatePlanningBranch(value, facts = []) {
  const branch = normalizePlanningBranch(value), observations = new Map(normalizePlanningFacts(facts).map(fact => [fact.id, fact]));
  const clauses = [{ if: branch.if, then: branch.then }, ...(branch.elif || [])];
  const trace = (matchedClause, clauseIndex) => clauses.length > 1 ? { matchedClause, clauseIndex } : {};
  for (let index = 0; index < clauses.length; index++) {
    const evaluated = evaluate(clauses[index].if, observations);
    if (evaluated.value === null) return { ...evaluated, selectedChildId: null, ...trace(null, index) };
    if (evaluated.value) return { ...evaluated, selectedChildId: clauses[index].then, ...trace(index ? 'elif' : 'if', index) };
  }
  return { ...result(false), selectedChildId: branch.else, ...trace('else', clauses.length) };
}
