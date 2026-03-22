import assert from 'node:assert/strict';

import {
  buildUserSettingsPromptBlock,
  normalizeGeminiModel,
  parseModelJsonObject,
  parseTailoringPayload
} from '../cover-letter-ai.js';
import {
  normalizeAndFilterOperations,
  chunkOperations
} from '../docx-engine.js';
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
  assert.equal(normalizeGeminiModel('bad-model'), 'gemini-2.5-flash');
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

run('formatJobDisplayName and getStatusLabel provide UI labels', () => {
  assert.equal(formatJobDisplayName({ company: 'Google', role: 'SWE' }), 'Google - SWE');
  assert.equal(getStatusLabel('tailoring'), 'Tailoring');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}