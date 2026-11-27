// Disposable current Runtime UI host. Uses production routes; never starts a model.
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHarnessServer} from '../../server.mjs';
class NoModelRuntime extends EventEmitter {
 status(){return {connected:false,authenticated:false,models:[],activeTurns:0};}
 async start(){return this.status();}
 async close(){}
 async runAgent(){throw Error('This isolated Runtime host must not start a model.');}
}
const directory=await mkdtemp(path.join(tmpdir(),'blackice-runtime-browser-'));
const host=await createHarnessServer({runtime:new NoModelRuntime(),dataDir:path.join(directory,'data'),defaultCwd:directory,remoteAccess:false,port:0});
const address=await host.listen(),url=address+'/#runtime',receipt=process.argv[2];
if(receipt)await writeFile(receipt,JSON.stringify({pid:process.pid,url,cwd:directory,at:new Date().toISOString()}));
process.stdout.write('RUNTIME_RENDERED_FIXTURE '+JSON.stringify({pid:process.pid,url})+'\n');
let closing=false;
async function close(){if(closing)return;closing=true;await host.close();await rm(directory,{recursive:true,force:true});process.exit(0);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
