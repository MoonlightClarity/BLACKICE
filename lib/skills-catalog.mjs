import { searchReleaseSkills, readReleaseSkill } from './release-skills.mjs';
/** The UI and model read the same release-owned source. No saved/native discovery. */
export function skillIdFromRequestPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/skills/')) return null;
  let id; try { id = decodeURIComponent(pathname.slice('/api/skills/'.length)); } catch { return null; }
  return /^builtin-[a-z0-9-]+$/.test(id) ? id : null;
}
export function createSkillsCatalog() {
  return {
    async list({query='',source='all'}={}) {
      if (!['all','bundled'].includes(source)) throw Object.assign(new Error('Only release-owned skills are available.'), {status:400});
      const entries=searchReleaseSkills(query);
      return {entries, sources:{bundled:{status:'available',count:entries.length}}, truncated:false, explanation:'Release-owned methods are read on demand, never automatically selected or edited by the model. Catalog presence does not prove use.'};
    },
    async detail({id}={}) { return readReleaseSkill(id); }
  };
}
