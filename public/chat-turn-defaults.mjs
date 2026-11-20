/** Defaults for an ordinary new Chat, not changes to archived or active runs. */
export const CHAT_DEFAULTS=Object.freeze({directoryActions:'off',chatPlanning:'off',pastChats:'off'});
export const NEW_CHAT_RECEIPT_DEPTH='maximal';
const modes=Object.freeze({directoryActions:['off','on'],chatPlanning:['off','on'],pastChats:['off','on']});
export const ordinaryChatWorkflow=(workflow,groupId)=>groupId===undefined&&
  typeof workflow?.id==='string'&&workflow.id.startsWith('mission_chat_')&&workflow.description==='A focused task started from Mission.';
export const ordinaryChatRun=run=>ordinaryChatWorkflow(run?.workflow,run?.chatDisplayGroupId);
// Resolve only an unrecorded ordinary Chat mode when admitting new work.
export const ordinaryChatPastChats=(run,defaults)=>run?.pastChats??
  (ordinaryChatRun(run)?defaults?.pastChats??CHAT_DEFAULTS.pastChats:undefined);

export function chatDefaultsPatch(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length||
    Object.entries(value).some(([key,mode])=>!Object.hasOwn(modes,key)||!modes[key].includes(mode)))
    throw new Error('Choose valid new-chat defaults for Directory, Planning, or Search Previous Chats.');
  return Object.fromEntries(Object.entries(value));
}

export function chatTurnMode(key,{draft,saved,defaults,existing=false,ordinary=false}={}){
  const allowed=modes[key];
  const legacyOrdinary=existing&&ordinary&&key==='pastChats'&&saved==null;
  const fallback=existing&&!legacyOrdinary?(key==='pastChats'?'on':'off'):CHAT_DEFAULTS[key];
  const mode=existing&&!legacyOrdinary?saved:defaults?.[key];
  return allowed.includes(draft)?draft:allowed.includes(mode)?mode:fallback;
}
