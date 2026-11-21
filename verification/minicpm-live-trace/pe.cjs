'use strict';
const fs=require('node:fs');
function inspectPe(path){
 const b=fs.readFileSync(path);
 if(b.toString('ascii',0,2)!=='MZ')throw Error('PE_DOS_SIGNATURE');
 const pe=b.readUInt32LE(0x3c);if(b.toString('ascii',pe,pe+4)!=='PE\0\0')throw Error('PE_SIGNATURE');
 const n=b.readUInt16LE(pe+6),opt=pe+24,sz=b.readUInt16LE(pe+20),magic=b.readUInt16LE(opt);
 if(magic!==0x20b)throw Error('PE_NOT_X64');
 const dd=opt+112,sections=[];
 for(let i=0;i<n;i++){const s=opt+sz+i*40;sections.push({va:b.readUInt32LE(s+12),vsize:b.readUInt32LE(s+8),raw:b.readUInt32LE(s+20),size:b.readUInt32LE(s+16)});}
 function off(r){for(const s of sections)if(r>=s.va&&r<s.va+Math.max(s.vsize,s.size))return s.raw+r-s.va;throw Error('PE_RVA:'+r);}
 function str(r){const a=off(r),z=b.indexOf(0,a);if(z<0)throw Error('PE_STRING');return b.toString('ascii',a,z);}
 const imports=[],exports=[];const ir=b.readUInt32LE(dd+8);
 if(ir){let i=off(ir);while(b.readUInt32LE(i)||b.readUInt32LE(i+12)){const dll=str(b.readUInt32LE(i+12));let th=off(b.readUInt32LE(i)),names=[];while(b.readBigUInt64LE(th)){const v=b.readBigUInt64LE(th);names.push((v>>63n)?'#'+String(v&65535n):str(Number(v)+2));th+=8;}imports.push({dll,names});i+=20;}}
 const er=b.readUInt32LE(dd);if(er){const e=off(er),count=b.readUInt32LE(e+24),names=off(b.readUInt32LE(e+32));for(let i=0;i<count;i++)exports.push(str(b.readUInt32LE(names+4*i)));}
 return {path,machine:b.readUInt16LE(pe+4),imports,exports};
}
module.exports={inspectPe};
