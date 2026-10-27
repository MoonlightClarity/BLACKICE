import path from 'node:path';

const PREFIX=':codex-file-citation{',FALLBACK='File reference unavailable';
function citation(source,start,{streaming}={}) {
 let quoted=false,escaped=false,end=start+PREFIX.length;
 for(;end<source.length&&end-start<=8500;end++){
  const char=source[end];if(escaped){escaped=false;continue;}if(quoted&&char==='\\'){escaped=true;continue;}
  if(char==='"')quoted=!quoted;else if(char==='}'&&!quoted)break;
 }
 if(end===source.length||end-start>8500)return {end:source.length,text:streaming?'':FALLBACK,pending:streaming};
 const body=source.slice(start+PREFIX.length,end),attrs={};let offset=0;const pair=/\s*(path|purpose)\s*=\s*"((?:[^"\\]|\\.)*)"/gy;
 while(offset<body.length){if(!body.slice(offset).trim())break;pair.lastIndex=offset;const match=pair.exec(body);if(!match||Object.hasOwn(attrs,match[1]))return{end:end+1,text:FALLBACK};attrs[match[1]]=match[2].replace(/\\(["\\])/g,'$1');offset=pair.lastIndex;}
 if(!attrs.path||!['source','output'].includes(attrs.purpose))return{end:end+1,text:FALLBACK};
 const local=attrs.path;
 if(local.length>8000||/[\x00-\x1f\x7f]/.test(local)||!(path.win32.isAbsolute(local)||path.posix.isAbsolute(local))||/^[a-z][a-z0-9+.-]*:/i.test(local)&&!/^[a-z]:[\\/]/i.test(local))return{end:end+1,text:FALLBACK};
 // This adapter handles the PDF skill's file citations only. Other native
 // formats retain their existing handlers; no unregistered path is authorized.
 if(!/\.pdf$/i.test(local))return{end:end+1,text:source.slice(start,end+1)};
 let href;try{href=encodeURI(local.replaceAll('\\','/')).replace(/[?#]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());}catch{return{end:end+1,text:FALLBACK};}
 return{end:end+1,text:'['+(attrs.purpose==='source'?'Source PDF':'PDF file')+'](<'+href+'>)'};
}

/** Translate native PDF citations into ordinary Markdown. Registration and
 * preview authority remain with BLACKICE's existing exact-file resolver. */
export function normalizeNativeFileCitations(value,{streaming=false}={}) {
 if(typeof value!=='string')return value;
 const colon=value.lastIndexOf(':');if(!value.includes(PREFIX)&&!(streaming&&colon>=0&&PREFIX.startsWith(value.slice(colon))))return value;
 let fence=null;const lines=value.split(/(\r?\n)/),result=[];
 for(let lineIndex=0;lineIndex<lines.length;lineIndex+=2){
  const line=lines[lineIndex],newline=lines[lineIndex+1]||'',marker=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;result.push(line,newline);continue;}
  if(fence||/^(?: {4}|\t)/.test(line)){result.push(line,newline);continue;}
  let output='';for(let index=0;index<line.length;){
   if(line[index]==='\\'){output+=line.slice(index,index+2);index+=2;continue;}
   if(line[index]==='`'){const ticks=/^`+/.exec(line.slice(index))[0],end=line.indexOf(ticks,index+ticks.length);if(end<0){output+=line.slice(index);break;}output+=line.slice(index,end+ticks.length);index=end+ticks.length;continue;}
   if(line.startsWith(PREFIX,index)){const token=citation(line,index,{streaming:streaming&&!newline&&lineIndex===lines.length-1});output+=token.text;index=token.end;continue;}
   if(streaming&&!newline&&lineIndex===lines.length-1&&line[index]===':'&&PREFIX.startsWith(line.slice(index)))break;
   output+=line[index++];
  }
  result.push(output,newline);
 }
 return result.join('');
}
