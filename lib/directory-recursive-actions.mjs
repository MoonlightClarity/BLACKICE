// Task-local hierarchical action structure. Planning is model-authored; host keeps
// ancestry, readiness and receipt provenance exact. No provider calls or replay here.
const ids=actions=>new Map(actions.map(a=>[a.id,a]));
const children=(actions,parentId)=>actions.filter(action=>action.parentId===parentId);
export const directChildren=children;

export function ancestorIds(actions,id){
 const byId=ids(actions),parents=[],visited=new Set([id]);
 let current=byId.get(id);
 while(current?.parentId){
  if(visited.has(current.parentId))throw Error('Directory parent ancestry cycles.');
  visited.add(current.parentId);
  parents.push(current.parentId);
  current=byId.get(current.parentId);
  if(!current)throw Error('Directory parent action is missing.');
 }
 return parents;
}
export function isDescendant(actions,candidateId,ancestorId){
 return candidateId!==ancestorId&&ancestorIds(actions,candidateId).includes(ancestorId);
}
export function depthOf(actions,id){return ancestorIds(actions,id).length;}

export function coveredBlockedChild(actions,blockedId){
 const byId=ids(actions),blocked=byId.get(blockedId);
 if(blocked?.state!=='blocked'||!blocked.parentId)return false;
 const visited=new Set();
 const stack=[blockedId];
 while(stack.length){
  const id=stack.pop();
  if(visited.has(id))continue;
  visited.add(id);
  for(const next of actions){
   if(next.parentId!==blocked.parentId||!next.replaces?.includes(id))continue;
   if(next.state==='observed')return true;
   if(next.state==='blocked')stack.push(next.id);
  }
 }
 return false;
}
export function synthesisStatus(actions,parentId){
 const direct=children(actions,parentId);
 const unfinished=direct.filter(item=>!['observed','blocked'].includes(item.state)).map(item=>item.id);
 const blocked=direct.filter(item=>item.state==='blocked').map(item=>item.id);
 const unaddressed=direct.filter(item=>item.state==='blocked'&&!coveredBlockedChild(actions,item.id)).map(item=>item.id);
 return{
  parentId,childCount:direct.length,
  observedCount:direct.filter(item=>item.state==='observed').length,
  blockedCount:blocked.length,
  unfinished,unaddressedBlocked:unaddressed,
  readyToSynthesize:direct.length>0&&unfinished.length===0,
  objectiveEligible:direct.length>0&&unfinished.length===0&&unaddressed.length===0,
 };
}
export function readyRecursiveAction(action,actions){
 if(action.state!=='pending'&&action.state!=='decomposed')return false;
 if(!(action.dependsOn||[]).every(id=>actions.find(other=>other.id===id)?.state==='observed'))return false;
 for(const ancestor of ancestorIds(actions,action.id)){
  const parent=actions.find(item=>item.id===ancestor);
  if(!['decomposed','active'].includes(parent?.state))return false;
 }
 return action.state==='pending'||synthesisStatus(actions,action.id).readyToSynthesize;
}

export function validateRecursiveStructure(actions,{maxActionIdLength=80}={}){
 const byId=ids(actions);
 if(byId.size!==actions.length)throw Error('Action IDs must be unique.');
 for(const item of actions){
  if(item.parentId!==undefined){
   if(typeof item.parentId!=='string'||item.parentId.length>maxActionIdLength||!byId.has(item.parentId)||item.parentId===item.id)
    throw Error('Recursive action parent is absent or invalid.');
  }
  ancestorIds(actions,item.id);
  if(item.state==='decomposed'&&!children(actions,item.id).length)
   throw Error('Decomposed parent has no recorded child actions.');
  if(item.replaces!==undefined){
   if(!item.parentId||!Array.isArray(item.replaces)||!item.replaces.length||
    new Set(item.replaces).size!==item.replaces.length||item.replaces.some(id=>{
     const old=byId.get(id);
     return !old||id===item.id||old.parentId!==item.parentId||old.state!=='blocked';
    }))throw Error('A replacement must cite blocked sibling actions under the same parent.');
  }
  for(const dependency of item.dependsOn||[]){
   if(dependency===item.parentId||isDescendant(actions,item.id,dependency)||isDescendant(actions,dependency,item.id))
    throw Error('A child cannot depend on an ancestor or descendant that needs its own completion.');
  }
 }
}

export function recursiveSubtree(actions,id){
 const byId=ids(actions);
 if(!byId.has(id))return null;
 const actionIds=new Set([id]),pending=[id];
 while(pending.length){
  const parent=pending.pop();
  for(const child of children(actions,parent))if(!actionIds.has(child.id)){
   actionIds.add(child.id);pending.push(child.id);
  }
 }
 return{path:[...ancestorIds(actions,id)].reverse().concat(id),
  actions:actions.filter(a=>actionIds.has(a.id)),
  descendants:actionIds.size-1};
}
export function projectedRecursiveActions(actions,{focus,ready=[],maxActions=72}={}){
 if(actions.length<=maxActions)return{actions,deferredActionCount:0};
 const byId=ids(actions),selected=new Set();
 const add=id=>{if(byId.has(id)&&selected.size<maxActions)selected.add(id);};
 const prefer=id=>{
  add(id);
  for(const ancestor of ancestorIds(actions,id))add(ancestor);
 };
 // The currently active action and its closest ancestors take priority over
 // recent history; never trim away the live focus merely because it is old.
 if(focus)prefer(focus);
 for(const id of ready.slice(0,24))prefer(id);
 for(const action of actions.filter(a=>a.state==='active'||a.state==='decomposed').slice(-14))prefer(action.id);
 for(const action of actions.filter(a=>a.state==='blocked').slice(-6))prefer(action.id);
 for(const action of actions.slice(-24))prefer(action.id);
 const result=actions.filter(a=>selected.has(a.id));
 return{actions:result,deferredActionCount:actions.length-result.length};
}
