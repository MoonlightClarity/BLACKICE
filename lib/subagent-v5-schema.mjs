/** Exact original v5 forecast input schema retained only for saved native provider catalogs; no scoring. */
export const SUBAGENT_V5_FORECAST_SCHEMA=Object.freeze({
 type:'object',additionalProperties:false,required:['factors'],properties:{
  factors:{type:'array',minItems:1,maxItems:7,items:{type:'object',additionalProperties:false,
   required:['id','wep','confidence','basis'],properties:{
    id:{type:'string',enum:['saved_critical_path_time','independent_quality_gain','context_isolation_gain','worker_setup_cost','duplicated_context_cost','integration_and_rework_cost','hardware_contention_cost']},
    wep:{type:'string',enum:['almost_no_chance','very_unlikely','unlikely','roughly_even_chance','likely','very_likely','almost_certain']},
    confidence:{type:'string',enum:['low','moderate','high']},
    basis:{type:'string',minLength:12,maxLength:1000}
   }}}
 }
});
