import { createWorkflowActivityUI } from './workflow-execution.mjs';
import { createTaskHistory } from './task-lifecycle.mjs';

/** Each Activity surface owns its reads and subscriptions only while selected.
 * Native windows have their own Applications workspace.
 */
export function createActivityWorkspace({mount,api,events,getStatus,notify,onNavigate}) {
  mount.innerHTML=[
    '<div class="next-panel next-activity-workspace next-visual-workspace"><div class="next-panel-inner">',
    '<header class="next-panel-head"><div><h1>Activity</h1><p>Follow a workflow or review task progress.</p></div>',
    '<div id="next-activity-runtime" class="next-card"><h2>Agent activity</h2><p class="next-help" id="next-activity-status">Checking current work…</p></div></header>',
    '<div class="next-visual-tabs" role="tablist" aria-label="Activity views">',
    '<button type="button" role="tab" id="next-activity-tab-workflows" aria-controls="next-activity-workflows" aria-selected="true">Workflows</button>',
    '<button type="button" role="tab" id="next-activity-tab-tasks" aria-controls="next-activity-tasks" aria-selected="false" tabindex="-1">Task timeline</button></div>',
    '<section id="next-activity-workflows" role="tabpanel" aria-labelledby="next-activity-tab-workflows"></section>',
    '<section id="next-activity-tasks" role="tabpanel" aria-labelledby="next-activity-tab-tasks" hidden></section>',
    '</div></div>',
  ].join('');
  const $=id=>mount.querySelector('#'+id),activity=$('next-activity-status');
  let active=false,unsubscribe=null,section='workflows';
  const workflows=createWorkflowActivityUI({mount:$('next-activity-workflows'),api,events,getStatus,notify,onNavigate});
  const history=createTaskHistory({mount:$('next-activity-tasks'),api,events,notify,onNavigate,prefix:'next-activity-tasks',presentation:'timeline'});
  const surfaces={workflows,tasks:history};
  const panels={workflows:$('next-activity-workflows'),tasks:$('next-activity-tasks')};
  const keys=Object.keys(surfaces),tabs=keys.map(key=>$('next-activity-tab-'+key));
  function select(key){
    if(!surfaces[key]||key===section)return;
    if(active)surfaces[section].leave();
    section=key;
    for(const current of keys){
      const selected=current===section,tab=$('next-activity-tab-'+current);
      panels[current].hidden=!selected;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
    }
    if(active)void surfaces[section].enter();
  }
  for(const [index,tab] of tabs.entries()){
    tab.addEventListener('click',()=>select(keys[index]));
    tab.addEventListener('keydown',event=>{
      const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
      if(next<0)return;event.preventDefault();select(keys[next]);tabs[next].focus();
    });
  }
  function updateStatus(status) {
    const execution=status?.execution||{},count=Number(execution.activeCount||execution.activeRunCount||0);
    activity.textContent=count>0?count+' agent execution'+(count===1?'':'s')+' working.':'No active agent executions.';
  }
  const onEvent=event=>{
    if(!active)return;
    if(event.type==='runtime.status')updateStatus(event.data);
    if(event.type==='execution.updated')updateStatus({execution:event.data});
  };
  return {
    enter(){if(active)return;active=true;unsubscribe=events.subscribe(onEvent);updateStatus(getStatus?.());void surfaces[section].enter();},
    leave(){if(!active)return;active=false;unsubscribe?.();unsubscribe=null;surfaces[section].leave();},
    updateStatus(info){updateStatus(info);workflows.updateStatus(info);},
    destroy(){this.leave();for(const surface of Object.values(surfaces))surface.destroy();mount.innerHTML='';},
  };
}
