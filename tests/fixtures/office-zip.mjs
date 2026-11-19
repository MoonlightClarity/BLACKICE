import { deflateRawSync } from 'node:zlib';

const crcTable = Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0});
function crc(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export function zip(parts){
  const body=[],directory=[];let offset=0;
  for(const [name,source] of Object.entries(parts)){
    const nameBytes=Buffer.from(name),data=Buffer.from(source),compressed=deflateRawSync(data),checksum=crc(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);
    local.writeUInt32LE(checksum,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);
    body.push(local,nameBytes,compressed);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
    central.writeUInt16LE(8,10);central.writeUInt32LE(checksum,16);central.writeUInt32LE(compressed.length,20);
    central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);
    directory.push(central,nameBytes);offset+=local.length+nameBytes.length+compressed.length;
  }
  const dir=Buffer.concat(directory),end=Buffer.alloc(22),count=Object.keys(parts).length;
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);
  end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...body,dir,end]);
}
