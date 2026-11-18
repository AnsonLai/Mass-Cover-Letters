import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadDocxZipFromBlob, extractDocumentParagraphs, applyOperationsInBatches } from '../docx-engine.js';

import { createTailoringSourceCache } from '../tailoring-source-cache.js';

test('real DOCX jobs reuse source inspection without leaking one job’s edits into another', async () => {
  let inspections = 0;
  const cache = createTailoringSourceCache({
    openDocument: bytes => loadDocxZipFromBlob(new Blob([bytes])),
    extractParagraphs: doc => { inspections += 1; return extractDocumentParagraphs(doc); }
  });
  const source = new Blob([await readFile(new URL('./fixtures/wordcraft-export-a.docx', import.meta.url))]);
  const [a, b] = await Promise.all([cache.prepare('base', source), cache.prepare('base', source)]);
  const edited = await applyOperationsInBatches({ doc: a.doc, operations: [{ type: 'redline', targetRef: 1, target: 'JOB_A_ORIGINAL', modified: 'Job A only' }], generateRedlines: false });
  assert.equal(edited.failures.length, 0);
  assert.equal((await extractDocumentParagraphs(a.doc))[0].text, 'Job A only');
  assert.equal((await extractDocumentParagraphs(b.doc))[0].text, 'JOB_A_ORIGINAL');
  const c = await cache.prepare('base', source);
  assert.equal(c.paragraphs[0].text, 'JOB_A_ORIGINAL');
  assert.equal((await extractDocumentParagraphs(c.doc))[0].text, 'JOB_A_ORIGINAL');
  assert.equal(inspections, 1);
});

function harness({ failFirstOpen = false } = {}) {
  let opens = 0;
  let extractions = 0;
  return {
    get opens() { return opens; },
    get extractions() { return extractions; },
    cache: createTailoringSourceCache({
      async openDocument(bytes) {
        opens += 1;
        if (failFirstOpen && opens === 1) throw new Error('temporary open failure');
        return { bytes: new Uint8Array(bytes), annotations: [] };
      },
      async extractParagraphs(doc) {
        extractions += 1;
        return [{ index: 1, text: new TextDecoder().decode(doc.bytes), meta: { tags: ['source'] } }];
      }
    })
  };
}

test('same source shares extraction but every caller receives an isolated mutable document', async () => {
  const state = harness();
  const { cache } = state;
  const blob = new Blob(['base document']);
  const [first, second] = await Promise.all([
    cache.prepare('base:source', blob),
    cache.prepare('base:source', blob)
  ]);

  assert.equal(state.extractions, 1);
  assert.equal(state.opens, 2);
  assert.notStrictEqual(first.doc, second.doc);
  first.doc.annotations.push('job A mutation');
  first.paragraphs[0].text = 'changed paragraph';
  first.paragraphs[0].meta.tags.push('changed');

  assert.deepEqual(second.doc.annotations, []);
  assert.equal(second.paragraphs[0].text, 'base document');
  assert.deepEqual(second.paragraphs[0].meta.tags, ['source']);

  const third = await cache.prepare('base:source', blob);
  assert.equal(state.extractions, 1);
  assert.notStrictEqual(second.doc, third.doc);
  assert.equal(third.paragraphs[0].text, 'base document');
});

test('changed bytes replace the cached extraction for the source key', async () => {
  const { cache } = harness();
  const first = await cache.prepare('resume:source', new Blob(['old resume']));
  const replacement = await cache.prepare('resume:source', new Blob(['edited resume']));

  assert.equal(new TextDecoder().decode(first.doc.bytes), 'old resume');
  assert.equal(new TextDecoder().decode(replacement.doc.bytes), 'edited resume');
  assert.equal(replacement.paragraphs[0].text, 'edited resume');
});

test('failed source preparation is evicted so a later attempt can retry', async () => {
  const { cache } = harness({ failFirstOpen: true });
  const source = new Blob(['retryable']);
  await assert.rejects(cache.prepare('job:cover', source), /temporary open failure/);

  const recovered = await cache.prepare('job:cover', source);
  assert.equal(new TextDecoder().decode(recovered.doc.bytes), 'retryable');
  assert.equal(recovered.paragraphs[0].text, 'retryable');
});

test('clear can invalidate one key or the entire cache', async () => {
  const state = harness();
  const { cache } = state;
  const source = new Blob(['same']);
  await cache.prepare('a', source);
  await cache.prepare('b', source);
  cache.clear('a');
  await cache.prepare('a', source);
  assert.equal(state.extractions, 3);
  cache.clear();
  await cache.prepare('b', source);
  assert.equal(state.extractions, 4);
});
