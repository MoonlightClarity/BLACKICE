/**
 * Hyper-V runs in a hidden, one-shot PowerShell administrator child while the
 * Electron host remains asInvoker for Chromium renderer startup.
 * Tested Windows configuration: UAC consent Never notify, EnableLUA=1.
 * The PS code and guest input stay in a private temporary request file, never
 * on the process command line. No VMConnect, host input or window activation.
 */
import {promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
const helper=fileURLToPath(new URL('../desktop/workbench-elevated-command.ps1',import.meta.url));
const failure=(message,code='WORKBENCH_ADMINISTRATOR_UNAVAILABLE')=>
  Object.assign(new Error(message),{code,status:503});

export async function runHiddenWorkbenchPowerShell(script,{executeFile=execute,helperPath=helper,
    temporaryRoot=tmpdir(),timeoutMs=30000}={}){
  if(process.platform!=='win32')
    throw failure('Headless Hyper-V operations require Windows.','WORKBENCH_WINDOWS_ONLY');
  if(typeof script!=='string'||!script.trim()||script.length>60000)
    throw failure('Invalid bounded Workbench PowerShell request.','WORKBENCH_ADMINISTRATOR_ARGUMENTS');
  const id=randomUUID(),folder=await fs.mkdtemp(path.join(temporaryRoot,'blackice-hyperv-'));
  const requestPath=path.join(folder,'request.json'),responsePath=path.join(folder,'receipt.json');
  try{
    await fs.writeFile(requestPath,JSON.stringify({version:1,id,script}),'utf8');
    let processFailure=null;
    try{
      await executeFile('powershell.exe',[
        '-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden',
        '-ExecutionPolicy','Bypass','-File',helperPath,
        '-RequestPath',requestPath,'-ResponsePath',responsePath
      ],{windowsHide:true,shell:false,timeout:timeoutMs,maxBuffer:32768,encoding:'utf8'});
    }catch(error){processFailure=error}
    let reply;
    try{
      const bytes=await fs.readFile(responsePath);
      if(bytes.length>1700000)throw Error('Reply exceeded bounds.');
      reply=JSON.parse(bytes.toString('utf8'));
    }catch{
      throw failure(
        processFailure?'Hidden Hyper-V operation failed or timed out; inspect before repeating.':
          'Hidden Hyper-V operation returned no valid receipt.',
        processFailure?'WORKBENCH_ADMINISTRATOR_UNCERTAIN':'WORKBENCH_ADMINISTRATOR_PROTOCOL');
    }
    if(reply?.version!==1||reply.id!==id||typeof reply.ok!=='boolean')
      throw failure('Hidden Hyper-V receipt identity did not match.','WORKBENCH_ADMINISTRATOR_PROTOCOL');
    if(!reply.ok)
      throw failure(String(reply.message||'Administrator operation was rejected.').slice(0,450),
        'WORKBENCH_ADMINISTRATOR_REJECTED');
    if(processFailure)
      throw failure('Hidden Hyper-V command returned a receipt but its process failed; inspect before repeating.',
        'WORKBENCH_ADMINISTRATOR_UNCERTAIN');
    if(typeof reply.output!=='string'||reply.output.length>1600000)
      throw failure('Invalid bounded administrator output.','WORKBENCH_ADMINISTRATOR_PROTOCOL');
    return reply.output;
  }finally{await fs.rm(folder,{recursive:true,force:true}).catch(()=>{})}
}
