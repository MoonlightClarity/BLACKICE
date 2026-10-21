import {spawn} from 'node:child_process';
import {runProfileMaintenance} from '../lib/profile-maintenance.mjs';

const [requestFile,executable,...launchArgs]=process.argv.slice(2);
if(!requestFile||!executable||launchArgs.some(value=>value.includes('\0')))process.exit(2);
try{
  const result=await runProfileMaintenance({requestFile});
  if(result.status==='cancelled')process.exit(0);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,launchArgs,{detached:true,stdio:'ignore',windowsHide:true,env});
  child.on('error',()=>{process.exitCode=1;});child.unref();
}catch{process.exitCode=1;}
