# Application Station

Application Station helps you turn one strong base cover letter into many job-specific applications quickly.

## What It Can Do

- Tailor a single base `.docx` cover letter for each job posting you add.
- Optionally tailor your resume for each job too.
- Use sample cover letters to steer voice/style.
- Add optional tailoring preferences under Settings → Additional instructions; they save locally and apply to future cover letters and resumes.
- Work job-by-job while keeping everything organized in one session.
- Preview results directly in the browser before exporting.
- Export one result at a time or all results as a ZIP.

## How You Use It

1. Start the app locally.
2. Enter your Gemini API key in the UI.
3. Upload your base cover letter (`.docx`).
4. Optionally upload:
   - Resume (`.docx`)
   - Sample cover letters
5. Add a job description.
   - Company and role are optional.
   - You can paste just the full job post and fill details later.
6. Choose output mode:
   - `Direct Edits`: clean final text
   - `Track Changes`: revision-style redlines
7. Generate, review in preview, then export.

## Typical Workflow

- Add multiple job descriptions.
- Generate tailored outputs per job from the same base files.
- Switch between cover letter and resume previews.
- If using tracked changes, accept all changes in-preview when ready.
- Export individual files or everything as a ZIP package.

## Run Locally

```bash
python -m http.server 8002
```

Then open `http://localhost:8002`.

## V2 secondary trial

The main tool at `index.html` starts with the lightweight preview. Power users can enable **Settings → Document preview → Enable document editing (beta)**. Only then, when a document opens, does the app download WordCraft's roughly 39 MB WebAssembly editor. The preference saves in this browser. Turning editing off saves the active document and removes the editor; saved manual changes remain visible in the lightweight preview and are included in individual and bulk exports. The existing `wordcraft-demo.html` URL remains available with the same setting.

Deploy the checked-in `vendor/wordcraft/` bundle alongside the app. It includes the patched editor and its approximately 39 MB WebAssembly file; the default lightweight mode does not load that editor. The patch and native build script are in `vendor/wordcraft-patches/` and `scripts/build-wordcraft.ps1`. Do not replace the patched bundle with the stock release: it lacks the draft-saving bridge.

Autosave waits for about 900 ms of idle typing, with a five-second maximum wait during continuous typing. Switching documents, disabling editing, and exporting force a save. Closing or reloading the page while editor changes are pending triggers the browser’s leave-page warning; the app does not rely on an asynchronous save during unload. Tailoring reuses source paragraph inspection across jobs, detects changed source bytes, and gives every job its own mutable document so concurrent jobs cannot affect each other.

Before publishing, verify the editing toggle on the hosted subpath and confirm the editor's JavaScript and WebAssembly assets load only when needed. Browser integration instructions are in `tests/wordcraft-demo-integration.md`.

## Notes

- Your session persists in the browser (files/results in IndexedDB, lightweight preferences in localStorage).
- The DOCX engine uses the checked-in 0.9.0 bundle under `vendor/docx-redline/0.9.0`; include it when serving or deploying the app. Browser and Node checks use the same release.
- Edits that cannot preserve revision fidelity are refused. Skipped edits and list-conversion warnings appear in the job details for review.

## Tests

```bash
node --test tests/*.test.mjs
node tests/run-tests.mjs
```

DOCX fixture tests currently require `jszip` locally or in the sibling `Docx Redline JS` checkout. That checkout is used only to construct fixtures, not to load the engine.

## License

MIT (`LICENSE`).
