import {layoutRelationshipLabels,LABEL_METRICS} from './visual-label-layout.mjs';
import {safeSvgPreview} from './svg-preview.mjs';
import {layoutVisual,noteTextLayout,wrapVisualText} from './visual-layout.mjs';

const fail=message=>{throw Object.assign(new Error(message),{status:400,code:'VISUAL_INVALID'});};
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const label=(value,max=180)=>typeof value==='string'&&value.trim()&&value.length<=max?value:fail(`Use nonempty text of at most ${max} characters.`);
const wrap=wrapVisualText;
const array=(value,max)=>Array.isArray(value)&&value.length<=max?value:fail(`Use an array of at most ${max} entries.`);
const number=(v,max=2000)=>Number.isFinite(v)&&v>=0&&v<=max?v:fail('Coordinates must be finite and within the canvas.');
const keys=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('Unsupported visual document fields.');};

/** Static image profile: no references, resource expansion, filters, CSS or executable DOM. */
export function visualSvgUrl(svg){
 if(typeof svg!=='string'||svg.length>32768||/<\/?(?:use|symbol|pattern|filter|fe\w+|mask|clipPath|image|style|foreignObject)\b/i.test(svg)||/\b(?:href|src|style)\s*=|url\s*\(/i.test(svg))return null;
 if((svg.match(/</g)||[]).length>400)return null;
 // Bound numeric geometry too: a tiny XML document can request enormous raster work.
 for(const attribute of svg.matchAll(/\b(?:width|height|viewBox|d|points|transform|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|stroke-width|font-size)\s*=\s*(["'])(.*?)\1/gs)){
  if(/&|Infinity|NaN/i.test(attribute[2]))return null;
  const numbers=attribute[2].match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)||[];
  if(numbers.length>1200||numbers.some(n=>!Number.isFinite(Number(n))||Math.abs(Number(n))>10000))return null;
 }
 return safeSvgPreview(svg);
}

function compileLegacyVisual(input,regionObstacles=[]){
 keys(input,['version','title','summary','kind','width','height','items','links','groups','grid','notes','svg']);
 if(input.version!==1)fail('Use visual document version 1.');
 const document=structuredClone(input),title=label(input.title,120),summary=label(input.summary,4000);
 if(input.kind==='custom'){
  if(Object.keys(input).some(k=>!['version','title','summary','kind','svg'].includes(k)))fail('Custom SVG cannot contain semantic primitives.');
  if(!visualSvgUrl(input.svg))fail('SVG is not a bounded static image. Remove references, scripts, filters, CSS and external content.');
  return {document,svg:input.svg,text:`${title}\n${summary}`};
 }
 if(input.kind!=='composed')fail('Choose composed or custom.');
 if(input.svg!==undefined)fail('Composed documents cannot contain custom SVG.');
 const width=number(input.width??1000),height=number(input.height??650);
 if(width<200||height<150)fail('Canvas is too small.');
 const items=array(input.items??[],40),links=array(input.links??[],60),groups=array(input.groups??[],12),notes=array(input.notes??[],20),ids=new Set();
 let shapes='',text=[title,summary];const relationshipLabels=[],obstacles=[...regionObstacles];
 const lines=(value,x,y,maxChars=28)=>wrap(value,maxChars).map((s,i)=>`<text x="${x}" y="${y+i*18}" font-size="14" font-family="Arial, sans-serif" fill="#20343b">${esc(s)}</text>`).join('');
 for(const g of groups){keys(g,['label','x','y','width','height']);label(g.label);const x=number(g.x),y=number(g.y),w=number(g.width),h=number(g.height);if(x+w>width||y+h>height)fail('Group exceeds canvas.');shapes+=`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#f4f6f8" stroke="#bdcbd1"/>`+lines(g.label,x+10,y+20);text.push(`Group: ${g.label}`);}
 for(const item of items){keys(item,['id','label','x','y','width','height','status']);if(!/^[a-zA-Z][\w-]{0,39}$/.test(item.id)||ids.has(item.id))fail('Item IDs must be unique simple names.');ids.add(item.id);label(item.label);if(item.status!==undefined)label(item.status,50);number(item.x);number(item.y);number(item.width??210);number(item.height??100);if((item.width??210)<80||(item.height??100)<50)fail('Items need at least 80 by 50 units.');if(wrap(item.label,Math.max(8,Math.floor(((item.width??210)-20)/8))).length*18+20+(item.status?wrap(item.status,Math.max(8,Math.floor(((item.width??210)-20)/8))).length*18+4:0)>(item.height??100))fail('Item label does not fit. Enlarge the item or shorten the label.');if(item.x+(item.width??210)>width||item.y+(item.height??100)>height)fail('Item exceeds canvas.');}
 for(const link of links){keys(link,['from','to','label','uncertain']);if(!ids.has(link.from)||!ids.has(link.to))fail('Every connection needs existing endpoints.');label(link.label,100);if(link.uncertain!==undefined&&typeof link.uncertain!=='boolean')fail('uncertain must be boolean.');const a=items.find(i=>i.id===link.from),b=items.find(i=>i.id===link.to),x=a.x+(a.width??210)/2,y=a.y+(a.height??100)/2,u=b.x+(b.width??210)/2,v=b.y+(b.height??100)/2;
  const dx=u-x,dy=v-y,length=Math.hypot(dx,dy);if(length<1)fail('Connected items need different positions.');
  const border=(w,h)=>Math.min(dx? w/2/Math.abs(dx):Infinity,dy?h/2/Math.abs(dy):Infinity);
  const start=border(a.width??210,a.height??100),end=border(b.width??210,b.height??100),sx=x+dx*start,sy=y+dy*start,ex=u-dx*end,ey=v-dy*end,nx=dx/length,ny=dy/length;
  for(let segment=0;segment<16;segment++){const ax=sx+(ex-sx)*segment/16,ay=sy+(ey-sy)*segment/16,bx=sx+(ex-sx)*(segment+1)/16,by=sy+(ey-sy)*(segment+1)/16;obstacles.push({x:Math.min(ax,bx)-3,y:Math.min(ay,by)-3,width:Math.abs(bx-ax)+6,height:Math.abs(by-ay)+6});}
  const linkText=`${link.label}${link.uncertain?' (uncertain)':''}`;
  const edgeKey='R'+(relationshipLabels.length+1);
  relationshipLabels.push({id:relationshipLabels.length,key:edgeKey,text:linkText,legend:edgeKey+': '+a.label+' ['+a.id+'] → '+b.label+' ['+b.id+']: '+linkText,fallbackLegend:edgeKey+': '+a.label+' ['+a.id+' @ '+a.x+','+a.y+'] → '+b.label+' ['+b.id+' @ '+b.x+','+b.y+']: '+linkText+' (No inline marker fits; endpoints identified by positions.)',x:(sx+ex)/2,y:(sy+ey)/2});
  shapes+=`<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="#527f80" stroke-width="2"${link.uncertain?' stroke-dasharray="6 4"':''}/><polygon points="${ex},${ey} ${ex-10*nx+4*ny},${ey-10*ny-4*nx} ${ex-10*nx-4*ny},${ey-10*ny+4*nx}" fill="#527f80"/>`;text.push(`${link.from} → ${link.to}: ${link.label}${link.uncertain?' (uncertain)':''}`);
 }
 for(const item of items){const w=item.width??210,h=item.height??100;shapes+=`<rect x="${item.x}" y="${item.y}" width="${w}" height="${h}" rx="3" fill="#edf5f4" stroke="#70918f"/>`+lines(item.label,item.x+10,item.y+24,Math.max(8,Math.floor((w-20)/8)))+(item.status?lines(item.status,item.x+10,item.y+h-10-(wrap(item.status,Math.max(8,Math.floor((w-20)/8))).length-1)*18,Math.max(8,Math.floor((w-20)/8))):'');text.push(`${item.id}: ${item.label}${item.status?` [${item.status}]`:''}`);}
 if(input.grid){const g=input.grid;keys(g,['x','y','columns','rows']);const cols=array(g.columns,6).map(c=>label(c,60)),rows=array(g.rows,12);if(!cols.length)fail('Grid needs columns.');const x=number(g.x??20),y=number(g.y??20),cw=(width-x-20)/cols.length;if(cw<80)fail('Grid columns are too narrow or outside canvas.');const all=[cols,...rows.map(r=>{array(r,cols.length);if(r.length!==cols.length)fail('Grid rows must match columns.');return r.map(c=>label(c,100));})];let cy=y;for(const row of all){const rh=Math.max(48,...row.map(c=>wrap(c,Math.max(8,Math.floor((cw-16)/8))).length*18+20));if(cy+rh>height)fail('Grid exceeds canvas.');row.forEach((cell,i)=>{shapes+=`<rect x="${x+i*cw}" y="${cy}" width="${cw}" height="${rh}" fill="${cy===y?'#dce9eb':'#f7f9fa'}" stroke="#c1cdd1"/>`+lines(cell,x+i*cw+8,cy+22,Math.max(8,Math.floor((cw-16)/8)));});cy+=rh;text.push(row.join(' | '));}obstacles.push({x,y,width:width-x-20,height:cy-y});}
 for(const note of notes){keys(note,['text','x','y']);label(note.text,300);const {x,y,chars,bottom}=noteTextLayout(note,width);if(bottom>height)fail('Note exceeds canvas.');shapes+=lines(note.text,x,y,chars);text.push(`Note: ${note.text}`);obstacles.push({x,y:y-14,width:Math.max(...wrap(note.text,chars).map(r=>[...r].length))*14,height:bottom-y+14});}
 const labelLayout=layoutRelationshipLabels({width,height,labels:relationshipLabels,obstacles:[...obstacles,...items.map(i=>({x:i.x,y:i.y,width:i.width??210,height:i.height??100})),...groups]});
 for(const p of labelLayout.placements){shapes+=`<g><rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" fill="white" stroke="#c1cdd1"/>`+p.rows.map((r,i)=>`<text x="${p.x+LABEL_METRICS.padding}" y="${p.y+LABEL_METRICS.baseline+i*LABEL_METRICS.lineHeight}" font-size="14" font-family="sans-serif" xml:space="preserve" textLength="${Math.max(1,r.width)}" lengthAdjust="spacingAndGlyphs" fill="#172033">${esc(r.text)}</text>`).join('')+'</g>';}
 const outputHeight=labelLayout.height;
 const titleRows=wrap(title,Math.max(12,Math.floor((width-32)/9))),headerHeight=titleRows.length*22+24;
 const heading=titleRows.map((row,i)=>`<text x="16" y="${-headerHeight+24+i*22}" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="#713d38">${esc(row)}</text>`).join('');
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${outputHeight+headerHeight}" viewBox="0 ${-headerHeight} ${width} ${outputHeight+headerHeight}"><title>${esc(title)}</title><desc>${esc(summary)}</desc><rect y="${-headerHeight}" width="${width}" height="${outputHeight+headerHeight}" fill="white"/><rect y="${-headerHeight}" width="${width}" height="${headerHeight-8}" fill="#eef1f4"/>${heading}${shapes}</svg>`;
 if(!visualSvgUrl(svg))fail('Visual is too complex. Split it into smaller artifacts.');
 return {document,svg,text:text.join('\n')};
}

export const VISUAL_EXAMPLE={version:1,kind:'composed',title:'What would distinguish these explanations?',summary:'Two explanations share one observation. Seek evidence that separates them.',width:1000,height:500,items:[{id:'observed',label:'Failure after deployment',x:380,y:30},{id:'change',label:'Code regression',x:80,y:300,status:'Hypothesis'},{id:'load',label:'Load increase',x:680,y:300,status:'Hypothesis'}],links:[{from:'change',to:'observed',label:'could explain',uncertain:true},{from:'load',to:'observed',label:'could explain',uncertain:true}],notes:[{text:'Missing: failure rate on the old version under equal load.',x:220,y:470}]};

export const VISUAL_COMPOSITION_EXAMPLE={version:2,kind:'composed',title:VISUAL_EXAMPLE.title,summary:VISUAL_EXAMPLE.summary,items:VISUAL_EXAMPLE.items.map(({id,label,status})=>({id,label,...(status?{status}:{})})),links:VISUAL_EXAMPLE.links,notes:[{text:VISUAL_EXAMPLE.notes[0].text}]};

export function compileVisual(input){
 if(input?.version!==2)return compileLegacyVisual(input);
 if(input.kind==='custom')return {...compileLegacyVisual({...input,version:1}),document:structuredClone(input)};
 if(input.kind!=='composed')fail('Choose composed or custom.');
 const {document,rendered,regions}=layoutVisual(input),compiled=compileLegacyVisual(rendered,regions);
 let svg=compiled.svg,text=compiled.text;
 for(const region of regions){
  label(region.label,120);label(region.summary,1000);if(!visualSvgUrl(region.svg))fail('Custom region must be a bounded static SVG.');
  // Already validated XML; match the root respecting quoted attribute values.
  const root=region.svg.match(/<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/);if(!root)fail('Custom region needs an SVG root.');
  const attr=name=>root[0].match(new RegExp('\\b'+name+'\\s*=\\s*(["\x27])(.*?)\\1'))?.[2];
  const viewBox=attr('viewBox')||`0 0 ${Number.parseFloat(attr('width'))||region.width} ${Number.parseFloat(attr('height'))||region.height}`;
  if(!/^\s*[-+\d.eE]+(?:[\s,]+[-+\d.eE]+){3}\s*$/.test(viewBox)||viewBox.trim().split(/[\s,]+/).some((n,i)=>!Number.isFinite(Number(n))||(i>1&&Number(n)<=0)))fail('Custom region needs a finite positive viewBox.');
  const nested=region.svg.replace(root[0],`<svg xmlns="http://www.w3.org/2000/svg" x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" viewBox="${esc(viewBox)}">`);
  const end=svg.lastIndexOf('</svg>');svg=svg.slice(0,end)+nested+svg.slice(end);text+=`\nCustom region ${region.id}: ${region.label}\n${region.summary}`;
 }
 for(const group of document.groups||[])if(group.members)text+=`\nGroup ${group.id} contains: ${group.members.join(', ')}`;
 if(!visualSvgUrl(svg))fail('Combined SVG is too complex. Split it into smaller artifacts.');
 return {document,svg,text};
}
