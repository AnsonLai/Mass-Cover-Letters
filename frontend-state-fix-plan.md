# Frontend bug triage and fix plan

Use the [state machine audit](frontend-state-audit.md) as the inventory. For each candidate, identify the user action and the state invariant it breaks, reproduce the old behavior, and verify the smallest fix through the same entry point. Exercise both pages for shared UI changes. Use test stores, synthetic DOCX fixtures, and mocked Gemini responses so the checks need no real credentials or saved documents.

## Status

- **Complete:** All five isolated fixes in phase 1, with browser smoke coverage on both pages and an automated archive regression test.
- **Next:** Reproduce duplicate generation starts and premature batch cleanup with controlled promises. Check how many runs actually start and when editing resumes.
- **Pending:** Preview and API-key ownership, mutations during generation, and failure-injection checks for results and drafts.

## 1. Isolated fixes completed

All five fixes are implemented. Headless Chrome smoke checks passed on both entry pages using synthetic documents and an isolated browser profile. They covered Escape ownership, reopening completed setup, resize cancellation and keyboard resizing, both files in a colliding bulk export, and retrying a malformed upload through the file picker and drop zone. The archive regression test also covers an existing suffixed filename and a case-only collision. The Node suite passed 87 tests and the standalone runner passed.

| Order | Fixed bug | Regression check |
| --- | --- | --- |
| 1 | **Export All drops colliding filenames.** Archive insertion uses the display filename as the ZIP path. | Export two jobs with the same normalized company and role in the same month. Inspect the ZIP paths and contents. Preserve every document, leave unique names unchanged, and make the displayed count match the ZIP. Include a collision with a name that already has a numeric suffix. |
| 2 | **Escape dismisses the setup checklist while closing another surface.** The global handler writes dismissal unconditionally. | Open Settings and press Escape. Repeat in the welcome dialog and tour with an incomplete checklist. Only the active surface should close, with no new checklist dismissal record. Preserve explicit dismissal when the checklist owns Escape. |
| 3 | **Completed setup cannot be reopened.** The visibility predicate ignores the forced-open flag. | Finish all four steps and open Setup Checklist from Settings. The completed checklist should open, Close Guide should close it, and the completed state should stay collapsed or hidden on normal reload. Check reopening during incomplete setup as well. |
| 4 | **Sidebar resize can get stuck after cancellation.** The drag cleans up on pointerup alone. | Begin dragging, cancel the pointer, then start another drag. Verify listener and CSS cleanup, ownership by the initiating pointer, and normal mouse/keyboard resizing. Check a resize across the compact breakpoint. |
| 5 | **Failed uploads can leave the file picker stuck on the same value.** Input cleanup follows the awaited import. | Select a malformed DOCX and then select the same file again. Both attempts should reach the import path, each should show a useful error, and the prior valid document should remain available. Exercise file picker and drop separately. Treat atomic sample-batch imports as a separate decision. |

Use `node --test tests/*.test.mjs` and `node tests/run-tests.mjs` after each change. Add focused automated coverage where existing tests miss the regression, especially archive contents. Use the documented [browser integration harness](tests/wordcraft-demo-integration.md) for UI transitions it can exercise, and record manual steps for the rest.

## 2. Reproduce higher-impact races with controlled ordering

1. **Generation ownership.** Delay editor flush, start Generate and Generate All, then release the flush. Count jobs and mocked requests. Reject a batch worker while a sibling is pending. Fix only if reproduction shows duplicate starts or early cleanup. Assert one owner from the first await until all claimed workers settle.
2. **Preview ownership.** Delay one render, select another job or tab, then release renders in reverse order. Check visible content, label, and WordCraft binding. Exercise both engines and an empty target. Assert that only the latest target commits visible content.
3. **Key validation ownership.** Hold A's response, save or clear B, and then resolve A. Inspect the input, saved key, validation marker, and displayed status. Assert that obsolete responses cannot commit. Mock model switches and failed revalidation.
4. **Deletion, uploads, and generation settings.** Pause a run during preparation and application. Exercise Clear Applications, source replacement, and mode changes separately. Verify that removed jobs do not reappear as orphaned results and that each attempt uses one coherent input snapshot. Keep policy decisions such as whether new jobs join an active batch explicit.

## 3. Resolve result and draft consistency before changing storage

Inject failures between each result, details, backup, epoch, and snapshot write. Reload after each failure and compare what the queue, preview, and export report. Repeat across two tabs and during Accept, Undo, and rerun. Decide whether a failed rerun keeps the previous committed result available, then apply that rule consistently to all three surfaces. Scope any transaction or versioning change to the invariants demonstrated by those tests.

Cover the remaining lower-priority findings in the audit after the steps above. Prioritize reproducible data loss, wrong documents, blocked actions, or misleading success messages. Leave cache churn, benign stale callbacks, and other cosmetic states for later unless a reproduction shows a user-visible effect.
