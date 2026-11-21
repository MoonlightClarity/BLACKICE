'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),c=require('node:crypto');
const pin=require('./build-inputs.json');
const [action,root,arg]=process.argv.slice(2);
if(!action||!p.isAbsolute(root||''))throw Error('Usage: prepare-build.cjs fetch|extract|verify-source <absolute-evidence-root> [asset-name]');
const hash=b=>c.createHash('sha256').update(b).digest('hex');
function save(file,obj){const txt=JSON.stringify(obj,null,2)+'\n';fs.mkdirSync(p.dirname(file),{recursive:true});const tmp=file+'.stage-'+process.pid;const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,txt);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);if(fs.readFileSync(file,'utf8')!==txt)throw Error('READBACK:'+file);return {path:file,sha256:hash(txt)};}
function run(exe,args,cwd){const r=cp.spawnSync(exe,args,{cwd,encoding:'utf8',timeout:110000,maxBuffer:5e6});const receipt={exe,args,cwd,status:r.status,signal:r.signal,error:r.error?.message||null,stdout:r.stdout||'',stderr:r.stderr||''};save(p.join(root,'receipts','command-'+Date.now()+'.json'),receipt);if(r.status!==0||r.signal||r.error)throw Error('COMMAND_FAILED:'+JSON.stringify(receipt));return receipt;}
function verified(a){const file=p.join(root,'downloads',a.filename);const b=fs.readFileSync(file),sha=hash(b);if(a.sha256&&sha!==a.sha256)throw Error('HASH:'+a.name);if(a.bytes&&b.length!==a.bytes)throw Error('SIZE:'+a.name);return {file,sha256:sha,bytes:b.length};}
async function main(){
 fs.mkdirSync(root,{recursive:true});
 if(action==='fetch'){
   const a=arg==='source'?{...pin.source,name:'source'}:pin.assets.find(x=>x.name===arg);if(!a)throw Error('UNKNOWN_ASSET');
   const file=p.join(root,'downloads',a.filename);fs.mkdirSync(p.dirname(file),{recursive:true});
   if(fs.existsSync(file)){const v=verified(a);if(a.name==='source'){const old=JSON.parse(fs.readFileSync(p.join(root,'receipts','download-source.json'),'utf8'));if(old.sha256!==v.sha256)throw Error('SOURCE_ARCHIVE_CHANGED');}console.log(JSON.stringify({existing:true,...v}));return;}
   const res=await fetch(a.url,{signal:AbortSignal.timeout(90000),headers:{'User-Agent':'BLACKICE-pinned-native-trace-build'}});if(!res.ok)throw Error('HTTP:'+res.status);
   const b=Buffer.from(await res.arrayBuffer());if(b.length>300000000)throw Error('DOWNLOAD_TOO_LARGE');
   const sha=hash(b);if(a.sha256&&sha!==a.sha256)throw Error('HASH_MISMATCH');if(a.bytes&&a.bytes!==b.length)throw Error('SIZE_MISMATCH');
   const tmp=file+'.partial-'+process.pid;const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);
   const receipt={schema:'blackice.minicpm.trace-download.v1',at:new Date().toISOString(),name:a.name,url:a.url,finalUrl:res.url.split('?')[0],commit:a.commit||null,publisherExpectedSha256:a.sha256||null,...verified(a)};
   save(p.join(root,'receipts','download-'+a.name+'.json'),receipt);console.log(JSON.stringify(receipt));return;
 }
 if(action==='extract'){
   const tools=p.join(root,'tools');fs.mkdirSync(tools,{recursive:true});
   const a=arg==='source'?{...pin.source,name:'source'}:pin.assets.find(x=>x.name===arg);if(!a)throw Error('UNKNOWN_ASSET');const v=verified(a);
   const dest=arg==='source'?p.join(root,'source'):arg==='ninja'?p.join(tools,'ninja'):tools;
   const target=arg==='source'?p.join(dest,'llama.cpp-'+pin.source.commit):arg==='w64devkit'?p.join(tools,'w64devkit'):arg==='cmake'?p.join(tools,'cmake-4.5.1-windows-x86_64'):p.join(dest,'ninja.exe');
   if(fs.existsSync(target))throw Error('EXTRACT_TARGET_EXISTS:'+target);
   fs.mkdirSync(dest,{recursive:true});
   if(arg==='w64devkit')run(v.file,['-y','-o'+dest],root);
   else run('tar.exe',['-xf',v.file,'-C',dest],root);
   if(!fs.existsSync(target))throw Error('EXTRACT_TARGET_MISSING:'+target);
   const receipt={schema:'blackice.minicpm.trace-extract.v1',at:new Date().toISOString(),asset:v,target};save(p.join(root,'receipts','extract-'+arg+'.json'),receipt);console.log(JSON.stringify(receipt));return;
 }
 if(action==='verify-source'){
   const source=p.join(root,'source','llama.cpp-'+pin.source.commit);const files=Object.entries(pin.source.expectedFiles).map(([rel,expected])=>{const b=fs.readFileSync(p.join(source,rel)),actual=hash(b);if(actual!==expected)throw Error('SOURCE_FILE_HASH:'+rel);return{path:rel,sha256:actual,bytes:b.length};});
   const tools={gcc:p.join(root,'tools','w64devkit','bin','gcc.exe'),gxx:p.join(root,'tools','w64devkit','bin','g++.exe'),dlltool:p.join(root,'tools','w64devkit','bin','dlltool.exe'),cmake:p.join(root,'tools','cmake-4.5.1-windows-x86_64','bin','cmake.exe'),ninja:p.join(root,'tools','ninja','ninja.exe')};
   const identities=Object.fromEntries(Object.entries(tools).map(([k,file])=>[k,{path:file,sha256:hash(fs.readFileSync(file))}]));
   const versions=Object.fromEntries(['gcc','gxx','cmake','ninja'].map(k=>[k,run(tools[k],['--version'],root).stdout.trim()]));
   const receipt={schema:'blackice.minicpm.trace-build-ready.v1',at:new Date().toISOString(),source,commit:pin.source.commit,files,tools:identities,versions};save(p.join(root,'receipts','source-toolchain.json'),receipt);console.log(JSON.stringify(receipt));return;
 }
 throw Error('UNKNOWN_ACTION:'+action);
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
