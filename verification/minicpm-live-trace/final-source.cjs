'use strict';
const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto');
const pin=require('./build-inputs.json');
const io=require('./io-source-patch.cjs'),trace=require('./apply-instrumentation.cjs'),ui=require('./ui-source-patch.cjs');
const copiedFiles=['blackice-trace.cpp','blackice-trace.h','blackice-decode-error.h','blackice-empty-self-test.inc','blackice-runtime-snapshot.h','blackice-text-position.h'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value);
function inventory(root){
 const files=[];
 function visit(relative){
  for(const name of fs.readdirSync(p.join(root,relative)).sort()){
   const rel=relative?relative+'/'+name:name,file=p.join(root,rel),stat=fs.lstatSync(file);
   if(stat.isDirectory())visit(rel);
   else if(stat.isSymbolicLink()){
    const target=fs.readlinkSync(file);files.push({path:rel,kind:'symlink',target,bytes:Buffer.byteLength(target),sha256:hash('symlink\0'+target)});
   }else if(stat.isFile()){
    const bytes=fs.readFileSync(file);files.push({path:rel,kind:'file',bytes:bytes.length,sha256:hash(bytes)});
   }else throw Error('UNSUPPORTED_SOURCE_ENTRY:'+rel);
  }
 }
 visit('');return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function identity(record){const {path,...content}=record;return content;}
function derive(source,toolRoot=__dirname){
 const before=inventory(source),byPath=new Map(before.map(x=>[x.path,x]));
 const expected={...io.expected};for(const patcher of [trace,ui])for(const [name,sha]of Object.entries(patcher.expected)){if(expected[name]&&expected[name]!==sha)throw Error('UPSTREAM_PIN_CONFLICT:'+name);expected[name]=sha;}
 const writes=new Map(),dispositions=new Map(before.map(x=>[x.path,{path:x.path,disposition:'unchanged',before:identity(x),after:identity(x)}]));
 for(const [name,sha]of Object.entries(expected).sort(([a],[b])=>a.localeCompare(b))){
  const existing=byPath.get(name);if(existing?.kind!=='file'||existing.sha256!==sha)throw Error('PINNED_UPSTREAM_SOURCE_REQUIRED:'+name);
  let text=fs.readFileSync(p.join(source,name),'utf8');
  if(Object.hasOwn(io.expected,name))text=io.patch(name,text);
  if(Object.hasOwn(trace.expected,name))text=trace.patch(name,text);
  if(Object.hasOwn(ui.expected,name))text=ui.patch(name,text);
  const bytes=Buffer.from(text);writes.set(name,bytes);
  dispositions.set(name,{path:name,disposition:'replaced',before:identity(existing),after:{kind:'file',bytes:bytes.length,sha256:hash(bytes)}});
 }
 for(const name of copiedFiles){
  const relative='src/'+name;if(byPath.has(relative))throw Error('UNEXPECTED_UPSTREAM_NAME_COLLISION:'+relative);
  const bytes=fs.readFileSync(p.join(toolRoot,name));writes.set(relative,bytes);
  dispositions.set(relative,{path:relative,disposition:'added',before:null,after:{kind:'file',bytes:bytes.length,sha256:hash(bytes)}});
 }
 const entries=[...dispositions.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const content={schema:'blackice.minicpm.final-source-content.v1',sourceCommit:pin.source.commit,sourceArchiveSha256:pin.source.sha256,
  entries,deletedFiles:[],replacedFiles:entries.filter(x=>x.disposition==='replaced').map(x=>x.path),copiedFiles:copiedFiles.map(x=>'src/'+x)};
 return{content,contentSha256:hash(canonical(content)),writes,before};
}
function atomic(file,bytes){
 fs.mkdirSync(p.dirname(file),{recursive:true});const tmp=file+'.stage-'+process.pid;
 const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);if(!fs.readFileSync(file).equals(bytes))throw Error('SOURCE_READBACK:'+file);
}
function verify(content,source){
 const expected=content.entries.filter(x=>x.after!==null).map(x=>({path:x.path,...x.after}));
 const actual=inventory(source);if(canonical(actual)!==canonical(expected)){
  const a=new Map(actual.map(x=>[x.path,x])),e=new Map(expected.map(x=>[x.path,x]));
  const mismatches=[...new Set([...a.keys(),...e.keys()])].filter(k=>canonical(a.get(k))!==canonical(e.get(k)));
  throw Error('FINAL_SOURCE_DRIFT:'+mismatches.slice(0,30).join(','));
 }
 return{complete:true,files:actual.length,contentSha256:hash(canonical(content)),deletedFiles:content.deletedFiles};
}
function apply(plan,source){
 if(canonical(inventory(source))!==canonical(plan.before))throw Error('SOURCE_CHANGED_AFTER_DERIVATION');
 for(const [name,bytes]of plan.writes)atomic(p.join(source,name),bytes);
 return verify(plan.content,source);
}
function materialize(plan,upstream,target,previous=null){
 if(previous)verify(previous,target);
 else if(fs.existsSync(target)){
  if(canonical(inventory(target))!==canonical(plan.before))throw Error('FRESH_TARGET_DIFFERS_FROM_UPSTREAM');
 }else fs.cpSync(upstream,target,{recursive:true,errorOnExist:true,force:false,dereference:false});
 const after=new Map(plan.content.entries.filter(x=>x.after!==null).map(x=>[x.path,x.after]));
 if(previous)for(const entry of previous.entries){
  if(entry.after!==null&&!after.has(entry.path)){
   if(entry.disposition!=='added')throw Error('UNQUALIFIED_SOURCE_DELETION:'+entry.path);
   fs.unlinkSync(p.join(target,entry.path));
  }
 }
 for(const [name,bytes]of plan.writes){
  const file=p.join(target,name);
  if(fs.existsSync(file)&&fs.readFileSync(file).equals(bytes))continue;
  atomic(file,bytes);
 }
 return verify(plan.content,target);
}
module.exports={derive,apply,materialize,verify,inventory,hash,copiedFiles};
