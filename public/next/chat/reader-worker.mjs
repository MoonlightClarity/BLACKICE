import { projectFamily } from './reader-model.mjs';

/** Parsing and reducing saved histories never blocks the visible Chat renderer. */
const work=new Map();
self.addEventListener('message',async event=>{
  const packet=event.data;
  if(packet?.type==='cancel'){
    work.get(packet.id)?.abort();work.delete(packet.id);return;
  }
  if(packet?.type!=='load'||!Number.isSafeInteger(packet.id)||!/^[a-zA-Z0-9_-]{1,120}$/.test(packet.runId||''))return;
  const controller=new AbortController();work.set(packet.id,controller);
  try {
    const fetchRun=async endpoint=>{
      const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('Saved conversation request failed ('+response.status+').');
      return response.json();
    };
    let family;
    try {family=await fetchRun('/api/conversations/'+encodeURIComponent(packet.runId));}
    catch(error){if(controller.signal.aborted)return;
      const run=await fetchRun('/api/runs/'+encodeURIComponent(packet.runId));family={runs:[run]};}
    const projected=projectFamily(family);
    if(work.get(packet.id)===controller)self.postMessage({id:packet.id,ok:true,family:projected});
  }catch(error){
    if(work.get(packet.id)===controller)self.postMessage({id:packet.id,ok:false,error:String(error?.message||error)});
  }finally{work.delete(packet.id);}
});
