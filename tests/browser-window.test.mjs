import test from 'node:test';
import assert from 'node:assert/strict';
import {revealBrowserOS} from '../lib/browser-window.mjs';
const root='C:\\Users\\test\\AppData\\Local';
const fakeStats={isFile:()=>true,isDirectory:()=>true};
test('browser reveal is explicit-only, Windows-scoped, and never uses agent-supplied paths',async()=>{
 let invoked=0;
 const open=async(file,args,opts)=>{
  invoked++;
  assert.equal(file,'powershell.exe');assert.equal(opts.windowsHide,true);assert.ok(opts.timeout<=13000);
  assert.ok(!JSON.stringify(args).includes('linkedin.com'));
  assert.equal(opts.env.AGENT_DESK_NEO_EXE,root+'\\BrowserClaw\\Application\\chrome.exe');
  const script=Buffer.from(args.at(-1),'base64').toString('utf16le');
  assert.match(script,/SetForegroundWindow/);
  assert.match(script,/ShowWindowAsync/);
  assert.match(script,/Start-Process/);
  assert.match(script,/existing profile/);
  return {stdout:JSON.stringify({shown:true,focused:true,started:false})};
 };
 assert.deepEqual(await revealBrowserOS({platform:'win32',env:{LOCALAPPDATA:root},statImpl:async()=>fakeStats,execFileImpl:open}),{shown:true,focused:true,started:false});
 assert.equal(invoked,1);
 await assert.rejects(revealBrowserOS({platform:'linux',env:{LOCALAPPDATA:root},execFileImpl:open}),/Windows/);
 await assert.rejects(revealBrowserOS({platform:'win32',env:{LOCALAPPDATA:'relative'},execFileImpl:open}),/path/);
 assert.equal(invoked,1);
});
test('a window not yet ready returns a bounded nonintrusive result, not a false open success',async()=>{
 const result=await revealBrowserOS({platform:'win32',env:{LOCALAPPDATA:root},statImpl:async()=>fakeStats,execFileImpl:async()=>({stdout:JSON.stringify({shown:false,focused:false,started:true})})});
 assert.equal(result.shown,false);
 assert.match(result.reason,/starting/);
 await assert.rejects(revealBrowserOS({platform:'win32',env:{LOCALAPPDATA:root},statImpl:async()=>fakeStats,execFileImpl:async()=>({stdout:'not json'})}),/did not confirm/);
});
