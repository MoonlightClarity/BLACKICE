import { skillApplicability } from './skills-catalog.mjs';

// A small, inspectable summary is the automatic delivery unit. Complete owner
// skill bodies remain readable on demand and explicit method selections remain
// full fidelity. A long unrelated method never becomes ambient instructions.
const BRIEFS = Object.freeze({
  'library-what-makes-done':
    'Define done by the actual requested result and verify its effect. A plan, search, tool call or progress report is not completion. If the effect requires follow-up confirmation, complete that step and verify it. If work remains and a viable next action exists, perform it.',
  'library-anti-completion-bias':
    'Do not end a turn merely to describe work not done. Continue the next practical step while tools are available; otherwise report the specific observed blocker or runtime limit.',
  'builtin-task-grounding':
    'Treat the user’s scope as authority. Separate actual restrictions from unknowns, counterparty preferences and unsupported assumptions. A failed branch does not cancel independent work.',
  'builtin-decomposition':
    'For compound work, choose the next executable step; track only dependencies that affect action. Do not require a planning ritual before doing the task.',
  'library-long-term-judgment':
    'Compare realistic next actions by expected benefit and cost without changing user constraints or treating uncertainty as an automatic stop.',
  'library-browser-navigation':
    'Use the contained browser and fresh page identity. Reuse observed controls, verify external effects, and recover stale or missing tabs by reading current tabs. A failed pre-dispatch call has not changed the website. Read the full browser method only for complex frames, visual obstacles, or cleanup.',
  'library-job-search':
    'Use the user’s current designated resume and application history; preserve exact-requisition duplicate protection. Choose live roles by overlap in actual duties and transferable skills, not an exact-title match or arbitrary years of experience. Before spending time on a form, identify one concrete duty or deliverable plausibly supported by the user’s demonstrated work; otherwise continue discovery rather than applying to an unrelated specialty. Respect the user’s hard employment, pay, location and travel constraints; employer wish lists are not user exclusions. Unverified work authorization or sponsorship is an unanswered application field, NOT evidence every role is ineligible; check reusable facts and continue independent work. Do not invent credentials or categorical facts. Resolve or defer only the specific field or form that cannot be answered; pursue another skill-adjacent role. Submit when supported, verify the destination receipt, and record uncertainty without replaying submissions. Read the full editable Job Search skill when specific resume sources or application procedures are needed.'
});

export function projectExecutionSkill(skill, { explicit = false } = {}) {
  if (!skill || typeof skill.content !== 'string') throw new TypeError('Skill content is required');
  if (explicit) return { mode: 'full', text: skill.content };
  const contextual = skillApplicability(skill.content, skill);
  const brief = String(BRIEFS[skill.id] || contextual.description ||
    'Use this procedure only when it materially improves the task.').replace(/\s+/g, ' ').trim().slice(0, 1200);
  return {
    mode: 'brief',
    text: brief + '\nComplete skill remains available through relay_skills read with id ' + JSON.stringify(skill.id) + '.'
  };
}
