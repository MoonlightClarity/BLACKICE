import {sameBrowserOwner} from './browser-conversations.mjs';
const fail=(message,code='BROWSER_TAB_IN_USE')=>Object.assign(new Error(message),{code,status:409,actionDispatched:false});
const valid=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
export function validateTabMark(args){
 if(!args||args.action!=='tab_mark'||!valid(args.tabId)||typeof args.inUse!=='boolean'||args.browser!==undefined&&args.browser!=='relay'||Object.keys(args).some(key=>!['action','browser','tabId','inUse'].includes(key)))throw fail('Mark one observed contained tab with an explicit inUse boolean.','BROWSER_VALIDATION');
}
export function restoredTabMark(entry){
 if(entry?.inUse!==true)return {inUse:false,inUseBy:null};
 const by=entry.inUseBy;
 // Malformed attribution cannot silently remove protection or grant agent authority.
 return {inUse:true,inUseBy:by?.kind==='task'&&valid(by.taskId)&&valid(by.nodeId)?{kind:'task',taskId:by.taskId,nodeId:by.nodeId}:{kind:'user'}};
}
export function tabMarkChange(args,tab,{source,owner}={}){
 validateTabMark(args);
 if(!tab||tab.purpose==='chat-mode')throw fail('Choose an ordinary existing browser tab.','BROWSER_TAB_NOT_FOUND');
 if(source!=='user'){
  if(!owner||!tab.owner||!sameBrowserOwner(tab.owner,owner))throw fail('Only the owning task may mark this tab.','BROWSER_TAB_OWNERSHIP');
  if(tab.inUse&&!(tab.inUseBy?.kind==='task'&&tab.inUseBy.taskId===owner.taskId&&tab.inUseBy.nodeId===owner.nodeId))throw fail('This in-use mark belongs to the person or another worker; leave it intact.');
 }
 return args.inUse?{inUse:true,inUseBy:source==='user'?{kind:'user'}:{kind:'task',taskId:owner.taskId,nodeId:owner.nodeId}}:{inUse:false,inUseBy:null};
}
export function assertTabNotInUse(tab){if(tab?.inUse===true)throw fail('This tab is marked in use. Release your own mark when finished, or ask the person to review it.');}
