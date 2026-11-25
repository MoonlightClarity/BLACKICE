import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';

const MAX_DESCRIPTION = 12000;
const TOOL_NAME = /^[a-z][a-z0-9_]{1,99}$/;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message, status = 400) => Object.assign(new Error(message), {status});

function validated(value) {
  if (!plain(value) || value.version !== 1 || !Number.isSafeInteger(value.revision)
      || value.revision < 0 || !plain(value.overrides)) throw invalid('Invalid saved tool-description record.');
  const overrides = Object.create(null);
  for (const [name, description] of Object.entries(value.overrides)) {
    if (!TOOL_NAME.test(name) || typeof description !== 'string' || !description.trim()
        || description.length > MAX_DESCRIPTION || description.includes('\0'))
      throw invalid('Invalid saved tool description: '+name);
    overrides[name] = description;
  }
  return {version:1,revision:value.revision,overrides};
}

/** User-controlled model-visible tool-description overlays; argument schemas remain canonical. */
export class ToolDescriptionOverrides {
  constructor({dataDir}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('Tool descriptions require a data directory.');
    this.file = path.join(dataDir,'tool-descriptions.json');
    this.state = {version:1,revision:0,overrides:Object.create(null)};
    this.ready = false;
    this.queue = Promise.resolve();
  }
  async init() {
    if (this.ready) return this;
    let data;
    try { data = await fs.readFile(this.file,'utf8'); }
    catch (error) { if(error.code !== 'ENOENT') throw error; }
    if (data !== undefined) this.state = validated(JSON.parse(data));
    this.ready = true;
    return this;
  }
  get revision() { return this.state.revision; }
  project(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.map(tool => {
      const description = this.state.overrides[tool?.name];
      return typeof description === 'string' ? {...tool,description} : tool;
    });
  }
  list(definitions) {
    const unique = new Map();
    for (const tool of definitions || []) {
      if (!TOOL_NAME.test(tool?.name || '') || typeof tool.description !== 'string'
          || unique.has(tool.name)) continue;
      const override = this.state.overrides[tool.name];
      unique.set(tool.name,{name:tool.name,defaultDescription:tool.description,
        description:override ?? tool.description,overridden:typeof override==='string'});
    }
    return {version:1,revision:this.revision,tools:[...unique.values()].sort((a,b)=>a.name.localeCompare(b.name))};
  }
  async save({name,description,expectedRevision},definitions) {
    if (!this.ready) await this.init();
    const task = async () => {
      const available = new Set((definitions || []).map(tool=>tool?.name));
      if (!TOOL_NAME.test(name || '') || !available.has(name))
        throw invalid('The tool is not in BLACKICE\'s editable model-tool catalog.',404);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw invalid('Supply the current tool-description revision.');
      if (expectedRevision !== this.revision)
        throw invalid('Tool descriptions changed since they were loaded. Reload before saving.',409);
      if (description !== null && (typeof description !== 'string' || !description.trim()
          || description.length > MAX_DESCRIPTION || description.includes('\0')))
        throw invalid('Description must contain 1 to 12000 characters, or null to restore the default.');
      const current = this.state.overrides[name];
      if ((description === null && current === undefined) || (description !== null && description === current))
        return this.list(definitions);
      const overrides = {...this.state.overrides};
      if (description === null) delete overrides[name];
      else overrides[name] = description;
      const next = validated({version:1,revision:this.revision+1,overrides});
      const tmp = this.file + '.' + randomUUID() + '.tmp';
      await fs.mkdir(path.dirname(this.file),{recursive:true});
      try {
        await fs.writeFile(tmp,JSON.stringify(next,null,2)+'\n',{encoding:'utf8',flag:'wx'});
        await fs.rename(tmp,this.file);
      } catch(error) {
        await fs.rm(tmp,{force:true}).catch(()=>{});
        throw error;
      }
      this.state = next;
      return this.list(definitions);
    };
    const result = this.queue.then(task);
    this.queue = result.then(()=>{},()=>{});
    return result;
  }
}
