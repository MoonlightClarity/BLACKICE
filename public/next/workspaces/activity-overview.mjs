import { escapeHTML as escape } from '../core/dom.mjs';
import { activityStatus,activityEvidenceStatus,activityKey,activityErrorText,activityTimestamp,activityDuration,activityListPath,activityDetailPath,activityEventRelevant } from './activity-model.mjs';

const PAGE = 40, EVIDENCE_PAGE = 50;
const message = error => String(error?.message || error || 'The activity could not be loaded.');
const bounded = (value, limit=20000) => String(value ?? '').slice(0,limit);

/** A bounded, read-only view of existing runs and direct tool receipts. */
export function createActivityOverview({mount,api,events,notify=()=>{},onNavigate=()=>{},onInspectWorkflow=()=>{}} = {}) {
  mount.classList.add('next-activity-overview');
  mount.innerHTML = [
    '<div class="ac-summary" role="group" aria-label="Filter activity by status">',
    ...[['all','All activity'],['active','Running'],['attention','Needs attention'],['finished','Finished']].map(([key,label])=>'<button type="button" data-ac-filter="'+key+'" aria-pressed="'+(key==='all')+'"><strong data-ac-count="'+key+'">—</strong><span>'+label+'</span></button>'),
    '</div><div class="ac-toolbar">',
    '<label class="next-label">Activity source<select id="ac-source" class="next-field"><option value="runs">Runs</option><option value="tools">Direct tool actions</option><option value="all">Runs and tool actions</option></select></label>',
    '<label class="next-label ac-search">Search activity<input id="ac-query" class="next-field" type="search" maxlength="200" placeholder="Title, ID, tool, or error" autocomplete="off"></label>',
    '<button type="button" id="ac-clear" hidden>Clear filters</button><button type="button" id="ac-refresh">Refresh</button></div>',
    '<div class="ac-feedback-line"><p id="ac-feedback" class="next-help" role="status" aria-live="polite">Activity loads when this view opens.</p><span id="ac-updated" class="next-help"></span></div>',
    '<p id="ac-warning" class="ac-warning" role="status" hidden></p>',
    '<div class="ac-layout"><section class="ac-feed" aria-label="Activity records">',
    '<div id="ac-empty" class="ac-empty" hidden></div><ul id="ac-list" class="ac-list" aria-label="Activity records"></ul>',
    '<nav class="ac-pagination" aria-label="Activity pages"><button type="button" id="ac-page-prev" disabled>Previous</button><span id="ac-page-label" class="next-help"></span><button type="button" id="ac-page-next" disabled>Next</button></nav>',
    '</section><section id="ac-detail" class="ac-detail" aria-labelledby="ac-detail-title">',
    '<header class="ac-detail-head"><h2 id="ac-detail-title" tabindex="-1">Select an activity</h2><button id="ac-detail-close" type="button" hidden aria-label="Close activity details">Close</button></header>',
    '<div class="ac-detail-actions"><button id="ac-open-chat" type="button" hidden>Open in Chat</button><button id="ac-open-workflow" type="button" hidden>Inspect workflow</button><button id="ac-detail-refresh" type="button" hidden>Refresh evidence</button></div>',
    '<p id="ac-detail-feedback" class="next-help" role="status"></p><div id="ac-detail-body"><p class="ac-empty">Choose a record to inspect its status, output, and retained evidence.</p></div>',
    '</section></div>',
  ].join('');
  const $ = id => mount.querySelector('#'+id);
  const ui = Object.fromEntries(['source','query','clear','refresh','feedback','updated','warning','list','empty','page-prev','page-next','page-label','detail','detail-title','detail-close','detail-refresh','open-chat','open-workflow','detail-feedback','detail-body'].map(key=>[key,$('ac-'+key)]));
  let active=false,destroyed=false,data=null,detail=null,selected=null;
  let source='runs',status='all',query='',offset=0,evidenceOffset=0;
  let listController=null,detailController=null,listEpoch=0,detailEpoch=0;
  let unsubscribe=null,eventTimer=null,searchTimer=null,pollTimer=null;
  let listBusy=false,detailBusy=false,listError='',detailError='',dirty=false,lastDetailMarkup='';
  let listEventVersion=0,detailEventVersion=0,listNeedsRefresh=false,detailNeedsRefresh=false;
  const rows = new Map();
  const filters = [...mount.querySelectorAll('[data-ac-filter]')];
  const counts = [...mount.querySelectorAll('[data-ac-count]')];
  const read = (path, signal) => api(path,'GET',undefined,{signal,deadlineMs:30000});

  function updateControls() {
    for (const button of filters) button.setAttribute('aria-pressed',String(button.dataset.acFilter===status));
    for (const count of counts) count.textContent=data ? String(data.counts?.[count.dataset.acCount] ?? '—') : '—';
    ui.clear.hidden=source==='runs' && status==='all' && !query;
    ui.refresh.disabled=listBusy;
    ui.refresh.textContent=listBusy?'Refreshing…':'Refresh';
    ui.list.setAttribute('aria-busy',String(listBusy));
    ui['page-prev'].disabled=listBusy || offset===0;
    ui['page-next'].disabled=listBusy || data?.nextOffset == null;
    const total=Number(data?.total)||0, shown=data?.items?.length||0, displayedOffset=Number(data?.offset)||0;
    ui['page-label'].textContent=data ? (shown ? (displayedOffset+1)+'–'+(displayedOffset+shown)+' of '+total : '0 records') : '';
    const note=listError ? 'Could not load activity. '+listError+(data?' Showing the last loaded records.':'') : listBusy && !data ? 'Loading activity…' : dirty && offset>0 ? 'New activity is available. Refresh to return to the latest page.' : data ? (total===0?'No matching activity.':total+' matching '+(total===1?'record.':'records.')) : 'Activity loads when this view opens.';
    if(ui.feedback.textContent!==note)ui.feedback.textContent=note;
    ui.feedback.dataset.error=String(Boolean(listError));
    ui.updated.textContent=data?.generatedAt?'Updated '+activityTimestamp(data.generatedAt):'';
    const warnings=Object.entries(data?.sources||{}).filter(([kind,value])=>(value?.available===false||value?.warning) && (source==='all'||source===kind)).map(([kind,value])=>(kind==='runs'?'Runs':'Direct actions')+': '+activityErrorText(value.warning||value.error||'Source unavailable.'));
    ui.warning.textContent=warnings.join(' ');ui.warning.hidden=!warnings.length;
    const showEmpty=!data?.items?.length;
    ui.empty.hidden=!showEmpty;
    if(showEmpty) {
      ui.empty.textContent=listBusy&&!data?'Loading saved activity…':listError&&!data?'Activity could not load. Use Refresh to try again.':warnings.length?'The activity source is incomplete or unavailable. Refresh to check again.':query||status!=='all'?'No records match these filters. Clear filters to see recent work.':source==='tools'?'No direct tool actions have been recorded.':'No runs have been recorded yet. New runs will appear here.';
    }
  }
  function rowMarkup(item) {
    const state=activityStatus(item),duration=activityDuration(item),error=activityErrorText(item.error);
    return '<span class="ac-row-top"><strong>'+escape(bounded(item.title||item.tool||'Untitled activity',240))+'</strong><span class="ac-status" data-tone="'+state.tone+'" title="'+escape(state.description)+'">'+escape(state.label)+'</span></span>'+
      '<span class="ac-row-meta"><span>'+(item.kind==='tools'?'Tool action':'Run')+(item.tool?' · '+escape(bounded(item.tool,80)):'')+'</span><time datetime="'+escape(item.updatedAt||item.createdAt||'')+'">'+escape(activityTimestamp(item.updatedAt||item.createdAt))+'</time>'+(duration?'<span>'+escape(duration)+'</span>':'')+'</span>'+
      (error?'<span class="ac-row-error">'+escape(bounded(error,220))+'</span>':item.toolCounts?.unresolved>0?'<span class="ac-row-error">'+Number(item.toolCounts.unresolved)+' tool '+(item.toolCounts.unresolved===1?'failure':'failures')+' without a resolution receipt'+'</span>':'')+
      '<span class="ac-row-id">'+escape(item.requestId||item.id)+'</span>';
  }
  function paintRows() {
    const current=new Set(),focused=mount.ownerDocument.activeElement?.dataset?.acKey;
    for (const item of (data?.items||[]).slice(0,PAGE)) {
      const key=activityKey(item);current.add(key);
      let row=rows.get(key);
      if(!row) {
        const li=mount.ownerDocument.createElement('li'),button=mount.ownerDocument.createElement('button');
        button.type='button';button.className='ac-record';button.dataset.acKey=key;li.append(button);
        row={li,button,markup:''};rows.set(key,row);
        button.addEventListener('click',()=>void selectRecord(row.item));
      }
      row.item=item;
      const markup=rowMarkup(item);
      if(markup!==row.markup){row.button.innerHTML=markup;row.markup=markup;}
      row.button.setAttribute('aria-pressed',String(Boolean(selected&&activityKey(selected)===key)));
      row.button.setAttribute('aria-label',(item.title||item.tool||'Activity')+', '+activityStatus(item).label);
      ui.list.append(row.li);
      if(selected&&activityKey(selected)===key)selected=item;
    }
    for(const [key,row] of rows)if(!current.has(key)){row.li.remove();rows.delete(key);}
    if(focused&&rows.has(focused)&&mount.ownerDocument.activeElement?.dataset?.acKey!==focused)rows.get(focused).button.focus({preventScroll:true});
    updateControls();
  }
  async function loadList({reset=false}={}) {
    if(!active||destroyed)return;
    if(reset)offset=0;
    const epoch=++listEpoch,readVersion=listEventVersion;listNeedsRefresh=false;
    listController?.abort();const controller=new AbortController();listController=controller;
    listBusy=true;listError='';updateControls();
    try {
      const incoming=await read(activityListPath({source,status,q:query,offset,limit:PAGE}),controller.signal);
      if(!active||epoch!==listEpoch||controller.signal.aborted)return;
      if(!Array.isArray(incoming?.items)||!Number.isFinite(Number(incoming.total)))throw Error('The activity response was incomplete.');
      data={...incoming,items:incoming.items.filter(item=>item&&item.id&&['runs','tools'].includes(item.kind)).slice(0,PAGE)};
      offset=Number(incoming.offset)||0;dirty=readVersion!==listEventVersion;paintRows();
    } catch(error) { if(active&&epoch===listEpoch&&!controller.signal.aborted){listError=message(error);offset=Number(data?.offset)||0;} }
    finally { if(epoch===listEpoch){listBusy=false;listController=null;if(readVersion!==listEventVersion)listNeedsRefresh=true;if(active){updateControls();if(listNeedsRefresh&&offset===0)queueLiveRefresh();}} }
  }
  function resetFilters() {
    source='runs';status='all';query='';offset=0;ui.source.value=source;ui.query.value='';
    data=null;rows.clear();ui.list.replaceChildren();void loadList({reset:true});
  }
  function applyFilter() {
    clearTimeout(searchTimer);searchTimer=null;
    source=ui.source.value;query=ui.query.value.trim();offset=0;
    data=null;rows.clear();ui.list.replaceChildren();void loadList({reset:true});
  }
  function textBlock(label,block,{open=false}={}) {
    if(!block || typeof block.text!=='string' || !block.text.length)return '';
    const suffix=block.truncated?'<p class="next-help">Showing '+Number(block.text.length).toLocaleString()+' of '+Number(block.totalCharacters||block.text.length).toLocaleString()+' characters retained in this record.</p>':'';
    return '<details class="ac-block" data-ac-section="'+escape(label)+'"'+(open?' open':'')+'><summary>'+escape(label)+'</summary><pre>'+escape(bounded(block.text))+'</pre>'+suffix+'</details>';
  }
  function paintDetail({focus=false}={}) {
    ui['detail-title'].textContent=selected?.title||selected?.tool||'Select an activity';
    ui['detail-close'].hidden=!selected;ui['detail-refresh'].hidden=!selected;
    ui['detail-refresh'].disabled=detailBusy;
    ui['open-chat'].hidden=!selected||selected.kind!=='runs';
    ui['open-workflow'].hidden=!selected||selected.kind!=='runs';
    ui.detail.setAttribute('aria-busy',String(detailBusy));
    ui['detail-feedback'].textContent=detailError?'Could not load evidence. '+detailError+(detail?' Previously loaded evidence is still shown.':''):detailBusy?'Loading evidence…':'';
    ui['detail-feedback'].dataset.error=String(Boolean(detailError));
    if(!selected){ui['detail-body'].innerHTML='<p class="ac-empty">Choose a record to inspect its status, output, and retained evidence.</p>';lastDetailMarkup='';return;}
    if(!detail){ui['detail-body'].innerHTML='<p class="ac-empty">'+(detailBusy?'Loading the selected record…':'No evidence is loaded. Use Refresh evidence to try again.')+'</p>';lastDetailMarkup='';return;}
    const item=detail.item||selected,state=activityStatus(item);
    const evidence=detail.evidence||{items:[],total:0,offset:0,nextOffset:null};
    const error=activityErrorText(detail.error||item.error);
    const fields=[['Recorded status',item.status||'Not recorded'],['Settlement',item.settled===true?'Settled':item.settled===false?'Still active':'Not recorded'],['Run ID',item.kind==='runs'?item.id:''],['Job ID',item.kind==='tools'?item.id:''],['Request ID',item.requestId],['Started',item.startedAt?activityTimestamp(item.startedAt):''],['Finished',item.finishedAt?activityTimestamp(item.finishedAt):''],['Elapsed',activityDuration(item)],['Tool',item.tool],['Action',item.action]];
    let html='<div class="ac-detail-summary"><span class="ac-status" data-tone="'+state.tone+'">'+escape(state.label)+'</span><span class="next-help">'+escape(state.description)+'</span></div>'+
      (error?'<section class="ac-error"><h3>Recorded failure</h3><pre>'+escape(bounded(error,12000))+'</pre>'+((detail.error||item.error)?.truncated?'<p class="next-help">The failure summary is truncated. Inspect retained evidence below for the recorded result.</p>':'')+'</section>':'')+
      (item.toolCounts?.unresolved>0?'<section class="ac-attention"><h3>Tool failures need review</h3><p>'+Number(item.toolCounts.unresolved)+' tool '+(item.toolCounts.unresolved===1?'failure has':'failures have')+' no retained resolution receipt. The run’s saved outcome and the tool evidence are shown separately below.</p></section>':'')+
      (item.interaction?'<section class="ac-attention"><h3>Input needed</h3><pre>'+escape(bounded(activityErrorText(item.interaction),6000))+'</pre></section>':'')+
      '<dl class="ac-facts">'+fields.filter(([,value])=>value).map(([label,value])=>'<div><dt>'+escape(label)+'</dt><dd>'+escape(value)+'</dd></div>').join('')+'</dl>'+
      (detail.notice?'<p class="ac-notice">'+escape(activityErrorText(detail.notice))+'</p>':'')+
      textBlock('Instructions / input',detail.input)+textBlock('Recorded output',detail.output,{open:true});
    if(Array.isArray(detail.nodes)&&detail.nodes.length){
      html+='<details class="ac-block" data-ac-section="Stages"><summary>Stages ('+Number(detail.nodeTotal??detail.nodes.length)+')</summary><ol class="ac-stages">'+detail.nodes.slice(0,80).map(node=>{
        const label=node.title||node.name||node.id||'Stage',nodeStatus=activityStatus(node);
        return '<li><span><strong>'+escape(bounded(label,160))+'</strong><span class="ac-status" data-tone="'+nodeStatus.tone+'">'+escape(nodeStatus.label)+'</span></span>'+(node.error?'<pre>'+escape(bounded(activityErrorText(node.error),3000))+'</pre>':'')+'</li>';
      }).join('')+'</ol>'+(detail.nodesTruncated?'<p class="next-help">The stage list is truncated. Inspect workflow to see more.</p>':'')+'</details>';
    }
    html+='<section class="ac-evidence" aria-labelledby="ac-evidence-title"><h3 id="ac-evidence-title">Recorded evidence <span class="next-help">('+Number(evidence.total||0)+')</span></h3>'+
      ((evidence.items||[]).length?(evidence.items||[]).slice(0,EVIDENCE_PAGE).map(event=>{
        const state=activityEvidenceStatus(event);
        return '<details class="ac-evidence-row" data-ac-evidence="'+escape(event.id||'')+'"><summary><span><strong>'+escape(bounded(event.label||event.type||'Event',180))+'</strong><span class="ac-row-meta">'+escape([event.at?activityTimestamp(event.at):'',event.nodeId||'',event.tool||''].filter(Boolean).join(' · '))+'</span></span>'+(state?'<span class="ac-status" data-tone="'+state.tone+'" title="'+escape(state.description)+'">'+escape(state.label)+'</span>':'')+'</summary><p class="ac-receipt-id">'+escape(event.id||'')+'</p><pre>'+escape(bounded(event.text,20000)||'No text payload was retained.')+'</pre>'+(event.truncated?'<p class="next-help">This receipt is truncated ('+Number(event.totalCharacters||0).toLocaleString()+' characters recorded).</p>':'')+'</details>';
      }).join(''):'<p class="next-help">No event receipts are retained for this record. This does not prove that no tools ran.</p>')+
      '<nav class="ac-pagination" aria-label="Evidence pages"><button id="ac-evidence-prev" type="button"'+(Number(evidence.offset||0)===0||detailBusy?' disabled':'')+'>Previous evidence</button><span class="next-help">'+((evidence.items||[]).length?(Number(evidence.offset||0)+1)+'–'+(Number(evidence.offset||0)+(evidence.items||[]).length)+' of '+Number(evidence.total||0):'')+'</span><button id="ac-evidence-next" type="button"'+(evidence.nextOffset==null||detailBusy?' disabled':'')+'>Next evidence</button></nav></section>';
    if(html!==lastDetailMarkup){
      const disclosureKey=el=>el.dataset.acEvidence?'e:'+el.dataset.acEvidence:'s:'+el.dataset.acSection;
      const disclosureStates=new Map([...ui['detail-body'].querySelectorAll('details')].map(el=>[disclosureKey(el),el.open]));
      const focusedElement=mount.ownerDocument.activeElement,focusedDisclosure=ui['detail-body'].contains(focusedElement)?focusedElement?.closest('details'):null;
      const focusedSummary=focusedElement?.tagName==='SUMMARY'&&focusedDisclosure?disclosureKey(focusedDisclosure):null;
      const oldScroll=ui.detail.scrollTop,focusedId=ui['detail-body'].contains(focusedElement)?focusedElement?.id:null;
      ui['detail-body'].innerHTML=html;lastDetailMarkup=html;
      for(const disclosure of ui['detail-body'].querySelectorAll('details')){const key=disclosureKey(disclosure);if(disclosureStates.has(key))disclosure.open=disclosureStates.get(key);if(focusedSummary===key)disclosure.querySelector('summary')?.focus({preventScroll:true});}
      ui.detail.scrollTop=oldScroll;
      if(focusedId)$(focusedId)?.focus({preventScroll:true});
      $('ac-evidence-prev')?.addEventListener('click',()=>{evidenceOffset=Math.max(0,evidenceOffset-EVIDENCE_PAGE);void loadDetail();});
      $('ac-evidence-next')?.addEventListener('click',()=>{if(detail?.evidence?.nextOffset!=null){evidenceOffset=detail.evidence.nextOffset;void loadDetail();}});
    }
    if(focus){
      ui['detail-title'].focus({preventScroll:true});
      const rect=ui.detail.getBoundingClientRect(),height=mount.ownerDocument.defaultView?.innerHeight||Infinity;
      if(rect.top>height-80||rect.bottom<0)ui.detail.scrollIntoView({block:'start'});
    }
  }
  async function loadDetail({focus=false}={}) {
    if(!active||!selected||destroyed)return;
    const item=selected,key=activityKey(item),epoch=++detailEpoch,readVersion=detailEventVersion;detailNeedsRefresh=false;
    detailController?.abort();const controller=new AbortController();detailController=controller;
    detailBusy=true;detailError='';paintDetail();
    try{
      const incoming=await read(activityDetailPath(item,{offset:evidenceOffset,limit:EVIDENCE_PAGE}),controller.signal);
      if(!active||epoch!==detailEpoch||controller.signal.aborted||!selected||key!==activityKey(selected))return;
      if(!incoming?.item||activityKey(incoming.item)!==key)throw Error('The returned evidence did not match the selected record.');
      detail=incoming;selected=incoming.item;evidenceOffset=Number(incoming.evidence?.offset)||0;paintRows();
    }catch(error){if(active&&epoch===detailEpoch&&!controller.signal.aborted){detailError=message(error);evidenceOffset=Number(detail?.evidence?.offset)||0;}}
    finally{if(epoch===detailEpoch){detailBusy=false;detailController=null;if(readVersion!==detailEventVersion)detailNeedsRefresh=true;if(active){paintDetail({focus});if(detailNeedsRefresh&&evidenceOffset===0)queueLiveRefresh();}}}
  }
  async function selectRecord(item) {
    if(!item)return;
    if(!selected||activityKey(selected)!==activityKey(item)){detail=null;lastDetailMarkup='';evidenceOffset=0;ui.detail.scrollTop=0;}
    selected=item;paintRows();await loadDetail({focus:true});
  }
  function closeDetail() {
    const key=selected&&activityKey(selected);detailEpoch++;detailController?.abort();detailController=null;detailBusy=false;
    selected=null;detail=null;detailError='';detailNeedsRefresh=false;lastDetailMarkup='';paintRows();paintDetail();
    if(key&&rows.has(key))rows.get(key).button.focus({preventScroll:true});
  }
  function queueLiveRefresh() {
    if(!active||eventTimer)return;
    eventTimer=setTimeout(()=>{
      eventTimer=null;if(!active)return;
      if(offset===0&&listNeedsRefresh&&!listBusy)void loadList();
      if(selected&&detailNeedsRefresh&&!detailBusy&&evidenceOffset===0)void loadDetail();
    },1000);
  }
  function scheduleRefresh(event) {
    if(!active)return;
    const listRelevant=activityEventRelevant(event,source),detailRelevant=selected&&activityEventRelevant(event,selected.kind);
    if(!listRelevant&&!detailRelevant)return;
    if(listRelevant){dirty=true;listNeedsRefresh=true;listEventVersion++;if(offset>0)updateControls();}
    if(detailRelevant){detailNeedsRefresh=true;detailEventVersion++;}
    queueLiveRefresh();
  }
  ui.source.addEventListener('change',applyFilter);
  ui.query.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(applyFilter,220);});
  ui.query.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyFilter();}});
  ui.clear.addEventListener('click',resetFilters);
  ui.refresh.addEventListener('click',()=>void loadList({reset:true}));
  for(const button of filters)button.addEventListener('click',()=>{status=button.dataset.acFilter;applyFilter();});
  ui['page-prev'].addEventListener('click',()=>{offset=Math.max(0,offset-PAGE);void loadList();});
  ui['page-next'].addEventListener('click',()=>{if(data?.nextOffset!=null){offset=data.nextOffset;void loadList();}});
  ui['detail-close'].addEventListener('click',closeDetail);
  ui['detail-refresh'].addEventListener('click',()=>void loadDetail());
  ui['open-chat'].addEventListener('click',()=>{if(selected?.kind==='runs')onNavigate('chat',{conversationId:selected.id});});
  ui['open-workflow'].addEventListener('click',()=>{if(selected?.kind==='runs')onInspectWorkflow(selected.id);});
  ui.detail.addEventListener('keydown',event=>{if(event.key==='Escape'&&selected){event.preventDefault();closeDetail();}});
  ui.list.addEventListener('keydown',event=>{
    const controls=[...ui.list.querySelectorAll('button[data-ac-key]')],index=controls.indexOf(mount.ownerDocument.activeElement);
    if(index<0)return;
    const next=event.key==='ArrowDown'?Math.min(index+1,controls.length-1):event.key==='ArrowUp'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?controls.length-1:-1;
    if(next>=0){event.preventDefault();controls[next].focus();}
  });
  return {
    enter(){
      if(active||destroyed)return;active=true;unsubscribe=events?.subscribe(scheduleRefresh);
      void loadList();if(selected)void loadDetail();
      pollTimer=setInterval(()=>{if(!active||mount.ownerDocument.hidden)return;if(offset===0&&!listBusy)void loadList();if(selected?.active&&!detailBusy&&evidenceOffset===0)void loadDetail();},15000);
    },
    leave(){
      if(!active)return;active=false;listEpoch++;detailEpoch++;unsubscribe?.();unsubscribe=null;
      listController?.abort();detailController?.abort();listController=null;detailController=null;listBusy=false;detailBusy=false;
      clearTimeout(eventTimer);clearTimeout(searchTimer);clearInterval(pollTimer);eventTimer=null;searchTimer=null;pollTimer=null;
    },
    refresh(){return loadList({reset:true});},
    destroy(){this.leave();destroyed=true;rows.clear();mount.replaceChildren();},
  };
}
