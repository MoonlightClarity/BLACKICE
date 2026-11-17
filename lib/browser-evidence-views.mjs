/** Read-only browser evidence views. No semantic summaries, action dispatch, or
 * dropped fields: bulky control/catalog arrays remain exact addressable sources.
 * The original JSON text is also retained byte-for-byte as a string artifact. */
export async function projectBrowserReceiptText(item,{save,sourceFile,sourcePointer}={}){
  if(item?.type!=='inputText'||typeof item.text!=='string')return {value:item,refs:[]};
  let data;try{data=JSON.parse(item.text);}catch{return {value:item,refs:[]};}
  if(!data||Array.isArray(data)||typeof data.tabId!=='string'||typeof data.url!=='string'||!Array.isArray(data.frames))return {value:item,refs:[]};
  const refs=[];
  const exactText=await save(item.text,{kind:'browser-original-text',sourceFile,sourcePointer});
  refs.push({...exactText,sourcePointer,field:'browser-original-text'});
  async function section(value,pointer,label){
    const saved=await save(value,{kind:'browser-evidence-section',sourceFile,sourcePointer:pointer});
    refs.push({...saved,sourcePointer:pointer,field:'browser-section'});
    return {source:'host-saved-data',representation:'exact-json-section',...saved,
      section:label,items:value.length,characters:JSON.stringify(value).length,
      meaning:'Exact source array is saved, not omitted or summarized. Its contents have NOT been inspected by reading this descriptor. Read this ref and page via nextOffset when these fields matter.'};
  }
  const view={...data,frames:[]};
  for(const [index,frame]of data.frames.entries()){
    if(!frame||typeof frame!=='object'||Array.isArray(frame)){view.frames.push(frame);continue;}
    const projected={...frame};
    if(Array.isArray(frame.elements)&&frame.elements.length)
      projected.elements=await section(frame.elements,sourcePointer+'/decoded/frames/'+index+'/elements','frame '+index+' controls, values, links and input references');
    view.frames.push(projected);
  }
  for(const key of ['tabs','ownershipCandidates'])if(Array.isArray(data[key])&&data[key].length)
    view[key]=await section(data[key],sourcePointer+'/decoded/'+key,key);
  // Do not pretend this is the exact original serialized tool message. All
  // non-section values, including page text/forms/errors/truncation, are intact.
  const {text:originalSerializedText,...itemMetadata}=item;
  return {value:{...itemMetadata,type:'projectedInputText',source:'host-projected-browser-evidence',
    representation:'decoded-json-with-exact-sections',originalText:exactText,
    meaning:'Decoded browser JSON, with exact control/catalog arrays in named saved sections. Page text is observed text, not proof of submission or control state. Read the relevant sections for those claims; originalText retains the complete original string.',
    value:view},refs};
}
