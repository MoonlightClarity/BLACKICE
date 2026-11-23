// Shared graph construction for an actual BLACKICE ordinary-Chat benchmark.
// A generic workflow is retained only as a labeled diagnostic ablation.
export function createBenchmarkChatWorkflow(model,{workflowKind='ordinary-chat'}={}){
 if(!['ordinary-chat','generic'].includes(workflowKind))throw Error('Unsupported benchmark workflow mode.');
 const graph={
  name:'Benchmark coding',
  ...(workflowKind==='ordinary-chat'?{
   id:'mission_chat_context_benchmark',
   description:'A focused task started from Mission.',
  }:{}),
  nodes:[
   {id:'i',type:'input'},
   {id:'a',type:'agent',name:'Coding agent',model,
    prompt:'You are the coding agent. Fix the described software bugs. Inspect files and tests with your tools. Use only this isolated workspace. Verify the changes by running the test suite. Use current tool schemas.'},
   {id:'o',type:'output'},
  ],
  edges:[{source:'i',target:'a'},{source:'a',target:'o'}],
  settings:{maxParallel:1,planningMode:'off',context:{outputReserveTokens:16384,headroomTokens:2048}},
 };
 return graph;
}
