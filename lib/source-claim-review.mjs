// Narrow host diagnostics for claims about a supplied source.
// A literal hit never establishes semantic entailment; flag candidates for
// inspection, not "verified" facts or proof of analytical task completion.
const ws=value=>String(value||'').replace(/[\u200b-\u200d\uFEFF]/g,'').replace(/\s+/g,' ').trim();
const norm=value=>ws(value).toLocaleLowerCase('en-US').replace(/[“”„‟]/g,'"').replace(/[‘’]/g,"'").replace(/[‐‑‒–—]/g,'-');
const keyTokens=value=>(norm(value).match(/[\p{L}\p{N}]+/gu)||[]);
const stop=new Set(['the','a','an','any','of','to','for','in','on','by','from','with','and','or','that','which','are','is','were','be','being','this','these','it','its','their','such','very','specific','actual','real','examples','evidence','available','visible','documented','mentioned','reported','given','including','include','provided','provides','provide','found','present','shown','clear','explicit','new','other','additional','link','links','example','examples']);
const qualifying=new Set(['external','independent','verified','public','published','validated','proven','certified','measurable','production','scale','scaled','successful','formal','long','term','sustained','demonstrated','credible','direct','reliable','reliability','trustworthy','independently']);
const maxFlags=12;
const wordBoundary=(text,token)=>new RegExp('(?<![\\p{L}\\p{N}])'+token+'(?:s|es)?(?![\\p{L}\\p{N}])','iu').test(text);
function positiveMention(unit, token){
 const text=norm(unit.text),re=new RegExp('(?<![\\p{L}\\p{N}])'+token+'(?:s|es)?(?![\\p{L}\\p{N}])','giu');
 for(const match of text.matchAll(re)){
  const preceding=text.slice(0,match.index);
  // A qualifying source absence can span more than five words (for
  // example, "no independent production benchmarks for system latency").
  // Check the current clause, not an arbitrary nearest-word window.
  const boundary=Math.max(preceding.lastIndexOf('. '),preceding.lastIndexOf('! '),preceding.lastIndexOf('? '),preceding.lastIndexOf('; '),preceding.lastIndexOf('\n'));
  const clause=preceding.slice(boundary+1).split(/\b(?:but|however|whereas)\b/iu).at(-1);
  if(/\b(?:no|without|lacks?|not|missing|absence\s+of)\b/iu.test(clause))continue;
  return true;
 }
 return false;
}
function splitStatements(answer){
 return String(answer).replace(/\r\n?/g,'\n').split(/\n+|(?<=[.!?])\s+(?=[A-Z“"‘])/u).map(ws).filter(Boolean);
}
function phraseCandidates(statement){
 // Conservative scope: only unambiguous syntactic claims of source absence.
 // Do not parse all negative sentences or infer that a source is complete.
 const p=/\b(?:there (?:is|are) no|contains? no|provides? no|no|without|lacks?|missing|does(?:n['’]t| not) (?:include|mention|provide|list|report))\s+((?:[\p{L}\d][\p{L}\d'-]*[ \t]*){1,10})/giu;
 const candidates=[];
 for(const match of statement.matchAll(p)){
  const prior=statement.slice(Math.max(0,match.index-8),match.index);
  if(/\bnot\s*$/i.test(prior))continue;
  let phrase=match[1].replace(/\b(?:but|although|whereas|because|which|while|however|rather|or|and)\b.*$/iu,'').trim();
  const words=keyTokens(phrase);
  // Qualifier words often change the proposition: a project can exist
  // without being independently verified, shipped, or formally published.
  if(!words.length||words.some(w=>qualifying.has(w)))continue;
  const targets=words.filter(w=>w.length>=4&&!stop.has(w)).slice(0,5);
  if(targets.length)candidates.push({phrase,targets});
 }
 return candidates;
}
export function reviewSourceClaims({answer,units,max=maxFlags}={}){
 if(typeof answer!=='string'||!Array.isArray(units)||!units.length)return {version:1,status:'unavailable',reason:'source-or-answer-unavailable',flags:[],checked:0,semanticVerification:'not-established'};
 const valid=units.filter(u=>Number.isInteger(u?.id)&&typeof u.text==='string'&&u.text.trim());
 if(!valid.length)return {version:1,status:'unavailable',reason:'source-text-unavailable',flags:[],checked:0,semanticVerification:'not-established'};
 const statements=splitStatements(answer),sourceText=norm(valid.map(u=>u.text).join(' ')),flags=[];
 const recorded=new Set();
 for(const statement of statements){
  for(const c of phraseCandidates(statement)){
   const matches=valid.filter(u=>c.targets.every(token=>wordBoundary(norm(u.text),token)&&positiveMention(u,token))).slice(0,5);
   if(matches.length){
    const signature=JSON.stringify(['absence',statement,c.phrase]);if(recorded.has(signature))continue;
    recorded.add(signature);
    flags.push({kind:'possible-absence-conflict',statement:statement.slice(0,350),target:c.phrase.slice(0,120),sourceRefs:matches.map(u=>u.id),reason:'Literal target terms occur in supplied source outside an obvious nearby negation. This does not establish semantic contradiction.',status:'candidate-review-only'});
   }
  }
  // Only check explicit quotation delimiters. Quoted labels/short concepts
  // are not automatically claims of verbatim source quotation.
  const quotePattern=/[“"]([^”"\n]{16,500})[”"]/gu;
  for(const q of statement.matchAll(quotePattern)){
   const literal=norm(q[1]);
   if(literal.length<16||sourceText.includes(literal))continue;
   const signature=JSON.stringify(['quote',literal]);if(recorded.has(signature))continue;
   recorded.add(signature);
   flags.push({kind:'unmatched-literal-quotation',statement:statement.slice(0,350),quote:ws(q[1]).slice(0,350),sourceRefs:[],reason:'Quotation text is not found verbatim after whitespace and typography normalization. A paraphrase may be intended; inspect the attribution.',status:'candidate-review-only'});
  }
  if(flags.length>=max)break;
 }
 return {version:1,status:'inspected',sourceUnits:valid.length,checked:statements.length,flags:flags.slice(0,max),semanticVerification:'not-established'};
}
