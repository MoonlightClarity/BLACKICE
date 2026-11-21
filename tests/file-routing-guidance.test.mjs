import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceToolHandler,WORKSPACE_TOOL,WORKSPACE_INSTRUCTIONS} from '../lib/workspace-tools.mjs';
import {ATTACHMENT_TOOL} from '../lib/attachments.mjs';
test('current workspace guidance routes discovery and local document reads without advertising hidden find',async()=>{
 const h=createWorkspaceToolHandler({cwd:process.cwd()});
 const r=await h({name:'relay_workspace',arguments:{action:'invalid'}});
 assert.equal(r.success,false);const body=JSON.parse(r.contentItems[0].text);
 assert.equal(body.actionDispatched,false);
 assert.equal(body.error,`Choose ${WORKSPACE_TOOL.inputSchema.properties.action.enum.join(', ')}. For filename/path discovery use relay_find_files.`);
 assert.equal(WORKSPACE_TOOL.inputSchema.properties.action.enum.includes('find'),false);
 // Check the route and supported formats, not the retired long-form wording.
 assert.match(WORKSPACE_TOOL.description,/filenames or paths use relay_find_files/);
 for (const format of ['PDF','DOCX','XLSX']) assert.ok(WORKSPACE_TOOL.description.includes(format), format);
 assert.match(WORKSPACE_INSTRUCTIONS,/relay_files[^.]*chat attachment ID/);
 assert.match(ATTACHMENT_TOOL.inputSchema.properties.pageCount.description,/only one page is read and pageCount is ignored/);
 assert.match(ATTACHMENT_TOOL.inputSchema.properties.charCount.description,/reads only startPage/);
});
