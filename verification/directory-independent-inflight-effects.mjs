import {readFileSync,writeFileSync} from 'node:fs';
const file='lib/task-action-directory.mjs';
let source=readFileSync(file,'utf8');
function change(from,to,name){
 const at=source.indexOf(from);
 if(at<0||source.indexOf(from,at+from.length)!==-1)throw Error('Expected exactly one '+name);
 source=source.slice(0,at)+to+source.slice(at+from.length);
 console.log('CHANGED',name);
}
change("import {createHash} from 'node:crypto';",
"import {createHash} from 'node:crypto';\nimport path from 'node:path';",'path-import');
change("const linkableRead=(r,actionId,runId,nodeId)=>",
`// Two actively running workspace writes/patches may be admitted concurrently
// only when their canonical lexical targets are different. Never infer
// independence for browser effects, identical paths, mixed path kinds, or
// unknown calls. Historical unresolved receipts are never bypassed.
const workspaceMutationTarget=call=>{
 if(!call||call.namespace||call.name!=='relay_workspace')return null;
 let args=call.arguments??call.input??{};
 if(typeof args==='string')try{args=JSON.parse(args);}catch{return null;}
 if(!args||!['write','patch'].includes(args.action)||typeof args.path!=='string'||!args.path.trim())return null;
 const raw=args.path;
 if(/^[a-z]:[\\\\/]/i.test(raw)||raw.startsWith('\\\\\\\\'))
   return ['windows',path.win32.normalize(raw).toLowerCase()];
 if(raw.startsWith('/'))return ['posix-absolute',path.posix.normalize(raw)];
 return ['relative',path.posix.normalize(raw.replaceAll('\\\\','/'))];
};
const independentWorkspaceMutations=(a,b)=>{
 const x=workspaceMutationTarget(a),y=workspaceMutationTarget(b);
 return Boolean(x&&y&&x[0]===y[0]&&x[1]!==y[1]);
};
const linkableRead=(r,actionId,runId,nodeId)=>`, 'independent-target-classifier');
change("this.queue=Promise.resolve();this.sourceKeys=new Map();",
"this.queue=Promise.resolve();this.sourceKeys=new Map();this.activeEffectFlights=new Map();",'inflight-instance-ledger');
change("let receiptId,startRevision,gate;const report=value=>{try{trace?.(value);}catch{}};",
"let receiptId,startRevision,gate;const flight=observationOnly?null:{call,runId,nodeId};const report=value=>{try{trace?.(value);}catch{}};\n   try{",'lifecycle-finally-open');
change("const unknown=s.receipts.filter(r=>r.actionId===a?.id&&unresolvedEffect(r));if(!observationOnly&&unknown.length&&",
`const unknown=s.receipts.filter(r=>r.actionId===a?.id&&unresolvedEffect(r));
   const unsafe=unknown.filter(r=>{
     const active=this.activeEffectFlights.get(r.id);
     return !active||active.runId!==runId||active.nodeId!==nodeId||
       !independentWorkspaceMutations(call,active.call);
   });
   if(!observationOnly&&unsafe.length&&`, 'bypass-only-proven-independent-active-effect');
change("state:'unknown',at:this.now()});report({...gate,phase:'gate',decision:'allow',receiptId});",
"state:'unknown',at:this.now()});if(flight)this.activeEffectFlights.set(receiptId,flight);report({...gate,phase:'gate',decision:'allow',receiptId});",'register-validated-reservation-before-dispatch');
change("directory:this.read()};\n }\n async steer(",
"directory:this.read()};\n   }finally{if(receiptId)this.activeEffectFlights.delete(receiptId);}\n  }\n  async steer(",'cleanup-active-intent-on-all-paths');
writeFileSync(file,source);
