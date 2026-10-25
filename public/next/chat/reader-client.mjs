export function createConversationReader({api,WorkerClass=globalThis.Worker,timeoutMs=45000}={}) {
  let worker=null,closed=false,sequence=0;
  const pending=new Map();
  const interrupted=()=>new DOMException('Cancelled','AbortError');
  const disable=error=>{
    const old=worker;worker=null;
    try{old?.terminate();}catch{}
    for(const item of pending.values())item.reject(error||Error('Conversation reader stopped.'));
    pending.clear();
  };
  if(typeof WorkerClass==='function')try{
    worker=new WorkerClass('/next/chat/reader-worker.mjs',{type:'module',name:'BLACKICE conversations'});
    worker.addEventListener('message',event=>{
      const data=event.data,item=pending.get(data?.id);
      if(!item)return;
      if(data.ok&&data.family)item.resolve(data.family);
      else item.reject(Error(data.error||'Could not open this conversation.'));
    });
    worker.addEventListener('error',()=>disable(Error('Conversation reader unavailable.')));
    worker.addEventListener('messageerror',()=>disable(Error('Conversation reader sent invalid data.')));
  }catch{worker=null;}
  async function load(runId,{signal}={}){
    if(closed)throw Error('Conversation reader closed.');
    if(typeof runId!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(runId))throw Error('Invalid saved conversation.');
    if(signal?.aborted)throw interrupted();
    // Never parse full saved conversations on the interactive renderer thread.
    if(!worker)throw Error('The background conversation reader is unavailable. Reload the workspace to retry.');
    try {
      return await new Promise((resolve,reject)=>{
        const id=++sequence;
        let done=false,timeout;
        const end=(error,result)=>{
          if(done)return;done=true;
          clearTimeout(timeout);signal?.removeEventListener('abort',abort);
          pending.delete(id);
          if(error)reject(error);else resolve(result);
        };
        const abort=()=>{
          try{worker?.postMessage({type:'cancel',id});}catch{}
          end(interrupted());
        };
        pending.set(id,{resolve:value=>end(null,value),reject:error=>end(error)});
        signal?.addEventListener('abort',abort,{once:true});
        timeout=setTimeout(()=>{
          try{worker?.postMessage({type:'cancel',id});}catch{}
          end(Error('Loading the saved conversation took too long.'));
        },timeoutMs);
        try{worker.postMessage({type:'load',id,runId});}catch(error){disable(error);}
      });
    }catch(error){
      if(signal?.aborted)throw interrupted();
      if(!worker)throw Error('The background conversation reader stopped. Reload the workspace to retry.');
      throw error;
    }
  }
  return{load,get usingWorker(){return !!worker;},close(){
    if(closed)return;closed=true;disable(Error('Conversation reader closed.'));
  }};
}
