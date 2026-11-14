// Only direct, local gradient paint servers. No inheritance, filters or resources.
const gradientNames=new Set(['linearGradient','radialGradient']);
const idPattern=/^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const scalar=value=>/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?%?$/i.test(value)&&Number.isFinite(Number(value.replace(/%$/,'')))&&Math.abs(Number(value.replace(/%$/,'')))<=10000;
export function visualPaintValidation(){
 const ids=new Map(),gradients=new Map(),references=new Set();let totalStops=0;
 return {
  element(name,attributes,parents){
   const id=attributes.get('id');if(id)ids.set(id,(ids.get(id)||0)+1);
   for(const [key,value] of attributes){
    if(!/url\s*\(/i.test(value))continue;
    const match=/^url\(#([A-Za-z_][A-Za-z0-9_.:-]*)\)$/.exec(value);
    if(!['fill','stroke'].includes(key)||!match||gradientNames.has(name)||name==='stop')return false;
    references.add(match[1]);
   }
   if(gradientNames.has(name)){
    if(parents.at(-1)!=='defs'||!id||!idPattern.test(id)||gradients.has(id)||gradients.size>=16)return false;
    const coordinates=name==='linearGradient'?['x1','y1','x2','y2']:['cx','cy','r','fx','fy','fr'];
    const allowed=new Set(['id','gradientUnits','spreadMethod',...coordinates]);
    for(const [key,value] of attributes){
     if(!allowed.has(key))return false;
     if(coordinates.includes(key)&&(!scalar(value)||['r','fr'].includes(key)&&Number(value.replace(/%$/,''))<0))return false;
     if(key==='gradientUnits'&&!['userSpaceOnUse','objectBoundingBox'].includes(value))return false;
     if(key==='spreadMethod'&&value!=='pad')return false;
    }
    gradients.set(id,{count:0,last:-1});
   }else if(name==='stop'){
    if(!gradientNames.has(parents.at(-1)))return false;
    // Gradients cannot nest, so the most recently opened definition is current.
    const gradient=[...gradients.values()].at(-1);if(!gradient||++gradient.count>16||++totalStops>128)return false;
    for(const key of attributes.keys())if(!['offset','stop-color','stop-opacity'].includes(key))return false;
    const raw=attributes.get('offset');if(!raw||!scalar(raw))return false;
    const offset=Number(raw.replace(/%$/,''))/(raw.endsWith('%')?100:1);
    if(offset<0||offset>1||offset<gradient.last)return false;gradient.last=offset;
    const opacity=attributes.get('stop-opacity');if(opacity!==undefined&&(!scalar(opacity)||opacity.includes('%')||Number(opacity)<0||Number(opacity)>1))return false;
   }else if(gradientNames.has(parents.at(-1)))return false;
   return true;
  },
  complete(){return [...gradients].every(([id,g])=>ids.get(id)===1&&g.count>=2)&&[...references].every(id=>gradients.has(id)&&ids.get(id)===1);}
 };
}
