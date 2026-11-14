// Resolve the whole sibling plan before admitting any child work. Invalid
// dependencies must never silently turn a dependent step into independent work.
export function resolveDirectoryDependencies(parentId, steps) {
  const aliases = new Map();
  for (let i = 0; i < steps.length; i++) {
    const alias = String(steps[i].id ?? '').trim();
    if (!alias) continue;
    if (aliases.has(alias)) return null;
    const canonical = `${parentId}.${i + 1}`;
    if ((/^\d+$/.test(alias) && alias !== String(i + 1)) ||
        (alias.startsWith(parentId + '.') && alias !== canonical)) return null;
    aliases.set(alias, canonical);
  }
  const resolved = [];
  for (let i = 0; i < steps.length; i++) {
    const declared = steps[i].depends_on;
    if (declared !== undefined && !Array.isArray(declared)) return null;
    const tokens = declared ?? (i ? [String(i)] : []);
    const refs = [];
    for (const token of tokens) {
      if (typeof token !== 'string' && typeof token !== 'number') return null;
      const raw = String(token).trim();
      const ref = aliases.get(raw) ?? (/^\d+$/.test(raw) ? `${parentId}.${raw}` : raw);
      const prior = steps.slice(0, i).findIndex((_, n) => ref === `${parentId}.${n + 1}`);
      if (prior < 0) return null;
      if (!refs.includes(ref)) refs.push(ref);
    }
    resolved.push(refs);
  }
  return resolved;
}
