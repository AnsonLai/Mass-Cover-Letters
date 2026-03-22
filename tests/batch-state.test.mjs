import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoverLetterJob
} from '../main.js';

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
