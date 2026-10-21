import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appFingerprint} from './release-check.mjs';
import {captureSourceFiles} from './install-background-update.mjs';

const candidate=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.argv[2]||path.join(candidate,'..','qa-regression'));
if(out===candidate||out.startsWith(candidate+path.sep))throw Error('Keep verification output outside the candidate.');
await fs.mkdir(out,{recursive:true});
const report={format:1,product:'BLACKICE',version:JSON.parse(await fs.readFile(path.join(candidate,'package.json'),'utf8')).version,platform:process.platform,node:process.version,candidate,startedAt:new Date().toISOString(),runnerPid:process.pid,deadlineMs:300000};
const reportPath=path.join(out,'regression-report.json');
await fs.writeFile(path.join(out,'running.json'),JSON.stringify(report,null,2));
report.appFingerprintBefore=await appFingerprint(candidate);
report.sourceHashesBefore=await captureSourceFiles(candidate);
const tests=(await fs.readdir(path.join(candidate,'tests'))).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name);
report.testFiles=tests.length;
const logPath=path.join(out,'regression.tap'),log=await fs.open(logPath,'w');
let child,timedOut=false,timer,stopTimer;
try{
  const environment={...process.env};
  for(const key of Object.keys(environment))if(key.startsWith('RELAY_LIVE_'))environment[key]='0';
  environment.RELAY_LIVE_BROWSER_QA='0';environment.RELAY_LIVE_FIREFOX_QA='0';environment.RELAY_LIVE_UIA_QA='0';
  child=spawn(process.execPath,['--test','--test-concurrency=4','--test-timeout=60000','--test-reporter=tap',...tests],{cwd:candidate,env:environment,windowsHide:true,shell:false,stdio:['ignore',log.fd,log.fd]});
  report.childPid=child.pid;
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  timer=setTimeout(()=>{
    timedOut=true;
    if(process.platform==='win32'){
      const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
      killer.on('error',()=>child.kill('SIGKILL'));
      stopTimer=setTimeout(()=>{killer.kill('SIGKILL');child.kill('SIGKILL');},3000);
    }else child.kill('SIGKILL');
  },report.deadlineMs);
  const result=await done;report.exitCode=result.code;report.signal=result.signal;report.timedOut=timedOut;
}catch(error){report.error=error.message;report.exitCode=1;}
finally{clearTimeout(timer);clearTimeout(stopTimer);await log.close();}
const content=await fs.readFile(logPath,'utf8'),count=name=>{const values=[...content.matchAll(new RegExp('^# '+name+' (\\d+)\\r?$','gm'))];return values.length?Number(values.at(-1)[1]):null;};
report.tests={total:count('tests'),passed:count('pass'),failed:count('fail'),cancelled:count('cancelled'),skipped:count('skipped')};
report.skips=content.split(/\r?\n/).filter(line=>/# SKIP\b/.test(line));
report.failures=content.split(/\r?\n/).filter(line=>/^not ok\b/.test(line));
report.logSha256=createHash('sha256').update(content).digest('hex');
report.appFingerprintAfter=await appFingerprint(candidate);
report.sourceHashesAfter=await captureSourceFiles(candidate);
report.unchanged=report.appFingerprintBefore===report.appFingerprintAfter&&JSON.stringify(report.sourceHashesBefore)===JSON.stringify(report.sourceHashesAfter);
report.passed=report.exitCode===0&&!report.timedOut&&report.unchanged&&report.tests.total>0&&report.tests.failed===0&&report.tests.cancelled===0;
report.finishedAt=new Date().toISOString();
await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
await fs.rm(path.join(out,'running.json'),{force:true});
const {sourceHashesBefore,sourceHashesAfter,...summary}=report;
console.log(JSON.stringify({...summary,sourceFilesVerified:Object.keys(sourceHashesAfter).length},null,2));
if(!report.passed)process.exitCode=1;
