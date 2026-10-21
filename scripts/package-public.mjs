import { promises as fs, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicSigningConfiguration, publicBuilderConfiguration, verifyPublisherSignature } from './release-signing.mjs';
import { appFingerprint } from './release-check.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), parent=path.dirname(source), outputs=path.basename(parent)==='outputs'?parent:path.join(source,'dist');
if(process.platform!=='win32')throw Error('Public Windows artifacts must be built and verified on Windows.');
const signing=await publicSigningConfiguration();
const requireCodeSigning=process.argv.includes('--require-signing');
const version=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Public packaging requires a stable numeric release version.');
const id=randomUUID(),buildRoot=path.join(source,'.build',`public-${id}`),configFile=path.join(source,'.build',`public-signing-${id}.json`),stage=path.join(outputs,`.Blackice-Public-stage-${id}`),destination=path.join(outputs,'Blackice-Public-Windows'),previous=path.join(outputs,`.Blackice-Public-previous-${id}`);
const config=publicBuilderConfiguration(signing,{source,output:buildRoot,requireCodeSigning});
let previousMoved=false,promoted=false;
await fs.mkdir(path.dirname(configFile),{recursive:true});await fs.mkdir(outputs,{recursive:true});
try{
  // This file contains public certificate selectors only. Passwords/PFX values
  // remain in the inherited signing environment and never enter build inputs.
  await fs.writeFile(configFile,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(source,'node_modules/electron-builder/cli.js'),'--win','nsis','--x64','--config',configFile,'--publish','never'],{cwd:source,env:{...process.env},stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Public packaging failed with exit code ${code}.`)));});
  const name=`Blackice-${version}-Setup.exe`,installer=path.join(buildRoot,name),application=path.join(buildRoot,'win-unpacked','BLACKICE.exe');
  if(signing.configured)for(const file of [application,installer]){const signature=await verifyPublisherSignature(file,signing.publisher);if(!signature.valid)throw Error(`The ${path.basename(file)} publisher signature was not valid (${signature.status}). The public output was left untouched.`);}
  const fingerprint=await appFingerprint(path.join(buildRoot,'win-unpacked','resources/app'));
  if(fingerprint!==await appFingerprint(source))throw Error('Application sources changed during packaging. Rebuild and retest this candidate.');
  await fs.mkdir(stage,{recursive:false});await fs.copyFile(installer,path.join(stage,name));
  const info=await fs.stat(path.join(stage,name)),digest=createHash('sha256');for await(const chunk of createReadStream(path.join(stage,name)))digest.update(chunk);
  await fs.writeFile(path.join(stage,'blackice-public-release.json'),JSON.stringify({format:1,product:'BLACKICE',version,appFingerprint:fingerprint,builtAt:new Date().toISOString(),publisher:signing.configured?signing.publisher:null,signing:{status:signing.configured?'signed':'unsigned',publisher:signing.configured?signing.publisher:null,publisherVerified:signing.configured},releasePolicy:{requireCodeSigning},artifact:{name,size:info.size,sha256:digest.digest('hex')},published:false},null,2)+'\n');
  await fs.writeFile(path.join(stage,'Read me.txt'),[`BLACKICE ${version} ${signing.configured?'signed':'unsigned'} public candidate.`,signing.configured?'Run Setup.exe. Its configured publisher was verified in Windows.':'Run Setup.exe. This installer is unsigned; Windows cannot verify an BLACKICE publisher identity.','Publication is a separate human-operated step. This command never uploads artifacts.','Run npm run release:check with matching test, installed-integrity, profile backup/restore and diagnostics receipts before publishing.','Agents execute directly without per-action permission prompts. Provided AS IS, without warranty; use at your own risk.'].join('\r\n'));
  try{await fs.rename(destination,previous);previousMoved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.rename(stage,destination);promoted=true;
  console.log(`${signing.configured?'Signed':'Unsigned'} public candidate: ${path.join(destination,name)}\nVersion: ${version}\nApplication fingerprint: ${fingerprint}\nPublisher verified: ${signing.configured?'yes':'no; unsigned'}\nPublication: not performed. Run release:check before distributing.`);
}finally{
  if(!promoted&&previousMoved){await fs.rename(previous,destination);previousMoved=false;}
  for(const generated of [buildRoot,stage,...(promoted&&previousMoved?[previous]:[])]){
    const buildSafe=path.dirname(generated)===path.join(source,'.build')&&path.basename(generated)===`public-${id}`;
    const outputSafe=path.dirname(generated)===outputs&&[`.Blackice-Public-stage-${id}`,`.Blackice-Public-previous-${id}`].includes(path.basename(generated));
    if(!buildSafe&&!outputSafe)throw Error('Public build cleanup escaped its generated boundary.');
    await fs.rm(generated,{recursive:true,force:true});
  }
  await fs.rm(configFile,{force:true});
}
