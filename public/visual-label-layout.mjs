// Versioned relationship label layout. Geometry is shared by placement and SVG rendering.
// textLength + spacingAndGlyphs fixes each row's rendered advance independently of OS font fallback.
const fail=message=>{throw Object.assign(Error(message),{code:'VISUAL_INVALID',status:400});};
export const LABEL_METRICS=Object.freeze({fontSize:14,fontFamily:'sans-serif',lineHeight:24,padding:8,baseline:19});
const marks=/\p{Mark}|[\u200d\ufe0e\ufe0f]/u;
const clusters=text=>{const parts=[];for(const ch of text){if(parts.length&&(marks.test(ch)||parts.at(-1).endsWith('\u200d')))parts[parts.length-1]+=ch;else parts.push(ch);}return parts;};
const advance=cluster=>{const ch=[...cluster].find(c=>!marks.test(c));return !ch?0:ch===' '?4:/[ilI.,'!|:;]/.test(ch)?4:/[MW@]/.test(ch)?12:ch.codePointAt(0)>127?14:8;};
export function relationshipTextBox(text,maxWidth){
 const {padding,lineHeight}=LABEL_METRICS,limit=maxWidth-padding*2,rows=[];
 if(limit<14)fail('Not enough width for a relationship label.');
 for(const line of text.split('\n')){
  let row='',width=0;
  for(const ch of clusters(line)){const size=advance(ch);if(row&&width+size>limit){rows.push({text:row,width});row='';width=0;}row+=ch;width+=size;}
  rows.push({text:row,width});
 }
 return {rows,width:Math.max(1,...rows.map(r=>r.width))+padding*2,height:rows.length*lineHeight+padding*2};
}
export const boxesOverlap=(a,b,gap=4)=>a.x<b.x+b.width+gap&&a.x+a.width+gap>b.x&&a.y<b.y+b.height+gap&&a.y+a.height+gap>b.y;
export function layoutRelationshipLabels({width,height,labels,obstacles=[]}){
 const placements=[],occupied=obstacles.map(o=>({...o})),deferred=[];
 for(const label of labels){
  const box=relationshipTextBox(label.text,Math.min(256,width-16));
  const mx=label.x,my=label.y;
  // Bounded deterministic candidates; no semantic interpretation or movement of pinned content.
  const candidates=[[mx-box.width/2,my-box.height-8],[mx-box.width/2,my+8],[mx+8,my-box.height/2],[mx-box.width-8,my-box.height/2]];
  for(const dy of [-64,64,-128,128])candidates.push([mx-box.width/2,my+dy-box.height/2]);
  const chosen=candidates.map(([x,y])=>({...box,x,y})).find(b=>b.x>=8&&b.y>=8&&b.x+b.width<=width-8&&b.y+b.height<=height-8&&!occupied.some(o=>boxesOverlap(b,o)));
  if(chosen){const p={...chosen,id:label.id,kind:'inline'};placements.push(p);occupied.push(p);}else deferred.push(label);
 }
 let outputHeight=height;
 if(deferred.length){
  let y=height+16;
  for(const label of deferred){
   const box=relationshipTextBox(label.legend,width-16);
   const p={...box,x:8,y,id:label.id,kind:'legend'};placements.push(p);y+=box.height+8;
  }
  outputHeight=y+8;
  if(outputHeight>2000)fail('Relationship labels need more space than the bounded canvas. Split the visual; no text was omitted.');
 }
 return {placements,height:outputHeight,legend:deferred.length>0};
}
