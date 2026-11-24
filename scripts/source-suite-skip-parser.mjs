// Parse only TAP's explicit # SKIP annotations; skipped assertions did not execute.
// The publication gate still validates each exact skip name and disclosed reason.
export function parseSourceSuiteSkips(log) {
  if (typeof log !== 'string') throw new TypeError('A TAP text log is required.');
  return [...log.matchAll(/^ok \d+ - (.*?) # SKIP(?: (.*))?\r?$/gm)].map(match => ({
    name: match[1], reason: match[2] || null, assertionsRan: false,
  }));
}
