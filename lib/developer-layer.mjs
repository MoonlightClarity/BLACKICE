import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const layerPath = dataDir => path.join(dataDir,'developer-layer.md');

export async function readDeveloperLayer(dataDir) {
  const file = layerPath(dataDir);
  try { return {path:file,content:await fs.readFile(file,'utf8')}; }
  catch(error) { if(error.code==='ENOENT')return {path:file,content:null}; throw error; }
}

export async function saveDeveloperLayer(dataDir,content) {
  const file = layerPath(dataDir);
  if(content===null) await fs.rm(file,{force:true});
  else {
    const temporary = file+'.'+randomUUID()+'.tmp';
    try { await fs.writeFile(temporary,content,{flag:'wx'}); await fs.rename(temporary,file); }
    finally { await fs.rm(temporary,{force:true}); }
  }
  return {path:file,content};
}
