import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  DOCX_REDLINE_VERSION,
  extractCanonicalParagraphText,
  extractParagraphsFromDocumentXml,
  extractDocumentParagraphs,
  normalizeAndFilterOperations,
  reconcileOperationsWithParagraphs,
  chunkOperations,
  describeOperationFailure,
  summarizeOperationFailures,
  findOriginalSubstring,
  diceSimilarity,
  normalizeForMatch,
  ingestDocxFile,
  loadDocxFromBlob,
  generateBlobFromDoc,
  applyOperationsInBatches,
  acceptAllTrackedChangesInDoc,
  loadEngineDependencies
} from '../docx-engine.js';

const require = createRequire(import.meta.url);

async function createTestDocxBytes(paragraphs = ['First paragraph.', 'Second paragraph for testing.']) {
  let JSZipCtor = null;
  const candidatePaths = [
    '../../Docx Redline JS/node_modules/jszip',
    '../Docx Redline JS/node_modules/jszip',
    'jszip'
  ];

  for (const p of candidatePaths) {
    try {
      JSZipCtor = require(p);
      if (JSZipCtor) break;
    } catch { }
  }

  if (!JSZipCtor) {
    throw new Error('JSZip required for generating test DOCX fixture');
  }

  const zip = new JSZipCtor();

  const contentTypesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const pNodes = paragraphs.map((text, idx) =>
    `<w:p w14:paraId="${(idx + 1).toString(16).padStart(8, '0')}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">` +
    `<w:r><w:t>${text}</w:t></w:r>` +
    `</w:p>`
  ).join('');

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${pNodes}</w:body>` +
    '</w:document>';

  const docRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

  zip.file('[Content_Types].xml', contentTypesXml);
  zip.file('_rels/.rels', relsXml);
  zip.file('word/_rels/document.xml.rels', docRelsXml);
  zip.file('word/document.xml', documentXml);

  return zip.generateAsync({ type: 'uint8array' });
}

function createMockBlob(bytes, name = 'test.docx') {
  return {
    name,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

test('DOCX_REDLINE_VERSION is strictly 0.8.0', () => {
  assert.equal(DOCX_REDLINE_VERSION, '0.8.0');
});

test('ingestDocxFile parses valid docx and inspects paragraphs', async () => {
  const bytes = await createTestDocxBytes(['Dear Hiring Manager,', 'I am writing to apply for the position.']);
  const file = createMockBlob(bytes, 'application.docx');

  const result = await ingestDocxFile(file);
  assert.equal(result.fileName, 'application.docx');
  assert.equal(result.paragraphs.length, 2);
  assert.equal(result.paragraphs[0].index, 1);
  assert.equal(result.paragraphs[0].ref, 'P1');
  assert.equal(result.paragraphs[0].text, 'Dear Hiring Manager,');
  assert.equal(result.paragraphs[1].index, 2);
  assert.equal(result.paragraphs[1].ref, 'P2');
  assert.equal(result.paragraphs[1].text, 'I am writing to apply for the position.');
  assert.match(result.fullText, /Dear Hiring Manager/);
});

test('ingestDocxFile rejects non-docx file types', async () => {
  const file = { name: 'resume.pdf' };
  await assert.rejects(
    async () => ingestDocxFile(file),
    /Only \.docx files are supported/
  );
});

test('applyOperationsInBatches executes redline with track changes', async () => {
  const bytes = await createTestDocxBytes(['Original intro.', 'Original body paragraph.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  const applyRes = await applyOperationsInBatches({
    doc,
    operations: [
      {
        type: 'redline',
        targetRef: 1,
        target: 'Original intro.',
        modified: 'Tailored executive intro.'
      }
    ],
    author: 'Application Station',
    generateRedlines: true
  });

  assert.equal(applyRes.validation.ok, true);
  assert.equal(applyRes.failures.length, 0);
  assert.equal(applyRes.results.length, 1);
  assert.equal(applyRes.results[0].success, true);

  const inspectAfter = doc.inspect({ revisionView: 'accepted' });
  assert.equal(inspectAfter.paragraphs[0].text, 'Tailored executive intro.');

  const inspectRejected = doc.inspect({ revisionView: 'rejected' });
  assert.equal(inspectRejected.paragraphs[0].text, 'Original intro.');
});

test('applyOperationsInBatches executes localized exact replacements', async () => {
  const bytes = await createTestDocxBytes(['I have five years of experience in JavaScript.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  const applyRes = await applyOperationsInBatches({
    doc,
    operations: [
      {
        type: 'redline',
        targetRef: 1,
        target: 'I have five years of experience in JavaScript.',
        replacements: [
          { find: 'five years', replace: 'seven years' },
          { find: 'JavaScript', replace: 'TypeScript and Node.js' }
        ]
      }
    ],
    author: 'Application Station',
    generateRedlines: true
  });

  assert.equal(applyRes.validation.ok, true);
  assert.equal(applyRes.results[0].success, true);
  const inspectAccepted = doc.inspect({ revisionView: 'accepted' });
  assert.equal(inspectAccepted.paragraphs[0].text, 'I have seven years of experience in TypeScript and Node.js.');
});

test('applyOperationsInBatches handles direct edit mode (generateRedlines: false)', async () => {
  const bytes = await createTestDocxBytes(['Baseline statement.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  const applyRes = await applyOperationsInBatches({
    doc,
    operations: [
      {
        type: 'redline',
        targetRef: 1,
        target: 'Baseline statement.',
        modified: 'Direct updated statement.'
      }
    ],
    author: 'Application Station',
    generateRedlines: false
  });

  assert.equal(applyRes.validation.ok, true);
  assert.equal(applyRes.results[0].success, true);

  const inspectAccepted = doc.inspect({ revisionView: 'accepted' });
  const inspectRejected = doc.inspect({ revisionView: 'rejected' });
  assert.equal(inspectAccepted.paragraphs[0].text, 'Direct updated statement.');
  assert.equal(inspectRejected.paragraphs[0].text, 'Direct updated statement.');
});

test('applyOperationsInBatches records failure gracefully when target is not found', async () => {
  const bytes = await createTestDocxBytes(['Real paragraph.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  const applyRes = await applyOperationsInBatches({
    doc,
    operations: [
      {
        type: 'redline',
        targetRef: 99,
        target: 'Completely missing sentence that does not exist.',
        modified: 'Replacement text.'
      }
    ],
    author: 'Application Station',
    generateRedlines: true
  });

  assert.equal(applyRes.results.length, 1);
  assert.equal(applyRes.results[0].success, false);
  assert.equal(applyRes.failures.length, 1);
  assert.match(applyRes.failures[0], /redline on P99:/);
  assert.doesNotMatch(applyRes.failures[0], /\[object Object\]/);
});

test('acceptAllTrackedChangesInDoc accepts pending revisions', async () => {
  const bytes = await createTestDocxBytes(['Initial text before review.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  await applyOperationsInBatches({
    doc,
    operations: [
      {
        type: 'redline',
        targetRef: 1,
        target: 'Initial text before review.',
        modified: 'Accepted final text.'
      }
    ],
    author: 'Reviewer',
    generateRedlines: true
  });

  const acceptOutcome = await acceptAllTrackedChangesInDoc({ doc, allAuthors: true });
  assert.equal(acceptOutcome.hasChanges, true);
  assert.ok(acceptOutcome.acceptedCount > 0);

  const inspectAfter = doc.inspect({ revisionView: 'accepted' });
  assert.equal(inspectAfter.paragraphs[0].text, 'Accepted final text.');

  // Running accept again should report no changes
  const secondAccept = await acceptAllTrackedChangesInDoc({ doc, allAuthors: true });
  assert.equal(secondAccept.hasChanges, false);
  assert.equal(secondAccept.acceptedCount, 0);
});

test('generateBlobFromDoc produces valid docx blob that can be re-opened', async () => {
  const bytes = await createTestDocxBytes(['Round-trip test paragraph.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  const blob = await generateBlobFromDoc(doc);
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  // Re-open from generated blob
  const reloadedDoc = await loadDocxFromBlob(blob);
  const inspection = reloadedDoc.inspect();
  assert.equal(inspection.paragraphs.length, 1);
  assert.equal(inspection.paragraphs[0].text, 'Round-trip test paragraph.');
});

test('normalizeAndFilterOperations filters invalid ops and preserves localized replacements', () => {
  const rawOps = [
    null,
    undefined,
    123,
    {},
    { type: 'redline', targetRef: 'P1', target: '[P1] Hello', modified: '[P1] World' },
    { type: 'redline', targetRef: 2, target: 'Keep', replacements: [{ find: 'a', replace: 'b' }] },
    { type: 'redline', targetRef: 3, target: 'No action' }, // missing modified and replacements
    { type: 'comment', targetRef: 'P4', target: 'Text', textToComment: '[P4] Exact', commentContent: 'A comment' },
    { type: 'comment', targetRef: 'P4', target: 'Text', textToComment: 'Exact' }, // missing commentContent
    { type: 'highlight', targetRef: 5, target: 'Text', textToHighlight: 'Exact', color: 'invalid_color' },
    { type: 'highlight', targetRef: 6, target: 'Text', textToHighlight: 'Exact', color: 'cyan' },
    { type: 'highlight', targetRef: 7, target: 'Text' } // missing textToHighlight
  ];

  const filtered = normalizeAndFilterOperations(rawOps);
  assert.equal(filtered.length, 5);

  // #0: standard redline
  assert.equal(filtered[0].type, 'redline');
  assert.equal(filtered[0].targetRef, 1);
  assert.equal(filtered[0].target, 'Hello');
  assert.equal(filtered[0].modified, 'World');

  // #1: localized replacements redline
  assert.equal(filtered[1].type, 'redline');
  assert.equal(filtered[1].targetRef, 2);
  assert.deepEqual(filtered[1].replacements, [{ find: 'a', replace: 'b' }]);

  // #2: comment with stripped marker
  assert.equal(filtered[2].type, 'comment');
  assert.equal(filtered[2].targetRef, 4);
  assert.equal(filtered[2].textToComment, 'Exact');
  assert.equal(filtered[2].commentContent, 'A comment');

  // #3: highlight with invalid color coerced to yellow
  assert.equal(filtered[3].type, 'highlight');
  assert.equal(filtered[3].color, 'yellow');

  // #4: highlight with valid color preserved
  assert.equal(filtered[4].type, 'highlight');
  assert.equal(filtered[4].color, 'cyan');
});

test('chunkOperations handles edge cases', () => {
  assert.deepEqual(chunkOperations([], 2), []);
  assert.deepEqual(chunkOperations([1, 2, 3], 0), [[1, 2, 3]]);
  assert.deepEqual(chunkOperations([1, 2, 3], -1), [[1, 2, 3]]);
  assert.deepEqual(chunkOperations([1, 2, 3], 'invalid'), [[1, 2, 3]]);
  assert.deepEqual(chunkOperations([1, 2, 3], 10), [[1, 2, 3]]);
  assert.deepEqual(chunkOperations([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test('error boundaries for missing inputs', async () => {
  await assert.rejects(async () => loadDocxFromBlob(null), /Missing document blob/);
  await assert.rejects(async () => generateBlobFromDoc(null), /Missing document instance/);
  await assert.rejects(async () => applyOperationsInBatches({ doc: null }), /Missing document instance/);
  await assert.rejects(async () => acceptAllTrackedChangesInDoc({ doc: null }), /Missing document instance/);
  await assert.rejects(async () => extractDocumentParagraphs(null), /Unsupported document format/);
});

test('applyOperationsInBatches handles empty operations gracefully', async () => {
  const bytes = await createTestDocxBytes(['Paragraph one.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  const res = await applyOperationsInBatches({
    doc,
    operations: [],
    author: 'Author'
  });

  assert.deepEqual(res.results, []);
  assert.equal(res.validation.ok, true);
  assert.deepEqual(res.failures, []);
});

test('ingestDocxFile handles document with zero text paragraphs', async () => {
  const bytes = await createTestDocxBytes([]);
  const file = createMockBlob(bytes);
  const { doc, paragraphs, fullText } = await ingestDocxFile(file);

  assert.ok(doc);
  assert.deepEqual(paragraphs, []);
  assert.equal(fullText, '');
});

test('applyOperationsInBatches applies comment and highlight operations', async () => {
  const bytes = await createTestDocxBytes(['Payment is due upon receipt.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  const res = await applyOperationsInBatches({
    doc,
    operations: [
      {
        type: 'comment',
        targetRef: 1,
        target: 'Payment is due upon receipt.',
        textToComment: 'Payment',
        commentContent: 'Please verify terms.'
      },
      {
        type: 'highlight',
        targetRef: 1,
        target: 'Payment is due upon receipt.',
        textToHighlight: 'receipt',
        color: 'yellow'
      }
    ],
    author: 'Reviewer'
  });

  assert.equal(res.validation.ok, true);
  assert.equal(res.failures.length, 0);
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].success, true);
  assert.equal(res.results[1].success, true);

  const inspect = doc.inspect();
  assert.ok(inspect.comments.length > 0 || doc.entries.has('word/comments.xml'));
});

test('applyOperationsInBatches applies sequential batches across distinct paragraphs', async () => {
  const bytes = await createTestDocxBytes(['Section A.', 'Section B.', 'Section C.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  let progressCallCount = 0;
  const res = await applyOperationsInBatches({
    doc,
    batchSize: 1,
    operations: [
      { type: 'redline', targetRef: 1, target: 'Section A.', modified: 'Updated Section A.' },
      { type: 'redline', targetRef: 2, target: 'Section B.', modified: 'Updated Section B.' },
      { type: 'redline', targetRef: 3, target: 'Section C.', modified: 'Updated Section C.' }
    ],
    author: 'Reviewer',
    onProgress: () => { progressCallCount += 1; }
  });

  assert.equal(res.validation.ok, true);
  assert.equal(res.results.length, 3);
  assert.ok(res.results.every(r => r.success));
  assert.equal(progressCallCount, 3);

  const inspect = doc.inspect({ revisionView: 'accepted' });
  assert.equal(inspect.paragraphs[0].text, 'Updated Section A.');
  assert.equal(inspect.paragraphs[1].text, 'Updated Section B.');
  assert.equal(inspect.paragraphs[2].text, 'Updated Section C.');
});

test('applyOperationsInBatches handles mixed valid and invalid operations in same batch', async () => {
  const bytes = await createTestDocxBytes(['Existing clause.']);
  const file = createMockBlob(bytes);
  const { doc } = await ingestDocxFile(file);

  const res = await applyOperationsInBatches({
    doc,
    operations: [
      { type: 'redline', targetRef: 1, target: 'Existing clause.', modified: 'Modified clause.' },
      { type: 'redline', targetRef: 99, target: 'Ghost clause.', modified: 'Never applied.' }
    ],
    author: 'Reviewer'
  });

  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].success, true);
  assert.equal(res.results[1].success, false);
  assert.equal(res.failures.length, 1);
  assert.match(res.failures[0], /P99/);

  // Valid change landed
  const inspect = doc.inspect({ revisionView: 'accepted' });
  assert.equal(inspect.paragraphs[0].text, 'Modified clause.');
});

test('reconcileOperationsWithParagraphs snaps typographical differences', () => {
  const paragraphs = [
    { index: 1, text: 'I’m happy to join the “Platform” team—immediately.' }
  ];

  const operations = [
    {
      type: 'comment',
      targetRef: 1,
      target: "I'm happy to join the \"Platform\" team-immediately.",
      textToComment: "\"Platform\" team",
      commentContent: 'Great choice'
    },
    {
      type: 'highlight',
      targetRef: 1,
      target: "I'm happy to join the \"Platform\" team-immediately.",
      textToHighlight: 'team-immediately',
      color: 'yellow'
    }
  ];

  const reconciled = reconcileOperationsWithParagraphs(operations, paragraphs);
  assert.equal(reconciled[0].target, 'I’m happy to join the “Platform” team—immediately.');
  assert.equal(reconciled[0].textToComment, '“Platform” team');
  assert.equal(reconciled[1].textToHighlight, 'team—immediately');
});

