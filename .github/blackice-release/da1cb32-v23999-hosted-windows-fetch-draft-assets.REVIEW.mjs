// BLACKICE v2.39.99 — proposed genuine GitHub-hosted Windows asset fetch.
// DO NOT execute outside an actual root-approved GitHub Actions windows-2025 job.
// Read-only GitHub release/asset downloads + immutable vendor 7za archive.
// No release creation/update, tag, workflow, installer execution, or credentials on disk.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
const REPO='MoonlightClarity/BLACKICE';
const API='api.github.com',GH='github.com';
const SOURCE='da1cb32b24b6a80eb94a1f5ab9a7992598e07201';
const TARGET='0101d3f88cc7f3f139394a1c943b899511668a90';
const RELEASE=446663182;
const TAG='v2.39.99';
const DEADLINE_MS=12*60*1000;
const ARTIFACTS=Object.freeze([
 Object.freeze({key:'installer',id:753681965,name:'Blackice-2.39.99-Setup.exe',
  bytes:115734689,sha256:'7b5d2e6c82485a97d04888c5a055691a186a8ce220b12887396ab656c5652022'}),
 Object.freeze({key:'sourcezip',id:754534773,name:'da1cb32-v23999-minimal-runner-inputs-REVIEW-002.zip',
  bytes:19515258,sha256:'2fa2fc4fd79113b7819ae7e7ab3b89ac4b25c2709997fb8a349774620b1ee606'}),
 Object.freeze({key:'compatzip',id:754540104,name:'da1cb32-v23999-sparse-git-compatibility-supplement-REVIEW-001.zip',
  bytes:24521,sha256:'d78315f5a72569153ced00c5778032a51ffca90ee50981b1387801f157186327'})
]);
const VENDOR=Object.freeze({key:'vendor',name:'7zip-win-x64.tar.gz',
 bytes:491982,sha256:'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3',
 url:'https://github.com/electron-userland/electron-builder-binaries/releases/download/7zip%401.0.0/7zip-win-x64.tar.gz',
 releasedImmutable:true,releaseId:333828656,
 resultingExecutable:'7zip/bin/7za.exe',resultingBytes:849920,
 resultingSha256:'223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3'
});
const now=()=>Date.now();
const bad=code=>Object.assign(new Error(code),{publicCode:code});
const reason=e=>(typeof e?.publicCode==='string'&&/^[a-z0-9_]{3,60}$/.test(e.publicCode))?e.publicCode:
 e?.name==='AbortError'?'deadline_abort':
 ['ECONNRESET','ETIMEDOUT','EPIPE','EAI_AGAIN','ENOTFOUND'].includes(e?.code)?
 'transport_'+e.code.toLowerCase():'unexpected_error';
const iso=()=>new Date().toISOString();
const hex=(s,len)=>typeof s==='string'&&new RegExp('^[a-f0-9]{'+len+'}$').test(s);
const sha=b=>createHash('sha256').update(b).digest('hex');
function exactHost(url,host) {
 const u=url instanceof URL?url:new URL(url);
 if(u.protocol!=='https:'||u.hostname!==host||u.port||u.username||u.password||u.hash)
  throw bad('unauthorized_https_host');
 return u;
}
function cdn(url){
 const u=url instanceof URL?url:new URL(url);
 if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||
    !u.hostname.endsWith('.githubusercontent.com')||
    u.hostname==='api.github.com')throw bad('unapproved_cdn_redirect');
 return u;
}
function remaining(deadline) {
 const d=deadline-now();
 if(d<=0)throw bad('intake_deadline_expired');
 return d;
}
function realRunner() {
 assert.equal(process.platform,'win32','Must use real Windows');
 assert.equal(process.env.GITHUB_ACTIONS,'true','Must be real Actions job');
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','Refuse self-hosted/nonrunner');
 assert.equal(process.env.GITHUB_REPOSITORY,REPO,'Wrong repository');
 assert.equal(process.env.GITHUB_SERVER_URL,'https://github.com','Refuse GHES');
 assert.equal(process.env.RUNNER_OS,'Windows','Refuse non-Windows runner');
 assert.equal(process.env.RUNNER_ARCH,'X64','Refuse other architectures');
 const workflow=process.env.EXPECTED_WORKFLOW_COMMIT;
 assert.ok(hex(workflow,40)&&process.env.GITHUB_SHA===workflow,
  'Actual workflow commit not independently approved');
 assert.ok(process.env.RUNNER_TEMP&&path.isAbsolute(process.env.RUNNER_TEMP),'No real RUNNER_TEMP');
 assert.ok(process.env.GITHUB_TOKEN&&process.env.GITHUB_TOKEN.length>15,'GitHub Actions read token absent');
 return path.resolve(process.env.RUNNER_TEMP,'b99');
}
function request(u,token,accept,deadline,signal){
 const target=u instanceof URL?u:new URL(u);
 if(token)exactHost(target,API);
 else if(target.hostname!==GH)cdn(target);
 else exactHost(target,GH);
 const headers={
  Accept:accept,
  'Accept-Encoding':'identity',
  'X-GitHub-Api-Version':'2022-11-28',
  'User-Agent':'BLACKICE-23999-exact-draft-VM-intake'
 };
 if(token)headers.Authorization='Bearer '+token;
 return new Promise((resolve,reject)=>{
  const req=https.request(target,{method:'GET',headers,agent:false,rejectUnauthorized:true,signal,
   timeout:Math.min(60000,remaining(deadline))},res=>resolve({res,target}));
  req.once('error',reject);
  req.once('timeout',()=>req.destroy(bad('https_read_timeout')));
  req.end();
 });
}
async function json(relative,token,deadline,signal){
 const url='https://'+API+relative;
 const {res}=await request(url,token,'application/vnd.github+json',deadline,signal);
 if(res.statusCode>=300&&res.statusCode<400){res.destroy();throw bad('api_redirect_disallowed');}
 let bytes=0,parts=[];
 for await(const data of res){
  bytes+=data.length;
  if(bytes>3*1024*1024){res.destroy();throw bad('api_json_size_cap');}
  parts.push(data);
 }
 let value=null;
 try{value=JSON.parse(Buffer.concat(parts,bytes).toString('utf8'));}catch{
  throw bad('api_json_invalid');
 }
 return {http:res.statusCode,data:value,
  requestId:typeof res.headers['x-github-request-id']==='string'
   ?res.headers['x-github-request-id'].slice(0,100):null};
}
function validRelease(info){
 const r=info?.data;
 return info?.http===200&&r?.id===RELEASE&&r.tag_name===TAG
  &&r.draft===true&&r.published_at===null&&r.target_commitish===TARGET
  &&typeof r.name==='string'&&r.name.includes('2.39.99')
  &&typeof r.body==='string'&&r.body.includes('DRAFT_ONLY_NOT_PUBLISHABLE')
  &&r.body.includes('LOCAL_TESTED_SOURCE_COMMIT='+SOURCE);
}
async function gateDraft(token,deadline,signal){
 const base='/repos/'+REPO;
 const release=await json(base+'/releases/'+RELEASE,token,deadline,signal);
 if(!validRelease(release))throw bad('draft_identity_changed');
 const tag=await json(base+'/git/ref/tags/'+TAG,token,deadline,signal);
 if(tag.http!==404)throw bad('git_tag_present_or_unknown');
 return {at:iso(),releaseRequestId:release.requestId,tagHttp:tag.http};
}
async function assetMetadata(token,deadline,signal) {
 const base='/repos/'+REPO+'/releases';
 const list=await json(base+'/'+RELEASE+'/assets?per_page=100',token,deadline,signal);
 if(list.http!==200||!Array.isArray(list.data)||list.data.length!==ARTIFACTS.length)
  throw bad('unexpected_release_asset_count');
 const results=[];
 for(const spec of ARTIFACTS){
  const item=list.data.filter(x=>x.id===spec.id||x.name===spec.name);
  if(item.length!==1)throw bad('missing_duplicate_or_wrong_asset');
  const x=item[0];
  if(x.id!==spec.id||x.name!==spec.name||x.state!=='uploaded'
    ||x.size!==spec.bytes||x.digest!=='sha256:'+spec.sha256)
   throw bad('asset_listing_identity_mismatch');
  const meta=await json(base+'/assets/'+spec.id,token,deadline,signal);
  if(meta.http!==200||meta.data?.id!==spec.id||
    meta.data.name!==spec.name||meta.data.state!=='uploaded'||
    meta.data.size!==spec.bytes||meta.data.digest!=='sha256:'+spec.sha256)
   throw bad('asset_metadata_identity_mismatch');
  results.push({spec,metadataRequestId:meta.requestId});
 }
 return results;
}
async function download(url,token,spec,filename,deadline,signal){
 const exists=await fs.lstat(filename).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e));
 if(exists)throw bad('existing_download_file_no_replay');
 let target=new URL(url);
 let credential=token,redirects=0,lastResponseId=null;
 for(;;){
  remaining(deadline);
  const {res}=await request(target,credential,'application/octet-stream',deadline,signal);
  if([301,302,303,307,308].includes(res.statusCode)){
   const location=res.headers.location;
   if(typeof location!=='string')throw bad('missing_download_location');
   target=cdn(new URL(location,target));
   res.resume();
   credential=null; // NEVER forward GitHub authorization to any CDN redirect.
   redirects++;
   if(redirects>3)throw bad('download_redirect_limit');
   continue;
  }
  if(res.statusCode!==200){res.destroy();throw bad('asset_download_http_not_200');}
  const contentLength=res.headers['content-length'];
  if(contentLength!==undefined&&Number(contentLength)!==spec.bytes){
   res.destroy();throw bad('download_length_header_mismatch');
  }
  lastResponseId=typeof res.headers['x-github-request-id']==='string'
   ?res.headers['x-github-request-id'].slice(0,100):null;
  const state={bytes:0,digest:createHash('sha256')};
  const bounded=new Transform({
   transform(chunk,encoding,cb){
    state.bytes+=chunk.length;
    if(state.bytes>spec.bytes){cb(bad('download_oversize'));return;}
    state.digest.update(chunk);cb(null,chunk);
   }
  });
  const output=createWriteStream(filename,{flags:'wx',mode:0o600});
  await pipeline(res,bounded,output);
  const digest=state.digest.digest('hex');
  if(state.bytes!==spec.bytes||digest!==spec.sha256)
   throw bad('downloaded_bytes_or_sha_mismatch');
  const st=await fs.stat(filename);
  if(!st.isFile()||st.size!==spec.bytes)throw bad('downloaded_file_size_mismatch');
  return {
   name:spec.name,id:spec.id||null,bytes:state.bytes,sha256:digest,
   contentType:typeof res.headers['content-type']==='string'
    ?res.headers['content-type'].slice(0,100):null,
   authorizationStrippedAfterRedirect:redirects>0,
   requestId:lastResponseId
  };
 }
}
async function run(argv){
 if(argv.length!==2||argv[0]!=='--workspace')throw bad('only_exact_workspace_cli');
 const dest=realRunner();
 if(path.resolve(argv[1]).toLowerCase()!==dest.toLowerCase())
  throw bad('workspace_must_be_short_exact_RUNNER_TEMP_b99');
 const token=process.env.GITHUB_TOKEN;
 const began=now(),deadline=began+DEADLINE_MS;
 const abort=new AbortController();
 const timer=setTimeout(()=>abort.abort(),DEADLINE_MS);
 try{
 const initial=await gateDraft(token,deadline,abort.signal);
 await fs.mkdir(dest,{recursive:false});
 const metadatas=await assetMetadata(token,deadline,abort.signal);
 const proven=[];
 for(const {spec,metadataRequestId} of metadatas){
  const data=await download('https://'+API+'/repos/'+REPO+
   '/releases/assets/'+spec.id,token,spec,path.join(dest,spec.name),deadline,abort.signal);
  proven.push({...data,metadataRequestId});
 }
 // Trusted, immutable 7zip@1.0.0 tar.gz: PUBLIC download, no GitHub token.
 const vendor=await download(VENDOR.url,null,VENDOR,path.join(dest,VENDOR.name),deadline,abort.signal);
 const final=await gateDraft(token,deadline,abort.signal);
 const receipt={
  format:1,product:'BLACKICE',kind:'genuine-hosted-readonly-draft-intake',
  at:iso(),sourceCommit:SOURCE,releaseId:RELEASE,draft:true,publishedAt:null,
  gitTagAbsent:true,actualRemoteStagingTarget:TARGET,
  distinctTestedSourceCommit:true,initialDraft:initial,finalDraft:final,
  assets:proven,vendorArchive:{
   name:VENDOR.name,bytes:vendor.bytes,sha256:vendor.sha256,
   immutableReleaseId:VENDOR.releaseId,archiveExecutableSha256:VENDOR.resultingSha256,
   archiveExecutableBytes:VENDOR.resultingBytes,
   redirectedWithoutAuthorization:vendor.authorizationStrippedAfterRedirect
  },realHostedEnvironmentAsserted:true,workflowCommit:process.env.GITHUB_SHA,
  completedAt:iso(),elapsedMs:now()-began,
  noGitHubMutation:true,noInstallerExecution:true,
  noCredentialsPersisted:true
 };
 const out=path.join(dest,'download-receipt.json');
 const h=await fs.open(out,'wx',0o600);
 try{await h.writeFile(JSON.stringify(receipt,null,2)+'\n');await h.sync();}
 finally{await h.close();}
 // Never print response bodies, token, headers or signed download redirects.
 console.log(JSON.stringify({status:'verified-draft-assets-and-vendor-archiver',
  releaseId:RELEASE,assetIds:ARTIFACTS.map(a=>a.id),
  exactInstallerSha256:ARTIFACTS[0].sha256,
  originalSourceZipSha256:ARTIFACTS[1].sha256,
  originalCompatibilityZipSha256:ARTIFACTS[2].sha256,
  vendorArchiveSha256:VENDOR.sha256,finalDraft:true,tagAbsent:true,
  receipt:out,noInstall:true}));
 }finally{clearTimeout(timer);}
}
function selftest(){
 assert.equal(ARTIFACTS.length,3);
 assert.equal(ARTIFACTS[0].id,753681965);
 assert.equal(ARTIFACTS[0].bytes,115734689);
 assert.equal(ARTIFACTS[1].id,754534773);
 assert.equal(ARTIFACTS[1].bytes,19515258);
 assert.equal(ARTIFACTS[2].id,754540104);
 assert.equal(ARTIFACTS[2].bytes,24521);
 assert.equal(VENDOR.sha256,'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3');
 assert.equal(VENDOR.resultingSha256,'223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3');
 assert.equal(validRelease({http:200,data:{id:RELEASE,tag_name:TAG,draft:true,
  published_at:null,target_commitish:TARGET,name:'BLACKICE 2.39.99 draft',
  body:'DRAFT_ONLY_NOT_PUBLISHABLE\nLOCAL_TESTED_SOURCE_COMMIT='+SOURCE}}),true);
 assert.throws(()=>exactHost('https://github.evil.example/',API));
 assert.throws(()=>cdn('http://release-assets.githubusercontent.com/x'));
 assert.throws(()=>cdn('https://evil.example/x'));
 console.log(JSON.stringify({testsPassed:11,noNetwork:true,noCredentialRead:true,
  noDraftMutation:true,noInstalledRuntime:true}));
}
try{
 if(process.argv[2]==='--selftest'&&process.argv.length===3)selftest();
 else await run(process.argv.slice(2));
}catch(e){
 console.error(JSON.stringify({status:'not_completed',reasonCode:reason(e),
  noAutomaticRetry:true,noInstallerExecution:true}));
 process.exitCode=1;
}
