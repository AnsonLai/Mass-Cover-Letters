function copyParagraphs(paragraphs) {
  return paragraphs.map(paragraph => structuredClone(paragraph));
}

async function fingerprint(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable in this context.');
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createTailoringSourceCache({ openDocument, extractParagraphs, maxEntries = 2 }) {
  if (typeof openDocument !== 'function' || typeof extractParagraphs !== 'function') {
    throw new TypeError('openDocument and extractParagraphs functions are required.');
  }
  const entries = new Map();
  const limit = Math.max(1, Number.isInteger(maxEntries) ? maxEntries : 2);

  function retainMostRecent(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }

  return {
    async prepare(key, blob) {
      if (!blob || typeof blob.arrayBuffer !== 'function') throw new TypeError('A source Blob is required.');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const hash = await fingerprint(bytes);
      let entry = entries.get(key);
      if (!entry || entry.hash !== hash) {
        entry = { hash, bytes, documentClaimed: false, promise: null };
        retainMostRecent(key, entry);
        entry.promise = (async () => {
          const doc = await openDocument(bytes.slice());
          const paragraphs = await extractParagraphs(doc);
          entry.paragraphs = copyParagraphs(paragraphs);
          entry.initialDocument = doc;
        })().catch(error => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        });
      } else {
        // Refresh LRU ordering without changing the shared in-flight promise.
        retainMostRecent(key, entry);
      }

      await entry.promise;
      let doc;
      if (!entry.documentClaimed) {
        entry.documentClaimed = true;
        doc = entry.initialDocument;
        entry.initialDocument = null;
      } else {
        doc = await openDocument(entry.bytes.slice());
      }
      return { doc, paragraphs: copyParagraphs(entry.paragraphs) };
    },
    clear(key) {
      if (arguments.length) entries.delete(key);
      else entries.clear();
    }
  };
}
