import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDocumentStore
} from '../document-store.js';

test('createDocumentStore persists blobs and json values in the adapter', async () => {
  const store = await createDocumentStore();

  await store.putBlob('doc-1', new Blob(['abc']));
  await store.putJson('meta-1', { ok: true });

  const savedBlob = await store.getBlob('doc-1');
  const savedJson = await store.getJson('meta-1');

  assert.equal(await savedBlob.text(), 'abc');
  assert.deepEqual(savedJson, { ok: true });
});
