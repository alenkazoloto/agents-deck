// The desk's Sessions folders in the browser: the list's folder filter, the folder editor (the
// desk's Rename…/Note…/Mark done/Delete… as one form) and "Move to folder…" on an open chat. The
// rules mirror `core/sessions/SessionFolders` and the Android app's FolderDialog; the machine checks
// them again, so these only spare a round trip.

import { h } from './dom.js';

/** `SessionFolders.NAME_MAX_LENGTH`: the machine trims a name to this. */
export const FOLDER_NAME_MAX = 60;

/** The filter's "No folder" choice; `undefined` is "All folders". */
export const UNFILED = '';

/** A done folder reads as the desk's combo reads it: finished work, still a place to file into. */
export const folderLabel = (folder) => (folder.done ? `${folder.name} (done)` : folder.name);

/** `SessionFolders.normalizeName`, so the clash check compares what the machine would store. */
export const normalizeFolderName = (raw) => (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, FOLDER_NAME_MAX);

/** `SessionFolders.normalizeNote`. */
const normalizeNote = (raw) => (raw ?? '').trim().slice(0, 500);

/** Why [raw] cannot name a folder, or null — the desk's two sentences. [exceptId] is the folder being renamed. */
export function folderNameProblem(raw, folders, exceptId) {
  const name = normalizeFolderName(raw);
  if (!name) return 'A folder needs a name.';
  const lower = name.toLowerCase();
  return folders.some((f) => f.id !== exceptId && f.name.toLowerCase() === lower) ? `A folder called "${name}" already exists.` : null;
}

/** The filter choice still names a folder the machine has; a folder deleted meanwhile falls back to all, as the desk's filter does. */
export const liveChoice = (fleet, choice) =>
  (choice === undefined || choice === UNFILED || fleet?.folders?.some((f) => f.id === choice) ? choice : undefined);

/** [fleet] with only the rows the folder filter keeps. */
export function inFolder(fleet, choice) {
  const c = liveChoice(fleet, choice);
  if (!fleet || c === undefined) return fleet;
  return { ...fleet, rows: fleet.rows.filter((r) => (c === UNFILED ? !r.folderId : r.folderId === c)) };
}

/** The fleet after `/v1/session-actions` filed [result.key]: the row's folder and the folders the machine now has. */
export function withSessionResult(fleet, result) {
  if (!fleet) return fleet;
  return { ...fleet, folders: result.folders, rows: fleet.rows.map((r) => (r.key === result.key ? { ...r, folderId: result.folderId || undefined } : r)) };
}

/** The fleet after `/v1/folder-actions`; a deleted folder's chats are in no folder at once, as the desk's are. */
export function withFolderResult(fleet, folderId, result, deleted) {
  if (!fleet) return fleet;
  const rows = deleted ? fleet.rows.map((r) => (r.folderId === folderId ? { ...r, folderId: undefined } : r)) : fleet.rows;
  return { ...fleet, folders: result.folders, rows };
}

/** The delete confirmation: the desk has no Undo for it, so the count is named first. */
export function deleteQuestion(folder) {
  const fate = folder.count === 0 ? 'It holds no chats.'
    : folder.count === 1 ? 'Its chat stays in the list, in no folder.'
      : `Its ${folder.count} chats stay in the list, in no folder.`;
  return `Delete the folder “${folder.name}”? ${fate}`;
}

/**
 * What the reader has typed into a folder form, kept across the frames that rebuild the view:
 * [editing] is the folder whose editor is open, [newName] the picker's "New folder" box.
 */
export const folderUi = { editing: null, opened: null, name: '', note: '', done: false, newName: '' };

/** [opened] is the folder as the form found it: a desk edit arriving meanwhile is not sent back over. */
export function startEditing(folder) {
  const opened = { name: folder.name, note: folder.note, done: folder.done };
  Object.assign(folderUi, { editing: folder.id, opened, ...opened });
}

/** Everything typed belongs to one pairing; the next machine's picker starts empty. */
export function forgetFolderDrafts() {
  Object.assign(folderUi, { editing: null, opened: null, name: '', note: '', done: false, newName: '' });
}

export const stopEditing = () => { folderUi.editing = null; };

/** What the reader changed since the form opened; absent fields are left as the machine has them. */
export function editedFields() {
  const folder = folderUi.opened;
  const changes = {};
  if (!folder) return changes;
  const name = normalizeFolderName(folderUi.name);
  const note = normalizeNote(folderUi.note);
  if (name !== folder.name) changes.name = name;
  if (note !== folder.note) changes.note = note;
  if (folderUi.done !== folder.done) changes.done = folderUi.done;
  return changes;
}

// ---- views ----------------------------------------------------------------------------------------

/**
 * The folder filter above the list, shown once the machine has folders. [choose] sets the filter
 * (undefined for all); the edit button appears for a chosen folder when the machine edits folders.
 */
export function folderFilterView(state, deck, choice, choose, rerender) {
  const folders = state.fleet?.folders ?? [];
  if (!deck.foldersOffered || !folders.length) return null;
  const c = liveChoice(state.fleet, choice);
  const chosen = folders.find((f) => f.id === c);
  const select = h('select', {
    'aria-label': 'Folder',
    onchange: (e) => { stopEditing(); choose(e.target.value === '*' ? undefined : e.target.value); },
  },
  h('option', { value: '*' }, 'All folders'),
  h('option', { value: UNFILED }, 'No folder'),
  folders.map((f) => h('option', { value: f.id }, folderLabel(f))));
  select.value = c === undefined ? '*' : c;
  const editing = chosen && folderUi.editing === chosen.id;
  return h('div', { class: 'folders' },
    h('div', { class: 'row' }, select,
      chosen && deck.folderEditOffered && !editing
        && h('button', { class: 'link', onclick: () => { startEditing(chosen); rerender(); } }, 'Edit folder')),
    chosen?.note && !editing && h('p', { class: 'dim folder-note' }, chosen.note),
    editing && folderEditorView(chosen, folders, deck, state.folders, rerender),
    !editing && state.folders?.notice && h('p', { class: 'dim', role: 'status' }, state.folders.notice));
}

/** The desk's folder menu as one form; Save sends only what changed here. */
function folderEditorView(folder, folders, deck, status, rerender) {
  const busy = !!status?.busy;
  const problem = folderNameProblem(folderUi.name, folders, folder.id);
  const unchanged = !Object.keys(editedFields()).length;
  const nameBox = h('input', {
    type: 'text', 'aria-label': 'Folder name', maxlength: String(FOLDER_NAME_MAX), autocomplete: 'off',
    oninput: (e) => { folderUi.name = e.target.value; rerender(); },
  });
  nameBox.value = folderUi.name;
  const noteBox = h('textarea', { rows: 2, placeholder: 'Note', 'aria-label': 'Folder note', oninput: (e) => { folderUi.note = e.target.value; rerender(); } });
  noteBox.value = folderUi.note;
  const doneBox = h('input', { type: 'checkbox', 'aria-label': 'Folder done', onchange: (e) => { folderUi.done = e.target.checked; rerender(); } });
  doneBox.checked = folderUi.done;
  const save = async () => { if (await deck.editFolder(folder.id, editedFields())) stopEditing(); rerender(); };
  const remove = async () => {
    if (!confirm(deleteQuestion(folder))) return;
    if (await deck.deleteFolder(folder.id)) stopEditing();
    rerender();
  };
  return h('section', { class: 'folder-editor', 'aria-label': 'Edit folder' },
    h('h2', {}, 'Edit folder'),
    nameBox,
    problem && h('p', { class: 'notice' }, problem),
    noteBox,
    h('label', { class: 'check' }, doneBox, ' Done', h('span', { class: 'dim' }, ' — sorts below the other folders; its chats stay listed')),
    status?.notice && h('p', { class: 'notice', role: 'alert' }, status.notice),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: busy || !!problem || unchanged, onclick: save }, 'Save'),
      h('button', { disabled: busy, onclick: () => { stopEditing(); rerender(); } }, 'Cancel'),
      h('button', { class: 'link danger', disabled: busy, onclick: remove }, 'Delete…')));
}

/** "Move to folder…" on the open chat: no folder, each folder, or a new one named here. */
export function movePickerView(state, deck, rerender) {
  const open = state.open;
  const folders = state.fleet?.folders ?? [];
  const current = state.fleet?.rows.find((r) => r.key === open.key)?.folderId;
  const busy = !!open.folderBusy;
  const typed = folderUi.newName;
  const problem = folderNameProblem(typed, folders);
  const choice = (label, id) => h('li', {},
    h('button', { class: 'row-open', disabled: busy, 'aria-current': (current ?? UNFILED) === id ? 'true' : undefined, onclick: () => deck.fileIn(id) },
      label, (current ?? UNFILED) === id && h('span', { class: 'dim' }, ' — here now')));
  const box = h('input', {
    type: 'text', placeholder: 'New folder', 'aria-label': 'New folder name', maxlength: String(FOLDER_NAME_MAX), autocomplete: 'off',
    oninput: (e) => { folderUi.newName = e.target.value; rerender(); },
  });
  box.value = typed;
  const create = async () => { if (await deck.fileInNew(typed)) folderUi.newName = ''; rerender(); };
  return h('section', { class: 'fork-picker', role: 'dialog', 'aria-label': 'Move to folder' },
    h('h2', {}, 'Move to folder'),
    h('ul', {}, choice('No folder', UNFILED), folders.map((f) => choice(folderLabel(f), f.id))),
    h('div', { class: 'row' }, box, h('button', { disabled: busy || !!problem, onclick: create }, 'Create and move')),
    typed.trim() && problem && h('p', { class: 'dim' }, problem),
    h('div', { class: 'row' }, h('button', { class: 'link', onclick: () => deck.dismissFolderPicker() }, 'Cancel')));
}
