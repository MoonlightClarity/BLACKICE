import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const require=createRequire(import.meta.url);
const {validateHiddenWindow,validateHiddenStatus,readHiddenNativeControls,proveHiddenClose}=require('../verification/probe-workbench-native-hidden.cjs');
const status=()=>({detached:true,connected:true,displayReady:true,windowVisible:false,inputOwner:'agent',inputSequence:0,wakeRequests:0,
  workbenchWindowHwnd:'101',childHwnd:'102',windowCloseRevision:0});
function fixture(){
  let current=status(),owner='agent';const worker={pid:42,exitCode:null,killed:false};
  const viewer={native:{worker},status:async()=>({...current})};
  const workbench={consoleControl:{status:()=>({owner})},adapter:{frame:async()=>({bytes:Buffer.alloc(54),width:16,height:16,sequence:1})}};
  return {viewer,workbench,worker,get current(){return current},set current(value){current=value},set owner(value){owner=value}};
}
test('hidden native identity rejects visibility, topmost, wrong parent/process, input or wake activity',()=>{
  const value={root:'101',child:'102',rootAlive:true,childAlive:true,rootPid:42,childPid:42,actualParent:'101',rootVisible:false,childVisible:false,rootTopmost:false,childStyleIsChild:true};
  assert.equal(validateHiddenWindow(value,{root:'101',child:'102',pid:42}).windowHidden,true);
  for(const changed of [{rootVisible:true},{childVisible:true},{rootTopmost:true},{rootPid:43},{actualParent:'999'}])
    assert.throws(()=>validateHiddenWindow({...value,...changed},{root:'101',child:'102',pid:42}));
  validateHiddenStatus(status(),'101');
  for(const changed of [{windowVisible:true},{inputOwner:'user'},{inputSequence:1},{wakeRequests:1},{workbenchWindowHwnd:'999'}])
    assert.throws(()=>validateHiddenStatus({...status(),...changed},'101'));
});
test('hidden WM_CLOSE retains the exact helper, decoded frame and owner without requesting Show',async()=>{
  const f=fixture();let posts=0;
  const result=await proveHiddenClose({...f,postClose:async(root,pid)=>{posts++;assert.equal(root,'101');assert.equal(pid,42);f.current={...f.current,windowCloseRevision:1}},pause:async()=>{}});
  assert.equal(posts,1);assert.equal(result.windowNeverShown,true);assert.equal(result.sameHelperPid,true);assert.equal(result.agentFrameApiAvailable,true);
});
test('raw hidden toolbar proof bypasses acceptance filtering while pinning the exact helper instance and HWNDs',async()=>{
  const f=fixture();f.current.controls={available:true,enabled:false};f.viewer.native.status=async()=>({...f.current});
  f.viewer.status=async()=>({...f.current,controls:{available:false}});
  const proof=await readHiddenNativeControls({viewer:f.viewer,worker:f.worker,root:'101',child:'102'});
  assert.equal(proof.controls.available,true);assert.equal(proof.sameNativeInstanceVerified,true);assert.equal(proof.helperPid,42);
  assert.equal((await f.viewer.status()).controls.available,false,'Product receipt remains acceptance gated');
  for(const mode of ['worker','instance','root','child','visible','unavailable','uncertain','cached']){
    const changed=fixture();changed.current.controls={available:true};
    changed.viewer.native.status=async()=>{
      if(mode==='worker')changed.viewer.native.worker={...changed.worker,pid:43};
      if(mode==='instance')changed.viewer.native={...changed.viewer.native};
      return {...changed.current,...(mode==='root'?{workbenchWindowHwnd:'999'}:mode==='child'?{childHwnd:'999'}:
        mode==='visible'?{windowVisible:true}:mode==='unavailable'?{controls:{available:false}}:mode==='uncertain'?{uncertain:true}:mode==='cached'?{cached:true}:{})};
    };
    await assert.rejects(readHiddenNativeControls({viewer:changed.viewer,worker:changed.worker,root:'101',child:'102'}),mode);
  }
});
test('hidden lifecycle refuses changed owner/helper, missing close acknowledgement or lost decoded frame',async()=>{
  for(const mode of ['owner','helper','ack','frame']){
    const f=fixture();await assert.rejects(proveHiddenClose({...f,pause:async()=>{},postClose:async()=>{
      f.current={...f.current,windowCloseRevision:mode==='ack'?0:1};
      if(mode==='owner')f.owner='user';if(mode==='helper')f.viewer.native.worker={...f.worker,pid:43};
      if(mode==='frame')f.workbench.adapter.frame=async()=>({bytes:Buffer.alloc(0),width:16,height:16,sequence:1});
    }}));
  }
});
test('hidden probe source contains no show, topmost, desktop capture, input, wake or ownership transfer paths',async()=>{
  const source=await fs.readFile('verification/probe-workbench-native-hidden.cjs','utf8');
  assert.match(source,/showOnAttach:false/);assert.match(source,/show:false/);assert.match(source,/window-all-closed/);
  assert.doesNotMatch(source,/showInactive\(|\.show\(|ShowWindow\(|SetWindowPos\(|alwaysOnTop:|disableHardwareAcceleration|desktopCapturer|wakeDisplay\(|\.take\(|\.cede\(|agentInput\(/);
});
test('actual Electron entry smoke creates no native helper or test window',{skip:process.platform!=='win32',timeout:15000},async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-hidden-native-entry-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)).toLowerCase(),path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('blackice-hidden-native-entry-'));await fs.rm(root,{recursive:true,force:true})});
  const output=path.join(root,'entry.json');
  const {stdout}=await promisify(execFile)(path.resolve('node_modules/electron/dist/electron.exe'),
    [path.resolve('verification/probe-workbench-native-hidden.cjs'),'--entry-smoke','--output='+output],{windowsHide:true,timeout:12000,maxBuffer:32768});
  assert.equal(JSON.parse(stdout.trim()).passed,true);const report=JSON.parse(await fs.readFile(output,'utf8'));
  assert.equal(report.vmHelperStarted,false);assert.equal(report.windowCreated,false);assert.equal(report.guestInputSent,0);assert.equal(report.hostInputSent,0);
});
