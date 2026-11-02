import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
import {WorkbenchGuestResolution,selectWorkbenchGuestMode} from '../lib/workbench-guest-resolution.mjs';
const modes=[[640,480],[800,600],[1024,768],[1280,720],[1280,800],[1600,900],[1920,1080]].map(([width,height])=>({width,height,bpp:32,frequency:60}));
async function fixture(options={}){
  const control=new WorkbenchConsoleControl(),claim=await control.take(),timers=new Map(),calls=[];let now=0,nextId=0;
  const f={native:{connected:true,displayReady:true,windowVisible:true,windowMinimized:false,windowForeground:false,workbenchWindowHwnd:'123',viewport:{width:1280,height:800,revision:1},surface:{width:1024,height:768}},
    agent:{paired:true,agentId:'fixture-agent',guestSessionId:2,capabilities:['display_info','display_resize']},control,claim,calls,timers};
  f.workbench={consoleControl:control,status:async()=>({guest:{running:true,agent:{...f.agent}}}),
    guestAction:request=>control.run(async assertCurrent=>{
      assertCurrent();calls.push(request);
      if(options.beforeAction)await options.beforeAction(request,f);
      assertCurrent();
      let result;
      if(request.kind==='display_info')result={supported:true,remoteSession:false,current:{width:1024,height:768,bpp:32},modes};
      else{result={confirmed:true,changed:true,actual:{...request.args,bpp:32}};if(!options.noNativeConfirmation)f.native.surface={width:request.args.width,height:request.args.height};}
      return {status:'completed',agentId:f.agent.agentId,guestSessionId:2,result,...options.response};
    },request.controlToken)};
  f.resolution=new WorkbenchGuestResolution({workbench:f.workbench,getNativeStatus:async()=>structuredClone(f.native),clock:()=>now,
    pause:async ms=>{now+=ms;},setTimer:(fn,delay)=>{const id=++nextId;timers.set(id,{fn,delay});return id;},clearTimer:id=>timers.delete(id)});
  f.resolution.configure({enabled:true,controlToken:claim.controlToken});
  f.flush=async()=>{const [id,timer]=[...timers].at(-1);timers.delete(id);now+=timer.delay;await timer.fn();};
  f.dispose=()=>f.resolution.close();return f;
}

test('mode policy chooses an enumerated 32bpp fit without arbitrary or oversized mode attempts',()=>{
  assert.deepEqual(selectWorkbenchGuestMode(modes,{width:1900,height:1000}),{width:1600,height:900});
  assert.deepEqual(selectWorkbenchGuestMode(modes,{width:4096,height:4096}),{width:1920,height:1080});
  assert.equal(selectWorkbenchGuestMode([{width:800,height:600,bpp:16}],{width:800,height:600}),null);
  assert.throws(()=>selectWorkbenchGuestMode(modes,{width:5000,height:1000}));
});
test('debounced automatic fit uses current USER token, physical pixels and guest plus native confirmation without requiring foreground',async t=>{
  const f=await fixture();t.after(f.dispose);f.resolution.observe(f.native);
  assert.equal([...f.timers.values()][0].delay,400);assert.equal(f.calls.length,0);
  await f.flush();assert.deepEqual(f.calls.map(c=>c.kind),['display_info','display_resize']);
  assert.deepEqual(f.calls[1].args,{width:1280,height:800,guestSessionId:2});
  assert.deepEqual(f.calls[1].expectedAgent,{agentId:'fixture-agent',guestSessionId:2});
  assert.equal(f.calls[1].controlToken,f.claim.controlToken);assert.equal(f.resolution.status().state,'applied');
  assert.deepEqual(f.control.status(),{owner:'user',revision:f.claim.revision});
  f.resolution.observe(f.native);assert.equal(f.timers.size,0,'Repeated native status does not reapply.');
});
test('resize storms retain only latest viewport and enforce one-second minimum between mode applications',async t=>{
  const f=await fixture();t.after(f.dispose);f.resolution.observe(f.native);
  f.native.viewport={width:1600,height:900,revision:2};f.resolution.observe(f.native);assert.equal(f.timers.size,1);
  await f.flush();assert.equal(f.calls.at(-1).args.width,1600);
  f.native.viewport={width:1920,height:1080,revision:3};f.resolution.observe(f.native);
  assert.equal([...f.timers.values()][0].delay,1000);await f.flush();assert.equal(f.calls.at(-1).args.width,1920);
});
test('matching native surface does not apply another mode; hidden, minimized or tiny viewports never resize',async t=>{
  const f=await fixture();t.after(f.dispose);f.native.surface={width:1280,height:800};f.resolution.observe(f.native);await f.flush();
  assert.deepEqual(f.calls.map(c=>c.kind),['display_info']);
  for(const change of [{windowVisible:false},{windowMinimized:true},{viewport:{width:320,height:200,revision:5}}]){
    f.resolution.observe({...f.native,...change});assert.equal(f.timers.size,0);
  }
});
test('stale tokens, AGENT and NONE cannot configure or dispatch automatic resolution',async t=>{
  const f=await fixture();t.after(f.dispose);await f.control.cede(f.claim.controlToken);
  f.resolution.observe(f.native);assert.equal(f.timers.size,0);assert.equal(f.resolution.status().state,'paused');
  assert.throws(()=>f.resolution.configure({enabled:true,controlToken:f.claim.controlToken}));
  const next=await f.control.take();assert.throws(()=>f.resolution.configure({enabled:true,controlToken:f.claim.controlToken}));
  f.resolution.configure({enabled:true,controlToken:next.controlToken});
  await f.control.failClosed(Error('fixture'),[]).catch(()=>{});f.resolution.observe(f.native);assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);
});
test('viewport changes during inventory and replaced guest-agent identities cannot apply stale modes',async t=>{
  const f=await fixture({beforeAction:async(request,f)=>{if(request.kind==='display_info')f.native.viewport={width:1600,height:900,revision:2};}});t.after(f.dispose);
  f.resolution.observe(f.native);await f.flush();assert.deepEqual(f.calls.map(c=>c.kind),['display_info']);assert.equal(f.resolution.status().state,'waiting');
  const g=await fixture({beforeAction:async(request,f)=>{f.agent.agentId='replacement';}});t.after(g.dispose);
  g.resolution.observe(g.native);await g.flush();assert.equal(g.calls.length,1);assert.equal(g.resolution.status().code,'WORKBENCH_RESOLUTION_UNCONFIRMED');
});
test('unconfirmed guest response or decoded surface preserves scaled view and never retries unchanged geometry',async t=>{
  for(const options of [{noNativeConfirmation:true},{response:{status:'pending'}}]){
    const f=await fixture(options);t.after(f.dispose);f.resolution.observe(f.native);await f.flush();
    assert.equal(f.resolution.status().state,'scaled');assert.equal(f.resolution.status().code,'WORKBENCH_RESOLUTION_UNCONFIRMED');
    f.resolution.observe(f.native);assert.equal(f.timers.size,0);
  }
});
test('disabling or closing cancels pending geometry without input, wake or lifecycle operations',async t=>{
  const f=await fixture();t.after(f.dispose);f.resolution.observe(f.native);f.resolution.configure({enabled:false});assert.equal(f.timers.size,0);
  f.resolution.configure({enabled:true,controlToken:f.claim.controlToken});f.resolution.observe(f.native);f.resolution.close();assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);
});
test('native desktop actions take precedence over the slower legacy guest action path',async t=>{
  const f=await fixture();t.after(f.dispose);let nativeCalls=0;
  const original=f.workbench.guestAction;
  f.workbench.guestNativeDesktopAction=function(value){assert.equal(this,f.workbench);nativeCalls++;return original(value);};
  f.workbench.guestAction=()=>assert.fail('An attached native desktop must use its bounded display action path.');
  f.resolution.observe(f.native);await f.flush();assert.equal(nativeCalls,2);assert.equal(f.resolution.status().state,'applied');
});
