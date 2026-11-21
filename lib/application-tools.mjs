export const APPLICATION_SCHEMA_VERSION=2;
export const APPLICATION_TOOL={type:'function',name:'relay_apps',description:"Open a compatible Windows app in a private session shown in BLACKICE Observe. status lists available appIds; create opens one. inspect returns session/window/editor refs. get_text reads an editor; control with operation:\"set_value\" replaces its text. save_text stores a BLACKICE text snapshot, read_document reads it, and restore_document replaces an editor from that snapshot using expectedTextSha256. screenshot captures the session; close ends it and discards unsaved state. Other Windows apps can use relay_windows or relay_workspace.",inputSchema:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['status','create','inspect','screenshot','get_text','control','save_text','read_document','restore_document','close']},documentId:{type:'string'},title:{type:'string',maxLength:160},expectedTextSha256:{type:'string',pattern:'^[a-f0-9]{64}$',description:'Current exact editor hash from inspect, required for restore_document and recommended for control set_value to reject concurrent edits.'},appId:{type:'string'},name:{type:'string',maxLength:100},sessionId:{type:'string'},windowId:{type:'string'},ref:{type:'string',description:'Current readable/writable control ref from inspect. Required for control; get_text may omit it only when exactly one observed editor exists.'},operation:{type:'string',enum:['set_value']},text:{type:'string',maxLength:10000}},required:['action']}};
export const APPLICATION_INSTRUCTIONS = "\n\nPRIVATE APPLICATION SESSIONS\nUse appIds from status and editor refs from inspect. Supply expectedTextSha256 when changing text; on conflict reread the editor and merge the changes. restore_document requires the current hash and saves a recovery version before replacement.\nsave_text/read_document are BLACKICE text snapshots, not saves of the application's original file. Save the requested deliverable in its destination. close discards unsaved session state. After an error, inspect the surviving session before creating another.\n";
export function createApplicationToolHandler({workspace,signal,onEvent=()=>{},toolDefinition=APPLICATION_TOOL}){
  return async(call,context={})=>{
    let action='unknown';
    try{
      const value=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Choose an application action.');
      action=value.action;const schema=toolDefinition?.inputSchema;
      if(!schema?.properties?.action?.enum?.includes(action)||Object.keys(value).some(key=>!Object.hasOwn(schema.properties,key)))throw Error('Use only the actions and fields attached to this saved application tool catalog.');
      const allowed={status:[],create:['appId','name'],inspect:['sessionId','windowId'],screenshot:['sessionId','windowId'],get_text:['sessionId','ref'],control:['sessionId','ref','operation','text','expectedTextSha256'],save_text:['sessionId','title'],read_document:['documentId'],restore_document:['sessionId','documentId','expectedTextSha256'],close:['sessionId']}[action];
      if(!allowed||Object.keys(value).some(key=>key!=='action'&&!allowed.includes(key)))throw Error('Use only the fields advertised for this application action.');
      const activeSignal=context.signal||signal;if(activeSignal?.aborted)throw Error('The application action was cancelled.');
      const {action:_,...args}=value;
      const result=action==='status'?workspace.status():action==='read_document'?await workspace.readDocument(args):action==='create'?await workspace.create(args,{signal:activeSignal}):action==='close'?await workspace.end(args.sessionId):await workspace.perform(value,{signal:activeSignal});
      const {imageUrl,...receipt}=result;
      const items=[{type:'inputText',text:JSON.stringify(receipt)}];
      if(imageUrl)items.push({type:'inputImage',imageUrl});
      onEvent({type:'tool.result',tool:APPLICATION_TOOL.name,action,status:'completed',sessionId:result.sessionId||result.id});
      return{success:true,contentItems:items};
    }catch(error){onEvent({type:'tool.result',tool:APPLICATION_TOOL.name,action,status:'failed',message:error.message});return{success:false,contentItems:[{type:'inputText',text:error.message+' Inspect status before repeating any action; no foreground fallback was used.'}]};}
  };
}
