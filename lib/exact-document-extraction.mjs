import { createHash } from 'node:crypto';

const readable = new Set(['pdf','text','document']);
const hash = value => createHash('sha256').update(value,'utf8').digest('hex');
const normalize = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const bound = 300000;

// An explicit inline source-text request is not a request for analysis,
// rewriting, external transmission, or unrelated filesystem discovery.
export function exactDocumentTextRequest(input) {
  if (typeof input !== 'string' || input.length > 500 || /[\r\n;]/.test(input)) return null;
  const text=input.trim().replace(/[.!?]+$/,'');
  if (/\b(?:summary|summari[sz]e|rewrite|translate|explain|analy[sz]e|analysis|selected points|key points|highlights|only the (?:first|last)|and then|email|upload|post|share with)\b/i.test(text)) return null;
  const prefix='(?:(?:can|could|would)\\s+you\\s+)?(?:please\\s+)?';
  const pattern=new RegExp('^'+prefix+'(?:(?:send|give|show|provide|return)\\s+(?:me\\s+)?|extract\\s+|copy\\s+|transcribe\\s+)(?:(?:the\\s+)?(?:(?:actual|original|full|complete|exact|verbatim|raw|selectable)\\s+)*text\\s+(?:of|from|in)\\s+|(?:the\\s+)?(?:actual|original|full|complete|exact|verbatim|raw)\\s+)?(.+?)(?:\\s+(?:verbatim|word for word))?$','i');
  const match=pattern.exec(text);
  if (!match) return null;
  let target=match[1].trim().replace(/^(?:the|this|that|my|our|previous|earlier|original|attached|uploaded|following)\s+/i,'');
  target=target.replace(/^(?:the|this|that|my|our|previous|earlier|original|attached|uploaded|following)\s+/i,'');
  target=target.replace(/\s+text$/i,'').replace(/^["“]|["”]$/g,'').trim();
  // Never interpret an arbitrary "send me X" as exact text extraction.
  if (!/\b(?:text|transcribe|verbatim|word for word)\b/i.test(text) || !target || target.length>240 || /[\\/:]/.test(target)) return null;
  if (!/\b(?:resume|résumé|cv|pdf|document|attachment|report|file|source|transcript|article)\b/i.test(target) && !/\.(?:pdf|docx|txt|md|csv|json)$/i.test(target)) return null;
  return {target};
}

function candidatesFor(entries,target,run,{allowContext=false}={}) {
  const wanted=normalize(target), generic=/^(?:attached |uploaded |previous |original )?(?:document|file|attachment|source|pdf)$/i.test(target);
  if(generic) return entries.filter(e=>target.toLowerCase().endsWith('pdf')?e.kind==='pdf':true);
  if(/^(?:resume|résumé|cv)$/i.test(target)){
    const named=entries.filter(e=>/(?:^| )(?:resume|résumé|cv)(?: |$)/i.test(normalize(e.name)));
    if(named.length)return named;
    return allowContext&&entries.length===1&&/\b(?:resume|résumé|cv)\b/i.test(run.input||'')?entries:[];
  }
  if(/^(?:report|transcript|article)$/i.test(target)){
    const named=entries.filter(e=>normalize(e.name).split(' ').includes(wanted));
    return named.length?named:allowContext&&entries.length===1&&normalize(run.input).split(' ').includes(wanted)?entries:[];
  }
  return entries.filter(e=>normalize(e.name)===wanted||normalize(e.name.replace(/\.[^.]+$/,''))===wanted);
}

// Only an explicitly requested current or ancestor attachment may be read.
// Prior assistant prose is not a source. A new attachment scope takes priority.
export async function selectExactDocumentSource({request,run,getRun,store,signal}) {
  if(!request||!store)return null;
  const taskId=run.taskId||run.id,seen=new Set();
  let cursor=run, observed=false;
  for(let depth=0;cursor&&depth<64;depth++){
    signal?.throwIfAborted();
    if(seen.has(cursor.id)||(cursor.taskId||cursor.id)!==taskId)break;
    seen.add(cursor.id);
    if(cursor.attachmentIds?.length){
      observed=true;
      const entries=[];
      for(const id of [...new Set(cursor.attachmentIds)]) {
        signal?.throwIfAborted();
        try { const e=await store.get(id); if(readable.has(e.kind)) entries.push(e); } catch(cause) { signal?.throwIfAborted(); }
      }
      const matches=candidatesFor(entries,request.target,cursor,{allowContext:cursor!==run});
      const distinct=[...new Map(matches.map(e=>[e.sha256||e.id,e])).values()];
      if(distinct.length===1)return {entry:distinct[0],sourceRunId:cursor.id};
      if(distinct.length>1)return {unavailable:'More than one original attachment matches '+request.target+'. No single document was selected.',sourceRunId:cursor.id};
      if(cursor===run)return {unavailable:'No current attachment matches the requested original document.'};
    }
    cursor=cursor.parentRunId?getRun(cursor.parentRunId):null;
  }
  return observed?{unavailable:'The requested original document could not be identified in this conversation. No previous answer was used as source text.'}:null;
}
const fence = text => {
  let n=3;for(const m of text.matchAll(/[\x60]+/g))n=Math.max(n,m[0].length+1);
  const marker='\x60'.repeat(n);
  return marker+'text\n'+text+(text.endsWith('\n')?'':'\n')+marker;
};

export async function extractOriginalDocumentText({selection,store,signal,maxChars=bound}) {
  signal?.throwIfAborted();
  if(selection.unavailable)return {output:selection.unavailable,receipt:{version:1,source:'host-original-document-extraction',complete:false,status:'source-unavailable',...(selection.sourceRunId?{sourceRunId:selection.sourceRunId}:{})}};
  const {entry,sourceRunId}=selection;
  const receipt={version:1,source:'host-original-document-extraction',sourceRunId,attachmentId:entry.id,sourceSha256:entry.sha256,kind:entry.kind,modelUsed:false};
  const parts=[], gaps=[];let chars=0, complete=true;
  if(entry.kind==='pdf'){
    let page=1,start=0,calls=0;
    const pages=new Map();
    while(page!==null&&chars<maxChars&&calls++<128){
      signal?.throwIfAborted();
      const r=await store.read(entry.id,{startPage:page,startChar:start,pageCount:Math.min(20,entry.pageCount||20),charCount:Math.min(20000,maxChars-chars),signal});
      if(r.attachment?.id!==entry.id||r.attachment?.sha256!==entry.sha256||r.totalPages!==entry.pageCount||!Array.isArray(r.pages)||!r.pages.length)throw Error('Original PDF readback did not match the selected source.');
      let expectedPage=page,expectedStart=start,last;
      for(const part of r.pages){
        if(part.page!==expectedPage||part.startChar!==expectedStart||typeof part.text!=='string'||!Number.isSafeInteger(part.totalChars)||part.startChar+part.text.length>part.totalChars||part.nextChar!==(part.startChar+part.text.length<part.totalChars?part.startChar+part.text.length:null)||chars+part.text.length>maxChars)throw Error('PDF extraction returned a discontinuous or unverified range.');
        const old=pages.get(part.page)||{text:'',textAvailable:part.textAvailable};
        if(old.text.length!==part.startChar)throw Error('PDF extraction ranges do not join exactly.');
        old.text+=part.text;old.complete=part.nextChar===null;pages.set(part.page,old);chars+=part.text.length;
        last=part;
        expectedPage=part.nextChar===null?part.page+1:part.page;expectedStart=part.nextChar??0;
      }
      const wantPage=last.nextChar!==null?last.page:last.page<r.totalPages?last.page+1:null;
      const wantChar=wantPage===null?null:last.nextChar??0;
      if(r.nextPage!==wantPage||r.nextChar!==wantChar||r.nextPage===page&&r.nextChar===start)throw Error('PDF extraction cursor did not advance consistently.');
      page=r.nextPage;start=r.nextChar;
    }
    for(const [index,p]of pages){
      if(!p.textAvailable){gaps.push(index);complete=false;}
      parts.push({label:'Page '+index,text:p.text,complete:p.complete,textAvailable:p.textAvailable});
    }
    complete=complete&&page===null&&pages.size===entry.pageCount;
    Object.assign(receipt,{totalPages:entry.pageCount,returnedPages:pages.size,emptyTextPages:gaps, ...(page===null?{}:{nextPage:page,nextChar:start})});
  }else{
    const r=await store.text(entry.id,{signal});
    if(r.entry?.id!==entry.id||r.entry?.sha256!==entry.sha256||typeof r.text!=='string')throw Error('Original document readback did not match the selected source.');
    let text=r.text.slice(0,maxChars);
    if(/[\uD800-\uDBFF]$/.test(text)&&text.length<r.text.length)text=text.slice(0,-1);
    chars=text.length;complete=chars===r.text.length;
    parts.push({label:null,text,complete,textAvailable:true});
    Object.assign(receipt,{totalChars:r.text.length,...(complete?{}:{nextChar:chars})});
  }
  signal?.throwIfAborted();
  Object.assign(receipt,{complete,status:complete?'complete':'partial',returnedChars:chars,parts:parts.map(p=>({label:p.label,chars:p.text.length,sha256:hash(p.text),complete:p.complete,textAvailable:p.textAvailable}))});
  const intro=entry.kind==='pdf'?'Original PDF selectable text (page labels added; no summary or OCR).':'Original document text (no summary or rewriting).';
  const warnings=[...(!complete?['Extraction is partial; no missing text has been invented.']:[]),...(gaps.length?['No selectable text on page(s) '+gaps.join(', ')+'.']:[])];
  const output=[intro,...warnings,...parts.flatMap(p=>[...(p.label?[p.label+(p.complete?'':' (partial)')]:[]),p.textAvailable?fence(p.text):'(No selectable text.)'])].join('\n\n');
  return {output,receipt};
}
