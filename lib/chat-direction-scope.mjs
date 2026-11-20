/** Only recognize explicit stop/report turns, not generic requests to change plans. */
export function chatDirectionScope(message) {
 const text=String(message||'').trim().replace(/’/g,"'");
 if (!text || /\b(?:then|after that)\b[^.!?]*\b(?:resume|continue|retry|search|apply|submit|send|run|fix)\b/i.test(text))return null;
 if (/^(?:do not|don't) (?:job search|search for jobs|apply(?: to jobs)?)[.!?]+\s*(?:please\s+)?stop[.!?]*$/i.test(text))return 'stop';
 if (/^(?:please\s+)?stop[.!?]*$/i.test(text) || /^(?:please\s+)?(?:do not|don't) (?:job search|search for jobs|apply(?: to jobs)?)[.!?]*$/i.test(text))return 'stop';
 const report=/\b(?:tell me|show me|list|explain|report|what|where|why|asking about|look at)\b/i.test(text);
 const priorFailure=/\b(?:tool (?:failures?|issues?|errors?)|what failed|what went wrong|where (?:it|you) failed|(?:failures?|errors?) (?:in|from) (?:the )?(?:previous|earlier|last|prior)\b)/i.test(text);
 const priorReview=/\b(?:previous|earlier|prior) turns?\b/i.test(text)&&/\bwhere (?:you|it) ran into\b/i.test(text);
 if(report&&(priorFailure||priorReview) && !/\b(?:and|also)\s+(?:resume|continue|retry|apply|submit|send|run|fix)\b/i.test(text))return 'diagnose';
 return null;
}
