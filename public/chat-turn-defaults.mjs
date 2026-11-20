/** Defaults for an ordinary new Chat, not changes to archived or active runs. */
export const CHAT_DEFAULTS=Object.freeze({directoryActions:'off',chatPlanning:'off',pastChats:'off'});
export const NEW_CHAT_RECEIPT_DEPTH='maximal';
const modes=Object.freeze({directoryActions:['off','on'],chatPlanning:['off','on'],pastChats:['off','on']});

export function chatDefaultsPatch(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length||
    Object.entries(value).some(([key,mode])=>!Object.hasOwn(modes,key)||!modes[key].includes(mode)))
    throw new Error('Choose valid new-chat defaults for Directory, Planning, or Search Previous Chats.');
  return Object.fromEntries(Object.entries(value));
}

export function chatTurnMode(key,{draft,saved,defaults,existing=false}={}){
  const allowed=modes[key];
  const fallback=existing?(key==='pastChats'?'on':'off'):CHAT_DEFAULTS[key];
  const mode=existing?saved:defaults?.[key];
  return allowed.includes(draft)?draft:allowed.includes(mode)?mode:fallback;
}
