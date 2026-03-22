import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAndFilterOperations,
  chunkOperations
} from '../docx-engine.js';

test('normalizeAndFilterOperations strips paragraph marker prefixes and invalid rows', () => {
  const ops = normalizeAndFilterOperations([
    { type: 'COMMENT', targetRef: 'P12', target: '[P12] Payment is due', textToComment: '[P12] Payment', commentContent: 'Check timing' },
    { type: 'redline', target: 'No ref', modified: '' },
    { type: 'highlight', targetRef: 'P5', target: '[P5] Term', textToHighlight: '[P5] Term', color: 'invalid' }
  ]);

  assert.equal(ops.length, 2);
  assert.equal(ops[0].type, 'comment');
  assert.equal(ops[0].targetRef, 12);
  assert.equal(ops[0].target, 'Payment is due');
  assert.equal(ops[1].color, 'yellow');
});

test('chunkOperations splits operation list into fixed-size batches', () => {
  const chunks = chunkOperations([1, 2, 3, 4, 5], 2);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], [1, 2]);
  assert.deepEqual(chunks[1], [3, 4]);
  assert.deepEqual(chunks[2], [5]);
});
