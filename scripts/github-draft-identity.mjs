import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function verifyDraftIdentity(value,{id,tag,source}) {
  if(!/^[1-9][0-9]*$/.test(String(id))||!/^v\d+\.\d+\.\d+$/.test(tag)||!/^[a-f0-9]{40}$/.test(source))throw Error('Invalid expected draft identity');
  if(!value||String(value.id)!==String(id)||value.draft!==true||value.tag_name!==tag||value.target_commitish!==source){
    const safe=(v,pattern)=>typeof v==='string'&&pattern.test(v)?v:'<missing-or-invalid>';
    const actual={id:Number.isSafeInteger(value?.id)?String(value.id):'<missing-or-invalid>',draft:typeof value?.draft==='boolean'?value.draft:'<missing-or-invalid>',tag:safe(value?.tag_name,/^v\d+\.\d+\.\d+$/),source:safe(value?.target_commitish,/^[a-f0-9]{40}$/)};
    throw Error('REST draft identity mismatch: '+JSON.stringify({expected:{id:String(id),draft:true,tag,source},actual}));
  }
  if(!Array.isArray(value.assets)||value.assets.some(a=>!Number.isSafeInteger(a.id)||a.id<=0||typeof a.name!=='string'))throw Error('Invalid draft asset inventory');
  const names=['Blackice-'+tag.slice(1)+'-Setup.exe','blackice-public-release.json','SHA256SUMS.txt'];
  for(const name of names)if(value.assets.filter(a=>a.name===name).length!==1)throw Error('Expected unique draft asset missing: '+name);
  return {databaseId:value.id,isDraft:true,tagName:value.tag_name,targetCommitish:value.target_commitish,assets:value.assets};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(verifyDraftIdentity(JSON.parse(readFileSync(0,'utf8')),{id:process.argv[2],tag:process.argv[3],source:process.argv[4]})))}catch(error){console.error(error.message);process.exitCode=1}}
