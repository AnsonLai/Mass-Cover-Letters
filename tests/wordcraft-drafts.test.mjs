import test from 'node:test';
import assert from 'node:assert/strict';

import { createDocumentStore } from '../document-store.js';
import {
  draftKeyFor,
  bumpSourceVersion,
  fingerprintBlob,
  readDraftBlob,
  removeDraft,
  saveDraft,
  sourceFingerprint
} from '../wordcraft-drafts.js';

test('draft keys and records are independent for each source document', async () => {
  const store = await createDocumentStore();
  const sources = [
    ['base:source', 'base cover'],
    ['resume:source', 'base resume'],
    ['job:alpha:cover', 'job alpha cover'],
    ['job:alpha:resume', 'job alpha resume']
  ];

  for (const [sourceKey, sourceText] of sources) {
    const source = new Blob([sourceText]);
    const draft = new Blob([`edited ${sourceText}`]);
    await store.putBlob(sourceKey, source);
    await saveDraft(store, sourceKey, await fingerprintBlob(source), draft);
  }

  for (const [sourceKey, sourceText] of sources) {
    const source = await store.getBlob(sourceKey);
    assert.equal(await (await readDraftBlob(store, sourceKey, source)).text(), `edited ${sourceText}`);
  }

  assert.equal(draftKeyFor('base:source'), 'wordcraft:draft:base:source');
  assert.notEqual(draftKeyFor('base:source'), draftKeyFor('resume:source'));
  assert.equal(store.isPersistent, false);
});

test('fingerprintBlob returns a lowercase SHA-256 digest', async () => {
  assert.equal(
    await fingerprintBlob(new Blob(['abc'])),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('source version invalidates a draft when replacement bytes are identical', async () => {
  const store = await createDocumentStore();
  const key = 'job:alpha:cover';
  const original = new Blob(['same bytes']);
  const draft = new Blob(['manual edit']);
  const rawHash = await fingerprintBlob(original);

  assert.equal(await sourceFingerprint(store, key, original), rawHash);
  await saveDraft(store, key, await sourceFingerprint(store, key, original), draft);
  assert.equal(await (await readDraftBlob(store, key, original)).text(), 'manual edit');

  assert.equal(await bumpSourceVersion(store, key), 1);
  const replacement = new Blob(['same bytes']);
  assert.equal(await fingerprintBlob(replacement), rawHash);
  assert.equal(await sourceFingerprint(store, key, replacement), `${rawHash}:1`);
  assert.equal(await (await readDraftBlob(store, key, replacement)).text(), 'same bytes');
  assert.equal(await bumpSourceVersion(store, key), 2);
});

test('source hash invalidates an editor draft after regeneration or upload', async t => {
  for (const sourceChange of ['AI regeneration', 'upload']) {
    await t.test(sourceChange, async () => {
      const store = await createDocumentStore();
      const key = `source:${sourceChange}`;
      const original = new Blob(['source version one']);
      const draft = new Blob(['edited in WordCraft']);
      await store.putBlob(key, original);
      const sourceHash = await fingerprintBlob(original);
      await saveDraft(store, key, sourceHash, draft);

      const changedSource = new Blob([sourceChange === 'upload' ? 'uploaded replacement' : 'AI regenerated output']);
      await store.putBlob(key, changedSource);
      const selected = await readDraftBlob(store, key, await store.getBlob(key));
      assert.equal(await selected.text(), await changedSource.text());
      assert.notEqual(await fingerprintBlob(changedSource), sourceHash);
    });
  }
});

test('draft records clone metadata on read and preserve their Blob', async () => {
  const store = await createDocumentStore();
  const key = draftKeyFor('base:source');
  const blob = new Blob(['draft bytes']);
  await store.putDraft(key, { sourceHash: 'abc', blob, savedAt: '2026-10-12T00:00:00.000Z' });

  const firstRead = await store.getDraft(key);
  firstRead.sourceHash = 'mutated';
  firstRead.savedAt = 'mutated';
  assert.equal(await firstRead.blob.text(), 'draft bytes');

  const secondRead = await store.getDraft(key);
  assert.equal(secondRead.sourceHash, 'abc');
  assert.equal(secondRead.savedAt, '2026-10-12T00:00:00.000Z');
  assert.equal(await secondRead.blob.text(), 'draft bytes');
});

test('saving a draft does not overwrite the original source blob', async () => {
  const store = await createDocumentStore();
  const source = new Blob(['original source']);
  const draft = new Blob(['editor draft']);
  await store.putBlob('base:source', source);
  await saveDraft(store, 'base:source', await fingerprintBlob(source), draft);

  assert.equal(await (await store.getBlob('base:source')).text(), 'original source');
  assert.equal(await (await readDraftBlob(store, 'base:source', source)).text(), 'editor draft');
});

test('missing drafts return the source and failed writes propagate', async () => {
  const store = await createDocumentStore();
  const source = new Blob(['source']);
  assert.equal(await store.getDraft(draftKeyFor('missing')), null);
  assert.equal(await readDraftBlob(store, 'missing', source), source);

  const failingStore = {
    putDraft: async () => { throw new Error('storage full'); }
  };
  await assert.rejects(saveDraft(failingStore, 'source', 'hash', new Blob(['draft'])), /storage full/);
});

test('removeDraft removes only the draft entry', async () => {
  const store = await createDocumentStore();
  const source = new Blob(['source']);
  await store.putBlob('source', source);
  await saveDraft(store, 'source', await fingerprintBlob(source), new Blob(['draft']));
  await removeDraft(store, 'source');

  assert.equal(await store.getDraft(draftKeyFor('source')), null);
  assert.equal(await (await store.getBlob('source')).text(), 'source');
});
