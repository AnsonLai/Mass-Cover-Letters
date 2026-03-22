import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOutputFileName,
  createCoverLetterJob,
  filterDocxFiles,
  getNextRunnableJob
} from '../main.js';

test('filterDocxFiles keeps only docx uploads', () => {
  const files = [
    { name: 'base.docx' },
    { name: 'resume.DOCX' },
    { name: 'note.txt' }
  ];

  assert.deepEqual(filterDocxFiles(files).map(file => file.name), ['base.docx', 'resume.DOCX']);
});

test('createCoverLetterJob returns queued cover-letter job model', () => {
  const job = createCoverLetterJob({
    company: 'Google',
    role: 'Software Engineer',
    description: 'Build scalable systems.'
  });

  assert.equal(job.status, 'queued');
  assert.equal(job.company, 'Google');
  assert.equal(job.role, 'Software Engineer');
  assert.equal(job.operationCount, 0);
  assert.equal(job.resumeOperationCount, 0);
});

test('getNextRunnableJob returns queued jobs first', () => {
  const jobs = [
    { id: 'done-1', status: 'done' },
    { id: 'queued-1', status: 'queued' },
    { id: 'retry-1', status: 'retry' }
  ];

  assert.equal(getNextRunnableJob(jobs)?.id, 'queued-1');
});

test('buildOutputFileName formats human-readable filename with month-year suffix', () => {
  const name = buildOutputFileName({
    company: 'google_llc',
    role: 'software_engineer_ii'
  }, new Date(Date.UTC(2026, 2, 21)));

  assert.equal(name, 'Google LLC - Software Engineer II - Cover Letter - 032026.docx');
});
