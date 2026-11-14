import {randomUUID} from 'node:crypto';
import {visualSvgUrl} from '../public/visual-document.mjs';
import {ASSET_INSPECTION,assetInspectionHtml} from './visual-inspection.mjs';

// Private, disposable Chromium surface. Never navigates a user tab or persists a draft.
export function createVisualPreview({BrowserWindow,session}){
 let pending=Promise.resolve();
 return (compiled,{signal,inspection}={})=>{
  const task=pending.catch(()=>{}).then(async()=>{
   signal?.throwIfAborted();if(inspection!==undefined&&inspection!=='asset')throw Error('Unknown visual inspection mode.');const url=visualSvgUrl(compiled.svg);if(!url)throw Error('Preview requires a validated static SVG.');
   const isolated=session.fromPartition('visual-preview-'+randomUUID());
   isolated.setPermissionCheckHandler(()=>false);
   isolated.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
   isolated.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('data:')&&details.url!=='about:blank'}));
   const win=new BrowserWindow({show:false,width:800,height:600,useContentSize:true,webPreferences:{session:isolated,offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
   win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   const cancel=()=>{if(!win.isDestroyed())win.destroy();};signal?.addEventListener('abort',cancel,{once:true});
   const timer=setTimeout(cancel,15000);
   try{
    await win.loadURL(url);signal?.throwIfAborted();
    const dimensions=await win.webContents.executeJavaScript(`(()=>{const s=document.documentElement,v=s.viewBox.baseVal;const w=v.width||s.width.baseVal.value||800,h=v.height||s.height.baseVal.value||500;return {width:w,height:h}})()`);
    const scale=Math.min(1,900/dimensions.width,1400/dimensions.height),width=Math.max(200,Math.round(dimensions.width*scale)),height=Math.max(150,Math.round(dimensions.height*scale));
    win.setContentSize(width,height);
    const diagnostics=await win.webContents.executeJavaScript(`(()=>{const s=document.documentElement;if(!s.viewBox.baseVal.width)s.setAttribute('viewBox','0 0 ${dimensions.width} ${dimensions.height}');s.style.width='100%';s.style.height='100%';${compiled.document.kind==='composed'&&!compiled.document.regions?.length?"s.style.filter='grayscale(1) invert(.88)';":''}const v=s.getBoundingClientRect(),issues=[],labels=[...s.querySelectorAll('text')].map(t=>{const m=t.getScreenCTM();return {text:t.textContent.slice(0,100),box:t.getBoundingClientRect(),font:parseFloat(getComputedStyle(t).fontSize)*Math.hypot(m.a,m.b)}}).filter(t=>t.box.width&&t.box.height);for(const t of labels){const b=t.box;if(b.x<v.x-.5||b.y<v.y-.5||b.right>v.right+.5||b.bottom>v.bottom+.5)issues.push({kind:'text-outside-canvas',text:t.text});}for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){const a=labels[i].box,b=labels[j].box;if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>2)issues.push({kind:'text-overlap',text:[labels[i].text,labels[j].text]});}return {textCount:labels.length,minimumTextSize:labels.length?Math.min(...labels.map(t=>t.font)):null,issues:issues.slice(0,20),issueCount:issues.length,scope:'Advisory text bounds and text overlaps at this preview size; inspect the image for other collisions, small labels, excessive whitespace and misleading relationships.'}})()`);
    await new Promise(resolve=>setTimeout(resolve,100));signal?.throwIfAborted();
    const capture=await win.webContents.capturePage();const png=capture.resize({width}).toPNG();
    if(png.length>8*1024*1024)throw Error('Preview exceeds image limit.');
    const result={imageUrl:'data:image/png;base64,'+png.toString('base64'),width,height,diagnostics,
     qualityAssessment:{status:'not-assessed',reason:'Text-layout diagnostics and successful rendering do not assess color, silhouette, composition, usability or production readiness.'}};
    if(inspection==='asset'){
     win.setContentSize(ASSET_INSPECTION.width,ASSET_INSPECTION.height);
     await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(assetInspectionHtml(compiled.svg)));
     await win.webContents.executeJavaScript('Promise.all([...document.images].map(image=>image.decode()))');
     signal?.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,100));signal?.throwIfAborted();
     const sheet=(await win.webContents.capturePage()).resize({width:ASSET_INSPECTION.width}).toPNG();
     if(sheet.length>8*1024*1024)throw Error('Inspection exceeds image limit.');
     result.inspectionImageUrl='data:image/png;base64,'+sheet.toString('base64');result.inspection=ASSET_INSPECTION;
    }
    return result;
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);cancel();await isolated.clearStorageData().catch(()=>{});}
  });pending=task;return task;
 };
}
