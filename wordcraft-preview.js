import { createWordcraftSession } from './wordcraft-session.js?v=2026-10-12-drafts-epoch';

const editors = new WeakMap();
const REQUIRED_APIS = ['wordcraftLoad', 'wordcraftSnapshot', 'wordcraftAcknowledgeSave', 'wordcraftState'];

function rpc(editor, method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The editor did not respond. Your edits are still open; retry saving.')), 30000);
    Promise.resolve().then(() => editor.frame.contentWindow[method](...args))
      .then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function locked(editor, operation) {
  editor.locks += 1;
  editor.frame.inert = true;
  try { return await operation(); }
  finally { editor.locks -= 1; editor.frame.inert = editor.locks > 0 || editor.editingDisabled; }
}

function createEditor(host, store, report) {
  const frame = document.createElement('iframe');
  frame.className = 'wordcraft-preview-frame';
  frame.title = 'WordCraft document editor';
  frame.inert = true;
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  const footer = document.createElement('div');
  footer.className = 'wordcraft-export-note';
  const note = document.createElement('span');
  note.setAttribute('role', 'status');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry saving';
  retry.hidden = true;
  footer.append(note, retry);
  host.classList.add('wordcraft-preview-host');
  host.replaceChildren(frame, footer);
  const editor = { frame, locks: 0, editingDisabled: false, autoSaving: false, controller: null, timer: null };
  editors.set(host, editor);
  const onStatus = (status, error) => {
    retry.hidden = status !== 'error';
    footer.dataset.level = status === 'error' ? 'error' : 'info';
    if (status === 'error') {
      console.warn('[WordCraft save]', error);
      note.textContent = error?.name === 'QuotaExceededError'
        ? 'Browser storage is full. Your edits remain open. Save through WordCraft’s File menu, then retry.'
        : `Couldn’t save your edits. Your document remains open. ${error?.message || String(error)}`;
    } else if (editor.editingDisabled) {
      note.textContent = 'Editing is paused while tailoring.';
    } else if (!store.isPersistent) {
      note.textContent = 'Edits are saved for this tab only. Browser storage is unavailable; export before closing.';
    } else {
      note.textContent = status === 'saving' ? 'Saving edits…' : status === 'pending'
        ? 'New edits are waiting to save…' : status === 'saved' ? 'Edits saved in this browser.'
          : 'Edits save automatically in this browser and are included in Export.';
    }
  };
  editor.onStatus = onStatus;
  retry.onclick = () => flushWordcraftPreview(host).catch(() => {});
  editor.ready = (async () => {
    const response = await fetch('./vendor/wordcraft/index.html', { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) throw new Error('WordCraft build is missing. Run scripts/build-wordcraft.ps1.');
    frame.src = `./vendor/wordcraft/index.html?embed&drafts=${Date.now()}`;
    await new Promise((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        if (editors.get(host) !== editor) return reject(new Error('Editor closed during startup.'));
        try {
          const win = frame.contentWindow;
          const canvas = win?.document?.getElementById('wordcraft_canvas');
          const loading = win?.document?.getElementById('wordcraft_loading');
          if (canvas?.width > 0 && !loading && REQUIRED_APIS.every(api => typeof win[api] === 'function')) return resolve();
          if (loading && /failed|error|panicked/i.test(loading.textContent)) throw new Error(loading.textContent.trim());
          if (performance.now() - started > 90000) throw new Error('The editor’s draft-saving bridge did not start. Rebuild WordCraft and reload.');
          setTimeout(check, 250);
        } catch (error) { reject(error); }
      };
      setTimeout(check, 250);
    });
    editor.controller = createWordcraftSession({ store, onStatus, bridge: {
      state: () => rpc(editor, 'wordcraftState'),
      snapshot: name => rpc(editor, 'wordcraftSnapshot', name),
      acknowledge: revision => rpc(editor, 'wordcraftAcknowledgeSave', revision),
      load: (name, bytes) => rpc(editor, 'wordcraftLoad', name, bytes)
    } });
    editor.timer = setInterval(() => {
      if (!document.hidden && editor.locks === 0 && !editor.editingDisabled && !editor.autoSaving) {
        editor.autoSaving = true;
        editor.controller.flush().catch(() => {}).finally(() => { editor.autoSaving = false; });
      }
    }, 1000);
  })();
  report('Starting WordCraft…');
  return editor;
}

export function getActiveWordcraftBinding(host) {
  return editors.get(host)?.controller?.getActiveBinding() || null;
}

export function setWordcraftEditingEnabled(host, enabled) {
  const editor = editors.get(host);
  if (!editor) return;
  editor.editingDisabled = !enabled;
  editor.frame.inert = editor.locks > 0 || editor.editingDisabled;
  editor.onStatus('ready');
}

export async function flushWordcraftPreview(host, options = {}) {
  const editor = editors.get(host);
  if (!editor) return;
  await editor.ready;
  await locked(editor, () => editor.controller.flush({ settle: true, ...options }));
}

export async function clearWordcraftPreview(host) {
  const editor = editors.get(host);
  if (editor?.controller) await locked(editor, () => editor.controller.clear());
  if (editor?.timer) clearInterval(editor.timer);
  editors.delete(host);
  host.classList.remove('wordcraft-preview-host');
}

export async function renderWordcraftPreview(blob, host, report, binding) {
  let editor = editors.get(host);
  if (!editor) editor = createEditor(host, binding.store, report);
  await editor.ready;
  await locked(editor, () => editor.controller.open({ ...binding, sourceBlob: blob }));
  return true;
}
