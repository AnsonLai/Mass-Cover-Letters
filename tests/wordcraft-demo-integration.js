import { createDocumentStore } from '../document-store.js?v=2026-10-12-drafts-ready';
const store = await createDocumentStore({ name: document.documentElement.dataset.documentStore });
if (!await store.getJson('session:state')) {
  const a = await (await fetch('./tests/fixtures/wordcraft-export-a.docx')).blob();
  const b = await (await fetch('./tests/fixtures/wordcraft-export-b.docx')).blob();
  await store.putBlob('base:source', a);
  await store.putBlob('resume:source', b);
  const jobs = [];
  for (const [id, blob] of [['a', a], ['b', b]]) {
    const storage = { resultKey: `test:${id}:cover`, resumeResultKey: `test:${id}:resume`, detailsKey: `test:${id}:details` };
    await store.putBlob(storage.resultKey, blob);
    await store.putBlob(storage.resumeResultKey, blob);
    jobs.push({ id, company: `Sample ${id.toUpperCase()}`, role: 'Counsel', description: 'Isolated integration fixture', status: 'done', generatedMode: 'track', operationCount: 2, coverLetterOperationCount: 1, resumeOperationCount: 1, storage, recommendation: 'Sample application for editor save/export integration testing.' });
  }
  await store.putJson('session:state', { baseDocument: { fileName: 'sample-base.docx' }, resumeDocument: { fileName: 'sample-resume.docx' }, jobs, selectedJobId: 'a', previewType: 'coverLetter', sampleDocuments: [] });
}
await import('../main.js?v=2026-10-12-drafts-final');
