// One-off source transform for the isolated Directory experiment.
// Require every exact preimage so this cannot silently target an evolved source.
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
function edit(name,changes){
 const full=path.join(root,name);
 let s=fs.readFileSync(full,'utf8');
 for(const [from,to] of changes){
  if(typeof from==='string'){
   const at=s.indexOf(from);
   if(at<0)throw Error(name+': missing preimage '+from.slice(0,80));
   if(s.indexOf(from,at+from.length)>=0)throw Error(name+': duplicated preimage '+from.slice(0,80));
   s=s.slice(0,at)+to+s.slice(at+from.length);
  }else{
   const matches=[...s.matchAll(from)];
   if(matches.length!==to.expected)throw Error(name+': expected '+to.expected+' for '+from+'; got '+matches.length);
   s=s.replace(from,to.value);
  }
 }
 fs.writeFileSync(full,s);
 console.log('UPDATED',name);
}
edit('lib/task-external-context.mjs',[
 ['const MAX_PAGE_BYTES = 8192;\n',''],
 ["description: 'Read task-owned text from a previous large tool result. To find exact text, call search with reference and needle, then read using the match offset. Read does not accept needle. A sourceContinuation cursor refers to source bytes beyond the archived returned page, not a search of that archive. This only reads the current task.',",
  "description: 'Search or page exact task-owned archived text by reference. A read page can be as large as actual available model context; the archive itself is not token capped. Search a target phrase first, then read its matching byte offset. SourceContinuation refers to source beyond the returned archive, not an archive search. This only reads the current task.'"],
 ["maxBytes: { type: 'integer', minimum: 512, maximum: MAX_PAGE_BYTES },",
  "maxBytes: { type: 'integer', minimum: 1, description: 'Optional returned UTF-8 bytes, bounded by actual source size and provider context instead of a fixed Directory page ceiling.' },"],
 ["limit: { type: 'integer', minimum: 1, maximum: 20 },",
  "limit: { type: 'integer', minimum: 1, description: 'Optional number of matches or listed references to return; continue by cursor as needed.' },"],
 ["needle: { type: 'string', minLength: 1, maxLength: 200, description: 'For action search only: exact text to locate. Do not add needle to a read call.' },",
  "needle: { type: 'string', minLength: 1, description: 'For action search only: exact text to locate. Do not add needle to a read call.' },"],
 ["function integer(value, fallback, lower, upper) {\n  if (value === undefined) return fallback;\n  if (!Number.isSafeInteger(value) || value < lower || value > upper) throw error('Invalid context page limit or offset.');",
  "function integer(value, fallback, lower) {\n  if (value === undefined) return fallback;\n  if (!Number.isSafeInteger(value) || value < lower) throw error('Invalid context page limit or offset.');"],
 ["const start = integer(offset, 0, 0, metadata.bytes);","const start = integer(offset, 0, 0);\n    if(start>metadata.bytes)throw error('Context offset is beyond the archived source.');"],
 ["const requested = integer(maxBytes, DEFAULT_PAGE_BYTES, 512, MAX_PAGE_BYTES);","const requested = integer(maxBytes, DEFAULT_PAGE_BYTES, 1);"],
 ["const capacity = Math.min(requested + 4, stat.size - start);","const capacity = Math.min(requested + 4, stat.size - start);"],
 ["if (typeof needle !== 'string' || !needle.length || needle.length > 200) throw error('Supply a short, nonempty literal search needle.');",
  "if (typeof needle !== 'string' || !needle.length) throw error('Supply a nonempty literal search needle.');"],
 ["const from = integer(startOffset, 0, 0, metadata.bytes);",
  "const from = integer(startOffset, 0, 0);\n    if(from>metadata.bytes)throw error('Search offset is beyond the archived source.');"],
 ["const wanted = integer(limit, 8, 1, 20);","const wanted = integer(limit, 8, 1);"],
 ["      const scanBudget = 8 * 1024 * 1024;\n",""],
 ["while (position < metadata.bytes && scanned < scanBudget && matches.length < wanted)",
  "while (position < metadata.bytes && matches.length < wanted)"],
 ["const count = Math.min(64 * 1024, metadata.bytes - position, scanBudget - scanned);",
  "const count = Math.min(64 * 1024, metadata.bytes - position);"],
 ["const nextScanOffset = complete ? null : matches.length === wanted",
  "const nextScanOffset = complete ? null : matches.length === wanted"],
 ["const count = integer(limit, 10, 1, 20);","const count = integer(limit, 10, 1);"],
]);
edit('lib/directory-done-checklist.mjs',[
 ["const key = /^[a-zA-Z0-9_-]{1,48}$/;","const key = /^[a-zA-Z0-9_-]+$/;"],
 [/maxItems:24,/g,{expected:2,value:''}],
 [/maxLength:320,/g,{expected:2,value:''}],
 ["if (!Array.isArray(items)||items.length<1||items.length>24) throw invalid('Provide 1–24 completion checks.');",
  "if (!Array.isArray(items)||items.length<1) throw invalid('Provide one or more completion checks.');"],
 ["||item.check.length>320",""],
 ["||item.requestQuote.length>320",""],
 ["||seen.size>=8",""],
 ["Checklist parents must exist, with no cycles and at most 8 levels.","Checklist parents must exist and must not form cycles."],
 ["||drop.length>24",""],
 ["||reason.length>1200",""],
 ["||alternatives.length>8",""],
 ["||value.length>320",""],
 ["if(!Array.isArray(submitted)||submitted.length>24) throw invalid('Supply up to 24 leaf check results.');",
  "if(!Array.isArray(submitted)) throw invalid('Supply an array of leaf check results.');"],
]);
edit('lib/task-action-directory.mjs',[
 ["// Keep host receipts durable while the provider receives a bounded view.\nexport const ACTION_DIRECTORY_MAX_RECEIPTS=8192;\n",
  "// Preserve every admitted receipt; model-context projection is separate from durable history.\n"],
 ["const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);",
  "const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value);"],
 ["const text=(value,max=1200)=>typeof value==='string'&&value.trim()&&value.length<=max;",
  "const text=value=>typeof value==='string'&&Boolean(value.trim());"],
 ["const checkIdSchema={type:'string',minLength:1,maxLength:48,pattern:'^[A-Za-z0-9_-]+$',description:'Short ID using only letters, digits, underscore or hyphen; for example fully_remote.'};",
  "const checkIdSchema={type:'string',minLength:1,pattern:'^[A-Za-z0-9_-]+$',description:'ID using only letters, digits, underscore or hyphen; for example fully_remote.'};"],
 ["const maxQualifyingRows=16,maxRequiredChecks=8;\n",""],
 ["const boundedKey=value=>id(value)&&value.length<=48;","const boundedKey=value=>id(value);"],
 ["if(!Number.isInteger(value.minQualifyingCount)||value.minQualifyingCount<1||value.minQualifyingCount>maxQualifyingRows)",
  "if(!Number.isSafeInteger(value.minQualifyingCount)||value.minQualifyingCount<1)"],
 ["if(!Array.isArray(value.requiredChecks)||value.requiredChecks.length<1||value.requiredChecks.length>maxRequiredChecks)",
  "if(!Array.isArray(value.requiredChecks)||value.requiredChecks.length<1)"],
 ["'count-range':'Set qualifying.minQualifyingCount to an integer from 1 to 16.'",
  "'count-range':'Set qualifying.minQualifyingCount to a positive safe integer.'"],
 ["'check-count':'Set qualifying.requiredChecks to an array of 1 to 8 hard-condition IDs.'",
  "'check-count':'Set qualifying.requiredChecks to a nonempty array of hard-condition IDs.'"],
 ["'check-id':'Use 1-48 letters, digits, underscores, or hyphens per qualifying.requiredChecks ID (example: fully_remote).'",
  "'check-id':'Use letters, digits, underscores, or hyphens per qualifying.requiredChecks ID (example: fully_remote).'"],
 ["if(typeof locator!=='string'||!locator.trim()||locator.length>8192)return null;",
  "if(typeof locator!=='string'||!locator.trim())return null;"],
 ["if(!Array.isArray(scope)||scope.length<1||scope.length>24)return null;",
  "if(!Array.isArray(scope)||scope.length<1)return null;"],
 ["if(typeof encoded!=='string'||encoded.length>1024*1024)return null;",
  "if(typeof encoded!=='string')return null;"],
 ["if(!Array.isArray(rows)||!rows.length||rows.length>maxQualifyingRows)reject('Supply 1-'+maxQualifyingRows+' candidate rows for the declared verification contract.');",
  "if(!Array.isArray(rows)||!rows.length)reject('Supply at least one candidate row for the declared verification contract.');"],
 [/maxItems:(?!0\b)\d+,/g,{expected:10,value:''}],
 [/maxLength:\d+,?/g,{expected:6,value:''}],
 ["||snapshot.actions.length>24",""],
 ["||snapshot.receipts.length>ACTION_DIRECTORY_MAX_RECEIPTS",""],
 ["if(!Array.isArray(input.actions)||!input.actions.length||input.actions.length>24)throw fail('DIRECTORY_PLAN','Use 1–24 concrete actions.');",
  "if(!Array.isArray(input.actions)||!input.actions.length)throw fail('DIRECTORY_PLAN','Use a nonempty list of concrete actions.');"],
 ["||a.dependsOn.length>24",""],
 ["||a.sourceRefs.length>32",""],
 ["if(combined.length>24)throw fail('DIRECTORY_PLAN','The outline can hold 24 actions including recorded work. Keep the next steps focused.');",""],
 ["if(history.length>=24)throw doneChecklistError('The checklist revision limit was reached; preserve this action and plan a separate next action if needed.');",""],
 ["||input.receipts.length>32",""],
 ["if(notes.length>=24||cited.every(r=>used.has(r.id)))",
  "if(cited.every(r=>used.has(r.id)))"],
 ["if(!Array.isArray(refs)||refs.length>32)throw fail('DIRECTORY_BLOCKER','Cite at most 32 exact receipts for the checks you made.');",
  "if(!Array.isArray(refs))throw fail('DIRECTORY_BLOCKER','Supply exact receipt references for the checks you made.');"],
 ["if(s.receipts.length>=ACTION_DIRECTORY_MAX_RECEIPTS)reject('DIRECTORY_CAPACITY','The durable host receipt ledger reached its bounded storage limit; preserve evidence and resolve this task rather than discarding receipts.');",""],
]);
