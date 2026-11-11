import {normalizePlanningOntology} from '../../planning-module-policy.mjs';

const key=id=>'blackice.next.chatOntology.'+id;
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(id);
const modes=new Set(['ontology','off']);

/** The current conversation wins; the application default is a fallback only. */
export function readConversationOntology({conversationId='new',runs=[],defaults,storage}={}){
  let draft=null;
  if(validId(conversationId))try{
    const stored=JSON.parse(storage?.getItem(key(conversationId))||'null');
    if(stored&&typeof stored==='object'&&!Array.isArray(stored)){
      draft={planningMode:stored.planningMode==='off'?'off':'ontology',planningOntology:normalizePlanningOntology(stored.planningOntology)};
    }
  }catch{}
  const ordered=Array.isArray(runs)?runs:[];
  const latest=ordered.at(-1);
  const priorPolicy=[...ordered].reverse().find(run=>run?.planningOntology)?.planningOntology;
  const persistedMode=latest
    ?latest.planningOntology?'ontology'
      :latest.planningMode==='off' && !['forced','advisory'].includes(latest.planningEnforcement)?'off'
      :'ontology'
    :'ontology';
  return {
    planningMode:draft?.planningMode||persistedMode,
    planningOntology:normalizePlanningOntology(draft?.planningOntology??priorPolicy??defaults),
    source:draft?'conversation-draft':latest?'conversation-run':'defaults',
  };
}

export function saveConversationOntology({conversationId='new',planningMode='ontology',planningOntology,storage}={}){
  if(!validId(conversationId)||!modes.has(planningMode))throw Error('Choose a valid conversation Planning policy.');
  const item={planningMode,planningOntology:normalizePlanningOntology(planningOntology)};
  storage?.setItem(key(conversationId),JSON.stringify(item));
  return item;
}

export function transferNewOntology({conversationId,storage}={}){
  if(!validId(conversationId)||conversationId==='new')return false;
  const source=storage?.getItem(key('new'));
  if(!source)return false;
  if(!storage.getItem(key(conversationId)))storage.setItem(key(conversationId),source);
  storage.removeItem(key('new'));
  return true;
}

/** The grid exposes explicit choices, while preserving legacy global Auto choices. */
export function gridOntologyState(policy,id){
  const normalized=normalizePlanningOntology(policy),state=normalized.modules[id];
  return state==='optional'&&normalized.autoSelect?'auto':state;
}

export function updatedGridOntology(policy,id,choice){
  const normalized=normalizePlanningOntology(policy);
  if(!['mandatory','optional','forbidden','auto'].includes(choice)||!Object.hasOwn(normalized.modules,id))
    throw Error('Choose a known module and one Planning state.');
  // Freeze legacy global automatic choices into individual Auto cells when a
  // person first edits the grid; otherwise editing one cell changes all others.
  const modules=Object.fromEntries(Object.entries(normalized.modules).map(([name,state])=>[
    name,state==='optional'&&normalized.autoSelect?'auto':state,
  ]));
  modules[id]=choice;
  return normalizePlanningOntology({version:1,autoSelect:false,modules});
}
