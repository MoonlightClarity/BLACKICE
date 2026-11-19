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
