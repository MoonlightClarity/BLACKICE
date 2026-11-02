import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {WorkbenchVMConnectHost} from '../desktop/workbench-vmconnect-host.mjs';

const makeFake=()=>{
 const calls=[],spawns=[];
 const state={connected:false,shown:false,userInput:false,childHwnd:'12345',parentHwnd:'123',
   pid:9900,vm:'BLACKICE-Workbench',width:0,height:0,x:0,y:0};
 const spawnImpl=(executable,args,opts)=>{
   const child=new EventEmitter();
   child.stdout=new EventEmitter();child.stderr=new EventEmitter();
   child.stdout.setEncoding=()=>{};
   child.stdin={
     write(message){
       const command=JSON.parse(message);
       calls.push(command);
       let result;
       if(command.action==='attach'){
         state.connected=true;state.parentHwnd=command.parent;
         Object.assign(state,{x:command.x,y:command.y,width:command.width,height:command.height});
         result={...state};
       }else if(command.action==='visible'){
         state.shown=command.visible;result={...state};
       }else if(command.action==='input'){
         state.userInput=command.enabled;result={...state};
       }else if(command.action==='bounds'){
         Object.assign(state,{x:command.x,y:command.y,width:command.width,height:command.height});
         result={...state};
       }else if(command.action==='close'){
         state.connected=false;state.shown=false;result={viewerClosed:true,vmPreserved:true};
       }else{result={...state}}
       setImmediate(()=>child.stdout.emit('data',JSON.stringify({ok:true,requestId:command.requestId,result})+'\n'));
       return true;
     },
     end(){}
   };
   child.kill=()=>child.emit('exit',0);
   spawns.push({executable,args,opts,child});
   return child;
 };
 const getWindow=()=>{
   const buffer=Buffer.alloc(8);buffer.writeBigUInt64LE(123n);
   return {getNativeWindowHandle:()=>buffer,getContentSize:()=>[1200,800],isDestroyed:()=>false};
 };
 return {spawnImpl,getWindow,calls,spawns,state};
};
test('Microsoft native VMConnect launches one hidden helper, retains a single native child and re-shows after renderer reload',async()=>{
 const fake=makeFake(),host=new WorkbenchVMConnectHost({spawnImpl:fake.spawnImpl,getWindow:fake.getWindow});
 const first=await host.perform({action:'attach',vmId:'11111111-2222-4333-8444-555555555555',bounds:{x:5,y:80,width:1120,height:650}},fake.getWindow());
 assert.equal(first.connected,true);
 assert.equal(first.shown,true,'first attach must show the native child');
 assert.equal(fake.spawns.length,1);
 assert.equal(fake.spawns[0].executable,'powershell.exe');
 assert.equal(fake.spawns[0].opts.windowsHide,true);
 assert.equal(fake.spawns[0].opts.shell,false);
 assert.equal(fake.calls[0].parent,'123');
 await host.perform({action:'visible',visible:false},fake.getWindow());
 assert.equal(fake.state.shown,false);
 const attached=await host.perform({action:'attach',vmId:'11111111-2222-4333-8444-555555555555',bounds:{x:8,y:90,width:1080,height:610}},fake.getWindow());
 assert.equal(attached.shown,true,'reconnecting to a hidden child must show it');
 assert.equal(fake.spawns.length,1,'hidden reattach must never launch another VMConnect process');
 assert.equal(attached.width,1080);
 await host.perform({action:'input',enabled:true},fake.getWindow());
 assert.equal(fake.state.userInput,true);
 await host.perform({action:'input',enabled:false},fake.getWindow());
 assert.equal(fake.state.userInput,false);
 await host.close();
 assert.equal(fake.state.connected,false);
 assert.equal(host.closed,true);
 assert.equal(fake.calls.filter(a=>a.action==='close').length,1);
});
test('native VMConnect rejects malformed or out-of-window geometry without spawning',async()=>{
 const fake=makeFake(),host=new WorkbenchVMConnectHost({spawnImpl:fake.spawnImpl,getWindow:fake.getWindow});
 await assert.rejects(host.perform({action:'attach',bounds:{x:0,y:0,width:20000,height:650}},fake.getWindow()),/bounds/);
 await assert.rejects(host.perform({action:'attach',bounds:{x:1100,y:50,width:500,height:650}},fake.getWindow()),/exceeds/);
 await assert.rejects(host.perform({action:'vmconnect',target:'localhost'},fake.getWindow()),/Unsupported/);
 assert.equal(fake.spawns.length,0);
});
