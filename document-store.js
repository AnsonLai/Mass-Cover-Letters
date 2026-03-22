function cloneJsonValue(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

const DB_NAME = 'cover-letter-ai-store';
const DB_VERSION = 1;
const BLOBS_STORE = 'blobs';
const JSON_STORE = 'json';

function createMemoryStore() {
  const blobMap = new Map();
  const jsonMap = new Map();

  return {
    async putBlob(key, blob) {
      blobMap.set(String(key), blob);
    },
    async getBlob(key) {
      return blobMap.get(String(key)) || null;
    },
    async putJson(key, value) {
      jsonMap.set(String(key), cloneJsonValue(value));
    },
    async getJson(key) {
      const value = jsonMap.get(String(key));
      return value == null ? null : cloneJsonValue(value);
    },
    async remove(key) {
      const normalized = String(key);
      blobMap.delete(normalized);
      jsonMap.delete(normalized);
    }
  };
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionAsPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

async function openIndexedDb() {
  const indexedDb = globalThis.indexedDB;
  if (!indexedDb) {
    throw new Error('IndexedDB is unavailable');
  }

  const openRequest = indexedDb.open(DB_NAME, DB_VERSION);
  openRequest.onupgradeneeded = () => {
    const db = openRequest.result;
    if (!db.objectStoreNames.contains(BLOBS_STORE)) {
      db.createObjectStore(BLOBS_STORE);
    }
    if (!db.objectStoreNames.contains(JSON_STORE)) {
      db.createObjectStore(JSON_STORE);
    }
  };

  return requestAsPromise(openRequest);
}

function runStoreRequest(db, storeName, mode, operation) {
  const tx = db.transaction([storeName], mode);
  const store = tx.objectStore(storeName);
  const request = operation(store);
  return Promise.all([
    requestAsPromise(request),
    transactionAsPromise(tx)
  ]).then(([result]) => result);
}

function runRemoveRequest(db, key) {
  const tx = db.transaction([BLOBS_STORE, JSON_STORE], 'readwrite');
  tx.objectStore(BLOBS_STORE).delete(key);
  tx.objectStore(JSON_STORE).delete(key);
  return transactionAsPromise(tx);
}

function createIndexedDbStore(db) {
  return {
    async putBlob(key, blob) {
      await runStoreRequest(db, BLOBS_STORE, 'readwrite', store => store.put(blob, String(key)));
    },
    async getBlob(key) {
      const result = await runStoreRequest(db, BLOBS_STORE, 'readonly', store => store.get(String(key)));
      return result ?? null;
    },
    async putJson(key, value) {
      await runStoreRequest(db, JSON_STORE, 'readwrite', store => store.put(cloneJsonValue(value), String(key)));
    },
    async getJson(key) {
      const result = await runStoreRequest(db, JSON_STORE, 'readonly', store => store.get(String(key)));
      return result == null ? null : cloneJsonValue(result);
    },
    async remove(key) {
      await runRemoveRequest(db, String(key));
    }
  };
}

export async function createDocumentStore() {
  if (typeof indexedDB === 'undefined') {
    return createMemoryStore();
  }

  try {
    const db = await openIndexedDb();
    return createIndexedDbStore(db);
  } catch (error) {
    console.warn('[CoverLetter AI] Falling back to in-memory document store:', error?.message || String(error));
    return createMemoryStore();
  }
}