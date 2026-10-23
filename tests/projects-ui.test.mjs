import test from 'node:test';
import assert from 'node:assert/strict';
import {initProjectsUI} from '../public/projects-ui.mjs';
import {createDraftStore,draftKey,draftWorkspace} from '../public/draft-store.mjs';
import {defaultOntology} from '../public/process-model.mjs';
import {createMethodSearchIndex} from '../lib/method-catalog.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const flush=async()=>{for(let index=0;index<4;index++)await tick();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const escape=value=>String(value??'').replace(/[<>&"]/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[char]));
const decode=value=>String(value??'').replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&');
const attrs=source=>Object.fromEntries([...source.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([,name,value])=>[name,decode(value??'')]));
const savedProject=()=>({id:'saved-project',revision:7,name:'Saved plan',objective:'Test the project editor round trip.',cwd:'C:/fixture/project',model:'default',verifierModel:'default',maxRepairs:2,status:'draft',tasks:[
  {id:'later-output',title:'Use prerequisite',instructions:'Work after the prerequisite.',acceptanceCriteria:['The dependency is used.'],dependsOn:['prerequisite'],model:'provider::implement-a',verifierModel:'provider::review-a',maxRepairs:0,status:'pending',attempts:[]},
  {id:'prerequisite',title:'Build prerequisite',instructions:'Make a prerequisite.',acceptanceCriteria:['The prerequisite exists.'],dependsOn:[],model:'provider::implement-b',verifierModel:'provider::review-b',maxRepairs:3,status:'pending',attempts:[]},
]});
const heldProject=()=>{const project=savedProject(),task=project.tasks[1];project.status='needs_attention';task.status='blocked';task.error='Inspect the original result before continuing.';task.retryHold={runId:'original-implementation'};task.attempts=[{number:1,implementation:{status:'completed',runId:'original-implementation',requestId:'original-request',output:'Created the original result.'},verification:{status:'completed',runId:'original-review',requestId:'original-review-request',verdict:{passed:false,summary:'The original evidence was incomplete.',criteria:task.acceptanceCriteria.map(criterion=>({criterion,passed:false,evidence:'The original check was incomplete.'}))}}}];return project;};
const reusableMethod=()=>({id:'compare-method',revision:3,origin:'builtin',name:'Compare the options',description:'Make a supported decision.',taskType:'decision',inputs:[{id:'options',label:'Options',description:'The alternatives to compare.',required:true}],steps:[{id:'scope',title:'Define the criteria',type:'scope',instructions:'Record the supplied constraints.',inputs:['Project goal','Options'],result:'A saved set of criteria.',checks:['The constraints are explicit.']},{id:'compare',title:'Compare each option',type:'analyze',instructions:'Compare evidence for each option.',inputs:['Reviewed criteria'],result:'A comparison table.',checks:['Every option is compared.']}]});
const methodPreview=()=>({name:'Compare storage options',objective:'Choose a suitable storage option.',cwd:'C:/fixture/project',model:'default',verifierModel:'default',maxRepairs:2,method:{id:'compare-method',revision:3,origin:'builtin',name:'Compare the options',taskType:'decision'},context:'Options\nLocal files; managed database',tasks:[{id:'scope',title:'Define the criteria',stepType:'scope',instructions:'Record the supplied constraints.',inputs:['Project goal','Options'],result:'A saved set of criteria.',acceptanceCriteria:['The constraints are explicit.'],dependsOn:[]},{id:'compare',title:'Compare each option',stepType:'analyze',instructions:'Compare evidence for each option.',inputs:['Reviewed criteria'],result:'A comparison table.',acceptanceCriteria:['Every option is compared.'],dependsOn:['scope']}]});

/** Minimal form DOM, following the repository's event-driven UI fixtures. */
function fixture(t,{projects=[],organization={revision:3,groups:[]},methods=[],ontology=defaultOntology,onApi,onDraftInChat,cachedDrafts=[]}={}){
  const previous=Object.fromEntries(['document','setTimeout','clearTimeout'].map(key=>[key,globalThis[key]])),listeners=new Map(),calls=[],toasts=[],planningDrafts=[],planningOpened=[],storageValues=new Map(),forms=new Map(),timers=new Map();
  let view=null,form=null,html='',timer=0,currentProjects=structuredClone(projects),currentOrganization=structuredClone(organization),currentMethods=structuredClone(methods),currentOntology=structuredClone(ontology),cwd='C:/fixture/project',main=null,list=null,projectControls=[],coordinationControls=[],taskCards=[],workflowNodes=[],attemptDetails=[],folderDetails=[],catalogDetails=[],methodDetails=[],otherDetails=[],map=null,mapViewport=null,mapCanvas=null,mapSize=null;
  const storage={getItem:key=>storageValues.get(key)??null,setItem:(key,value)=>storageValues.set(key,value),removeItem:key=>storageValues.delete(key),get length(){return storageValues.size;},key:index=>[...storageValues.keys()][index]};
  for(const cached of cachedDrafts)storage.setItem('projects-ui-test:'+cached.key,JSON.stringify({version:1,savedAt:cached.savedAt,data:cached.data}));
  const draftStore=createDraftStore({storage,prefix:'projects-ui-test:'});
  const controls=(source,owner='project-editor')=>[...source.matchAll(/<(input|textarea|select)\b([^>]*)(?:>([\s\S]*?)<\/\1>|\/?>)/g)].map(([,tag,attributeText,content])=>{
    const attributes=attrs(attributeText);let value=tag==='textarea'?decode(content):attributes.value??'';
    if(tag==='select'){
      const options=[...String(content).matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(([,source,text])=>({attributes:attrs(source),text:decode(text)}));
      const selected=options.find(option=>Object.hasOwn(option.attributes,'selected'))||options[0];value=selected?.attributes.value??selected?.text??'';
    }
    const node={id:attributes.id||'',name:attributes.name||'',type:attributes.type||tag,value,selectionStart:0,selectionEnd:0,setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},checked:Object.hasOwn(attributes,'checked'),disabled:Object.hasOwn(attributes,'disabled'),attributes,focus(){document.activeElement=this;},closest:selector=>selector==='#'+owner?forms.get(owner)||null:null};
    return node;
  });
  function parseEditor(source){
    forms.clear();
    const kinds={'data-task-editor':'taskEditor','data-method-step':'methodStep','data-method-input':'methodInput','data-milestone-editor':'milestoneEditor'};
    for(const owner of ['project-editor','method-editor','method-type-editor','project-metadata-editor','project-method-search','project-organization-editor']){
      const markup=[...source.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].find(([,attributeText])=>attrs(attributeText).id===owner)?.[0];if(!markup)continue;
      const groups=[...markup.matchAll(/<fieldset\b([^>]*)>([\s\S]*?)<\/fieldset>/g)].map(([,attributeText,content])=>{
        const attributes=attrs(attributeText),kind=Object.keys(kinds).find(key=>Object.hasOwn(attributes,key));if(!kind)return null;
        const fields=controls(content,owner);
        const group={kind,dataset:{[kinds[kind]]:attributes[kind]},fields,querySelector:selector=>fields.find(node=>node.name===/^\[name=([^\]]+)\]/.exec(selector)?.[1])||null,querySelectorAll:selector=>{const name=/^\[name=([^\]]+)\]:checked$/.exec(selector)?.[1];return selector==='[name]'?fields:name?fields.filter(node=>node.name===name&&node.checked):[];}};for(const field of fields){const closest=field.closest;field.closest=selector=>selector===`[${kind}]`?group:closest(selector);}return group;
      }).filter(Boolean);
      const fields=controls(markup.replace(/<fieldset\b[\s\S]*?<\/fieldset>/g,''),owner);
      const node={id:owner,fields,groups,elements:{namedItem:name=>fields.find(field=>field.name===name)||null},querySelectorAll:selector=>selector==='[name]'?[...fields,...groups.flatMap(group=>group.fields)]:groups.filter(group=>`[${group.kind}]`===selector)};forms.set(owner,node);
    }
    form=forms.get('project-editor')||null;
  }
  function parseProject(source){
    main={scrollTop:0,focus(options){this.focusOptions=options;document.activeElement=this;},closest:selector=>selector==='.project-main'?main:null};const listAttrs=attrs(/<aside\b([^>]*class="project-list"[^>]*)>/.exec(source)?.[1]||'');list=source.includes('class="project-list"')?{scrollTop:0,hidden:Object.hasOwn(listAttrs,'hidden'),inert:Object.hasOwn(listAttrs,'inert')}:null;
    const memberships=new Map([...source.matchAll(/<details\b([^>]*data-project-group="[^"]+"[^>]*)>([\s\S]*?)<\/details>/g)].flatMap(([,text,content])=>[...content.matchAll(/<button\b([^>]*data-project="select"[^>]*)>/g)].map(([,button])=>[attrs(button)['data-id'],attrs(text)['data-project-group']])));
    const navMarkup=/<nav\b[^>]*class="coordination-navigation"[^>]*>[\s\S]*?<\/nav>/.exec(source)?.[0]||'';
    coordinationControls=[...navMarkup.matchAll(/<button\b([^>]*data-action="[^"]+"[^>]*)>/g)].map(([,text])=>{const attributes=attrs(text);return{dataset:{action:attributes['data-action']},disabled:Object.hasOwn(attributes,'disabled'),focus(options){this.focusOptions=options;this.focusWasVisible=otherDetails.find(detail=>detail.dataset.detail==='coordination-area')?.open===true;if(this.focusWasVisible&&!this.disabled)document.activeElement=this;},closest(selector){return selector==='.coordination-navigation [data-action]'?this:null;}};});
    projectControls=[...source.matchAll(/<button\b([^>]*data-project="[^"]+"[^>]*)>/g)].map(([,text])=>{const attributes=attrs(text);return{dataset:{project:attributes['data-project'],id:attributes['data-id'],task:attributes['data-task']},attributes,focus(options){this.focusOptions=options;document.activeElement=this;},closest(selector){return selector==='[data-project]'?this:selector==='details:not([open])'?catalogDetails.find(detail=>!detail.open&&detail.dataset.projectGroup===memberships.get(attributes['data-id']))||null:null;}};});
    taskCards=[...source.matchAll(/<article\b([^>]*data-project-task="[^"]+"[^>]*)>([\s\S]*?)<\/article>/g)].map(([,text,content],index)=>{
      const attributes=attrs(text),node={dataset:{projectTask:attributes['data-project-task'],workflowSelected:attributes['data-workflow-selected']},attributes,content,scrolls:[],focus(options){this.focusOptions=options;document.activeElement=this;},scrollIntoView(options){this.scrolls.push(options);main.scrollTop=index*180;},closest(selector){return selector==='[data-project-task]'?this:null;}};
      node.controls=[...content.matchAll(/<button\b([^>]*data-project="[^"]+"[^>]*)>/g)].map(([,text])=>{const attributes=attrs(text);return{dataset:{project:attributes['data-project'],id:attributes['data-id'],task:attributes['data-task']},focus(options){this.focusOptions=options;document.activeElement=this;},closest(selector){return selector==='[data-project-task]'?node:selector==='[data-project]'?this:null;}};});
      node.details=[...content.matchAll(/<details\b([^>]*data-detail="[^"]+"[^>]*)>/g)].map(([,text])=>{const attributes=attrs(text),detail={dataset:{detail:attributes['data-detail'],taskState:attributes['data-task-state']},open:Object.hasOwn(attributes,'open')};detail.summary={focus(options){this.focusOptions=options;document.activeElement=this;},closest(selector){return selector==='summary'?this:selector==='details[data-detail]'?detail:selector==='[data-project-task]'?node:null;}};detail.querySelector=selector=>selector==='summary'?detail.summary:null;return detail;});
      node.querySelectorAll=selector=>selector==='[data-project]'?node.controls:selector==='details[data-detail]'?node.details:[];return node;
    });
    workflowNodes=[...source.matchAll(/<button\b([^>]*data-workflow-node="[^"]+"[^>]*)>/g)].map(([,text])=>{
      const attributes=attrs(text),node={dataset:{workflowNode:attributes['data-workflow-node']},attributes,scrolls:[],scrollIntoView(options){this.scrolls.push(options);},focus(options){this.focusOptions=options;this.focusWasVisible=['project:graph','project:details'].every(id=>otherDetails.find(detail=>detail.dataset.detail===id)?.open);if(this.focusWasVisible)document.activeElement=this;},closest(selector){return selector==='details'?otherDetails.find(detail=>detail.dataset.detail==='project:graph'):selector==='[data-workflow-node]'?this:selector==='#projects-workspace'?view:selector==='.workflow-map'?map:null;}};return node;
    });
    attemptDetails=taskCards.flatMap(node=>node.details);
    folderDetails=[...source.matchAll(/<details\b([^>]*class="project-folder"[^>]*)>/g)].map(([,text])=>{const attributes=attrs(text),detail={dataset:{detail:attributes['data-detail'],taskState:attributes['data-task-state']},open:Object.hasOwn(attributes,'open')};detail.summary={focus(options){this.focusOptions=options;document.activeElement=this;},closest(selector){return selector==='summary'?this:selector==='details[data-detail]'?detail:null;}};detail.querySelector=selector=>selector==='summary'?detail.summary:null;return detail;});
    catalogDetails=[...source.matchAll(/<details\b([^>]*class="(?:project-group|project-status-filter)"[^>]*)>/g)].map(([,text])=>{const attributes=attrs(text),detail={dataset:{detail:attributes['data-detail'],projectGroup:attributes['data-project-group']},open:Object.hasOwn(attributes,'open')};detail.summary={focus(options){this.focusOptions=options;document.activeElement=this;},closest(selector){return selector==='summary'?this:selector==='details[data-detail]'?detail:null;}};detail.querySelector=selector=>selector==='summary'?detail.summary:null;return detail;});
    methodDetails=[...source.matchAll(/<details\b([^>]*data-method-detail="[^"]+"[^>]*)>/g)].map(([,text])=>{const attributes=attrs(text),hint={textContent:'Open to load'},detail={dataset:{detail:attributes['data-detail'],methodDetail:attributes['data-method-detail']},open:Object.hasOwn(attributes,'open'),closest:selector=>selector==='#projects-workspace'?view:null};detail.querySelector=selector=>selector==='[role="status"]'?hint:null;return detail;});
    const known=new Set([...attemptDetails,...folderDetails,...catalogDetails,...methodDetails].map(detail=>detail.dataset.detail));
    otherDetails=[...source.matchAll(/<details\b([^>]*data-detail="[^"]+"[^>]*)>/g)].map(([,text])=>{const attributes=attrs(text),id=attributes['data-detail'];if(known.has(id))return null;const detail={dataset:{detail:id},open:Object.hasOwn(attributes,'open')};detail.summary={focus(options){this.focusOptions=options;document.activeElement=this;},closest(selector){return selector==='summary'?this:selector==='details[data-detail]'?detail:null;}};detail.querySelector=selector=>selector==='summary'?detail.summary:null;detail.parentElement={closest:selector=>selector!=='details'?null:id==='project:graph'?otherDetails.find(node=>node.dataset.detail==='project:details'):id.startsWith('editor:')?otherDetails.find(node=>node.dataset.detail==='draft-step:'+id.slice(7)):null};return detail;}).filter(Boolean);
    for(const form of forms.values())for(const group of form.groups)for(const field of group.fields){const closest=field.closest;field.closest=selector=>selector==='details'?otherDetails.find(detail=>detail.dataset.detail===(['instructions','criteria','stepType','stepInputs','dependency'].includes(field.name)?'editor:':'draft-step:')+group.dataset.taskEditor)||null:closest(selector);}
    mapViewport=source.includes('data-workflow-scroll')?{scrollLeft:0,scrollTop:0,clientWidth:640}:null;
    const canvasAttributes=attrs(/<div\b([^>]*data-workflow-canvas[^>]*)>/.exec(source)?.[1]||'');
    mapCanvas=mapViewport?{style:{},dataset:{zoom:canvasAttributes['data-zoom'],width:canvasAttributes['data-width'],height:canvasAttributes['data-height']}}:null;
    mapSize=mapViewport?{style:{}}:null;
    map=mapViewport?{dataset:{workflowMap:decode(/data-workflow-map="([^"]+)"/.exec(source)?.[1])},scrolls:[],scrollIntoView(options){this.scrolls.push(options);},querySelector:selector=>selector==='[data-workflow-scroll]'?mapViewport:selector==='[data-workflow-canvas]'?mapCanvas:selector==='[data-workflow-size]'?mapSize:null}:null;
  }
  const document={activeElement:null,querySelector:selector=>{
    if(!view)return null;if(selector==='#projects-workspace')return view;if(selector==='#project-editor')return form;
    if(selector?.startsWith('#')&&forms.has(selector.slice(1)))return forms.get(selector.slice(1));
    if(['#project-objective','#project-method','#method-name','#method-type-name'].includes(selector))return [...forms.values()].flatMap(item=>item.fields).find(field=>field.id===selector.slice(1))||null;
    if(selector==='#modal-root .modal')return{classList:{add(){}}};
    if(selector==='#project-name')return form?.elements.namedItem('name')||null;
    if(selector==='#project-editor [data-task-editor]:last-of-type input')return form?.groups.at(-1)?.fields.find(node=>node.name==='title')||null;
    return null;
  },addEventListener(type,callback){const group=listeners.get(type)||[];group.push(callback);listeners.set(type,group);}};
  globalThis.document=document;
  // Polling is an integration/browser concern; keep it from escaping a fake modal.
  globalThis.setTimeout=callback=>{const id=++timer;timers.set(id,callback);return id;};globalThis.clearTimeout=id=>{timers.delete(id);};
  t.after(()=>{view=null;for(const[key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  const emit=async(type,target)=>{const event={target,preventDefault(){this.prevented=true;}};for(const callback of listeners.get(type)||[])await callback(event);await flush();return event;};
  const api=async(url,method,body)=>{
    calls.push({url,method,body:structuredClone(body)});const response=await onApi?.(url,method,body);if(response!==undefined)return response;
    if(url==='/api/projects'&&!method)return{projects:structuredClone(currentProjects).map(project=>({...project,groupName:currentOrganization.groups.find(group=>group.id===project.groupId)?.name||null,organizationRevision:currentOrganization.revision})),organization:structuredClone(currentOrganization),status:{healthy:true}};
    if(url==='/api/planning/organization'&&method==='POST'){
      assert.equal(body.expectedRevision,currentOrganization.revision);const createdGroupIds=[];
      for(const operation of body.operations){
        if(operation.type==='create_group'){const id=operation.id||'group-created-'+(currentOrganization.groups.length+1);currentOrganization.groups.push({id,name:operation.name,planCount:0});createdGroupIds.push(id);}
        if(operation.type==='rename_group'){const group=currentOrganization.groups.find(group=>group.id===operation.groupId);assert.ok(group);group.name=operation.name;}
        if(operation.type==='update_project'){const project=currentProjects.find(project=>project.id===operation.projectId);assert.ok(project);for(const key of ['groupId','archived'])if(Object.hasOwn(operation,key))project[key]=operation[key];}
      }
      currentOrganization.revision++;return{...structuredClone(currentOrganization),createdGroupIds,healthy:true};
    }
    if(url==='/api/capabilities'&&!method)return{capabilities:[],status:{healthy:true}};
    if(url.startsWith('/api/methods?')&&!method){const params=new URL(url,'http://fixture.local').searchParams,options={};for(const key of ['query','domain','phase','output','catalogRevision'])if(params.has(key))options[key]=params.get(key);for(const key of ['limit','offset'])if(params.has(key))options[key]=Number(params.get(key));return{...createMethodSearchIndex(currentMethods).search(options),ontology:structuredClone(currentOntology),status:{healthy:true}};}
    if(url.startsWith('/api/methods/')&&!method)return structuredClone(currentMethods.find(item=>item.id===decodeURIComponent(url.split('/').at(-1))));
    if(url.startsWith('/api/method-types')&&method){const id=method==='PUT'?url.split('/').at(-1):'custom-type',previous=[...currentOntology.taskTypes,...currentOntology.stepTypes].find(item=>item.id===id),type={...previous,...structuredClone(body),id,revision:(previous?.revision||0)+1,origin:'custom'};const key=type.kind==='step'?'stepTypes':'taskTypes';currentOntology[key]=[...currentOntology[key].filter(item=>item.id!==id),type];return type;}
    if(url.startsWith('/api/methods')&&method){const id=method==='PUT'?url.split('/').at(-1):'created-method',previous=currentMethods.find(item=>item.id===id),result={...structuredClone(body),id,revision:(previous?.revision||0)+1,origin:'custom'};currentMethods=[...currentMethods.filter(item=>item.id!==id),result];return result;}
    if(url.startsWith('/api/projects/')&&!method)return structuredClone(currentProjects.find(item=>item.id===url.split('/').at(-1)));
    if(method==='PUT'&&!body.tasks){const previous=currentProjects.find(item=>item.id===url.split('/').at(-1)),result={...previous,...structuredClone(body),revision:previous.revision+1};currentProjects=currentProjects.map(item=>item.id===result.id?result:item);return result;}
    if(method==='POST'||method==='PUT'){
      const project={...structuredClone(body),id:method==='PUT'?url.split('/').at(-1):'created-project',revision:method==='PUT'?body.expectedRevision+1:1,status:'draft',tasks:body.tasks.map(task=>({...task,status:'pending',attempts:[]}))};
      currentProjects=[...currentProjects.filter(item=>item.id!==project.id),project];return project;
    }
    throw Error(`Unexpected request ${method||'GET'} ${url}`);
  };
  const ui=initProjectsUI({api,showModal(){html='';view={contains:node=>node===main||coordinationControls.includes(node)||otherDetails.some(detail=>detail.summary===node)||[...forms.values()].some(form=>form.fields.includes(node)||form.groups.some(group=>group.fields.includes(node)))||projectControls.includes(node)||folderDetails.some(detail=>detail.summary===node)||catalogDetails.some(detail=>detail.summary===node)||taskCards.includes(node)||workflowNodes.includes(node)||taskCards.some(card=>card.controls.includes(node)||card.details.some(detail=>detail.summary===node)),querySelector:selector=>selector==='.project-main'?main:selector==='.project-list'?list:selector==='[data-workflow-map]'?map:selector==='[data-workflow-scroll]'?mapViewport:selector==='[data-workflow-canvas]'?mapCanvas:null,querySelectorAll:selector=>selector==='.coordination-navigation [data-action]'?coordinationControls:selector==='[data-project]'?projectControls:selector==='[data-workflow-map]'?(map?[map]:[]):selector==='[data-project-task]'?taskCards:selector==='[data-workflow-node]'?workflowNodes:selector==='details[data-detail]'?[...attemptDetails,...folderDetails,...catalogDetails,...methodDetails,...otherDetails]:selector==='details[open][data-detail]'?[...attemptDetails,...folderDetails,...catalogDetails,...methodDetails,...otherDetails].filter(node=>node.open):[],get innerHTML(){return html;},set innerHTML(value){html=value;parseEditor(value);parseProject(value);}};},closeModal(){view=null;},toast:(...message)=>toasts.push(message),escape,icon:()=>'',getCwd:()=>cwd,getModels:()=>[],draftStore,onOpenPlanning:value=>planningOpened.push(value),onDraftInChat:async request=>{planningDrafts.push(request);return onDraftInChat?.(request);}});
  return{ui,calls,toasts,planningDrafts,planningOpened,draftStore,forms,timers,get form(){return form;},get html(){return html;},get drafts(){return draftStore.list();},
    get main(){return main;},get list(){return list;},get projectControls(){return projectControls;},get coordinationControls(){return coordinationControls;},get taskCards(){return taskCards;},get workflowNodes(){return workflowNodes;},get attemptDetails(){return attemptDetails.filter(node=>!node.dataset.detail.startsWith('task:'));},get taskDisclosures(){return attemptDetails.filter(node=>node.dataset.detail.startsWith('task:'));},get folderDetails(){return folderDetails;},get groupDetails(){return catalogDetails.filter(detail=>detail.dataset.projectGroup);},get disclosures(){return [...attemptDetails,...folderDetails,...catalogDetails,...methodDetails,...otherDetails];},get map(){return map;},get mapViewport(){return mapViewport;},
    click(action,data={}){const button={dataset:{project:action,...data},closest(selector){return selector==='[data-project]'?this:null;}};return emit('click',button);},
    clickWorkflow(taskId){const node=workflowNodes.find(item=>item.dataset.workflowNode===taskId);assert.ok(node,`Missing workflow task ${taskId}`);return emit('click',node);},
    toggleMethod(id,open=true){const detail=methodDetails.find(item=>item.dataset.methodDetail===id);assert.ok(detail,`Missing method detail ${id}`);detail.open=open;return emit('toggle',detail);},
    input(name,value,{task}={}){const field=task?form.groups.find(group=>group.dataset.taskEditor===task).fields.find(node=>node.name===name):form.elements.namedItem(name);assert.ok(field,`Missing field ${task||'project'}:${name}`);field.value=value;return emit('input',field);},
    submit(owner='project-editor'){const target=forms.get(owner);assert.ok(target);return emit('submit',target);},
    inputForm(owner,name,value,{group,checked}={}){const target=forms.get(owner);assert.ok(target,`Missing form ${owner}`);const field=group?target.groups.find(item=>Object.values(item.dataset).includes(group))?.fields.find(item=>item.name===name):target.elements.namedItem(name);assert.ok(field,`Missing ${owner}:${group||''}:${name}`);field.value=value;if(checked!==undefined)field.checked=checked;return emit('input',field);},
    checkbox(owner,group,name,value,checked){const target=forms.get(owner),field=target.groups.find(item=>Object.values(item.dataset).includes(group))?.fields.find(item=>item.name===name&&item.value===value);assert.ok(field);field.checked=checked;return emit('change',field);},
    close(){view=null;form=null;},
    setCwd(value){cwd=value;},
    setProjects(value){currentProjects=structuredClone(value);},
    setOrganization(value){currentOrganization=structuredClone(value);},
    setMethods(value){currentMethods=structuredClone(value);},
  };
}

async function authoredDraft(f){await f.ui.open();await f.click('new');await f.input('name','A carefully authored goal');await f.input('objective','Produce and verify a useful capability.');await f.input('title','Write result',{task:'task-1'});await f.input('instructions','Create the requested result.',{task:'task-1'});await f.input('criteria','The result exists.',{task:'task-1'});}

test('saving a project never clears edits typed while its older request is in flight',async t=>{
  const pending=deferred(),f=fixture(t,{onApi:(url,method)=>url==='/api/projects'&&method==='POST'?pending.promise:undefined});
  await authoredDraft(f);await f.submit();
  const posted=f.calls.find(call=>call.method==='POST');assert.equal(posted.body.name,'A carefully authored goal');
  await f.input('name','Newer title typed during save');
  pending.resolve({...posted.body,id:'newly-saved-project',revision:1,status:'draft',tasks:posted.body.tasks.map(task=>({...task,status:'pending',attempts:[]}))});await flush();
  assert.ok(f.form,'newer edits stay open after the old save resolves');assert.equal(f.form.elements.namedItem('name').value,'Newer title typed during save');
  assert.equal(f.drafts.length,1);assert.equal(f.drafts[0].data.draft.name,'Newer title typed during save');
  assert.equal(f.calls.filter(call=>call.method).length,1,'preserving edits must not dispatch another save or run');
});

test('New project preserves an existing unsaved draft and its persistent recovery copy',async t=>{
  const f=fixture(t);await authoredDraft(f);await f.click('new');
  assert.ok(f.form);assert.equal(f.form.elements.namedItem('name').value,'A carefully authored goal');assert.equal(f.drafts[0].data.draft.name,'A carefully authored goal');
  f.close();await f.ui.open();assert.equal(f.form.elements.namedItem('name').value,'A carefully authored goal');assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('editing a saved plan preserves forward dependencies, per-task models and per-task repair budgets',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();await f.click('edit',{id:project.id});
  await f.input('name','Renamed without changing the graph');await f.submit();
  const saved=f.calls.find(call=>call.method==='PUT');assert.ok(saved);assert.equal(saved.url,'/api/projects/saved-project');assert.equal(saved.body.expectedRevision,7);
  assert.deepEqual(saved.body.tasks,project.tasks.map(({status,attempts,...task})=>task));
  assert.deepEqual(saved.body.tasks[0].dependsOn,['prerequisite']);assert.equal(saved.body.tasks[0].model,'provider::implement-a');assert.equal(saved.body.tasks[0].verifierModel,'provider::review-a');assert.equal(saved.body.tasks[0].maxRepairs,0);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/start')).length,0,'editing starts no project work');
});

test('a failed project save retains the exact editable draft across closing and reopening',async t=>{
  const f=fixture(t,{onApi:(url,method)=>{if(url==='/api/projects'&&method==='POST')throw Error('Storage unavailable.');}});await authoredDraft(f);await f.submit();
  assert.ok(f.form);assert.equal(f.form.elements.namedItem('name').value,'A carefully authored goal');assert.equal(f.drafts[0].data.draft.tasks[0].instructions,'Create the requested result.');
  f.close();await f.ui.open();assert.equal(f.form.elements.namedItem('name').value,'A carefully authored goal');assert.equal(f.drafts.length,1);
});

test('Back then New keeps separate drafts that can be resumed and saves only the submitted draft',async t=>{
  const f=fixture(t);await authoredDraft(f);const first=f.drafts[0];
  await f.click('cancel-edit');assert.match(f.html,/Resume draft/);await f.click('new');await f.input('name','Second independent plan');
  assert.equal(f.drafts.length,2);assert.notEqual(f.drafts.find(item=>item.data.draft.name==='Second independent plan').key,first.key);
  assert.equal(f.drafts.find(item=>item.key===first.key).data.draft.name,'A carefully authored goal');
  await f.click('cancel-edit');await f.click('resume-draft',{id:first.key});
  assert.equal(f.form.elements.namedItem('name').value,'A carefully authored goal');await f.submit();
  assert.equal(f.drafts.length,1);assert.equal(f.drafts[0].data.draft.name,'Second independent plan');
  assert.match(f.html,/Resume draft/);await f.click('resume-draft',{id:f.drafts[0].key});assert.equal(f.form.elements.namedItem('name').value,'Second independent plan');
});

test('an old modal save cannot clear a reopened editor or release its newer pending action',async t=>{
  const first=deferred(),second=deferred();let saves=0;
  const f=fixture(t,{onApi:(url,method)=>url==='/api/projects'&&method==='POST'?(++saves===1?first.promise:second.promise):undefined});
  await authoredDraft(f);await f.submit();const old=f.calls.find(call=>call.method==='POST');
  f.close();await f.ui.open();await f.input('name','Reopened editor with newer content');await f.submit();
  first.resolve({...old.body,id:'older-save',revision:1,status:'draft',tasks:old.body.tasks.map(task=>({...task,status:'pending',attempts:[]}))});await flush();
  assert.equal(f.form.elements.namedItem('name').value,'Reopened editor with newer content');assert.equal(f.drafts[0].data.draft.name,'Reopened editor with newer content');
  await f.click('cancel-edit');assert.ok(f.form,'an older completion must not unlock controls owned by a newer save');assert.equal(saves,2);
  second.reject(Error('Newer save failed safely.'));await flush();assert.ok(f.form);assert.equal(f.form.elements.namedItem('name').value,'Reopened editor with newer content');
});

test('draft recovery follows the current workspace while editable output folders remain part of each plan',async t=>{
  const f=fixture(t);await authoredDraft(f);await f.input('cwd','C:/deliverables/custom-location');
  f.close();f.setCwd('C:/fixture/other-project');await f.ui.open();assert.equal(f.form,null);await f.click('new');await f.input('name','Other workspace plan');
  f.close();f.setCwd('C:/fixture/project');await f.ui.open();assert.equal(f.form.elements.namedItem('name').value,'A carefully authored goal');assert.equal(f.form.elements.namedItem('cwd').value,'C:/deliverables/custom-location');
  assert.equal(f.drafts.length,2);
});

test('project form fields retain stable accessible labels after populated editor rerenders',async t=>{
  const f=fixture(t);await authoredDraft(f);await f.click('add-task');
  assert.equal(f.form.elements.namedItem('name').attributes['aria-label'],'Swarm name');
  const instructions=f.form.groups.map(group=>group.fields.find(node=>node.name==='instructions'));
  assert.equal(instructions.length,2);assert.deepEqual(instructions.map(node=>node.attributes['aria-label']),['Instructions','Instructions']);assert.equal(instructions[0].value,'Create the requested result.');
});

test('cold recovery resumes the latest workspace draft while keeping legacy and older drafts available',async t=>{
  const scope=draftKey('projects',draftWorkspace('C:/fixture/project')),draft={name:'Legacy recovered plan',objective:'Keep unfinished work.',cwd:'C:/fixture/project',model:'default',verifierModel:'default',maxRepairs:2,tasks:[{id:'task-1',title:'Task',instructions:'Complete it.',acceptanceCriteria:['The task is checked.'],dependsOn:[]}]};
  const f=fixture(t,{cachedDrafts:[
    {key:scope,savedAt:'2026-01-01T10:00:00.000Z',data:{draft,editing:null,baseRevision:null}},
    {key:scope+':latest',savedAt:'2026-01-02T10:00:00.000Z',data:{draft:{...draft,name:'Latest recovered plan'},editing:null,baseRevision:null}},
    {key:draftKey('projects',draftWorkspace('C:/fixture/project-other'))+':unrelated',savedAt:'2026-01-03T10:00:00.000Z',data:{draft:{...draft,name:'Unrelated folder plan'},editing:null,baseRevision:null}},
  ]});
  await f.ui.open();assert.equal(f.form.elements.namedItem('name').value,'Latest recovered plan');assert.match(f.html,/Resume draft/);assert.doesNotMatch(f.html,/Unrelated folder plan/);
  await f.click('resume-draft',{id:scope});assert.equal(f.form.elements.namedItem('name').value,'Legacy recovered plan');assert.equal(f.drafts.length,3);
});

test('project workflow nodes open their actual task without dispatching work',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();
  assert.match(f.html,/<svg\b/);assert.deepEqual(new Set(f.workflowNodes.map(node=>node.dataset.workflowNode)),new Set(project.tasks.map(task=>task.id)));
  assert.ok(f.html.indexOf('data-project-task=')<f.html.indexOf('data-workflow-node='),'the task outline is primary; the dependency graph remains available below it');
  await f.clickWorkflow('prerequisite');
  const card=f.taskCards.find(node=>node.dataset.projectTask==='prerequisite');assert.equal(document.activeElement,card);assert.equal(card.dataset.workflowSelected,'true');assert.equal(card.attributes.tabindex,'-1');
  assert.equal(f.workflowNodes.find(node=>node.dataset.workflowNode==='prerequisite').attributes['aria-pressed'],'true');
  assert.deepEqual(card.scrolls,[{block:'nearest',inline:'nearest',behavior:'auto'}]);
  assert.equal(f.calls.filter(call=>call.method).length,0,'inspecting a graph node must not start, edit, retry or pause work');
});

test('project polling preserves selected task, focused evidence, expanded attempts and both scroll positions',async t=>{
  const project=savedProject();project.tasks[1].attempts=[{number:1,implementation:{status:'completed',runId:'implementation-run'},verification:{status:'completed',runId:'review-run',verdict:{criteria:[],summary:'Evidence reviewed.'}}}];
  const f=fixture(t,{projects:[project]});await f.ui.open();await f.clickWorkflow('prerequisite');
  const oldCard=document.activeElement;f.main.scrollTop=320;f.attemptDetails[0].open=true;f.mapViewport.scrollLeft=84;f.mapViewport.scrollTop=21;
  const updated=structuredClone(project);updated.revision++;updated.status='running';updated.tasks[1].status='running';f.setProjects([updated]);await f.ui.refresh();
  const card=f.taskCards.find(node=>node.dataset.projectTask==='prerequisite');assert.notEqual(card,oldCard);assert.equal(document.activeElement,card);assert.equal(card.dataset.workflowSelected,'true');assert.deepEqual(card.focusOptions,{preventScroll:true});
  assert.equal(f.main.scrollTop,320);assert.equal(f.attemptDetails[0].open,true);assert.equal(f.mapViewport.scrollLeft,84);assert.equal(f.mapViewport.scrollTop,21);
  assert.equal(card.scrolls.length,0,'background updates must not jump the viewport');
});

test('a focused workflow node keeps keyboard focus when status polling redraws the project',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();for(const id of ['project:details','project:graph'])f.disclosures.find(detail=>detail.dataset.detail===id).open=true;f.workflowNodes.find(node=>node.dataset.workflowNode==='later-output').focus();
  const updated=structuredClone(project);updated.revision++;updated.tasks[0].status='blocked';f.setProjects([updated]);await f.ui.refresh();
  assert.equal(document.activeElement,f.workflowNodes.find(node=>node.dataset.workflowNode==='later-output'));assert.deepEqual(document.activeElement.focusOptions,{preventScroll:true});
});

test('polling retains keyboard focus inside task evidence controls and expandable attempt summaries',async t=>{
  const project=savedProject();project.tasks[1].attempts=[{number:1,implementation:{status:'running',runId:'implementation-run'}}];
  const f=fixture(t,{projects:[project]});await f.ui.open();const card=()=>f.taskCards.find(node=>node.dataset.projectTask==='prerequisite');
  card().controls.find(node=>node.dataset.project==='open-run').focus();project.revision++;f.setProjects([project]);await f.ui.refresh();
  assert.equal(document.activeElement,card().controls.find(node=>node.dataset.project==='open-run'));assert.deepEqual(document.activeElement.focusOptions,{preventScroll:true});
  card().details.find(detail=>detail.dataset.detail==='prerequisite').summary.focus();project.revision++;f.setProjects([project]);await f.ui.refresh();
  assert.equal(document.activeElement,card().details.find(detail=>detail.dataset.detail==='prerequisite').summary);assert.deepEqual(document.activeElement.focusOptions,{preventScroll:true});
});

test('switching projects clears task selection and scroll even when the projects reuse task IDs',async t=>{
  const project=savedProject(),other={...structuredClone(project),id:'another-project',name:'Another project'},f=fixture(t,{projects:[project,other]});await f.ui.open();await f.clickWorkflow('prerequisite');f.main.scrollTop=400;
  await f.click('select',{id:other.id});assert.equal(f.main.scrollTop,0);assert.ok(f.taskCards.every(node=>node.dataset.workflowSelected==='false'));
  assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('workflow task navigation preserves native IDs containing selector punctuation',async t=>{
  const project=savedProject(),taskId='prerequisite"[data-id="other"]<task>';project.tasks[1].id=taskId;project.tasks[0].dependsOn=[taskId];
  const f=fixture(t,{projects:[project]});await f.ui.open();await f.clickWorkflow(taskId);
  assert.equal(document.activeElement?.dataset.projectTask,taskId);assert.equal(document.activeElement?.dataset.workflowSelected,'true');assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('project groups list plans by name and filter actual projects without dispatching work',async t=>{
  const draft=savedProject(),reviewed={...structuredClone(draft),id:'reviewed',name:'Reviewed plan',status:'completed',tasks:draft.tasks.map(task=>({...task,status:'completed'}))},blocked={...structuredClone(draft),id:'blocked',name:'Blocked plan',status:'needs_attention'};blocked.tasks[1].status='blocked';blocked.tasks[1].error='No artifact was supplied.';
  const f=fixture(t,{projects:[reviewed,draft,blocked]});await f.ui.open();await f.click('browse');
  const listed=()=>f.projectControls.filter(node=>node.dataset.project==='select').map(node=>node.dataset.id);
  assert.deepEqual(listed(),['blocked','reviewed','saved-project']);assert.match(f.html,/<h4>Build prerequisite<\/h4>/);assert.match(f.html,/No artifact was supplied\./);
  await f.click('filter',{id:'reviewed'});assert.deepEqual(listed(),['reviewed']);assert.match(f.html,/<span>2 \/ 2 tasks reviewed<\/span>/);assert.equal(document.activeElement?.dataset.id,'reviewed');assert.equal(document.activeElement?.dataset.project,'filter');
  await f.click('filter',{id:'working'});assert.deepEqual(listed(),[]);assert.match(f.html,/No active plans in this view/);
  await f.click('filter',{id:'all'});assert.deepEqual(listed(),['blocked','reviewed','saved-project']);assert.match(f.html,/<h4>Build prerequisite<\/h4>/);
  assert.equal(f.calls.filter(call=>call.method).length,0,'status filters and attention inspection start no execution');
});

test('next-step inspection opens the actual eligible task even with forward dependencies',async t=>{
  const f=fixture(t,{projects:[savedProject()]});await f.ui.open();
  const control=f.projectControls.find(node=>node.dataset.project==='focus-task');assert.equal(control.dataset.task,'prerequisite');assert.ok(f.html.indexOf('aria-label="Next step"')<f.html.indexOf('data-workflow-map='));
  await f.click('focus-task',{task:control.dataset.task});assert.equal(document.activeElement?.dataset.projectTask,'prerequisite');assert.equal(document.activeElement?.dataset.workflowSelected,'true');assert.equal(f.calls.filter(call=>call.method).length,0);
  assert.match(f.html,/Back to workflow/);f.mapViewport.scrollLeft=44;f.mapViewport.scrollTop=15;const oldMap=f.map;assert.equal(f.disclosures.find(detail=>detail.dataset.detail==='project:details').open,false);assert.equal(f.disclosures.find(detail=>detail.dataset.detail==='project:graph').open,false);
  await f.click('back-to-map',{task:'prerequisite'});const node=f.workflowNodes.find(item=>item.dataset.workflowNode==='prerequisite');assert.equal(document.activeElement,node);assert.equal(node.focusWasVisible,true,'the map node must be visible through every details ancestor before receiving focus');assert.equal(f.disclosures.find(detail=>detail.dataset.detail==='project:details').open,true);assert.equal(f.disclosures.find(detail=>detail.dataset.detail==='project:graph').open,true);assert.deepEqual(node.focusOptions,{preventScroll:true});assert.deepEqual(node.scrolls,[],'returning to the map must not scroll its heading out of view');assert.deepEqual(f.map.scrolls,[{block:'start',inline:'nearest',behavior:'auto'}]);assert.equal(f.map,oldMap,'returning must preserve the existing map and its zoom');assert.equal(f.mapViewport.scrollLeft,44);assert.equal(f.mapViewport.scrollTop,15);assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('polling preserves portfolio keyboard focus, selected project, and sidebar position',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();await f.click('browse');await f.click('filter',{id:'ready'});f.list.scrollTop=92;f.main.scrollTop=58;
  project.revision++;project.name='Updated plan name';f.setProjects([project]);await f.ui.refresh();
  assert.equal(document.activeElement?.dataset.project,'filter');assert.equal(document.activeElement?.dataset.id,'ready');assert.deepEqual(document.activeElement.focusOptions,{preventScroll:true});assert.equal(f.list.scrollTop,92);assert.equal(f.main.scrollTop,58);
  const next=f.projectControls.find(node=>node.dataset.project==='focus-task');next.focus();project.revision++;f.setProjects([project]);await f.ui.refresh();assert.equal(document.activeElement?.dataset.project,'focus-task');assert.equal(document.activeElement?.dataset.task,'prerequisite');
});

test('blocked-task next step escapes saved evidence and inspection cannot retry implicitly',async t=>{
  const project=savedProject();project.status='needs_attention';project.tasks[1].status='blocked';project.tasks[1].error='<script>unsafe evidence</script>';
  const f=fixture(t,{projects:[project]});await f.ui.open();assert.match(f.html,/&lt;script&gt;unsafe evidence&lt;\/script&gt;/);assert.doesNotMatch(f.html,/<script>unsafe/);
  await f.click('focus-task',{task:'prerequisite'});assert.equal(document.activeElement?.dataset.projectTask,'prerequisite');assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('external-action retry holds replace fresh retry with inspection of the original run',async t=>{
  const project=savedProject();project.status='needs_attention';project.tasks[1].status='blocked';project.tasks[1].retryHold={runId:'original-external-run'};project.tasks[1].error='Inspect the original result before continuing.';
  const f=fixture(t,{projects:[project]});await f.ui.open();
  const card=f.taskCards.find(node=>node.dataset.projectTask==='prerequisite');
  assert.match(card.content,/Inspect original run/);assert.doesNotMatch(card.content,/data-project="retry-task"/);
  assert.ok(card.controls.some(control=>control.dataset.project==='open-run'&&control.dataset.id==='original-external-run'));
  assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('Review original result stages a separate review and only Resume to review requests execution',async t=>{
  const project=heldProject(),prepared=structuredClone(project),task=prepared.tasks[1];prepared.status='paused';prepared.revision++;task.status='verifying';task.error=null;task.attempts.push({number:2,mode:'review_only',sourceAttempt:1,implementation:structuredClone(task.attempts[0].implementation),verification:{status:'prepared',runId:null,requestId:'fresh-review-request'}});
  const f=fixture(t,{projects:[project],onApi:(url,method)=>{
    if(method==='POST'&&url.endsWith('/review-task')){f.setProjects([prepared]);return structuredClone(prepared);}
    if(method==='POST'&&url.endsWith('/start')){const working=structuredClone(prepared);working.status='running';working.revision++;working.tasks[1].attempts[1].verification.status='running';working.tasks[1].attempts[1].verification.runId='fresh-review';f.setProjects([working]);return working;}
  }});await f.ui.open();let card=f.taskCards.find(node=>node.dataset.projectTask==='prerequisite');assert.match(card.content,/Review original result/);assert.match(card.content,/Inspect original run/);assert.doesNotMatch(card.content,/data-project="retry-task"/);
  await f.click('review-task',{id:project.id,task:'prerequisite'});assert.deepEqual(f.calls.filter(call=>call.method).map(call=>({url:call.url,body:call.body})),[{url:`/api/projects/${project.id}/review-task`,body:{taskId:'prerequisite'}}]);card=f.taskCards.find(node=>node.dataset.projectTask==='prerequisite');
  assert.match(card.content,/<span class="project-status">Review prepared<\/span>/);assert.match(f.html,/>Resume to review<\/button>/);assert.equal(document.activeElement?.dataset.project,'start','keyboard focus follows the newly prepared review to its explicit Resume control');assert.match(card.content,/1 implementation attempt · 1 review-only attempt/);assert.doesNotMatch(card.content,/2 implementation attempts/);assert.match(card.content,/Original implementation<\/strong><span class="project-status">completed/);assert.match(card.content,/Reuses the original implementation/);assert.match(card.content,/Review-only attempt 2 · original attempt 1/);assert.doesNotMatch(card.content,/data-project="review-task"/);
  await f.click('focus-task',{task:'prerequisite'});assert.equal(f.calls.filter(call=>call.method).length,1,'inspecting the prepared review starts no work');
  await f.click('start',{id:project.id});assert.deepEqual(f.calls.filter(call=>call.method).map(call=>call.url),[`/api/projects/${project.id}/review-task`,`/api/projects/${project.id}/start`]);assert.match(f.taskCards.find(node=>node.dataset.projectTask==='prerequisite').content,/<span class="project-status">Reviewing<\/span>/);
});

test('review-only recovery stays available after an explicitly unstarted repair but never after a later failed implementation',async t=>{
  const project=heldProject();project.tasks[1].attempts.push({number:2,implementation:{status:'interrupted',runId:null,notAdmitted:true}});const f=fixture(t,{projects:[project]});await f.ui.open();let card=f.taskCards.find(node=>node.dataset.projectTask==='prerequisite');assert.match(card.content,/Review original result/);assert.match(card.content,/1 implementation attempt · 1 unstarted repair/);assert.match(card.content,/Attempt 2 · not started/);
  project.revision++;project.tasks[1].attempts[1].implementation={status:'failed',runId:'later-failed-implementation',requestId:'later-request'};f.setProjects([project]);await f.ui.refresh();card=f.taskCards.find(node=>node.dataset.projectTask==='prerequisite');assert.doesNotMatch(card.content,/data-project="review-task"/);assert.match(card.content,/Inspect original run/);assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('a rejected review preparation preserves original evidence and offers no implicit retry or execution',async t=>{
  const project=heldProject(),f=fixture(t,{projects:[project],onApi:(url,method)=>{if(method==='POST'&&url.endsWith('/review-task'))throw Error('The original review is still stopping.');}});await f.ui.open();const card=()=>f.taskCards.find(node=>node.dataset.projectTask==='prerequisite');card().controls.find(node=>node.dataset.project==='review-task').focus();card().details[0].open=true;f.main.scrollTop=140;
  await f.click('review-task',{id:project.id,task:'prerequisite'});assert.match(f.html,/The original review is still stopping/);assert.equal(document.activeElement?.dataset.project,'review-task');assert.equal(card().details[0].open,true);assert.equal(f.main.scrollTop,140);assert.match(card().content,/Inspect original run/);assert.match(card().content,/Review original result/);assert.equal(f.calls.filter(call=>call.method).length,1);assert.equal(f.calls.some(call=>call.url.endsWith('/start')||call.url.endsWith('/retry-task')),false);
});

test('a newly saved plan remains visible after creating it from an empty status filter',async t=>{
  const f=fixture(t);await f.ui.open();await f.click('filter',{id:'working'});await f.click('new');await f.input('name','A new plan from a filtered view');await f.input('objective','Preserve visible selection.');await f.input('title','Task',{task:'task-1'});await f.input('instructions','Produce the result.',{task:'task-1'});await f.input('criteria','The result exists.',{task:'task-1'});await f.submit();
  assert.equal(f.form,null);const selected=f.projectControls.find(node=>node.dataset.project==='select'&&node.attributes['aria-current']==='true');assert.equal(selected?.dataset.id,'created-project');assert.equal(f.projectControls.find(node=>node.dataset.project==='filter'&&node.attributes['aria-pressed']==='true')?.dataset.id,'all');assert.equal(f.calls.filter(call=>call.method).length,1);
});

test('task evidence badges agree with diagram readiness and wait for completed review',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();const card=id=>f.taskCards.find(node=>node.dataset.projectTask===id);
  assert.match(card('prerequisite').content,/<span class="project-status">Ready<\/span>/);assert.match(card('later-output').content,/<span class="project-status">Waiting for prerequisites<\/span>/);
  project.tasks[1].status='verifying';project.revision++;f.setProjects([project]);await f.ui.refresh();assert.match(card('prerequisite').content,/<span class="project-status">Reviewing<\/span>/);assert.match(card('later-output').content,/<span class="project-status">Waiting for prerequisites<\/span>/);
  project.tasks[1].status='completed';project.revision++;f.setProjects([project]);await f.ui.refresh();assert.match(card('later-output').content,/<span class="project-status">Ready<\/span>/);assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('expanded working-folder detail and its keyboard focus survive project updates',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();assert.equal(f.folderDetails.length,1);assert.equal(f.folderDetails[0].open,false);f.folderDetails[0].open=true;f.folderDetails[0].summary.focus();
  project.revision++;project.status='running';f.setProjects([project]);await f.ui.refresh();assert.equal(f.folderDetails[0].open,true);assert.equal(document.activeElement,f.folderDetails[0].summary);assert.deepEqual(document.activeElement.focusOptions,{preventScroll:true});assert.equal(f.calls.filter(call=>call.method).length,0);
});


test('an empty project library offers a clear starting point without empty filters or sidebar',async t=>{
  const f=fixture(t);await f.ui.open();assert.match(f.html,/Create swarm/);assert.match(f.html,/Advanced saved plan/);assert.doesNotMatch(f.html,/class="project-portfolio"/);assert.doesNotMatch(f.html,/class="project-list"/);assert.match(f.html,/class="project-layout single"/);assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('task summaries start compact and map or Next inspection expands only the requested task',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();assert.equal(f.taskDisclosures.length,2);assert.ok(f.taskDisclosures.every(detail=>!detail.open));assert.match(f.html,/project-check-count">1 check/);
  await f.clickWorkflow('later-output');assert.equal(f.taskDisclosures.find(detail=>detail.dataset.detail==='task:later-output').open,true);assert.equal(f.taskDisclosures.find(detail=>detail.dataset.detail==='task:prerequisite').open,false);
  await f.click('focus-task',{task:'prerequisite'});assert.equal(f.taskDisclosures.find(detail=>detail.dataset.detail==='task:prerequisite').open,true);assert.equal(document.activeElement.dataset.projectTask,'prerequisite');assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('manual task disclosure survives polling and a new blocker stays visible without opening evidence',async t=>{
  const project=savedProject();project.tasks[1].status='running';const f=fixture(t,{projects:[project]});await f.ui.open();const detail=id=>f.taskDisclosures.find(node=>node.dataset.detail==='task:'+id);
  assert.equal(detail('prerequisite').open,false,'active task evidence stays closed until requested');assert.equal(detail('later-output').open,false);
  detail('prerequisite').open=false;detail('later-output').open=true;detail('later-output').summary.focus();f.main.scrollTop=240;
  project.revision++;project.objective+=' Updated context.';f.setProjects([project]);await f.ui.refresh();assert.equal(detail('prerequisite').open,false);assert.equal(detail('later-output').open,true);assert.equal(document.activeElement,detail('later-output').summary);assert.equal(f.main.scrollTop,240);
  project.revision++;project.tasks[1].status='blocked';project.tasks[1].error='Inspect the saved result before retrying.';f.setProjects([project]);await f.ui.refresh();assert.equal(detail('prerequisite').open,false,'new blockers preserve the chosen disclosure state');assert.match(f.html,/<section class="project-next-action"[\s\S]*?Inspect the saved result before retrying\.[\s\S]*?<\/section>/);assert.equal(detail('later-output').open,true);assert.equal(f.main.scrollTop,240);assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('task summary counts use reviewed criteria and preserve the original evidence details',async t=>{
  const project=savedProject(),task=project.tasks[1];task.status='blocked';task.acceptanceCriteria=['First check','Second check'];task.attempts=[{number:1,implementation:{status:'completed',runId:'implementation-1'},verification:{status:'completed',runId:'review-1',verdict:{summary:'One check needs work.',criteria:[{criterion:'First check',passed:true,evidence:'The expected file exists.'},{criterion:'Second check',passed:false,evidence:'The test still fails.'}]}}}];
  const f=fixture(t,{projects:[project]});await f.ui.open();const card=f.taskCards.find(card=>card.dataset.projectTask===task.id);assert.match(card.content,/1\/2 checks passed/);assert.match(card.content,/The test still fails/);assert.ok(card.controls.some(control=>control.dataset.project==='open-run'&&control.dataset.id==='implementation-1'));assert.ok(card.controls.some(control=>control.dataset.project==='open-run'&&control.dataset.id==='review-1'));
});











test('an existing custom graph keeps its dependency edges when reordered, while explicit sequencing updates them',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open({projectId:project.id});await f.click('edit');await f.click('task-down',{task:'later-output'});
  assert.deepEqual(f.form.groups.filter(group=>group.kind==='data-task-editor').map(group=>group.dataset.taskEditor),['prerequisite','later-output']);await f.click('sequence-tasks');await f.submit();const saved=f.calls.find(call=>call.method==='PUT');assert.deepEqual(saved.body.tasks.map(task=>[task.id,task.dependsOn]),[['prerequisite',[]],['later-output',['prerequisite']]]);assert.equal(saved.body.tasks[1].model,'provider::implement-a');assert.equal(saved.body.tasks[0].maxRepairs,3);assert.equal(f.calls.filter(call=>call.url.endsWith('/start')).length,0);
});

test('the agent planning action prepares a normal editable Chat request and preserves the current project draft',async t=>{
  const f=fixture(t);await authoredDraft(f);await f.click('plan-in-chat');assert.equal(f.planningDrafts.length,1);assert.equal(f.planningDrafts[0].goal,'Produce and verify a useful capability.');assert.match(f.planningDrafts[0].prompt,/Prepare drafts only/);assert.match(f.planningDrafts[0].prompt,/Create the requested result/);assert.match(f.planningDrafts[0].prompt,/Do not start a project/);assert.equal(f.calls.filter(call=>call.method).length,0);assert.equal(f.form.elements.namedItem('name').value,'A carefully authored goal');
});







test('project tracking updates a running project with metadata only and preserves actual execution evidence',async t=>{
  const project=heldProject();project.status='running';project.tasks[1].status='verifying';project.priority='normal';project.owner='';project.milestones=[{id:'reviewed-result',title:'Reviewed result',taskIds:['prerequisite'],dueDate:'',done:false}];
  const before=structuredClone(project.tasks),f=fixture(t,{projects:[project]});await f.ui.open({projectId:project.id});await f.click('edit-metadata',{id:project.id});assert.ok(f.forms.get('project-metadata-editor'));assert.match(f.html,/Completion comes from the linked steps passing review/);assert.doesNotMatch(f.html,/name="milestoneDone"/);await f.inputForm('project-metadata-editor','owner','Morgan');await f.inputForm('project-metadata-editor','priority','high');await f.inputForm('project-metadata-editor','notes','Confirm the final review evidence.');await f.submit('project-metadata-editor');
  const updated=f.calls.find(call=>call.url==='/api/projects/saved-project'&&call.method==='PUT');assert.equal(updated.body.expectedRevision,7);assert.equal(updated.body.owner,'Morgan');assert.equal(updated.body.priority,'high');assert.ok(!Object.hasOwn(updated.body,'tasks'));assert.ok(!Object.hasOwn(updated.body,'objective'));assert.ok(!Object.hasOwn(updated.body,'status'));assert.deepEqual(project.tasks,before);assert.match(f.html,/original-implementation/);assert.equal(f.calls.filter(call=>/\/(start|retry-task|review-task)$/.test(call.url)).length,0);
});

test('a manual milestone is explicitly separate from agent-reviewed task completion',async t=>{
  const f=fixture(t,{projects:[savedProject()]});await f.ui.open({projectId:'saved-project'});await f.click('edit-metadata',{id:'saved-project'});await f.click('add-milestone');await f.inputForm('project-metadata-editor','milestoneTitle','Stakeholder decision',{group:'milestone-1'});await f.inputForm('project-metadata-editor','milestoneDone','',{group:'milestone-1',checked:true});assert.match(f.html,/This checkbox does not complete or review any project step/);await f.submit('project-metadata-editor');
  const saved=f.calls.find(call=>call.method==='PUT');assert.deepEqual(saved.body.milestones[0].taskIds,[]);assert.equal(saved.body.milestones[0].done,true);assert.match(f.html,/Manual checkpoint completed/);assert.match(f.html,/0 \/ 2 tasks reviewed/);assert.ok(!Object.hasOwn(saved.body,'tasks'));
});

test('a metadata revision conflict preserves the draft until an explicit reload accepts newer saved details',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project],onApi:(url,method)=>{if(url==='/api/projects/saved-project'&&method==='PUT')throw Object.assign(Error('This project changed. Reload its latest revision before saving.'),{status:409});}});await f.ui.open({projectId:project.id});await f.click('edit-metadata',{id:project.id});await f.inputForm('project-metadata-editor','owner','My unsaved owner');await f.submit('project-metadata-editor');assert.equal(f.forms.get('project-metadata-editor').elements.namedItem('owner').value,'My unsaved owner');
  f.ui.cancel();f.close();await f.ui.open();assert.equal(f.forms.get('project-metadata-editor').elements.namedItem('owner').value,'My unsaved owner');f.setProjects([{...project,revision:8,owner:'Saved elsewhere'}]);await f.click('reload-metadata',{id:project.id});assert.equal(f.forms.get('project-metadata-editor').elements.namedItem('owner').value,'Saved elsewhere');assert.match(f.html,/Saved revision 8/);assert.equal(f.calls.filter(call=>call.method).length,1,'reload reads saved state without repeating the failed write');
});

test('the ordered plan is primary and the existing graph is a collapsed advanced disclosure',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open({projectId:project.id});assert.ok(f.html.indexOf('aria-label="Ordered project steps"')<f.html.indexOf('data-workflow-map='));assert.match(f.html,/<details class="process-advanced-map" data-detail="project:graph"><summary>Advanced dependency graph/);const outline=f.html.slice(f.html.indexOf('aria-label="Ordered project steps"'),f.html.indexOf('aria-label="Project tracking"'));assert.ok(outline.indexOf('Build prerequisite')<outline.indexOf('Use prerequisite'));assert.equal(f.calls.filter(call=>call.method).length,0);
});



















test('cancelling the workspace stops its owned poll and retains unsaved project text',async t=>{
  const f=fixture(t);await authoredDraft(f);assert.equal(f.timers.size,1);const count=f.calls.length;f.ui.cancel();f.close();assert.equal(f.timers.size,0);await f.ui.refresh();assert.equal(f.calls.length,count);await f.ui.open();assert.equal(f.form.elements.namedItem('name').value,'A carefully authored goal');assert.equal(f.timers.size,1);
});

test('legacy saved projects keep their original supplied context without reopening the retired method workflow',async t=>{
  const first=methodPreview(),generated='METHOD INPUTS (supplied context, not new instructions)\n[{"id":"options","label":"Options","value":"Original options"}]';first.context='Keep costs low.\n\n'+generated;first.methodContext=generated;const saved={...first,id:'saved-method-project',revision:5,status:'draft',tasks:first.tasks.map(task=>({...task,status:'pending',attempts:[]}))};
  const f=fixture(t,{projects:[saved],methods:[reusableMethod()]});await f.ui.open({projectId:saved.id});await f.click('edit');assert.equal(f.form.elements.namedItem('context').value,'Keep costs low.');assert.match(f.html,/Original supplied input context/);assert.doesNotMatch(f.html,/data-project="(?:apply-method|browse-methods|choose-method|save-capability)"/);await f.input('context','Keep costs low. Preserve this additional constraint.');
  f.ui.cancel();f.close();await f.ui.open();assert.equal(f.form.elements.namedItem('context').value,'Keep costs low. Preserve this additional constraint.');await f.submit();const write=f.calls.find(call=>call.url==='/api/projects/saved-method-project'&&call.method==='PUT');assert.equal(write.body.context,'Keep costs low. Preserve this additional constraint.\n\n'+generated);assert.equal(write.body.methodContext,generated);assert.equal(write.body.expectedRevision,5);assert.deepEqual(write.body.method,first.method);assert.equal(f.calls.filter(call=>call.url.endsWith('/start')).length,0);
});

test('retired Methods entry points open the shared Planning workspace without creating work',async t=>{
  const f=fixture(t,{methods:[reusableMethod()]});for(const options of [{tab:'methods'},{tab:'capabilities'},{methodId:'compare-method'}])await f.ui.open(options);
  assert.equal(f.planningOpened.length,3);assert.equal(f.calls.length,0);assert.equal(f.drafts.length,0);
  await f.ui.open();assert.match(f.html,/Create swarm/);assert.match(f.html,/Advanced saved plan/);assert.doesNotMatch(f.html,/data-project="(?:browse-methods|choose-method|edit-method|new-method)"/);await f.click('planning');assert.equal(f.planningOpened.length,4);assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('Swarms opens active plans by default and keeps Archive explicit across saved updates',async t=>{
  const active=savedProject(),archived={...heldProject(),id:'archived-plan',name:'Archived evidence',archived:true},f=fixture(t,{projects:[archived,active]});
  const listed=()=>f.projectControls.filter(node=>node.dataset.project==='select').map(node=>node.dataset.id);
  await f.ui.open();assert.deepEqual(listed(),[active.id]);assert.equal(f.projectControls.find(node=>node.dataset.project==='history'&&node.dataset.id==='active').attributes['aria-pressed'],'true');
  await f.click('history',{id:'archived'});assert.deepEqual(listed(),[archived.id]);assert.match(f.html,/This plan is archived/);assert.match(f.html,/The original evidence was incomplete/);
  assert.ok(!f.projectControls.some(node=>['start','pause','edit','retry-task','review-task'].includes(node.dataset.project)),'archived evidence offers no work admission or graph edit controls');
  assert.ok(f.projectControls.some(node=>node.dataset.project==='open-run'&&node.dataset.id==='original-implementation'));
  archived.revision++;f.setProjects([active,archived]);await f.ui.refresh();assert.deepEqual(listed(),[archived.id]);assert.equal(f.projectControls.find(node=>node.dataset.project==='history'&&node.dataset.id==='archived').attributes['aria-pressed'],'true');
  f.close();await f.ui.open();assert.deepEqual(listed(),[archived.id],'reopening the current workspace preserves an explicitly chosen Archive view');
  await f.ui.open({projectId:active.id});assert.deepEqual(listed(),[active.id],'an exact saved-plan link reveals its actual history view');assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('creating, renaming and moving a named group uses shared organization revisions only',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();
  await f.click('new-group');await f.inputForm('project-organization-editor','name','Research & evidence');await f.submit('project-organization-editor');
  const groupId=f.calls.find(call=>call.method==='POST').body.operations[0].id;assert.match(groupId,/^group_[A-Za-z0-9_-]+$/);
  assert.ok(f.groupDetails.some(group=>group.dataset.projectGroup===groupId));assert.match(f.html,/Research &amp; evidence/);
  await f.click('move-plan',{id:project.id});await f.inputForm('project-organization-editor','groupId',groupId);await f.submit('project-organization-editor');
  assert.match(f.html,/Research &amp; evidence \/ PLAN/);
  await f.click('rename-group',{id:groupId});await f.inputForm('project-organization-editor','name','Evidence review');await f.submit('project-organization-editor');
  assert.match(f.html,/Evidence review \/ PLAN/);assert.ok(!f.forms.has('project-organization-editor'));
  const writes=f.calls.filter(call=>call.method);assert.deepEqual(writes.map(call=>({url:call.url,method:call.method,body:call.body})),[
    {url:'/api/planning/organization',method:'POST',body:{expectedRevision:3,operations:[{type:'create_group',id:groupId,name:'Research & evidence'}]}},
    {url:'/api/planning/organization',method:'POST',body:{expectedRevision:4,operations:[{type:'update_project',projectId:project.id,groupId}]}},
    {url:'/api/planning/organization',method:'POST',body:{expectedRevision:5,operations:[{type:'rename_group',groupId,name:'Evidence review'}]}},
  ]);
  await f.click('rename-plan',{id:project.id});await f.inputForm('project-organization-editor','name','Evidence plan');await f.submit('project-organization-editor');
  assert.deepEqual(f.calls.find(call=>call.method==='PUT').body,{expectedRevision:7,name:'Evidence plan'},'organization edits must not change the project execution revision');
});

test('renaming a running plan is metadata only and retains its worker evidence',async t=>{
  const project=heldProject();project.status='running';project.tasks[1].status='running';const original=structuredClone(project.tasks),f=fixture(t,{projects:[project]});await f.ui.open();
  assert.ok(!f.projectControls.some(node=>node.dataset.project==='edit'));
  await f.click('rename-plan',{id:project.id});await f.inputForm('project-organization-editor','name','Current evidence review');await f.submit('project-organization-editor');
  const writes=f.calls.filter(call=>call.method);assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/projects/'+project.id);assert.equal(writes[0].method,'PUT');assert.deepEqual(writes[0].body,{expectedRevision:7,name:'Current evidence review'});
  assert.match(f.html,/Current evidence review/);assert.ok(f.projectControls.some(node=>node.dataset.project==='open-run'&&node.dataset.id==='original-implementation'));assert.deepEqual(project.tasks,original);
});

test('organization conflicts preserve local text until an explicit revision refresh',async t=>{
  const project=savedProject();let rejected=false;const f=fixture(t,{projects:[project],onApi:(url,method)=>{if(url==='/api/projects/'+project.id&&method==='PUT'&&!rejected){rejected=true;throw Error('The saved project changed. Refresh its revision.');}}});await f.ui.open();
  await f.click('rename-plan',{id:project.id});await f.inputForm('project-organization-editor','name','My exact unsaved name');await f.submit('project-organization-editor');
  assert.equal(f.forms.get('project-organization-editor').elements.namedItem('name').value,'My exact unsaved name');assert.match(f.html,/The saved project changed/);
  f.setProjects([{...project,revision:8,name:'Someone else saved this name'}]);await f.click('reload-organization');
  assert.equal(f.forms.get('project-organization-editor').elements.namedItem('name').value,'My exact unsaved name');await f.submit('project-organization-editor');
  const writes=f.calls.filter(call=>call.method==='PUT');assert.deepEqual(writes.map(call=>call.body),[{expectedRevision:7,name:'My exact unsaved name'},{expectedRevision:8,name:'My exact unsaved name'}]);assert.match(f.html,/My exact unsaved name/);
});

test('group disclosure and keyboard focus survive live updates and plan selection',async t=>{
  const first={...savedProject(),groupId:'work'},second={...savedProject(),id:'second-plan',name:'Second plan',groupId:'work'},f=fixture(t,{projects:[first,second],organization:{revision:3,groups:[{id:'work',name:'Work'}]}});await f.ui.open();
  const group=()=>f.groupDetails.find(node=>node.dataset.projectGroup==='work');group().open=false;group().summary.focus();first.revision++;f.setProjects([first,second]);await f.ui.refresh();
  assert.equal(group().open,false);assert.equal(document.activeElement,group().summary);assert.deepEqual(document.activeElement.focusOptions,{preventScroll:true});
  await f.click('select',{id:second.id});assert.equal(group().open,false,'changing the inspected plan does not expand unrelated collapsed groups');assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('Archive and Restore move only saved organization metadata and leave work untouched',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();await f.click('archive-plan',{id:project.id});
  assert.match(f.html,/No active plans in this view/);await f.click('history',{id:'archived'});assert.match(f.html,/This plan is archived/);await f.click('restore-plan',{id:project.id});
  assert.equal(f.projectControls.find(node=>node.dataset.project==='history'&&node.dataset.id==='active').attributes['aria-pressed'],'true');assert.ok(f.projectControls.some(node=>node.dataset.project==='select'&&node.dataset.id===project.id));
  assert.deepEqual(f.calls.filter(call=>call.method).map(call=>call.body),[
    {expectedRevision:3,operations:[{type:'update_project',projectId:project.id,archived:true}]},
    {expectedRevision:4,operations:[{type:'update_project',projectId:project.id,archived:false}]},
  ]);
  project.status='running';f.setProjects([project]);await f.ui.refresh();assert.ok(Object.hasOwn(f.projectControls.find(node=>node.dataset.project==='archive-plan').attributes,'disabled'));
  await f.click('archive-plan',{id:project.id});assert.equal(f.calls.filter(call=>call.method).length,2);assert.match(f.toasts.at(-1)[0],/active workers/);
});

test('worker plan navigation follows the actual saved run identity without dispatching a worker',async t=>{
  const project=heldProject(),run={id:'original-implementation',status:'completed',taskState:{taskId:'worker-owned-plan',revision:6,steps:[{id:'checked',title:'Inspect original result',status:'done'}]}},f=fixture(t,{projects:[project],onApi:url=>url==='/api/runs/'+run.id?{run}:undefined});await f.ui.open();
  assert.deepEqual(f.taskCards.map(card=>card.dataset.projectTask),['prerequisite','later-output']);assert.match(f.taskCards[0].content,/project-attempt-outline/);assert.match(f.taskCards[0].content,/data-project-worker="implementation"/);assert.match(f.taskCards[0].content,/data-project-worker="verification"/);
  await f.click('worker-plan',{id:run.id});assert.deepEqual(f.planningOpened,[{taskId:'worker-owned-plan',taskState:run.taskState,runId:run.id,runStatus:run.status}]);assert.equal(f.calls.filter(call=>call.method).length,0);assert.equal(f.timers.size,0,'navigating to the worker plan stops Swarms polling');
});

test('missing worker plans keep the saved outline visible and never substitute the project task id',async t=>{
  const f=fixture(t,{projects:[heldProject()],onApi:url=>url==='/api/runs/original-implementation'?{id:'original-implementation',status:'running'}:undefined});await f.ui.open();await f.click('worker-plan',{id:'original-implementation'});
  assert.deepEqual(f.planningOpened,[]);assert.match(f.html,/This worker has no saved plan yet/);assert.ok(f.taskCards.length);assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('expanding tasks exposes the same saved outline without launching or rewriting it',async t=>{
  const f=fixture(t,{projects:[savedProject()]});await f.ui.open();assert.ok(f.taskDisclosures.every(detail=>!detail.open));await f.click('expand-tasks');assert.ok(f.taskDisclosures.every(detail=>detail.open));await f.click('collapse-tasks');assert.ok(f.taskDisclosures.every(detail=>!detail.open));assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('saving a new plan while browsing Archive reveals the new active plan',async t=>{
  const archived={...savedProject(),archived:true},f=fixture(t,{projects:[archived]});await f.ui.open();await f.click('history',{id:'archived'});await f.click('new');
  await f.input('name','New active work');await f.input('objective','Inspect the active plan without starting it.');await f.input('title','Inspect plan',{task:'task-1'});await f.input('instructions','Inspect the saved plan.',{task:'task-1'});await f.input('criteria','The plan is inspectable.',{task:'task-1'});await f.submit();
  assert.equal(f.projectControls.find(node=>node.dataset.project==='history'&&node.dataset.id==='active').attributes['aria-pressed'],'true');assert.deepEqual(f.projectControls.filter(node=>node.dataset.project==='select').map(node=>node.dataset.id),['created-project']);assert.match(f.html,/New active work/);assert.equal(f.calls.filter(call=>call.method).length,1);
});

test('unavailable organization replaces stale groups, shows its error and withholds organization writes',async t=>{
  const project={...savedProject(),groupId:'work'},f=fixture(t,{projects:[project],organization:{revision:3,healthy:true,groups:[{id:'work',name:'Old group name'}]}});await f.ui.open();assert.match(f.html,/Old group name/);
  f.setOrganization({revision:null,groups:[],healthy:false,error:'The saved organization file is damaged.'});await f.ui.refresh();
  assert.match(f.html,/<div class="project-error" role="alert"><p class="error-text">The saved organization file is damaged\./);assert.doesNotMatch(f.html,/Old group name/);
  assert.ok(!f.projectControls.some(node=>['new-group','rename-group','move-plan','archive-plan','restore-plan'].includes(node.dataset.project)));
  assert.ok(f.projectControls.some(node=>node.dataset.project==='rename-plan'),'the authoritative project name remains editable');
  await f.click('archive-plan',{id:project.id});await f.click('new-group');assert.equal(f.calls.filter(call=>call.method).length,0);
  f.setOrganization({revision:4,healthy:true,groups:[{id:'work',name:'Recovered group'}]});await f.click('refresh-organization');assert.match(f.html,/Recovered group/);assert.ok(f.projectControls.some(node=>node.dataset.project==='move-plan'));assert.doesNotMatch(f.html,/archive membership cannot be confirmed/);
});

test('a lost create acknowledgement is reconciled by its stable group identity before a changed-name retry',async t=>{
  let delivered=false,groupId;const f=fixture(t,{projects:[savedProject()],onApi:(url,method,body)=>{
    if(url==='/api/planning/organization'&&method==='POST'&&!delivered){delivered=true;const operation=body.operations[0];groupId=operation.id;f.setOrganization({revision:4,healthy:true,groups:[{id:groupId,name:operation.name}]});throw Error('The save acknowledgement was lost.');}
  }});await f.ui.open();await f.click('new-group');await f.inputForm('project-organization-editor','name','Original submitted group');await f.submit('project-organization-editor');
  assert.match(f.html,/acknowledgement was lost/);await f.inputForm('project-organization-editor','name','Name reviewed after reconnect');await f.click('reload-organization');
  assert.match(f.html,/<h3>Rename group<\/h3>/);assert.equal(f.forms.get('project-organization-editor').elements.namedItem('name').value,'Name reviewed after reconnect');await f.submit('project-organization-editor');
  const writes=f.calls.filter(call=>call.method);assert.deepEqual(writes.map(call=>call.body),[
    {expectedRevision:3,operations:[{type:'create_group',id:groupId,name:'Original submitted group'}]},
    {expectedRevision:4,operations:[{type:'rename_group',groupId,name:'Name reviewed after reconnect'}]},
  ]);assert.equal(f.groupDetails.filter(group=>group.dataset.projectGroup===groupId).length,1);assert.match(f.html,/Name reviewed after reconnect/);
});

test('an unavailable group refresh preserves the current move selection and blocks its submission',async t=>{
  const project={...savedProject(),groupId:'work'},f=fixture(t,{projects:[project],organization:{revision:3,groups:[{id:'work',name:'Work'}]}});await f.ui.open();await f.click('move-plan',{id:project.id});
  f.setOrganization({revision:null,healthy:false,groups:[],error:'Organization unavailable.'});await f.click('reload-organization');
  assert.equal(f.forms.get('project-organization-editor').elements.namedItem('groupId').value,'work');assert.match(f.html,/Unavailable group/);await f.submit('project-organization-editor');assert.equal(f.calls.filter(call=>call.method).length,0);assert.match(f.html,/Organization unavailable/);
});


test('Swarms distinguishes saved plans from one-off creation and the related workspaces',async t=>{
  const f=fixture(t);await f.ui.open();
  assert.match(f.html,/data-action="planning"/);assert.match(f.html,/data-action="projects" aria-current="page" disabled/);assert.match(f.html,/data-action="operations"/);
  assert.match(f.html,/data-action="swarm">Create swarm/);assert.match(f.html,/data-project="new"[^>]*>Advanced saved plan/);assert.match(f.html,/Create swarm/);
  assert.equal(f.calls.filter(call=>call.method).length,0,'navigation and empty-state choices must not dispatch work');
});

test('returning from Planning retains the selected saved swarm and offers unfinished drafts explicitly',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await authoredDraft(f);const key=f.drafts[0].key;
  await f.click('cancel-edit');await f.click('select',{id:project.id});await f.click('planning');f.close();await f.ui.open();
  assert.equal(f.form,null,'the selected saved swarm must not be replaced by an unrelated recovery draft');assert.match(f.html,/Saved plan/);assert.match(f.html,/Resume draft/);
  await f.click('resume-draft',{id:key});assert.equal(f.form.elements.namedItem('name').value,'A carefully authored goal');assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('opening Planning saves the current swarm draft and restores its exact text on return',async t=>{
  const f=fixture(t);await authoredDraft(f);await f.input('objective','Keep this exact unfinished outcome.');await f.click('planning');f.close();await f.ui.open();
  assert.equal(f.form.elements.namedItem('objective').value,'Keep this exact unfinished outcome.');assert.equal(f.drafts[0].data.draft.objective,'Keep this exact unfinished outcome.');assert.equal(f.calls.filter(call=>call.method).length,0);
});

test('current work stays primary while the saved library is deliberately revealed without dispatching work',async t=>{
  const first={...savedProject(),groupId:'work'},second={...savedProject(),id:'second-plan',name:'Second saved swarm',groupId:'work'},f=fixture(t,{projects:[first,second],organization:{revision:3,groups:[{id:'work',name:'Work'}]}});
  await f.ui.open({projectId:first.id});assert.equal(f.list.hidden,true);assert.equal(f.list.inert,true);assert.ok(f.taskDisclosures.every(detail=>!detail.open));assert.equal(f.disclosures.find(detail=>detail.dataset.detail==='project:details').open,false);
  assert.match(f.html,/<h3>Saved plan<\/h3><p class="project-goal-preview">Test the project editor round trip\.<\/p>/);assert.match(f.html,/<h4>Build prerequisite<\/h4>/);
  await f.click('browse');assert.equal(f.list.hidden,false);assert.equal(f.list.inert,false);assert.equal(document.activeElement?.dataset.id,first.id);f.list.scrollTop=137;const group=()=>f.groupDetails.find(detail=>detail.dataset.projectGroup==='work');group().open=false;
  await f.click('browse');assert.equal(f.list.hidden,true);assert.equal(document.activeElement?.dataset.project,'browse');first.revision++;f.setProjects([first,second]);await f.ui.refresh();await f.click('browse');assert.equal(f.list.scrollTop,137);assert.equal(group().open,false);assert.equal(document.activeElement,group().summary,'a collapsed selected group receives visible focus without being opened');
  await f.click('select',{id:second.id});assert.equal(f.list.hidden,true);assert.equal(document.activeElement,f.main);assert.match(f.html,/<h3>Second saved swarm<\/h3>/);
  await f.click('browse');assert.equal(group().open,false);assert.equal(f.list.scrollTop,137);assert.equal(document.activeElement,group().summary);assert.equal(f.calls.filter(call=>call.method).length,0,'catalog, task inspection, and selection must not save or launch workers');
});

test('closed step editors preserve every saved field and validation reveals the correction without an execution request',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open({projectId:project.id});await f.click('edit');
  const detail=id=>f.disclosures.find(item=>item.dataset.detail===id),taskId='prerequisite';assert.ok(f.disclosures.filter(item=>item.dataset.detail.startsWith('draft-step:')).every(item=>!item.open));
  detail('draft-step:'+taskId).open=true;detail('editor:'+taskId).open=true;await f.input('instructions','Keep this exact unfinished instruction.',{task:taskId});await f.input('criteria','',{task:taskId});detail('draft-step:'+taskId).open=false;detail('editor:'+taskId).open=false;
  await f.submit();assert.match(f.html,/Add an observable acceptance check for step 2/);assert.equal(detail('draft-step:'+taskId).open,true);assert.equal(detail('editor:'+taskId).open,true);assert.equal(detail('draft-step:later-output').open,false);assert.equal(document.activeElement?.name,'criteria');assert.equal(f.calls.filter(call=>call.method).length,0);
  await f.input('criteria','The prerequisite exists.',{task:taskId});await f.submit();const write=f.calls.find(call=>call.method==='PUT');assert.ok(write);assert.equal(write.body.tasks[1].instructions,'Keep this exact unfinished instruction.');assert.equal(write.body.tasks[1].model,'provider::implement-b');assert.equal(write.body.tasks[1].maxRepairs,3);assert.deepEqual(write.body.tasks[0].dependsOn,['prerequisite']);assert.deepEqual(write.body.tasks[0].acceptanceCriteria,project.tasks[0].acceptanceCriteria);assert.equal(f.calls.filter(call=>call.method).length,1);assert.equal(f.calls.some(call=>/\/(?:start|retry-task|review-task)$/.test(call.url)),false);
});

test('changed swarm polling preserves the open area chooser and focused summary without starting work',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();
  const chooser=()=>f.disclosures.find(detail=>detail.dataset.detail==='coordination-area'),initial=chooser();assert.ok(initial,'the shared area chooser has a stable disclosure identity');initial.open=true;initial.summary.focus();
  project.revision++;project.name='Changed while choosing an area';f.setProjects([project]);await f.ui.refresh();
  assert.notEqual(chooser(),initial,'the regression must exercise a changed-data redraw');assert.equal(chooser().open,true);assert.equal(document.activeElement,chooser().summary);assert.deepEqual(chooser().summary.focusOptions,{preventScroll:true});assert.match(f.html,/Changed while choosing an area/);assert.equal(f.calls.filter(call=>call.method).length,0,'polling with the area chooser open must not save, restart, or launch workers');
});

for(const destination of ['planning','operations'])test('changed swarm polling preserves keyboard focus on the open '+destination+' area destination without admission',async t=>{
  const project=savedProject(),f=fixture(t,{projects:[project]});await f.ui.open();const chooser=()=>f.disclosures.find(detail=>detail.dataset.detail==='coordination-area'),control=()=>f.coordinationControls.find(node=>node.dataset.action===destination);
  chooser().open=true;const initial=control();assert.ok(initial);initial.focus();assert.equal(document.activeElement,initial);
  project.revision++;project.name='Changed during keyboard area navigation';f.setProjects([project]);await f.ui.refresh();
  assert.notEqual(control(),initial,'the test must exercise a changed-data redraw');assert.equal(chooser().open,true);assert.equal(document.activeElement,control());assert.equal(control().focusWasVisible,true);assert.deepEqual(control().focusOptions,{preventScroll:true});assert.equal(f.planningOpened.length,0,'restoring focus must not activate the destination');assert.equal(f.calls.filter(call=>call.method).length,0,'polling cannot admit saved work or launch a worker');
});
