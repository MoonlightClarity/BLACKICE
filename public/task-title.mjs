/** Compact labels from the authored task; never changes the message itself. */
export function taskTitle(input, { max = 120, fallback = 'New task' } = {}) {
  const value = typeof input === 'string' ? input : typeof input?.task === 'string' ? input.task : '';
  const generic = /^(?:goal|task|objective|request|outcome|brief|prompt|context|build|problem|question|decision|what to do|your task)\s*:?$/i;
  const tidy = line => line.trim().replace(/^\uFEFF/, '').replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').replace(/^>\s*/, '').replace(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
  let result = '';
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim() || /^\s*(?:`{3,}|~{3,}|[-*_]{3,})/.test(line)) continue;
    // Labels need only a small prefix; keep pathological Markdown out of long regex scans.
    const cleaned = tidy(line.slice(0, 4096));
    if (!cleaned || generic.test(cleaned)) continue;
    result = cleaned.replace(/^(?:goal|task|objective|request|outcome)\s*:\s*(?=\S)/i, '');
    break;
  }
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 120;
  const shortened = String(result || fallback).slice(0, limit);
  return shortened.replace(/[\uD800-\uDBFF]$/, '');
}

/** Automatic sidebar topic label only; explicit conversation names bypass this formatter. */
export function conversationTitle(input,{fallback='Conversation'}={}){
  const authored=taskTitle(input,{max:4096,fallback});
  let topic=authored.replace(/^(?:(?:please|can you|could you|would you|help me|i need (?:you to|help with)|i want (?:you to|to))\s+)+/i,'')
    .replace(/^(?:build|create|make|write|research|find|fix|explain|review|compare|implement)\s+(?:(?:a|an|the)\s+)?/i,'');
  topic=topic.split(/[.!?](?:\s|$)/,1)[0].trim()||authored;
  const words=topic.split(/\s+/);let label='';
  for(const word of words.slice(0,6)){
    if(label&&label.length+1+word.length>48)break;
    label+=(label?' ':'')+word;
  }
  label=label.slice(0,48).replace(/[\uD800-\uDBFF]$/,'').replace(/[,:;.!?]+$/,'');
  label=label.replace(/(?:\s+(?:and|or|for|with|the|a|an|my|your|to|of|in|on))+$/i,'');
  return label?label[0].toLocaleUpperCase()+label.slice(1):fallback;
}
