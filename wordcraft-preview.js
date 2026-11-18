import { createWordcraftSession } from './wordcraft-session.js?v=2026-11-10-state-ownership';

const editors = new WeakMap();
const REQUIRED_APIS = ['wordcraftLoad', 'wordcraftSnapshot', 'wordcraftAcknowledgeSave', 'wordcraftState'];

export function isWordcraftBindingDirty(state, binding) {
  return Boolean(binding && state.documentId === binding.documentId && state.revision !== binding.savedRevision);
}

export function shouldWarnBeforeWordcraftUnload(state, binding, pendingLocalEdit = false) {
  if (!binding) return false;
  if (pendingLocalEdit) return true;
  if (!state) return true;
  if (state.documentId !== binding.documentId) return state.dirty === true;
  return state.revision !== binding.savedRevision || state.dirty === true;
}

export function shouldReportAutosavePollError(statusErrorSource, lastPollErrorMessage, error) {
  const message = error?.message || String(error);
  return statusErrorSource !== 'session' && lastPollErrorMessage !== message;
}

export function isPotentialDocumentEdit(event) {
  if (['beforeinput', 'input', 'paste', 'cut', 'drop', 'compositionend'].includes(event.type)) return true;
  if (event.type !== 'keydown') return false;
  const key = event.key;
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return (event.ctrlKey || event.metaKey) && !event.altKey && ['b', 'i', 'u', 'x', 'v', 'z', 'y'].includes(key.toLowerCase());
  }
  return key === 'Backspace' || key === 'Delete' || key === 'Enter' || key === 'Tab' || key.length === 1;
}

export function isEditorSurfaceEvent(event, frameDocument) {
  const target = event.target;
  // Egui routes canvas keystrokes through a tiny, invisible body-level text input.
  // Match that narrow DOM signature while excluding ordinary inputs and selects.
  const formField = target?.closest?.('input, select');
  if (formField) {
    const bodyChildren = frameDocument.body?.children;
    const isEguiTextAgent = formField.tagName === 'INPUT' && formField.type === 'text' &&
      formField.parentElement === frameDocument.body && formField.style?.width === '1px' &&
      formField.style?.height === '1px' && bodyChildren?.length === 2 &&
      Array.from(bodyChildren).includes(formField) &&
      Array.from(bodyChildren).some(child => child.id === 'wordcraft_canvas');
    if (isEguiTextAgent) return true;
    return false;
  }
  // Other native text agents can use textarea / textbox nodes.
  if (target?.closest?.('textarea, [role="textbox"]')) return true;
  if (target?.id === 'wordcraft_canvas' || target?.closest?.('#wordcraft_canvas, [contenteditable="true"]')) return true;
  return frameDocument.activeElement?.id === 'wordcraft_canvas';
}

export function createWordcraftAutosaveSchedule({ idleMs = 900, maxWaitMs = 5000 } = {}) {
  let revision = null;
  let dirtySince = null;
  let changedAt = null;
  return {
    observe(state, now) {
      const changed = revision !== null && state.revision !== revision;
      revision = state.revision;
      if (state.dirty) {
        if (dirtySince === null) dirtySince = now;
        if (changed || changedAt === null) changedAt = now;
      } else {
        dirtySince = null;
        changedAt = null;
      }
    },
    due(now) {
      return dirtySince !== null && (now - changedAt >= idleMs || now - dirtySince >= maxWaitMs);
    },
    defer(now) {
      if (dirtySince !== null) { dirtySince = now; changedAt = now; }
    },
    reset() { revision = null; dirtySince = null; changedAt = null; }
  };
}

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
  const editor = {
    frame, locks: 0, editingDisabled: false, autoSaving: false, controller: null,
    timer: null, autosaveSchedule: null, lastObservedState: null, pendingLocalEdit: false, pendingLocalEditAt: null,
    beforeUnloadHandler: null, inputHandler: null, inputEventTarget: null,
    lastStatus: null, statusErrorSource: null, statusErrorMessage: null,
    lastPollErrorMessage: null, lastLoggedErrorMessage: null
  };
  editors.set(host, editor);
  editor.beforeUnloadHandler = event => {
    const binding = editor.controller?.getActiveBinding();
    if (!shouldWarnBeforeWordcraftUnload(editor.lastObservedState, binding, editor.pendingLocalEdit)) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', editor.beforeUnloadHandler);
  const onStatus = (status, error, source = 'session') => {
    const errorMessage = error ? error.message || String(error) : null;
    if (status === 'error' && editor.lastStatus === 'error' &&
      editor.statusErrorSource === source && editor.statusErrorMessage === errorMessage) return;
    editor.lastStatus = status;
    editor.statusErrorSource = status === 'error' ? source : null;
    editor.statusErrorMessage = status === 'error' ? errorMessage : null;
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
    editor.inputHandler = event => {
      if (!isPotentialDocumentEdit(event) || !isEditorSurfaceEvent(event, frameDocument) || editor.locks > 0 || editor.editingDisabled) return;
      const binding = editor.controller?.getActiveBinding();
      if (binding && editor.lastObservedState?.documentId === binding.documentId) {
        editor.pendingLocalEdit = true;
        editor.pendingLocalEditAt = performance.now();
      }
    };
    const frameDocument = frame.contentDocument;
    editor.inputEventTarget = frame.contentWindow;
    for (const type of ['beforeinput', 'input', 'paste', 'cut', 'drop', 'compositionend', 'keydown']) {
      editor.inputEventTarget?.addEventListener(type, editor.inputHandler, true);
    }
    editor.autosaveSchedule = createWordcraftAutosaveSchedule();
    let retryAfter = 0;
    editor.timer = setInterval(async () => {
      if (document.hidden || editor.locks > 0 || editor.editingDisabled || editor.autoSaving) return;
      editor.autoSaving = true;
      try {
        const state = await rpc(editor, 'wordcraftState');
        editor.lastLoggedErrorMessage = null;
        if (editor.lastPollErrorMessage) {
          editor.lastPollErrorMessage = null;
          if (editor.statusErrorSource === 'poll') editor.onStatus('ready');
        }
        editor.lastObservedState = state;
        const now = performance.now();
        const binding = editor.controller.getActiveBinding();
        const dirty = isWordcraftBindingDirty(state, binding);
        const activeState = { ...state, dirty };
        if (binding && state.documentId === binding.documentId) {
          if (dirty) editor.pendingLocalEdit = true;
          else if (editor.pendingLocalEdit && editor.pendingLocalEditAt !== null && now - editor.pendingLocalEditAt >= 1000) {
            editor.pendingLocalEdit = false;
            editor.pendingLocalEditAt = null;
          }
        }
        editor.autosaveSchedule.observe(activeState, now);
        if (editor.autosaveSchedule.due(now) && now >= retryAfter) {
          await editor.controller.flush();
          const afterSave = await rpc(editor, 'wordcraftState');
          editor.lastObservedState = afterSave;
          const afterBinding = editor.controller.getActiveBinding();
          const afterNow = performance.now();
          const savedState = {
            ...afterSave,
            dirty: isWordcraftBindingDirty(afterSave, afterBinding)
          };
          editor.autosaveSchedule.observe(savedState, afterNow);
          if (afterBinding && afterSave.documentId === afterBinding.documentId && !savedState.dirty) {
            editor.pendingLocalEdit = false;
            editor.pendingLocalEditAt = null;
          }
          editor.autosaveSchedule.defer(afterNow);
          retryAfter = 0;
        }
      } catch (error) {
        // Keep the draft pending so a later poll retries. Session flush failures
        // already call onStatus('error'); state RPC failures need their own visible
        // report because no session save path ran.
        if (!editor.statusErrorSource || editor.statusErrorSource !== 'session') {
          const message = error?.message || String(error);
          if (shouldReportAutosavePollError(editor.statusErrorSource, editor.lastPollErrorMessage, error)) {
            editor.lastPollErrorMessage = message;
            editor.onStatus('error', error, 'poll');
          }
        }
        const logMessage = error?.message || String(error);
        if (editor.lastLoggedErrorMessage !== logMessage) {
          editor.lastLoggedErrorMessage = logMessage;
          console.warn('[WordCraft autosave poll]', error);
        }
        retryAfter = performance.now() + 3000;
      } finally { editor.autoSaving = false; }
    }, 350);
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
  const state = await rpc(editor, 'wordcraftState');
  editor.lastObservedState = state;
  const binding = editor.controller.getActiveBinding();
  if (binding && state.documentId === binding.documentId && !isWordcraftBindingDirty(state, binding)) {
    editor.pendingLocalEdit = false;
    editor.pendingLocalEditAt = null;
  }
}

export async function clearWordcraftPreview(host, isCurrent = () => true) {
  const editor = editors.get(host);
  if (!isCurrent()) return;
  if (editor?.controller && !await locked(editor, () => editor.controller.clear(isCurrent))) return;
  if (!isCurrent() || editors.get(host) !== editor) return;
  if (editor?.timer) clearInterval(editor.timer);
  if (editor?.inputHandler) {
    for (const type of ['beforeinput', 'input', 'paste', 'cut', 'drop', 'compositionend', 'keydown']) {
      editor.inputEventTarget?.removeEventListener(type, editor.inputHandler, true);
    }
  }
  if (editor?.beforeUnloadHandler) window.removeEventListener('beforeunload', editor.beforeUnloadHandler);
  editors.delete(host);
  host.classList.remove('wordcraft-preview-host');
}

export async function renderWordcraftPreview(blob, host, report, binding, { isCurrent = () => true, canEdit = () => true } = {}) {
  let editor = editors.get(host);
  if (!editor) editor = createEditor(host, binding.store, report);
  await editor.ready;
  const ownsHost = () => isCurrent() && editors.get(host) === editor;
  if (!ownsHost()) return false;
  return locked(editor, async () => {
    editor.editingDisabled = !canEdit();
    const opened = await editor.controller.open({ ...binding, sourceBlob: blob }, ownsHost);
    if (!opened) return false;
    editor.pendingLocalEdit = false;
    editor.pendingLocalEditAt = null;
    editor.lastObservedState = await rpc(editor, 'wordcraftState');
    editor.autosaveSchedule?.reset();
    return ownsHost();
  });
}
