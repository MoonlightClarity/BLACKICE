import {createDraftStore,draftKey,draftWorkspace} from './draft-store.mjs';
import {renderWorkflowMap,handleWorkflowMapAction,readWorkflowMapView,restoreWorkflowMapView} from './workflow-map.mjs';
import {projectViewModel,projectPortfolio,projectGroupOutline,projectTaskOutline,isPreparedReview,reviewOriginalSource} from './project-view-model.mjs';
import {projectPlan,projectMetadata,emptyProject,newProjectStep,newMethodStep,newMethodInput,newMilestone,isSequentialPlan,sequenceSteps,moveStep,removeProjectStep,methodDefinition,applyMethodPreview,authoredProjectContext,combineProjectContext,projectDraftIssue,metadataIssue,methodDraftIssue,planningPrompt,defaultOntology,lines} from './process-model.mjs';
import {createProcessRenderer} from './process-ui.mjs';
import {coordinationNavigation} from './coordination-navigation.mjs';

export function initProjectsUI({api,showModal,closeModal,toast,escape,icon,getCwd=()=>'',getModels=()=>[],onOpenRun,onDraftInChat,onOpenPlanning,draftStore=createDraftStore()}){
  const $=selector=>document.querySelector(selector),alive=()=>state.active&&Boolean($('#projects-workspace'));
  const state={active:false,methods:[],methodPage:{methods:[],offset:0,limit:20,total:0,totalMethods:0,nextOffset:null,facets:{}},methodSearch:{query:'',domain:'',phase:'',output:'',offset:0},methodLoading:false,ontology:structuredClone(defaultOntology),methodsError:'',methodId:'',methodValues:{},methodContext:'',methodDraft:null,typeDraft:null,trackingDraft:null,highlightMethod:null,projects:[],organization:{revision:null,groups:[]},organizationEditor:null,history:'active',capabilities:[],health:null,selected:null,workflowTask:null,renderedView:null,tab:'projects',filter:'all',draft:null,editing:null,baseRevision:null,busy:false,error:'',request:0,draftKey:null,persisted:null,scope:null,view:0,editor:0};let timer,methodTimer,methodIntent=0;const methodCache=new Map(),methodRequests=new Map(),methodFailures=new Set();
  const statusLabel=status=>({draft:'Plan ready',running:'Working',paused:'Paused',completed:'Agent-reviewed',needs_attention:'Needs attention',pending:'Waiting',verifying:'Reviewing',blocked:'Blocked'})[status]||status;
  const disabled=()=>state.busy?' disabled':'';
  const button=(action,label,{id='',task='',extra='',primary=false}={})=>`<button type="button" class="button${primary?' primary':''}" data-project="${action}" data-id="${escape(id)}" data-task="${escape(task)}" ${extra}${disabled()}>${label}</button>`;
  const field=(label,control)=>`<label class="field"><span class="field-label">${label}</span>${control.replace(/<(input|textarea|select)\b/,`<$1 aria-label="${escape(label)}"`)}</label>`;
  const selected=()=>state.projects.find(item=>item.id===state.selected);
  const portfolio=()=>projectPortfolio(state.projects,{filter:state.filter,history:state.history,blockedReason:state.health?.projects?.blockedReason});
  const groupedPlans=()=>projectGroupOutline(state.projects,{groups:state.organization.groups,filter:state.filter,history:state.history,blockedReason:state.health?.projects?.blockedReason});
  const organizationReady=()=>Number.isSafeInteger(state.organization.revision)&&state.organization.healthy!==false;
  const plan=projectPlan;
  const process=createProcessRenderer({escape,button,field});
  const editingAnything=()=>Boolean(state.draft||state.methodDraft||state.typeDraft||state.trackingDraft);
  function syncMethods(){const entries=new Map(state.methodPage.methods.map(method=>[method.id,method]));for(const [id,method]of methodCache)entries.set(id,method);state.methods=[...entries.values()];}
  const pagedMethods=()=>state.methodPage.methods.map(method=>{const full=methodCache.get(method.id);return full?.revision===method.revision?full:method;});
  async function methodDetail(id){
    const existing=methodCache.get(id),summary=state.methodPage.methods.find(method=>method.id===id);if(existing&&(!summary||existing.revision===summary.revision))return existing;
    const owner=state.view,key=owner+':'+id+':'+(summary?.revision??'current');if(methodRequests.has(key))return methodRequests.get(key);
    const request=(async()=>{const method=await api('/api/methods/'+encodeURIComponent(id));if(method?.id!==id||!Array.isArray(method.steps)||!Number.isSafeInteger(method.revision))throw Error('The method response did not include its complete saved definition.');if(owner===state.view&&alive()){const current=state.methodPage.methods.find(item=>item.id===id),newer=methodCache.get(id);if(newer&&newer.revision>method.revision)return newer;if(current&&current.revision>method.revision)throw Error('This method changed while its procedure was loading. Open it again to read the current revision.');methodCache.delete(id);methodCache.set(id,method);while(methodCache.size>40){const first=[...methodCache.keys()].find(key=>key!==state.methodId&&key!==id);if(!first)break;methodCache.delete(first);}syncMethods();}return method;})();methodRequests.set(key,request);
    try{return await request;}finally{if(methodRequests.get(key)===request)methodRequests.delete(key);}
  }
  async function withMethod(id,operation){const owner=state.view,editor=state.editor,intent=++methodIntent,owns=()=>owner===state.view&&editor===state.editor&&intent===methodIntent&&alive();try{const method=await methodDetail(id);if(owns())return operation(method);}catch(error){if(owns()){state.methodsError=error.message;render();toast(error.message,true);}}}
  function searchURL(){const params=new URLSearchParams({compact:'true',limit:'20',query:state.methodSearch.query});for(const key of ['domain','phase','output'])if(state.methodSearch[key])params.set(key,state.methodSearch[key]);if(state.methodSearch.offset){params.set('offset',String(state.methodSearch.offset));params.set('catalogRevision',state.methodSearch.catalogRevision);}return '/api/methods?'+params;}
  function acceptMethods(page){if(!Array.isArray(page.methods)||!Number.isSafeInteger(page.total)||!Number.isSafeInteger(page.totalMethods)||typeof page.catalogRevision!=='string')throw Error('The method catalog returned an incomplete search page.');if(state.methodPage.catalogRevision&&page.catalogRevision!==state.methodPage.catalogRevision)methodCache.clear();state.methodPage=page;state.methodSearch.offset=page.offset;state.methodSearch.catalogRevision=page.catalogRevision;if(page.ontology)state.ontology=page.ontology;syncMethods();state.methodsError=page.status?.healthy===false?page.status.error||'The method library needs attention.':'';}
  async function searchMethods({restart=true}={}){
    clearTimeout(methodTimer);methodIntent++;const owner=state.view,request=++state.request;state.methodLoading=true;state.methodsError='';render();
    try{const page=await api(searchURL());if(owner!==state.view||request!==state.request||!alive())return;acceptMethods(page);}
    catch(error){if(owner!==state.view||request!==state.request||!alive())return;if(restart&&state.methodSearch.offset&&error.code==='METHOD_CATALOG_CONFLICT'){state.methodSearch.offset=0;delete state.methodSearch.catalogRevision;return searchMethods({restart:false});}state.methodsError=error.message;}
    finally{if(owner===state.view&&request===state.request&&alive()){state.methodLoading=false;render();}}
  }
  function changeMethodSearch(){const form=$('#project-method-search');if(!form)return false;state.methodSearch={query:form.elements.namedItem('query').value.trim(),domain:form.elements.namedItem('domain').value,phase:form.elements.namedItem('phase').value,output:form.elements.namedItem('output').value,offset:0};state.highlightMethod=null;state.request++;methodIntent++;clearTimeout(methodTimer);return true;}
  function inputValues(id){return Object.hasOwn(state.methodValues,id)?state.methodValues[id]:{};}
  function setInputValue(methodId,inputId,value){if(!Object.hasOwn(state.methodValues,methodId))Object.defineProperty(state.methodValues,methodId,{value:{},enumerable:true,writable:true,configurable:true});Object.defineProperty(state.methodValues[methodId],inputId,{value,enumerable:true,writable:true,configurable:true});}
  const workspaceScope=()=>draftKey('projects',draftWorkspace(getCwd()));
  const drafts=()=>draftStore.list(state.scope||workspaceScope()).filter(item=>(item.key===state.scope||item.key.startsWith((state.scope||workspaceScope())+':'))&&item.data?.draft&&Array.isArray(item.data.draft.tasks));
  function restoreDraft(saved){state.returnPlanKey=null;state.editor++;state.draft=structuredClone(saved.data.draft);state.editing=saved.data.editing||null;state.baseRevision=saved.data.baseRevision||null;state.draftKey=saved.key;state.persisted=structuredClone(saved.data);state.methodId=saved.data.methodId||'';state.methodValues=structuredClone(saved.data.methodValues||{});state.methodContext=saved.data.methodContext||saved.data.draft.methodContext||'';state.tab='projects';state.error='';}
  function persist(){if(!state.draft||!state.draftKey)return;const result=draftStore.save(state.draftKey,{draft:state.draft,editing:state.editing,baseRevision:state.baseRevision,...(state.methodId?{methodId:state.methodId}:{}),...(state.methodContext?{methodContext:state.methodContext}:{}),...(Object.keys(state.methodValues).length?{methodValues:state.methodValues}:{})});state.persisted=result.data;if(result.error)state.error=result.error;}
  function newDraft(project,{goal='',methodId=''}={}){
    state.returnPlanKey=null;const existing=project&&drafts().find(item=>item.data.editing===project.id);
    if(existing){restoreDraft(existing);render();return $('#project-name')?.focus();}
    state.editor++;state.draft=project?plan(project):emptyProject(getCwd(),goal);state.editing=project?.id||null;state.baseRevision=project?.revision||null;
    state.methodId=methodId;state.methodValues={};state.methodContext=project?.methodContext||'';state.trackingDraft=null;state.tab='projects';
    const unique=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.draftKey=(state.scope||workspaceScope())+':'+unique;state.error='';persist();render();$('#project-name')?.focus();
  }
  function renderDrafts(){const available=drafts().filter(item=>item.key!==state.draftKey||!state.draft);return available.length?`<details class="project-settings project-drafts"><summary>Resume draft · ${available.length}</summary><div class="project-actions">${available.map(item=>button('resume-draft',escape(item.data.draft.name||'Untitled plan'),{id:item.key})).join('')}</div></details>`:'';}
  function beginOrganization(kind,id=''){
    if(editingAnything())return toast('Save this draft or return to your plans before organizing them.');
    const project=state.projects.find(item=>item.id===id),group=state.organization.groups.find(item=>item.id===id);
    if(['rename-plan','move-plan'].includes(kind)&&!project||kind==='rename-group'&&!group)return;
    if(kind!=='rename-plan'&&!organizationReady())return toast('Refresh Swarms to load the saved plan groups.',true);
    if(kind==='new-group')id='group_'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
    state.organizationEditor={kind,id,label:project?.name||group?.name||'',name:kind==='rename-plan'?project.name:kind==='rename-group'?group.name:'',groupId:project?.groupId||'',expectedRevision:state.organization.revision,projectRevision:project?.revision,error:''};
    render();$('#project-organization-editor')?.elements.namedItem(kind==='move-plan'?'groupId':'name')?.focus();
  }
  function renderOrganizationEditor(){
    const editor=state.organizationEditor;if(!editor)return'';
    const title=({'rename-plan':'Rename plan','move-plan':'Move plan to a group','new-group':'Create a group','rename-group':'Rename group'})[editor.kind];
    const control=editor.kind==='move-plan'?field('Group',`<select name="groupId"><option value=""${!editor.groupId?' selected':''}>Ungrouped</option>${editor.groupId&&!state.organization.groups.some(group=>group.id===editor.groupId)?`<option value="${escape(editor.groupId)}" selected disabled>Unavailable group</option>`:''}${state.organization.groups.map(group=>`<option value="${escape(group.id)}"${editor.groupId===group.id?' selected':''}>${escape(group.name)}</option>`).join('')}</select>`):field(editor.kind==='rename-plan'?'Plan name':'Group name',`<input name="name" value="${escape(editor.name)}" maxlength="${editor.kind==='rename-plan'?160:120}" required autocomplete="off">`);
    return`<form id="project-organization-editor" class="project-organization-editor" novalidate><div><h3>${title}</h3>${editor.label?`<p>${escape(editor.label)}</p>`:''}</div>${control}<div class="project-actions">${button('cancel-organization','Cancel')}<button class="button primary" type="submit"${state.busy||editor.kind!=='rename-plan'&&!organizationReady()?' disabled':''}>${editor.kind==='move-plan'?'Move plan':editor.kind==='new-group'?'Create group':'Save name'}</button></div>${editor.error?`<p class="error-text" role="alert">${escape(editor.error)}</p>${button('reload-organization','Refresh saved details')}`:''}</form>`;
  }
  function readOrganizationEditor(){const form=$('#project-organization-editor'),editor=state.organizationEditor;if(!form||!editor)return;for(const key of ['name','groupId']){const value=form.elements.namedItem(key)?.value;if(value!==undefined)editor[key]=value;}}
  async function saveOrganization(){
    readOrganizationEditor();const editor=state.organizationEditor;if(!editor||state.busy)return;
    if(editor.kind!=='rename-plan'&&!organizationReady()){editor.error=state.organization.error||'Refresh Swarms to load the saved plan groups.';render();return;}
    const name=editor.name.trim(),maximum=editor.kind==='rename-plan'?160:120;if(editor.kind!=='move-plan'&&(!name||name.length>maximum||/[\u0000-\u001f\u007f]/.test(name))){editor.error=`Use a name from 1 to ${maximum} characters on one line.`;render();return;}
    const submitted={kind:editor.kind,name:editor.name,groupId:editor.groupId},owner=state.view,owns=()=>owner===state.view&&alive()&&state.organizationEditor===editor;state.busy=true;state.request++;editor.error='';render();
    try{
      if(editor.kind==='rename-plan'){
        const saved=await api('/api/projects/'+encodeURIComponent(editor.id),'PUT',{expectedRevision:editor.projectRevision,name});
        if(!owns())return;state.projects=state.projects.map(project=>project.id===saved.id?{...project,...saved}:project);editor.projectRevision=saved.revision;
      }else{
        const operation=editor.kind==='move-plan'?{type:'update_project',projectId:editor.id,groupId:editor.groupId||null}:editor.kind==='rename-group'?{type:'rename_group',groupId:editor.id,name}:{type:'create_group',id:editor.id,name};
        const result=await api('/api/planning/organization','POST',{expectedRevision:editor.expectedRevision,operations:[operation]});
        if(!owns())return;state.organization=result.organization||result;editor.expectedRevision=state.organization.revision;
        if(editor.kind==='new-group'&&editor.name!==submitted.name&&state.organization.createdGroupIds?.[0]){editor.kind='rename-group';editor.id=state.organization.createdGroupIds[0];editor.label=name;}
      }
      const changed=editor.name!==submitted.name||editor.groupId!==submitted.groupId;
      if(!changed)state.organizationEditor=null;state.error='';await load({force:true});if(owner===state.view&&alive())toast(changed?'The submitted change was saved. Your newer edit is still here.':submitted.kind==='move-plan'?'Plan moved.':submitted.kind==='new-group'?'Group created.':'Name saved.');
    }catch(error){if(owns())editor.error=error.message;}
    finally{if(owner===state.view&&alive()){state.busy=false;render();}}
  }
  async function load({force=false,initial=false}={}){
    const request=++state.request,owner=state.view;
    const responses=await Promise.allSettled([api('/api/projects'),api('/api/capabilities'),api(searchURL())]);
    if(request!==state.request||owner!==state.view||!alive())return;
    const before=JSON.stringify([state.projects,state.organization,state.capabilities,state.methods,state.health,state.methodsError]);
    const [data,library,methods]=responses;
    if(data.status==='fulfilled'){state.projects=data.value.projects;const organization=data.value.organization;state.organization=organization?.healthy!==false&&Number.isSafeInteger(organization?.revision)&&Array.isArray(organization.groups)?organization:{revision:null,groups:[],...(organization?{healthy:false,error:organization.error||'Saved plan names, groups and archive state are unavailable. Refresh them before organizing plans.'}:{})};state.health={...state.health,projects:data.value.status};if(state.revealProjectId){const requested=state.projects.find(item=>item.id===state.revealProjectId);if(requested){state.history=requested.archived?'archived':'active';state.selected=requested.id;}state.revealProjectId=null;}}
    else state.error=data.reason.message;
    if(library.status==='fulfilled'){state.capabilities=library.value.capabilities;state.health={...state.health,capabilities:library.value.status};}
    else state.health={...state.health,capabilities:{healthy:false,error:library.reason.message}};
    if(methods.status==='fulfilled'){try{acceptMethods(methods.value);}catch(error){state.methodsError=error.message;}}
    else if(state.methodSearch.offset&&methods.reason?.code==='METHOD_CATALOG_CONFLICT'){state.methodSearch.offset=0;delete state.methodSearch.catalogRevision;return load({force:true,initial});}
    else state.methodsError=`The method library could not be loaded. ${methods.reason.message}`;
    const wanted=state.methodId||state.highlightMethod;if(wanted&&!methodCache.has(wanted)){try{await methodDetail(wanted);}catch(error){if(owner===state.view)state.methodsError=error.message;}if(request!==state.request||owner!==state.view||!alive())return;}
    if(!portfolio().items.some(item=>item.project.id===state.selected))state.selected=portfolio().items[0]?.project.id||null;
    const pristineInitial=initial; // Render current editor values; focus and selection are restored below.
    if((!editingAnything()||pristineInitial)&&(force||before!==JSON.stringify([state.projects,state.organization,state.capabilities,state.methods,state.health,state.methodsError])))render();
  }
  function modelOptions(value){const options=getModels(value).filter(model=>model.available!==false);if(!options.some(model=>model.value===value))options.unshift({value,label:value==='default'?'Use default model':value});return options.map(model=>`<option value="${escape(model.value)}"${model.value===value?' selected':''}>${escape(model.label||model.value)}</option>`).join('');}
  function renderEditor(){const draft=state.draft;return `<form id="project-editor" class="project-editor" novalidate>
    <div class="project-section-heading"><div><span class="section-eyebrow">GOAL &amp; PLAN</span><h3>${state.editing?'Shape this saved swarm':'What should this swarm accomplish?'}</h3><p>Describe the outcome, then give each specialist a task and acceptance checks. Saving keeps the swarm ready for you to start.</p></div>${onDraftInChat?button('plan-in-chat','Ask agent to plan'):''}</div>
    ${field('What should this make possible?',`<textarea id="project-objective" name="objective" rows="3" maxlength="8000" placeholder="Describe the result you need, who it helps, and the limits of this work." required>${escape(draft.objective)}</textarea>`)}
    <div class="project-two-fields">${field('Swarm name',`<input id="project-name" name="name" value="${escape(draft.name)}" maxlength="160" placeholder="A short name for this outcome" required>`)}${field('Working folder',`<input id="project-cwd" name="cwd" value="${escape(draft.cwd)}" required>`)}</div>
    ${process.projectSteps(draft,state.ontology)}
    <details class="project-settings" data-detail="editor:tracking"><summary>Project details &amp; milestones</summary>${process.trackingFields(draft,{tasks:draft.tasks})}</details>
    <details class="project-settings" data-detail="editor:models"><summary>Models, context &amp; repair budget</summary><div class="project-three-fields">${field('Implementation model',`<select name="model">${modelOptions(draft.model)}</select>`)}${field('Review model',`<select name="verifierModel">${modelOptions(draft.verifierModel)}</select>`)}${field('Repairs per task',`<select name="maxRepairs">${[0,1,2,3].map(value=>`<option${value===draft.maxRepairs?' selected':''}>${value}</option>`).join('')}</select>`)}</div>${field('Shared project context',`<textarea name="context" rows="3" maxlength="8000" placeholder="Source paths or context shared with each step. Original supplied inputs are kept separately below.">${escape(authoredProjectContext(draft.context,state.methodContext))}</textarea>`)}${state.methodContext?`<details class="process-applied-context" data-detail="editor:method-context"><summary>Original supplied input context</summary><p class="project-help">These inputs were saved with the original plan and remain available to its workers.</p><pre>${escape(state.methodContext)}</pre></details>`:''}<p class="project-help">A separate model turn reviews each step. Specific failed checks guide repairs within this budget.</p></details>
    <p class="project-help">A completed response must pass its saved acceptance checks before dependent work starts. Reviews are agent-reported; inspect the evidence for consequential work.</p>
    <div class="project-editor-actions"><p>Saving a plan starts no work.</p>${button('cancel-edit','Back to saved swarms')}<button class="button primary" type="submit"${disabled()}>${state.busy?'Saving…':state.editing?'Save changes':'Save swarm'}</button></div></form>`;}
  const methodScope=()=>draftKey('methods',draftWorkspace(getCwd()));
  const methodDrafts=()=>draftStore.list(methodScope()).filter(saved=>saved.data?.definition&&Array.isArray(saved.data.definition.steps));
  const uniqueKey=prefix=>prefix+':'+(globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  function persistMethod(){
    const editor=state.methodDraft;if(!editor)return;
    const result=draftStore.save(editor.key,{definition:editor.definition,editing:editor.editing,baseRevision:editor.baseRevision,source:editor.source});
    editor.persisted=result.data;if(result.error)state.error=result.error;
  }
  function restoreMethod(saved){state.editor++;state.methodDraft={...structuredClone(saved.data),key:saved.key,persisted:structuredClone(saved.data)};state.tab='methods';state.error='';}
  function startMethod(method){
    if(state.methodDraft)persistMethod();
    const saved=method&&methodDrafts().find(item=>item.data.editing===method.id||item.data.source===method.id);
    if(saved)restoreMethod(saved);
    else{state.editor++;state.methodDraft={definition:methodDefinition(method),editing:method?.origin==='custom'?method.id:null,baseRevision:method?.origin==='custom'?method.revision:null,source:method?.origin==='builtin'?method.id:null,key:uniqueKey(methodScope())};state.tab='methods';state.error='';persistMethod();}
    state.typeDraft=null;render();$('#method-name')?.focus();
  }
  function persistType(){if(!state.typeDraft)return;const result=draftStore.save(state.typeKey,{type:state.typeDraft});if(result.error)state.error=result.error;}
  function startType(kind,type){
    if(state.methodDraft)readMethodEditor();
    if(state.draft)readEditor();
    if(state.typeDraft){toast('Your current type draft is still open. Save it or go back first.');return;}
    state.typeKey=methodScope()+':type:'+kind;const saved=!type&&draftStore.load(state.typeKey);
    state.typeDraft=saved?.data?.type?.kind===kind?structuredClone(saved.data.type):{kind,name:type?.name||'',description:type?.description||'',...(type?{id:type.id,expectedRevision:type.revision}:{})};
    persistType();render();$('#method-type-name')?.focus();
  }
  function persistTracking(){const editor=state.trackingDraft;if(!editor)return;const result=draftStore.save(editor.key,{tracking:{projectId:editor.projectId,expectedRevision:editor.expectedRevision,values:editor.values}});editor.persisted=result.data;if(result.error)state.error=result.error;}
  function startTracking(project,{fresh=false}={}){
    const key=(state.scope||workspaceScope())+':metadata:'+project.id,saved=!fresh&&draftStore.load(key);
    state.editor++;state.trackingDraft={...(saved?.data?.tracking?.projectId===project.id?structuredClone(saved.data.tracking):{projectId:project.id,expectedRevision:project.revision,values:projectMetadata(project)}),key};state.error='';persistTracking();render();
  }
  function readTrackingFields(form,values){
    const control=name=>form.elements.namedItem(name);
    for(const name of ['name','priority','owner','dueDate','notes'])if(control(name))values[name]=control(name).value;
    if(control('tags'))values.tags=[...new Set(control('tags').value.split(',').map(item=>item.trim()).filter(Boolean))];
    const groups=[...form.querySelectorAll('[data-milestone-editor]')];
    values.milestones=groups.map(node=>{
      const previous=values.milestones?.find(item=>item.id===node.dataset.milestoneEditor)||{},taskIds=[...node.querySelectorAll('[name=milestoneTask]:checked')].map(input=>input.value);
      return{...previous,id:node.dataset.milestoneEditor,title:node.querySelector('[name=milestoneTitle]').value,dueDate:node.querySelector('[name=milestoneDueDate]').value,taskIds,done:taskIds.length?false:node.querySelector('[name=milestoneDone]')?.checked===true};
    });
  }
  function readMethodEditor(){
    const form=$('#method-editor'),editor=state.methodDraft;if(!form||!editor)return;
    const value=name=>form.elements.namedItem(name)?.value;Object.assign(editor.definition,{name:value('name'),description:value('description'),taskType:value('taskType')});
    editor.definition.inputs=[...form.querySelectorAll('[data-method-input]')].map(node=>({id:node.dataset.methodInput,label:node.querySelector('[name=inputLabel]').value,description:node.querySelector('[name=inputDescription]').value,required:node.querySelector('[name=inputRequired]').checked}));
    editor.definition.steps=[...form.querySelectorAll('[data-method-step]')].map(node=>({id:node.dataset.methodStep,title:node.querySelector('[name=title]').value,type:node.querySelector('[name=type]').value,instructions:node.querySelector('[name=instructions]').value,result:node.querySelector('[name=result]').value,inputs:lines(node.querySelector('[name=stepInputs]').value),checks:lines(node.querySelector('[name=checks]').value)}));
    persistMethod();
  }
  function readTypeEditor(){const form=$('#method-type-editor');if(!form||!state.typeDraft)return;state.typeDraft.name=form.elements.namedItem('name').value;state.typeDraft.description=form.elements.namedItem('description').value;persistType();}
  function readMetadataEditor(){const form=$('#project-metadata-editor');if(!form||!state.trackingDraft)return;readTrackingFields(form,state.trackingDraft.values);persistTracking();}
  function renderTrackingEditor(){
    const editor=state.trackingDraft,project=state.projects.find(item=>item.id===editor.projectId);
    return`<form id="project-metadata-editor" class="project-editor process-metadata-editor" novalidate><div class="project-section-heading"><div><span class="section-eyebrow">PROJECT TRACKING</span><h3>Keep the outcome on track</h3><p>Edit ownership, timing, notes, and milestones. The execution plan and its saved evidence stay intact.</p></div></div>${process.trackingFields(editor.values,{tasks:project?.tasks||[],includeName:true})}<details class="project-settings" data-detail="metadata:revision"><summary>Saved revision ${escape(editor.expectedRevision)}</summary><p class="project-help">If this project changed elsewhere, refresh these details before editing again. This replaces this details draft with the latest saved values.</p>${button('reload-metadata','Use latest saved details',{id:editor.projectId})}</details><div class="project-editor-actions"><p>Linked milestones complete when their steps pass review.</p>${button('cancel-metadata','Back to project')}<button class="button primary" type="submit">Save details</button></div></form>`;
  }
  async function draftInChat({forMethod=false}={}){
    if(!onDraftInChat)return toast('Open Chat to ask your agent to prepare a draft plan.');
    if(state.draft)readEditor();if(state.methodDraft)readMethodEditor();
    const draft=state.draft||(!forMethod&&selected()?plan(selected()):null),method=forMethod?state.methodDraft?.definition:state.methods.find(item=>item.id===state.methodId),goal=draft?.objective||method?.description||method?.name||'';
    if(!goal.trim())return toast('Describe your goal first so the agent has something concrete to plan.',true);
    const projectId=!forMethod?(state.editing||(!state.draft?selected()?.id:undefined)):undefined;
    const request={prompt:planningPrompt({goal,draft,method,projectId,ontology:state.ontology}),goal,...(state.methodId?{methodId:state.methodId}:{}),...(projectId?{projectId}:{}),...(state.draftKey?{draftKey:state.draftKey}:{})};
    const view=state.view;try{await onDraftInChat(request);}catch(error){if(view===state.view&&alive())toast(error.message,true);}
  }
  function workerAttempts(row){
    return `<ol class="project-attempt-outline">${row.attempts.map(({attempt,workers})=>`<li><details class="project-attempt" data-detail="attempt:${escape(row.task.id)}:${escape(attempt.number)}"${attempt===row.task.attempts.at(-1)?' open':''}><summary>${attempt.mode==='review_only'?`Review-only attempt ${escape(attempt.number)} · original attempt ${escape(attempt.sourceAttempt)}`:`Attempt ${escape(attempt.number)}${attempt.implementation?.notAdmitted?' · not started':''}`}</summary><ol class="project-worker-outline">${workers.map(({kind,phase,label,reused,runId})=>`<li class="project-worker" data-project-worker="${kind}"><div class="project-worker-heading"><strong>${escape(label)}</strong><span class="project-status">${escape(phase.status==='prepared'?'Review prepared':phase.status)}</span></div>${reused?'<p class="project-help">Reuses the original implementation; this attempt starts a separate review.</p>':''}<div class="project-actions">${runId?button('open-run','Open worker run',{id:runId})+(onOpenPlanning?button('worker-plan','Open worker plan',{id:runId}):''):'<span class="project-help">No run has started.</span>'}</div>${phase.error?`<p class="error-text">${escape(phase.error)}</p>`:''}${phase.verdict?`<p>${escape(phase.verdict.summary)}</p>`:''}</li>`).join('')}</ol></details></li>`).join('')}</ol>`;
  }
  function taskHTML(task,row){const attempt=task.attempts.at(-1),verdict=attempt?.verification?.verdict,prepared=isPreparedReview(task),source=reviewOriginalSource(task),taskLabel=prepared?'Review prepared':task.status==='pending'?(task.dependsOn.every(id=>selected()?.tasks.find(item=>item.id===id)?.status==='completed')?'Ready':'Waiting for prerequisites'):statusLabel(task.status);
    const implementations=task.attempts.filter(item=>item.mode!=='review_only'&&!item.implementation?.notAdmitted).length,reviews=task.attempts.filter(item=>item.mode==='review_only').length,unstarted=task.attempts.filter(item=>item.mode!=='review_only'&&item.implementation?.notAdmitted).length;
    const history=[`${implementations} implementation ${implementations===1?'attempt':'attempts'}`,reviews?`${reviews} review-only ${reviews===1?'attempt':'attempts'}`:'',unstarted?`${unstarted} unstarted ${unstarted===1?'repair':'repairs'}`:'',`${task.maxRepairs} repairs per implementation cycle`].filter(Boolean).join(' · ');
    const passed=task.acceptanceCriteria.filter(criterion=>verdict?.criteria.some(check=>check.criterion===criterion&&check.passed===true)).length,checks=verdict?`${passed}/${task.acceptanceCriteria.length} checks passed`:`${task.acceptanceCriteria.length} ${task.acceptanceCriteria.length===1?'check':'checks'}`,expanded=state.workflowTask===task.id||['running','verifying','blocked'].includes(task.status);
    return `<article class="project-task-card" data-project-task="${escape(task.id)}" data-workflow-selected="${state.workflowTask===task.id}" tabindex="-1" aria-label="${escape(task.title)}" data-status="${escape(task.status)}"><details class="project-task-disclosure" data-detail="task:${escape(task.id)}" data-task-state="${escape(task.status)}"${expanded?' open':''}><summary class="project-task-summary"><span class="project-outline-number" aria-hidden="true">${row.number}</span><span class="project-task-title"><strong>${escape(task.title)}</strong><span class="project-check-count">${escape(checks)}${task.attempts.length?` · ${task.attempts.length} ${task.attempts.length===1?'attempt':'attempts'}`:''}</span></span><span class="project-status">${escape(taskLabel)}</span><span class="project-task-chevron" aria-hidden="true">${icon('down',15)}</span></summary><div class="project-task-detail">${state.workflowTask===task.id?`<div class="project-task-navigation">${button('back-to-map','Back to workflow',{task:task.id})}</div>`:''}${row.dependencies.length?`<nav class="project-outline-dependencies" aria-label="Prerequisites for ${escape(task.title)}"><span>After</span>${row.dependencies.map(dependency=>dependency.known?button('focus-task',escape(dependency.title),{task:dependency.id}):`<span>${escape(dependency.title)}</span>`).join('')}</nav>`:''}${task.result?`<div class="process-expected-result"><span class="section-eyebrow">EXPECTED RESULT</span><p>${escape(task.result)}</p></div>`:''}<p class="project-task-instructions">${escape(task.instructions)}</p>${task.inputs?.length?`<p class="project-help">Uses: ${task.inputs.map(escape).join(' · ')}</p>`:''}<ul class="project-checks">${task.acceptanceCriteria.map(criterion=>{const check=verdict?.criteria.find(item=>item.criterion===criterion);return `<li data-passed="${check?.passed??''}"><span aria-hidden="true">${check?check.passed?'✓':'×':'○'}</span><div>${escape(criterion)}${check?`<small>${escape(check.evidence)}</small>`:''}</div></li>`;}).join('')}</ul>${task.error?`<p class="error-text" role="status">${escape(task.error)}</p>`:''}
    ${task.status==='blocked'?`<div class="project-actions">${task.retryHold?.runId?button('open-run','Inspect original run',{id:task.retryHold.runId}):!selected()?.archived?button('retry-task','Prepare another attempt',{id:state.selected,task:task.id}):''}${source&&!selected()?.archived?button('review-task','Review original result',{id:state.selected,task:task.id}):''}</div>${source&&!selected()?.archived?'<p class="project-help">Prepare a separate review of the existing result. Resume explicitly to start it; implementation and delivery will not repeat.</p>':''}`:''}
    ${prepared?`<p class="project-help">${selected()?.archived?'Restore this plan, then resume':'Resume'} to review the original result. No new implementation or delivery is prepared.</p>`:''}
    ${task.attempts.length?`<details class="project-attempts" data-detail="${escape(task.id)}"><summary>Workers &amp; attempts · ${history}</summary>${workerAttempts(row)}</details>`:'<p class="project-help">Implementation and review workers appear here when their runs start.</p>'}</div></details></article>`;
  }
  function renderTaskOutline(project,model){
    return `<section class="project-plan-outline" aria-label="Plan tasks and workers"><div class="project-section-heading project-evidence-heading"><div><h4>Tasks &amp; workers</h4><p>${model.evidence.implementationRuns} implementation runs · ${model.evidence.reviewRuns} review runs. Expand a task to inspect its checks and workers.</p></div><div class="project-actions">${button('expand-tasks','Expand tasks')}${button('collapse-tasks','Collapse tasks')}</div></div><ol class="project-task-outline" aria-label="Ordered project steps">${projectTaskOutline(project).map(row=>`<li>${taskHTML(row.task,row)}</li>`).join('')}</ol></section>`;
  }
  function renderPortfolio(){const {counts}=portfolio(),labels=[['all','All statuses'],['attention','Needs attention'],['working','Working'],['ready','Ready / paused'],['reviewed','Agent-reviewed']];return `<details class="project-status-filter" data-detail="catalog:status"><summary>Filter by status${state.filter!=='all'?' · '+labels.find(([key])=>key===state.filter)?.[1]:''}</summary><div class="project-portfolio" role="group" aria-label="Filter projects by status">${labels.map(([key,label])=>`<button type="button" data-project="filter" data-id="${key}" aria-pressed="${state.filter===key}" data-project-bucket="${key}"><span>${label}</span><strong>${counts[key]}</strong></button>`).join('')}</div></details>`;}
  function renderProjectList(){
    const outline=groupedPlans();
    return `<aside class="project-list" aria-label="Saved swarm plans"><div class="project-catalog-heading"><h3>Saved swarms</h3><div class="project-history-tabs" role="group" aria-label="Plan history">${[['active','Active plans',outline.activeCount],['archived','Archive',outline.archivedCount]].map(([key,label,count])=>`<button type="button" data-project="history" data-id="${key}" aria-pressed="${state.history===key}">${label}<span>${count}</span></button>`).join('')}</div><p class="project-list-caption">${state.history==='archived'?'Archived plans stay available for inspection.':'Each saved swarm keeps its tasks, checks and worker history.'}</p>${Number.isSafeInteger(state.organization.revision)?button('new-group','New group'):''}</div>${renderPortfolio()}<nav class="project-groups" aria-label="Plan groups">${outline.groups.map(group=>`<details class="project-group" data-detail="group:${escape(group.id||'ungrouped')}" data-project-group="${escape(group.id||'ungrouped')}" open><summary><span class="project-group-chevron" aria-hidden="true">${icon('chevron',13)}</span><strong>${escape(group.name)}</strong><span>${group.items.length}</span></summary><div class="project-group-body">${group.id&&Number.isSafeInteger(state.organization.revision)?`<div class="project-group-actions">${button('rename-group','Rename group',{id:group.id})}</div>`:''}<ol class="project-group-plans">${group.items.map(({project,model})=>`<li><button type="button" class="project-list-item" data-project="select" data-id="${escape(project.id)}" data-project-bucket="${model.bucket}" aria-current="${state.selected===project.id?'true':'false'}"><strong>${escape(project.name)}</strong><small><span class="project-list-dot" aria-hidden="true"></span>${escape(statusLabel(project.status))}</small><span class="project-list-count">${model.reviewed}/${model.total} tasks reviewed${model.counts.blocked?` · ${model.counts.blocked} blocked`:''}</span></button></li>`).join('')}</ol>${!group.items.length?'<p class="project-group-empty">No plans in this group.</p>':''}</div></details>`).join('')||'<p class="project-group-empty">No archived plans.</p>'}</nav>${!outline.items.length&&state.filter!=='all'?button('filter','Clear status filter',{id:'all'}):''}</aside>`;
  }
  function renderProject(){
    const project=selected();
    if(!project&&state.projects.length)return `<div class="project-empty"><h3>${state.history==='archived'?'No archived plans in this view.':'No active plans in this view.'}</h3><p>${state.filter==='all'?'Choose a group or create a new plan.':'Clear the status filter to see the other plans in this view.'}</p>${state.filter!=='all'?button('filter','Clear status filter',{id:'all'}):button('history',state.history==='archived'?'View active plans':'View archive',{id:state.history==='archived'?'active':'archived'})}</div>`;
    if(!project)return `<div class="project-empty"><span class="project-empty-mark">${icon('workflow',30)}</span><h3>Build a swarm you can return to.</h3><p>Save a goal, specialist tasks and acceptance checks. Start it when ready, then follow each task to its worker run and plan.</p><div class="project-empty-actions">${button('new','Create a saved swarm',{primary:true})}${onOpenPlanning?button('planning','Browse chat plans'):''}</div><div class="project-loop"><span>Group</span><b>→</b><span>Plan</span><b>→</b><span>Tasks &amp; workers</span></div></div>`;
    const model=projectViewModel(project,{blockedReason:state.health?.projects?.blockedReason}),next=model.next,nextTask=project.tasks.find(task=>task.id===next.taskId),archived=project.archived===true;
    const canEdit=!archived&&!project.tasks.some(task=>task.attempts.length)&&['draft','paused','needs_attention'].includes(project.status),executing=project.status==='running'||project.tasks.some(task=>['running','verifying'].includes(task.status)&&!isPreparedReview(task));
    return `<div class="project-detail"><div class="project-section-heading project-detail-header"><div><span class="section-eyebrow">${escape(project.groupName||'Ungrouped')} / ${archived?'ARCHIVE':'PLAN'}</span><h3>${escape(project.name)}</h3><span class="project-status">${escape(statusLabel(project.status))}</span></div><div class="project-actions">${!archived&&['draft','paused'].includes(project.status)?button('start',project.status==='paused'?(model.preparedReview?'Resume to review':'Resume swarm'):'Start swarm',{id:project.id,primary:true}):''}${!archived&&project.status==='running'?button('pause','Pause after current phase',{id:project.id}):''}${canEdit?button('edit','Edit plan',{id:project.id}):''}</div></div>
      <div class="project-plan-organization" aria-label="Organize this plan">${button('rename-plan','Rename',{id:project.id})}${Number.isSafeInteger(state.organization.revision)?button('move-plan','Move to group',{id:project.id})+button(archived?'restore-plan':'archive-plan',archived?'Restore plan':'Archive',{id:project.id,extra:!archived&&executing?'disabled title="Pause and wait for active workers to finish before archiving."':''}):''}</div>
      ${archived?'<p class="project-notice" role="status">This plan is archived. Its tasks and worker evidence remain available. Restore it before starting or changing its work.</p>':''}
      <span class="section-eyebrow">OUTCOME</span><p class="project-objective">${escape(project.objective)}</p>${project.method?`<details class="process-method-source"><summary>Original starting point</summary><p>${escape(project.method.name)} · revision ${escape(project.method.revision)}</p></details>`:''}
      <div class="project-summary"><span>${model.reviewed} / ${model.total} tasks reviewed</span><details class="project-folder" data-detail="metadata:folder"><summary>Working folder</summary><span>${escape(project.cwd)}</span></details></div><div class="project-progress" role="progressbar" aria-label="Reviewed project tasks" aria-valuenow="${model.reviewed}" aria-valuemin="0" aria-valuemax="${model.total}"><span style="width:${model.percent}%"></span></div>
      ${!archived?`<section class="project-next-action" data-next-kind="${next.kind}" aria-label="Next step"><div><span class="project-next-label">Next action</span><h4>${escape(next.title)}</h4>${nextTask?`<strong class="project-next-task">${escape(nextTask.title)}</strong>`:''}<p>${escape(next.description)}</p>${model.blockedTasks.length>1?`<p>${model.blockedTasks.length} tasks are blocked. Inspect each task's evidence before retrying.</p>`:''}</div>${next.taskId?button('focus-task',escape(next.label)+icon('chevron',14),{task:next.taskId}):''}</section>`:''}
      ${project.pauseReason&&project.pauseReason!==next.description?`<p class="project-notice" role="status">${escape(project.pauseReason)}</p>`:''}<div class="project-task-totals" aria-label="Task status">${[['working','Working'],['blocked','Blocked'],['ready','Ready'],['waiting','Waiting'],['reviewed','Reviewed']].map(([key,label])=>`<span data-task-state="${key}"><b>${model.counts[key]}</b> ${label}</span>`).join('')}</div>
      ${renderTaskOutline(project,model)}${process.trackingSummary(project,model)}<details class="process-advanced-map" data-detail="project:graph"><summary>Advanced dependency graph</summary>${renderWorkflowMap({kind:'project',project,selectedId:state.workflowTask,instanceId:'project-flow-'+project.id})}</details>
      <p class="project-help">Separate review turns check the saved criteria. Evidence remains linked to its actual runs. BLACKICE must stay open for execution.</p></div>`;
  }
  function renderCapabilities(){return `<div class="project-capabilities"><div class="project-section-heading"><div><span class="section-eyebrow">REVIEWED HISTORY</span><h3>Plans with working evidence.</h3><p>These saved capabilities retain the original agent reviews. Using one creates a new plan that needs its own checks.</p></div></div>${state.capabilities.length?state.capabilities.map(item=>`<article class="project-capability-card"><span class="project-status">Agent-reviewed</span><h4>${escape(item.name)}</h4><p>${escape(item.description)}</p><small>${item.definition.tasks.length} tasks · ${item.evidence.reduce((sum,item)=>sum+item.verdict.criteria.length,0)} recorded checks · ${escape(new Date(item.createdAt).toLocaleDateString())}</small><div>${button('use-capability','Use as starting plan',{id:item.id,primary:true})}${button('source','View evidence',{id:item.sourceProjectId})}</div></article>`).join(''):`<div class="project-empty"><h3>Your reviewed work will collect here.</h3><p>Finish a project and save its method with the acceptance checks and actual runs that supplied its evidence.</p></div>`}</div>`;}
  function taskCard(taskId){return [...$('#projects-workspace')?.querySelectorAll('[data-project-task]')||[]].find(node=>node.dataset.projectTask===taskId);}
  function focusControl(action,id){[...$('#projects-workspace')?.querySelectorAll('[data-project]')||[]].find(node=>node.dataset.project===action&&node.dataset.id===id)?.focus({preventScroll:true});}
  function focusTask(taskId){const project=selected();if(!project?.tasks.some(task=>task.id===taskId))return;state.workflowTask=taskId;render();const card=taskCard(taskId),disclosure=[...card?.querySelectorAll('details[data-detail]')||[]].find(node=>node.dataset.detail==='task:'+taskId);if(disclosure)disclosure.open=true;card?.focus({preventScroll:true});card?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'auto'});}
  function rememberFocus(view){const active=document.activeElement;if(!view.contains?.(active))return null;for(const formId of ['project-editor','method-editor','method-type-editor','project-metadata-editor','project-method-search','project-organization-editor'])if(active?.name&&active.closest?.('#'+formId)){const group=['taskEditor','methodStep','methodInput','milestoneEditor'].map(key=>({key,node:active.closest?.('[data-'+key.replace(/[A-Z]/g,char=>'-'+char.toLowerCase())+']')})).find(item=>item.node);return{control:active.name,option:['checkbox','radio'].includes(active.type)?active.value:null,formId,group:group?{key:group.key,id:group.node.dataset[group.key]}:null,start:active.selectionStart,end:active.selectionEnd};}const node=active.closest?.('[data-workflow-node]'),mapAction=active.closest?.('[data-workflow-action]');if(node)return{node:node.dataset.workflowNode};if(mapAction)return{mapAction:mapAction.dataset.workflowAction};const card=active.closest?.('[data-project-task]'),action=active.closest?.('[data-project]'),summary=active.closest?.('summary');return{...(card?{task:card.dataset.projectTask}:{}),...(action?{action:action.dataset.project,id:action.dataset.id,actionTask:action.dataset.task}:{}),...(summary?{detail:summary.closest('details[data-detail]')?.dataset.detail}:{})};}
  function restoreFocus(view,focus){if(!focus)return;let target;if(focus.control){const form=$('#'+focus.formId),attribute=focus.group?'data-'+focus.group.key.replace(/[A-Z]/g,char=>'-'+char.toLowerCase()):null,container=attribute?[...form?.querySelectorAll('['+attribute+']')||[]].find(node=>node.dataset[focus.group.key]===focus.group.id):form;target=[...container?.querySelectorAll('[name]')||[]].find(node=>node.name===focus.control&&(focus.option===null||focus.option===undefined||node.value===focus.option))||(!focus.group?form?.elements.namedItem(focus.control):null);}else if(focus.node)target=[...view.querySelectorAll('[data-workflow-node]')].find(node=>node.dataset.workflowNode===focus.node);else if(focus.mapAction)target=[...view.querySelectorAll('[data-workflow-action]')].find(node=>node.dataset.workflowAction===focus.mapAction);else{const container=focus.task?taskCard(focus.task):view;if(focus.action)target=[...container?.querySelectorAll('[data-project]')||[]].find(node=>node.dataset.project===focus.action&&node.dataset.id===focus.id&&node.dataset.task===focus.actionTask);else if(focus.detail)target=[...container?.querySelectorAll('details[data-detail]')||[]].find(node=>node.dataset.detail===focus.detail)?.querySelector('summary');else target=container;}target?.focus?.({preventScroll:true});if(focus.control&&typeof focus.start==='number')try{target?.setSelectionRange?.(focus.start,focus.end);}catch{}}
  function render(){
    if(!alive())return;
    const view=$('#projects-workspace'),viewKey=JSON.stringify([state.selected,state.tab,state.draft?state.draftKey:null,state.methodDraft?.key,state.typeDraft?.kind,state.trackingDraft?.key,state.organizationEditor?.kind,state.organizationEditor?.id]),sameView=state.renderedView===viewKey,scroll=sameView?view.querySelector('.project-main')?.scrollTop||0:0,listScroll=view.querySelector('.project-list')?.scrollTop||0,disclosures=new Map([...view.querySelectorAll('details[data-detail]')].filter(node=>sameView||/^(group:|catalog:)/.test(node.dataset.detail)).map(node=>[node.dataset.detail,{open:node.open,status:node.dataset.taskState}])),mapView=sameView?readWorkflowMapView(view):null,focus=sameView?rememberFocus(view):null;
    if(state.workflowTask&&!selected()?.tasks.some(task=>task.id===state.workflowTask))state.workflowTask=null;
    const single=editingAnything()||!state.projects.length&&!state.organization.groups.length;
    const content=state.typeDraft?process.typeEditor(state.typeDraft):state.trackingDraft?renderTrackingEditor():state.draft?renderEditor():renderProject();
    view.innerHTML=`${coordinationNavigation('swarms')}<div class="project-tabs"><div class="project-library-heading"><strong>Saved swarms <span>${state.projects.filter(project=>!project.archived).length}</span></strong><p>Keep tasks, checks and worker history together.</p></div><button type="button" class="button" data-action="swarm">Create one-off swarm</button>${!editingAnything()&&!state.projects.length&&Number.isSafeInteger(state.organization.revision)?button('new-group','New group'):''}${button('new','New saved swarm',{primary:true})}</div>${renderDrafts()}${renderOrganizationEditor()}${state.error?`<p class="project-error error-text" role="alert">${escape(state.error)}</p>`:''}${state.health?.projects?.healthy===false?`<p class="project-error error-text" role="alert">${escape(state.health.projects.error)}</p>`:''}${state.organization.healthy===false?`<div class="project-error" role="alert"><p class="error-text">${escape(state.organization.error)} Names, groups and archive membership cannot be confirmed until this is resolved.</p>${button('refresh-organization','Refresh groups')}</div>`:''}<div class="project-layout${single?' single':''}">${!single?renderProjectList():''}<div class="project-main">${content}</div></div>`;
    if(state.busy)for(const control of view.querySelectorAll('button,input,select,textarea'))control.disabled=true;
    const main=view.querySelector('.project-main'),list=view.querySelector('.project-list');if(main)main.scrollTop=scroll;if(list)list.scrollTop=listScroll;
    for(const node of view.querySelectorAll('details[data-detail]')){const previous=disclosures.get(node.dataset.detail),newAttention=previous?.status!==node.dataset.taskState&&['running','verifying','blocked'].includes(node.dataset.taskState);if(previous&&!newAttention)node.open=previous.open;}
    restoreWorkflowMapView(view,mapView);state.renderedView=viewKey;restoreFocus(view,focus);
  }
  function readEditor(){
    const form=$('#project-editor');if(!form||!state.draft)return;
    const value=name=>form.elements.namedItem(name)?.value;
    Object.assign(state.draft,{name:value('name'),objective:value('objective'),cwd:value('cwd'),model:value('model'),verifierModel:value('verifierModel'),maxRepairs:Number(value('maxRepairs'))});
    if(value('context')!==undefined)state.draft.context=combineProjectContext(value('context'),state.methodContext);state.draft.methodContext=state.methodContext;
    const previousMethod=state.methods.find(method=>method.id===state.methodId);
    if(previousMethod)for(const input of previousMethod.inputs||[]){const control=form.elements.namedItem('method-input:'+input.id);if(control)setInputValue(previousMethod.id,input.id,control.value);}
    if(value('methodId')!==undefined)state.methodId=value('methodId');
    state.draft.tasks=[...form.querySelectorAll('[data-task-editor]')].map(node=>{
      const task={...state.draft.tasks.find(task=>task.id===node.dataset.taskEditor),id:node.dataset.taskEditor,title:node.querySelector('[name=title]').value,instructions:node.querySelector('[name=instructions]').value,acceptanceCriteria:lines(node.querySelector('[name=criteria]').value),dependsOn:[...node.querySelectorAll('[name=dependency]:checked')].map(node=>node.value)};
      if(node.querySelector('[name=result]')&&(node.querySelector('[name=result]').value||Object.hasOwn(task,'result')))task.result=node.querySelector('[name=result]').value;
      if(node.querySelector('[name=stepInputs]')&&(node.querySelector('[name=stepInputs]').value||Object.hasOwn(task,'inputs')))task.inputs=lines(node.querySelector('[name=stepInputs]').value);
      const type=node.querySelector('[name=stepType]');if(type?.value)task.stepType=type.value;else if(type)delete task.stepType;
      return task;
    });
    readTrackingFields(form,state.draft);persist();
  }
  function readActive(){readOrganizationEditor();if(state.typeDraft)readTypeEditor();else if(state.trackingDraft)readMetadataEditor();else if(state.methodDraft)readMethodEditor();else if(state.draft)readEditor();}
  function leaveEditor(){readActive();state.draft=null;state.methodDraft=null;state.typeDraft=null;state.trackingDraft=null;state.error='';state.editor++;}
  function reportIssue(message){state.error=message;toast(message,true);render();const main=$('#projects-workspace')?.querySelector('.project-main');if(main)main.scrollTop=0;}
  async function action(operation){if(state.busy)return;const view=state.view,mount=$('#projects-workspace'),owns=()=>state.view===view&&$('#projects-workspace')===mount;state.busy=true;state.error='';for(const control of mount?.querySelectorAll('button,input,select,textarea')||[])control.disabled=true;
    try{const result=await operation(owns);if(!owns())return result;await load({force:true});return result;}catch(error){if(owns()){state.error=error.message;toast(error.message,true);}}finally{if(owns()){state.busy=false;render();}}}
  document.addEventListener('input',event=>{
    if(!alive())return;
    if(event.target.closest('#project-organization-editor')){readOrganizationEditor();return;}
    if(event.target.closest('#project-method-search')){if(changeMethodSearch())methodTimer=setTimeout(()=>searchMethods(),180);return;}
    if(event.target.closest('#project-editor')){const prior=state.methodId;readEditor();if(state.methodId!==prior){const id=state.methodId;render();if(id)void withMethod(id,()=>{if(state.methodId===id){render();$('#project-method')?.focus();}});else $('#project-method')?.focus();}}
    else if(event.target.closest('#method-editor'))readMethodEditor();
    else if(event.target.closest('#method-type-editor'))readTypeEditor();
    else if(event.target.closest('#project-metadata-editor'))readMetadataEditor();
  });
  document.addEventListener('change',event=>{
    if(!alive())return;
    if(event.target.closest('#project-organization-editor')){readOrganizationEditor();return;}
    if(event.target.closest('#project-method-search')){if(changeMethodSearch())void searchMethods();return;}
    if(event.target.closest('#project-editor')){const prior=state.methodId;readEditor();if(state.methodId!==prior||event.target.name==='milestoneTask'){const id=state.methodId;render();if(id&&state.methodId!==prior)void withMethod(id,()=>{if(state.methodId===id){render();$('#project-method')?.focus();}});}}
    else if(event.target.closest('#method-editor'))readMethodEditor();
    else if(event.target.closest('#method-type-editor'))readTypeEditor();
    else if(event.target.closest('#project-metadata-editor')){readMetadataEditor();if(event.target.name==='milestoneTask')render();}
  });
  document.addEventListener('submit',event=>{
    if(event.target.id==='project-organization-editor'&&alive()){event.preventDefault();return saveOrganization();}
    if(event.target.id==='project-method-search'&&alive()){event.preventDefault();if(changeMethodSearch())void searchMethods();return;}
    if(!['project-editor','method-editor','method-type-editor','project-metadata-editor'].includes(event.target.id)||!alive())return;
    event.preventDefault();if(state.busy)return;
    if(event.target.id==='project-editor'){
      readEditor();const issue=projectDraftIssue(state.draft);if(issue)return reportIssue(issue);
      const payload=structuredClone(state.draft),id=state.editing,revision=state.baseRevision,key=state.draftKey,persisted=state.persisted,editor=state.editor,signature=JSON.stringify(payload);
      return void action(async owns=>{const project=await api(id?`/api/projects/${encodeURIComponent(id)}`:'/api/projects',id?'PUT':'POST',{...payload,...(id?{expectedRevision:revision}:{})});draftStore.remove(key,{expected:persisted});if(owns()&&state.editor===editor&&JSON.stringify(state.draft)===signature){state.draft=null;state.editing=null;state.draftKey=null;state.persisted=null;state.selected=project.id;state.revealProjectId=project.id;state.history=project.archived?'archived':'active';state.tab='projects';state.filter='all';state.methodId='';state.methodValues={};state.methodContext='';}return project;});
    }
    if(event.target.id==='method-editor'){
      readMethodEditor();const editor=state.methodDraft,issue=methodDraftIssue(editor.definition);if(issue)return reportIssue(issue);
      const payload=structuredClone(editor.definition),signature=JSON.stringify(payload),persisted=editor.persisted;
      return void action(async owns=>{const method=await api(editor.editing?`/api/methods/${encodeURIComponent(editor.editing)}`:'/api/methods',editor.editing?'PUT':'POST',{...payload,...(editor.editing?{expectedRevision:editor.baseRevision}:{})});draftStore.remove(editor.key,{expected:persisted});if(owns()&&state.methodDraft===editor){if(JSON.stringify(editor.definition)===signature){state.methodDraft=null;state.highlightMethod=method.id;state.methodSearch={query:method.name,domain:'',phase:'',output:'',offset:0};methodCache.set(method.id,method);syncMethods();state.tab='methods';toast('Method saved. Choose Use method to prepare a project plan.');}else{editor.editing=method.id;editor.baseRevision=method.revision;editor.source=null;persistMethod();}}return method;});
    }
    if(event.target.id==='method-type-editor'){
      readTypeEditor();const draft=state.typeDraft;if(!draft.name.trim())return reportIssue('Give this type a name.');
      const payload=structuredClone(draft),signature=JSON.stringify(payload),key=state.typeKey;
      return void action(async owns=>{const type=await api(draft.id?`/api/method-types/${encodeURIComponent(draft.id)}`:'/api/method-types',draft.id?'PUT':'POST',draft.id?{expectedRevision:draft.expectedRevision,name:draft.name,description:draft.description}:{kind:draft.kind,name:draft.name,description:draft.description});draftStore.remove(key,{expected:{type:payload}});if(owns()&&state.typeDraft===draft){if(JSON.stringify(draft)===signature){state.typeDraft=null;toast('Type saved. It is now available to your methods.');}else{draft.id=type.id;draft.expectedRevision=type.revision;persistType();}}return type;});
    }
    readMetadataEditor();const editor=state.trackingDraft,issue=metadataIssue(editor.values);if(issue)return reportIssue(issue);
    const values=structuredClone(editor.values),signature=JSON.stringify(values),persisted=editor.persisted;
    return void action(async owns=>{const project=await api(`/api/projects/${encodeURIComponent(editor.projectId)}`,'PUT',{expectedRevision:editor.expectedRevision,...values});draftStore.remove(editor.key,{expected:persisted});if(owns()&&state.trackingDraft===editor){if(JSON.stringify(editor.values)===signature){state.trackingDraft=null;state.selected=project.id;toast('Project details saved.');}else{editor.expectedRevision=project.revision;persistTracking();}}return project;});
  });
  document.addEventListener('toggle',event=>{
    const disclosure=event.target,id=disclosure?.dataset?.methodDetail;if(!id||!disclosure.closest?.('#projects-workspace')||!alive())return;if(!disclosure.open){methodFailures.delete(id);return;}const cached=methodCache.get(id),summary=state.methodPage.methods.find(method=>method.id===id);if(cached&&(!summary||cached.revision===summary.revision)||methodFailures.has(id))return;
    const owner=state.view;void methodDetail(id).then(()=>{if(owner===state.view&&alive())render();}).catch(error=>{if(owner===state.view&&alive()){methodFailures.add(id);state.methodsError=error.message;const hint=disclosure.querySelector('[role="status"]');if(hint)hint.textContent='The full method could not be loaded. Close and reopen these details to retry. '+error.message;}});
  },true);
  document.addEventListener('click',event=>{
    if(!alive())return;
    const mapAction=event.target.closest('[data-workflow-action]'),mapNode=event.target.closest('[data-workflow-node]');
    if(mapAction?.closest('#projects-workspace')){handleWorkflowMapAction(mapAction);return;}
    if(mapNode?.closest('#projects-workspace')){focusTask(mapNode.dataset.workflowNode);return;}
    const target=event.target.closest('[data-project]');if(!target||state.busy)return;const name=target.dataset.project,id=target.dataset.id;
    if(['rename-plan','move-plan','new-group','rename-group'].includes(name))return beginOrganization(name,id);
    if(name==='cancel-organization'){state.organizationEditor=null;return render();}
    if(name==='refresh-organization')return void action(()=>Promise.resolve());
    if(name==='reload-organization'){const editor=state.organizationEditor;return void action(async owns=>{await load({force:true});if(owns()&&state.organizationEditor===editor){editor.expectedRevision=state.organization.revision;editor.projectRevision=state.projects.find(project=>project.id===editor.id)?.revision;editor.error=editor.kind!=='rename-plan'&&!organizationReady()?state.organization.error||'Saved plan groups are unavailable.':'';const recovered=editor.kind==='new-group'&&state.organization.groups.find(group=>group.id===editor.id);if(recovered){editor.kind='rename-group';editor.label=recovered.name;toast('The earlier group was saved. Review its name before saving further changes.');}}return null;});}
    if(name==='history'){if(!['active','archived'].includes(id))return;readOrganizationEditor();state.history=id;state.filter='all';state.selected=portfolio().items[0]?.project.id||null;state.workflowTask=null;render();return focusControl('history',id);}
    if(name==='expand-tasks'||name==='collapse-tasks'){for(const detail of $('#projects-workspace').querySelectorAll('details[data-detail]'))if(detail.dataset.detail.startsWith('task:'))detail.open=name==='expand-tasks';return;}
    if(name==='archive-plan'||name==='restore-plan'){
      const project=state.projects.find(item=>item.id===id);if(!project||!Number.isSafeInteger(state.organization.revision))return;
      const archived=name==='archive-plan';if(archived&&(project.status==='running'||project.tasks.some(task=>['running','verifying'].includes(task.status)&&!isPreparedReview(task))))return toast('Pause and wait for active workers to finish before archiving this plan.',true);
      const expectedRevision=state.organization.revision;return void action(async owns=>{const result=await api('/api/planning/organization','POST',{expectedRevision,operations:[{type:'update_project',projectId:id,archived}]});if(owns()){state.organization=result.organization||result;if(!archived){state.history='active';state.selected=id;state.revealProjectId=id;}toast(archived?'Plan archived.':'Plan restored.');}return result;});
    }
    if(name==='worker-plan'){
      const owner=state.view;state.busy=true;render();
      return Promise.resolve(api('/api/runs/'+encodeURIComponent(id))).then(result=>{if(owner!==state.view||!alive())return;const run=result.run||result,taskId=run.taskState?.taskId||run.taskId;if(run.id!==id||!taskId)throw Error('This worker has no saved plan yet. Open its run to inspect its current work.');cancel();closeModal();return onOpenPlanning?.({taskId,...(run.taskState?{taskState:run.taskState}:{}),runId:id,runStatus:run.status});}).catch(error=>{if(owner===state.view&&alive()){state.error=error.message;toast(error.message,true);}}).finally(()=>{if(owner===state.view&&alive()){state.busy=false;render();}});
    }
    if(name==='planning'){cancel();return onOpenPlanning?.();}
    if(name==='methods-previous'||name==='methods-next'){if(state.methodLoading)return;const offset=name==='methods-next'?state.methodPage.nextOffset:Math.max(0,state.methodPage.offset-state.methodPage.limit);if(offset==null)return;state.methodSearch.offset=offset;state.highlightMethod=null;return void searchMethods();}
    if(name==='new'){if(state.draft){toast('Your current swarm draft is still open. Save it or return to saved swarms first.');return $('#project-name')?.focus();}leaveEditor();state.tab='projects';return newDraft();}
    if(name==='resume-draft'){const saved=drafts().find(item=>item.key===id);if(!saved)return toast('This draft is no longer available.',true);leaveEditor();restoreDraft(saved);render();return $('#project-name')?.focus();}
    if(name==='filter'){if(!['all','attention','working','ready','reviewed'].includes(id))return;state.filter=id;const items=portfolio().items;if(!items.some(item=>item.project.id===state.selected)){state.selected=items[0]?.project.id||null;state.workflowTask=null;}render();return focusControl('filter',id);}
    if(name==='focus-task')return focusTask(target.dataset.task);
    if(name==='back-to-map'){const node=[...$('#projects-workspace').querySelectorAll('[data-workflow-node]')].find(node=>node.dataset.workflowNode===target.dataset.task),details=node?.closest('.process-advanced-map');if(details)details.open=true;node?.focus({preventScroll:true});return node?.closest('.workflow-map')?.scrollIntoView({block:'start',inline:'nearest',behavior:'auto'});}
    if(name==='select'||name==='source'){state.returnPlanKey=null;leaveEditor();state.tab='projects';if(name==='source'){state.filter='all';state.history=state.projects.find(project=>project.id===id)?.archived?'archived':'active';}if(state.selected!==id)state.workflowTask=null;state.selected=id;state.error='';render();return focusControl('select',id);}
    if(name==='tab'){leaveEditor();state.tab=id==='capabilities'?'methods':id==='methods'?'methods':'projects';return render();}
    if(name==='cancel-edit'){persist();state.draft=null;state.error='';return render();}
    if(name==='edit')return newDraft(selected());
    if(name==='plan-in-chat')return void draftInChat();
    if(name==='plan-method-in-chat')return void draftInChat({forMethod:true});
    if(name==='browse-methods'){if(state.draft){readEditor();state.returnPlanKey=state.draftKey;}leaveEditor();state.tab='methods';return render();}
    if(name==='show-method')return void withMethod(id,method=>{leaveEditor();state.tab='methods';state.highlightMethod=id;state.methodSearch={query:method.name,domain:'',phase:'',output:'',offset:0};return searchMethods();});
    if(name==='refresh-methods'){methodFailures.clear();return void action(()=>Promise.resolve());}
    if(name==='choose-method'){
      return void withMethod(id,method=>{if(method.outline){if(onOpenPlanning)return onOpenPlanning(method);throw new Error('Open this branching method from the task workspace to use it with your agent.');}const saved=state.returnPlanKey&&drafts().find(item=>item.key===state.returnPlanKey);leaveEditor();if(saved){restoreDraft(saved);state.methodId=id;persist();render();}else newDraft(null,{methodId:id});state.returnPlanKey=null;return $('#project-objective')?.focus();});
    }
    if(name==='apply-method'){
      readEditor();const method=methodCache.get(state.methodId),draft=state.draft;if(!method||!draft)return;
      if(!draft.objective.trim())return reportIssue('Describe your goal before filling the plan from a method.');
      if(!draft.cwd.trim())return reportIssue('Choose a working folder before filling the plan.');
      const inputs=structuredClone(inputValues(method.id)),missing=method.inputs.find(input=>input.required&&(!Object.hasOwn(inputs,input.id)||!String(inputs[input.id]).trim()));if(missing)return reportIssue(`Add the required method input: ${missing.label}.`);
      const signature=JSON.stringify([draft,state.methodId,state.methodValues]),editor=state.editor;
      return void action(async owns=>{const preview=await api(`/api/methods/${encodeURIComponent(method.id)}/preview`,'POST',{name:draft.name.trim()||draft.objective.trim().replace(/\s+/g,' ').slice(0,160),objective:draft.objective,cwd:draft.cwd,model:draft.model,verifierModel:draft.verifierModel,maxRepairs:draft.maxRepairs,inputs,priority:draft.priority||'normal',owner:draft.owner||'',dueDate:draft.dueDate||''});if(!owns()||state.editor!==editor)return;if(JSON.stringify([state.draft,state.methodId,state.methodValues])!==signature){toast('Your plan changed while the method was loading. Choose Use method steps again to apply it to your current draft.');return;}state.draft=applyMethodPreview(state.draft,preview,{methodContext:state.methodContext});state.methodContext=preview.methodContext??preview.context??'';persist();toast('Method steps added to your draft. Review and adapt them before saving.');return preview;});
    }
    if(name==='add-task'){readEditor();if(state.draft.tasks.length>=100)return toast('Use at most 100 tasks.',true);state.draft.tasks.push(newProjectStep(state.draft.tasks));persist();render();return $('#project-editor [data-task-editor]:last-of-type input')?.focus();}
    if(name==='remove-task'||name==='task-remove'){readEditor();const taskId=target.dataset.task;if(state.draft.tasks.length<=1)return;if(state.draft.milestones?.some(item=>item.taskIds.includes(taskId)))return toast('Remove this step from its linked milestones before removing it from the plan.',true);state.draft.tasks=removeProjectStep(state.draft.tasks,taskId);persist();return render();}
    if(name==='task-up'||name==='task-down'){readEditor();state.draft.tasks=moveStep(state.draft.tasks,target.dataset.task,name==='task-up'?-1:1,{sequence:isSequentialPlan(state.draft.tasks)});persist();return render();}
    if(name==='sequence-tasks'){readEditor();state.draft.tasks=sequenceSteps(state.draft.tasks);persist();return render();}
    if(name==='new-method'){leaveEditor();return startMethod();}
    if(name==='edit-method')return void withMethod(id,method=>{if(method.outline){if(onOpenPlanning)return onOpenPlanning(method);throw new Error('Open this branching method from the task workspace to inspect and reuse its full outline.');}leaveEditor();return startMethod(method);});
    if(name==='resume-method'){const saved=methodDrafts().find(item=>item.key===id);if(!saved)return toast('This method draft is no longer available.',true);leaveEditor();restoreMethod(saved);return render();}
    if(name==='cancel-method'){readMethodEditor();state.methodDraft=null;state.error='';return render();}
    if(name==='add-method-step'){readMethodEditor();const draft=state.methodDraft.definition;if(draft.steps.length>=50)return toast('Use at most 50 method steps.',true);draft.steps.push(newMethodStep(draft.steps));persistMethod();return render();}
    if(name==='method-step-up'||name==='method-step-down'||name==='method-step-remove'){readMethodEditor();const draft=state.methodDraft.definition;if(name==='method-step-remove'){if(draft.steps.length<=1)return;draft.steps=draft.steps.filter(step=>step.id!==target.dataset.task);}else draft.steps=moveStep(draft.steps,target.dataset.task,name==='method-step-up'?-1:1);persistMethod();return render();}
    if(name==='add-method-input'){readMethodEditor();const draft=state.methodDraft.definition;if(draft.inputs.length>=20)return toast('Use at most 20 method inputs.',true);draft.inputs.push(newMethodInput(draft.inputs));persistMethod();return render();}
    if(name==='remove-method-input'){readMethodEditor();state.methodDraft.definition.inputs=state.methodDraft.definition.inputs.filter(input=>input.id!==target.dataset.task);persistMethod();return render();}
    if(name==='new-type')return startType(id==='step'?'step':'task');
    if(name==='edit-type'){const type=[...state.ontology.taskTypes,...state.ontology.stepTypes].find(item=>item.id===id);if(type?.origin==='custom')return startType(type.kind,type);return;}
    if(name==='cancel-type'){readTypeEditor();state.typeDraft=null;state.error='';return render();}
    if(name==='edit-metadata'){const project=state.projects.find(item=>item.id===id);if(project)return startTracking(project);return;}
    if(name==='cancel-metadata'){readMetadataEditor();state.trackingDraft=null;state.error='';return render();}
    if(name==='reload-metadata'){return void action(async owns=>{const project=await api(`/api/projects/${encodeURIComponent(id)}`);if(owns()&&state.trackingDraft?.projectId===id){state.projects=state.projects.map(item=>item.id===id?project:item);startTracking(project,{fresh:true});}return project;});}
    if(name==='add-milestone'||name==='remove-milestone'){if(state.trackingDraft)readMetadataEditor();else readEditor();const values=state.trackingDraft?.values||state.draft;if(!values)return;if(name==='add-milestone'){if(values.milestones.length>=30)return toast('Use at most 30 milestones.',true);values.milestones.push(newMilestone(values.milestones));}else values.milestones=values.milestones.filter(item=>item.id!==target.dataset.task);if(state.trackingDraft)persistTracking();else persist();return render();}
    if(name==='open-run'){closeModal();return Promise.resolve(onOpenRun?.(id)).catch(error=>toast(error.message,true));}
    if(name==='start'||name==='pause')return void action(()=>api(`/api/projects/${encodeURIComponent(id)}/${name}`,'POST',{}));
    if(name==='retry-task')return void action(()=>api(`/api/projects/${encodeURIComponent(id)}/retry-task`,'POST',{taskId:target.dataset.task}));
    if(name==='review-task'){let ownsView;return void action(owns=>{ownsView=owns;return api(`/api/projects/${encodeURIComponent(id)}/review-task`,'POST',{taskId:target.dataset.task});}).then(project=>{if(project&&ownsView?.())focusControl('start',id);});}
    if(name==='save-capability')return void action(async owns=>{const capability=await api('/api/capabilities','POST',{projectId:id});if(owns()){state.tab='methods';toast('Capability saved with its review evidence.');}return capability;});
    if(name==='use-capability')return void action(async owns=>{const project=await api(`/api/capabilities/${encodeURIComponent(id)}/use`,'POST',{cwd:getCwd()});if(owns()){state.tab='projects';state.filter='all';state.history='active';state.selected=project.id;state.revealProjectId=project.id;toast('New plan saved. Review it before starting.');}return project;});
  });
  function polling(){clearTimeout(timer);const owner=state.view;timer=setTimeout(async()=>{if(!alive()||owner!==state.view)return;if(!editingAnything()&&!state.organizationEditor&&!state.busy&&!state.methodLoading)await load();if(alive()&&owner===state.view)polling();},1400);}
  function cancel(){readActive();clearTimeout(timer);clearTimeout(methodTimer);state.active=false;state.view++;state.editor++;state.request++;state.busy=false;state.methodLoading=false;}
  return{
    async open({projectId,methodId,goal,tab}={}){
      if((tab==='methods'||tab==='capabilities'||methodId)&&onOpenPlanning){cancel();return onOpenPlanning();}
      state.view++;state.editor++;state.request++;state.busy=false;state.active=true;state.methodLoading=false;clearTimeout(timer);clearTimeout(methodTimer);
      const scope=workspaceScope();
      if(state.scope&&state.scope!==scope){readActive();state.draft=null;state.methodDraft=null;state.typeDraft=null;state.trackingDraft=null;state.editing=null;state.draftKey=null;state.persisted=null;state.selected=null;state.workflowTask=null;state.renderedView=null;state.methodId='';state.methodValues={};state.methodContext='';state.returnPlanKey=null;}
      state.scope=scope;
      if(projectId||methodId||goal!==undefined||tab){leaveEditor();state.tab='projects';if(projectId){state.selected=projectId;state.revealProjectId=projectId;state.filter='all';state.workflowTask=null;}if(methodId)state.highlightMethod=methodId;}
      showModal('projects',`<div class="modal-header"><span class="node-icon">${icon('workflow',20)}</span><div class="modal-title"><h2>Swarms</h2><p>Coordinate specialists with saved tasks and checks, or create a one-off swarm.</p></div><button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close',17)}</button></div><div id="projects-workspace" class="projects-workspace"></div>`,true);
      $('#modal-root .modal')?.classList.add('projects-modal');
      if((methodId||goal!==undefined)&&state.tab==='projects')newDraft(null,{goal:goal||'',methodId:methodId||''});
      else if(!editingAnything()&&!state.selected&&!projectId&&!tab&&state.tab==='projects'){const saved=drafts()[0];if(saved)restoreDraft(saved);}
      const owner=state.view;render();await load({force:true,initial:true});if(alive()&&owner===state.view)polling();
    },
    refresh(){if(alive()&&!editingAnything()&&!state.organizationEditor&&!state.busy)return load();},cancel,
  };
}
