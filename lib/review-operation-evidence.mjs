// This projection relates only actual, admitted, host tool receipts. It does
// not create task obligations, execute the offered call, or certify a verdict.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pageable=new Set(['relay_workspace','relay_find_files','relay_browser','relay_history','relay_agents','relay_files','relay_directory_action']);
const integer=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const canonicalItem=item=>{
  if(item?.type!=='inputText'||typeof item.text!=='string')return null;
  try{const value=JSON.parse(item.text);return object(value)&&JSON.stringify(value)===item.text?value:null;}catch{return null;}
};
const argsOf=row=>object(row.arguments)?row.arguments:null;
const admitted=row=>row.source==='admitted-tool-delivery'&&typeof row.id==='string'&&row.id===row.callId&&!row.namespace&&row.success===true;
const exactKeys=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
function validPage(page,archive){
  return object(page)&&page.reference===archive.reference&&page.tool===archive.tool&&page.bytes===archive.bytes&&
    integer(page.offset,0,archive.bytes)&&integer(page.nextOffset,page.offset,archive.bytes)&&
    typeof page.text==='string'&&Buffer.byteLength(page.text,'utf8')===page.nextOffset-page.offset&&
    page.complete===(page.nextOffset===archive.bytes);
}
function validMatchTemplate(template,archive,page){
  const args=template?.arguments;
  return exactKeys(template,['tool','arguments'])&&template.tool==='relay_context_page'&&
    exactKeys(args,['action','reference','offset','maxBytes'])&&args.action==='read'&&
    args.reference===archive.reference&&args.offset===page.offset&&integer(args.maxBytes,512,8192)&&
    args.maxBytes>=page.nextOffset-page.offset;
}
function sameMatchText(read,match,needle){
  if(read.offset!==match.offset)return false;
  const a=Buffer.from(read.text,'utf8'),b=Buffer.from(match.text,'utf8'),n=Math.min(a.length,b.length);
  return n>=Buffer.byteLength(needle,'utf8')&&a.subarray(0,n).equals(b.subarray(0,n));
}
/** Compact links between an exposed archive, a delivered literal search, and
 * a distinct delivered page read. Never interpret source text as operations.
 * An absent link means not observed in THIS admitted view, not proof of
 * nonexecution, and never means the user required that operation.
 */
export function projectReviewOperationEvidence(snapshot,referenceIndex){
  const rows=snapshot.evidence?.records||[];
  if(!Array.isArray(rows)||referenceIndex.length!==rows.length)return undefined;
  const counts=new Map();
  for(const row of rows)counts.set(row.id,(counts.get(row.id)||0)+1);
  const archives=new Map(),ambiguous=new Set(),exposed=new Set();
  for(let i=0;i<rows.length;i++){
    const row=rows[i],citation=referenceIndex[i];
    if(!admitted(row)||counts.get(row.id)!==1||citation?.evidenceId!==row.id||typeof citation.citationRef!=='string')continue;
    const args=argsOf(row),items=row.result?.contentItems;
    if(!args||args.action!==row.action||!Array.isArray(items))continue;
    if(pageable.has(row.tool)){
      for(let itemIndex=0;itemIndex<items.length;itemIndex++){
        const ptr=canonicalItem(items[itemIndex]);
        if(!ptr||ptr.externalContext!==true||!uuid.test(ptr.reference||'')||!integer(ptr.bytes)||
           ptr.tool!==row.tool||ptr.contentIndex!==itemIndex||
           ptr.searchCallTemplate?.tool!=='relay_context_page'||
           ptr.searchCallTemplate?.arguments?.action!=='search'||
           ptr.searchCallTemplate?.arguments?.reference!==ptr.reference)continue;
        const existing=archives.get(ptr.reference);
        if(existing&&(existing.bytes!==ptr.bytes||existing.tool!==row.tool)){
          ambiguous.add(ptr.reference);continue;
        }
        const archive=existing||{reference:ptr.reference,tool:row.tool,bytes:ptr.bytes,sources:[],searches:[],reads:[]};
        archive.sources.push({receipt:citation.citationRef,action:row.action,
          ...(typeof args.path==='string'?{requestedPath:args.path}:{}),
          ...(integer(args.startLine,1)?{requestedStartLine:args.startLine}:{}),
          ...(integer(args.lineCount,1)?{requestedLineCount:args.lineCount}:{}),
          ...(ptr.preview?.truncated===true?{originalSourceTruncated:true}:{}),
          ...(integer(ptr.preview?.startLine,1)&&integer(ptr.preview?.endLine,ptr.preview.startLine)?
            {returnedSourceLines:[ptr.preview.startLine,ptr.preview.endLine]}:{}),
          ...(integer(ptr.preview?.nextStartLine,1)?{nextSourceLine:ptr.preview.nextStartLine}:{})});
        archives.set(ptr.reference,archive);exposed.add(ptr.reference);
      }
      continue;
    }
    if(row.tool!=='relay_context_page'||!['search','read'].includes(row.action))continue;
    // A single-result receipt is the native archive reader's shape. Resolve
    // an omitted reference only when a unique source was already exposed.
    const reference=args.reference===undefined&&exposed.size===1?[...exposed][0]:args.reference;
    const archive=archives.get(reference);
    if(!archive||ambiguous.has(reference)||items.length!==1)continue;
    const data=canonicalItem(items[0]);
    if(!data||data.reference!==reference||data.bytes!==archive.bytes)continue;
    if(row.action==='read'){
      if(!validPage(data,archive)||data.offset!==(args.offset??0)||
        (args.maxBytes!==undefined&&(!integer(args.maxBytes,512,8192)||data.nextOffset-data.offset>args.maxBytes)))continue;
      const read={receipt:citation.citationRef,index:i,page:data};
      archive.reads.push(read);continue;
    }
    const needle=args.needle;
    if(typeof needle!=='string'||!needle||data.needle!==needle||data.startOffset!==(args.startOffset??0)||
       !integer(data.startOffset,0,archive.bytes)||typeof data.complete!=='boolean'||
       !integer(data.scannedBytes,0,archive.bytes-data.startOffset)||
       !Array.isArray(data.matches)||!data.matches.every((match,j)=>object(match)&&integer(match.offset,data.startOffset,archive.bytes-Buffer.byteLength(needle,'utf8'))&&
         (j===0||match.offset>data.matches[j-1].offset)))continue;
    // A complete search covers the returned archive, not unreturned source.
    if(data.complete&&(data.nextScanOffset!==null||data.scannedBytes!==archive.bytes-data.startOffset))continue;
    const first=data.firstMatchEvidence;
    if(data.matches.length&&(!validPage(first,archive)||first.offset!==data.matches[0].offset||!first.text.startsWith(needle)))continue;
    const search={receipt:citation.citationRef,index:i,data,first:data.matches.length?first:null};
    archive.searches.push(search);
  }
  const chains=[];
  for(const archive of archives.values()){
    if(ambiguous.has(archive.reference))continue;
    const searches=archive.searches.map(search=>{
      const {data,first}=search;
      const row={receipt:search.receipt,action:'search',needle:data.needle,
        startOffset:data.startOffset,scanComplete:data.complete,matchedOffsets:data.matches.map(m=>m.offset),
        result:data.matches.length?'literal-match-returned':'no-match-returned'};
      if(first){
        const reads=archive.reads.filter(r=>r.index>search.index&&sameMatchText(r.page,first,data.needle));
        row.firstMatch={offset:first.offset,nextOffset:first.nextOffset,text:first.text,
          provenance:'exact passage returned by search, not a distinct read call'};
        row.separateReadAfterSearchAtFirstMatch={state:reads.length?'observed':'not-observed-in-admitted-view',
          receipts:reads.map(r=>r.receipt)};
        if(!reads.length&&validMatchTemplate(data.matchedReadCallTemplate,archive,first))
          row.availableReadCall=data.matchedReadCallTemplate;
      }
      return row;
    });
    chains.push({archiveReference:archive.reference,sourceTool:archive.tool,capturedBytes:archive.bytes,
      sourceReceipts:archive.sources,searches,
      separateReadReceipts:archive.reads.map(r=>({receipt:r.receipt,offset:r.page.offset,nextOffset:r.page.nextOffset}))});
  }
  if(!chains.length)return undefined;
  return {source:'host-linked-admitted-operation-receipts',scope:'admitted-inline-view-only',
    meaning:'Observed source, search and read relationships, not new user requirements or approval. Not-observed does not establish nonexecution. A separate read is required only when the actual request requires it.',
    archives:chains};
}
