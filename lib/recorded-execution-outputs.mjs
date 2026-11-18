// Actual recorded task outcomes, independent of the retired response-cycle runner.
export function recordedExecutionOutputs(run){
  return run.workflow.nodes.filter(node=>node.type==='agent').map(node=>({nodeId:node.id,title:node.name,status:run.nodes[node.id].status,
    output:run.nodes[node.id].output||'',reused:run.nodes[node.id].reused===true,
    toolReceipts:run.events.filter(event=>event.nodeId===node.id&&(event.data?.type==='tool.result'||event.data?.type==='item'&&
      ['dynamicToolCall','commandExecution','fileChange','mcpToolCall'].includes(event.data.item?.type)&&
      (event.data.stage==='completed'||event.data.item.status==='completed'))).map(value=>structuredClone(value))}));
}
