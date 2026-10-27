import { text } from '../core/dom.mjs';

/**
 * Visual projection of methods the agent actually RECORDED in the saved plan.
 * No required phases, inferred thought traces, or compulsory completion boxes.
 * A repeated technique remains a separate occurrence in plan order.
 */
export const ANALYTIC_METHOD_LABELS = Object.freeze({
  assumption_check: Object.freeze({
    label:'Key assumptions check',
    when:'At framing and again before a consequential judgment'
  }),
  information_quality: Object.freeze({
    label:'Information quality',
    when:'Throughout collection, interpretation and reassessment'
  }),
  competing_hypotheses: Object.freeze({
    label:'Analysis of competing hypotheses',
    when:'Revisited as evidence and candidate explanations change'
  }),
  contrarian_review: Object.freeze({
    label:'Contrarian challenge',
    when:'When a prevailing interpretation needs stress-testing'
  }),
  outside_in: Object.freeze({
    label:'Outside-in perspective',
    when:'When framing needs broader contextual forces'
  }),
  indicators: Object.freeze({
    label:'Indicators and signposts',
    when:'Updated throughout as observable conditions change'
  }),
  decision_test: Object.freeze({
    label:'Decision assumption test',
    when:'When a specific intervention or decision is actually at issue'
  })
});
export function recordedAnalyticPasses(state={}) {
  const entries=Array.isArray(state?.steps)?state.steps:[];
  const seen=new Map();
  const occurrences=[];
  for(const [index,step] of entries.entries()){
    if ((step?.kind||'action')!=='action') continue;
    const id=String(step.stepType||'');
    const method=ANALYTIC_METHOD_LABELS[id];
    if(!method)continue;
    const number=(seen.get(id)||0)+1;
    seen.set(id,number);
    occurrences.push({
      id:step.id,title:step.title||method.label,kind:id,
      label:method.label,when:method.when,
      occurrence:number,revisited:number>1,position:index+1,
      status:step.status||'pending',
      hasEvidence:Boolean(String(step.evidence||'').trim())
    });
  }
  return {
    occurrences,
    repeated:[...seen].filter(([,count])=>count>1).map(([kind,count])=>({kind,count})),
    sourceRevision:Number.isSafeInteger(state?.revision)?state.revision:null
  };
}
export function renderRecordedAnalyticPasses(parent, state={}, {onSelect}={}) {
  const timeline=recordedAnalyticPasses(state);
  if (!timeline.occurrences.length) return null;
  const block=text(parent,'','details','next-tradecraft-timeline');
  block.dataset.revision=String(timeline.sourceRevision??'');
  text(block,'Analytical technique timeline · '+timeline.occurrences.length+' recorded passes','summary');
  text(block,'This shows methods actually saved in the plan. The same method may be revisited; the timeline is not a required sequence or a proof that an interpretation is correct.','p','next-help');
  const list=text(block,'','ol','next-tradecraft-steps');
  for(const row of timeline.occurrences){
    const item=text(list,'','li','next-tradecraft-step');
    item.dataset.stepId=row.id;
    item.dataset.technique=row.kind;
    item.dataset.status=row.status;
    const header=text(item,'','div','next-tradecraft-step-head');
    if(typeof onSelect==='function'){
      const button=text(header,row.title,'button','next-tradecraft-step-link');
      button.type='button';
      button.addEventListener('click',()=>onSelect(row.id));
    } else text(header,row.title,'strong');
    const stateLabel=row.revisited ? row.label+' · revisit '+row.occurrence : row.label;
    text(item,stateLabel+' · '+row.status,'p','next-tradecraft-meta');
    text(item,row.when,'p','next-help');
    if(row.hasEvidence)text(item,'Source or reasoning record saved','span','next-tradecraft-evidence');
  }
  return block;
}
