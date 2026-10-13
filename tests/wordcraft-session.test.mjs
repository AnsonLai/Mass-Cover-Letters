import test from 'node:test';
import assert from 'node:assert/strict';

import { createDocumentStore } from '../document-store.js';
import { draftKeyFor, bumpSourceVersion } from '../wordcraft-drafts.js';
import { createWordcraftSession } from '../wordcraft-session.js';

function binding(key, text, jobId = key, previewType = 'cover') {
  return {
    key,
    sourceBlob: new Blob([text]),
    filename: `${key}.docx`,
    jobId,
    previewType
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('explicit replacement reloads byte-identical sources and ignores prior edits', async () => {
  const store = await createDocumentStore();
  const mock = mockBridge();
  const session = createWordcraftSession({ bridge: mock.bridge, store });
  const source = binding('job:cover', 'original');
  await session.open(source);
  mock.setState({ ...mock.getState(), revision: 2, dirty: true });
  await session.flush({ settle: true });
  await bumpSourceVersion(store, source.key);
  await session.open(source);
  assert.equal(mock.loads.length, 2);
  assert.equal(mock.loads[1].text, 'original');
});

function mockBridge({ beforeLoad, afterLoad, beforeAck, snapshotBytes } = {}) {
  let current = { revision: 0, documentId: null, dirty: false };
  const loads = [];
  const snapshots = [];
  const acknowledgements = [];
  const bridge = {
    async state() { return { ...current }; },
    async snapshot(filename) {
      snapshots.push({ filename, ...current });
      const bytes = snapshotBytes?.(current, snapshots.length) ?? `edit-${current.documentId}-${current.revision}`;
      return {
        bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
        revision: current.revision,
        documentId: current.documentId,
        dirty: current.dirty
      };
    },
    async acknowledge(revision) {
      acknowledgements.push(revision);
      const accepted = await beforeAck?.(revision, current, acknowledgements.length);
      if (accepted === false) return false;
      if (current.documentId) current = { ...current, revision, dirty: false };
      return true;
    },
    async load(filename, bytes) {
      const text = new TextDecoder().decode(bytes);
      loads.push({ filename, text });
      await beforeLoad?.(filename, text, loads.length);
      const documentId = `document-${loads.length}`;
      current = { revision: 1, documentId, dirty: false };
      const loaded = { ...current };
      await afterLoad?.(filename, loaded, loads.length);
      return loaded;
    }
  };
  return {
    bridge,
    loads,
    snapshots,
    acknowledgements,
    setState(state) { current = { ...state }; },
    getState() { return { ...current }; }
  };
}

function watchStore(store) {
  const writes = [];
  const originalPutDraft = store.putDraft.bind(store);
  store.putDraft = async (key, record) => {
    writes.push({ key, sourceHash: record.sourceHash, blob: record.blob });
    return originalPutDraft(key, record);
  };
  return { store, writes };
}

test('rapid A → resume → B opens serialize and keep draft keys isolated', async () => {
  const store = await createDocumentStore();
  const gate = deferred();
  const firstLoadStarted = deferred();
  const mock = mockBridge({
    beforeLoad: async (_filename, _text, count) => {
      if (count === 1) {
        firstLoadStarted.resolve();
        await gate.promise;
      }
    },
    afterLoad: async (_filename, state) => {
      mock.setState({ ...state, revision: state.revision + 1, dirty: true });
    }
  });
  const session = createWordcraftSession({ bridge: mock.bridge, store });

  const openingA = session.open(binding('job-a:cover', 'A source', 'job-a', 'cover'));
  const openingResume = session.open(binding('resume:source', 'resume source', 'job-a', 'resume'));
  const openingB = session.open(binding('job-b:cover', 'B source', 'job-b', 'cover'));
  await firstLoadStarted.promise;
  assert.deepEqual(mock.loads.map(load => load.filename), ['job-a:cover.docx']);
  gate.resolve();
  await Promise.all([openingA, openingResume, openingB]);
  await session.flush({ settle: true });

  assert.deepEqual(mock.loads.map(load => load.text), ['A source', 'resume source', 'B source']);
  assert.equal(session.getActiveBinding().key, 'job-b:cover');
  assert.equal(session.getActiveBinding().jobId, 'job-b');
  for (const key of ['job-a:cover', 'resume:source', 'job-b:cover']) {
    assert.ok(await store.getDraft(draftKeyFor(key)), `expected a saved draft for ${key}`);
  }
});

test('autosave stores a draft and a new session reloads it for the same source hash', async () => {
  const store = await createDocumentStore();
  const source = binding('base:source', 'original letter');
  const mock = mockBridge({ snapshotBytes: () => 'edited letter bytes' });
  const first = createWordcraftSession({ bridge: mock.bridge, store });
  await first.open(source);
  mock.setState({ revision: 2, documentId: 'document-1', dirty: true });
  await first.flush({ settle: true });
  assert.equal(await (await store.getDraft(draftKeyFor(source.key))).blob.text(), 'edited letter bytes');

  const reloadMock = mockBridge();
  const second = createWordcraftSession({ bridge: reloadMock.bridge, store });
  await second.open(source);
  assert.equal(reloadMock.loads[0].text, 'edited letter bytes');
});

test('source regeneration/upload changes invalidate an older saved draft', async t => {
  for (const kind of ['regenerated', 'uploaded']) {
    await t.test(kind, async () => {
      const store = await createDocumentStore();
      const original = binding('job:cover', 'old generated file', 'job', 'cover');
      const initial = mockBridge({ snapshotBytes: () => 'old editor draft' });
      const first = createWordcraftSession({ bridge: initial.bridge, store });
      await first.open(original);
      initial.setState({ revision: 3, documentId: 'document-1', dirty: true });
      await first.flush({ settle: true });

      const changed = binding('job:cover', `${kind} source file`, 'job', 'cover');
      const nextMock = mockBridge();
      const next = createWordcraftSession({ bridge: nextMock.bridge, store });
      await next.open(changed);
      assert.equal(nextMock.loads[0].text, `${kind} source file`);
    });
  }
});

test('reopening the same key and source fingerprint updates metadata without reloading', async () => {
  const store = await createDocumentStore();
  const mock = mockBridge();
  const session = createWordcraftSession({ bridge: mock.bridge, store });
  await session.open(binding('job:cover', 'same source', 'job-1', 'cover'));
  await session.open(binding('job:cover', 'same source', 'job-2', 'resume'));

  assert.equal(mock.loads.length, 1);
  assert.equal(session.getActiveBinding().jobId, 'job-2');
  assert.equal(session.getActiveBinding().previewType, 'resume');
});

test('storage failure prevents save acknowledgement, switching, and settled flush; retry succeeds', async () => {
  const baseStore = await createDocumentStore();
  let failWrites = true;
  const store = {
    ...baseStore,
    getDraft: baseStore.getDraft.bind(baseStore),
    putDraft: async (...args) => {
      if (failWrites) throw new Error('storage full');
      return baseStore.putDraft(...args);
    },
    remove: baseStore.remove.bind(baseStore)
  };
  const mock = mockBridge();
  const session = createWordcraftSession({ bridge: mock.bridge, store });
  await session.open(binding('job-a:cover', 'A source'));
  mock.setState({ revision: 2, documentId: 'document-1', dirty: true });

  await assert.rejects(session.flush({ settle: true }), /storage full/);
  assert.deepEqual(mock.acknowledgements, []);
  await assert.rejects(session.open(binding('job-b:cover', 'B source')), /storage full/);
  assert.equal(mock.loads.length, 1);

  failWrites = false;
  await session.flush({ settle: true });
  await session.open(binding('job-b:cover', 'B source'));
  assert.equal(mock.acknowledgements.length, 1);
  assert.equal(mock.loads.length, 2);
});

test('a new edit during acknowledgement is resnapshotted before settled flush returns', async () => {
  const store = await createDocumentStore();
  const mock = mockBridge({
    snapshotBytes: (_state, number) => `settled edit ${number}`,
    beforeAck: (_revision, state, number) => {
      if (number === 1) {
        mock.setState({ revision: state.revision + 1, documentId: state.documentId, dirty: true });
        return false;
      }
      return true;
    }
  });
  const session = createWordcraftSession({ bridge: mock.bridge, store });
  await session.open(binding('job:cover', 'source'));
  mock.setState({ revision: 2, documentId: 'document-1', dirty: true });

  await session.flush({ settle: true });
  assert.deepEqual(mock.snapshots.map(snapshot => snapshot.revision), [2, 3]);
  assert.deepEqual(mock.acknowledgements, [2, 3]);
  assert.equal(await (await store.getDraft(draftKeyFor('job:cover'))).blob.text(), 'settled edit 2');
});

test('an outside File Open document cannot be saved under the prior application key', async () => {
  const baseStore = await createDocumentStore();
  const { store, writes } = watchStore(baseStore);
  const mock = mockBridge();
  const session = createWordcraftSession({ bridge: mock.bridge, store });
  await session.open(binding('job:cover', 'source'));
  mock.setState({ revision: 9, documentId: 'user-opened-file', dirty: true });

  await assert.rejects(session.flush({ settle: true }), /different file was opened/);
  assert.equal(mock.snapshots.length, 0);
  assert.equal(mock.acknowledgements.length, 0);
  assert.deepEqual(writes, []);
});

test('a clean user-saved foreign document can be replaced by a selected preview', async () => {
  const store = await createDocumentStore();
  const mock = mockBridge();
  const session = createWordcraftSession({ bridge: mock.bridge, store });
  await session.open(binding('job-a:cover', 'A source'));
  mock.setState({ revision: 7, documentId: 'user-file-after-save', dirty: false });

  await session.open(binding('job-b:cover', 'B source'));
  assert.equal(mock.loads.length, 2);
  assert.equal(session.getActiveBinding().key, 'job-b:cover');
  assert.deepEqual(mock.snapshots, []);
  assert.deepEqual(mock.acknowledgements, []);
});

test('failed preview loading leaves the previous active document binding in place', async () => {
  const store = await createDocumentStore();
  const mock = mockBridge({ beforeLoad: async (filename) => {
    if (filename === 'job-b:cover.docx') throw new Error('load failed');
  } });
  const session = createWordcraftSession({ bridge: mock.bridge, store });
  await session.open(binding('job-a:cover', 'A source', 'job-a'));

  await assert.rejects(session.open(binding('job-b:cover', 'B source', 'job-b')), /load failed/);
  assert.equal(session.getActiveBinding().key, 'job-a:cover');
  assert.equal(session.getActiveBinding().jobId, 'job-a');
});
