import { sourceFingerprint, readDraftBlob, saveDraft } from './wordcraft-drafts.js?v=2026-10-12-drafts-epoch';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// One serialized owner of the iframe. Bindings never follow mutable UI selection.
export function createWordcraftSession({ bridge, store, onStatus = () => {} }) {
  let active = null;
  let queue = Promise.resolve();
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  async function flushCurrent({ settle = false, allowCleanExternal = false } = {}) {
    if (!active) return;
    for (let attempt = 0; attempt < (settle ? 4 : 1); attempt += 1) {
      const state = await bridge.state();
      if (state.documentId !== active.documentId) {
        if (allowCleanExternal && !state.dirty) { active = null; return; }
        throw new Error('A different file was opened inside WordCraft. Save it through its File menu before reopening an application preview.');
      }
      if (state.revision === active.savedRevision) return;
      onStatus('saving');
      const snapshot = await bridge.snapshot(active.filename);
      if (snapshot.documentId !== active.documentId) throw new Error('The editor document changed while saving. Your edits remain open.');
      const blob = new Blob([snapshot.bytes], { type: DOCX_TYPE });
      await saveDraft(store, active.key, active.sourceHash, blob);
      // Acknowledge only after the Blob and source fingerprint are stored atomically.
      if (await bridge.acknowledge(snapshot.revision)) {
        active.savedRevision = snapshot.revision;
        onStatus('saved');
        return;
      }
      onStatus('pending');
    }
    if (settle) throw new Error('The document kept changing while saving. Please retry before switching or exporting.');
  }
  return {
    getActiveBinding() { return active ? { ...active } : null; },
    flush(options = {}) {
      return serialize(async () => {
        try { await flushCurrent(options); }
        catch (error) { onStatus('error', error); throw error; }
      });
    },
    open(binding) {
      return serialize(async () => {
        try {
          await flushCurrent({ settle: true, allowCleanExternal: true });
          const sourceHash = await sourceFingerprint(store, binding.key, binding.sourceBlob);
          if (active?.key === binding.key && active.sourceHash === sourceHash) {
            active.jobId = binding.jobId;
            active.previewType = binding.previewType;
            return;
          }
          const blob = await readDraftBlob(store, binding.key, binding.sourceBlob);
          const loaded = await bridge.load(binding.filename, new Uint8Array(await blob.arrayBuffer()));
          active = { ...binding, sourceHash, savedRevision: loaded.revision, documentId: loaded.documentId };
          onStatus('ready');
        } catch (error) { onStatus('error', error); throw error; }
      });
    },
    clear() { return serialize(async () => { await flushCurrent({ settle: true }); active = null; }); }
  };
}
