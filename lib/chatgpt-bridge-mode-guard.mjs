/**
 * A bounded, best-effort check for English mode-redirect replies. This checks
 * the answer being saved, not ChatGPT's host mode or its available permissions.
 * Quoted material and code are examples, not instructions from the answerer.
 */
const MODE = String.raw`(?:(?:chatgpt(?:['’]s)?|the)\s+)?work[\s-]+mode\b`;
const USE_MODE = String.raw`(?:us(?:e|ing)|try(?:ing)?|open(?:ing)?|enabl(?:e|ing)|activat(?:e|ing)|launch(?:ing)?|enter(?:ing)?|select(?:ing)?|turn\s+on)\s+${MODE}`;
const MOVE_MODE = String.raw`(?:switch(?:ing)?|chang(?:e|ing)|mov(?:e|ing)|go(?:ing)?|head(?:ing)?|hand(?:ing)?(?:-?off)?|transfer(?:ring)?|delegat(?:e|ing)|rout(?:e|ing)|send(?:ing)?|tak(?:e|ing))\b[^.!?;]{0,100}?\b(?:to|into)\s+${MODE}`;
const CONTINUE_MODE = String.raw`(?:continu(?:e|ing)|proceed(?:ing)?|work(?:ing)?)\b[^.!?;]{0,80}?\bin\s+${MODE}`;
const DO_MODE = String.raw`(?:do(?:ing)?|handl(?:e|ing)|complet(?:e|ing)|finish(?:ing)?|execut(?:e|ing)|run(?:ning)?|perform(?:ing)?)\s+(?:this|that|it|the\s+(?:task|work|request|project))\b[^.!?;]{0,80}?\bin\s+${MODE}`;
const ACTION = `(?:${USE_MODE}|${MOVE_MODE}|${CONTINUE_MODE}|${DO_MODE})`;
const POLITE = String.raw`(?:(?:please|kindly|first|next|now|then|instead|just)\s+){0,2}`;
const patterns = [
  ['imperative', new RegExp(String.raw`(?:^|[\n,:]\s*|[—–]\s+)\s*${POLITE}${ACTION}`, 'gim')],
  ['question', new RegExp(String.raw`\b(?:can|could|would|will|should|may|shall)\s+(?:you|we|i)\s+${POLITE}${ACTION}`, 'gi')],
  ['offer', new RegExp(String.raw`\b(?:would\s+you\s+like|do\s+you\s+want|want|are\s+you\s+ready)(?:\s+(?:me|us))?\s+to\s+${ACTION}`, 'gi')],
  ['offer', new RegExp(String.raw`\b(?:would\s+you\s+like|do\s+you\s+want|want)\s+(?:a\s+)?(?:handoff|hand[- ]off|switch|transfer)\b[^.!?;]{0,80}?\b(?:to|into)\s+${MODE}`, 'gi')],
  ['offer', new RegExp(String.raw`\b(?:i|we)(?:['’](?:ll|d)|\s+(?:can|could|will|would|should|must|need\s+to|have\s+to|(?:am|are)\s+going\s+to|would\s+like\s+to))\s+(?:(?:only|also|now|then|just|instead)\s+){0,2}${ACTION}`, 'gi')],
  ['offer', new RegExp(String.raw`\b(?:i|we)(?:['’]d|\s+would)\s+be\s+happy\s+to\s+${ACTION}`, 'gi')],
  ['offer', new RegExp(String.raw`\blet(?:['’]s|\s+(?:me|us))\s+${ACTION}`, 'gi')],
  ['instruction', new RegExp(String.raw`\byou(?:['’]ll|\s+(?:will|would))?\s+(?:(?:need|have|ought)\s+to|should|must)\s+${ACTION}`, 'gi')],
  ['recommendation', new RegExp(String.raw`\b(?:i|we)(?:['’]d|\s+would)?\s+(?:recommend|suggest)\s+(?:(?:that\s+)?you\s+)?${ACTION}`, 'gi')],
  ['instruction', new RegExp(String.raw`\byou(?:['’]ll|\s+(?:will|would))?\s+(?:need|require)\s+${MODE}`, 'gi')],
  ['offer', new RegExp(String.raw`\b(?:why\s+don['’]t\s+you|wouldn['’]t\s+you(?:\s+rather)?)\s+${ACTION}`, 'gi')],
];

const modeNameOnly = new RegExp(`^${MODE}$`, 'i');
const unquote = value => modeNameOnly.test(value.trim()) ? value.trim() : ' ';

function proseOnly(answer) {
  const lines = [], source = answer.replace(/[\u200B-\u200D\uFEFF]/g, '');
  let fence = null;
  for (const original of source.split(/\r?\n/)) {
    const marker = original.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      lines.push(''); continue;
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; lines.push(''); continue; }
    // Markdown indented code and quoted lines are deliberately outside this check.
    if (/^(?: {4}|\t)/.test(original)) { lines.push(''); continue; }
    let line = original.replace(/^ {0,3}(?:(?:[-+*]|\d+[.)])\s+|#{1,6}\s+)/, '');
    if (/^\s*>/.test(line) || /^\s*(?:example|quoted (?:text|source)|source excerpt|sample (?:output|message))\s*:/i.test(line)) { lines.push(''); continue; }
    line = line
      .replace(/`([^`\n]*)`/g, (_, value) => unquote(value))
      .replace(/“([^”\n]*)”|"([^"\n]*)"|‘([^’\n]*)’/g, (_, curly, straight, single) => unquote(curly ?? straight ?? single))
      .replace(/(^|[\s:([{])'([^'\n]+)'(?=$|[\s.,!?;:)\]}])/g, (_, prefix, value) => prefix + unquote(value))
      .replace(/\[([^\]\n]+)\]\([^\s)]*\)/g, '$1')
      .replace(/[*_~]/g, '');
    lines.push(line);
  }
  return lines.join('\n');
}

function comparisonRequest(prompt) {
  return typeof prompt === 'string'
    && /\bwork[\s-]+mode\b/i.test(prompt)
    && /\bchat[\s-]+mode\b/i.test(prompt)
    && /\b(?:compare|comparison|differences?|versus|vs|when\s+to\s+use|when\s+should\s+i\s+use)\b/i.test(prompt);
}

const comparativeUse = new RegExp(String.raw`^\s*${POLITE}(?:use|try)\s+${MODE}\s+(?:for|when)\b`, 'i');

/** Return an actionable rejection only for a recognizable direct mode redirect. */
export function chatGPTBridgeModeViolation(answer, { prompt } = {}) {
  if (typeof answer !== 'string') return null;
  const normalized = answer.normalize('NFKC');
  if (!/work[\s\u200B-\u200D\uFEFF-]+mode/i.test(normalized)) return null;
  const comparison = comparisonRequest(prompt), prose = proseOnly(normalized);
  // Adversative clauses have independent intent: a preceding "do not switch"
  // must not hide a later "but would you like me to move this to Work Mode?".
  const clauses = prose.split(/[.!?;]\s*|\n\s*\n|\b(?:but|however)\b/i);
  for (const clause of clauses) {
    if (!/\bwork[\s-]+mode\b/i.test(clause)) continue;
    for (const [kind, pattern] of patterns) for (const match of clause.matchAll(pattern)) {
      const before = clause.slice(0, match.index).slice(-150);
      // Also permit explicit "Do not say: switch ..." wording without quotes.
      if (/\b(?:do\s+not|don['’]t|never|avoid)\s+(?:(?:say|ask|suggest|offer|recommend|request|write)\s*)?[, :]\s*$/i.test(before + match[0].match(/^[\s,:]*/)[0])) continue;
      const after = clause.slice(match.index + match[0].length, match.index + match[0].length + 80);
      const instruction = match[0].replace(/^[\s,:]+/, '').replace(/^(?:(?:please|kindly|first|next|now|then|instead|just)\s+){0,2}/i, '');
      // "Switching to Work Mode is unnecessary" is a description, not an
      // imperative. Gerunds remain actionable after "I recommend ...".
      if (kind === 'imperative' && /^(?:switching|changing|moving|going|heading|handing|transferring|delegating|routing|sending|taking|using|trying|opening|enabling|activating|launching|entering|selecting|continuing|proceeding|working|doing|handling|completing|finishing|executing|running|performing)\b/i.test(instruction)) continue;
      if (/^\s+(?:is|would\s+be|will\s+be)\s+(?:not\s+(?:needed|necessary|required)|unnecessary)\b/i.test(after)) continue;
      if (/\bif\s+(?:i|we|you|the\s+assistant)\s+(?:said|suggested|wrote)\b/i.test(before) && /\b(?:incorrect|wrong|unnecessary|not\s+correct)\b/i.test(after)) continue;
      // In a requested comparison, "Use Work Mode for [category]" can describe
      // the difference. Actual switching and handoff offers are still rejected.
      const currentTask = /\b(?:(?:this|that|your|our)\s+(?:task|work|request|project|conversation)|the\s+(?:current|queued|requested)\s+(?:task|work|request|project|conversation))\b/i.test(after);
      if (comparison && !currentTask && kind === 'imperative' && comparativeUse.test(match[0].replace(/^[\s,:]+/, '') + after)) continue;
      return {
        code: 'CHATGPT_BRIDGE_CHAT_MODE_REQUIRED',
        message: 'This bridge request requires ChatGPT Chat Mode. The answer asks to switch or hand off to Work Mode, so it was not saved and the request remains pending. Remain in Chat Mode and use the authorized connector for this request. If the requested result cannot be produced there, report the specific missing capability or blocker to the user in Chat Mode and leave this request pending. Complete the request only with the requested result.',
      };
    }
  }
  return null;
}
