import test from 'node:test';
import assert from 'node:assert/strict';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {createRetrievalToolHandler} from '../lib/retrieval-tools.mjs';
import {projectExecutionSkill} from '../lib/execution-skill-brief.mjs';
import {BROWSER_TOOL,createBrowserToolHandler} from '../lib/browser.mjs';
import {BROWSER_VERIFICATION_GUIDANCE} from '../lib/browser-signin.mjs';

const id='library-browser-captcha';

test('vision-only CAPTCHA skill is cataloged, discoverable, and readable by the model',async()=>{
  const catalog=createSkillsCatalog();
  const found=await catalog.list({query:'visual captcha',limit:15});
  const entry=found.entries.find(item=>item.id===id);
  assert.ok(entry,'the catalog must expose the dedicated CAPTCHA skill');
  assert.equal(Object.hasOwn(entry,'content'),false,'discovery must not silently inject the full manual');
  const response=await createRetrievalToolHandler({cwd:process.cwd(),skillsCatalog:catalog})
    ({name:'relay_skills',arguments:{action:'read',id}});
  assert.equal(response.success,true);
  const read=JSON.parse(response.contentItems[0].text).entry;
  assert.equal(read.id,id);
  assert.match(read.content,/model's own vision/);
  assert.match(read.content,/relay_browser/);
  assert.match(read.content,/screenshot/);
  assert.match(read.content,/imageScale/);
  assert.match(read.content,/expectedDocumentId/);
  assert.match(read.content,/verify its actual confirmation/i);
  assert.match(read.content,/Do not call third-party CAPTCHA solvers/);
  assert.match(read.content,/not automatically a human-only blocker/);
  const projected=projectExecutionSkill(read);
  assert.equal(projected.mode,'brief');
  assert.ok(projected.text.length<650);
  assert.match(projected.text,/library-browser-captcha/);
  assert.ok(!projected.text.includes(read.content),'automatic selection must not flood context');
  assert.equal(projectExecutionSkill(read,{explicit:true}).text,read.content,'explicit skill access remains full fidelity');
});

test('contained browser exposes screenshot and ordinary visual controls but no solver API',()=>{
  const actions=BROWSER_TOOL.inputSchema.properties.action.enum;
  for(const action of ['screenshot','snapshot','click','hover','press','select','wait'])assert.ok(actions.includes(action));
  for(const required of ['tabId','expectedUrl','expectedDocumentId','x','y'])assert.ok(BROWSER_TOOL.inputSchema.properties[required]);
  assert.match(BROWSER_TOOL.description,/library-browser-captcha/);
  assert.match(BROWSER_TOOL.description,/model vision/);
  assert.match(BROWSER_VERIFICATION_GUIDANCE,/read library-browser-captcha with relay_skills/);
  assert.match(BROWSER_VERIFICATION_GUIDANCE,/no external CAPTCHA-solving APIs/);
  assert.doesNotMatch(BROWSER_TOOL.description,/2captcha|anti-captcha|captcha\.solver/i);
});

test('native screenshot delivers image bytes for the model vision path without a solver service',async()=>{
  const owner={taskId:'fixture',runId:'run',nodeId:'agent'};
  const url='https://jobs.lever.co/example/apply',tabId='visual-fixture',documentId='visual-fixture:1';
  const screenshot='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/jpEAAAAASUVORK5CYII=';
  let calls=0;
  const browser={
    status:()=>({available:true,contained:true,tabs:[{tabId,url,documentId,owner}]}),
    perform:async args=>{
      calls++;assert.equal(args.action,'screenshot');assert.equal(args.tabId,tabId);
      return{tabId,url,documentId,frames:[{text:'Visual challenge'}],imageUrl:screenshot};
    }
  };
  const run=createBrowserToolHandler({browser,owner});
  const result=await run({name:'relay_browser',arguments:{action:'screenshot',browser:'relay',tabId}});
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(calls,1);
  assert.ok(result.contentItems.some(item=>item.type==='inputImage'&&item.imageUrl===screenshot),
    'vision-capable models must receive the screenshot as an image, not only page text');
});
