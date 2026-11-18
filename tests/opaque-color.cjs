// Computed CSS colors used by the renderer acceptance checks. Unknown formats fail closed.
module.exports=function isOpaqueColor(value){
 const text=String(value||'').trim().toLowerCase();
 if(text==='transparent')return false;
 const match=text.match(/^rgba?\(([^)]+)\)$/);
 if(!match)return false;
 const body=match[1],slash=body.split('/');
 const parts=body.split(',').map(part=>part.trim());
 const alpha=slash.length===2?slash[1].trim():parts.length===4?parts[3]:null;
 if(alpha===null)return parts.length===3||(!body.includes(',')&&body.trim().split(/\s+/).length===3);
 const number=alpha.endsWith('%')?Number(alpha.slice(0,-1))/100:Number(alpha);
 return Number.isFinite(number)&&number===1;
};
