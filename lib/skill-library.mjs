import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseSkill, searchReleaseSkills } from './release-skills.mjs';

export const SKILL_LIBRARY_ROOT = fileURLToPath(new URL('./skill-library', import.meta.url));
const fail = (message, status = 503) => Object.assign(new Error(message), { status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value);
const libraryId = /^library-[a-z0-9][a-z0-9-]{0,91}$/;
const bodyName = /^[a-z0-9][a-z0-9-]{0,95}\.md$/;
const clean = value => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const stopwords = new Set('a an and are about can could for help how i in is it me my of on please should the this to use want what when where with would you'.split(' '));
export const skillSearchTerms = query => [...new Set((clean(query).match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || []).filter(term => !stopwords.has(term)))];
const legacyEntries = new Map(searchReleaseSkills().map(item => {
 const heading = /^#\s+(.+)$/m.exec(readReleaseSkill(item.id).content)?.[1]?.trim();
 return [item.id, Object.freeze({...item, title: heading || item.title})];
}));

export function rankSkillMetadata(entry, terms, legacyBody = '') {
 if (!terms.length) return 0;
 const title = clean(entry.title), tags = (entry.tags || []).map(clean);
 const summary = clean([entry.description, entry.summary, entry.appliesWhen, entry.scope].filter(Boolean).join(' '));
 const id = entry.id;
 const phrase = terms.join(' ');
 let score = 0, matches = 0;
 for (const term of terms) {
  if (title.split(/[^\p{L}\p{N}]+/u).includes(term)) score += 12;
  else if (title.includes(term)) score += 8;
  else if (tags.some(tag => tag === term)) score += 7;
  else if (tags.some(tag => tag.includes(term))) score += 5;
  else if (id.includes(term)) score += 4;
  else if (summary.includes(term)) score += 3;
  else if (legacyBody.includes(term)) score++;
  else continue;
  matches++;
 }
 if (matches < Math.ceil(terms.length / 2)) return -1;
 return score + matches * 3 + (terms.length > 1 && title.includes(phrase) ? 20 : 0);
}

async function readBoundedText(file, bytes) {
 const info = await fs.lstat(file);
 if (!info.isFile() || info.size > bytes) throw fail('Packaged skill library file is not a bounded regular file.');
 const data = await fs.readFile(file);
 if (data.length > bytes) throw fail('Packaged skill library file changed size during read.');
 try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
 catch { throw fail('Packaged skill library file must be valid UTF-8.'); }
}

export function createSkillLibrary({ root = SKILL_LIBRARY_ROOT } = {}) {
 let pending;
 async function load() {
  if (!pending) pending = (async () => {
   let manifest;
   try { manifest = JSON.parse(await readBoundedText(path.join(root, 'index.json'), 8 * 1024 * 1024)); }
   catch { throw fail('Packaged skill library manifest is unavailable or invalid.'); }
   if (!plain(manifest) || manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > 10000)
    throw fail('Invalid packaged skill library manifest.');
   const byId = new Map(), paths = new Set();
   for (const row of manifest.entries) {
    const p = row?.source;
    if (!plain(row) || typeof row.id !== 'string' || !libraryId.test(row.id) || byId.has(row.id)
      || !bounded(row.title, 100) || !bounded(row.description, 260)
      || !Array.isArray(row.tags) || row.tags.length > 12 || !row.tags.every(tag => bounded(tag, 32))
      || !plain(p) || p.kind !== 'first-party' || !bounded(p.revision, 128)
      || typeof row.bodyFile !== 'string' || !bodyName.test(row.bodyFile) || paths.has(row.bodyFile))
     throw fail('Invalid or duplicate packaged skill library entry.');
    paths.add(row.bodyFile);
    byId.set(row.id, Object.freeze({
     id: row.id, title: row.title, description: row.description, tags: Object.freeze([...row.tags]),
     provenance: Object.freeze({kind: p.kind, revision: p.revision}),
     revision: 1, source: 'bundled', immutable: true, loaded: 'available_on_demand', bodyFile: row.bodyFile,
    }));
   }
   return byId;
  })();
  return pending;
 }
 const metadata = ({bodyFile, ...entry}) => ({...entry, tags: [...entry.tags], provenance: {...entry.provenance}});
 return {
  async list() { return [...(await load()).values()].map(metadata); },
  async has(id) { return (await load()).has(id); },
  async metadata(id) { const row = (await load()).get(id); return row ? metadata(row) : null; },
  async read(id) {
   const row = (await load()).get(id);
   if (!row) throw fail('Release skill not found.', 404);
   let content;
   try { content = await readBoundedText(path.join(root, row.bodyFile), 800000); }
   catch { throw fail('Packaged skill body is unavailable or invalid.'); }
   if (!content.trim() || content.length > 200000 || content.includes('\0')) throw fail('Invalid packaged skill body.');
   return {...metadata(row), content};
  },
 };
}
export const defaultSkillLibrary = createSkillLibrary();
export async function hasBundledSkill(id, library = defaultSkillLibrary) {
 return legacyEntries.has(id) || (typeof id === 'string' && libraryId.test(id) && await library.has(id));
}
export function legacySkillMetadata() { return [...legacyEntries.values()].map(row => ({...row})); }
export async function readBundledSkill(id, library = defaultSkillLibrary) {
 if (legacyEntries.has(id)) return {...readReleaseSkill(id), title: legacyEntries.get(id).title};
 if (typeof id !== 'string' || !libraryId.test(id)) throw fail('Release skill not found.', 404);
 return library.read(id);
}
