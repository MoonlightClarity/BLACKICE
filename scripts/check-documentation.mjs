// First-party Markdown/documentation integrity check. No dependencies or network calls.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const errors = [];
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const firstParty = tracked.filter((p) =>
  p.endsWith('.md') &&
  !p.startsWith('lib/vendor/') &&
  !p.startsWith('tests/fixtures/') &&
  !p.startsWith('verification/') &&
  !p.startsWith('node_modules/')
);
for (const dir of ['', 'docs', 'docs/history']) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const p = path.posix.join(dir, entry.name);
      if (!firstParty.includes(p)) firstParty.push(p);
    }
  }
}
const publicDocs = firstParty.filter((p) =>
  (!p.includes('/') || p.startsWith('docs/')) &&
  !/^RELEASE-NOTES-\d+\.\d+(?:\.\d+)?\.md$/.test(p) &&
  p !== 'docs/history/RECURSIVE-PLANNING-SCHEMA10.md' &&
  !p.startsWith('docs/history/')
);
const manifestPath = path.join(root, 'docs/document-status.json');
if (!fs.existsSync(manifestPath)) {
  errors.push('Missing docs/document-status.json');
} else {
  const status = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const statuses = ['current', 'reference', 'historical'];
  const assignments = new Map();
  for (const kind of statuses) {
    if (!Array.isArray(status[kind])) {
      errors.push('Document status is not an array: ' + kind);
      continue;
    }
    for (const p of status[kind]) {
      if (assignments.has(p)) errors.push('Duplicate classification: ' + p);
      assignments.set(p, kind);
      if (!fs.existsSync(path.join(root, p))) errors.push('Classified path does not exist: ' + p);
    }
  }
  for (const p of publicDocs) {
    if (!assignments.has(p)) errors.push('Unclassified public document: ' + p);
  }
  for (const p of assignments.keys()) {
    if (!publicDocs.includes(p)) errors.push('Classification out of scope: ' + p);
  }
  for (const [p, kind] of assignments) {
    if (kind !== 'historical') continue;
    const front = fs.readFileSync(path.join(root, p), 'utf8').slice(0, 750);
    if (!/Status: Historical/i.test(front)) {
      errors.push('Historical document lacks prominent status banner: ' + p);
    }
  }
}
const latest = 'RELEASE-NOTES-' + pkg.version + '.md';
if (!fs.existsSync(path.join(root, latest))) errors.push('Missing versioned release note: ' + latest);
for (const p of ['docs/README.md', 'RELEASE-NOTES.md']) {
  const doc = fs.readFileSync(path.join(root, p), 'utf8');
  const opening = doc.slice(0, 2500);
  if (!opening.includes(latest)) errors.push(p + ' does not lead with source-version release note ' + latest);
  if (!opening.includes('**' + pkg.version + '**')) errors.push(p + ' has a stale source-version banner (expected ' + pkg.version + ')');
}
let linksChecked = 0;
for (const p of firstParty) {
  const abs = path.join(root, p);
  const source = fs.readFileSync(abs, 'utf8');
  // Ignore fenced code snippets; the check is for navigational documentation links.
  const prose = source.replace(/^(\s*)(```|~~~)[^\n]*\r?\n[\s\S]*?^\1\2\s*$/gm, '');
  const links = [];
  const inline = /!?\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']+["'])?\)/g;
  for (const m of prose.matchAll(inline)) links.push(m[1] ?? m[2]);
  const refs = /^\s*\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gm;
  for (const m of prose.matchAll(refs)) links.push(m[1] ?? m[2]);
  for (const raw of links) {
    if (/^(?:#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
    const rel = raw.split(/[?#]/, 1)[0];
    if (!rel) continue;
    let decoded = rel;
    try { decoded = decodeURIComponent(rel); }
    catch { errors.push(p + ': invalid URL encoding in ' + raw); continue; }
    if (decoded.includes('\0')) { errors.push(p + ': invalid NUL link'); continue; }
    const dest = path.resolve(path.dirname(abs), decoded);
    if (!dest.startsWith(root + path.sep) && dest !== root) {
      errors.push(p + ': link escapes repository: ' + raw);
      continue;
    }
    linksChecked++;
    if (!fs.existsSync(dest)) errors.push(p + ': missing link target: ' + raw);
  }
}
if (errors.length) {
  for (const err of errors) console.error('DOCS ERROR: ' + err);
  console.error('Documentation check failed: ' + errors.length + ' issue(s).');
  process.exitCode = 1;
} else {
  console.log('Documentation check passed: ' + firstParty.length +
    ' first-party Markdown files; ' + linksChecked + ' relative targets; ' +
    publicDocs.length + ' classified entrypoints; source ' + pkg.version + '.');
}