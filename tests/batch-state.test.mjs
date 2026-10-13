import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoverLetterJob,
  normalizePersistedJob
} from '../main.js';
import { renderSelectedJob, getEditFeedback } from '../ui.js';

test('edit warnings survive session restore and appear separately from failures', () => {
  const job = normalizePersistedJob({
    company: 'Example', role: 'Engineer', status: 'done',
    applyWarnings: ['Cover letter: list marker remains literal.'],
    failedOperations: ['redline on P2: Refused.'], failedOperationCount: 1
  });
  const refs = Object.fromEntries([
    'selectedJobDisplay', 'jobMetaEditForm', 'editJobMetaBtn',
    'selectedJobTitle', 'selectedJobMeta', 'recommendationCard', 'recommendationText',
    'editDiagnostics', 'editDiagnosticsText'
  ].map(key => [key, { style: {}, dataset: {} }]));
  renderSelectedJob(refs, job);
  assert.match(refs.editDiagnosticsText.textContent, /Edit warnings:\n- Cover letter: list marker remains literal/);
  assert.match(refs.recommendationText.textContent, /edit could not be applied/);
  assert.doesNotMatch(refs.recommendationText.textContent, /list marker remains literal/);
  assert.equal(refs.editDiagnostics.open, false);
  assert.equal(refs.recommendationCard.open, false);
  refs.recommendationCard.open = true;
  renderSelectedJob(refs, job);
  assert.equal(refs.recommendationCard.open, true);
  renderSelectedJob(refs, { ...job, id: 'another-job' });
  assert.equal(refs.recommendationCard.open, false);
  assert.doesNotMatch(refs.recommendationText.textContent, /Validation warning/);
  assert.deepEqual(normalizePersistedJob({}).applyWarnings, []);
});

test('benign structural pairing diagnostics are quiet while remaining in saved job data', () => {
  const warnings = Array.from({ length: 15 }, (_, i) => `${i < 7 ? 'Cover letter' : 'Resume'}: redline on P${i + 1}: PAIRING_SKIPPED_STRUCTURAL_BOUNDARY`);
  const job = normalizePersistedJob({ applyWarnings: warnings });
  assert.deepEqual(getEditFeedback(job), { messages: [], details: '' });
  assert.deepEqual(job.applyWarnings, warnings);
  const mixed = getEditFeedback({ applyWarnings: [...warnings, 'Resume: UNKNOWN_CODE'], failedOperations: ['redline on P4: TARGET_NOT_FOUND'] });
  assert.equal(mixed.messages.length, 2);
  assert.match(mixed.details, /UNKNOWN_CODE/);
  assert.match(mixed.details, /TARGET_NOT_FOUND/);
  assert.doesNotMatch(mixed.details, /PAIRING_SKIPPED/);
});

test('unknown warnings and validation errors remain actionable without exposing raw codes', () => {
  const feedback = getEditFeedback({ applyWarnings: ['Resume: UNKNOWN_CODE'], validationError: 'RAW_XML_ERROR' });
  assert.equal(feedback.messages.length, 2);
  assert.doesNotMatch(feedback.messages.join(' '), /UNKNOWN_CODE|RAW_XML_ERROR/);
  assert.match(feedback.details, /UNKNOWN_CODE/);
  assert.match(feedback.details, /RAW_XML_ERROR/);
  assert.deepEqual(getEditFeedback({}), { messages: [], details: '' });
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
