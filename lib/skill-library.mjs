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
const stopwords = new Set('a an and are about can could do for help how i in is it me my of on please should the this to use want what when where with would you'.split(' '));
export const skillSearchTerms = query => [...new Set((clean(query).match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || []).filter(term => !stopwords.has(term)))];
const legacyEntries = new Map(searchReleaseSkills().map(item => {
 const heading = /^#\s+(.+)$/m.exec(readReleaseSkill(item.id).content)?.[1]?.trim();
 return [item.id, Object.freeze({...item, title: heading || item.title})];
}));

const tokens = value => clean(value).match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [];
const stem = term => term.length > 4 && term.endsWith('ies') ? term.slice(0,-3)+'y'
 : term.length > 3 && /[^sui]s$/.test(term) ? term.slice(0,-1) : term;
const words = value => tokens(value).flatMap(term=>term.includes('-')?[term,...term.split('-')]:[term]).map(stem);
// Canonical body tokens shared by the owner FTS index and metadata ranker.
export const skillBodySearchTerms = value => [...new Set(words(value))];
const formatTags = new Set(['pdf','docx','xlsx','csv','svg']);
const phraseWords = value => tokens(value.replaceAll('-',' ')).filter(term=>!stopwords.has(term)).map(stem);
function aliasEvidence(queryWords, alias) {
 const pattern = phraseWords(alias);
 if ((' '+queryWords.join(' ')+' ').includes(' '+pattern.join(' ')+' ')) return 70;
 // Allow up to two intervening significant words, preserving order and
 // exact token boundaries. Single words never qualify as intent anchors.
 for (let i=0;i<queryWords.length;i++) {
  if (queryWords[i] !== pattern[0]) continue;
  let j=i+1, k=1;
  const stop=Math.min(queryWords.length,i+pattern.length+2);
  for (;j<stop&&k<pattern.length;j++) if(queryWords[j]===pattern[k])k++;
  if(k===pattern.length)return 55;
 }
 return 0;
}

// Lexical only. Ordinary title/tag/ID/summary matches need half the significant
// words, or two strong overlaps plus one substantive description word. An
// exact or nearby curated phrase or supported format tag can anchor a longer sentence.
// Body fallback is limited to original inline skills and owner edits.
export function rankSkillMetadata(entry, terms, legacyBody = '', query = terms.join(' ')) {
 if (!terms.length) return 0;
 const titles = new Set(words(entry.title));
 const tags = (entry.tags || []).map(tag=>new Set(words(tag)));
 const summary = new Set(words([entry.description, entry.summary, entry.appliesWhen, entry.scope].filter(Boolean).join(' ')));
 const id = new Set([entry.id,...words(entry.id.replace(/^(?:builtin|library)-/,''))]);
 const body = new Set(words(legacyBody));
 const phrase = phraseWords(query);
 const anchor = Math.max(0,...(entry.aliases || []).map(alias=>aliasEvidence(phrase,alias)));
 let score = 0, matches = 0, strong = 0, support = 0, format = false;
 for (const term of new Set(terms.map(stem))) {
  const tagged = tags.some(tag=>tag.has(term));
  if (titles.has(term)) { score += 12; strong++; }
  else if (tagged) { score += 8; strong++; }
  else if (id.has(term)) { score += 6; strong++; }
  else if (summary.has(term)) { score += 3; support++; }
  else if (body.has(term)) score-=2; // body-only matches contribute 1 after the coverage bonus
  else continue;
  if (formatTags.has(term) && tagged) format = true;
  matches++;
 }
 if (!anchor && !format && matches < Math.ceil(terms.length / 2) && !(strong >= 2 && support >= 1)) return -1;
 return score + matches * 3 + anchor + (format ? 25 : 0);
}

async function readSkillText(file, maxBytes = Infinity) {
 const info = await fs.lstat(file);
 if (!info.isFile() || info.size > maxBytes) throw fail('Packaged skill library file is not a regular file or exceeds its size limit.');
 const data = await fs.readFile(file);
 if (data.length > maxBytes) throw fail('Packaged skill library file changed size during read.');
 try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
 catch { throw fail('Packaged skill library file must be valid UTF-8.'); }
}

export function createSkillLibrary({ root = SKILL_LIBRARY_ROOT } = {}) {
 let pending;
 async function load() {
  if (!pending) pending = (async () => {
   let manifest;
   try { manifest = JSON.parse(await readSkillText(path.join(root, 'index.json'))); }
   catch { throw fail('Packaged skill library manifest is unavailable or invalid.'); }
   if (!plain(manifest) || manifest.version !== 1 || !Array.isArray(manifest.entries))
    throw fail('Invalid packaged skill library manifest.');
   const byId = new Map(), paths = new Set();
   for (const row of manifest.entries) {
    const p = row?.source;
    if (!plain(row) || typeof row.id !== 'string' || !libraryId.test(row.id) || byId.has(row.id)
      || !bounded(row.title, 100) || !bounded(row.description, 260)
      || row.activation !== undefined && (!Array.isArray(row.activation) || row.activation.length > 4 || new Set(row.activation).size !== row.activation.length || !row.activation.every(v=>['substantive-analysis','dependent-work','competing-interpretations','judgment','resource-allocation'].includes(v)))
      || !Array.isArray(row.tags) || row.tags.length > 12 || !row.tags.every(tag => bounded(tag, 32))
      || row.aliases !== undefined && (!Array.isArray(row.aliases) || row.aliases.length > 8 || !row.aliases.every(alias=>bounded(alias,48) && phraseWords(alias).length >= 2))
      || !plain(p) || p.kind !== 'first-party' || !bounded(p.revision, 128)
      || typeof row.bodyFile !== 'string' || !bodyName.test(row.bodyFile) || paths.has(row.bodyFile))
     throw fail('Invalid or duplicate packaged skill library entry.');
    paths.add(row.bodyFile);
    byId.set(row.id, Object.freeze({
     id: row.id, title: row.title, description: row.description, tags: Object.freeze([...row.tags]),
     aliases: Object.freeze([...(row.aliases || [])]), ...(row.activation===undefined?{}:{activation:Object.freeze([...row.activation])}), provenance: Object.freeze({kind: p.kind, revision: p.revision}),
     revision: 1, source: 'bundled', immutable: true, loaded: 'available_on_demand', bodyFile: row.bodyFile,
    }));
   }
   return byId;
  })();
  return pending;
 }
 const metadata = ({bodyFile, ...entry}) => ({...entry, tags: [...entry.tags], aliases: [...entry.aliases], provenance: {...entry.provenance}});
 return {
  async list() { return [...(await load()).values()].map(metadata); },
  async has(id) { return (await load()).has(id); },
  async metadata(id) { const row = (await load()).get(id); return row ? metadata(row) : null; },
  async read(id) {
   const row = (await load()).get(id);
   if (!row) throw fail('Release skill not found.', 404);
   let content;
   try { content = await readSkillText(path.join(root, row.bodyFile), 800000); }
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
