import {createChatFrame} from '../../public/next/chat/render.mjs';
import {createAutonomyControls} from '../../public/next/chat/autonomy.mjs';
window.ready=(async()=>{
 const view=createChatFrame(document.querySelector('#mount'));window.view=view;
 const models=Array.from({length:30},(_,i)=>({id:'provider/model-'+i,displayName:i===1?'Provider / Very Long Model Name With Context And Reasoning Capabilities':'Model '+i}));
 let saved={id:'fixture',revision:1,enabled:true,modelAllowlist:['provider/model-0']};
 window.controls=createAutonomyControls({view,getStatus:()=>({models}),getContext:()=>({model:models[0].id}),api:async()=>({autonomy:saved})});
 window.controls.update({conversationId:'fixture'});await window.controls.refresh();view.autonomySettings.click();
 window.measure=()=>{const dialog=view.autonomyDialog, list=view.autonomyModels,row=list.querySelector('label'), box=row.querySelector('input'),name=row.querySelector('span');return {boxWidth:box.getBoundingClientRect().width,nameWidth:name.getBoundingClientRect().width,rowOverflow:row.scrollWidth-row.clientWidth,dialogOverflow:dialog.scrollWidth-dialog.clientWidth,listScrollable:list.scrollHeight>list.clientHeight,dialogHeight:dialog.getBoundingClientRect().height,viewport:{w:innerWidth,h:innerHeight},checkboxChecked:box.checked};};
 window.behavior=()=>{const box=view.autonomyModels.querySelector('input');box.click();const checked=box.checked;view.autonomySearch.value='Model 12';view.autonomySearch.dispatchEvent(new Event('input'));const filter=[...view.autonomyModels.children].filter(x=>!x.hidden).length===1;view.autonomySearch.value='';view.autonomySearch.dispatchEvent(new Event('input'));const preserved=box.checked===checked;view.autonomyCancel.click();const closed=!view.autonomyDialog.open;view.autonomySettings.click();return {filter,preserved,closed,reopened:view.autonomyDialog.open};};
})();
