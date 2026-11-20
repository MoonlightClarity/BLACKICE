# Expand a Catalog

Use when adding or revising entries in a collection people choose from: templates, report types, integrations, product records, game items, or other options. Use this to decide what each entry adds, what it actually supports, and what to check before offering it. It is not a mandate to implement a runtime for a design-only catalog.

## Start with the difference the entry should make

- Read the current catalog in the working copy. Find its stable IDs, nearest neighbors, and the places that show, save, or use those entries. Compare against active entries, not just a stale list or mockup.
- For each proposed entry, name who chooses it, what it lets them do, and what makes it different from the closest existing choice. If the only difference is a label, color, or marketing phrase, keep it as a variant when the distinction is useful. Don’t create another choice that people cannot meaningfully distinguish.
- Identify the promised scope: design-only, listed, selectable, or usable for a specified operation. Treat those as separate claims. Copy, images, flags, and class names describe an entry; they do not show that a downstream step uses it. Do not add an operation or invent values merely because the schema has fields for them.

## Add and check the entries

1. Keep existing IDs and references stable unless replacing them is the work. Reuse the shared structure for genuinely shared behavior. Write the user-facing label or note in terms of what the entry does; keep design notes, implementation gaps, and sources separate where the catalog supports it.
2. Trace each promised behavior to the step that uses it. Look for missing assets, unsupported branches, silent fallbacks, or defaults inherited from a neighboring entry. Where nothing uses the entry yet, leave it clearly marked as design-only or report the precise gap. Don’t let the label imply a stronger claim.
3. For a batch, check the basics for every entry, preferably in one pass: unique ID, valid references, correct grouping, and required data or assets present. Group entries that really share behavior and try one representative case per group in the actual place of use. Test every entry’s unique branch where it differs. One successful export does not establish that a second format opens correctly.
4. Check how users tell similar entries apart in the real view. For icons, assess the rendered size and silhouette, not artwork zoomed in. For text, read labels side by side and see whether they predict the right choice. Check a saved selection after reopening, status changes, or undo only where those behaviors are part of the request.
5. If a shared change can affect existing entries, try a neighboring entry that should stay unchanged. When some entries are ready and others are not, deliver the working subset if it meets the scope and name what remains only listed or unverified.

Record only the distinctions that matter: entry, difference from its nearest neighbor, promised scope, observed result, and remaining gap. Use a short table for a large batch if it helps. For deeper end-to-end checks, use **Verify a Working Slice** on each distinct route that matters.

## Examples

- **Report templates:** A regional summary should group by region, not simply rename the weekly report. Check every template is selectable under its own ID. Generate one report per distinct calculation path from inputs whose regional and weekly totals differ. If the new template appears but still groups by week, report it as selectable, not working.
- **Service catalog:** If asked to add new onboarding offerings to a brochure, give each a distinct audience and deliverable. Do not present self-service scheduling as available merely because the entry contains a booking label. If working booking is in scope, try the authorized route and verify its result separately.
- **Game roster:** Give a new pickup a distinct purpose and a shape recognizable at palette size. Verify that the editor lists and saves the placement. If the runtime has no code that grants its effect, call it placeable rather than playable. Don’t infer duration or radius from its art.

Adapted from the Eclipse Roster Expansion skill in the Hermes archive. Its rules for specific actors, art assets, and editor controls remain examples, not universal requirements.
