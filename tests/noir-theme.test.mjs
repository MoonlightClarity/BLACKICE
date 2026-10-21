import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createHarnessServer} from '../server.mjs';
import {renderNoirCity,sceneFromConfig,writeScene} from '../scripts/generate-noir-background.mjs';

const get=relative=>readFile(new URL('../'+relative,import.meta.url),'utf8');
const asset='public/assets/agentdesk-noir-city.svg';
const geometryOnly=svg=>svg.replace(/<metadata>[\s\S]*?<\/metadata>/,'');

test('retained vector artwork is reproducible byte-for-byte from editable source + config',async()=>{
 const config=JSON.parse(await get('scripts/noir-scene.config.json'));
 const committed=await get(asset),rendered=renderNoirCity(config);
 assert.equal(rendered,committed);
 assert.equal(await sceneFromConfig(),committed);
 assert.ok(Buffer.byteLength(committed)>20000&&Buffer.byteLength(committed)<2000000);
 assert.match(committed,/config SHA256 [0-9a-f]{64}/);
 assert.match(committed,/<title>BLACKICE \/ Frozen state<\/title>/);
 for(const id of ['01_dark_frozen_depths','02_overlapping_translucent_sheets','03_cloudy_frost_blooms','04_branching_subsurface_fractures','05_trapped_air_bubbles','06_frost_inclusions_and_surface_scores','07_reading_space_and_edge_falloff'])assert.ok(committed.includes(`id="${id}"`));
 assert.equal((committed.match(/inkscape:groupmode="layer"/g)||[]).length,7);
 assert.ok(committed.split('\n').length>500);
 assert.ok(!/<image\b|<foreignObject\b|<script\b|href\s*=|@import|data:image|NOCT|NIGHT SHIFT/i.test(committed));
 assert.equal(config.schemaVersion,3);
 assert.match(committed,/id="trapped-air-cluster-/);
 assert.match(committed,/id="feathered-frost-/);
 assert.match(committed,/id="frost-bloom-/);
 assert.ok(!/glacier-|monolith|distant-skyline|polar_atmosphere/.test(committed));
 assert.deepEqual((await writeScene({check:true})).sha256,createHash('sha256').update(committed).digest('hex'));
});

test('editable seed and palette change the actual scene without changing the original',async()=>{
 const config=JSON.parse(await get('scripts/noir-scene.config.json'));
 const standard=renderNoirCity(config);
 const reseeded=structuredClone(config);reseeded.seed+=1;
 const alternative=renderNoirCity(reseeded);
 assert.notEqual(geometryOnly(alternative),geometryOnly(standard));
 assert.equal(renderNoirCity(reseeded),alternative);
 const dimmer=structuredClone(config);dimmer.material.rimLight=.2;
 assert.notEqual(geometryOnly(renderNoirCity(dimmer)),geometryOnly(standard));
 const recolored=structuredClone(config);recolored.palette.cyan='#21ffe9';
 assert.notEqual(geometryOnly(renderNoirCity(recolored)),geometryOnly(standard));
 assert.equal(renderNoirCity(config),standard);
 for(const input of [
  {...config,seed:0},
  {...config,seed:1.1},
  {...config,canvas:{...config.canvas,width:0}},
  {...config,bubbles:{...config.bubbles,count:500000}},
  {...config,palette:{...config.palette,cyan:'url(http://example.com/unsafe)'}},
  {...config,material:{...config.material,translucency:2}},
 ])assert.throws(()=>renderNoirCity(input));
 const geometry=structuredClone(config);geometry.plates[0].outline[0][0]+=12;
 assert.notEqual(geometryOnly(renderNoirCity(geometry)),geometryOnly(standard));
 const fractured=structuredClone(config);fractured.fractures.push({points:[[0,1100],[90,1040],[120,1050]],strength:.8});
 assert.notEqual(geometryOnly(renderNoirCity(fractured)),geometryOnly(standard));
});

test('editable ice material rejects malformed geometry and out-of-bounds detail counts',async()=>{
 const config=JSON.parse(await get('scripts/noir-scene.config.json'));
 assert.throws(()=>renderNoirCity({...config,plates:undefined}),/Missing editable ice material section/);
 for(const outline of [
  [[0,0],[100,0]],
  [[0,0],[100,0],[100,100],[0,'100']],
  [[0,0],[100,0],[100,100],[0,4001]],
 ])assert.throws(()=>renderNoirCity({...config,plates:[{...config.plates[0],outline}]}),/Invalid ice plate geometry/);
 for(const scratches of [-1,1501,2.5]){
  assert.throws(()=>renderNoirCity({...config,surface:{...config.surface,scratches}}),/Invalid count/);
 }
 for(const id of ['bad" onclick="alert(1)','../ice','<script>'])assert.throws(()=>renderNoirCity({...config,plates:[{...config.plates[0],id}]}),/Invalid ice plate geometry/);
 const invalidFrost=structuredClone(config);invalidFrost.frost.patches[0].intensity=3;
 assert.throws(()=>renderNoirCity(invalidFrost),/Invalid frost patch/);
 const invalidBubble=structuredClone(config);invalidBubble.bubbles.clusters[0].radius='url(https://example.com)';
 assert.throws(()=>renderNoirCity(invalidBubble),/Invalid trapped bubble cluster/);
});

test('retained editable SVG backdrop is local and CSS uses no remote media',async()=>{
 const [html,server,css,packageText,readme]=await Promise.all([
  get('public/index.html'),get('server.mjs'),get('public/agentdesk-noir.css'),get('package.json'),get('README.md')
 ]);
 assert.ok(html.indexOf('href="/agentdesk-noir.css"')>html.indexOf('href="/relay-surface.css"'));
 assert.ok(server.includes("'assets/agentdesk-noir-city.svg'"));
 assert.ok(!server.includes("'assets/agentdesk-after-hours.png'"));
 assert.ok(!server.includes("'.jpg'"));
 assert.ok(css.includes('url("/assets/agentdesk-noir-city.svg")'));
 assert.ok(!css.includes('agentdesk-after-hours.png'));
 assert.ok(!css.includes('.jpg'));
 assert.match(css,/@media\(max-width:540px\)/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
 assert.match(css,/@media\(forced-colors:active\)/);
 assert.match(css,/@media\(prefers-contrast:more\)/);
 assert.match(css,/:focus-visible/);
 assert.match(css,/backdrop-filter:blur/);
 assert.ok(!['http://','https://','data:image/'].some(value=>css.includes(value)));
 const banned=['un','splash'].join('');
 for(const text of [html,server,css,readme,packageText])assert.ok(!text.toLowerCase().includes(banned));
 const pkg=JSON.parse(packageText);
 assert.ok(pkg.scripts['scene:build']?.includes('generate-noir-background.mjs'));
 assert.ok(pkg.scripts['scene:check']?.includes('--check'));
 assert.ok((await readdir(new URL('../public/assets/',import.meta.url))).every(name=>!/\.jpe?g$/i.test(name)));
});

test('retained SVG artwork and CSS are served locally with correct MIME types',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'agentdesk-svg-route-'));
 class Runtime extends EventEmitter{
  status(){return{connected:false,authenticated:false,models:[],defaultModel:'fixture'};}
  async start(){return this.status();}
  async close(){}
 }
 class Desktop extends EventEmitter{
  status(){return{enabled:false,available:false};}
  async setEnabled(){return this.status();}
  async close(){}
 }
 const app=await createHarnessServer({port:0,dataDir:path.join(root,'data'),defaultCwd:root,runtime:new Runtime(),desktop:new Desktop(),autoAttachDesktop:false,showBrowserOS:async()=>({shown:false,focused:false,started:false})});
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})});
 const address=await app.listen();
 const svg=await fetch(new URL('/assets/agentdesk-noir-city.svg',address));
 const css=await fetch(new URL('/agentdesk-noir.css',address));
 assert.equal(svg.status,200);assert.match(svg.headers.get('content-type'),/image\/svg\+xml/);
 assert.equal(await svg.text(),await get(asset));
 assert.equal(css.status,200);assert.match(css.headers.get('content-type'),/text\/css/);
 assert.match(await css.text(),/\.conversation-starters \.starter-card/);
 for(const name of ['Oxanium-Variable.ttf','IBMPlexMono-Regular.ttf','IBMPlexMono-Medium.ttf','ShareTechMono-Regular.ttf']){
  const font=await fetch(new URL('/assets/fonts/'+name,address));
  assert.equal(font.status,200);assert.equal(font.headers.get('content-type'),'font/ttf');
  assert.deepEqual(Buffer.from(await font.arrayBuffer()),await readFile(new URL('../public/assets/fonts/'+name,import.meta.url)));
 }
 for(const name of ['blackice-panel-ice.svg','blackice-control-ice.svg']){
  const response=await fetch(new URL('/assets/'+name,address));
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\/svg\+xml/);
  const content=await response.text();assert.equal(content,await get('public/assets/'+name));
  assert.match(content,/preserveAspectRatio="none"/);
  assert.ok(!/<image\b|<script\b|<foreignObject\b|href\s*=|data:image|@import/i.test(content));
 }
 for(const name of ['blackice-components.css','blackice-type.css']){
  const response=await fetch(new URL('/'+name,address));
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/css/);
  assert.equal(await response.text(),await get('public/'+name));
 }
 const legacy=await fetch(new URL('/assets/nonexistent-scene.svg',address));
 assert.equal(legacy.status,404);
});
