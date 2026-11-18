import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWordcraftAutosaveSchedule,
  isWordcraftBindingDirty,
  isPotentialDocumentEdit,
  isEditorSurfaceEvent,
  shouldReportAutosavePollError,
  shouldWarnBeforeWordcraftUnload
} from '../wordcraft-preview.js';

test('autosave dirtiness follows the active binding revision even after native File Save', () => {
  const binding = { documentId: 'active-doc', savedRevision: 4 };
  assert.equal(isWordcraftBindingDirty({ documentId: 'active-doc', revision: 5, dirty: false }, binding), true);
  assert.equal(isWordcraftBindingDirty({ documentId: 'active-doc', revision: 4, dirty: true }, binding), false);
  assert.equal(isWordcraftBindingDirty({ documentId: 'foreign-doc', revision: 9, dirty: true }, binding), false);
});

test('unload warning covers immediate pending edits and unsaved revisions only for the active document', () => {
  const binding = { documentId: 'active-doc', savedRevision: 4 };
  assert.equal(shouldWarnBeforeWordcraftUnload({ documentId: 'active-doc', revision: 4 }, binding), false);
  assert.equal(shouldWarnBeforeWordcraftUnload({ documentId: 'active-doc', revision: 5, dirty: false }, binding), true);
  assert.equal(shouldWarnBeforeWordcraftUnload({ documentId: 'active-doc', revision: 4 }, binding, true), true);
  assert.equal(shouldWarnBeforeWordcraftUnload({ documentId: 'foreign-doc', revision: 9, dirty: true }, binding), true);
  assert.equal(shouldWarnBeforeWordcraftUnload({ documentId: 'foreign-doc', revision: 9, dirty: false }, binding), false);
  assert.equal(shouldWarnBeforeWordcraftUnload({ documentId: 'foreign-doc', revision: 9, dirty: false }, binding, true), true);
  assert.equal(shouldWarnBeforeWordcraftUnload({ documentId: 'active-doc', revision: 9, dirty: true }, null, true), false);
  assert.equal(shouldWarnBeforeWordcraftUnload(null, binding), true);
  assert.equal(shouldWarnBeforeWordcraftUnload(null, binding, true), true);
});

test('unload edit marker ignores navigation and non-editing shortcuts', () => {
  assert.equal(isPotentialDocumentEdit({ type: 'keydown', key: 'a' }), true);
  assert.equal(isPotentialDocumentEdit({ type: 'keydown', key: 'Backspace' }), true);
  assert.equal(isPotentialDocumentEdit({ type: 'keydown', key: 'b', ctrlKey: true }), true);
  assert.equal(isPotentialDocumentEdit({ type: 'keydown', key: 'c', ctrlKey: true }), false);
  assert.equal(isPotentialDocumentEdit({ type: 'keydown', key: 'a', ctrlKey: true }), false);
  assert.equal(isPotentialDocumentEdit({ type: 'keydown', key: 'ArrowLeft' }), false);
  assert.equal(isPotentialDocumentEdit({ type: 'keydown', key: 'f', ctrlKey: true, altKey: true }), false);
});

test('poll errors are surfaced once without replacing session save errors', () => {
  const unavailable = new Error('The editor did not respond.');
  assert.equal(shouldReportAutosavePollError(null, null, unavailable), true);
  assert.equal(shouldReportAutosavePollError('poll', unavailable.message, unavailable), false);
  assert.equal(shouldReportAutosavePollError('poll', unavailable.message, new Error('Retry failed')), true);
  assert.equal(shouldReportAutosavePollError('session', null, unavailable), false);
});

test('surface filter allows the native editor textarea but ignores ordinary form fields', () => {
  const frameDocument = { activeElement: { id: 'wordcraft_canvas' } };
  const target = (kind) => ({
    id: kind === 'canvas' ? 'wordcraft_canvas' : '',
    closest(selector) {
      if (selector === 'input, select') return kind === 'search' ? {} : null;
      if (selector === 'textarea, [role="textbox"]') return kind === 'native-textarea' ? {} : null;
      if (selector === '#wordcraft_canvas, [contenteditable="true"]') return kind === 'canvas' ? {} : null;
      return null;
    }
  });
  assert.equal(isEditorSurfaceEvent({ target: target('native-textarea') }, frameDocument), true);
  assert.equal(isEditorSurfaceEvent({ target: target('canvas') }, frameDocument), true);
  assert.equal(isEditorSurfaceEvent({ target: target('search') }, frameDocument), false);
  assert.equal(isEditorSurfaceEvent({ target: { closest: () => null } }, { activeElement: { id: 'search' } }), false);

  const canvas = { id: 'wordcraft_canvas' };
  const body = { children: [] };
  const eguiInput = {
    tagName: 'INPUT', type: 'text', style: { width: '1px', height: '1px' }, parentElement: body,
    closest(selector) { return selector === 'input, select' ? this : null; }
  };
  body.children = [canvas, eguiInput];
  assert.equal(isEditorSurfaceEvent({ target: eguiInput }, { body, activeElement: eguiInput }), true);
});

test('autosave waits for a typing pause, with a bounded wait during continuous edits', () => {
  const schedule = createWordcraftAutosaveSchedule({ idleMs: 900, maxWaitMs: 5000 });
  schedule.observe({ revision: 1, dirty: false }, 0);
  assert.equal(schedule.due(1000), false);

  schedule.observe({ revision: 2, dirty: true }, 1000);
  assert.equal(schedule.due(1899), false);
  assert.equal(schedule.due(1900), true);

  schedule.observe({ revision: 3, dirty: true }, 1800);
  assert.equal(schedule.due(2600), false);
  schedule.observe({ revision: 4, dirty: true }, 2600);
  schedule.observe({ revision: 5, dirty: true }, 3400);
  schedule.observe({ revision: 6, dirty: true }, 4200);
  schedule.observe({ revision: 7, dirty: true }, 5000);
  schedule.observe({ revision: 8, dirty: true }, 5800);
  assert.equal(schedule.due(5999), false);
  assert.equal(schedule.due(6000), true);
  schedule.defer(6000);
  assert.equal(schedule.due(6001), false);
  assert.equal(schedule.due(6900), true);
});

test('autosave schedule clears after a clean state and can reset across documents', () => {
  const schedule = createWordcraftAutosaveSchedule();
  schedule.observe({ revision: 4, dirty: true }, 100);
  assert.equal(schedule.due(1000), true);
  schedule.observe({ revision: 4, dirty: false }, 1100);
  assert.equal(schedule.due(7000), false);

  schedule.observe({ revision: 1, dirty: false }, 8000);
  assert.equal(schedule.due(9000), false);
  schedule.observe({ revision: 2, dirty: true }, 9100);
  assert.equal(schedule.due(9999), false);
  assert.equal(schedule.due(10000), true);
});
