// Decode the historical Windows-guest BMP fixture into the exact PNG format
// used by archived receipts. This test helper cannot start a VM or send input.
import { deflateSync } from 'node:zlib';
const fail=(message)=>Object.assign(new Error(message),{code:'HISTORICAL_IMAGE_FIXTURE_INVALID'});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(name,data){const n=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([n,data])));return Buffer.concat([size,n,data,crc]);}
export function workbenchFramePng(frame){
  const b=frame?.bytes,w=frame?.width,h=frame?.height;
  if(!Buffer.isBuffer(b)||!Number.isInteger(w)||w<1||w>4096||!Number.isInteger(h)||h<1||h>4096||b.length!==54+w*h*4||b.toString('ascii',0,2)!=='BM'||b.readUInt32LE(10)!==54||b.readInt32LE(18)!==w||Math.abs(b.readInt32LE(22))!==h||b.readUInt16LE(28)!==32||b.readUInt32LE(30)!==0)throw fail('Fixture is not a validated 32-bit BMP.');
  const topDown=b.readInt32LE(22)<0,rows=Buffer.alloc((1+w*3)*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const from=54+((topDown?y:h-1-y)*w+x)*4,to=y*(1+w*3)+1+x*3;rows[to]=b[from+2];rows[to+1]=b[from+1];rows[to+2]=b[from];}
  const header=Buffer.alloc(13);header.writeUInt32BE(w,0);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
  if(png.length>12*1024*1024)throw fail('Decoded PNG exceeds archived image-size limit.');
  return png;
}
