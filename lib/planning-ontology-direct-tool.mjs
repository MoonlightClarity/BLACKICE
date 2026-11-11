import { DEFAULT_PLANNING_ONTOLOGY, PLANNING_ONTOLOGY_MODULES, normalizePlanningOntology } from '../public/planning-module-policy.mjs';

const payload = value => ({success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});

/** Direct ChatGPT surface for the same modular ontology configured in the chat pane. */
export function planningOntologyDirectTool({runtimeSettings}={}){
  if(typeof runtimeSettings?.get!=='function'||typeof runtimeSettings?.update!=='function')
    throw Object.assign(new Error('An initialized runtime settings store is required.'),{code:'PLANNING_ONTOLOGY_UNAVAILABLE',status:503});
  return {
    definition:{
      name:'blackice_planning_ontology',
      scope:'planning:write',
      requiredScopes:['planning:write'],
      mutating:true,
      description:'Inspect or update the global BLACKICE modular Planning ontology. Get lists modules and the saved Mandatory / Optional / Forbidden policy and model automatic-selection setting. Set atomically saves default policy for new chats. It does not start a model, run a planning cycle, require a task contract or alter active-run snapshots. Explicit user module states override model automatic selection.',
      inputSchema:{
        type:'object',additionalProperties:false,required:['requestId','action'],
        properties:{
          requestId:{type:'string',minLength:1,maxLength:120,pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'},
          action:{type:'string',enum:['get','set']},
          ontology:{
            type:'object',additionalProperties:false,properties:{
              version:{type:'integer',enum:[1]},
              autoSelect:{type:'boolean'},
              modules:{type:'object',additionalProperties:false,properties:Object.fromEntries(PLANNING_ONTOLOGY_MODULES.map(({id})=>[id,{type:'string',enum:['mandatory','optional','forbidden','auto']}]))}
            },
          },
        }
      },
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },
    durableArguments:args=>({requestId:args.requestId,action:args.action,...(args.ontology?{ontology:normalizePlanningOntology(args.ontology)}:{})}),
    async execute(args,{signal}={}){
      if(signal?.aborted)throw Object.assign(new Error('Cancelled before changing Planning defaults.'),{code:'ABORT_ERR',status:409});
      if(args.action==='get')return payload({policy:normalizePlanningOntology(runtimeSettings.get()?.planningOntology),modules:PLANNING_ONTOLOGY_MODULES,states:['mandatory','optional','forbidden','auto'],autoSelectDescription:'Auto is selected independently per module; the legacy global autoSelect field remains accepted for prior saved policies.',legacyForcedPlanning:'preserved only for old conversations'});
      if(args.action!=='set')throw Object.assign(new Error('Choose get or set.'),{code:'PLANNING_ONTOLOGY_INVALID',status:400});
      if(!args.ontology)throw Object.assign(new Error('Set requires ontology.'),{code:'PLANNING_ONTOLOGY_INVALID',status:400});
      const updated=await runtimeSettings.update({planningOntology:normalizePlanningOntology(args.ontology)});
      return payload({saved:true,policy:updated.planningOntology,scope:'future chats and direct start_chat default',activeRunsUnchanged:true});
    }
  };
}
