/**
 * Keep Electron asInvoker to preserve Chromium subprocess startup on Windows.
 * The hidden Workbench-specific helper requests Hyper-V administrator rights
 * on the tested UAC Never notify configuration; no desktop interaction.
 * Other UAC settings are untested and fail without foreground escalation.
 */
export const WORKBENCH_HOST_FOCUS_POLICY =
  'Run BLACKICE normally so its Browser tab works. Hyper-V is managed '+
  'through a hidden Workbench administrator helper on the tested Windows '+
  'Never notify configuration; no visible PowerShell, VMConnect, host focus '+
  'changes or host keyboard/pointer input.';

function blocked(){
  return Object.assign(new Error(WORKBENCH_HOST_FOCUS_POLICY),{
    code:'WORKBENCH_HOST_FOCUS_PROTECTED',status:503
  });
}

/** Legacy entrypoint kept solely to reject any older caller safely. */
export function buildElevatedWorkbenchLauncher(){
  throw blocked();
}

/** No shell, file, UAC, window or input effects; this always rejects. */
export async function runElevatedWorkbenchPowerShell(){
  throw blocked();
}
