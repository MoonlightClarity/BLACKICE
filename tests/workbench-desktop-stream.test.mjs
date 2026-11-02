import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {WorkbenchDesktopStream,hyperVHostIPv4} from '../lib/workbench-desktop-stream.mjs';

const jpg=Buffer.concat([Buffer.from([0xff,0xd8]),Buffer.alloc(600,34),Buffer.from([0xff,0xd9])]);
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function eventually(predicate,limit=1400){
  const until=Date.now()+limit;
  while(Date.now()<until){
    const value=await predicate();
    if(value)return value;
    await wait(25);
  }
  throw Error('Guest stream test did not observe the expected frame.');
}
async function fixture(t){
  const workspace=await mkdtemp(path.join(tmpdir(),'blackice-video-stream-test-'));
  const video=new WorkbenchDesktopStream({sharedRoot:workspace,intervalMs:40});
  t.after(async()=>{await video.close();await rm(workspace,{recursive:true,force:true})});
  return {workspace,video,root:path.join(workspace,'.blackice-workbench','desktop-stream')};
}
test('Hyper-V guest interface selection is exact, not a general host network bind',()=>{
  assert.equal(hyperVHostIPv4({'Ethernet':[{family:'IPv4',address:'192.168.1.2',internal:false}],
    'vEthernet (Default Switch)':[{family:'IPv4',address:'172.23.80.1',internal:false}]}),'172.23.80.1');
  assert.equal(hyperVHostIPv4({'Ethernet':[{family:'IPv4',address:'1.2.3.4',internal:false}]}),null);
});
test('guest sends bounded real JPEG frames over a persistent authenticated Hyper-V TCP socket',async t=>{
  const {video,root}=await fixture(t);
  const info=await video.startNetwork({hostIp:'127.0.0.1',port:0});
  assert.equal(info.mode,'guest-outbound-tcp');
  const {token}=JSON.parse(await readFile(path.join(root,'transport.json'),'utf8'));
  assert.match(token,/^[a-f0-9]{48}$/);
  const socket=net.createConnection(info.port,'127.0.0.1');
  t.after(()=>socket.destroy());
  await new Promise(ok=>socket.once('connect',ok));
  socket.write('BIV1 '+token+'\n');
  const header=Buffer.alloc(8);
  header.writeUInt32BE(jpg.length,0);
  header.writeUInt16BE(1024,4);header.writeUInt16BE(768,6);
  socket.write(Buffer.concat([header,jpg]));
  const frame=await eventually(()=>video.latest({maxAgeMs:2000}));
  assert.equal(frame.width,1024);
  assert.equal(frame.height,768);
  assert.deepEqual(frame.bytes,jpg);
  assert.equal(video.status().tcpConnected,true);
  const req=new EventEmitter(),parts=[];
  const res=new EventEmitter();
  Object.assign(res,{destroyed:false,writableEnded:false,writableLength:0,
    writeHead(code,headers){this.statusCode=code;this.headers=headers},
    flushHeaders(){},write(chunk){parts.push(Buffer.from(chunk));return true},
    end(){this.writableEnded=true;this.emit('close')}});
  video.stream(req,res);
  await eventually(()=>parts.some(p=>p.includes(Buffer.from('X-Guest-Width: 1024'))));
  assert.equal(res.statusCode,200);
  assert.match(res.headers['Content-Type'],/multipart\/x-mixed-replace/);
  assert.ok(Buffer.concat(parts).includes(jpg));
  req.emit('close');
  assert.equal(video.status().subscribers,0);
});
test('guest image fallback rejects stale, malformed and unverified JPEG frames',async t=>{
  const {video,root}=await fixture(t);
  await mkdir(root,{recursive:true});
  const id='a'.repeat(32);
  const filename='frame-'+id+'.jpg';
  const manifest={version:1,frameId:id,filename,producerId:'b'.repeat(32),
    at:new Date().toISOString(),width:1024,height:768,bytes:jpg.length,codec:'jpeg'};
  await writeFile(path.join(root,filename),jpg);
  await writeFile(path.join(root,'latest.json'),JSON.stringify(manifest));
  assert.equal((await video.latest()).width,1024);
  video.cached=null;
  await writeFile(path.join(root,'latest.json'),JSON.stringify({...manifest,filename:'../../bad.jpg'}));
  assert.equal(await video.latest(),null);
  video.cached=null;
  await writeFile(path.join(root,'latest.json'),JSON.stringify({...manifest,at:new Date(Date.now()-15000).toISOString()}));
  assert.equal(await video.latest(),null);
  video.cached=null;
  await writeFile(path.join(root,'latest.json'),JSON.stringify({...manifest,bytes:9999}));
  assert.equal(await video.latest(),null);
});
