import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const definitions = [
  {id:'builtin:browser',title:'General browser use',description:'Website navigation, source selection, forms, recovery and result verification.',sourcePath:'skills/browser/SKILL.md',appliesWhen:'Website work',name:'blackice-browser'},
  {id:'builtin:job-search',title:'Job searching',description:'Find jobs on job boards and employer career pages, screen roles and verify authorized applications.',sourcePath:'skills/job-search/SKILL.md',appliesWhen:'Job search or application work',name:'blackice-job-search'},
];
export const BUNDLED_TASK_SKILLS = Object.freeze(definitions.map(definition => {
  const content = readFileSync(new URL('../' + definition.sourcePath, import.meta.url), 'utf8');
  if (!content.startsWith('---') || !content.includes('name: ' + definition.name) || !content.includes('version: 1') || content.length > 40000) throw new Error('Invalid bundled task skill: ' + definition.id);
  return Object.freeze({...definition,version:1,content,sha256:createHash('sha256').update(content).digest('hex'),delivery:'on_demand'});
}));
export const bundledTaskSkill = id => BUNDLED_TASK_SKILLS.find(item => item.id === id);
export const bundledTaskSkillMetadata = item => ({id:item.id,kind:'skill',title:item.title,summary:item.description,revision:item.version,cwd:null,source:'bundled',readOnly:true,appliesWhen:item.appliesWhen,sha256:item.sha256});
export function searchBundledTaskSkills(query = '') {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return BUNDLED_TASK_SKILLS.filter(item => terms.every(term => [item.title,item.description,item.content].join('\n').toLowerCase().includes(term))).map(bundledTaskSkillMetadata);
}
export const BUNDLED_TASK_SKILL_GUIDANCE = '\nBUNDLED TASK SKILLS\nBefore website work, read relay_skills action:read id:"builtin:browser". For job searching or applications, also read id:"builtin:job-search": use relevant job boards and employer career pages rather than defaulting to general web search. Apply the relevant skill within the current task; reuse it once read rather than rereading on every click. These are separate, read-only bundled procedures, not claims that a task has been completed.\n';
