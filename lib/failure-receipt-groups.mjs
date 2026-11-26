import {createHash} from 'node:crypto';
import {failureFingerprint,failureUnclassified} from '../public/next/chat/tool-failure.mjs';

const hash=value=>'fg-'+createHash('sha256').update(value).digest('hex');
const at=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const text=(value,max=120)=>typeof value==='string'?value.slice(0,max):'';
const mutation=new Set(['click','fill','select','press','type','upload','submit','send','write','delete','navigate','run','run_js','append','patch']);
const memberKey=row=>row?.failure?failureFingerprint(row.failure):JSON.stringify(['legacy',row.runId||'',row.id||'']);
export const failureGroupId=row=>hash(memberKey(row));
function attention(meta,legacy=false){
 if(legacy||failureUnclassified(meta))return 'unclassified';
 if(meta.actionDispatched===false||meta.inputDispatched===false)return 'input not dispatched';
 if(mutation.has(meta.action))return 'effect not confirmed';
 return 'other failure';
}
const priority=label=>({'unclassified':0,'effect not confirmed':1,'other failure':2,'input not dispatched':3})[label]??4;
const matches=(meta,q)=>[meta.tool,meta.action,meta.code,meta.nodeId,meta.exitCode].filter(v=>v!==null&&v!==undefined).join('\n').toLocaleLowerCase().includes(q);
const recentSort=(a,b)=>(Date.parse(b.lastAt)||0)-(Date.parse(a.lastAt)||0)||a.groupId.localeCompare(b.groupId);
function groupFor(map,key,meta,runId){
 let item=map.get(key);
 if(!item){
  item={groupId:key,meta:{tool:text(meta.tool),action:text(meta.action),code:text(meta.code),nodeId:text(meta.nodeId),
    ...(typeof meta.actionDispatched==='boolean'?{actionDispatched:meta.actionDispatched}:{}),
    ...(typeof meta.inputDispatched==='boolean'?{inputDispatched:meta.inputDispatched}:{}),
    ...(Number.isSafeInteger(meta.exitCode)?{exitCode:meta.exitCode}:{})},
   count:0,recoveredCount:0,retained:0,firstAt:null,lastAt:null,runIds:new Set(),sample:null,attention:attention(meta,!meta.code),historical:false};
  map.set(key,item);
 }
 if(runId)item.runIds.add(runId);
 return item;
}
const setTime=(entry,first,last)=>{
 if(at(first)&&(!entry.firstAt||Date.parse(first)<Date.parse(entry.firstAt)))entry.firstAt=first;
 if(at(last)&&(!entry.lastAt||Date.parse(last)>Date.parse(entry.lastAt)))entry.lastAt=last;
};
const rowMatches=(row,q)=>!q||[row.id,row.title,row.text,row.nodeId,row.runId].filter(Boolean).join('\n').toLocaleLowerCase().includes(q);

/** Group before pagination; preserve outlier categories even after their individual
 * receipts roll over. Exact occurrence drilldown uses the original saved rows.
 * Legacy event-only failures have no trusted fingerprint and are never merged. */
export function failureGroupProjection(rows,{distinct=false,group=null,q='',summaries=[],offset=0,limit=30}={}){
 const retained=rows.filter(row=>rowMatches(row,q));
 const map=new Map();
 for(const source of summaries){
  for(const kind of source.kinds||[]){
   if(q&&!matches(kind,q))continue;
   const key=hash(failureFingerprint(kind));
   const entry=groupFor(map,key,kind,source.runId);
   entry.historical=true;
   entry.count=Math.min(Number.MAX_SAFE_INTEGER,entry.count+kind.count);
   entry.recoveredCount=Math.min(Number.MAX_SAFE_INTEGER,entry.recoveredCount+(kind.recoveredCount||0));
   setTime(entry,kind.firstAt,kind.lastAt);
  }
 }
 for(const row of retained){
  const key=failureGroupId(row),existing=map.has(key);
  const meta=row.failure||{nodeId:row.nodeId,tool:row.title,code:null};
  const entry=groupFor(map,key,meta,row.runId);
  if(!existing||!entry.historical){entry.count++;if(row.failure?.recovered===true)entry.recoveredCount++;}
  entry.retained++;
  if(!entry.sample||Date.parse(row.at)>Date.parse(entry.sample.at))entry.sample=row;
  if(!row.failure)entry.attention='unclassified';
  setTime(entry,row.at,row.at);
 }
 const all=[...map.values()];
 all.sort((a,b)=>priority(a.attention)-priority(b.attention)||recentSort(a,b));
 const displayed=all.map(entry=>{
  const count=entry.count,code=entry.meta.code||'Unclassified',label=[entry.meta.tool,entry.meta.action].filter(Boolean).join(' / ')||'Tool failure';
  const details={tool:entry.meta.tool,action:entry.meta.action,code,nodeId:entry.meta.nodeId,
    count,retainedOccurrences:entry.retained,firstSeenAt:entry.firstAt,lastSeenAt:entry.lastAt,
    followedByMatchingToolSuccess:entry.recoveredCount,
    withoutRecordedMatchingSuccess:Math.max(0,count-entry.recoveredCount),
    turns:entry.runIds.size,attention:entry.attention,individualReceiptsAvailable:entry.retained>0,
    ...(entry.count>entry.retained?{olderOccurrencesNotIndividuallyRetained:entry.count-entry.retained}:{})};
  return{id:entry.groupId,groupId:entry.groupId,view:'failures',grouped:true,
   title:label+' · '+code+' · '+count+' occurrence'+(count===1?'':'s'),
   text:JSON.stringify(details,null,2),count,retainedCount:entry.retained,
   firstAt:entry.firstAt,at:entry.lastAt,lastAt:entry.lastAt,attention:entry.attention,
   source:entry.historical?'saved distinct failure index':'saved failure receipts',runCount:entry.runIds.size};
 });
 const selected=group?all.find(item=>item.groupId===group):null;
 if(group){
  const original=retained.filter(row=>failureGroupId(row)===group);
  return{items:original.slice(offset,offset+limit),totalMatches:original.length,
    nextOffset:offset+limit<original.length?offset+limit:null,
    occurrenceTotal:selected?.count??original.length,groupCount:all.length,
    selectedGroup:group,availableOccurrences:original.length,groupSummary:selected?{count:selected.count,retained:selected.retained,attention:selected.attention}:null};
 }
 if(distinct){
  return{items:displayed.slice(offset,offset+limit),totalMatches:displayed.length,
    nextOffset:offset+limit<displayed.length?offset+limit:null,
    occurrenceTotal:displayed.reduce((sum,row)=>sum+row.count,0),
    groupCount:displayed.length,unclassifiedGroups:displayed.filter(row=>row.attention==='unclassified').length,
    distinct:true};
 }
 return{items:retained.slice(offset,offset+limit),totalMatches:retained.length,
   nextOffset:offset+limit<retained.length?offset+limit:null,occurrenceTotal:retained.length};
}
