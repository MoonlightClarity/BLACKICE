import { createWorkflowActivityUI } from './workflow-execution.mjs';
import { createTaskHistory } from './task-lifecycle.mjs';
import { createActivityOverview } from './activity-overview.mjs';

/** Activity surfaces read and subscribe only while selected. */
export function createActivityWorkspace({mount,api,events,getStatus,notify,onNavigate}) {
  mount.innerHTML=[
    '<div class="next-panel next-activity-workspace next-visual-workspace" data-activity-section="overview"><div class="next-panel-inner">',
    '<header class="next-panel-head"><div><h1>Activity</h1><p>Running work, recent outcomes, and the evidence behind them.</p></div>',
    '<div id="next-activity-runtime"><h2>Agent activity</h2><p class="next-help" id="next-activity-status">Checking current work…</p></div></header>',
    '<div class="next-visual-tabs" role="tablist" aria-label="Activity views">',
    '<button type="button" role="tab" id="next-activity-tab-overview" aria-controls="next-activity-overview" aria-selected="true">Overview</button>',
    '<button type="button" role="tab" id="next-activity-tab-workflows" aria-controls="next-activity-workflows" aria-selected="false" tabindex="-1">Workflows</button>',
    '<button type="button" role="tab" id="next-activity-tab-tasks" aria-controls="next-activity-tasks" aria-selected="false" tabindex="-1">Task timeline</button></div>',
    '<section id="next-activity-overview" role="tabpanel" aria-labelledby="next-activity-tab-overview"></section>',
    '<section id="next-activity-workflows" role="tabpanel" aria-labelledby="next-activity-tab-workflows" hidden></section>',
    '<section id="next-activity-tasks" role="tabpanel" aria-labelledby="next-activity-tab-tasks" hidden></section>',
    '</div></div>',
  ].join('');
  const $=id=>mount.querySelector('#'+id),activity=$('next-activity-status');
  let active=false,unsubscribe=null,section='overview';
  const surfaces={},keys=['overview','workflows','tasks'];
  const panels=Object.fromEntries(keys.map(key=>[key,$('next-activity-'+key)]));
  const tabs=keys.map(key=>$('next-activity-tab-'+key));
  function ensure(key){
    if(surfaces[key])return surfaces[key];
    if(key==='overview')surfaces[key]=createActivityOverview({mount:panels[key],api,events,notify,onNavigate,onInspectWorkflow:id=>{select('workflows');surfaces.workflows.openRunId(id);}});
    if(key==='workflows')surfaces[key]=createWorkflowActivityUI({mount:panels[key],api,events,getStatus,notify,onNavigate});
    if(key==='tasks')surfaces[key]=createTaskHistory({mount:panels[key],api,events,notify,onNavigate,prefix:'next-activity-tasks',presentation:'timeline'});
    return surfaces[key];
  }
  function select(key){
    if(!keys.includes(key)||key===section)return;
    if(active)surfaces[section]?.leave();
    section=key;mount.querySelector('.next-activity-workspace').dataset.activitySection=key;
    for(const current of keys){
      const selected=current===section,tab=$('next-activity-tab-'+current);
      panels[current].hidden=!selected;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
    }
    if(active){void ensure(section).enter();surfaces[section].updateStatus?.(getStatus?.());}
  }
  for(const [index,tab] of tabs.entries()){
    tab.addEventListener('click',()=>select(keys[index]));
    tab.addEventListener('keydown',event=>{
      const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
      if(next<0)return;event.preventDefault();select(keys[next]);tabs[next].focus();
    });
  }
  function updateStatus(status) {
    const execution=status?.execution;
    const value=execution?.activeCount??execution?.activeRunCount;
    const count=value==null?NaN:Number(value);
    activity.textContent=Number.isFinite(count)?count>0?count+' active execution'+(count===1?'':'s')+'.':'No active executions.':'Runtime status is unavailable.';
  }
  const onEvent=event=>{
    if(!active)return;
    if(event.type==='runtime.status')updateStatus(event.data);
    if(event.type==='execution.updated')updateStatus({execution:event.data});
  };
  return {
    enter(){if(active)return;active=true;unsubscribe=events.subscribe(onEvent);updateStatus(getStatus?.());void ensure(section).enter();},
    leave(){if(!active)return;active=false;unsubscribe?.();unsubscribe=null;surfaces[section]?.leave();},
    updateStatus(info){updateStatus(info);surfaces.workflows?.updateStatus(info);},
    destroy(){this.leave();for(const surface of Object.values(surfaces))surface.destroy();mount.innerHTML='';},
  };
}
