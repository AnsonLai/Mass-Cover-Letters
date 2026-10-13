export function draftKeyFor(sourceKey) {
  return `wordcraft:draft:${sourceKey}`;
}

export async function fingerprintBlob(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new TypeError('A Blob is required to fingerprint a WordCraft draft source.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in this context.');
  }
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sourceFingerprint(store, sourceKey, blob) {
  const digest = await fingerprintBlob(blob);
  const epoch = await store.getJson(`${draftKeyFor(sourceKey)}:source-version`);
  return epoch == null ? digest : `${digest}:${epoch}`;
}

export async function bumpSourceVersion(store, sourceKey) {
  const key = `${draftKeyFor(sourceKey)}:source-version`;
  const current = await store.getJson(key);
  const next = (Number.isSafeInteger(current) && current >= 0 ? current : 0) + 1;
  await store.putJson(key, next);
  return next;
}

export async function readDraftBlob(store, sourceKey, sourceBlob) {
  if (!sourceBlob) return null;

  const record = await store.getDraft(draftKeyFor(sourceKey));
  if (!record?.blob || !record.sourceHash) return sourceBlob;
  return record.sourceHash === await sourceFingerprint(store, sourceKey, sourceBlob) ? record.blob : sourceBlob;
}

export async function saveDraft(store, sourceKey, sourceHash, blob) {
  const record = {
    sourceHash: String(sourceHash),
    blob,
    savedAt: new Date().toISOString()
  };
  await store.putDraft(draftKeyFor(sourceKey), record);
  return record;
}

export async function removeDraft(store, sourceKey) {
  await store.remove(draftKeyFor(sourceKey));
}
