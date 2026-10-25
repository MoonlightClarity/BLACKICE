/** On-demand artifact preview. Saved bytes are verified by the existing task
 * endpoint; only a selected artifact is fetched. The dialog owns each read.
 */
export function createArtifactViewer({mount,api,notify=()=>{}}={}){
  const doc=mount.ownerDocument;
  const dialog=doc.createElement('dialog');
  dialog.className='next-artifact-dialog';
  dialog.setAttribute('aria-label','Saved file preview');
  const heading=doc.createElement('h2');heading.textContent='Saved file';
  const subtitle=doc.createElement('p');subtitle.className='next-help';
  const content=doc.createElement('section');content.className='next-artifact-content';
  const actions=doc.createElement('div');actions.className='next-row';
  const closeButton=doc.createElement('button');closeButton.type='button';closeButton.textContent='Close';
  actions.append(closeButton);
  const wrapper=doc.createElement('div');wrapper.className='next-artifact-wrapper';
  wrapper.append(heading,subtitle,content,actions);dialog.append(wrapper);mount.append(dialog);
  let controller=null,generation=0;
  const cancel=()=>{
    generation++;controller?.abort();controller=null;
    if(dialog.open)dialog.close();
  };
  closeButton.addEventListener('click',cancel);
  dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});
  const line=(value,tag='p')=>{const child=doc.createElement(tag);child.textContent=String(value||'');content.append(child);return child;};
  async function open({taskId,artifactId}={}){
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(taskId||'') ||
        !/^artifact_[0-9a-f-]{36}$/.test(artifactId||''))throw Error('Choose a saved task file.');
    cancel();
    const token=++generation;
    controller=new AbortController();
    heading.textContent='Opening saved file…';subtitle.textContent='Verifying saved bytes';content.replaceChildren();
    actions.querySelectorAll('a').forEach(node=>node.remove());
    if(!dialog.open)dialog.showModal();
    closeButton.focus({preventScroll:true});
    const base='/api/tasks/'+encodeURIComponent(taskId)+'/artifacts/'+encodeURIComponent(artifactId);
    try{
      const data=await api(base+'/preview','GET',undefined,{signal:controller.signal,deadlineMs:30000});
      if(token!==generation||!dialog.open)return;
      const file=data?.artifact;
      if(!file || typeof file.fileName!=='string')throw Error('The saved file preview was invalid.');
      heading.textContent=file.title||file.fileName;
      subtitle.textContent=file.fileName+' · '+Number(file.size||0).toLocaleString()+' bytes';
      content.replaceChildren();
      const dataImage=data.previewKind==='image'&&typeof data.imageUrl==='string'&&data.imageUrl.length<14*1024*1024&&
        /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(data.imageUrl);
      if(dataImage){
        const img=doc.createElement('img');img.src=data.imageUrl;img.alt=file.title||file.fileName;
        img.className='next-artifact-image';content.append(img);
      }else if(data.previewKind==='text'){
        line(data.content??data.text??'','pre').className='next-artifact-pre';
      }else line(data.message||'This file is available for download or opening in its native application.');
      if(file.sha256)line('SHA-256: '+file.sha256).className='next-help';
      const download=doc.createElement('a');
      download.href=base+'/content';download.download=file.fileName;download.textContent='Download file';
      download.className='next-primary next-artifact-download';actions.prepend(download);
    }catch(error){
      if(token!==generation||controller?.signal.aborted)return;
      heading.textContent='Unable to preview saved file';subtitle.textContent='';
      content.replaceChildren();line(error.message||'Unable to load this artifact.');
      const retry=doc.createElement('button');retry.type='button';retry.textContent='Try again';
      retry.addEventListener('click',()=>void open({taskId,artifactId}).catch(notify));
      content.append(retry);
    }
  }
  return {open,cancel,destroy(){cancel();dialog.remove();}};
}
