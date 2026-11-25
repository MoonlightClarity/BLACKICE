import {skillApplicability} from './skills-catalog.mjs';

// Utility for an optional, provenance-carrying preview. The runtime does NOT
// inject skills automatically. Only an explicit user request loads the full
// current revision, and model-initiated reads use relay_skills directly.
export function projectExecutionSkill(skill,{explicit=false}={}){
  if(!skill||typeof skill.content!=='string')throw new TypeError('Skill content is required');
  if(explicit)return {mode:'full',text:skill.content};
  const applicability=skillApplicability(skill.content,skill);
  const description=applicability.description||'An optional method, available through the skill catalog.';
  return {mode:'brief',text:description.replace(/\s+/g,' ').trim().slice(0,500)
    +'\nRead the current effective revision with relay_skills '+JSON.stringify({action:'read',id:skill.id})+'.'};
}
