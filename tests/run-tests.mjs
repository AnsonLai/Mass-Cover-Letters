import assert from 'node:assert/strict';

import {
  buildUserSettingsPromptBlock,
  normalizeGeminiModel,
  parseModelJsonObject,
  parseTailoringPayload
} from '../cover-letter-ai.js';
import {
  normalizeAndFilterOperations,
  chunkOperations,
  describeOperationFailure,
  summarizeOperationFailures,
  findOriginalSubstring,
  reconcileOperationsWithParagraphs
} from '../docx-engine.js';
import { DEFAULT_GEMINI_MODEL } from '../constants.js';
import {
  formatJobDisplayName,
  getStatusLabel
} from '../ui.js';

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

run('describeOperationFailure distinguishes engine errors from missing targets', () => {
  assert.equal(
    describeOperationFailure({ type: 'redline', targetRef: 4, success: false, error: 'boom' }),
    'redline on P4: boom'
  );
  assert.equal(
    describeOperationFailure({ type: 'highlight', targetRef: 0, success: false, error: null }),
    'highlight on unknown paragraph: target text was not found in the document'
  );
});

run('summarizeOperationFailures keeps only unsuccessful operations', () => {
  const failures = summarizeOperationFailures([
    { type: 'redline', targetRef: 1, success: true },
    { type: 'redline', targetRef: 2, success: false, error: null }
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /redline on P2/);
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

run('formatJobDisplayName and getStatusLabel provide UI labels', () => {
  assert.equal(formatJobDisplayName({ company: 'Google', role: 'SWE' }), 'Google - SWE');
  assert.equal(getStatusLabel('tailoring'), 'Tailoring');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}