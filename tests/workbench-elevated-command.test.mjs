import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runHiddenWorkbenchPowerShell} from '../lib/workbench-elevated-command.mjs';
import {WorkbenchDirectConsole} from '../lib/workbench-direct-console.mjs';

const fixture=async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-elev-helper-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
};

test('hidden Hyper-V helper uses a private request file and checks a matching receipt',async t=>{
  const folder=await fixture(t);
  const calls=[];
  const output=await runHiddenWorkbenchPowerShell("'WORKBENCH_READ_ONLY'",{
    temporaryRoot:folder,executeFile:async (program,args,options)=>{
      calls.push({program,args,options});
      assert.equal(program,'powershell.exe');
      assert.deepEqual(args.slice(0,6),['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy']);
      assert.equal(options.windowsHide,true);
      assert.equal(options.shell,false);
      const input=JSON.parse(await readFile(args[args.indexOf('-RequestPath')+1],'utf8'));
      assert.equal(input.script,"'WORKBENCH_READ_ONLY'");
      assert.equal(args.join(' ').includes('WORKBENCH_READ_ONLY'),false);
      const receipt=args[args.indexOf('-ResponsePath')+1];
      await writeFile(receipt,JSON.stringify({version:1,id:input.id,ok:true,output:'WORKBENCH_READ_ONLY'}));
      return {stdout:'',stderr:''};
    }
  });
  assert.equal(output,'WORKBENCH_READ_ONLY');
  assert.equal(calls.length,1);
  assert.deepEqual(await readdir(folder),[],'Per-operation request/receipt files are cleaned up');
});

test('hidden Hyper-V helper refuses a mismatched receipt instead of trusting output',async t=>{
  const folder=await fixture(t);
  await assert.rejects(runHiddenWorkbenchPowerShell("'READ_ONLY'",{
    temporaryRoot:folder,executeFile:async (_program,args)=>{
      await writeFile(args[args.indexOf('-ResponsePath')+1],JSON.stringify({
        version:1,id:'00000000-0000-4000-8000-000000000001',ok:true,output:'not verified'
      }));
      return {stdout:'',stderr:''};
    }
  }),{code:'WORKBENCH_ADMINISTRATOR_PROTOCOL'});
  assert.deepEqual(await readdir(folder),[]);
});

test('hidden Hyper-V helper reports an uncertain launch without silently retrying',async t=>{
  const folder=await fixture(t);let calls=0;
  await assert.rejects(runHiddenWorkbenchPowerShell("'READ_ONLY'",{
    temporaryRoot:folder,executeFile:async()=>{
      calls++;throw Error('Helper launch denied');
    }
  }),{code:'WORKBENCH_ADMINISTRATOR_UNCERTAIN'});
  assert.equal(calls,1);
  assert.deepEqual(await readdir(folder),[]);
});

test('real guest-console route delegates to one elevated helper and only guest-scoped actions',async()=>{
  const calls=[];
  const controller=new WorkbenchDirectConsole({runElevated:async script=>{
    const match=script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
    assert.ok(match,'Guest command must be carried through an encoded input request');
    const request=JSON.parse(Buffer.from(match[1],'base64').toString('utf8'));
    calls.push({script,request});
    return JSON.stringify({v:1,id:request.id,ok:true,result:{guest:'BLACKICE-Workbench',typed:true,characters:request.args.text.length}});
  }});
  const reply=await controller.type('guest text only');
  assert.equal(reply.typed,true);
  assert.equal(reply.characters,15);
  assert.equal(calls.length,1);
  assert.equal(calls[0].request.op,'type');
  assert.ok(calls[0].script.includes('powershell.exe'));
  assert.ok(calls[0].script.includes('-DirectOnce'));
  assert.equal(calls[0].script.includes('guest text only'),false);
});
