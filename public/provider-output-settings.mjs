/** Managed local provider output controls. Blank means native generation capacity. */
export function supportsNativeOutput(config){
  return /^local_llamacpp(?:_(?:[2-9]|[1-9]\d+))?$/.test(config?.id||'')&&config.type==='compatible'&&config.preset==='llamacpp'&&
    /^http:\/\/(?:localhost|127\.0\.0\.1):8080\/v1\/?$/i.test(config.baseUrl||'')&&!config.endpoints?.chatCompletions;
}

// All direct API protocols support automatic output capacity. Anthropic
// requires a numeric wire limit; the runtime resolves that separately.
export function supportsAutomaticOutput(config){
  return ['compatible','openai','anthropic'].includes(config?.type);
}
export function defaultOutputPolicy(config){
  return supportsAutomaticOutput(config)&&(config.maxTokens===undefined||config.maxTokens===8192)
    ?'provider-default':'configured-limit';
}
export function outputBudgetField(config){
  return (config?.outputTokenPolicy??defaultOutputPolicy(config))==='provider-default'
    ?'':String(config?.maxTokens??8192);
}
export function outputBudgetPatch(config,value){
  const raw=String(value??'').trim();
  if(!raw&&supportsAutomaticOutput(config))return {outputTokenPolicy:'provider-default'};
  const maxTokens=Number(raw);
  if(!raw||!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>128000)
    throw Error('Enter a whole number from 1 to 128,000, or leave blank for automatic output capacity.');
  return {maxTokens,outputTokenPolicy:'configured-limit'};
}
