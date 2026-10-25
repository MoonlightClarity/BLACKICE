export const KNOWLEDGE_PAGE_SIZE = 80;
export const KNOWLEDGE_LIST_LIMIT = 300;
export const KNOWLEDGE_HISTORY_LIMIT = 9;

export function knowledgeListPath({kind='memory',query='',memoryType='',cwd='',deletedOnly=false}={}) {
  const params=new URLSearchParams({kind:kind==='skill'?'skill':'memory',limit:String(KNOWLEDGE_LIST_LIMIT)});
  if(query.trim())params.set('query',query.trim().slice(0,256));
  if(kind!=='skill'&&memoryType)params.set('memoryType',memoryType);
  if(cwd.trim())params.set('cwd',cwd.trim());
  if(deletedOnly)params.set('deletedOnly','true');
  return '/api/knowledge?'+params;
}

export function knowledgeWindow(items,visible=KNOWLEDGE_PAGE_SIZE) {
  const count=Math.max(KNOWLEDGE_PAGE_SIZE,Math.min(KNOWLEDGE_LIST_LIMIT,Number(visible)||KNOWLEDGE_PAGE_SIZE));
  const bounded=Array.isArray(items)?items.slice(0,KNOWLEDGE_LIST_LIMIT):[];
  return {items:bounded.slice(0,count),total:bounded.length,hasMore:bounded.length>count};
}

export function knowledgeDraft(entry=null,kind='memory') {
  const current=entry?structuredClone(entry):null;
  const values={kind:current?.kind||kind,title:String(current?.title||''),summary:String(current?.summary||''),
    content:String(current?.content||''),cwd:String(current?.cwd||''),memoryType:current?.memoryType||'note'};
  return {entry:current,values,baseline:JSON.stringify(values),historyOpen:false};
}

export function knowledgeDraftChanged(draft) {
  return Boolean(draft)&&JSON.stringify(draft.values)!==draft.baseline;
}

/** Reuse the revision that supplied the draft; list refreshes must never advance it. */
export function knowledgeSavePayload(draft) {
  if(!draft?.values)throw Error('Open an entry before saving.');
  const {values,entry}=draft;
  if(entry?.deleted)throw Error('Restore a saved revision before editing this entry.');
  const kind=entry?.kind||values.kind;
  if(!['memory','skill'].includes(kind))throw Error('Choose memories or skills.');
  const title=values.title.trim(),content=values.content,summary=values.summary.trim();
  if(!title)throw Error('Enter a title.');
  if(title.length>120)throw Error('Keep the title to 120 characters.');
  if(summary.length>400)throw Error('Keep the summary to 400 characters.');
  if(!content.trim())throw Error('Enter content before saving.');
  if(content.length>(kind==='skill'?40000:8000))throw Error('Content exceeds the '+(kind==='skill'?'40,000':'8,000')+' character limit.');
  const payload={kind,title,summary,content,cwd:values.cwd.trim()||null};
  if(entry){payload.id=entry.id;payload.expectedRevision=knowledgeExpectedRevision(entry);}
  if(kind==='memory') {
    if(!['note','fact','assumption','decision'].includes(values.memoryType))throw Error('Choose a valid memory type.');
    payload.memoryType=values.memoryType;
    // These fields have their own backend validation and may refer to unavailable entries.
    // Preserve them exactly when this workspace edits the text or folder scope.
    if(Array.isArray(entry?.sources))payload.sources=structuredClone(entry.sources);
    if(Array.isArray(entry?.relations))payload.relations=structuredClone(entry.relations);
  }
  return payload;
}

export function knowledgeExpectedRevision(entry) {
  if(!Number.isSafeInteger(entry?.revision)||entry.revision<1)throw Error('Reload the saved entry to read its current revision.');
  return entry.revision;
}

export function knowledgeHistoryRows(history) {
  return (Array.isArray(history?.history)?history.history:[])
    .filter(row=>Number.isSafeInteger(row?.revision)&&row.revision>0)
    .slice(0,KNOWLEDGE_HISTORY_LIMIT);
}

export function knowledgeRestorePayload(history,revision) {
  if(!Number.isSafeInteger(history?.currentRevision)||history.currentRevision<1)
    throw Error('Refresh history before restoring a revision.');
  if(!knowledgeHistoryRows(history).some(row=>row.revision===revision))
    throw Error('Choose a retained revision from this history.');
  return {revision,expectedRevision:history.currentRevision};
}

/** Trash recovery restores the latest retained active snapshot, never a deleted
 * state or an unguarded copy of the editor's displayed content. */
export function knowledgeRecoveryPayload(history) {
  const rows=knowledgeHistoryRows(history),current=rows.find(row=>row.revision===history?.currentRevision);
  if(!current)throw Error('Refresh history before restoring this entry.');
  if(!current.deleted)throw Error('This entry is already active. Reload the saved entry to review it.');
  const target=rows.filter(row=>!row.deleted&&row.revision<current.revision).sort((a,b)=>b.revision-a.revision)[0];
  if(!target)throw Error('No active revision is retained for this entry. Review its history before creating a new entry.');
  return knowledgeRestorePayload(history,target.revision);
}

export function knowledgeAuthor(entry) {
  return entry?.provenance?.source==='user'?'You':entry?.provenance?.source==='agent'
    ?String(entry.provenance.nodeId||'').startsWith('learning-')?'Learned':'Agent':'Saved';
}
