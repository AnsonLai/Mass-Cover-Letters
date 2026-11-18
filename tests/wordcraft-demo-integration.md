# WordCraft demo integration checks

Run the local server and open `http://localhost:8002/tests/wordcraft-demo-integration.html`.
This page runs the demo's shared application code with two synthetic jobs in the separate IndexedDB database `wordcraft-integration-tests-2026-10-12`. It does not generate AI requests or seed the user's application database.

1. Confirm the page starts with a lightweight preview and no editor iframe. Open Settings and enable **Document editing (beta)**, then edit Sample A's cover letter. Switch to its resume and edit that too.
2. Switch to Sample B, edit its cover letter, and leave its resume untouched. Switching should save without a WordCraft save prompt.
3. Use the application's Export menu to export all applications. Check that each of the four DOCX files contains only its own edits.
4. Reload the test page and export an individual application. Previously saved edits should remain.
5. Accept all changes in Sample A's cover letter, export, then undo and export again. Manual edits should survive both operations; tracked changes should disappear on accept and return on undo.
6. Disable document editing. The iframe should disappear and manual edits should remain in the lightweight preview and exports. Reload and confirm editing remains off; enable it again to recover the edited document.

The native embed build must expose `wordcraftLoad`, `wordcraftSnapshot`, `wordcraftState`, and `wordcraftAcknowledgeSave`. Rebuild with `scripts/build-wordcraft.ps1` if needed.

Run automated checks with `node --test tests/*.test.mjs`. These include draft storage, source replacement, serialized switching, save failure/retry, revision acknowledgement, and foreign-document protection.

Browser verification on 2026-10-12 passed all steps above. The four-file ZIP was independently opened and its document XML checked for correct marker routing, restored tracked changes after undo, and byte-for-byte preservation of the untouched resume. All 74 automated tests passed. These synthetic checks cover the integration and export path; they do not establish full formatting fidelity for every Word document.

Pending-edit protection: while editing is enabled, verify closing/reloading warns immediately after typing, including before the autosave poll. Saving/exporting should clear the warning; disabling editing after saving should remove it. Native File Save must not suppress a warning while the app draft is still pending. Cancel navigation when testing so edits remain available. The isolated local `docs/wordcraft-round-trips/app-guard.html` harness probes the parent beforeunload event without navigating or opening a browser dialog.
