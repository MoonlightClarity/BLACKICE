/** Browser-side Activity acceptance. All APIs and events are synthetic.
 * Run through BLACKICE's direct frontend in a disposable mount in the real renderer.
 * This module neither opens a browser nor starts, changes, or cancels saved work.
 */
export async function exerciseActivityOverview({createActivityOverview,mount}) {
  const clock=()=>globalThis.performance?.now?.()??Date.now();
  const started=clock(),assertions=[],failures=[],timings={},calls=[],navigation=[],workflowNavigation=[],notifications=[];
  const listeners=new Set(),holds=[],base=Date.parse('2026-10-30T18:00:00Z');
  let component,scenario='setup',destroyed=false,listError='',detailError='',partialTools=false,archiveWarning=false,detailVersion=0,initialLoading=true;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(condition,message,actual)=>{if(!condition){const error=Error(message);error.actual=actual;throw error;}};
  const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
  const initial=deferred();
  const clone=value=>structuredClone(value);
  const item=(kind,id,status,extra={})=>({
    kind,id,key:kind+':'+id,title:'Fixture '+id,status,
    settled:!['queued','running','waiting','awaiting_input','cancelling'].includes(status),
    active:['queued','running','waiting','awaiting_input','cancelling'].includes(status),
    attention:['failed','interrupted','waiting','awaiting_input'].includes(status),
    finished:['completed','succeeded','failed','cancelled','interrupted'].includes(status),
    createdAt:new Date(base).toISOString(),startedAt:new Date(base+1000).toISOString(),
    updatedAt:new Date(base+2000).toISOString(),
    finishedAt:['completed','succeeded','failed','cancelled','interrupted'].includes(status)?new Date(base+2000).toISOString():null,
    ...(kind==='runs'?{taskId:'task-'+id,nodeCount:1}:{requestId:'request-'+id,tool:'blackice_workspace_read',action:'read'}),
    ...extra,
  });
  const records=[
    item('runs','run-working','running'),
    item('tools','tool-waiting','awaiting_input',{error:{message:'Fixture needs a response'}}),
    item('runs','run-failed','failed',{error:{code:'FIXTURE_FAILURE',message:'Fixture operation failed precisely'}}),
    item('tools','tool-cancelled','cancelled'),
    item('runs','run-completed','completed'),
    item('runs','run-interrupted','interrupted',{error:{message:'Fixture host interrupted'}}),
    item('tools','tool-unknown','unknown',{settled:null,active:false,attention:false,finished:false}),
    item('tools','tool-stopping','cancelling'),
    item('runs','run-cancel-pending','cancelled',{settled:false,active:true,finished:false,finishedAt:null}),
    item('runs','run-alpha','completed',{title:'Alpha older fixture'}),
    item('runs','run-beta','completed',{title:'Beta newer fixture'}),
    ...Array.from({length:9989},(_,i)=>item(i%2?'tools':'runs','record-'+i,i%2?'succeeded':'completed',{
      title:i===9988?'Deep needle at record 9999':'Saved fixture record '+i,
      createdAt:new Date(base-i*1000).toISOString(),updatedAt:new Date(base-i*1000).toISOString(),
    })),
  ];
  const listCalls=()=>calls.filter(call=>call.pathname==='/api/activity');
  const detailCalls=()=>calls.filter(call=>call.pathname.startsWith('/api/activity/'));
  const $=selector=>mount.querySelector(selector);
  const rows=()=>[...mount.querySelectorAll('#ac-list [data-ac-key]')];
  const keys=()=>rows().map(row=>row.dataset.acKey);
  const feedback=()=>$('#ac-feedback')?.textContent||'';
  const detail=()=>$('#ac-detail')?.textContent||'';
  const show=selector=>{
    const control=$(selector);check(control,'Missing control '+selector);
    check(!control.disabled,'Control is disabled '+selector);control.click();return control;
  };
  const query=value=>{
    const control=$('#ac-query');check(control,'Missing search control');
    control.value=value;control.dispatchEvent(new Event('input',{bubbles:true}));
  };
  const selectSource=value=>{
    const control=$('#ac-source');check(control,'Missing source control');
    control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}));
  };
  const filter=value=>show('[data-ac-filter="'+value+'"]');
  const select=key=>show('#ac-list [data-ac-key="'+key+'"]');
  async function until(predicate,label,timeout=5000) {
    const end=clock()+timeout;let last;
    while(clock()<end){try{const result=await predicate();if(result)return result;}catch(error){last=error;}await wait(20);}
    throw Error(label+' timed out'+(last?': '+last.message:''));
  }
  async function step(name,fn){
    scenario=name;const at=clock();await fn();assertions.push({name,passed:true,elapsedMs:Math.round(clock()-at)});
  }
  function emit(type,data={}){
    const receipt={type,data,runId:data.runId||data.id};
    for(const listener of [...listeners])listener(receipt);
  }
  function page(url){
    const source=url.searchParams.get('source')||'all',status=url.searchParams.get('status')||'all';
    const q=(url.searchParams.get('q')||'').toLowerCase(),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||40));
    const scoped=records.filter(record=>(source==='all'||record.kind===source)&&(!q||(record.title+' '+record.id).toLowerCase().includes(q)));
    const counts={all:scoped.length,active:scoped.filter(row=>row.active).length,attention:scoped.filter(row=>row.attention).length,finished:scoped.filter(row=>row.finished).length};
    const filtered=scoped.filter(record=>status==='all'||record[status]===true);
    return {items:clone(filtered.slice(offset,offset+limit)),total:filtered.length,offset,limit,
      nextOffset:offset+limit<filtered.length?offset+limit:null,counts,
      sources:{runs:archiveWarning?{available:true,warning:'Fixture archived run coverage is incomplete'}:{available:true},tools:partialTools?{available:false,error:'Fixture tools are temporarily unavailable'}:{available:true}},
      generatedAt:new Date().toISOString()};
  }
  function detailPage(url){
    const parts=url.pathname.split('/'),kind=decodeURIComponent(parts[3]||''),id=decodeURIComponent(parts[4]||'');
    const record=records.find(row=>row.kind===kind&&row.id===id);if(!record)throw Error('Fixture record missing');
    const offset=Math.max(0,Number(url.searchParams.get('offset'))||0),limit=Math.min(50,Math.max(1,Number(url.searchParams.get('limit'))||50));
    const evidence=Array.from({length:120},(_,index)=>({
      id:id+'-receipt-'+index,type:index%3?'tool.result':'tool.call',label:'Saved tool receipt '+index,status:'succeeded',
      at:new Date(base+index*1000).toISOString(),nodeId:'agent',tool:'fixture_workspace',action:'read',
      text:'Receipt '+index+' for '+id+'\nExact fixture evidence <img src=x onerror="globalThis.__activityFixtureUnsafe=true">',
      totalCharacters:120,truncated:false,
    }));
    const output='Complete fixture output '+id+' · revision '+detailVersion;
    return {item:clone(record),input:{text:'Fixture input '+id,totalCharacters:30,truncated:false},
      output:{text:output,totalCharacters:output.length,truncated:false},
      nodes:kind==='runs'?[{id:'agent',name:'Fixture agent',title:'Fixture agent',type:'agent',status:record.status,startedAt:record.startedAt,finishedAt:record.finishedAt,error:record.error}]:[],
      nodeTotal:kind==='runs'?1:0,nodesTruncated:false,error:record.error||null,
      evidence:{items:clone(evidence.slice(offset,offset+limit)),total:evidence.length,offset,limit,nextOffset:offset+limit<evidence.length?offset+limit:null}};
  }
  async function api(path,method='GET',payload,options={}){
    const url=new URL(path,'http://activity-fixture.invalid');
    const call={path,pathname:url.pathname,method,payload,at:clock()};
    calls.push(call);
    if(method!=='GET')throw Error('Activity attempted a forbidden fixture mutation: '+method+' '+path);
    check(url.pathname==='/api/activity'||url.pathname.startsWith('/api/activity/'),'Unexpected Activity API route',path);
    const isList=url.pathname==='/api/activity';
    if(isList&&listError)throw Error(listError);
    if(!isList&&detailError)throw Error(detailError);
    const response=isList?page(url):detailPage(url);
    if(isList&&initialLoading){initialLoading=false;await initial.promise;}
    const held=holds.find(entry=>!entry.used&&entry.match(url));if(held){held.used=true;await held.gate.promise;}
    // Deliberately deliver held reads after abort to test the component's revision check too.
    return response;
  }
  try {
    check(typeof createActivityOverview==='function','createActivityOverview must be a function');
    check(mount?.ownerDocument,'Provide an actual renderer mount');
    check(records.length===10000,'Fixture must contain exactly 10,000 metadata rows',records.length);
    component=createActivityOverview({mount,api,
      events:{subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},
      notify:(...args)=>notifications.push(args),onNavigate:(...args)=>navigation.push(args),
      onInspectWorkflow:(...args)=>workflowNavigation.push(args)});
    await step('lazy loading, explicit loading state, bounded 10,000-record initial page',async()=>{
      check(calls.length===0,'Creating an inactive overview must not read');
      const at=clock();component.enter();
      await until(()=>listCalls().length===1,'First list request');
      check(Boolean(mount.querySelector('[aria-busy="true"]'))||/load|refresh|checking/i.test(feedback()),'Initial loading must be visible and distinguishable from empty data',feedback());
      check(rows().length===0,'Deferred initial read must not invent records');
      initial.resolve();await until(()=>rows().length===40,'First bounded list');
      timings.initialPaintMs=Math.round(clock()-at);
      check(keys().length===new Set(keys()).size,'Initial page keys must be unique');
      check(rows().every(row=>['true','false'].includes(row.getAttribute('aria-pressed'))),'Every row must expose a valid aria-pressed value');
      check(rows().every(row=>row.getAttribute('aria-pressed')==='false'),'Initial unselected rows must announce false, not null');
      check(listCalls().every(call=>new URL(call.path,'http://fixture').searchParams.get('limit')==='40'),'List reads must request bounded 40-record pages');
      check(listeners.size===1,'Active overview should own one event subscription',listeners.size);
    });
    await step('page navigation replaces the bounded window',async()=>{
      const first=keys();show('#ac-page-next');await until(()=>rows().length===40&&!keys().includes(first[0]),'Second metadata page');
      check(rows().length<=40,'Paging must not append unbounded rows',rows().length);
      show('#ac-page-prev');await until(()=>keys()[0]===first[0],'Return to first page');
    });
    await step('failed metadata Next preserves the displayed page and records',async()=>{
      const beforeKeys=keys(),beforeLabel=$('#ac-page-label')?.textContent;
      listError='Fixture next metadata page unavailable';show('#ac-page-next');
      await until(()=>mount.textContent.includes(listError),'Failed metadata page');
      check(JSON.stringify(keys())===JSON.stringify(beforeKeys),'A failed page request must preserve the last displayed records');
      check($('#ac-page-label')?.textContent===beforeLabel,'A failed page request must not advance the displayed range', $('#ac-page-label')?.textContent);
      check($('#ac-page-prev')?.disabled===true,'A failed Next from page one must not enable Previous');
      listError='';show('#ac-refresh');await until(()=>!mount.textContent.includes('Fixture next metadata page unavailable'),'Retry metadata after page failure');
      show('#ac-page-next');await until(()=>!keys().includes(beforeKeys[0]),'Next retries the intended page');
      check(new URL(listCalls().at(-1).path,'http://fixture').searchParams.get('offset')==='40','Retry after failed Next must not skip a page');
      show('#ac-page-prev');await until(()=>keys()[0]===beforeKeys[0],'Restore first metadata page');
    });
    await step('deep search and explicit empty state',async()=>{
      const at=clock();query('Deep needle');await until(()=>rows().length===1&&rows()[0].textContent.includes('Deep needle'),'Search record outside first page');
      timings.deepSearchMs=Math.round(clock()-at);
      check(rows().length<=40,'Deep search must stay bounded');
      query('No matching fixture qzx');await until(()=>rows().length===0&&!/loading/i.test(feedback()),'Empty search');
      check(/no|empty|0 (?:match|result|record)/i.test($('#ac-list')?.textContent+' '+feedback()),'Empty state must explain the lack of records');
      query('');await until(()=>rows().length===40,'Clear search');
    });
    await step('source and status filtering use actual metadata',async()=>{
      selectSource('tools');await until(()=>rows().length&&keys().every(key=>key.startsWith('tools:')),'Tools source');
      filter('attention');await until(()=>keys().length===1&&keys()[0]==='tools:tool-waiting','Tools needing attention');
      selectSource('all');await until(()=>keys().includes('runs:run-failed'),'All-source attention');
      check(keys().includes('runs:run-interrupted'),'Interrupted work must remain inspectable in attention');
      filter('all');await until(()=>rows().length===40,'Clear status filter');
    });
    await step('failed receipt evidence is exact, escaped, and paged',async()=>{
      select('runs:run-failed');await until(()=>detail().includes('Fixture operation failed precisely'),'Exact saved failure detail');
      check(detail().includes('run-failed'),'Detail must include selected record identity');
      if(globalThis.innerWidth<=950)check($('#ac-detail').getBoundingClientRect().top<globalThis.innerHeight-40,'Narrow-screen selection must bring the inspector into view');
      check(mount.querySelectorAll('#ac-detail [data-ac-evidence]').length<=50,'Evidence DOM must be bounded');
      check(mount.querySelectorAll('#ac-detail img').length===0,'Evidence text must not create HTML elements');
      check(globalThis.__activityFixtureUnsafe!==true,'Evidence must not execute markup');
      const first=$('#ac-detail [data-ac-evidence]');check(first,'Expected inspectable evidence disclosure');first.open=true;
      check(first.textContent.includes('Exact fixture evidence <img'),'Evidence text must remain inspectable verbatim');
      const evidencePageLabel=()=>$('#ac-detail .ac-evidence .ac-pagination span')?.textContent;
      const firstLabel=evidencePageLabel(),firstIds=[...mount.querySelectorAll('#ac-detail [data-ac-evidence]')].map(row=>row.dataset.acEvidence);
      detailError='Fixture next evidence page unavailable';show('#ac-evidence-next');
      await until(()=>mount.textContent.includes(detailError),'Failed evidence page');
      check(evidencePageLabel()===firstLabel,'A failed evidence Next must preserve the displayed page range',evidencePageLabel());
      check($('#ac-evidence-prev')?.disabled===true,'A failed evidence Next from page one must not enable Previous');
      check(JSON.stringify([...mount.querySelectorAll('#ac-detail [data-ac-evidence]')].map(row=>row.dataset.acEvidence))===JSON.stringify(firstIds),'A failed evidence page must retain prior receipts');
      detailError='';show('#ac-detail-refresh');await until(()=>!mount.textContent.includes('Fixture next evidence page unavailable'),'Evidence page recovery');
      show('#ac-evidence-next');await until(()=>$('#ac-detail [data-ac-evidence]')?.dataset.acEvidence==='run-failed-receipt-50','Next evidence page');
      check(mount.querySelectorAll('#ac-detail [data-ac-evidence]').length<=50,'More evidence must remain bounded');
      show('#ac-evidence-prev');await until(()=>$('#ac-detail [data-ac-evidence]')?.dataset.acEvidence==='run-failed-receipt-0','Previous evidence page');
    });
    await step('late detail cannot overwrite newer selection',async()=>{
      show('#ac-detail-close');
      const gate=deferred();holds.push({match:url=>url.pathname==='/api/activity/runs/run-alpha',gate});
      select('runs:run-alpha');await until(()=>holds.at(-1).used,'Hold first detail');
      select('runs:run-completed');await until(()=>detail().includes('Complete fixture output run-completed'),'Latest detail');
      gate.resolve();await wait(60);
      check(detail().includes('Complete fixture output run-completed'),'Late A detail must not overwrite B');
      check(!detail().includes('Complete fixture output run-alpha'),'Old selected output leaked into current detail');
    });
    await step('exact navigation and inspection cannot dispatch writes',async()=>{
      show('#ac-open-chat');check(navigation.at(-1)?.[0]==='chat','Open Chat must navigate to Chat');
      check(navigation.at(-1)?.[1]?.conversationId==='run-completed','Open Chat must target the exact selected run',navigation.at(-1));
      show('#ac-open-workflow');check(workflowNavigation.at(-1)?.[0]==='run-completed','Workflow navigation must target the selected run',workflowNavigation.at(-1));
      check(calls.every(call=>call.method==='GET'),'Inspection/navigation must not write');
    });
    await step('error preserves prior records, retry recovers, partial sources are visible',async()=>{
      const prior=keys();listError='Fixture list unavailable';show('#ac-refresh');
      await until(()=>mount.textContent.includes(listError),'List error');
      check(JSON.stringify(keys())===JSON.stringify(prior),'Refresh failure must preserve previously loaded records');
      listError='';show('#ac-refresh');await until(()=>!mount.textContent.includes('Fixture list unavailable'),'Refresh recovery');
      partialTools=true;show('#ac-refresh');await until(()=>mount.textContent.includes('Fixture tools are temporarily unavailable'),'Partial source warning');
      check(rows().length>0,'One unavailable source must not erase available records');
      partialTools=false;show('#ac-refresh');await until(()=>!mount.textContent.includes('Fixture tools are temporarily unavailable'),'Source recovery');
      archiveWarning=true;show('#ac-refresh');await until(()=>mount.textContent.includes('Fixture archived run coverage is incomplete'),'Available source with incomplete archived coverage warning');
      check(rows().length>0,'Available source warning must not erase loaded records');
      archiveWarning=false;show('#ac-refresh');await until(()=>!mount.textContent.includes('Fixture archived run coverage is incomplete'),'Archived coverage warning clears');
    });
    await step('selected detail loading failure can recover',async()=>{
      detailError='Fixture selected evidence unavailable';show('#ac-detail-refresh');
      await until(()=>mount.textContent.includes(detailError),'Detail failure');
      detailError='';show('#ac-detail-refresh');
      await until(()=>detail().includes('Complete fixture output run-completed')&&!mount.textContent.includes('Fixture selected evidence unavailable'),'Detail retry');
    });
    await step('late filter result cannot repopulate newer query',async()=>{
      const gate=deferred();holds.push({match:url=>url.pathname==='/api/activity'&&url.searchParams.get('q')==='Alpha older',gate});
      query('Alpha older');await until(()=>holds.at(-1).used,'Hold older query');
      query('Beta newer');await until(()=>keys().length===1&&keys()[0]==='runs:run-beta','Newer query');
      gate.resolve();await wait(70);
      check(JSON.stringify(keys())===JSON.stringify(['runs:run-beta']),'Older query must not overwrite current filter');
      query('');await until(()=>rows().length===40,'Restore unfiltered page');
    });
    await step('live lifecycle transitions and coalesced updates',async()=>{
      filter('active');await until(()=>keys().includes('runs:run-working'),'Running row');
      select('runs:run-working');await until(()=>detail().includes('run-working'),'Running detail');
      const record=records.find(row=>row.id==='run-working');record.status='cancelling';record.updatedAt=new Date().toISOString();
      emit('run.updated',clone(record));await until(()=>/cancel|stopp/i.test(detail()),'Cancelling evidence',6000);
      Object.assign(record,{status:'cancelled',settled:true,active:false,finished:true,finishedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
      emit('run.updated',clone(record));await until(()=>!keys().includes('runs:run-working'),'Cancelled record leaves active filter',6000);
      filter('finished');await until(()=>keys().includes('runs:run-working'),'Cancelled record in finished filter');
      select('runs:run-working');await until(()=>/cancel/i.test(detail())&&detail().includes('run-working'),'Final cancellation detail');
      filter('all');await until(()=>rows().length===40,'All records after lifecycle');
      select('runs:run-completed');await until(()=>detail().includes('Complete fixture output run-completed'),'Stable selected detail');
      const beforeLists=listCalls().length,beforeDetails=detailCalls().length;
      for(let index=0;index<100;index++)emit('agent.event',{runId:'run-completed',nodeId:'agent',type:'tool.result',id:'burst-'+index});
      await wait(1500);
      const listDelta=listCalls().length-beforeLists,detailDelta=detailCalls().length-beforeDetails;
      check(listDelta<=3&&detailDelta<=3,'Burst events must coalesce reads',{listDelta,detailDelta});
      timings.burstListReads=listDelta;timings.burstDetailReads=detailDelta;
    });
    await step('terminal events received during held reads drain after stale responses',async()=>{
      const beta=records.find(row=>row.id==='run-beta');
      Object.assign(beta,{status:'running',active:true,settled:false,finished:false,finishedAt:null,updatedAt:new Date().toISOString()});
      component.refresh();await until(()=>rows().some(row=>row.dataset.acKey==='runs:run-beta'&&/Running/.test(row.textContent)),'Prepare running beta fixture');
      select('runs:run-beta');await until(()=>$('#ac-detail .ac-detail-summary .ac-status')?.textContent==='Running','Prepare running beta detail');
      const listGate=deferred(),detailGate=deferred();
      const listHold={match:url=>url.pathname==='/api/activity',gate:listGate};
      const detailHold={match:url=>url.pathname==='/api/activity/runs/run-beta',gate:detailGate};
      holds.push(listHold,detailHold);
      const beforeLists=listCalls().length,beforeDetails=detailCalls().length;
      show('#ac-refresh');show('#ac-detail-refresh');
      await until(()=>listHold.used&&detailHold.used,'Both stale reads held');
      Object.assign(beta,{status:'completed',active:false,settled:true,finished:true,finishedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
      detailVersion++;
      emit('run.updated',clone(beta));await wait(1300);
      listGate.resolve();detailGate.resolve();
      await until(()=>rows().some(row=>row.dataset.acKey==='runs:run-beta'&&/Completed/.test(row.textContent))&&$('#ac-detail .ac-detail-summary .ac-status')?.textContent==='Completed'&&detail().includes('revision '+detailVersion),'Pending terminal refresh after held reads',6000);
      check(listCalls().length>=beforeLists+2,'Terminal event during a list read must cause a follow-up read');
      check(detailCalls().length>=beforeDetails+2,'Terminal event during a detail read must cause a follow-up read');
    });
    await step('selected detail refreshes independently of the current list source',async()=>{
      select('runs:run-completed');await until(()=>detail().includes('Complete fixture output run-completed'),'Selected run before source change');
      selectSource('tools');await until(()=>rows().length>0&&keys().every(key=>key.startsWith('tools:')),'Tools list with selected run retained');
      check(detail().includes('Complete fixture output run-completed'),'Changing list source must retain the independently selected run');
      detailVersion++;emit('agent.event',{runId:'run-completed',nodeId:'agent',type:'tool.result'});
      await until(()=>detail().includes('Complete fixture output run-completed')&&detail().includes('revision '+detailVersion),'Run detail refresh while list source is tools',6000);
      check($('#ac-source')?.value==='tools','Detail refresh must not change the list source');
      select('tools:tool-cancelled');await until(()=>detail().includes('Complete fixture output tool-cancelled'),'Selected tool before source change');
      selectSource('runs');await until(()=>rows().length>0&&keys().every(key=>key.startsWith('runs:')),'Runs list with selected tool retained');
      check(detail().includes('Complete fixture output tool-cancelled'),'Changing list source must retain independently selected tool evidence');
      detailVersion++;emit('chatgpt-connector.updated',{revision:detailVersion});
      await until(()=>detail().includes('Complete fixture output tool-cancelled')&&detail().includes('revision '+detailVersion),'Tool detail refresh while list source is runs',6000);
      check($('#ac-source')?.value==='runs','Tool detail refresh must not change list source');
      selectSource('all');await until(()=>rows().length===40,'Restore all-source list');
      select('runs:run-completed');await until(()=>detail().includes('Complete fixture output run-completed'),'Restore selected completed run');
    });
    await step('keyboard, focus, and live evidence disclosure stability',async()=>{
      const input=$('#ac-query');check(input,'Search exists');input.focus();
      emit('conversations.updated',{});
      await wait(1250);
      check(mount.ownerDocument.activeElement===input,'Live update must preserve search focus');
      const row=rows().find(element=>element.dataset.acKey==='runs:run-completed');check(row?.tagName==='BUTTON','Rows must be native keyboard buttons');
      row.focus();check(mount.ownerDocument.activeElement===row,'Activity rows must be focusable');
      select('runs:run-completed');await until(()=>Boolean($('#ac-detail [data-ac-evidence]')),'Evidence for keyboard check');
      const output=$('#ac-detail [data-ac-section="Recorded output"]');
      check(output?.querySelector('summary'),'Recorded output needs an inspectable disclosure');
      output.open=false;output.querySelector('summary').focus();
      detailVersion++;emit('agent.event',{runId:'run-completed',nodeId:'agent',type:'tool.result'});
      await until(()=>detail().includes('revision '+detailVersion),'Changed output payload arrives');
      check($('#ac-detail [data-ac-section="Recorded output"]')?.open===false,'Live detail replacement must preserve explicitly closed output');
      check(mount.ownerDocument.activeElement?.tagName==='SUMMARY'&&mount.ownerDocument.activeElement?.closest('[data-ac-section]')?.dataset.acSection==='Recorded output','Changed output payload must preserve its focused summary');
      const evidence=$('#ac-detail [data-ac-evidence]'),evidenceId=evidence.dataset.acEvidence;
      check(evidence.tagName==='DETAILS'&&evidence.querySelector('summary'),'Evidence must have native disclosure controls');
      evidence.open=true;evidence.querySelector('summary').focus();
      detailVersion++;emit('agent.event',{runId:'run-completed',nodeId:'agent',type:'tool.result'});
      await until(()=>detail().includes('revision '+detailVersion),'Changed selected receipt payload');
      const current=$('#ac-detail [data-ac-evidence="'+evidenceId+'"]');
      check(current?.open===true,'Live detail update must preserve expanded receipt evidence');
      check(mount.ownerDocument.activeElement?.closest('[data-ac-evidence]')?.dataset.acEvidence===evidenceId,'Live detail update must preserve evidence focus');
      const close=$('#ac-detail-close');check(close?.tagName==='BUTTON','Detail close must be a native keyboard control');
    });
    await step('leave aborts stale reads and removes subscriptions',async()=>{
      const gate=deferred();holds.push({match:url=>url.pathname==='/api/activity',gate});
      component.refresh();await until(()=>holds.at(-1).used,'Hold read before leave');
      component.leave();check(listeners.size===0,'Hidden overview must unsubscribe',listeners.size);
      const before=calls.length,markup=mount.innerHTML;
      emit('run.updated',{id:'unexpected-hidden-record',status:'running'});
      gate.resolve();await wait(1300);
      check(calls.length===before,'Hidden overview must not issue event reads');
      check(mount.innerHTML===markup,'Late hidden read must not repaint the overview');
      component.enter();await until(()=>listeners.size===1&&calls.length>before,'Reenter resumes one subscription');
    });
    await step('destroy cleans up and all fixture APIs remain read-only',async()=>{
      component.destroy();destroyed=true;
      check(listeners.size===0,'Destroy must remove event subscription');
      const before=calls.length;emit('chatgpt-connector.updated',{});
      await wait(60);check(calls.length===before,'Destroyed overview must not read');
      check(calls.every(call=>call.method==='GET'),'Fixture observed an implicit mutation');
    });
  } catch(error) {
    failures.push({scenario,message:error.message,actual:error.actual??null,stack:String(error.stack||'').split('\n').slice(0,5)});
  } finally {
    initial.resolve();for(const held of holds)held.gate.resolve();
    if(!destroyed){try{component?.destroy();}catch(error){failures.push({scenario:'cleanup',message:error.message});}}
    delete globalThis.__activityFixtureUnsafe;
  }
  return {ok:failures.length===0,assertions,failures,timings:{...timings,totalMs:Math.round(clock()-started)},
    counts:{fixtureRecords:records.length,assertions:assertions.length,listReads:listCalls().length,detailReads:detailCalls().length,
      mutations:calls.filter(call=>call.method!=='GET').length,remainingSubscribers:listeners.size,navigations:navigation.length},
    requests:calls.map(({path,method})=>({path,method})),notifications};
}
