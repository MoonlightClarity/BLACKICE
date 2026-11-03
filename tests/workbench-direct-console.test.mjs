import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {WorkbenchDirectConsole} from '../lib/workbench-direct-console.mjs';

const fakeSpawn=(receipt,{calls}={calls:[]})=>(file,args,options)=>{
  calls.push({file,args,options});
  const child=new EventEmitter();
  child.stdin=new PassThrough();
  child.stdout=new PassThrough();
  child.stderr=new PassThrough();
  child.kill=()=>{child.killed=true};
  let request='';
  child.stdin.on('data',b=>{request+=String(b)});
  child.stdin.on('finish',()=>{
    queueMicrotask(()=>{
      const parsed=JSON.parse(request.trim());
      const answer=receipt(parsed);
      child.stdout.write(JSON.stringify({v:1,id:parsed.id,...answer})+'\n');
      child.stdout.end();
      child.emit('close',0);
    });
  });
  return child;
};

test('direct console inherits approved token, hides child and carries text through stdin only',async()=>{
  const calls=[],messages=[];
  const spawnProcess=fakeSpawn(req=>{
    messages.push(req);
    return {ok:true,result:{guest:'BLACKICE-Workbench',typed:true,characters:req.args.text.length}};
  },{calls});
  const consoleController=new WorkbenchDirectConsole({spawnProcess});
  const result=await consoleController.type('Windows guest only');
  assert.equal(result.characters,18);
  assert.equal(calls.length,1);
  assert.equal(calls[0].file,'powershell.exe');
  assert.equal(calls[0].options.windowsHide,true);
  assert.equal(calls[0].options.shell,false);
  assert.deepEqual(calls[0].options.stdio,['pipe','pipe','pipe']);
  assert.ok(calls[0].args.includes('-DirectOnce'));
  assert.ok(calls[0].args.includes('Hidden'));
  assert.equal(calls[0].args.join(' ').includes('Windows guest only'),false);
  assert.doesNotMatch(calls[0].args.join(' '),/RunAs|VMConnect|Start-Process|elevat/i);
  assert.deepEqual(messages[0].args,{text:'Windows guest only'});
  assert.equal(messages[0].op,'type');
});

test('direct console keeps the same guest-only validation and rejects other operations',async()=>{
  let called=0;
  const controller=new WorkbenchDirectConsole({spawnProcess:()=>{called++;throw Error('not expected')}});
  assert.throws(()=>controller.call('exec',{command:'Get-Process'}),{code:'WORKBENCH_CONSOLE_ARGUMENTS'});
  assert.throws(()=>controller.call('type',{text:'host\nnewline'}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.throws(()=>controller.call('click',{x:800,y:10,button:1}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.throws(()=>controller.call('key',{key:'ALT_TAB_HOST'}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.equal(called,0);
});

test('direct guest screenshot validates a bounded JPEG without host screen APIs',async()=>{
  const bytes=Buffer.alloc(120,64);bytes[0]=255;bytes[1]=216;bytes[2]=255;bytes[118]=255;bytes[119]=217;
  const controller=new WorkbenchDirectConsole({spawnProcess:fakeSpawn(()=>({
    ok:true,result:{width:800,height:600,jpeg:bytes.toString('base64')}
  }))});
  const frame=await controller.frame();
  assert.deepEqual(frame.bytes,bytes);
  assert.equal(frame.contentType,'image/jpeg');
  assert.equal(frame.width,800);
});

test('direct console preserves rejected guest receipts, never silently retries',async()=>{
  let count=0;
  const controller=new WorkbenchDirectConsole({spawnProcess:fakeSpawn(()=>{
    count++;
    return {ok:false,code:'WORKBENCH_BROKER_REJECTED',message:'Launch BLACKICE as administrator.'};
  })});
  await assert.rejects(controller.key('ENTER'),{code:'WORKBENCH_BROKER_REJECTED'});
  assert.equal(count,1);
});

test('the setup guide documents highest available rights and guest-only administrator operations',async()=>{
  const guide=await readFile(new URL('../public/next/workspaces/workbench-guide.mjs',import.meta.url),'utf8');
  const host=await readFile(new URL('../lib/windows-workbench.mjs',import.meta.url),'utf8');
  const script=await readFile(new URL('../scripts/workbench-headless-broker.ps1',import.meta.url),'utf8');
  assert.match(guide,/highestAvailable/);
  assert.match(guide,/Elevated BLACKICE on the tested administrator host/);
  assert.match(guide,/Administrator BLACKICE desktop/);
  assert.match(guide,/UAC/);
  assert.doesNotMatch(host,/new WorkbenchHeadlessBroker\(/);
  assert.match(host,/new WorkbenchDirectConsole\(/);
  assert.match(script,/if\(\$DirectOnce\)/);
  assert.match(script,/\[Console\]::In\.ReadLine\(\)/);
  assert.doesNotMatch(script,/Start-Process -Verb RunAs|SetForegroundWindow|SendInput/);
});
