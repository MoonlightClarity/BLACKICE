const modes=value=>({
  directoryMode:value?.directoryMode==='on'||value?.directoryMode==='auto'?'on':'off',
  subagentsMode:'default',
});
const valid=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(id);
const key=id=>'blackice.next.chatExecution.'+id;
/** Directory drafts stay conversation-scoped; retired subagent overrides use the default. */
export function readConversationExecutionModes({conversationId='new',runs=[],storage}={}){
  if(valid(conversationId))try{
    const value=JSON.parse(storage?.getItem(key(conversationId))||'null');
    if(value&&typeof value==='object'&&!Array.isArray(value))return modes(value);
  }catch{}
  return modes(runs.at(-1)?.executionModes);
}
export function saveConversationExecutionModes({conversationId='new',directoryMode='off',storage}={}){
  if(!valid(conversationId)||!['on','off'].includes(directoryMode))throw Error('Choose valid conversation execution modes.');
  const value=modes({directoryMode});storage?.setItem(key(conversationId),JSON.stringify(value));return value;
}
export function transferNewExecutionModes({conversationId,storage}={}){
  if(!valid(conversationId)||conversationId==='new')return false;
  const value=storage?.getItem(key('new'));if(!value)return false;
  if(!storage.getItem(key(conversationId)))saveConversationExecutionModes({...readConversationExecutionModes({storage}),conversationId,storage});
  storage.removeItem(key('new'));return true;
}
