// One bounded, provider-only verification opportunity for code-changing tasks.
// No calls, file mutations, outcome claims or user approval gates occur here.
const CODE_PATH=/(?:^|[\\/])[^\\/\0]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|rs|go|java|cs|cpp|cc|c|h|hpp|rb|php|swift|kt|sql|sh|ps1|vue|svelte)$/i;
const MUTATING=new Map([['relay_workspace',new Set(['write','patch'])],['relay_code',new Set(['save','patch'])]]);
const TEST_TOOL='relay_workspace';
const TEST_LIMIT=4,SOURCE_LIMIT=6;
const DEFAULT_MIN_STEPS=3;
const argsOf=call=>{
  try{
    const v=typeof call?.arguments==='string'?JSON.parse(call.arguments):call?.arguments;
    return v&&typeof v==='object'&&!Array.isArray(v)?v:null;
  }catch{return null;}
};
const short=value=>typeof value==='string'?value.slice(0,240):'';
const optOut=/\b(?:do not|don't|never)\s+(?:run|add|write|create)\s+(?:any\s+)?(?:additional|extra|new|further)\s+tests\b/i;

export function createCodingVerificationCoverage(){
 let editCount=0,testCount=0,lastEditSequence=0,sequence=0,issued=false;
 const edits=[],tests=[];
 return Object.freeze({
  observe({call,result,receipt,verifiedTest}={}){
   if(call?.namespace||result?.success!==true||!receipt||receipt.state!=='returned'||receipt.success!==true)return;
   const args=argsOf(call),action=args?.action;
   if(!args||typeof action!=='string')return;
   const allowed=MUTATING.get(call.name);
   if(allowed?.has(action)&&typeof args.path==='string'&&CODE_PATH.test(args.path)){
     editCount++; lastEditSequence=++sequence;
     edits.push({path:short(args.path),receiptId:receipt.id});
     if(edits.length>SOURCE_LIMIT)edits.shift();
   }else if(call.name===TEST_TOOL&&action==='run'&&verifiedTest?.command===args.command){
     testCount++;const checkSequence=++sequence;tests.push({command:short(verifiedTest.command),receiptId:receipt.id,sequence:checkSequence});
     if(tests.length>TEST_LIMIT)tests.shift();
   }
  },
  review({directoryReady=false,unknownEffects=0,remainingSteps,input='',candidateIncomplete=false,signalAborted=false,
    runSettled=false,hasPendingDirections=false,hasSteer=false,scopedWorker=false,benchmark=false,hasGoal=false}={}){
   if(issued||!directoryReady||unknownEffects>0||candidateIncomplete||signalAborted||runSettled||hasPendingDirections||hasSteer
      ||scopedWorker||benchmark||hasGoal||editCount<1||testCount<1||optOut.test(input)
      ||Number.isInteger(remainingSteps)&&remainingSteps<DEFAULT_MIN_STEPS)return null;
   const verifiedAfterEdit=tests.some(item=>item.sequence>lastEditSequence);
   if(!verifiedAfterEdit){
     issued=true;
     return 'BLACKICE ONE-TIME STALE-TEST WARNING (host-observed): A code source edit occurred after the last successfully returned public test. '+
       'Earlier test receipts cannot verify the current saved source. Recent code edits: '+JSON.stringify(edits)+'. '+
       'If authorized and useful, run the relevant tests on the current source, check the actual returned result, and update the saved task evidence. '+
       'Do not repeat the source mutation solely for bookkeeping, claim the old test covers the new code, or request routine approval. '+
       'If verification is unavailable, report that limitation. This warning is issued once.';
   }
   issued=true;
   const evidence={changedCode:edits,publicTestReceipts:tests.filter(item=>item.sequence>lastEditSequence).map(({command,receiptId})=>({command,receiptId})),totalCodeEdits:editCount,totalPublicTestChecks:testCount};
   return 'BLACKICE ONE-TIME CODING VERIFICATION REVIEW (host facts, not a new task): '+
     JSON.stringify(evidence)+
     '\nYour Directory actions are recorded as finished, but a successful provided/public test does not by itself verify every explicit requirement in the requested implementation. '+
     'Use the original task instructions and inspected source requirements to identify high-risk conditions not demonstrably tested, such as boundary inputs, error side effects, concurrent calls, retries, state isolation, or pagination. '+
     'Perform a bounded coverage pass over explicit hard requirements not established by the provided tests. Prioritize invalid inputs, failure side effects and boundary behavior before claiming complete correctness. Group uncovered cases into proportionate focused checks; an ephemeral scratch test outside provided test files is allowed if consistent with user instructions. '+
     'Do not edit the provided tests, repeat an already-confirmed write merely to get another receipt, or invent hidden-test outcomes. '+
     'If a check fails, fix the implementation, rerun the relevant checks, and record the actual evidence in a new ready Directory action only when needed. '+
     'If the remaining requirements are already supported or no useful check is feasible, finish with an accurate account of what was and was not verified. '+
     'Do not ask for routine approval, and do not create bookkeeping tasks without operational value. This review is issued at most once.';
  },
  summary:()=>({editCount,testCount,issued,edits:[...edits],tests:[...tests]}),
 });
}
