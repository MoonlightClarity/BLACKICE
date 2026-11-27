/** Pure projection of a skill document for catalog discovery and indexed storage. */
export function skillDocumentTitle(content){
 let fence;
 for(const line of content.split(/\r?\n/)){
  const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if(fence){
   if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=undefined;
   continue;
  }
  if(marker){fence=marker[1];continue;}
  const heading=/^ {0,3}#[ \t]+(.+)$/.exec(line)?.[1]?.trim();
  const title=heading?.replace(/(?:^|[ \t]+)#+[ \t]*$/,'').trim();
  if(title)return title;
 }
 return null;
}

const ACTIVATION = new Set(['substantive-analysis','dependent-work','competing-interpretations','judgment','resource-allocation']);
export function skillApplicability(content,base={}){
 const text=typeof content==='string'?content.replace(/^\uFEFF/,''):'';
 const match=/^---[ \t]*\r?\n([\s\S]{0,8192}?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
 const fields={};
 if(match)for(const line of match[1].split(/\r?\n/)){
  const m=/^(activation|applies_to|does_not_apply_to|scope|description):[ \t]*(.*)$/.exec(line);
  if(m&&!Object.hasOwn(fields,m[1]))fields[m[1]]=m[2].slice(0,500);
 }
 const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
 const body=match?text.slice(match[0].length):text;
 const intro=body.replace(/^\s*#[ \t]+[^\r\n]+[\r\n]+/,'').trim().split(/\r?\n\s*\r?\n|\r?\n\s*#{1,6}\s/)[0]?.trim();
 const declared=Object.hasOwn(fields,'activation')||Array.isArray(base.activation);
 const activation=[...new Set((Object.hasOwn(fields,'activation')?fields.activation.replace(/^\[|\]$/g,'').split(',').map(v=>v.trim()):base.activation||[]).filter(v=>ACTIVATION.has(v)))];
 const description=clean(fields.description||fields.applies_to||(!/^(?:#|[-*]\s|\x60{3}|~{3}|>)/.test(intro||'')?intro:'')||base.description||base.summary||base.appliesWhen).slice(0,260);
 return {description,activation,activationDeclared:declared,appliesWhen:clean(fields.applies_to||base.appliesWhen).slice(0,500),scope:clean(fields.scope||base.scope).slice(0,500),exclusions:clean(fields.does_not_apply_to).slice(0,500)};
}
