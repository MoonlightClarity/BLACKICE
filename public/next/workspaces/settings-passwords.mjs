import { mountBrowserCredentials } from '../../browser-credentials-ui.mjs';

// Reuse the existing vault UI. Detached panels pause its polling without
// discarding a local draft or an uncertain operation receipt.
export function createPasswordSettings({mount,api}={}) {
  const child=mount.ownerDocument.createElement('div');
  child.className='next-password-settings';
  let controller=null,active=false,destroyed=false;
  return {
    enter(){
      if(destroyed||active)return;
      active=true;mount.append(child);
      if(!controller){
        controller=mountBrowserCredentials({mount:child,api});
        const root=child.querySelector('.browser-credentials');
        const copying=[...(root?.children||[])].find(node=>node.getAttribute('aria-label')==='Copy passwords to a browser');
        const queue=[...(root?.children||[])].find(node=>node.getAttribute('aria-label')==='Browser copy queue');
        if(copying&&queue){
          const introduction=[...root.children].find(node=>node.tagName==='P');
          if(introduction)introduction.textContent='Manage logins saved for BLACKICE agents. Generated logins and passwords you save here share the same vault.';
          const optional=mount.ownerDocument.createElement('details');
          optional.className='credentials-section next-password-copy';
          const summary=mount.ownerDocument.createElement('summary');
          summary.textContent='Optional: copy logins to another browser';
          optional.append(summary,copying,queue);root.append(optional);
        }
      }
      else void controller.refresh(true);
    },
    leave(){active=false;child.remove();},
    destroy(){if(destroyed)return;this.leave();destroyed=true;controller?.destroy();controller=null;},
  };
}
