import {createHash} from 'node:crypto';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const pointerKey=value=>String(value).replaceAll('~','~0').replaceAll('/','~1');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isReference=value=>value&&typeof value==='object'&&(value.kind==='saved-evidence-reference'||value.type==='savedImage');
const serialSize=value=>JSON.stringify(value)?.length||0;
const typeOf=value=>Array.isArray(value)?'array':value===null?'null':typeof value;

/** Keep an exact, disk-backed working set when all saved evidence cannot fit in
 * one context. No model reads or summarizes sources here: the active phase sees
 * the task state and host index and chooses which exact sources it needs.
 */
export async function createEvidenceWorkingSet({value,projectedValue,store,sourceFile,protectedKeys=new Set(),fits,signal}={}){
  if(!store||typeof fits!=='function')throw fail('DIRECTORY_EVIDENCE_INDEX_INVALID','A saved evidence store and complete-prompt capacity check are required.');
  const check=()=>signal?.throwIfAborted?.();check();
  const original=await store.save(value,{kind:'evidence-source',sourceFile});
  const projection=projectedValue===undefined?await store.project(value,{sourceFile}):{value:projectedValue};
  const projected=await store.save(projection.value,{kind:'projected-evidence',sourceFile});
  const archived=[],receipts=[];
  async function reference(content,pointer,kind='indexed-evidence-field'){
    check();
    const saved=await store.save(content,{kind,sourceFile,sourcePointer:pointer});
    const row={...saved,sourcePointer:pointer,valueType:typeOf(content),
      ...(Array.isArray(content)?{items:content.length}:typeof content==='string'?{characters:content.length}:{})};
    archived.push(row);
    return {kind:'saved-evidence-reference',source:'host-saved-data',ref:saved.ref,sha256:saved.sha256,
      sourcePointer:pointer,valueType:row.valueType,...(row.items!==undefined?{items:row.items}:{}),...(row.characters!==undefined?{characters:row.characters}:{})};
  }
  async function index(item,pointer=''){
    if(Array.isArray(item)){const rows=[];for(let i=0;i<item.length;i++)rows.push(await index(item[i],pointer+'/'+i));return rows;}
    if(!item||typeof item!=='object'||isReference(item))return item;
    const receipt=item.source==='host-dispatch-receipt'&&Object.hasOwn(item,'result');
    const result=Object.create(null);
    for(const [key,child]of Object.entries(item)){
      const childPointer=pointer+'/'+pointerKey(key);
      if(receipt&&key==='result')result[key]=await reference(child,childPointer,'projected-tool-result');
      // Display excerpts remain in the exact saved receipt. The working index
      // uses the complete read ref rather than implying an excerpt is complete.
      else if(!receipt||!['excerpt','omittedCharacters'].includes(key))result[key]=await index(child,childPointer);
    }
    if(receipt)receipts.push({callId:item.callId||item.id||null,tool:item.tool,action:item.action,success:item.success,
      sourceFile:item.sourceFile,sourcePointer:pointer,resultRef:result.result.ref});
    return result;
  }
  const indexed=await index(projection.value);
  const fullIndex=await store.save(indexed,{kind:'evidence-working-set',sourceFile});
  // This header does not claim all saved records were inspected. Exact receipt
  // identity/status is retained inline while it fits, then in the saved index.
  const header=manifestRef=>({kind:'disk-backed-working-set',originalRef:original.ref,projectedRef:projected.ref,indexRef:fullIndex.ref,manifestRef:manifestRef.ref,
    representations:{original:'raw-json',projected:'projected-json'},
    receiptCount:receipts.length,archivedFields:archived.length,
    meaning:'Exact sources and the complete index are saved. Read needed refs through relay_directory_context. No automatic summarization or all-source inspection was performed.'});
  let working=structuredClone(indexed);
  const placeholder={...original,kind:'evidence-index-manifest'};
  const packet=()=>({...working,savedEvidence:header(placeholder)});
  // Large scalar data and naturally independent evidence collections can be
  // offloaded without replacing the module's small finding/candidate/state.
  const collections=new Set(['hostEvidence','sourceFiles','attributedData','attributedEvidenceIndex','explicitRequirementImport','imports','records','items','contentItems']);
  function candidates(root){
    const specific=[],fallback=[];
    function visit(item,parent,key,pointer,depth,protectedBranch=false){
      if(protectedBranch||isReference(item)||item===null||item===undefined)return;
      const size=serialSize(item);
      if(parent&&size>0){
        const candidate={parent,key,pointer,size,depth,value:item};
        if(typeof item==='string'||collections.has(String(key)))specific.push(candidate);
        if(typeof item==='object')fallback.push(candidate);
      }
      if(item&&typeof item==='object')for(const [childKey,child]of Object.entries(item))visit(child,item,childKey,pointer+'/'+pointerKey(childKey),depth+1,depth===0&&protectedKeys.has(childKey));
    }
    visit(root,null,null,'',0);
    // Prefer a specific evidence collection over a containing record, keeping
    // small module state available. Reference overhead is measured exactly.
    const bySize=(a,b)=>b.size-a.size||b.depth-a.depth;
    return [specific.sort(bySize),fallback.sort(bySize)];
  }
  while(!await fits(packet())){
    check();let replaced=false;
    const lists=candidates(working);
    for(const list of lists){
      for(const candidate of list){
        const ref=await reference(candidate.value,candidate.pointer);
        if(serialSize(ref)>=candidate.size){archived.pop();continue;}
        candidate.parent[candidate.key]=ref;replaced=true;break;
      }
      if(replaced)break;
    }
    if(!replaced)throw fail('DIRECTORY_AUTHORITY_CAPACITY','Current instructions and the minimum saved-evidence index exceed the model input capacity. Exact evidence and completed effects remain saved.');
  }
  const manifest={version:1,kind:'evidence-index-manifest',sourceFile,original,projected,index:fullIndex,
    receipts,archived,workingSetSha256:hash(working),inspection:'selective-read',coverageClaim:false};
  const manifestRef=await store.save(manifest,{kind:'evidence-index-manifest',sourceFile});
  const context={...working,savedEvidence:header(manifestRef)};
  if(!await fits(context))throw fail('DIRECTORY_EVIDENCE_INDEX_CAPACITY','The exact saved-evidence index does not fit its measured context. No source was truncated.');
  return {context,manifest,projectedValue:projection.value};
}
