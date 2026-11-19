/** Evidence records are normalized from settled, ordered host receipts, never model prose.
 * Only synthetic data belongs in this suite; marker values never appear in the task prompt.
 */
export function scoreDocument({events, target, marker, output, settled, attached = false}) {
  const preflight = attached ? [] : ['attachments.list'];
  const allowedFirst = attached ? ['attachments.read', 'attachments.list'] : ['files.find'];
  const first = events[preflight.includes(events[0]?.op) ? 1 : 0];
  const find = events.findIndex(event => event.op === 'files.find' && event.success && event.matches?.includes(target));
  const reader = attached ? 'attachments.read' : 'workspace.read';
  const attemptedRead = events.findIndex(event => event.op === reader && event.target === target);
  const usable = events.findIndex(event => event.op === reader && event.success &&
    event.target === target && event.text?.includes(marker));
  const report = {
    settled: settled === true,
    early: allowedFirst.includes(first?.op),
    foundBeforeRead: attemptedRead >= 0 && (attached || (find >= 0 && find < attemptedRead)),
    firstReadWorked: usable >= 0 && usable === attemptedRead,
    noShell: !events.some(event => event.op === 'workspace.run' || event.op === 'shell'),
    answered: output?.includes(marker) === true,
  };
  return {...report, passed: Object.values(report).every(Boolean), callsThroughUsable: usable < 0 ? null : usable + 1};
}

export function scoreSkill({events, target, marker, output, settled, metadataMax = 10}) {
  const search = events.findIndex(event => event.op === 'skills.search' && event.success);
  const read = events.findIndex(event => event.op === 'skills.read');
  const selected = target == null ? read < 0 :
    search >= 0 && search < read && events[search].ids?.includes(target) === true &&
    events[read].id === target && events[read].success === true &&
    events[read].text?.includes(marker) === true;
  const report = {
    settled: settled === true,
    selected,
    boundedMetadata: events.filter(event => event.op === 'skills.search').every(event =>
      Array.isArray(event.ids) && event.ids.length <= metadataMax && event.metadataOnly === true),
    noDistractorReads: events.every(event => event.op !== 'skills.read' || event.id === target),
    applied: target == null || output?.includes(marker) === true,
  };
  return {...report, passed: Object.values(report).every(Boolean)};
}


/** An answer score, a delivery receipt and overhead are separate measurements.
 * An inline control is self-contained, so the exact same facts require no read.
 */
export function scoreHandoff({events, targets, expected, output, settled, inline = false,
  selectedSkill = 'library-document-comparison', skillMarker, skillReceipts = []}) {
  const first = events[events[0]?.op === 'attachments.list' ? 1 : 0];
  const find = events.findIndex(event => event.op === 'files.find' && event.success &&
    Object.values(targets).some(target => event.matches?.includes(target)));
  const usable = Object.entries(targets).map(([format, target]) => {
    const assertions = format === 'pdf' ? [expected.dispatchCode, expected.discrepancy.pdf] :
      [expected.ticketCode, expected.discrepancy.docx];
    return events.findIndex(event => event.op === 'workspace.read' && event.success &&
      event.target === target && assertions.every(value => event.text?.includes(value)));
  });
  let json;
  try { json = JSON.parse(output?.trim().replace(/^\x60{3}json\s*([\s\S]*?)\s*\x60{3}$/i, '$1')); } catch {}
  const answer = settled === true && json?.dispatchCode === expected.dispatchCode &&
    json?.ticketCode === expected.ticketCode && json?.discrepancy?.pdf === expected.discrepancy.pdf &&
    json?.discrepancy?.docx === expected.discrepancy.docx;
  const skillBodyReturned = events.some(event => event.op === 'skills.read' && event.id === selectedSkill &&
    event.success === true && Boolean(skillMarker) && event.text?.includes(skillMarker));
  const skillDelivered = skillBodyReturned && skillReceipts.some(receipt => receipt.type === 'skill_loaded' && receipt.skillId === selectedSkill);
  const callsThroughEvidence = !inline && usable.every(index => index >= 0) ? Math.max(...usable) + 1 : null;
  const count = predicate => events.filter(predicate).length;
  const usefulCalls = new Set(inline ? [] : [find, ...usable].filter(index => index >= 0));
  return {
    settled: settled === true,
    firstActionAfterAttachmentCheck: first?.op ?? null,
    firstUsefulTool: inline ? null : events.find((_, index) => usefulCalls.has(index))?.op ?? null,
    earlyFileDiscovery: !inline && find >= 0 && events[find] === first,
    correctAnswer: answer,
    groundedAnswer: answer && (inline || usable.every(index => index >= 0)),
    skillBodyReturned,
    skillDelivered,
    skillCalls: count(event => event.op.startsWith('skills.')),
    shellCalls: count(event => event.op === 'workspace.run' || event.op === 'shell'),
    allCalls: events.length,
    extraCalls: events.length - usefulCalls.size,
    callsThroughEvidence,
  };
}
