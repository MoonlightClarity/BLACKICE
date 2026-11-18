import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ConnectionManager} from '../lib/mcp.mjs';
const exec=promisify(execFile);
async function root(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'browser-publication-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('independent processes publish one complete browser extraction without changing archive',async t=>{
 const dir=await root(t), archive=JSON.stringify({version:1,connections:[{id:'browseros-neo',name:'BrowserOS neo',transport:'http',url:'http://127.0.0.1:9000/mcp'}]});
 await fs.writeFile(path.join(dir,'connections.json'),archive);
 const source=`import {ConnectionManager} from ${JSON.stringify(new URL('../lib/mcp.mjs',import.meta.url).href)};const m=await new ConnectionManager({dataDir:${JSON.stringify(dir)}}).init();if(m.list().length!==1)throw Error('incomplete extraction');await m.close();`;
 await Promise.all(Array.from({length:8},()=>exec(process.execPath,['--input-type=module','-e',source])));
 assert.equal(await fs.readFile(path.join(dir,'connections.json'),'utf8'),archive);
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'browser-connections','settings.json'),'utf8')).connections.length,1);
 assert.deepEqual((await fs.readdir(dir)).sort(),['browser-connections','connections.json']);
});
test('failed publication preserves archive, removes owned staging and remains restartable',async t=>{
 const dir=await root(t),archive='{"version":1,"connections":[]}';
 await fs.writeFile(path.join(dir,'connections.json'),archive);
 const rename=fs.rename;fs.rename=async(from,to)=>{if(to===path.join(dir,'browser-connections'))throw Object.assign(Error('injected publication failure'),{code:'EIO'});return rename(from,to);};
 try{await assert.rejects(new ConnectionManager({dataDir:dir}).init(),{code:'EIO'});}finally{fs.rename=rename;}
 assert.deepEqual(await fs.readdir(dir),['connections.json']);
 assert.equal(await fs.readFile(path.join(dir,'connections.json'),'utf8'),archive);
 const m=await new ConnectionManager({dataDir:dir}).init();await m.close();
});
test('Windows first-save stress uses ordinary replaceable published files',async t=>{
 const dir=await root(t);
 for(let i=0;i<150;i++){const m=await new ConnectionManager({dataDir:path.join(dir,String(i))}).init();try{
 for(let n=0;n<3;n++)await m.save({id:'browseros-neo',name:'BrowserOS neo',transport:'http',url:'http://127.0.0.1:'+ (9000+n)+'/mcp'});
 const saved=JSON.parse(await fs.readFile(m.file,'utf8'));assert.equal(saved.connections[0].url,'http://127.0.0.1:9002/mcp');
 }finally{await m.close();}}
});

