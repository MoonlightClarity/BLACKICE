# Native agent tools v2: method revision 1

Implement the contract in TASK.md using the saved files. The effective native Modular Development skill supplies the coding method; this packet defines the benchmark's files, tools and verification steps.

1. Read METHOD.md, TASK.md, public-cases.json and src/index.cjs with relay_workspace action "read". Use action "list" for this workspace when needed. Preserve the task contract, public cases and test support. Only src is editable; helper modules must be relative CommonJS .cjs files under src.

2. Discover and read the relevant native skill through the attached read-only interface:
   - relay_skills: {"action":"search","query":"modular development"}
   - Use the returned entries[].id in relay_skills: {"action":"read","id":"library-modular-development"} when that is the returned ID.
   Read the returned entry.content and apply the effective skill. These are search/read operations; do not create or edit skills. The skill may also already be supplied in the native context.

3. Chat Planning and Action Directory are on. Read the current outline with relay_directory_action action "read". Reuse the host-created plan where it fits; plan or refine the necessary actions and focus the matching action before a save or public check. Action Directory is the task map; do not create a separate plan file. Preserve completed actions and actual failure receipts.

4. Submit complete source through relay_code, separately from prose:
   action "save", language "javascript", path "src/index.cjs", format "raw", code containing the exact complete source, and expectedHash copied from the current relay_workspace read's sha256.
   Preserve intended Unicode characters and newlines. For replacement helpers, read their current hash first. Omit expectedHash only when creating a helper confirmed absent under src. On a stale-hash rejection, read the current file and repair against that version.
   Inspect the save result. Require readback.verified true and retain its returned sha256. A chat code block is not a saved artifact.

5. Check the saved implementation with relay_code:
   action "check", language "javascript", path "src/index.cjs", check "public", expectedHash set to the latest saved or read hash.
   This attached check runs exactly node test-public.cjs. Inspect the actual command, exit status and stdout JSON report. The report covers both fixed public cases and the complete saved source snapshot. A returned tool call or a final claim is not a passing test.
   If the check fails, inspect its public feedback, repair the source through relay_code and check again. Keep failed and timed-out results visible. Do not modify the tests or inspect private evaluation data, other attempts or files outside the assigned scope.

6. After both public cases pass on the final saved source, record relay_directory_action action "observe" with outcome "objective-met", the focused action ID, an accurate claim and the exact DIRECTORY HOST RECEIPT ID returned by the successful public check. If work remains or a check is unresolved, record the actual partial result or blocker instead of claiming completion.
   Finish with a short summary of saved files and the real public-check result. Final chat prose is not graded as source.
