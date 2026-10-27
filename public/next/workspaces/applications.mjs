import { initNativeAppsUI } from '../../native-apps-ui.mjs';

/** A shared view of normal Windows applications, independent of the browser.
 * Leaving this workspace hides its managed windows without releasing them.
 */
export function createApplicationsWorkspace({mount,desktop=globalThis.window?.relayDesktop}={}) {
  mount.innerHTML='<div class="next-panel next-applications-workspace"><div id="next-applications-native" class="next-panel-inner"></div></div>';
  let active=false,entering=Promise.resolve(),stopChanges=null,generation=0;
  const native=initNativeAppsUI({mount:mount.querySelector('#next-applications-native'),desktop,title:'Applications',heading:'h1',
    // Chromium may mark an occluded/background desktop document hidden while
    // this route and its measured panel remain available. The native bridge
    // separately verifies the actual desktop window before accepting geometry.
    isVisible:()=>active&&!mount.hidden});
  return {
    enter(){if(active)return entering;active=true;generation++;stopChanges=desktop?.onNativeAppsChanged?.(()=>{if(active)void native.refresh();});return entering=Promise.resolve(native.enter());},
    leave(){if(!active)return;active=false;generation++;stopChanges?.();stopChanges=null;native.leave();},
    async prepareSurface(){await entering;if(!active||mount.hidden)throw Error('The Applications view is not visible.');return {...await native.prepareSurface(),generation};},
    observeSurface({generation:expected}={}){
      if(!active||mount.hidden||expected!==generation)return {surface:'applications',visible:false,generation,observedAt:new Date().toISOString()};
      return {...native.observeSurface(),generation};
    },
    updateStatus(){native.update();},
    destroy(){this.leave();native.destroy();mount.innerHTML='';},
  };
}
