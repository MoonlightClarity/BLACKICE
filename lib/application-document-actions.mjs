import {createHash,randomUUID} from 'node:crypto';

const fail=(message,status=400,code='APPLICATION_DOCUMENT_ACTION')=>Object.assign(new Error(message),{status,code});
export const applicationTextReceipt=(text,ref)=>({ref,sha256:createHash('sha256').update(text,'utf8').digest('hex'),characters:text.length,bytes:Buffer.byteLength(text,'utf8')});
export const applicationControls=elements=>(elements||[]).map(item=>({ref:item.ref,role:item.controlType||item.role||'Control',name:item.name||'',enabled:item.enabled===true,writable:item.enabled===true&&!item.password&&['Edit','Document'].includes(item.controlType)&&item.actions?.includes('set_value')===true,invokable:false,readable:!item.password&&item.actions?.includes('get_text')===true,...(item.value!==undefined&&!item.password?{value:item.value}:{})}));

async function readEditor(workspace,record,privateId,signal){
  const windows=await workspace.runtime.perform({sessionId:privateId,action:'windows'},{signal});record.windows=windows.windows||[];
  if(!record.windows.length)throw fail('The application has no private editor window. Saved text remains available without relaunching.',409);
  const observed=await workspace.runtime.perform({sessionId:privateId,action:'inspect',windowId:record.windows[0].id},{signal});
  const controls=applicationControls(observed.elements);workspace.controls.set(record.id,controls);
  const editors=controls.filter(item=>item.enabled&&item.writable&&item.readable);
  if(editors.length!==1)throw fail('This operation requires exactly one supported private text editor.',409);
  const result=await workspace.runtime.perform({sessionId:privateId,action:'get_text',ref:editors[0].ref,maxCharacters:12000},{signal});
  if(typeof result.text!=='string'||result.text.length>10000||result.text.includes('\0'))throw fail('This editor cannot be saved or restored within the 10,000-character text limit. The application was not changed.',409);
  return {text:result.text,editor:applicationTextReceipt(result.text,editors[0].ref)};
}

/** Called under the workspace mutation queue. No launch, shell, path or OS dialog. */
export async function performApplicationDocumentAction(workspace,value,{signal}={}){
  const fields={save_text:['sessionId','title'],restore_document:['sessionId','documentId','expectedTextSha256']}[value.action];
  if(!fields||Object.keys(value).some(key=>key!=='action'&&!fields.includes(key)))throw fail('Use only the saved-text fields advertised for this action.');
  if(value.action==='restore_document'&&!/^[a-f0-9]{64}$/.test(value.expectedTextSha256||''))throw fail('Inspect the current editor and include its expectedTextSha256 before restoring saved text.');
  if(signal?.aborted)throw fail('The saved-text operation was cancelled before it started.',409);
  const record=workspace.find(value.sessionId);workspace.sync();const privateId=workspace.bindings.get(record.id);
  if(!privateId||record.state!=='running')throw fail('Choose a running private editor. Saved versions do not relaunch applications.',409);
  const source={sessionId:record.id,appId:record.appId,applicationName:record.applicationName};
  record.busy=true;workspace.emit('updated',workspace.status());let submitted=false;
  try{
    const document=value.action==='restore_document'?await workspace.documents.read(value.documentId):null;
    const current=await readEditor(workspace,record,privateId,signal);
    if(value.action==='save_text'){
      const saved=await workspace.documents.save({title:value.title??record.name,source,text:current.text});record.lastSavedDocument=saved;
      record.lastAction={action:'save_text',at:new Date().toISOString(),status:'completed'};
      return {sessionId:record.id,document:saved,editor:current.editor};
    }
    if(current.editor.sha256!==value.expectedTextSha256)throw fail('The editor changed after the restore preview. Read the current editor and review the saved version again. No text was replaced.',409,'APPLICATION_TEXT_CONFLICT');
    const {text:targetText,...target}=document;
    if(target.sha256===current.editor.sha256){if(record.lastRestore?.state==='uncertain'&&record.lastRestore.documentId===target.id&&record.lastRestore.targetSha256===target.sha256)record.lastRestore={...record.lastRestore,state:'verified',verifiedAt:new Date().toISOString(),reconciled:true};record.lastSavedDocument=target;record.lastAction={action:'restore_document',at:new Date().toISOString(),status:'completed'};return {sessionId:record.id,document:target,recoveryDocument:null,editor:current.editor,verified:true,unchanged:true};}
    const recoveryDocument=await workspace.documents.save({title:`Before restoring ${target.title}`.slice(0,160),source,text:current.text});
    // A slow disk write must not turn a reviewed restore into a stale overwrite.
    const before=await workspace.runtime.perform({sessionId:privateId,action:'get_text',ref:current.editor.ref,maxCharacters:12000},{signal});
    if(typeof before.text!=='string'||applicationTextReceipt(before.text,current.editor.ref).sha256!==current.editor.sha256)throw fail('The editor changed while its recovery version was being saved. Review it again; no text was replaced.',409,'APPLICATION_TEXT_CONFLICT');
    if(signal?.aborted)throw fail('The restore was cancelled before replacing text. Its recovery version remains saved.',409);
    record.lastRestore={id:randomUUID(),state:'uncertain',documentId:target.id,recoveryDocumentId:recoveryDocument.id,beforeSha256:current.editor.sha256,targetSha256:target.sha256,at:new Date().toISOString()};
    // Persist the recovery reference and uncertain intent before any native effect.
    await workspace.record(record);
    submitted=true;
    await workspace.runtime.perform({sessionId:privateId,action:'set_value',ref:current.editor.ref,value:targetText},{signal});
    const readback=await workspace.runtime.perform({sessionId:privateId,action:'get_text',ref:current.editor.ref,maxCharacters:12000},{signal});
    if(typeof readback.text!=='string'||applicationTextReceipt(readback.text,current.editor.ref).sha256!==target.sha256)throw fail('The restored text did not match its saved version. The recovery version is preserved; inspect the actual editor before trying another change.',409,'APPLICATION_RESTORE_UNVERIFIED');
    record.lastRestore={...record.lastRestore,state:'verified',verifiedAt:new Date().toISOString()};record.lastSavedDocument=target;
    record.lastAction={action:'restore_document',at:new Date().toISOString(),status:'completed'};
    return {sessionId:record.id,document:target,recoveryDocument,editor:applicationTextReceipt(readback.text,current.editor.ref),verified:true};
  }catch(error){
    record.lastAction={action:value.action,at:new Date().toISOString(),status:submitted?'uncertain':'failed'};workspace.sync();
    if(submitted)error.message+=' A recovery text version was saved before replacement. Do not repeat the restore until its outcome is inspected.';
    throw error;
  }finally{record.busy=false;await workspace.record(record);}
}
