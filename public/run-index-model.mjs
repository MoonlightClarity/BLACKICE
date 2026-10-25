/** The renderer's run catalog is not an execution log.
 * Project full local runs to the information required for lists, chat navigation,
 * and startup selection. Never change the backend's saved run, history or APIs.
 */
export function projectRunIndex(source) {
  if (!source || typeof source !== 'object' || typeof source.id !== 'string') return null;
  const { events, ...result } = source;
  // Do not copy stream/tool/browser trace arrays into the renderer at startup.
  // Individual selected runs can still be read from existing /api/runs/:id.
  // Retain the task state, workflow and actual saved model output so controls
  // and recovery features can still inspect their normal run metadata.
  return { ...result, events: [], indexed: true };
}

/** Reconcile a summary refresh without erasing full live/selected history.
 * A summary's timestamp may be newer, but it does not contain event details.
 */
export function reconcileRunIndex(previous, summary) {
  if (!previous || previous.id !== summary?.id || !Array.isArray(previous.events) || !previous.events.length) return summary;
  // The fetched index has the newest metadata, workflow and task state.
  // Preserve only the full trace held by the already-open conversation;
  // stale local status/output must not shadow a newer HTTP snapshot.
  return { ...previous, ...summary, events: previous.events, indexed: false };
}

export function projectRunCollection(data) {
  const array = Array.isArray(data) ? data : data?.runs;
  if (!Array.isArray(array)) throw new Error('BLACKICE returned an invalid run catalog.');
  return array.map(projectRunIndex).filter(Boolean);
}
