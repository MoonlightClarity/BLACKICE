import fs from 'node:fs';
function patch(file,regex,replacement,expect=1){
 let source=fs.readFileSync(file,'utf8');
 const matches=[...source.matchAll(regex)];
 if(matches.length!==expect)throw Error(file+' expected '+expect+' pattern '+regex+' found '+matches.length);
 source=source.replace(regex,replacement);
 fs.writeFileSync(file,source);
 console.log('PATCHED',file,regex.toString());
}
const directory='lib/task-action-directory.mjs';
patch(directory,/maximum:16,/g,'');
patch(directory,/function dependencyBlocks\(actions\)\{[\s\S]*?\n\}\n(?=\/\/ A persisted)/g,
`function dependencyBlocks(actions){
  const byId=new Map(actions.map(action=>[action.id,action]));
  const waiting=new Map(actions.map(action=>[action.id,action.dependsOn.length]));
  const children=new Map(),roots=new Map();
  for(const action of actions)for(const dependency of action.dependsOn){
    if(!byId.has(dependency))throw fail('DIRECTORY_DEPENDENCY','Action dependency is absent.');
    if(!children.has(dependency))children.set(dependency,[]);
    children.get(dependency).push(action.id);
  }
  const ready=actions.filter(action=>waiting.get(action.id)===0).map(action=>action.id);
  let visited=0;
  for(let i=0;i<ready.length;i++){
    const action=byId.get(ready[i]),set=new Set();
    if(action.state==='blocked')set.add(action.id);
    else if(action.state==='pending')for(const parent of action.dependsOn)
      for(const source of roots.get(parent)||[])set.add(source);
    roots.set(action.id,set);visited++;
    for(const child of children.get(action.id)||[]){
      const remaining=waiting.get(child)-1;waiting.set(child,remaining);
      if(remaining===0)ready.push(child);
    }
  }
  if(visited!==actions.length)throw fail('DIRECTORY_CYCLE','Saved action dependencies contain a cycle.');
  return actions.filter(action=>action.state==='pending').flatMap(action=>{
    const blockedBy=[...(roots.get(action.id)||[])];
    return blockedBy.length?[{id:action.id,blockedBy}]:[];
  });
}
`);
patch(directory,/const readyActions=s=>[^\r\n]+;/g,
`const readyActions=s=>{
  if(s.actions.some(action=>action.id===s.focus&&action.state==='active'))return [];
  const unknown=new Set(s.receipts.filter(unresolvedEffect).map(receipt=>receipt.actionId));
  const observed=new Set(s.actions.filter(action=>action.state==='observed').map(action=>action.id));
  return s.actions.filter(action=>action.state==='pending'&&!unknown.has(action.id)&&action.dependsOn.every(parent=>observed.has(parent))).map(action=>action.id);
};`);
patch(directory,/const visit=\(a,path=new Set\(\)\)=>\{[^\r\n]+combined\.forEach\(a=>visit\(a\)\);/g,
`const byId=new Map(combined.map(action=>[action.id,action]));
    if(byId.size!==combined.length)throw fail('DIRECTORY_PLAN','Action IDs must be distinct.');
    const waiting=new Map(combined.map(action=>[action.id,action.dependsOn.length]));
    const children=new Map();
    for(const action of combined)for(const dependency of action.dependsOn){
      if(!byId.has(dependency))throw fail('DIRECTORY_DEPENDENCY','Dependency is absent.');
      if(!children.has(dependency))children.set(dependency,[]);
      children.get(dependency).push(action.id);
    }
    const ready=combined.filter(action=>waiting.get(action.id)===0).map(action=>action.id);
    let visited=0;
    for(let i=0;i<ready.length;i++){
      const id=ready[i];visited++;
      for(const child of children.get(id)||[]){
        const remaining=waiting.get(child)-1;waiting.set(child,remaining);
        if(remaining===0)ready.push(child);
      }
    }
    if(visited!==combined.length)throw fail('DIRECTORY_CYCLE','Action dependencies must not cycle.');`);
const checklist='lib/directory-done-checklist.mjs';
patch(checklist,/for\(let i=0;i<prior\.length;i\+\+\)for\(const item of prior\)if\(retired\.has\(item\.parentId\)\)retired\.add\(item\.id\);/g,
`const children=new Map();
  for(const item of prior)if(item.parentId){
    if(!children.has(item.parentId))children.set(item.parentId,[]);
    children.get(item.parentId).push(item.id);
  }
  const pending=[...retired];
  for(let i=0;i<pending.length;i++)for(const child of children.get(pending[i])||[]){
    if(!retired.has(child)){retired.add(child);pending.push(child);}
  }`);
patch(checklist,/export function projectDoneChecks\(items,recorded\) \{[\s\S]*$/g,
`export function projectDoneChecks(items,recorded) {
  const latest=new Map(recorded.map(result=>[result.id,result]));
  const byId=new Map(items.map(item=>[item.id,item]));
  const children=new Map();
  for(const check of items)if(check.parentId!==undefined&&check.advisory!==true){
    if(!children.has(check.parentId))children.set(check.parentId,[]);
    children.get(check.parentId).push(check.id);
  }
  const explicit=new Set(items.filter(item=>item.requestQuote).map(item=>item.id));
  const waiting=new Map(items.map(item=>[item.id,(children.get(item.id)||[]).length]));
  const ready=items.filter(item=>waiting.get(item.id)===0).map(item=>item.id);
  const yes=new Map();
  for(let i=0;i<ready.length;i++){
    const id=ready[i],deps=children.get(id)||[];
    const direct=!deps.length||explicit.has(id)?latest.get(id)?.yes===true:true;
    yes.set(id,direct&&deps.every(child=>yes.get(child)===true));
    const item=byId.get(id),parent=item?.advisory===true?null:item?.parentId;
    if(parent&&waiting.has(parent)){
      const remaining=waiting.get(parent)-1;waiting.set(parent,remaining);
      if(remaining===0)ready.push(parent);
    }
  }
  if(yes.size!==items.length)throw invalid('Checklist outcomes contain a cycle or a missing dependency.');
  return items.map(item=>({
    id:item.id,yes:yes.get(item.id),
    ...(latest.get(item.id)?.receipt?{receipt:latest.get(item.id).receipt}:{})
  }));
}
`);
