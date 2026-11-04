// Model-free preparation shared by the live evaluator and its regression tests.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

export function parseOutcomeOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Use --option value pairs.');
    options[args[i].slice(2)] = args[i + 1];
  }
  for (const key of Object.keys(options)) if (!['baseline', 'candidate', 'root', 'case-file', 'modes', 'ids', 'dependencies', 'variants'].includes(key)) throw Error('Unknown option: ' + key);
  const variants = (options.variants || 'baseline,candidate').split(',');
  if (!variants.length || variants.some(variant => !['baseline', 'candidate'].includes(variant)) || new Set(variants).size !== variants.length) {
    throw Error('Variants must select baseline, candidate, or both without duplicates.');
  }
  if (!options.root || variants.some(variant => !options[variant])) {
    throw Error('Usage: node scripts/outcome-live-eval.mjs --baseline SOURCE --candidate SOURCE --root UNUSED_DIRECTORY --case-file FIXTURES [--variants baseline,candidate|candidate] [--modes on,off] [--ids CASE,CASE]. Supply source paths for each selected variant.');
  }
  const root = path.resolve(options.root);
  const sources = Object.fromEntries(variants.map(variant => [variant, path.resolve(options[variant])]));
  const modes = (options.modes || 'on').split(',');
  if (!modes.length || modes.some(mode => !['on', 'off'].includes(mode)) || new Set(modes).size !== modes.length) throw Error('Planning modes must be on, off, or on,off.');
  if (!options['case-file']) throw Error('Supply --case-file with an explicit local fixture file.');
  const caseFile = path.resolve(options['case-file']);
  const dependencies = path.resolve(options.dependencies || path.join(sources.baseline || sources.candidate, 'node_modules'));
  return { options, root, sources, modes, caseFile, dependencies };
}

async function snapshotSource(source, target, dependencyRoot) {
  await fs.mkdir(target);
  // Planning loads its packaged skill during module import. Preserve the whole
  // skill tree, including references, as part of the executable source snapshot.
  for (const directory of ['lib', 'public', 'skills']) await fs.cp(path.join(source, directory), path.join(target, directory), { recursive: true });
  for (const file of ['server.mjs', 'package.json']) await fs.copyFile(path.join(source, file), path.join(target, file));
  const files = {};
  async function walk(directory, relative = '') {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const key = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), key);
      else if (entry.isFile()) files[key] = hash(await fs.readFile(path.join(directory, entry.name)));
    }
  }
  await walk(target);
  const dependencies = await fs.realpath(dependencyRoot);
  await fs.symlink(dependencies, path.join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return { fingerprint: hash(json(files)), files, dependencies };
}

export async function snapshotOutcomeSources({ sources, root, dependencies }) {
  const snapshots = {};
  for (const [variant, source] of Object.entries(sources)) {
    snapshots[variant] = await snapshotSource(source, path.join(root, 'source-' + variant), dependencies);
  }
  const changedFiles = snapshots.baseline && snapshots.candidate
    ? [...new Set([...Object.keys(snapshots.baseline.files), ...Object.keys(snapshots.candidate.files)])].filter(file => snapshots.baseline.files[file] !== snapshots.candidate.files[file])
    : null; // A single-variant run makes no baseline comparison.
  return { snapshots, changedFiles };
}
