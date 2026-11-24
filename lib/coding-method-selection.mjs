/** Select a coding method; this helper neither loads a skill nor authorizes work. */
function currentRequest(request) {
 if(typeof request!=='string')return '';
 let fence=null;
 return request.slice(0,8000).split(/\r?\n/).flatMap(line=>{
  const marker=/^\s*(\x60{3,}|~{3,})/.exec(line)?.[1][0];
  if(marker){if(!fence)fence=marker;else if(fence===marker)fence=null;return [];}
  if(fence||/^\s*>/.test(line))return [];
  // Preserve quoted filenames and an explicitly named method, not quoted commands.
  return [line.replace(/["“]([^"”\n]*)["”]/g,(_,text)=>
   /^(?:(?:blackice-|library-)?modular[ -]development(?: skill)?|[^\s]+\.(?:cjs|mjs|js|jsx|ts|tsx|py|rs|go|cpp|java|cs|rb|php|sql|sh|ps1|html|css))$/i.test(text.trim())?text:' ')];
 }).join('\n');
}
const prefix=/^(?:(?:please)\s+)?(?:(?:can|could|would|will)\s+you\s+|(?:i|we)\s+(?:want|need|would like)\s+(?:you\s+)?to\s+|help\s+(?:me|us)\s+(?:to\s+)?)?(?:please\s+)?/i;
const explicit=/^(?:use|load|read|apply|follow)\s+(?:the\s+)?(?:native\s+)?(?:blackice-|library-)?modular[ -]development(?:\s+(?:skill|method))?\b/i;
const optOut=/^(?:(?:do not|don't|never)\s+(?:use|load|read|apply|follow)|(?:avoid|skip)(?:\s+(?:using|loading|reading|applying|following))?)\s+(?:the\s+)?(?:native\s+)?(?:blackice-|library-)?modular[ -]development\b/i;
const withoutMethod=/\bwithout\s+(?:using|loading|applying)\s+(?:the\s+)?(?:native\s+)?(?:blackice-|library-)?modular[ -]development\b/i;
const action=/^(?:build|create|write|implement|refactor|debug|fix|repair|patch|extend|add|update|modify|change|edit|develop|save|complete|test|run|check|verify|inspect|read|review)\b\s+(.+)$/i;
const codeFile=/(?:^|[\/\\\s\x60"'(])[\w.-]+\.(?:cjs|mjs|js|jsx|ts|tsx|py|rs|go|c|cc|cpp|h|java|cs|rb|php|swift|kt|sql|sh|ps1|html|css|vue|svelte)\b/i;
const codeTarget=/\b(?:code(?:base)?|source\s+(?:code|files?)|scripts?|functions?|parsers?|compilers?|repositories|repository|repo|frontend|backend|APIs?|endpoints?|CLI|CommonJS|JavaScript|TypeScript|Python|Rust|Golang|React|Node\.?js|unit\s+tests?|integration\s+tests?|test\s+suite|failing\s+tests?)\b/i;
const softwareProduct=/\b(?:apps?|websites?|webpages?|web\s+pages?|(?:web|desktop|mobile|android|ios|electron)\s+applications?)\b/i;
const codeCheckCommand=/\b(?:node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|pytest|cargo\s+test|go\s+test)\b/i;
const documentTarget=/^(?:(?:my|our|a|an|the|this|that)\s+)?(?:résumé|resume|CV|cover\s+letter|job\s+application|job\s+description|application\s+form|grant\s+application|email|essay|article|report|class\s+schedule|learning\s+module)\b/i;

/** Current, unquoted task intent only. Catalog availability and delivery are separate. */
export function wantsModularDevelopmentSkill(request) {
 const text=currentRequest(request);
 if(!text.trim())return false;
 let requested=null,coding=false;
 for(const clause of text.split(/(?:[.!?;]\s+|\n+)/)){
  const current=clause.trim().replace(/^(?:[-*]|\d+[.)])\s+/,'').replace(prefix,'');
  if(optOut.test(current)||withoutMethod.test(current)){requested=false;continue;}
  if(explicit.test(current)){requested=true;continue;}
  const match=action.exec(current);
  if(!match)continue;
  const target=match[1];
  const file=codeFile.test(target),product=softwareProduct.test(target);
  // Applying for a coding job is not implementation. A tracker app or source file is.
  if(documentTarget.test(target)&&!file&&!product)continue;
  if(file||product||codeTarget.test(target)||codeCheckCommand.test(target)
    ||/\b[A-Za-z_$][\w$]*\s*\([^()\n]*\)/.test(target)
    ||/\bimplementation\b[^.!?\n]{0,60}\bsrc\b/i.test(target))coding=true;
 }
 return requested??coding;
}
