'use strict';
const {execute}=require('./qualification-driver.cjs');
const names=new Set(['journal','connection','now','config','scaffold','observations','admission','result','result-pages','artifact','payload','capture','provider-thread','policy-input','evidence-dir','failure-observation','snapshot-manifest','reason']);
function main(argv){
 const [command,...rest]=argv;if(!command)throw Error('Qualification command required');const options={};
 for(let i=0;i<rest.length;i+=2){
  const key=rest[i]?.match(/^--([a-z-]+)$/)?.[1];
  if(!key||!names.has(key)||rest[i+1]===undefined)throw Error('Expected supported qualification option/value pairs');
  const name=key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());if(Object.hasOwn(options,name))throw Error('Duplicate option: '+key);options[name]=rest[i+1];
 }
 return execute(command,options);
}
module.exports={main};
if(require.main===module){
 try{const result=main(process.argv.slice(2));process.stdout.write(JSON.stringify(result)+'\n');if(result.ok===false)process.exitCode=2;}
 catch(error){process.stdout.write(JSON.stringify({ok:false,scorable:false,purpose:'instruction-workflow-qualification',policyReviewRequired:true,error:{code:error.code||null,message:error.message}})+'\n');process.exitCode=1;}
}
