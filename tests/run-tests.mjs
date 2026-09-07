import assert from 'node:assert/strict';

import {
  buildUserSettingsPromptBlock,
  normalizeGeminiModel,
  parseModelJsonObject,
  parseTailoringPayload
} from '../cover-letter-ai.js';
import {
  DOCX_REDLINE_VERSION,
  extractCanonicalParagraphText,
  normalizeAndFilterOperations,
  chunkOperations,
  describeOperationFailure,
  summarizeOperationFailures,
  findOriginalSubstring,
  diceSimilarity,
  reconcileOperationsWithParagraphs
} from '../docx-engine.js';
import { DEFAULT_GEMINI_MODEL } from '../constants.js';
import {
  formatJobDisplayName,
  getStatusLabel
} from '../ui.js';
import {
  buildOutputFileName,
  normalizePersistedJob
} from '../main.js';
import {
  computePopoverPlacement
} from '../tour.js';

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}

run('parseModelJsonObject extracts JSON from fenced block', () => {
  const raw = 'text before\n```json\n{"recommendation":"x","operations":[]}\n```\ntext after';
  const parsed = parseModelJsonObject(raw);
  assert.equal(parsed.recommendation, 'x');
});

run('parseTailoringPayload normalizes operations list', () => {
  const payload = parseTailoringPayload('{"recommendation":"ok","operations":[{"type":"REDLINE","targetRef":"P2","target":"A","modified":"B"}]}');
  assert.equal(payload.recommendation, 'ok');
  assert.equal(payload.operations.length, 1);
  assert.equal(payload.operations[0].type, 'redline');
});

run('buildUserSettingsPromptBlock returns empty string without guidance', () => {
  assert.equal(buildUserSettingsPromptBlock({ voice: ' ', extraGuidance: '' }), '');
});

run('normalizeGeminiModel falls back to default model for unknown values', () => {
  assert.equal(normalizeGeminiModel('bad-model'), DEFAULT_GEMINI_MODEL);
});

run('normalizeAndFilterOperations strips paragraph marker prefixes and invalid rows', () => {
  const ops = normalizeAndFilterOperations([
    { type: 'COMMENT', targetRef: 'P12', target: '[P12] Payment is due', textToComment: '[P12] Payment', commentContent: 'Check timing' },
    { type: 'redline', target: 'No ref', modified: '' },
    { type: 'highlight', targetRef: 'P5', target: '[P5] Term', textToHighlight: '[P5] Term', color: 'invalid' }
  ]);

  assert.equal(ops.length, 2);
  assert.equal(ops[0].type, 'comment');
  assert.equal(ops[0].targetRef, 12);
  assert.equal(ops[1].color, 'yellow');
});

run('chunkOperations splits operation list into fixed-size batches', () => {
  const chunks = chunkOperations([1, 2, 3, 4, 5], 2);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], [1, 2]);
});

run('DOCX_REDLINE_VERSION is updated to 0.5.0', () => {
  assert.equal(DOCX_REDLINE_VERSION, '0.5.0');
});

run('describeOperationFailure distinguishes engine errors from missing targets', () => {
  assert.equal(
    describeOperationFailure({ type: 'redline', targetRef: 4, success: false, error: 'boom' }),
    'redline on P4: boom'
  );
  assert.equal(
    describeOperationFailure({ type: 'highlight', targetRef: 0, success: false, error: null }),
    'highlight on unknown paragraph: target text was not found in the document'
  );
  assert.equal(
    describeOperationFailure({ type: 'redline', targetRef: 3, success: false, error: 'Original text was not found in the supplied OOXML.' }),
    'redline on P3: Original text was not found in the supplied OOXML.'
  );
  assert.equal(
    describeOperationFailure({
      type: 'comment',
      targetRef: 4,
      success: false,
      error: { code: 'ANCHOR_NOT_FOUND', message: 'Comment anchor was not found in target paragraph.' }
    }),
    'comment on P4: Comment anchor was not found in target paragraph.'
  );
  assert.equal(
    describeOperationFailure({
      type: 'redline',
      targetRef: 2,
      success: false,
      error: { code: 'COMMENTED_CONTENT_DELETE' }
    }),
    'redline on P2: COMMENTED_CONTENT_DELETE'
  );
});

run('extractCanonicalParagraphText evaluates canonical accepted text excluding deletions and preserving breaks', () => {
  function el(tag, children = [], text = '') {
    const node = {
      nodeType: 1,
      localName: tag,
      namespaceURI: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      childNodes: children,
      textContent: text,
      parentNode: null
    };
    for (const child of children) child.parentNode = node;
    return node;
  }

  const p = el('p', [
    el('r', [el('t', [], 'Dear Hiring Team,')]),
    el('del', [el('r', [el('delText', [], ' I got let go.')])]),
    el('ins', [el('r', [el('t', [], ' I am excited to apply.')])]),
    el('r', [el('tab')]),
    el('r', [el('t', [], 'Role:')]),
    el('r', [el('noBreakHyphen')]),
    el('r', [el('t', [], 'Staff')]),
    el('r', [el('softHyphen')]),
    el('r', [el('t', [], 'Engineer')])
  ]);

  const accepted = extractCanonicalParagraphText(p, { revisionView: 'accepted' });
  assert.equal(accepted, 'Dear Hiring Team, I am excited to apply.\tRole:‑Staff\xadEngineer');

  const rejected = extractCanonicalParagraphText(p, { revisionView: 'rejected' });
  assert.equal(rejected, 'Dear Hiring Team, I got let go.\tRole:‑Staff\xadEngineer');
});

run('summarizeOperationFailures keeps only unsuccessful operations and preserves structured error text', () => {
  const failures = summarizeOperationFailures([
    { type: 'redline', targetRef: 1, success: true },
    { type: 'redline', targetRef: 2, success: false, error: null },
    { type: 'comment', targetRef: 5, success: false, error: 'PARTIAL_TARGET: Contiguous range mismatch' }
  ]);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /redline on P2/);
  assert.equal(failures[1], 'comment on P5: PARTIAL_TARGET: Contiguous range mismatch');
});

run('findOriginalSubstring recovers exact text past smart quotes and spacing', () => {
  const original = 'I’m excited to apply for the role—truly.';
  // Model echoes straight quote, single space, and a hyphen instead of an em dash.
  assert.equal(findOriginalSubstring(original, "I'm excited to apply"), 'I’m excited to apply');
  assert.equal(findOriginalSubstring(original, 'role-truly'), 'role—truly');
  assert.equal(findOriginalSubstring(original, 'not present'), null);
});

run('reconcileOperationsWithParagraphs snaps target and substrings to document text', () => {
  const paragraphs = [{ index: 4, text: 'Led the “Atlas” migration—on time.' }];
  const [op] = reconcileOperationsWithParagraphs([
    {
      type: 'highlight',
      targetRef: 4,
      target: 'Led the "Atlas" migration-on time.',
      textToHighlight: '"Atlas" migration'
    }
  ], paragraphs);

  assert.equal(op.target, 'Led the “Atlas” migration—on time.');
  assert.equal(op.textToHighlight, '“Atlas” migration');
});

run('reconcileOperationsWithParagraphs leaves operations without a matching paragraph alone', () => {
  const [op] = reconcileOperationsWithParagraphs([
    { type: 'redline', targetRef: 9, target: 'untouched', modified: 'x' }
  ], [{ index: 1, text: 'something else' }]);
  assert.equal(op.target, 'untouched');
});

run('diceSimilarity basics', () => {
  assert.equal(diceSimilarity('alpha beta gamma', 'alpha beta gamma'), 1);
  assert.equal(diceSimilarity('alpha beta', 'zeta theta'), 0);
});

run('reconcileOperationsWithParagraphs re-anchors a lightly paraphrased target', () => {
  const paragraphs = [
    { index: 1, text: 'I enjoy unrelated work on infrastructure and reporting.' },
    { index: 2, text: 'I led the Atlas migration for the payments team and shipped it two weeks early with zero downtime.' }
  ];
  const [op] = reconcileOperationsWithParagraphs([
    {
      type: 'redline',
      targetRef: 1,
      target: 'I led the Atlas migration for the payments team and shipped it two weeks early with no downtime.',
      modified: 'I led the Atlas migration for the payments team, shipping two weeks early with zero downtime.'
    }
  ], paragraphs);

  assert.equal(op.targetRef, 2);
  assert.equal(op.target, paragraphs[1].text);
});

run('reconcileOperationsWithParagraphs refuses ambiguous re-anchoring', () => {
  const paragraphs = [
    { index: 1, text: 'I led the Atlas migration for the payments team and shipped it two weeks early.' },
    { index: 2, text: 'I led the Atlas migration for the platform team and shipped it two weeks early.' }
  ];
  const [op] = reconcileOperationsWithParagraphs([
    {
      type: 'redline',
      targetRef: 9,
      target: 'I led the Atlas migration for the team and shipped it two weeks early.',
      modified: 'I led the migration early.'
    }
  ], paragraphs);

  assert.equal(op.targetRef, 9);
  assert.equal(op.target, 'I led the Atlas migration for the team and shipped it two weeks early.');
});

run('formatJobDisplayName and getStatusLabel provide UI labels', () => {
  assert.equal(formatJobDisplayName({ company: 'Google', role: 'SWE' }), 'Google - SWE');
  assert.equal(getStatusLabel('tailoring'), 'Tailoring');
});

run('normalizePersistedJob coerces in-flight statuses to retry', () => {
  assert.equal(normalizePersistedJob({ id: 'x', status: 'tailoring' }).status, 'retry');
  assert.equal(normalizePersistedJob({ id: 'x', status: 'preparing' }).status, 'retry');
  assert.equal(normalizePersistedJob({ id: 'x', status: 'applying' }).status, 'retry');
  assert.equal(normalizePersistedJob({ id: 'x', status: 'done' }).status, 'done');
  assert.equal(normalizePersistedJob({ id: 'x', status: 'queued' }).status, 'queued');
  assert.equal(normalizePersistedJob({ id: 'x', status: 'retry' }).status, 'retry');
});

run('normalizePersistedJob restores generatedMode and hasAcceptBackup', () => {
  const job = normalizePersistedJob({ id: 'x', status: 'done', generatedMode: 'direct', hasAcceptBackup: { coverLetter: true, resume: false } });
  assert.equal(job.generatedMode, 'direct');
  assert.equal(job.hasAcceptBackup.coverLetter, true);
  assert.equal(job.hasAcceptBackup.resume, false);
  // Legacy sessions default to track mode and no backups.
  const legacy = normalizePersistedJob({ id: 'y', status: 'done' });
  assert.equal(legacy.generatedMode, 'track');
  assert.equal(legacy.hasAcceptBackup.coverLetter, false);
});

run('buildOutputFileName preserves mixed-case company tokens', () => {
  const name = buildOutputFileName({ company: 'McKinsey & Company', role: 'iOS developer' }, new Date('2026-07-05'));
  assert.match(name, /^McKinsey & Company - iOS Developer - Cover Letter - 072026\.docx$/);
});

run('buildOutputFileName title-cases fully-lowercase tokens', () => {
  const name = buildOutputFileName({ company: 'acme corp', role: 'product manager' }, new Date('2026-07-05'));
  assert.match(name, /^Acme Corp - Product Manager - Cover Letter - 072026\.docx$/);
});

run('computePopoverPlacement keeps preferred side when it fits', () => {
  const placement = computePopoverPlacement(
    { left: 100, top: 100, right: 200, bottom: 160, width: 100, height: 60 },
    { width: 180, height: 120 },
    { width: 700, height: 500 },
    'right'
  );
  assert.equal(placement.side, 'right');
  assert.equal(placement.left, 212);
});

run('computePopoverPlacement flips when target is at right edge', () => {
  const placement = computePopoverPlacement(
    { left: 620, top: 100, right: 690, bottom: 160, width: 70, height: 60 },
    { width: 180, height: 120 },
    { width: 700, height: 500 },
    'right'
  );
  assert.equal(placement.side, 'left');
  assert.equal(placement.left, 428);
});

run('computePopoverPlacement clamps inside tiny viewport', () => {
  const placement = computePopoverPlacement(
    { left: 180, top: 140, right: 220, bottom: 180, width: 40, height: 40 },
    { width: 220, height: 140 },
    { width: 240, height: 180 },
    'right'
  );
  assert.equal(placement.side, 'clamped');
  assert.ok(placement.left >= 12);
  assert.ok(placement.top >= 12);
  assert.ok(placement.left <= 28);
  assert.ok(placement.top <= 28);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
