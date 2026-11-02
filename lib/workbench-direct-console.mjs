/**
 * One-shot Hyper-V guest display and input from the already-elevated BLACKICE
 * process. UAC is approved once at app launch; no privilege broker or task.
 * Child PowerShell has inherited permissions, hidden stdio, and fixed ops.
 * Guest text flows through stdin, not a process argument or host keyboard.
 */
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runHiddenWorkbenchPowerShell} from './workbench-elevated-command.mjs';
import {
  validateWorkbenchBrokerCommand,readWorkbenchBrokerReceipt
} from './workbench-headless-broker.mjs';

const scriptPath=fileURLToPath(new URL('../scripts/workbench-headless-broker.ps1',import.meta.url));
const operations=new Set(['frame','key','type','click']);
const failure=(message,code='WORKBENCH_CONSOLE_UNAVAILABLE')=>
  Object.assign(new Error(message),{code,status:503});

export class WorkbenchDirectConsole {
  constructor({spawnProcess=spawn,script=scriptPath,executable='powershell.exe',
      runElevated=runHiddenWorkbenchPowerShell}={}){
    this.spawnProcess=spawnProcess;this.script=script;this.executable=executable;
    this.runElevated=runElevated;
  }
  call(action,args={},timeoutMs=16000){
    if(!operations.has(action))throw failure('Only guest display and guest input are allowed.','WORKBENCH_CONSOLE_ARGUMENTS');
    validateWorkbenchBrokerCommand(action,args);
    const id=randomUUID(),request=JSON.stringify({v:1,id,op:action,args})+'\n';
    if(Buffer.byteLength(request)>10000)throw failure('Guest command is too large.','WORKBENCH_CONSOLE_ARGUMENTS');
    // Real Windows operations run under a separate hidden administrator token.
    // Tests can inject spawnProcess without prompting or touching the host.
    if(this.spawnProcess===spawn){
      const b64=Buffer.from(request,'utf8').toString('base64');
      const quoted=this.script.replaceAll("'","''");
      const code=[
        "$ErrorActionPreference='Stop'",
        "$command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+b64+"'))",
        "$reply=@($command | & powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File '"+quoted+"' -DirectOnce)",
        "if($LASTEXITCODE -ne 0 -or $reply.Count -ne 1){throw 'Invalid headless guest-controller receipt.'}",
        "Write-Output ([string]$reply[0])"
      ].join('\n');
      return this.runElevated(code,{timeoutMs:timeoutMs+18000})
        .then(output=>readWorkbenchBrokerReceipt(output.trim(),id,{action}));
    }
    return new Promise((resolve,reject)=>{
      let child;
      try{
        child=this.spawnProcess(this.executable,[
          '-NoProfile','-NonInteractive','-WindowStyle','Hidden',
          '-ExecutionPolicy','Bypass','-File',this.script,'-DirectOnce'
        ],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
      }catch(error){return reject(failure('Could not start headless guest operation: '+String(error.message).slice(0,160)))}
      let output='',stderr='',finished=false,dispatched=false;
      const finish=(error,result)=>{
        if(finished)return;
        finished=true;clearTimeout(timer);
        if(error){try{child.kill()}catch{}reject(error)}
        else resolve(result);
      };
      const timer=setTimeout(()=>finish(failure(
        dispatched?'Guest operation timed out after dispatch. Inspect the guest before retrying.':
          'Headless guest controller did not start.',
        dispatched?'WORKBENCH_CONSOLE_UNCERTAIN':'WORKBENCH_CONSOLE_UNAVAILABLE')),timeoutMs);
      timer.unref?.();
      child.stdout?.on('data',part=>{
        output+=part.toString('utf8');
        if(output.length>1400000)finish(failure('Guest controller response exceeded the size limit.','WORKBENCH_CONSOLE_PROTOCOL'));
      });
      child.stderr?.on('data',part=>{
        stderr=(stderr+part.toString('utf8')).slice(-2000);
      });
      child.on('error',error=>finish(failure('Headless guest controller failed: '+String(error.message).slice(0,160),
        dispatched?'WORKBENCH_CONSOLE_UNCERTAIN':'WORKBENCH_CONSOLE_UNAVAILABLE')));
      child.on('close',code=>{
        if(finished)return;
        const lines=output.trim().split(/\r?\n/).filter(Boolean);
        if(lines.length!==1)return finish(failure('Guest controller returned no unambiguous receipt. '+stderr.slice(0,120),
          dispatched?'WORKBENCH_CONSOLE_UNCERTAIN':'WORKBENCH_CONSOLE_PROTOCOL'));
        let result;
        try{result=readWorkbenchBrokerReceipt(lines[0],id,{action})}
        catch(error){return finish(error)}
        if(code!==0)return finish(failure('Guest controller ended unsuccessfully.','WORKBENCH_CONSOLE_UNCERTAIN'));
        finish(null,result);
      });
      child.stdin?.on('error',error=>finish(failure('Guest operation request was not delivered: '+String(error.message).slice(0,120),
        dispatched?'WORKBENCH_CONSOLE_UNCERTAIN':'WORKBENCH_CONSOLE_UNAVAILABLE')));
      try{child.stdin.end(request,'utf8');dispatched=true}
      catch(error){finish(failure('Guest operation was not dispatched: '+String(error.message).slice(0,120)))}
    });
  }
  async frame(){
    const result=await this.call('frame',{},24000);
    const bytes=Buffer.from(result.jpeg,'base64');
    if(bytes.length<100||bytes.length>900000||bytes[0]!==0xff||bytes[1]!==0xd8||
      bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)
      throw failure('Headless guest did not return a valid JPEG.','WORKBENCH_CONSOLE_PROTOCOL');
    if(result.width!==800||result.height!==600)
      throw failure('Headless guest frame has unexpected dimensions.','WORKBENCH_CONSOLE_PROTOCOL');
    return {bytes,contentType:'image/jpeg',width:result.width,height:result.height};
  }
  key(key){return this.call('key',{key},12000)}
  type(text){return this.call('type',{text},12000)}
  click(x,y,button=1){return this.call('click',{x,y,button},12000)}
}
