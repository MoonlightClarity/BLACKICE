import { createApi } from './core/api.mjs';
import { createEventBus } from './core/events.mjs';

const stage=document.getElementById('next-stage');
const tabs=[...document.querySelectorAll('.next-tab[data-space]')];
const health=document.getElementById('next-health');
const toast=document.getElementById('next-toast');
const api=createApi();
let status=null,current=null,revision=0;
const spaces=new Map(), notifications=new Set();
const modules={
  chat:()=>import('./chat/chat.mjs').then(m=>m.createChatWorkspace),
  planning:()=>import('./workspaces/planning-browser.mjs').then(m=>m.createPlanningBrowser),
  tasks:()=>import('./workspaces/tasks.mjs').then(m=>m.createTasksWorkspace),
  browser:()=>import('./workspaces/browser.mjs').then(m=>m.createBrowserWorkspace),
  activity:()=>import('./workspaces/activity.mjs').then(m=>m.createActivityWorkspace),
  knowledge:()=>import('./workspaces/knowledge.mjs').then(m=>m.createKnowledgeWorkspace),
  settings:()=>import('./workspaces/settings.mjs').then(m=>m.createSettingsWorkspace),
};
const notify=(message,error=false)=>{
  const element=document.createElement('p');
  element.textContent=String(message||'BLACKICE');
  element.dataset.error=String(error);
  toast.append(element);
  while(toast.children.length>3)toast.firstElementChild.remove();
  const handle=setTimeout(()=>{element.remove();notifications.delete(handle);},6000);
  notifications.add(handle);
};
const connection=(state)=>{
  health.textContent=state==='connected'?'Connected':state==='reconnecting'?'Reconnecting…':'Connecting…';
  health.dataset.status=state==='connected'?'ready':'error';
};
const events=createEventBus({onConnection:connection});
events.subscribe(receipt=>{
  if(receipt.type!=='runtime.status'||!receipt.data)return;
  status=receipt.data;
  health.textContent=status.connected===false?'Model unavailable':'Connected';
  health.dataset.status=status.connected===false?'error':'ready';
  spaces.get(current)?.instance?.updateStatus?.(status);
});
function updateTabs(name){
  for(const tab of tabs){
    const selected=tab.dataset.space===name;
    tab.setAttribute('aria-selected',String(selected));
    tab.tabIndex=selected?0:-1;
  }
}
function openWorkspaceTarget(space){
  const {conversationId,requestId,nodeId}=space?.navigation||{};
  if(requestId)space?.instance?.openRequestId?.(requestId,{nodeId});
  else if(conversationId)space?.instance?.openConversationId?.(conversationId);
}
async function show(name,{conversationId,requestId,nodeId}={}){
  if(!modules[name])return;
  const previous=current;const target=++revision;
  const navigation={conversationId,requestId,nodeId};
  if(previous===name){const space=spaces.get(name);if(space){space.navigation=navigation;openWorkspaceTarget(space);}return;}
  if(previous && spaces.has(previous)){
    const item=spaces.get(previous);
    item.instance?.leave?.();item.mount.hidden=true;
  }
  current=name;
  // The bootstrap placeholder is never a workspace. Remove it as soon as
  // the replacement shell activates its first independently owned view.
  stage.querySelector(':scope > .next-loading')?.remove();
  updateTabs(name);
  let space=spaces.get(name);
  if(!space){
    const mount=document.createElement('section');
    mount.className='next-space';
    mount.dataset.workspace=name;
    mount.setAttribute('aria-label',name.charAt(0).toUpperCase()+name.slice(1));
    stage.append(mount);
    space={mount,instance:null,loading:null,navigation};spaces.set(name,space);
    mount.innerHTML='<div class="next-loading"><h1>'+name.charAt(0).toUpperCase()+name.slice(1)+'</h1><p>Opening workspace…</p></div>';
    space.loading=modules[name]().then(factory=>{
      if(!spaces.has(name))return;
      const instance=factory({mount,api,events,notify,getStatus:()=>status,onNavigate:show});
      space.instance=instance;
      if(current===name){instance.enter?.();instance.updateStatus?.(status);openWorkspaceTarget(space);}
      else mount.hidden=true;
    }).catch(error=>{
      mount.textContent='';
      const wrapper=document.createElement('div');wrapper.className='next-panel next-empty';
      const heading=document.createElement('h2');heading.textContent='This workspace could not open.';
      const note=document.createElement('p');note.textContent=String(error?.message||error);
      wrapper.append(heading,note);mount.append(wrapper);notify(note.textContent,true);
    });
  }
  space.navigation=navigation;
  space.mount.hidden=false;
  if(space.instance){space.instance.enter?.();space.instance.updateStatus?.(status);openWorkspaceTarget(space);}
  try{history.replaceState(null,'','#'+name);}catch{}
}
for(const tab of tabs){
  tab.addEventListener('click',()=>void show(tab.dataset.space));
  tab.addEventListener('keydown',event=>{
    const index=tabs.indexOf(tab);let next=index;
    if(event.key==='ArrowRight')next=(index+1)%tabs.length;
    else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=tabs.length-1;
    else return;
    event.preventDefault();tabs[next].focus();void show(tabs[next].dataset.space);
  });
}
window.addEventListener('hashchange',()=>{
  const name=location.hash.slice(1);
  if(modules[name]&&current!==name)void show(name);
});
window.addEventListener('beforeunload',()=>{
  for(const {instance} of spaces.values())instance?.leave?.();
  for(const timer of notifications)clearTimeout(timer);
  events.close();
});
// Painting the shell never waits for a full history parse or an external provider.
globalThis.blackiceNextGuard?.ready();
events.start();
const first=modules[location.hash.slice(1)]?location.hash.slice(1):'chat';
void show(first);
void api('/api/status','GET',undefined,{deadlineMs:60000}).then(info=>{
  status=info;spaces.get(current)?.instance?.updateStatus?.(status);
}).catch(error=>{notify('Some runtime settings could not be loaded. '+error.message,true);});
