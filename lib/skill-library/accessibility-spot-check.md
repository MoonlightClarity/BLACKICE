# Spot-check web accessibility

Use for a page or short flow that the user wants checked for keyboard access, focus, labels, or narrow-screen usability.

## Check a concrete task

1. Open the requested page and name the task, such as “reach the delivery address and open its help.”
2. Use Tab and Shift+Tab to move through controls. Check that focus follows a usable order and can leave each component.
3. Use a screenshot to check the visible focus indicator. Read control names in the snapshot and compare them with the visible labels.
4. Open and close a menu or dialog; check that focus enters it and returns to a useful place afterward.
5. Check reflow in an actual narrow view when one is available. Use a disposable record for a test submission.

## Report the observed result

For each finding, give the page, starting state, keys or clicks, expected behavior, and actual behavior. For example: “After closing Help, Tab moves to the page header instead of the next address field.”

If the available snapshot or image does not show focus, say which check remains unverified and give the exact manual step needed. BLACKICE keyboard and screenshot checks do not establish screen-reader behavior or full accessibility conformance.

Workflow reference: [Accessibility Audit](https://github.com/kensaurus/skills/blob/088aafcaa77a03444d1b5b4c497deec5e8e71373/skills/audit-accessibility/SKILL.md) ([MIT](https://github.com/kensaurus/skills/blob/088aafcaa77a03444d1b5b4c497deec5e8e71373/LICENSE)); adapted for BLACKICE.
