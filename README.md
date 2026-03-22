# Application Station

Application Station helps you turn one strong base cover letter into many job-specific applications quickly.

## What It Can Do

- Tailor a single base `.docx` cover letter for each job posting you add.
- Optionally tailor your resume for each job too.
- Use sample cover letters to steer voice/style.
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

## Notes

- Your session persists in the browser (files/results in IndexedDB, lightweight preferences in localStorage).

## License

MIT (`LICENSE`).
