// Tests for saved schema-13 conversations must retain the catalog that was
// captured before canonical work items became the new-run default. This test
// fixture changes only admission metadata; all execution, persistence, tool
// handling and continuation still use the actual production engine.
import { HarnessEngine as CurrentHarnessEngine } from '../lib/engine.mjs';
export * from '../lib/engine.mjs';
export class HarnessEngine extends CurrentHarnessEngine {
  dispatchRun(run) {
    if (run.planningContractVersion === 14) run.planningContractVersion = 13;
    return super.dispatchRun(run);
  }
}
