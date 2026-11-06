import { PROVIDER_PRESETS, PROVIDER_CATALOG_REVIEWED_AT } from '../public/provider-catalog.mjs';

/**
 * Search model API services, not individual models within a saved gateway.
 * Sources: reviewed BLACKICE adapters + the public models.dev provider index.
 * An indexed protocol or price is not a tested connection or inference entitlement.
 */
const INDEX_URL='https://models.dev/api.json';
const CACHE_MS=10*60_000, FAILURE_MS=60_000, MAX_BYTES=32_000_000;
let cached=null, inFlight=null;
const trimmed=(v,max=300)=>typeof v==='string'?v.trim().slice(0,max):'';
const sourceURL=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
const zero=value=>typeof value==='number'&&Number.isFinite(value)&&value===0;
const builtin=p=>({
  id:'builtin:'+p.id,name:p.name,source:'supported',preset:p.id,supported:true,providerId:p.id,
  baseUrl:p.baseUrl||'',protocol:p.type,protocolLabel:p.protocolLabel||p.type,
  authentication:p.anonymous?'keyless':p.requiresApiKey?'keyed':p.id==='ollama'?'keyless':'optional',
  documentationUrl:p.docsUrl||'',keyUrl:p.keyUrl||'',referenceUrl:'',
  description:p.authNote||'',modelCount:null,zeroPriceModels:null,toolModels:null,modelIds:[],
  freeModelsDeclared:p.freeOnly===true,reviewedAt:PROVIDER_CATALOG_REVIEWED_AT,
  compatibility:'reviewed-adapter',
});
export function normalizeModelsDevIndex(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('External model provider index returned an invalid document.');
  const results=[];
  for(const [id,entry] of Object.entries(raw).slice(0,700)){
    if(!/^[a-z0-9_-]{1,100}$/i.test(id)||!entry||typeof entry!=='object'||Array.isArray(entry))continue;
    const models=entry.models&&typeof entry.models==='object'&&!Array.isArray(entry.models)?Object.entries(entry.models):[];
    const env=Array.isArray(entry.env)?entry.env.filter(v=>typeof v==='string'&&v.length<100):[];
    const api=sourceURL(entry.api),docs=sourceURL(entry.doc),site=sourceURL(entry.website);
    const compatible=entry.npm==='@ai-sdk/openai-compatible';
    results.push({
      id:'index:'+id,name:trimmed(entry.name,100)||id,source:'models.dev',providerId:id,preset:null,
      supported:false,baseUrl:api,protocol:compatible?'compatible':'unverified',
      protocolLabel:compatible?'Index-reported OpenAI compatibility':'API protocol not verified for BLACKICE',
      authentication:env.length?'keyed':'unverified',
      documentationUrl:docs||site||'https://models.dev/providers/'+encodeURIComponent(id)+'/',
      referenceUrl:'https://models.dev/providers/'+encodeURIComponent(id)+'/',
      keyUrl:'',modelCount:models.length,modelIds:models.map(([key])=>trimmed(key,200)).filter(Boolean),
      zeroPriceModels:models.reduce((n,[,m])=>n+(zero(m?.cost?.input)&&zero(m?.cost?.output)?1:0),0),
      toolModels:models.reduce((n,[,m])=>n+(m?.tool_call===true?1:0),0),
      freeModelsDeclared:false,
      description:compatible?'Reported OpenAI-compatible base URL. Actual catalog, credentials and chat requests require validation.':'Reference entry only. BLACKICE does not yet have a validated adapter for this protocol.',
      reviewedAt:null,compatibility:compatible&&api?'index-reported-compatible':'unverified',
    });
  }
  return results;
}
async function readIndex({fetchImpl=fetch,now=Date.now,refresh=false}={}){
  const at=now();
  if(!refresh&&cached&&cached.expiresAt>at)return cached;
  if(inFlight)return inFlight;
  inFlight=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetchImpl(INDEX_URL,{method:'GET',headers:{Accept:'application/json'},signal:controller.signal});
      if(!response.ok)throw Error('External provider directory returned HTTP '+response.status+'.');
      const type=trimmed(response.headers?.get?.('content-type')||'',200);
      if(type&&!type.includes('json'))throw Error('External provider directory did not return JSON.');
      const length=Number(response.headers?.get?.('content-length'));
      if(Number.isFinite(length)&&length>MAX_BYTES)throw Error('External provider directory exceeds the size limit.');
      const body=await response.text();
      if(Buffer.byteLength(body,'utf8')>MAX_BYTES)throw Error('External provider directory exceeds the size limit.');
      const entries=normalizeModelsDevIndex(JSON.parse(body));
      cached={entries,checkedAt:new Date(now()).toISOString(),expiresAt:now()+CACHE_MS,stale:false,warning:null};
    }catch{
      cached=cached?.entries?.length
        ? {...cached,stale:true,warning:'Could not refresh the external index. These entries are from the last successful fetch.',expiresAt:now()+FAILURE_MS}
        :{entries:[],checkedAt:null,expiresAt:now()+FAILURE_MS,stale:true,warning:'External directory is unavailable; reviewed BLACKICE connections remain searchable.'};
    }finally{clearTimeout(timer);}
    return cached;
  })();
  try{return await inFlight;}finally{inFlight=null;}
}
const validFilters=({query='',auth='any',source='all',offset=0,limit=30,freeModelsOnly=false}={})=>{
  if(typeof query!=='string'||query.length>160||!['any','keyed','keyless','optional','unverified'].includes(auth)
    ||!['all','supported','index'].includes(source)||!Number.isSafeInteger(offset)||offset<0
    ||!Number.isSafeInteger(limit)||limit<1||limit>80||typeof freeModelsOnly!=='boolean')
    throw Object.assign(Error('Invalid model provider search filters.'),{status:400,code:'INVALID_MODEL_PROVIDER_SEARCH'});
  return {query,auth,source,offset,limit,freeModelsOnly};
};
const score=(entry,words)=>{
  const name=entry.name.toLowerCase(),provider=entry.providerId.toLowerCase(),base=entry.baseUrl.toLowerCase();
  return words.reduce((sum,w)=>sum+(name===w||provider===w?12:name.startsWith(w)?9:name.includes(w)?7:base.includes(w)?3:1),0)
    +(entry.supported?2:0);
};
export function searchProviderEntries(options={},external=[]){
  const {query,auth,source,offset,limit,freeModelsOnly}=validFilters(options);
  const supported=PROVIDER_PRESETS.filter(p=>!p.hidden&&!p.deprecated&&p.id!=='compatible').map(builtin);
  const ids=new Set(supported.map(p=>p.providerId));
  const listed=external.filter(p=>!ids.has(p.providerId));
  const entries=source==='supported'?supported:source==='index'?listed:[...supported,...listed];
  const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches=entries.filter(entry=>(auth==='any'||entry.authentication===auth)
    &&(!freeModelsOnly||entry.freeModelsDeclared||entry.zeroPriceModels>0)
    &&words.every(word=>[entry.name,entry.providerId,entry.baseUrl,entry.description,entry.protocolLabel,...entry.modelIds]
      .filter(Boolean).join(' ').toLowerCase().includes(word)))
    .sort((a,b)=>score(b,words)-score(a,words)||a.name.localeCompare(b.name,'en'));
  return {
    total:matches.length,offset,limit,hasMore:offset+limit<matches.length,
    items:matches.slice(offset,offset+limit).map(({modelIds,...entry})=>({
      ...entry,
      matchedModelIds:words.length?modelIds.filter(id=>words.some(w=>id.toLowerCase().includes(w))).slice(0,5):[],
    })),
  };
}
/** External reference data; no saved keys, requests or profile details are sent. */
export async function searchAPIProviderDirectory(options={},deps={}){
  validFilters(options);
  const index=options.source==='supported'?{entries:[],checkedAt:null,stale:false,warning:null}:await readIndex({...deps,refresh:options.refresh===true});
  return {...searchProviderEntries(options,index.entries),indexCheckedAt:index.checkedAt,indexStale:index.stale,
    warning:index.warning,referenceSource:INDEX_URL,verificationNote:'External provider listings are not tested inference connections. Check a draft before saving.'};
}
export function resetProviderDirectoryCache(){cached=null;inFlight=null;}
