const receiptEvents = new Set([
  'directory.mutation', 'directory.snapshot', 'directory.effect', 'directory.final', 'browser.reference'
]);

// Keep task state, tool outcomes, and execution evidence used outside Receipts.
// The permanent marker prevents re-projecting Basic receipts from that evidence.
export function retireTurnReceipts(run) {
  run.receiptDiagnosticsRemoved = true;
  delete run.turnMachineTrace;
  for (const node of Object.values(run.nodes || {})) if (node) delete node.directoryContext;
  if (run.events?.some(event => receiptEvents.has(event?.data?.type)))
    run.events = run.events.filter(event => !receiptEvents.has(event?.data?.type));
  return run;
}

export function turnReceiptsUnavailable(run) {
  if (run.receiptDiagnosticsRemoved === true)
    return Object.assign(Error('Receipts are no longer available for this archived or previously retired turn.'), {
      status: 410, code: 'TURN_RECEIPTS_REMOVED'
    });
}
