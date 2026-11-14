import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const edits=[
 ['public/next/chat/model.mjs',"export const runText = run => typeof run?.input === 'string' ? run.input : text(run?.input?.task);",
  "export const runText = run => typeof run?.input === 'string' ? run.input : text(run?.input?.task);\nexport const displayChatRequest = run => run?.autonomy?.automatic || run?.autonomyDispatch ? '' : runText(run);"],
 ['public/next/chat/render.mjs',"import { runText, messagesOfRun,",
  "import { runText, displayChatRequest, messagesOfRun,"],
 ['public/next/chat/render.mjs',"const request=runText(run);","const request=displayChatRequest(run);"],
 ['public/next/chat/render.mjs',"earlier&&runText(earlier)","earlier&&displayChatRequest(earlier)"],
 ['public/next/chat/render.mjs',"earlier && runText(earlier)===request","earlier && displayChatRequest(earlier)===request"],
 ['public/next/chat/reader-model.mjs',"input:run.input,status:run.status,settled:run.settled,output:run.output,",
  "input:run.input,status:run.status,settled:run.settled,output:run.output,\n       ...(run.autonomy?.automatic||run.autonomyDispatch?{autonomy:{automatic:true}}:{}),"]
];
const next=new Map();
for(const [rel,from,to] of edits){
 const file=join(root,rel),current=next.has(file)?next.get(file):readFileSync(file,'utf8'),at=current.indexOf(from);
 if(at<0||current.indexOf(from,at+1)>=0)throw Error('Non-unique '+rel+': '+from);
 next.set(file,current.slice(0,at)+to+current.slice(at+from.length));
}
for(const [file,content] of next){writeFileSync(file,content,'utf8');process.stdout.write(file+'\n');}
