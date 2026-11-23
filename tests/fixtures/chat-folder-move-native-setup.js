(async()=>{
  document.body.innerHTML='<div id="chat-proof"></div>';
  const {createChatFrame}=await import('/next/chat/render.mjs');
  const {createConversationFolderUI}=await import('/next/chat/folders.mjs');
  const mount=document.querySelector('#chat-proof'),view=createChatFrame(mount);
  const state={revision:4,healthy:true,folders:[
    {id:'z',name:'Zebra',state:'active'},
    {id:'deep',name:'Delta',parentId:'z',state:'active'},
    {id:'root',name:'Alpha',state:'active'},
    {id:'child',name:'Bravo',parentId:'root',state:'active'}
  ]};
  const item={rootId:'fixture-chat',title:'Disposable chat',folderId:'root',folderSource:'manual'};
  const proof={state,item,calls:[]};
  const api=async(route,method='GET',body)=>{
    if(method!=='POST')return{folderOrganization:proof.state};
    proof.calls.push({route,method,body});
    if(body.expectedRevision!==proof.state.revision)throw Object.assign(Error('Revision conflict'),{status:409});
    proof.item.folderId=body.operations[0].folderId;
    proof.state={...proof.state,revision:proof.state.revision+1};
    return{folderOrganization:proof.state};
  };
  proof.view=view;
  proof.ui=createConversationFolderUI({view,api,getItems:()=>[proof.item],getBucket:()=> 'active'});
  proof.ui.onListLoaded([item],state);
  window.chatProof=proof;
  return true;
})()