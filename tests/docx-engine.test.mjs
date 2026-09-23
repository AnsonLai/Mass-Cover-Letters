import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOCX_REDLINE_VERSION,
  extractCanonicalParagraphText,
  normalizeAndFilterOperations,
  chunkOperations,
  describeOperationFailure
} from '../docx-engine.js';

function makeMockElement(tag, children = [], text = '') {
  const node = {
    nodeType: 1,
    localName: tag,
    namespaceURI: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    childNodes: children,
    textContent: text,
    parentNode: null
  };
  for (const child of children) {
    child.parentNode = node;
  }
  return node;
}

test('DOCX_REDLINE_VERSION is updated to 0.8.0', () => {
  assert.equal(DOCX_REDLINE_VERSION, '0.8.0');
});

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

test('extractCanonicalParagraphText evaluates canonical accepted text excluding deletions and preserving breaks', () => {
  const p = makeMockElement('p', [
    makeMockElement('r', [makeMockElement('t', [], 'Dear Hiring Manager,')]),
    makeMockElement('del', [makeMockElement('r', [makeMockElement('delText', [], ' I was fired.')])]),
    makeMockElement('ins', [makeMockElement('r', [makeMockElement('t', [], ' I am excited to apply.')])]),
    makeMockElement('r', [makeMockElement('tab')]),
    makeMockElement('r', [makeMockElement('t', [], 'Role:')]),
    makeMockElement('r', [makeMockElement('noBreakHyphen')]),
    makeMockElement('r', [makeMockElement('t', [], 'Lead')]),
    makeMockElement('r', [makeMockElement('softHyphen')]),
    makeMockElement('r', [makeMockElement('t', [], 'Engineer')])
  ]);

  const accepted = extractCanonicalParagraphText(p, { revisionView: 'accepted' });
  assert.equal(accepted, 'Dear Hiring Manager, I am excited to apply.\tRole:‑Lead\xadEngineer');

  const rejected = extractCanonicalParagraphText(p, { revisionView: 'rejected' });
  assert.equal(rejected, 'Dear Hiring Manager, I was fired.\tRole:‑Lead\xadEngineer');
});

test('describeOperationFailure formats structured error objects without [object Object]', () => {
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
