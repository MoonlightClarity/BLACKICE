// Historical graph-plan HTTP fixtures still execute through the real server.
// Only newly admitted default-version metadata is pinned to the captured v13
// protocol; route handling, persistence, continuation and custom engines remain real.
import { createHarnessServer as createCurrentHarnessServer } from '../server.mjs';
export * from '../server.mjs';
export async function createHarnessServer(options = {}) {
  const app = await createCurrentHarnessServer(options);
  if (!options.engine) {
    const dispatchRun = app.engine.dispatchRun;
    app.engine.dispatchRun = function (run) {
      if (run.planningContractVersion === 14) run.planningContractVersion = 13;
      return dispatchRun.call(this, run);
    };
  }
  return app;
}
