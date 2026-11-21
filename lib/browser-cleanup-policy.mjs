// A finished page and a finished task are not equivalent. Connection grants are not conversation owners.
export const BROWSER_CLEANUP_BASELINE = "Read tabs and record the baseline; track exact tab IDs opened by this task.";
export const BROWSER_CLEANUP_INVARIANTS = "Close a task page after saving its useful results and checking it for unfinished forms, pending effects, unresolved dialogs, running downloads or resumable work. Keep pages still needed by the user or another task, including work awaiting input.";
const EMPTY_TASK_FOLDER = "Close a task-created folder only after verifying it is empty.";

// Keep the external connector contract stable while sharing its task-page invariants.
export const BROWSER_CLEANUP_PROTOCOL = " BROWSER TAB CLEANUP: " + BROWSER_CLEANUP_BASELINE
  + " A connection-wide owner can cover several conversations. Use the saved conversationId when supported, otherwise distinguish task-created tabs from personal/pre-existing pages.\n"
  + BROWSER_CLEANUP_INVARIANTS
  + " The cleanup preview reports limited DOM inspection for deliberate per-page manual review; a hidden form cannot be ruled out by that scan alone.\n"
  + "Call blackice_browser_action action:\"close\" for the chosen tabId, await blackice_get_job, then reread tabs to verify removal. After an uncertain close, inspect the original job and tab state; an already absent tab needs no new close. " + EMPTY_TASK_FOLDER;

export const NATIVE_BROWSER_CLEANUP_PROTOCOL = "\nBROWSER TAB CLEANUP: " + BROWSER_CLEANUP_BASELINE
  + "\n" + BROWSER_CLEANUP_INVARIANTS
  + " Apply the same checks before reusing a page with navigate. Reuse a suitable completed owned page, or close completed task-created pages incrementally as work progresses; do not wait for the whole task to finish. Preserve personal/pre-existing pages and foreign pages. Task settlement alone does not establish that a page is finished.\n"
  + "Use relay_browser with action:\"close\", browser:\"relay\" and the exact chosen tabId. Await the native tool result, then use action:\"tabs\" to verify removal. After an uncertain close, inspect its receipt and current tabs before retrying; an already absent tab needs no new close. Keep inUse marks while pages are needed; use tab_mark with inUse:false only to release your own completed task mark. Never clear a user or another task's mark. " + EMPTY_TASK_FOLDER;
