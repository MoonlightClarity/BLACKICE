import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {prepareSourceTestTemp} from './source-test-temp.mjs';
const environment=await prepareSourceTestTemp();
const files=['browser-resource-resilience','chatgpt-connector-http','connection-startup','distribution','next-static-route','operations-http','planning-behavior','provider-activation-server','windows-release-inputs'].map(x=>'tests/'+x+'.test.mjs');
const startedAt=new Date().toISOString();
const r=spawnSync(process.execPath,['--test','--test-concurrency=4','--test-reporter=tap',...files],{encoding:'utf8',maxBuffer:30*1024*1024,timeout:480000,windowsHide:true});
const tap=r.stdout||'',lines=tap.split(/\r?\n/),failures=[];
for(let i=0;i<lines.length;i++)if(/^not ok /.test(lines[i])){let j=i+1;while(j<lines.length&&!/^# Subtest:|^ok \d|^not ok \d|^1\.\./.test(lines[j]))j++;failures.push(lines.slice(i,j).join('\n'));}
const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(k=>[k,Number(tap.match(new RegExp('^# '+k+' (\\d+)','m'))?.[1]??NaN)]));
const result={source:process.env.GITHUB_SHA,startedAt,finishedAt:new Date().toISOString(),environment,files,concurrency:4,exitCode:r.status,signal:r.signal,error:r.error?.message,counts,failures,stderr:(r.stderr||'').slice(-12000),scope:'Targeted disposable Windows fixtures; no installed app; production deadlines unchanged'};
await fs.mkdir('verification/diagnostics',{recursive:true});
await fs.writeFile('verification/diagnostics/terminal-targeted.json',JSON.stringify(result,null,2)+'\n');
await fs.writeFile('terminal-targeted.tap',tap);
console.log(JSON.stringify({counts,failures,exitCode:r.status}));
