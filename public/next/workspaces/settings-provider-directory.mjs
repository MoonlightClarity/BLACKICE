/** Model API service discovery. Every indexed connection remains unverified until checked. */
const authLabel={keyed:'API key documented',keyless:'Keyless mode documented',optional:'Key may be optional',unverified:'Authentication unverified'};
const kindLabel={supported:'BLACKICE adapter reviewed','models.dev':'External reference index'};
const safeLink=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const humanDate=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString():'unknown';};

export function createProviderDirectoryUI({mount,api,onChoose}){
  mount.innerHTML=`<details id="next-provider-directory-directory" class="next-provider-directory-panel next-card">
    <summary>Find model API providers · keyed or keyless</summary>
    <div class="next-provider-directory-content">
      <p class="next-help">Find independent AI providers by name, model ID or API address. Supported adapters are separated from external references. Checking a connection verifies its live catalog before saving.</p>
      <div class="next-provider-directory-filters">
        <label class="next-label">Search providers and models<input id="next-provider-directory-query" class="next-field" type="search" maxlength="160" placeholder="Nemotron, Groq, open models…"></label>
        <label class="next-label">Authentication<select id="next-provider-directory-auth" class="next-field"><option value="any">All</option><option value="keyless">Documented keyless</option><option value="keyed">Key documented</option><option value="optional">Optional</option><option value="unverified">Unknown</option></select></label>
        <label class="next-label">Source<select id="next-provider-directory-source" class="next-field"><option value="all">Reviewed + external</option><option value="supported">Reviewed in BLACKICE</option><option value="index">External provider index</option></select></label>
      </div>
      <div class="next-row"><label class="next-row"><input id="next-provider-directory-free" type="checkbox"> Free or zero-price models reported</label>
        <button type="button" id="next-provider-directory-search">Search providers</button>
        <button type="button" id="next-provider-directory-refresh">Refresh external index</button></div>
      <p class="next-help">An external listing is not a working BLACKICE integration. Only endpoints reported as OpenAI-compatible can open a custom connection draft, and they still require live verification.</p>
      <p id="next-provider-directory-status" class="next-help" role="status" aria-live="polite">Search independent model providers.</p>
      <ul id="next-provider-directory-results" class="next-provider-directory-results"></ul>
      <div class="next-row"><button type="button" id="next-provider-directory-prev" hidden>Previous</button><span id="next-provider-directory-page" class="next-help"></span><button type="button" id="next-provider-directory-next" hidden>Next</button></div>
    </div>
  </details>`;
  const $=id=>mount.querySelector('#next-provider-directory-'+id);
  let active=false,disposed=false,request=0,busy=false,controller=null,data=null,offset=0;
  const el=(tag,label,className)=>{const node=mount.ownerDocument.createElement(tag);if(label!==undefined)node.textContent=String(label);if(className)node.className=className;return node;};
  const appendLink=(target,url,label)=>{const href=safeLink(url);if(!href)return;const link=el('a',label);link.href=href;link.rel='noopener noreferrer';link.target='_blank';target.append(link);};
  function controls(){
    for(const id of ['query','auth','source','free','search','refresh','prev','next'])$(id).disabled=busy;
    if(data){$('prev').hidden=offset===0;$('next').hidden=!data.hasMore;
      $('page').textContent=data.total?(`${offset+1}–${offset+data.items.length} of ${data.total} providers`):'No matching providers';}
  }
  function paint(){
    const list=$('results');list.replaceChildren();
    if(!data){controls();return;}
    if(!data.items.length){list.append(el('li','No providers matched. Try another search, authentication type or source.','next-help'));controls();return;}
    for(const item of data.items){
      const li=el('li',undefined,'next-provider-directory-result');
      const head=el('div',undefined,'next-provider-directory-item-heading');
      head.append(el('strong',item.name),el('span',kindLabel[item.source]||item.source,'next-help'));
      li.append(head);
      const meta=[authLabel[item.authentication]||'Authentication unknown',item.modelCount!==null?item.modelCount+' models indexed':null,
        item.zeroPriceModels>0?item.zeroPriceModels+' zero-priced models reported':item.freeModelsDeclared?'Free models advertised':null,
        item.toolModels>0?item.toolModels+' tool-capable models indexed':null].filter(Boolean);
      li.append(el('p',meta.join(' · '),'next-help'));
      if(item.description)li.append(el('p',item.description,'next-help'));
      if(item.matchedModelIds?.length)li.append(el('p','Matching model IDs: '+item.matchedModelIds.join(', '),'next-help'));
      if(item.source==='models.dev')li.append(el('p',item.protocolLabel+'; live inference not verified.','next-help'));
      const actions=el('div',undefined,'next-row');
      appendLink(actions,item.documentationUrl,'Documentation');
      if(item.referenceUrl&&item.referenceUrl!==item.documentationUrl)appendLink(actions,item.referenceUrl,'Index entry');
      if(item.supported||item.compatibility==='index-reported-compatible'){
        const button=el('button',item.supported?'Review supported connection':'Review compatible API draft');
        button.type='button';button.setAttribute('data-directory-choose',item.id);
        button.addEventListener('click',()=>{if(!active||disposed)return;onChoose(item);});
        actions.append(button);
      }
      li.append(actions);
      list.append(li);
    }
    controls();
  }
  async function search(refresh=false){
    if(!active||disposed)return;
    controller?.abort();controller=new AbortController();const token=++request;
    busy=true;controls();$('status').textContent='Searching model API providers…';
    const params=new URLSearchParams({query:$('query').value.trim(),auth:$('auth').value,source:$('source').value,
      offset:String(offset),limit:'30',freeModelsOnly:String($('free').checked),refresh:String(refresh)});
    try{
      const result=await api('/api/provider-directory?'+params.toString(),'GET',undefined,{signal:controller.signal});
      if(!active||disposed||token!==request)return;
      data=result;paint();
      const stamp=result.indexCheckedAt?' Index fetched '+humanDate(result.indexCheckedAt)+'.':'';
      $('status').textContent=`Found ${result.total} provider${result.total===1?'':'s'}.`+stamp+' External data is a reference, not provider-side live availability.'+(result.warning?' '+result.warning:'');
    }catch(error){if(!active||disposed||token!==request)return;
      $('status').textContent='Provider search failed: '+String(error?.message||error).slice(0,280);
    }finally{if(token===request){busy=false;controller=null;controls();}}
  }
  $('directory').addEventListener('toggle',()=>{if($('directory').open&&active&&!data)void search();});
  $('search').addEventListener('click',()=>{offset=0;void search();});
  $('refresh').addEventListener('click',()=>{offset=0;void search(true);});
  $('prev').addEventListener('click',()=>{offset=Math.max(0,offset-30);void search();});
  $('next').addEventListener('click',()=>{if(data?.hasMore){offset+=30;void search();}});
  $('query').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();offset=0;void search();}});
  for(const id of ['auth','source','free'])$(id).addEventListener('change',()=>{offset=0;void search();});
  return{
    enter(){if(disposed)return;active=true;if($('directory').open&&!data)void search();},
    leave(){active=false;request++;controller?.abort();controller=null;busy=false;controls();},
    destroy(){this.leave();disposed=true;mount.replaceChildren();},
  };
}
