const modes=value=>({
  directoryMode:['auto','on','off'].includes(value?.directoryMode)?value.directoryMode:'auto',
  subagentsMode:['default','on','off'].includes(value?.subagentsMode)?value.subagentsMode:'default',
});
const valid=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(id);
const key=id=>'blackice.next.chatExecution.'+id;
/** Saved local draft wins only for its own conversation; run snapshots survive restart. */
export function readConversationExecutionModes({conversationId='new',runs=[],storage}={}){
  if(valid(conversationId))try{
    const value=JSON.parse(storage?.getItem(key(conversationId))||'null');
    if(value&&typeof value==='object'&&!Array.isArray(value))return modes(value);
  }catch{}
  return modes(runs.at(-1)?.executionModes);
}
export function saveConversationExecutionModes({conversationId='new',directoryMode='auto',subagentsMode='default',storage}={}){
  if(!valid(conversationId)||!['auto','on','off'].includes(directoryMode)||!['default','on','off'].includes(subagentsMode))throw Error('Choose valid conversation execution modes.');
  const value={directoryMode,subagentsMode};storage?.setItem(key(conversationId),JSON.stringify(value));return value;
}
export function transferNewExecutionModes({conversationId,storage}={}){
  if(!valid(conversationId)||conversationId==='new')return false;
  const value=storage?.getItem(key('new'));if(!value)return false;
  if(!storage.getItem(key(conversationId)))storage.setItem(key(conversationId),value);
  storage.removeItem(key('new'));return true;
}
