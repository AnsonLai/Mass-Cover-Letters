# Edited DOCX and bulk export proof of concept

Run the local server and open `http://localhost:8002/tests/wordcraft-export-smoke.html`.
The locally built WordCraft bundle must include the embed-only `wordcraftExport(name)` bridge.
This page uses synthetic fixtures and in-memory snapshots; it never accesses application session storage or AI APIs.

1. Click **Load job A**, then **Capture baseline**. The baseline checks DOCX readability, bold text, a table, a hyperlink, and existing tracked insertion/deletion elements.
2. In the editor, move to the end and append `MANUAL_EDIT_JOB_A`.
3. Click **Load job B**. This exports job A's edited document into its own snapshot before importing B.
   WordCraft may still ask to save the previous sample. Choose **Don't Save** in that prompt: the parent test page has already captured its edited bytes. Production integration must acknowledge a successful save back to WordCraft after durable storage, so normal job switches do not require this prompt.
4. Append `MANUAL_EDIT_JOB_B` at the end of B.
5. Click **Verify bulk export**. This captures B and uses the application's existing ZIP creation function.
6. Confirm that the ZIP contains exactly two documents, each with its own manual marker and without the other job's marker, and that the application's DOCX engine can reopen both. **Download test ZIP** saves the resulting artifact.

The test proves the serialization and packaging path. It does not implement production autosave, job-switch synchronization, save recovery, or full fidelity testing against real-world Word documents.
