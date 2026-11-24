import {reduceToolOutcome} from '../public/tool-outcomes-model.mjs';

// Preserve attempt identity. One successful operation cannot resolve a different attempt.
export function createActionFailureReview() {
  let summary;
  let correction;
  function issues() {
    return summary?.issues.filter(issue => !issue.resolved) || [];
  }
  return {
    observe(event) { if (event.type === 'tool.result') summary = reduceToolOutcome(summary,event); },
    pending() { return issues().length > 0 || Boolean(summary?.omittedUnresolved); },
    beforeFinal({output, remainingSteps}) {
      const pending = issues();
      if (!pending.length && !summary?.omittedUnresolved) return null;
      const labels = [...new Set(pending.map(issue => issue.tool + ' ' + issue.action))];
      const report = labels.map(label => label + ' failed.').join(' ') +
        (summary.omittedUnresolved ? ' Earlier failed attempts also have no retained recovery receipt.' : '');
      const paragraphs = String(output || '').toLowerCase().split(/\n+/);
      const disclosed = pending.every(issue => {
        const code = String(issue.code || '').toLowerCase();
        const operation = (issue.tool + ' ' + issue.action).toLowerCase();
        const filenames = [...issue.message.matchAll(/[^\s'"/\\:]+\.[a-z0-9]{1,12}(?=['"\s]|$)/gi)].map(match => match[0].toLowerCase());
        return paragraphs.some(line => {
          const namedCode = code && code !== 'tool_failed' && line.includes(code);
          const named = namedCode || line.includes(operation) || (line.includes(issue.tool.toLowerCase()) && line.includes(issue.action.toLowerCase()))
            || filenames.some(name => line.includes(name));
          return named && (namedCode || /\b(fail(?:ed|ure)?|unsuccessful|unavailable|missing|absent|unable|enoent|denied|not found|no such file|could not|couldn.t|does not exist|doesn.t exist)\b/.test(line));
        });
      });
      if (disclosed && (!summary.omittedUnresolved || /earlier failed/i.test(output))) return null;
      if (correction === report || remainingSteps === 0) {
        throw Object.assign(new Error(report + ' The final answer did not account for the failed attempts.'), {code:'ACTION_FAILURE_UNREPORTED'});
      }
      correction = report;
      return {continue:true,prompt:'Execution receipts record these failed attempts: ' + report +
        ' Continue useful work where possible. If an alternate operation achieved the objective, explain its evidence. In the final answer identify each listed tool and action together, say it failed, and explain the consequence. Preserve verified results. Do not claim an unverified effect or repeat an action whose effect is uncertain.'};
    }
  };
}
