# Frontend bug triage and fix plan

Use the [state machine audit](frontend-state-audit.md) as the inventory. For each candidate, identify the user action and the state invariant it breaks, reproduce the old behavior, and verify the smallest fix through the same entry point. Exercise both pages for shared UI changes. Use test stores, synthetic DOCX fixtures, and mocked Gemini responses so the checks need no real credentials or saved documents.

## Status

- **Complete:** Phase 1's five isolated fixes and phase 2's generation, preview, key validation, and generation-time mutation fixes.
- **Next:** Inject result and draft write failures and decide how the last committed result should behave after a failed rerun.

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

## 2. Controlled race fixes completed

1. **Generation ownership.** The previous commit started two requests for a single job when Generate and Generate All fired together. It also unlocked the UI on a worker rejection while a sibling was pending. The fix reserves the run before its first await and waits for all claimed work to settle. Chrome checks counted requests and verified editor inertness during a held save and through cleanup.
2. **Preview ownership.** Finishing an older standard render after a newer one previously overwrote the visible content. Standard previews now render offscreen and publish only the latest result. WordCraft serializes host changes and drops superseded loads or clears before committing them where the bridge still permits it. Chrome verified selection after a held editor save, opening an empty target, and reopening a document. Node tests cover stale open after a held draft read and stale clear after a held save acknowledgment.
3. **Key validation ownership.** A stale validation previously overwrote a subsequently saved key. Only the current request can now commit validation status. Chrome verified out-of-order saves, clearing while pending, failed revalidation, and changing models mid-request.
4. **Generation inputs and document mutations.** Each run uses a fixed job list, source documents, and settings snapshot. Uploads, removals, and result mutations are blocked while generation owns the app. New jobs can be added and stay queued for the next run. Chrome checked Clear Applications, a source upload, a mode change, and an addition while a batch was waiting for mocked responses.

The controlled Chrome checks passed on both entry pages with synthetic documents and mocked Gemini, the standard renderer, and the WordCraft bridge. The Node suite passed 89 tests and the standalone runner passed. Cross-tab and interrupted-write behavior remain in phase 3.

## 3. Resolve result and draft consistency before changing storage

Inject failures between each result, details, backup, epoch, and snapshot write. Reload after each failure and compare what the queue, preview, and export report. Repeat across two tabs and during Accept, Undo, and rerun. Decide whether a failed rerun keeps the previous committed result available, then apply that rule consistently to all three surfaces. Scope any transaction or versioning change to the invariants demonstrated by those tests.

Cover the remaining lower-priority findings in the audit after the steps above. Prioritize reproducible data loss, wrong documents, blocked actions, or misleading success messages. Leave cache churn, benign stale callbacks, and other cosmetic states for later unless a reproduction shows a user-visible effect.
