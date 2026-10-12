import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoverLetterJob,
  normalizePersistedJob
} from '../main.js';
import { renderSelectedJob } from '../ui.js';

test('edit warnings survive session restore and appear separately from failures', () => {
  const job = normalizePersistedJob({
    company: 'Example', role: 'Engineer', status: 'done',
    applyWarnings: ['Cover letter: list marker remains literal.'],
    failedOperations: ['redline on P2: Refused.'], failedOperationCount: 1
  });
  const refs = Object.fromEntries([
    'selectedJobDisplay', 'jobMetaEditForm', 'editJobMetaBtn',
    'selectedJobTitle', 'selectedJobMeta', 'recommendationCard', 'recommendationText'
  ].map(key => [key, { style: {} }]));
  renderSelectedJob(refs, job);
  assert.match(refs.recommendationText.textContent, /Edit warnings:\n- Cover letter: list marker remains literal/);
  assert.match(refs.recommendationText.textContent, /edit not applied/);
  assert.doesNotMatch(refs.recommendationText.textContent, /Validation warning/);
  assert.deepEqual(normalizePersistedJob({}).applyWarnings, []);
});

test('createCoverLetterJob trims fields and initializes runtime state', () => {
  const job = createCoverLetterJob({
    company: '  Amazon  ',
    role: '  Solutions Architect ',
    description: ' Build cloud migration plans. '
  });

  assert.equal(job.company, 'Amazon');
  assert.equal(job.role, 'Solutions Architect');
  assert.equal(job.description, 'Build cloud migration plans.');
  assert.equal(job.status, 'queued');
  assert.equal(typeof job.storage.resultKey, 'string');
  assert.equal(typeof job.storage.resumeResultKey, 'string');
});

test('createCoverLetterJob infers company and role when omitted', () => {
  const job = createCoverLetterJob({
    company: '',
    role: '',
    description: [
      'Google - Backend Engineer',
      'Build services for ads ranking systems.'
    ].join('\n')
  });

  assert.equal(job.company, 'Google');
  assert.equal(job.role, 'Backend Engineer');
});
