const fail=message=>{throw Object.assign(Error(message),{status:400,code:'VISUAL_INVALID'});};
const size=(value,fallback,min=0)=>{const n=value??fallback;if(!Number.isFinite(n)||n<min||n>2000)fail('Use bounded layout dimensions.');return n;};
const collections=['items','links','groups','notes','regions'];
const allowed={items:['id','label','status','x','y','width','height'],links:['id','from','to','label','uncertain'],groups:['id','label','members','x','y','width','height'],notes:['id','text','x','y'],regions:['id','label','summary','svg','x','y','width','height']};
const overlaps=(a,b)=>a.x<b.x+b.width+24&&a.x+a.width+24>b.x&&a.y<b.y+b.height+24&&a.y+a.height+24>b.y;
const lineCount=(text,chars)=>String(text??'').split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(Array.from(line).length/chars)),0);

/** Coordinates describe presentation only. Topology never implies chronology or causality. */
export function layoutVisual(input){
 const document=structuredClone(input);
 if(Object.keys(document).some(k=>!['version','kind','title','summary','width','height','layout','grid',...collections].includes(k)))fail('Unsupported visual document fields.');
 if(document.layout&&(!Number.isInteger(document.layout.columns)||document.layout.columns<1||document.layout.columns>6||Object.keys(document.layout).some(k=>k!=='columns')))fail('Layout accepts columns from 1 to 6.');
 const width=size(document.width,1000,200),columns=document.layout?.columns??Math.max(1,Math.floor((width-40)/280)),cell=(width-40)/columns;
 const limits={items:40,links:60,groups:12,notes:20,regions:8};
 for(const collection of collections){
  if(document[collection]===undefined)continue;
  if(!Array.isArray(document[collection])||document[collection].length>limits[collection])fail('Too many visual objects.');
  const used=new Set();for(const object of document[collection]){
   if(!object||typeof object!=='object'||Array.isArray(object)||Object.keys(object).some(k=>!allowed[collection].includes(k)))fail('Unsupported '+collection+' fields.');
   if(object.id!==undefined){if(!/^[A-Za-z][\w-]{0,39}$/.test(object.id)||used.has(object.id))fail('Object IDs must be unique within each collection.');used.add(object.id);}
  }
  let sequence=1;for(const object of document[collection])if(!object.id){while(used.has(`${collection}-${sequence}`))sequence++;object.id=`${collection}-${sequence++}`;used.add(object.id);}
 }
 const rendered={...structuredClone(document),version:1,width};delete rendered.layout;delete rendered.regions;
 const occupied=[];
 for(const item of rendered.items||[]){
  item.width=size(item.width,Math.min(240,cell-32),80);const chars=Math.max(8,Math.floor((item.width-20)/8));item.height=size(item.height,Math.max(100,lineCount(item.label,chars)*18+28+(item.status?lineCount(item.status,chars)*18+4:0)),50);
  if((item.x===undefined)!==(item.y===undefined))fail('Set both coordinates or omit both.');
  if(item.x!==undefined){item.x=size(item.x,0);item.y=size(item.y,0);occupied.push(item);}
 }
 // A neutral ring keeps small relationship graphs from routing through a middle
 // object. This is a layout convenience, not an analytical diagram category.
 const items=rendered.items||[];
 if(!occupied.length&&!document.layout&&rendered.links?.length&&items.length>1&&items.length<=6&&width>=700){
  const maxWidth=Math.max(...items.map(i=>i.width)),maxHeight=Math.max(...items.map(i=>i.height)),rx=(width-maxWidth-40)/2,ry=items.length>4?320:220,cy=40+maxHeight/2+ry;
  items.forEach((item,index)=>{const angle=-Math.PI/2+index*Math.PI*2/items.length;item.x=Math.round(width/2+Math.cos(angle)*rx-item.width/2);item.y=Math.round(cy+Math.sin(angle)*ry-item.height/2);occupied.push(item);});
 }
 for(const item of rendered.items||[])if(item.x===undefined){
  let placed=false;for(let y=40;y+item.height<=1960&&!placed;y+=40)for(let col=0;col<columns;col++){
   const candidate={...item,x:20+col*cell,y};if(candidate.x+candidate.width>width-20||occupied.some(other=>overlaps(candidate,other)))continue;Object.assign(item,candidate);occupied.push(item);placed=true;break;
  }if(!placed)fail('Automatic layout is full. Use fewer objects or a wider canvas.');
 }
 for(const link of rendered.links||[])delete link.id;
 for(const group of rendered.groups||[]){
  delete group.id;
  if(group.members!==undefined){
   if(!Array.isArray(group.members)||!group.members.length||new Set(group.members).size!==group.members.length)fail('Groups need unique member IDs.');
   const members=group.members.map(id=>(rendered.items||[]).find(i=>i.id===id));if(members.some(i=>!i))fail('Group member not found.');
   group.x=Math.max(0,Math.min(...members.map(i=>i.x))-12);group.y=Math.max(0,Math.min(...members.map(i=>i.y))-30);group.width=Math.max(...members.map(i=>i.x+i.width))+12-group.x;group.height=Math.max(...members.map(i=>i.y+i.height))+12-group.y;delete group.members;
   if((rendered.items||[]).some(item=>!members.includes(item)&&item.x+item.width/2>group.x&&item.x+item.width/2<group.x+group.width&&item.y+item.height/2>group.y&&item.y+item.height/2<group.y+group.height))fail('Group enclosure includes an unrelated item. Reorder or position its members together.');
  }
 }
 let bottom=Math.max(20,...occupied.map(i=>i.y+i.height),...(rendered.groups||[]).map(g=>(g.y??0)+(g.height??0)));
 if(rendered.grid){rendered.grid.y??=bottom+40;const grid=rendered.grid;if(!Array.isArray(grid.columns)||!grid.columns.length||!Array.isArray(grid.rows)||grid.rows.some(row=>!Array.isArray(row)||row.length!==grid.columns.length))fail('Grid needs matching columns and rows.');const cw=(width-(grid.x??20)-20)/grid.columns.length;if(cw<80)fail('Grid columns are too narrow.');bottom=grid.y+[grid.columns,...grid.rows].reduce((n,row)=>n+Math.max(48,...row.map(c=>lineCount(c,Math.max(8,Math.floor((cw-16)/8)))*18+20)),0);}
 for(const note of rendered.notes||[]){delete note.id;if((note.x===undefined)!==(note.y===undefined))fail('Set both note coordinates or omit both.');note.x??=20;note.y??=bottom+40;bottom=Math.max(bottom,note.y+lineCount(note.text,60)*18);}
 const regions=structuredClone(document.regions||[]);for(const region of regions){region.width=size(region.width,width-40,80);region.height=size(region.height,200,50);if((region.x===undefined)!==(region.y===undefined))fail('Set both region coordinates or omit both.');region.x=size(region.x,20);region.y=size(region.y,bottom+40);if(region.x+region.width>width)fail('Custom region exceeds canvas.');bottom=Math.max(bottom,region.y+region.height);}
 rendered.height=size(document.height,Math.max(150,bottom+30),150);if(bottom>rendered.height)fail('Content exceeds canvas. Increase height or split the visual.');
 return {document,rendered,regions};
}
