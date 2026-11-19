# Spot-check web accessibility

Check a page or short flow for keyboard, focus, and labeling barriers with observed evidence.

**What you need:** A reachable page or an existing authorized browser session. BLACKICE's browser can snapshot, capture screenshots, and send keyboard input; it does not supply screen-reader results.

**Approach:** Pick a concrete task, such as finding a form field and opening its help. Use Tab and Shift+Tab to sample forward and reverse focus order, and use the screenshot for a visible focus indicator when needed. Check whether controls have understandable names and whether focus returns after dismissing an overlay. For reflow, check an actual narrow view only if one is available. Use a test state or stop before interacting with a control that could produce an unwanted real action.

**Check and recover:** Report the page, starting state, keystrokes, expected behavior, and what actually happened. If the snapshot or screenshot cannot establish focus, mark that check unverified or provide short manual steps. Name the flows and assistive technologies you did not test; a spot check is not a conformance audit.

Workflow reference: [Accessibility Audit by kensaurus LLC](https://github.com/kensaurus/skills/blob/088aafcaa77a03444d1b5b4c497deec5e8e71373/skills/audit-accessibility/SKILL.md) ([MIT license](https://github.com/kensaurus/skills/blob/088aafcaa77a03444d1b5b4c497deec5e8e71373/LICENSE)). Written for BLACKICE; no upstream templates, scripts, or assets included.
