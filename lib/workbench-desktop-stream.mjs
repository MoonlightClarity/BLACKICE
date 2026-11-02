/**
 * Interactive guest screen transport for BLACKICE Workbench.
 * A persistent guest-side JPEG encoder connects outbound to this host's
 * Hyper-V-only adapter, while the renderer sees one local authenticated MJPEG
 * stream. An SMB ring buffer is a fallback, never the preferred video path.
 */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {randomBytes} from 'node:crypto';

const BOUNDARY='blackice-guest-frame';
const fail=(message,code='WORKBENCH_DESKTOP_STREAM_UNAVAILABLE',status=503)=>
  Object.assign(new Error(message),{code,status});
const validId=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
const isJpeg=bytes=>bytes?.length>=200&&bytes.length<=4000000&&
  bytes[0]===0xff&&bytes[1]===0xd8&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9;
const safeMeta=meta=>meta?.version===1&&validId(meta.frameId)&&
  validId(meta.producerId)&&meta.filename==='frame-'+meta.frameId+'.jpg'&&
  meta.codec==='jpeg'&&Number.isInteger(meta.width)&&meta.width>=160&&meta.width<=7680&&
  Number.isInteger(meta.height)&&meta.height>=120&&meta.height<=4320&&
  Number.isInteger(meta.bytes)&&meta.bytes>=200&&meta.bytes<=4000000&&
  typeof meta.at==='string'&&Number.isFinite(Date.parse(meta.at));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function hyperVHostIPv4(interfaces=os.networkInterfaces()){
  for(const [name,adapters] of Object.entries(interfaces)){
    if(!/^vEthernet \(Default Switch\)$/i.test(name))continue;
    const entry=(adapters||[]).find(a=>a.family==='IPv4'&&!a.internal&&a.address);
    if(entry)return entry.address;
  }
  return null;
}
export class WorkbenchDesktopStream{
  constructor({sharedRoot,clock=Date.now,intervalMs=55,fsImpl=fs,netImpl=net}={}){
    if(typeof sharedRoot!=='string'||!path.isAbsolute(sharedRoot))
      throw fail('Desktop video needs a configured workspace.','WORKBENCH_STREAM_ROOT',500);
    this.root=path.join(path.resolve(sharedRoot),'.blackice-workbench','desktop-stream');
    this.clock=clock;this.files=fsImpl;this.net=netImpl;
    this.intervalMs=Math.max(35,Math.min(200,intervalMs));
    this.clients=new Set();this.timer=null;this.heartbeat=null;this.busy=false;this.closed=false;
    this.viewerNonce=randomBytes(12).toString('hex');
    this.networkToken=randomBytes(24).toString('hex');
    this.listener=null;this.listenInfo=null;this.sockets=new Set();
    this.liveFrame=null;this.cached=null;this.lastFrameAt=null;this.lastError=null;
    this.writingViewer=Promise.resolve();
  }
  async startNetwork({hostIp=hyperVHostIPv4(),port=18941}={}){
    if(this.closed||this.listener)return this.listenInfo;
    if(!hostIp)return null;
    if(!net.isIP(hostIp))throw fail('Invalid Hyper-V host adapter IP.','WORKBENCH_STREAM_BIND',400);
    const server=this.net.createServer(socket=>this.acceptSocket(socket));
    try{
      await new Promise((resolve,reject)=>{
        const failed=error=>{server.removeListener('listening',resolve);reject(error)};
        server.once('error',failed);
        server.listen(port,hostIp,()=>{server.removeListener('error',failed);resolve()});
      });
      this.listener=server;
      const address=server.address();
      this.listenInfo={hostIp,port:address.port,mode:'guest-outbound-tcp'};
      const settings={version:1,hostIp,port:address.port,token:this.networkToken,
        at:new Date(this.clock()).toISOString()};
      await this.files.mkdir(this.root,{recursive:true});
      await this.files.writeFile(path.join(this.root,'transport.json'),JSON.stringify(settings),'utf8');
      this.lastError=null;return this.listenInfo;
    }catch(error){
      this.lastError='Guest TCP listener unavailable: '+String(error.message||error).slice(0,180);
      try{server.close()}catch{}
      if(this.listener===server)this.listener=null;
      this.listenInfo=null;
      return null;
    }
  }
  acceptSocket(socket){
    if(this.closed||this.sockets.size>=2){socket.destroy();return}
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let buf=Buffer.alloc(0),authorized=false;
    const discard=()=>this.sockets.delete(socket);
    socket.on('close',discard);
    socket.on('error',()=>discard());
    socket.on('data',chunk=>{
      if(this.closed)return socket.destroy();
      if(chunk.length>4500000||buf.length+chunk.length>8000000)return socket.destroy();
      buf=Buffer.concat([buf,chunk]);
      if(!authorized){
        const lf=buf.indexOf(10);
        if(lf<0){if(buf.length>120)socket.destroy();return}
        const greeting=buf.subarray(0,lf).toString('ascii').trim();
        if(greeting!=='BIV1 '+this.networkToken)return socket.destroy();
        authorized=true;buf=buf.subarray(lf+1);
      }
      while(buf.length>=8){
        const len=buf.readUInt32BE(0),width=buf.readUInt16BE(4),height=buf.readUInt16BE(6);
        if(len<200||len>4000000||width<160||height<120||width>7680||height>4320)
          return socket.destroy();
        if(buf.length<8+len)return;
        const jpeg=buf.subarray(8,8+len);
        buf=buf.subarray(8+len);
        if(!isJpeg(jpeg))return socket.destroy();
        const receivedAt=this.clock();
        const frame={frameId:randomBytes(16).toString('hex'),producerId:'direct-tcp',
          bytes:jpeg,width,height,codec:'jpeg',at:new Date(receivedAt).toISOString()};
        this.liveFrame=frame;this.lastFrameAt=receivedAt;this.lastError=null;
      }
    });
  }
  async latest({maxAgeMs=5500}={}){
    if(this.liveFrame&&this.clock()-this.lastFrameAt<Math.min(2700,maxAgeMs))return this.liveFrame;
    let raw;
    try{raw=await this.files.readFile(path.join(this.root,'latest.json'),'utf8')}
    catch(error){if(error.code==='ENOENT')return null;throw error}
    let meta;
    try{meta=JSON.parse(raw)}catch{return null}
    if(!safeMeta(meta))return null;
    const age=this.clock()-Date.parse(meta.at);
    if(age < -5000||age>maxAgeMs)return null;
    if(this.cached?.frameId===meta.frameId)return this.cached;
    let bytes;
    try{bytes=await this.files.readFile(path.join(this.root,meta.filename))}
    catch(error){if(error.code==='ENOENT')return null;throw error}
    if(!isJpeg(bytes)||bytes.length!==meta.bytes)return null;
    const frame={bytes,frameId:meta.frameId,producerId:meta.producerId,at:meta.at,
      width:meta.width,height:meta.height,codec:'jpeg'};
    this.cached=frame;this.lastFrameAt=this.clock();this.lastError=null;
    return frame;
  }
  status(){
    return {mode:this.listenInfo?'guest-tcp-mjpeg':'guest-smb-mjpeg',
      subscribers:this.clients.size,tcpConnected:this.sockets.size>0,
      lastFrameId:this.liveFrame?.frameId||this.cached?.frameId||null,
      lastFrameAt:this.lastFrameAt,
      width:this.liveFrame?.width||this.cached?.width||null,
      height:this.liveFrame?.height||this.cached?.height||null,lastError:this.lastError};
  }
  async viewerHeartbeat(active){
    if(this.closed&&active)return;
    const target=path.join(this.root,'viewer.json');
    const tmp=path.join(this.root,'viewer-'+this.viewerNonce+'.tmp');
    const value=JSON.stringify({version:1,active,viewer:this.viewerNonce,at:new Date(this.clock()).toISOString()});
    const op=this.writingViewer.catch(()=>{}).then(async()=>{
      await this.files.mkdir(this.root,{recursive:true});
      await this.files.writeFile(tmp,value,'utf8');
      await this.files.rename(tmp,target);
    });
    this.writingViewer=op.catch(error=>{this.lastError=String(error.message||error).slice(0,180)});
    await this.writingViewer;
  }
  async poll(){
    if(this.closed||this.busy||!this.clients.size)return;
    this.busy=true;
    try{
      const frame=await this.latest();
      if(!frame)return;
      for(const viewer of [...this.clients]){
        const res=viewer.res;
        if(res.destroyed||res.writableEnded){this.clients.delete(viewer);continue}
        if(viewer.frameId===frame.frameId||res.writableLength>1024*1024)continue;
        const header=Buffer.from('--'+BOUNDARY+'\r\nContent-Type: image/jpeg\r\nContent-Length: '+
          frame.bytes.length+'\r\nX-Frame-ID: '+frame.frameId+
          '\r\nX-Guest-Width: '+frame.width+'\r\nX-Guest-Height: '+frame.height+'\r\n\r\n');
        try{
          res.write(header);res.write(frame.bytes);res.write('\r\n');
          viewer.frameId=frame.frameId;
        }catch{this.clients.delete(viewer);try{res.end()}catch{}}
      }
    }catch(error){this.lastError=String(error.message||error).slice(0,180)}
    finally{this.busy=false;if(!this.clients.size)this.stop()}
  }
  start(){
    if(this.closed||this.timer)return;
    void this.viewerHeartbeat(true);
    this.heartbeat=setInterval(()=>void this.viewerHeartbeat(true),1300);
    this.heartbeat.unref?.();
    this.timer=setInterval(()=>void this.poll(),this.intervalMs);
    this.timer.unref?.();
    void this.poll();
  }
  stop(){
    if(this.clients.size)return;
    if(this.timer){clearInterval(this.timer);this.timer=null}
    if(this.heartbeat){clearInterval(this.heartbeat);this.heartbeat=null}
    if(!this.closed)void this.viewerHeartbeat(false);
  }
  stream(req,res){
    if(this.closed)throw fail('Guest video is shutting down.');
    if(this.clients.size>=4)throw fail('Too many VM viewers.','WORKBENCH_STREAM_LIMIT',429);
    res.writeHead(200,{
      'Content-Type':'multipart/x-mixed-replace; boundary='+BOUNDARY,
      'Cache-Control':'no-store, no-cache, must-revalidate','Pragma':'no-cache',
      'X-Content-Type-Options':'nosniff','Connection':'keep-alive','X-Accel-Buffering':'no'
    });
    res.flushHeaders?.();
    const client={res,frameId:null};
    this.clients.add(client);
    const cleanup=()=>{if(this.clients.delete(client)&&!this.clients.size)this.stop()};
    req.once('close',cleanup);res.once('close',cleanup);
    this.start();return client;
  }
  async waitForFrame({timeoutMs=3000}={}){
    const end=this.clock()+timeoutMs;
    while(this.clock()<end){
      const data=await this.latest();
      if(data)return data;
      await wait(100);
    }
    return null;
  }
  async close(){
    if(this.closed)return;
    this.closed=true;
    if(this.timer){clearInterval(this.timer);this.timer=null}
    if(this.heartbeat){clearInterval(this.heartbeat);this.heartbeat=null}
    for(const {res} of this.clients){try{res.end()}catch{}}
    this.clients.clear();
    for(const socket of this.sockets)socket.destroy();
    this.sockets.clear();
    if(this.listener){
      const server=this.listener;this.listener=null;
      await new Promise(resolve=>server.close(()=>resolve()));
    }
    await this.viewerHeartbeat(false);
    await this.writingViewer.catch(()=>{});
  }
}
