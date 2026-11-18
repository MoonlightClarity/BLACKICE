import { Worker } from 'node:worker_threads';

// One in-flight commit at the engine boundary. The worker owns SQLite, JSON
// encoding and fsync; the UI thread transfers only changed records.
export class IncrementalRunStore {
  constructor(directory) { this.directory=directory; this.pending=new Map(); this.nextId=0; this.worker=null; this.failure=null; }
  request(action, data={}) {
    if(this.failure)return Promise.reject(this.failure);
    if(!this.worker){
      const worker=this.worker=new Worker(new URL('./incremental-run-store-worker.mjs',import.meta.url),{workerData:{directory:this.directory}});
      worker.on('message',message=>{const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);if(message.error)pending.reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else pending.resolve(message.result);if(!this.pending.size)worker.unref();});
      const failed=error=>{this.failure=error;for(const pending of this.pending.values())pending.reject(error);this.pending.clear();worker.unref();};
      worker.on('error',failed);worker.on('exit',code=>{if(this.worker===worker){this.worker=null;if(this.pending.size)failed(new Error(`Run storage worker exited (${code}); commit outcome is unknown.`));}});
      worker.unref();
    }
    const id=++this.nextId;this.worker.ref();
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});try{this.worker.postMessage({id,action,...data});}catch(error){this.pending.delete(id);if(!this.pending.size)this.worker.unref();reject(error);}});
  }
  load(){return this.request('load');}
  write(batch){return this.request('write',batch);}
  async close(){if(!this.worker)return;await this.request('close');const worker=this.worker;this.worker=null;await worker?.terminate();}
}
