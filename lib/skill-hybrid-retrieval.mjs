/**
 * Local, bounded skill discovery. Source skill documents and revisioned user
 * overlays remain authoritative: FTS5 is a disposable index, never a second
 * copy of skill instructions. Semantic concept vectors bridge common task
 * paraphrases without a provider request, downloaded model or unsafe body scan.
 */
import { DatabaseSync } from 'node:sqlite';

// Constrained equivalence classes: matching a single vague word never makes a
// skill eligible. These are retrieval hints, not instructions or permissions.
const CONCEPTS = {
  browser: 'browser browsers website websites webpage webpages web site sites chromium tabs tab',
  interaction: 'navigate navigating navigation interact interaction clicking click clicks button buttons controls control filling fill forms form scrolling scroll follow',
  recovery: 'recovery recover recovering retry retries resume resuming stale refresh refreshed reconnect continuity interrupted',
  accessibility: 'accessibility accessible keyboard focus screenreader screenreaders aria',
  debugging: 'debug debugging diagnose diagnostics diagnostic troubleshooting troubleshoot trace failing failed failure failures freeze freezes crashing crash crashes',
  software: 'software app apps code coding program programs source implementation',
  comparison: 'compare comparing comparison differences diff versions change changed changes',
  document: 'document documents report reports files file text',
  pdf: 'pdf pdfs scanned scan extraction extract extractable',
  word: 'docx msword microsoftword wordprocessor wordprocessing',
  spreadsheet: 'spreadsheet spreadsheets workbook workbooks worksheet worksheets xlsx excel cells formulas',
  csv: 'csv delimited tabular rows',
  reconcile: 'reconcile reconciliation matching match mismatched duplicates duplicate deduplicate consistency',
  invoice: 'invoice invoices bills billing payable supplier suppliers',
  ledger: 'ledger bank banking transactions transaction statements statement accounts',
  chart: 'chart charts graph graphs plot plots trend trends visualizations visualize',
  diagram: 'diagram diagrams architecture flowchart flowcharts schematic schematics topology sketch sketches drawing',
  research: 'research investigate investigating inquiry investigate findings',
  employment: 'employment jobs job vacancies vacancy hiring positions position roles openings careers',
  application: 'apply applying applicant applicants applications submission submit',
  remote: 'remote telecommute telecommuting homebased wfh',
  planning: 'planning plan plans strategy strategies objectives objective milestones roadmap',
  decomposition: 'decomposition break down breakdown divide subdivide steps subtasks',
  review: 'review reviewing critique audit auditing inspection inspect assess assessing assessment',
  verification: 'verify verification validate validation confirm confirmation test testing checks check correctness correctnesses',
  handoff: 'handoff handover onboarding transfer takeover transition',
  writing: 'draft drafting write writing compose composing rewrite revising edit editing',
  completion: 'complete completion finish finishing done deliver delivered outcome outcomes',
  ongoing: 'continue continuing continuation persist persistence maintain ongoing keep working',
  relationship: 'relationship relationships connection connections movement movements dataflow flow flows',
  premature: 'premature prematurely overclosure unfinished earlystop earlystopping',
};
const COMMON = new Set('a an and are as at be been by can could do does for from had has have how i in into is it its me my of on or our please should so some than that the their there these this those through to us use using want was were what when where which while who why will with without would you your then after before any'.split(' '));
const ANCHORS = new Set('browser accessibility debugging software comparison document pdf word spreadsheet csv reconcile invoice ledger chart diagram relationship research employment application remote planning decomposition verification handoff writing completion'.split(' '));
const canonical = new Map();
for (const [concept, values] of Object.entries(CONCEPTS)) {
  for (const word of values.split(' ')) {
    if (canonical.has(word) && canonical.get(word) !== concept) throw Error('Ambiguous skill retrieval concept: '+word);
    canonical.set(word,concept);
  }
}
const tokenize = text => [...new Set(String(text || '').normalize('NFKC').toLowerCase()
  .replaceAll('-', ' ').match(/[\p{L}\p{N}]+/gu) || [])].filter(word => !COMMON.has(word));
const conceptualize = text => new Set(tokenize(text).map(token => canonical.get(token)).filter(Boolean));
const details = entry => [
  entry.title, entry.description, entry.summary, entry.appliesWhen, entry.scope,
  entry.id?.replaceAll('-', ' '), ...(entry.tags || []), ...(entry.aliases || []),
].filter(Boolean).join(' ');

/** Similarity for local meaning-based retrieval, independent of query wording.
 * A two-concept/domain-anchor threshold protects against accidental hits.
 */
export function semanticSkillScore(entry, query) {
  const wanted = conceptualize(query);
  if (wanted.size < 2) return -1;
  const present = conceptualize(details(entry));
  const overlap = [...wanted].filter(concept => present.has(concept));
  if (overlap.length < 2 || !overlap.some(concept => ANCHORS.has(concept))) return -1;
  const coverage = overlap.length / wanted.size;
  if (coverage < 0.66) return -1;
  // Title and tags are a stronger indication of domain than generic examples
  // or prose. Weight the domain concept over broad verbs such as 'review'.
  const title = conceptualize(entry.title);
  const tags = conceptualize((entry.tags||[]).join(' '));
  const titleHits = overlap.filter(concept => title.has(concept));
  const tagHits = overlap.filter(concept => tags.has(concept));
  const focused = overlap.reduce((sum,concept)=>sum + (
    concept==='review'||concept==='verification'||concept==='ongoing'?1:
    concept==='debugging'||concept==='browser'||concept==='accessibility'?3:2),0);
  return Math.round(12 + 8 * overlap.length + 22 * coverage + titleHits.length*7 + tagHits.length*2 + focused);
}

// Automatic topical activation requires a shared subject, not just shared
// generic operations (completion, review, verification, planning, recovery).
// A specialist's explicitly named subject must match the request. General
// reasoning methods have their own declared task applicability.
const SUBJECT_ANCHORS=new Set(['browser','accessibility','software','document','pdf','word','spreadsheet','csv','invoice','ledger','chart','diagram','research','employment','remote']);
export function semanticSkillTopicalMatch(entry,query){
  if(semanticSkillScore(entry,query)<50)return false;
  const wanted=conceptualize(query),present=conceptualize(details(entry));
  const shared=[...wanted].some(concept=>SUBJECT_ANCHORS.has(concept)&&present.has(concept));
  const titledSubjects=[...conceptualize(entry.title)].filter(concept=>SUBJECT_ANCHORS.has(concept));
  return shared&&titledSubjects.every(concept=>wanted.has(concept));
}

/** Optional native FTS5 acceleration and tie-breaking. No on-disk migrations,
 * provider calls or database writes: rebuilt from current effective metadata.
 */
export class SkillHybridIndex {
  #db = null;
  #fingerprint = '';
  constructor() {
    try {
      const db = new DatabaseSync(':memory:');
      db.exec("CREATE VIRTUAL TABLE skills USING fts5(id UNINDEXED, title, description, tags, aliases, tokenize='unicode61 remove_diacritics 2')");
      this.#db = db;
    } catch { this.#db = null; }
  }
  refresh(entries) {
    if (!this.#db) return;
    const fingerprint = JSON.stringify(entries.map(row => [
      row.id, row.title, row.description, row.tags, row.aliases, row.revision, row.source,
    ]));
    if (fingerprint === this.#fingerprint) return;
    try {
      this.#db.exec('BEGIN');
      this.#db.exec('DELETE FROM skills');
      const insert = this.#db.prepare('INSERT INTO skills(id,title,description,tags,aliases) VALUES (?,?,?,?,?)');
      for (const row of entries) insert.run(row.id, row.title || '', row.description || '',
        (row.tags || []).join(' '), (row.aliases || []).join(' '));
      this.#db.exec('COMMIT');
      this.#fingerprint = fingerprint;
    } catch {
      try { this.#db.exec('ROLLBACK'); } catch {}
      // Pure metadata/semantic matching remains available if FTS5 fails.
      this.close();
    }
  }
  score(query) {
    if (!this.#db) return new Map();
    const terms = tokenize(query).slice(0, 32).filter(term => term.length <= 64);
    if (!terms.length) return new Map();
    const expression = terms.map(term => '"'+term+'"').join(' OR ');
    try {
      const hits = this.#db.prepare('SELECT id FROM skills WHERE skills MATCH ? ORDER BY bm25(skills, 0, 6, 2, 4, 3), id LIMIT 10000').all(expression);
      return new Map(hits.map((row, i) => [row.id, Math.max(1, 8 - Math.floor(i / 4))]));
    } catch { return new Map(); }
  }
  close() {
    try { this.#db?.close(); } catch {}
    this.#db = null;
    this.#fingerprint = '';
  }
}

/** Preserve strong exact/alias hits; rescue paraphrases only on two or more
 * independent, domain-relevant concept matches. FTS never grants eligibility.
 */
export function hybridSkillScore(entry, query, lexicalScore, ftsBoost = 0) {
  const semantic = semanticSkillScore(entry, query);
  // A speculative concept match must not outrank strong multi-term
  // metadata evidence from a precise task query.
  if (lexicalScore < 0) return semantic < 0 ? -1 : Math.round(semantic * 0.55);
  return lexicalScore + (semantic < 0 ? 0 : Math.min(12, Math.round(semantic / 5)))
    + Math.min(8, ftsBoost);
}
