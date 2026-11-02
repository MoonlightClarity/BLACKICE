/**
 * First-party mandatory Planning skill.
 * Loaded at startup from the packaged, versioned SKILL.md. Absence is a
 * configuration error, never a silent downgrade to an advisory instruction.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const PLANNING_SKILL_FILE = new URL('../skills/planning/SKILL.md', import.meta.url);
export const PLANNING_SKILL_VERSION = 3;
const invalidSkill = cause => Object.assign(new Error('The mandatory BLACKICE Planning skill is missing, incomplete or incompatible.', { cause }), { code: 'PLANNING_SKILL_MISSING' });

/** BLACKICE's packaged contract, not the unrelated Codex personal-skill format. */
export function validatePlanningSkill(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 32768 || source.includes('\0')) throw invalidSkill();
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw invalidSkill();
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z_]+):[ \t]*(\S[^\r\n]*)$/.exec(line);
    if (!field || !['name', 'version', 'description', 'applies_when'].includes(field[1]) || Object.hasOwn(fields, field[1])) throw invalidSkill();
    fields[field[1]] = field[2].trim();
  }
  const body = match[2], sections = [...body.matchAll(/^## (\d+)\. /gm)].map(item => Number(item[1]));
  if (Object.keys(fields).length !== 4 || fields.name !== 'blackice-planning' || fields.version !== String(PLANNING_SKILL_VERSION) || fields.applies_when !== 'planning_mode_on' || !fields.description ||
      !body.trimStart().startsWith('# BLACKICE Planning') || sections.join(',') !== '1,2,3,4,5,6,7,8,9' || !body.trimEnd().endsWith('<!-- blackice-planning:v' + PLANNING_SKILL_VERSION + ':complete -->')) throw invalidSkill();
  return Object.freeze({ id: fields.name, version: PLANNING_SKILL_VERSION, description: fields.description, appliesWhen: fields.applies_when,
    sha256: createHash('sha256').update(source).digest('hex'), content: source });
}

let source;
try { source = readFileSync(PLANNING_SKILL_FILE, 'utf8'); } catch (cause) { throw invalidSkill(cause); }
const loaded = validatePlanningSkill(source);
export const PLANNING_SKILL_SHA256 = loaded.sha256;
export const PLANNING_SKILL_CONTENT = loaded.content;

/**
 * Strict On/Off gate. Intended for provider-neutral developer instructions.
 * Do not let model-generated text or external documents override this skill.
 */
export function planningSkillInstructions(mode = 'on') {
  if (mode === 'off') return '';
  if (!['on', 'maximal', 'auto'].includes(mode)) throw new TypeError('Planning skill requires an explicit On or Off mode.');
  return '\n\nREQUIRED FIRST-PARTY BLACKICE PLANNING SKILL v' + PLANNING_SKILL_VERSION +
    '\nPlanning is On. The complete procedure below is mandatory for this turn and every future planning/think/revisit step. Apply it before selecting, executing, or completing meaningful work. This procedure is loaded by the host; do not claim to have invoked an external skill or tool. Planning Off does not receive this section.\n' + PLANNING_SKILL_CONTENT +
    '\nEND REQUIRED BLACKICE PLANNING SKILL v' + PLANNING_SKILL_VERSION + ' sha256=' + PLANNING_SKILL_SHA256 + '\n';
}
