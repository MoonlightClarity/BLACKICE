/**
 * BLACKICE / Frozen state: an original macro study of fractured, translucent ice.
 * All material, irregular sheet geometry, bubbles and frost are native SVG.
 * No raster images, tracing, external media or fonts. Geometry is editable in
 * Inkscape; source controls are in noir-scene.config.json. Historical exports and
 * the asset path stay compatible with the application.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG=path.join(here,'noir-scene.config.json');
export const DEFAULT_OUTPUT=path.join(here,'..','public','assets','agentdesk-noir-city.svg');
const n=value=>String(Number(value.toFixed(2)));
const hash=value=>createHash('sha256').update(value).digest('hex');
const attrs=points=>points.map(p=>p.map(n).join(' ')).join('L');
const pathSvg=(points,attribute='',closed=false)=>`<path d="M${attrs(points)}${closed?'Z':''}" ${attribute}/>`;
const rect=(x,y,w,h,attribute='')=>`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ${attribute}/>`;
const group=(id,items,attribute='')=>`<g id="${id}" ${attribute}>\n${items.join('\n')}\n</g>`;
const layer=(id,label,items)=>group(id,items,`inkscape:groupmode="layer" inkscape:label="${label}"`);
const range=(r,a,b)=>a+(b-a)*r();
const mix=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
function random(seed){let state=seed>>>0;return()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};}
const gradient=(id,stops,attribute='x1="0" y1="0" x2="1" y2="1"')=>`<linearGradient id="${id}" ${attribute}>${stops.map(([offset,color,opacity=1])=>`<stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`).join('')}</linearGradient>`;
const radial=(id,color,opacity)=>`<radialGradient id="${id}"><stop stop-color="${color}" stop-opacity="${opacity}"/><stop offset=".5" stop-color="${color}" stop-opacity="${opacity*.28}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
const pointsValid=(points,min=2)=>Array.isArray(points)&&points.length>=min&&points.length<80&&points.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>Number.isFinite(v)&&v>=-2000&&v<=4000));
function validate(c){
 if(c?.schemaVersion!==3||!Number.isSafeInteger(c.seed)||c.seed<=0||c.seed>0xffffffff)throw Error('Scene seed must be a positive 32-bit integer');
 const {canvas,palette,material,plates,fractures,bubbles,frost,surface,composition}=c;
 if(!canvas||!palette||!material||!Array.isArray(plates)||!Array.isArray(fractures)||!bubbles||!frost||!surface||!composition)throw Error('Missing editable ice material section');
 if(!Number.isInteger(canvas.width)||!Number.isInteger(canvas.height)||canvas.width<800||canvas.width>4096||canvas.height<500||canvas.height>2700)throw Error('Canvas dimensions out of bounds');
 for(const key of ['abyss','deep','body','glaze','cyan','frost','white'])if(!/^#[\da-fA-F]{6}$/.test(palette[key]||''))throw Error('Invalid or missing palette color '+key);
 for(const [obj,keys]of[[material,['rimLight','translucency','depth']],[frost,['intensity']],[bubbles,['intensity']],[surface,['scratchIntensity']],[composition,['quietCenter','vignette']]])for(const key of keys)if(!Number.isFinite(obj[key])||obj[key]<0||obj[key]>1)throw Error('Invalid intensity '+key);
 for(const [obj,keys]of[[bubbles,['count']],[frost,['crystalsPerFracture']],[surface,['scratches']]])for(const key of keys)if(!Number.isInteger(obj[key])||obj[key]<0||obj[key]>1500)throw Error('Invalid count '+key);
 if(!Number.isFinite(material.roughness)||material.roughness<0||material.roughness>12)throw Error('Invalid material roughness');
 if(plates.length>20||fractures.length>40||!Array.isArray(bubbles.clusters)||bubbles.clusters.length>30||!Array.isArray(frost.patches)||frost.patches.length>30)throw Error('Invalid ice geometry');
 const ids=new Set();
 for(const plate of plates){if(!/^[a-z][a-z0-9-]{0,40}$/.test(plate.id)||ids.has(plate.id)||!pointsValid(plate.outline,3)||!Number.isFinite(plate.light)||plate.light<0||plate.light>1||!Number.isFinite(plate.rotation)||Math.abs(plate.rotation)>180)throw Error('Invalid ice plate geometry');ids.add(plate.id);}
 for(const fracture of fractures)if(!pointsValid(fracture.points)||!Number.isFinite(fracture.strength)||fracture.strength<0||fracture.strength>1)throw Error('Invalid ice fracture');
 for(const cluster of bubbles.clusters)if(!['x','y','radius','spread'].every(k=>Number.isFinite(cluster[k]))||cluster.radius<.5||cluster.radius>40||cluster.spread<10||cluster.spread>500)throw Error('Invalid trapped bubble cluster');
 for(const patch of frost.patches)if(!['x','y','rx','ry','rotation','intensity'].every(k=>Number.isFinite(patch[k]))||patch.rx<5||patch.rx>600||patch.ry<5||patch.ry>400||patch.intensity<0||patch.intensity>1||Math.abs(patch.rotation)>180)throw Error('Invalid frost patch');
}
// A fixed seed produces hand-editable irregular vertices instead of clean polygons.
function rough(points,r,amount,closed=false,step=27){const out=[],count=closed?points.length:points.length-1;
 for(let i=0;i<count;i++){const a=points[i],b=points[(i+1)%points.length],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy),steps=Math.max(1,Math.ceil(len/step));
  out.push(a);for(let j=1;j<steps;j++){const t=j/steps,v=range(r,-amount,amount),at=mix(a,b,t);out.push([at[0]-dy/len*v,at[1]+dx/len*v]);}}
 if(!closed)out.push(points.at(-1));return out;
}
function definitions(c,shapes){const p=c.palette;return[
 '<defs>',
 gradient('deep-frozen-water',[[0,p.deep],[.38,p.abyss],[.65,p.body],[1,p.deep]]),
 gradient('ice-glaze',[[0,p.glaze,.9],[.16,p.body,.65],[.5,p.deep,.92],[.78,p.body,.77],[1,p.glaze,.85]]),
 gradient('clear-ice-glass',[[0,p.cyan,.04],[.16,p.frost,.2],[.32,p.body,.5],[.6,p.deep,.78],[.88,p.glaze,.75],[1,p.cyan,.22]]),
 gradient('refracted-rim',[[0,p.white,.75],[.23,p.cyan,.48],[.55,p.frost,.32],[1,p.cyan,.7]]),
 gradient('silvery-surface',[[0,p.white,0],[.44,p.frost,.018],[.49,p.frost,.065],[.53,p.white,.11],[.57,p.frost,.025],[1,p.white,0]],'x1="0" y1="1" x2="1" y2="0"'),
 radial('cold-interior',p.cyan,.24),radial('soft-frost',p.frost,.4),
 '<radialGradient id="reading-space"><stop offset="0" stop-color="'+p.abyss+'" stop-opacity="'+c.composition.quietCenter+'"/><stop offset=".46" stop-color="'+p.abyss+'" stop-opacity="'+n(c.composition.quietCenter*.65)+'"/><stop offset="1" stop-color="'+p.abyss+'" stop-opacity="0"/></radialGradient>',
 '<radialGradient id="edge-vignette"><stop offset=".2" stop-color="'+p.abyss+'" stop-opacity="0"/><stop offset="1" stop-color="'+p.abyss+'" stop-opacity="'+c.composition.vignette+'"/></radialGradient>',
 '<filter id="subsurface-softness" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="2.2"/></filter>',
 '<filter id="frost-haze" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8"/></filter>',
 '<filter id="ice-material-grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".009 .035" numOctaves="3" seed="'+c.seed+'" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 .67 0 0 0 0 .82 0 0 0 0 .84 1.7 0 0 0 -.78"/><feComposite in2="SourceGraphic" operator="in"/></filter>',
 ...c.plates.map((plate,i)=>[
  '<clipPath id="plate-clip-'+plate.id+'">'+pathSvg(shapes[i],'',true)+'</clipPath>',
  gradient('sheet-'+plate.id,[[0,p.glaze,plate.light],[.22,p.body,.85],[.5,p.deep,.98],[.74,p.body,.93],[1,p.glaze,plate.light*.75]],`x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${plate.rotation} .5 .5)"`)
 ].join('\n')),
 '</defs>'
].join('\n');}
function depths(c){const p=c.palette;return layer('01_dark_frozen_depths','01 / Deep black ice and subsurface light',[
 rect(0,0,1920,1200,'fill="url(#deep-frozen-water)"'),
 '<ellipse cx="1600" cy="300" rx="830" ry="540" fill="url(#cold-interior)" opacity="'+c.material.depth+'"/>',
 '<ellipse cx="70" cy="1000" rx="800" ry="600" fill="url(#cold-interior)" opacity="'+n(c.material.depth*.65)+'"/>',
 rect(0,0,1920,1200,'fill="url(#silvery-surface)" opacity=".45"')
 ]);}
function sheetLayer(c,r,shapes){const p=c.palette,items=[];
 c.plates.forEach((plate,i)=>{const points=shapes[i],detail=[
  pathSvg(points,'transform="translate(7 17)" fill="'+p.abyss+'" stroke="'+p.abyss+'" stroke-width="22" stroke-opacity=".7"',true),
  pathSvg(points,'fill="url(#sheet-'+plate.id+')" stroke="'+p.glaze+'" stroke-width="7" stroke-opacity="'+n(c.material.translucency*.3)+'" stroke-linejoin="round"',true),
  pathSvg(points,'transform="translate(4 7)" fill="none" stroke="'+p.frost+'" stroke-width="4.5" stroke-opacity="'+n(c.material.rimLight*.22)+'"',true),
  pathSvg(points,'fill="none" stroke="url(#refracted-rim)" stroke-width="1.4" stroke-dasharray="33 3 17 7 96 2 41 6" stroke-opacity="'+n(c.material.rimLight*plate.light*.75)+'"',true),
  rect(-200,-200,2320,1600,'fill="url(#silvery-surface)" clip-path="url(#plate-clip-'+plate.id+')" opacity="'+c.material.translucency+'"')
 ];
 // Dim overlapping glass laminae give each plate depth beneath its surface.
 const lamina=[];
 for(let j=0;j<7;j++){const y=range(r,-200,1400),lean=range(r,-220,220);lamina.push(pathSvg([[-200,y],[750,y+lean],[2120,y+lean*.6],[2120,y+lean*.6+range(r,4,25)],[750,y+lean+12],[-200,y+8]],'fill="'+p.glaze+'" opacity="'+n(range(r,.035,.09)*c.material.translucency)+'"',true));}
 detail.push(group('laminae-'+plate.id,lamina,'clip-path="url(#plate-clip-'+plate.id+')"'));
 // Fine pale frozen striations at chipped sheet edges, never wireframe outlines.
 const rim=[pathSvg(points.slice(1,Math.ceil(points.length*.55)),'fill="none" stroke="'+p.frost+'" stroke-width="16" stroke-opacity="'+n(c.material.rimLight*.11)+'" filter="url(#frost-haze)"')];
 for(let j=0;j<points.length;j+=2){const a=points[j],b=points[(j+1)%points.length],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy)||1;
  for(let k=0;k<2;k++){const at=mix(a,b,range(r,.15,.8)),size=range(r,3,18),sign=r()>.5?1:-1;rim.push(pathSvg([[at[0]-dy/len*size*sign,at[1]+dx/len*size*sign],at,[at[0]+dx/len*range(r,1,7),at[1]+dy/len*range(r,1,7)]],'fill="none" stroke="'+p.frost+'" stroke-width="'+n(range(r,.3,.9))+'" stroke-opacity="'+n(range(r,.14,.42)*c.material.rimLight)+'"'));}
 }
 detail.push(group('chipped-rim-'+plate.id,rim));items.push(group('ice-sheet-'+plate.id,detail));
 });
 return layer('02_overlapping_translucent_sheets','02 / Overlapping frozen sheets, glazed faces and chipped rims',items);
}
function fractureLayer(c,r){const p=c.palette,items=[];
 c.fractures.forEach((fracture,index)=>{const points=rough(fracture.points,r,c.material.roughness*.7,false,18),a=fracture.strength,parts=[
  pathSvg(points,'fill="none" stroke="'+p.cyan+'" stroke-width="17" stroke-opacity="'+n(a*.12)+'" filter="url(#subsurface-softness)"'),
  pathSvg(points,'transform="translate(2.4 4.2)" fill="none" stroke="'+p.frost+'" stroke-width="2.5" stroke-opacity="'+n(a*.4)+'"'),
  pathSvg(points,'fill="none" stroke="'+p.abyss+'" stroke-width="5" stroke-opacity=".9"'),
  pathSvg(points,'fill="none" stroke="'+p.frost+'" stroke-width="1.1" stroke-opacity="'+n(a*.92)+'"')
 ];
 const feathers=[],frostBands=[[],[],[]];
 for(let j=0;j<c.frost.crystalsPerFracture;j++){
  const segment=Math.floor(range(r,0,points.length-1)),aPoint=points[segment],bPoint=points[segment+1],at=mix(aPoint,bPoint,r()),angle=Math.atan2(bPoint[1]-aPoint[1],bPoint[0]-aPoint[0])+(r()>.5?1:-1)*range(r,.6,1.5),len=range(r,5,38)*a,tip=[at[0]+Math.cos(angle)*len,at[1]+Math.sin(angle)*len];
  const lines=[`M${attrs([at,tip])}`];
  for(let k=1;k<=3;k++){const branch=mix(at,tip,k/4),branchLen=len*(1-k/5)*.4;for(const sign of[-1,1]){const theta=angle+sign*.65;lines.push(`M${attrs([branch,[branch[0]-Math.cos(theta)*branchLen,branch[1]-Math.sin(theta)*branchLen]])}`);}}
  frostBands[j%3].push(lines.join(''));
 }
 frostBands.forEach((bands,j)=>feathers.push(`<path d="${bands.join('')}" fill="none" stroke="${p.frost}" stroke-width="${[.75,1.1,1.6][j]}" stroke-opacity="${n(a*[.28,.45,.7][j]*c.frost.intensity)}"/>`));
 parts.push(group('feathered-frost-'+index,feathers));items.push(group('branching-fracture-'+index,parts));
 });
 return layer('04_branching_subsurface_fractures','04 / Branching subsurface cracks and feathered frost',items);
}
function bubbleLayer(c,r){const p=c.palette,items=[];
 c.bubbles.clusters.forEach((cluster,j)=>{const groupItems=[];
  for(let i=0;i<c.bubbles.count;i++){const angle=range(r,0,Math.PI*2),distance=Math.pow(r(),.7)*cluster.spread,x=cluster.x+Math.cos(angle)*distance,y=cluster.y+Math.sin(angle)*distance*.66,rad=(i<4?range(r,cluster.radius*.65,cluster.radius):range(r,.3,cluster.radius)*(1-distance/cluster.spread*.6)),ry=rad*range(r,.45,.9),opacity=range(r,.25,.78)*c.bubbles.intensity;
   groupItems.push(`<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rad)}" ry="${n(ry)}" fill="${p.deep}" fill-opacity=".38" stroke="${p.frost}" stroke-width="${n(range(r,.45,.85))}" stroke-opacity="${n(opacity)}"/>`);
  if(rad>2.5){groupItems.push(`<path d="M${n(x-rad*.7)} ${n(y-ry*.28)}Q${n(x-rad*.2)} ${n(y-ry*1.08)} ${n(x+rad*.45)} ${n(y-ry*.5)}" fill="none" stroke="${p.white}" stroke-width=".85" stroke-opacity="${n(opacity)}"/>`);groupItems.push(`<ellipse cx="${n(x+rad*.15)}" cy="${n(y+ry*.38)}" rx="${n(rad*.57)}" ry="${n(ry*.3)}" fill="${p.cyan}" opacity="${n(opacity*.1)}"/>`);}
  }
  items.push(group('trapped-air-cluster-'+j,groupItems));
 });
 return layer('05_trapped_air_bubbles','05 / Trapped air bubbles inside the ice',items);
}
function textureLayer(c,r){const p=c.palette,items=[];
 // Surface scores are short, clustered hairlines at one dominant skating angle.
 const scratch=[];for(let i=0;i<c.surface.scratches;i++){const x=range(r,-100,2000),y=range(r,-100,1300),len=range(r,4,95),xx=x+len,yy=y-len*.34;
  scratch.push(pathSvg([[x,y],[x+len*.45,y-len*.18],[xx,yy]],'fill="none" stroke="'+p.frost+'" stroke-width="'+n(range(r,.23,.55))+'" stroke-opacity="'+n(range(r,.02,.1)*c.surface.scratchIntensity)+'"'));
 }
 items.push(group('frozen-surface-scores',scratch));
 // Frost inclusions occur as irregular compact granular islands within the ice.
 for(const [j,cluster]of c.bubbles.clusters.entries()){if(j%2)continue;const grains=[];
  for(let k=0;k<90;k++){const theta=range(r,0,Math.PI*2),d=Math.pow(r(),1.5)*cluster.spread*.5,x=cluster.x+Math.cos(theta)*d,y=cluster.y+Math.sin(theta)*d*.38,size=range(r,.3,2.8);
   grains.push(pathSvg([[x,y],[x+size,y-size*.2],[x+size*.3,y+size*.7]],'fill="'+p.frost+'" opacity="'+n(range(r,.035,.24)*c.frost.intensity)+'"',true));}
  items.push(group('granular-frost-inclusion-'+j,grains));
 }
 return layer('06_frost_inclusions_and_surface_scores','06 / Granular frost inclusions and frozen surface striations',items);
}
export function renderNoirCity(config){validate(config);const r=random(config.seed),w=config.canvas.width,h=config.canvas.height,shapes=config.plates.map(plate=>rough(plate.outline,r,config.material.roughness,true,23));
 const cloudyFrost=config.frost.patches.flatMap((patch,i)=>[
 `<ellipse id="frost-bloom-${i}" cx="${patch.x}" cy="${patch.y}" rx="${patch.rx}" ry="${patch.ry}" transform="rotate(${patch.rotation} ${patch.x} ${patch.y})" fill="url(#soft-frost)" opacity="${n(patch.intensity*config.frost.intensity)}"/>`,
 `<ellipse cx="${patch.x}" cy="${patch.y}" rx="${patch.rx}" ry="${patch.ry}" transform="rotate(${patch.rotation} ${patch.x} ${patch.y})" fill="url(#soft-frost)" filter="url(#ice-material-grain)" opacity="${n(patch.intensity*.7*config.frost.intensity)}"/>`
 ]);
 const content=[depths(config),sheetLayer(config,r,shapes),layer('03_cloudy_frost_blooms','03 / Cloudy edge frost and native frozen grain',[
 rect(0,0,1920,1200,'fill="white" opacity=".035" filter="url(#ice-material-grain)"'),...cloudyFrost
 ]),fractureLayer(config,r),bubbleLayer(config,r),textureLayer(config,r),layer('07_reading_space_and_edge_falloff','07 / Subtle reading space and edge falloff',[
 '<ellipse cx="910" cy="560" rx="730" ry="530" fill="url(#reading-space)"/>',rect(0,0,1920,1200,'fill="url(#edge-vignette)"')
 ])];
 return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="BLACKICE: close view of fractured black ice with trapped bubbles and frost">\n<title>BLACKICE / Frozen state</title>\n<desc>An original macro view of real ice material: overlapping translucent frozen sheets, rough pale refracted rims, branching subsurface cracks, trapped air bubbles, granular frost and fine surface scores. All editable native SVG geometry. No bitmap or tracing.</desc>\n<metadata>BLACKICE / Frozen state; scene seed ${config.seed}; config SHA256 ${hash(JSON.stringify(config))}; generated deterministically with scripts/generate-noir-background.mjs; no external assets.</metadata>\n${definitions(config,shapes)}\n<g transform="scale(${w/1920} ${h/1200})">\n${content.join('\n')}\n</g>\n</svg>\n`;
}
export async function sceneFromConfig(file=DEFAULT_CONFIG){return renderNoirCity(JSON.parse(await readFile(file,'utf8')));}
export async function writeScene({config=DEFAULT_CONFIG,output=DEFAULT_OUTPUT,check=false}={}){const svg=await sceneFromConfig(config);if(check){if(await readFile(output,'utf8')!==svg)throw Error('Generated ice SVG differs from the checked-in output. Run npm run scene:build and review the diff.');}else await writeFile(output,svg,'utf8');return{path:output,bytes:Buffer.byteLength(svg),sha256:hash(svg),check};}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const args=process.argv.slice(2);let config=DEFAULT_CONFIG,output=DEFAULT_OUTPUT,check=false;for(let i=0;i<args.length;i++){if(args[i]==='--check')check=true;else if(args[i]==='--config'&&args[i+1])config=path.resolve(args[++i]);else if(args[i]==='--output'&&args[i+1])output=path.resolve(args[++i]);else throw Error('Usage: node scripts/generate-noir-background.mjs [--check] [--config scene.json] [--output scene.svg]');}console.log(JSON.stringify(await writeScene({config,output,check})));}
