// Review notes attach via @review-notes:, expanded by the machine on send.
// Reattachment and feedback chips require their own capabilities.
// Lenient decoders match core/mobile via test/fixtures/review-notes.json.

import { h } from './dom.js';
import { PROTOCOL_VERSION } from './wire.js';

const str = (o, k) => (typeof o?.[k] === 'string' ? o[k] : undefined);
const line = (o, k) => (Number.isInteger(o?.[k]) && o[k] > 0 ? o[k] : 1);
const objects = (o, k) => (Array.isArray(o?.[k]) ? o[k].filter((e) => e && typeof e === 'object') : []);

export const CURRENT = 'current';
export const BASELINE = 'baseline';

/** `MobileReviewNoteRequest.BODY_BYTES`, the desk's own bound, checked before sending. */
export const BODY_BYTES = 16 * 1024;

const bytes = (s) => new TextEncoder().encode(s).length;

/** `MobileReviewNote`; a state this client does not know is resolved, so it is never offered for attaching. */
export const decodeNote = (o) => {
  const startLine = line(o, 'startLine');
  return {
    id: str(o, 'id') ?? '',
    path: str(o, 'path') ?? '',
    side: str(o, 'side') === BASELINE ? BASELINE : CURRENT,
    startLine,
    endLine: Math.max(startLine, line(o, 'endLine')),
    quote: str(o, 'quote') ?? '',
    body: str(o, 'body') ?? '',
    state: ['open', 'delivered'].includes(str(o, 'state')) ? o.state : 'resolved',
    outdated: o?.outdated === true,
  };
};

/** `MobileReviewNotes`: every write answers the whole list too, which replaces the one shown. */
export const decodeNotes = (o) => ({
  key: str(o, 'key') ?? '',
  notes: objects(o, 'notes').map(decodeNote).filter((n) => n.id),
  pending: objects(o, 'pending').map((p) => ({
    batchId: str(p, 'batchId') ?? '',
    // Anything but a known failure is delivery unknown: a Retry, never a silent send.
    state: str(p, 'state') === 'failed' ? 'failed' : 'unknown',
    notes: Number.isInteger(p.notes) && p.notes > 0 ? p.notes : 0,
  })).filter((p) => p.batchId),
  token: str(o, 'token')?.trim() || undefined,
  chips: objects(o, 'chips').map((c) => ({
    batchId: str(c, 'batchId') ?? '',
    token: str(c, 'token') ?? '',
    path: str(c, 'path') ?? '',
    // As for pending: a state this client does not know is delivery unknown, a Retry, never a silent send.
    state: ['attached', 'failed'].includes(str(c, 'state')) ? c.state : 'unknown',
    notes: objects(c, 'notes').map(decodeNote).filter((n) => n.id),
  })).filter((c) => c.batchId && c.token && c.path),
});

/** `POST /v1/review/{key}/notes` (`MobileReviewNoteRequest`); the fields an op does not name stay off the wire. */
export const noteRequestBody = (key, { op, noteId, noteIds, batchId, path, side, startLine, endLine, quote, body }, operationId) => {
  const o = { v: PROTOCOL_VERSION, key, op, operationId };
  if (noteId) o.noteId = noteId;
  if (noteIds?.length) o.noteIds = noteIds;
  if (batchId) o.batchId = batchId;
  if (path) o.path = path;
  o.side = side ?? CURRENT;
  o.startLine = startLine ?? 0;
  o.endLine = endLine ?? 0;
  if (quote !== undefined) o.quote = quote;
  if (body !== undefined) o.body = body;
  return o;
};

export const notesOffered = (capabilities) => !!capabilities?.includes('review-notes');
export const reattachOffered = (capabilities) => !!capabilities?.includes('review-note-reattach');

/** [draft] with [token] after it, one space apart, as the phone and the desk put it there. */
export const withToken = (draft, token) => {
  const typed = (draft ?? '').trimEnd();
  return typed ? `${typed} ${token}` : token;
};

/**
 * A hunk's lines numbered on both sides: a `-` line has only its session-start number, a `+` line
 * only its current one, context both; `\ No newline…` has neither and takes no note.
 */
export const numberedLines = (hunk) => {
  let before = hunk.beforeStart;
  let after = hunk.afterStart;
  return hunk.lines.map((text) => {
    if (text[0] === '+') return { text, after: after++ };
    if (text[0] === '-') return { text, before: before++ };
    if (text[0] === '\\') return { text };
    return { text, before: before++, after: after++ };
  });
};

/** The side a new note on [row] is about: the file now wherever the line still exists. */
const sideOf = (row) => (row.after !== undefined ? CURRENT : BASELINE);
const numberOn = (row, side) => (side === CURRENT ? row.after : row.before);
const noteLine = (row, side) => ({ number: numberOn(row, side), text: row.text.slice(1) });

const lineLabel = (start, end) => (start === end ? `line ${start}` : `lines ${start}–${end}`);
const sideLabel = (side) => (side === BASELINE ? 'session start' : 'current');
const fileName = (path) => path.slice(path.lastIndexOf('/') + 1) || path;

export const attachLabel = (n) => (n === 0 ? 'Attach to message' : n === 1 ? 'Attach 1 note to message' : `Attach ${n} notes to message`);

/** The desk's card status line: outdated first, then the note's lifecycle. */
export const noteStatus = (note) => {
  const state = note.state === 'open' ? 'Open' : note.state === 'delivered' ? 'Delivered' : 'Resolved';
  return note.outdated ? `Saved location is outdated · ${sideLabel(note.side)}` : `${state} · ${sideLabel(note.side)}`;
};

const pendingText = (p) => {
  const notes = p.notes === 1 ? '1 note' : `${p.notes} notes`;
  return p.state === 'failed' ? `Feedback was not delivered (${notes}). Your notes are saved.` : `Feedback delivery is unknown (${notes}). Your notes are saved.`;
};

const noteLocation = (note) => `${fileName(note.path)} · ${lineLabel(note.startLine, note.endLine)}`;

const editorDraftKey = (key, e) => `review-note:${key}:${e.noteId ? `edit:${e.noteId}` : `add:${e.path}:${e.side}:${e.lines[0].number}`}`;

export const canSave = (e) => !!e && !e.saving && !!e.body.trim() && bytes(e.body) <= BODY_BYTES;

/**
 * The open chat's notes, kept by the deck in `open.changes.notes`:
 * `{data, loading, error, listing, history, selected, busy, editor, moving}`; [moving] is the note
 * "Reattach" picked, whose next clicked diff line becomes its new place. A write whose answer never
 * arrived keeps its operation id, so the same write tried again is answered with the first
 * outcome instead of a second note; any definite answer retires it.
 */
export class ReviewNotes {
  /**
   * @param {object} deps
   * @param {()=>({key:string, notes:object|null})|null} deps.current the open chat with Changes shown
   * @param {(key:string, patch:object)=>void} deps.patch merges into that chat's notes
   * @param {()=>import('./bridge.js').Bridge|null} deps.bridge
   * @param {(error:any)=>boolean} deps.failed a revoked token handled, or a refusal to show: true when handled
   * @param {(error:any)=>string} deps.describe
   * @param {(key:string, message:string)=>void} deps.say the panel's status line, or the chat's when Changes closed
   * @param {(key:string, token:string, message:string)=>Promise<void>} deps.attached puts the token into the chat's draft
   * @param {()=>number} deps.generation the pairing; an answer from an older one is dropped
   * @param {()=>string} deps.mintId
   * @param {import('./store.js').Store} deps.store unsaved note text, by its lines
   * @param {(key:string, data:object)=>void} [deps.adopted] every list the machine answered for [key], Changes open or not
   */
  constructor(deps) {
    this.deps = deps;
    /** `{json, operationId}` of the write whose answer never arrived. */
    this.uncertain = null;
    /** Bumped by every read and every write's answer: a read answered after a newer list was adopted is dropped. */
    this.seq = 0;
    /** The box the next render should focus: a note opened from the keyboard lands in its text. */
    this.focus = null;
  }

  /** The label to focus once, after the render that opened an editor. */
  takeFocus() {
    const label = this.focus;
    this.focus = null;
    return label;
  }

  #state(key) {
    const c = this.deps.current();
    return c?.key === key ? c.notes : null;
  }

  #patch(key, patch) {
    this.deps.patch(key, patch);
  }

  /** The machine's list, keeping ticks only on notes still open; a note being reattached that is gone stops the move. */
  #adopt(key, data) {
    this.deps.adopted?.(key, data);
    const s = this.#state(key);
    if (!s) return;
    const open = new Set(data.notes.filter((n) => n.state === 'open').map((n) => n.id));
    const gone = !!s.moving && !data.notes.some((n) => n.id === s.moving);
    this.#patch(key, {
      data, selected: s.selected.filter((id) => open.has(id)),
      ...(gone && { moving: null, editor: s.editor?.reattach ? null : s.editor }),
    });
    if (gone) this.deps.say(key, (s.editor?.reattach && s.editor.error) || 'That review note no longer exists.');
  }

  /** Read again whenever Changes or the list opens: the desk resolves and delivers notes behind the browser's back. */
  async load() {
    const c = this.deps.current();
    const bridge = this.deps.bridge();
    if (!c || !bridge) return;
    const { key } = c;
    const gen = this.deps.generation();
    const seq = ++this.seq;
    this.#patch(key, { ...(c.notes ?? { data: null, listing: false, history: false, selected: [], busy: false, editor: null, moving: null }), loading: true, error: null });
    // The machine reads the list without waiting for a write: an older read must not undo a write's answer.
    const latest = () => gen === this.deps.generation() && seq === this.seq;
    try {
      const data = await bridge.reviewNotes(key);
      if (!latest()) return;
      this.#patch(key, { loading: false });
      this.#adopt(key, data);
    } catch (error) {
      if (gen !== this.deps.generation() || this.deps.failed(error) || !latest()) return;
      this.#patch(key, { loading: false, error: this.deps.describe(error) });
    }
  }

  openList() {
    const c = this.deps.current();
    if (!c?.notes) return;
    this.#patch(c.key, { listing: true });
    return this.load();
  }

  closeList() {
    const c = this.deps.current();
    if (c?.notes) this.#patch(c.key, { listing: false });
  }

  toggleHistory() {
    const c = this.deps.current();
    if (c?.notes) this.#patch(c.key, { history: !c.notes.history });
  }

  toggle(noteId) {
    const c = this.deps.current();
    const s = c?.notes;
    if (!s?.data?.notes.some((n) => n.id === noteId && n.state === 'open')) return;
    this.#patch(c.key, { selected: s.selected.includes(noteId) ? s.selected.filter((id) => id !== noteId) : [...s.selected, noteId] });
  }

  /** The list's "Reattach": the list closes so the reader can click the note's new line in a diff. */
  startMove(noteId) {
    const c = this.deps.current();
    if (!c?.notes?.data?.notes.some((n) => n.id === noteId)) return;
    this.#patch(c.key, { moving: noteId, listing: false, editor: null });
  }

  cancelMove() {
    const c = this.deps.current();
    const s = c?.notes;
    if (!s?.moving || s.editor?.saving) return;
    this.#patch(c.key, { moving: null, editor: s.editor?.reattach ? null : s.editor });
  }

  /**
   * A diff line clicked: a new note on it, with the text left there last time — or, while a note is
   * [moving], that note offered for reattaching there. [rows] is its hunk, numbered.
   */
  async startAdd(path, rows, index) {
    const c = this.deps.current();
    const row = rows[index];
    if (!c?.notes || !row || (row.before === undefined && row.after === undefined)) return;
    const side = sideOf(row);
    // The other side's rows are skipped, not a stop: a side's numbers run on through them (the phone's `mapNotNull`).
    const following = rows.slice(index + 1).filter((r) => numberOn(r, side) !== undefined).map((r) => noteLine(r, side));
    const moving = c.notes.moving && this.#saved(c, c.notes.moving);
    if (moving) {
      if (c.notes.editor?.saving) return;
      // The saved text goes along unchanged: only the lines are being chosen.
      this.focus = null;
      this.#patch(c.key, { editor: { path, side, lines: [noteLine(row, side)], following, body: moving.body, noteId: moving.id, reattach: true, saving: false, error: null } });
      return;
    }
    const editor = { path, side, lines: [noteLine(row, side)], following, body: '', noteId: null, saving: false, error: null };
    this.focus = 'Review note';
    this.#patch(c.key, { editor });
    await this.#restoreText(c.key, editor);
  }

  async startEdit(note) {
    const c = this.deps.current();
    if (!c?.notes) return;
    const lines = note.quote.split('\n').map((text, i) => ({ number: note.startLine + i, text }));
    const editor = { path: note.path, side: note.side, lines, following: [], body: note.body, noteId: note.id, saving: false, error: null };
    this.focus = 'Review note';
    this.#patch(c.key, { editor });
    await this.#restoreText(c.key, editor);
  }

  async #restoreText(key, editor) {
    const saved = await this.deps.store.draft(editorDraftKey(key, editor)).catch(() => '');
    const s = this.#state(key);
    // Only into the editor it was read for, and never over what was typed meanwhile.
    if (saved && s?.editor && s.editor.noteId === editor.noteId && s.editor.path === editor.path
      && s.editor.lines[0].number === editor.lines[0].number && s.editor.body === editor.body) {
      this.#patch(key, { editor: { ...s.editor, body: saved } });
    }
  }

  /** "Next line": a new or reattached note widens over the hunk's following line on the same side. */
  extend() {
    const c = this.deps.current();
    const e = c?.notes?.editor;
    if (!e || (e.noteId && !e.reattach) || e.saving || e.following.length === 0) return;
    this.#patch(c.key, { editor: { ...e, lines: [...e.lines, e.following[0]], following: e.following.slice(1) } });
  }

  /** As typed; the text is kept by its lines until a save consumes it. */
  editBody(text) {
    const c = this.deps.current();
    const e = c?.notes?.editor;
    if (!e || e.reattach) return;
    this.#patch(c.key, { editor: { ...e, body: text, error: null } });
    this.deps.store.saveDraft(editorDraftKey(c.key, e), text === (e.noteId ? this.#saved(c, e.noteId)?.body : '') ? '' : text).catch(() => {});
  }

  #saved(c, noteId) {
    return c.notes?.data?.notes.find((n) => n.id === noteId);
  }

  cancelEditor() {
    const c = this.deps.current();
    if (c?.notes?.editor && !c.notes.editor.saving) this.#patch(c.key, { editor: null });
  }

  async save() {
    const c = this.deps.current();
    const e = c?.notes?.editor;
    if (!canSave(e)) return;
    const { key } = c;
    const lines = { path: e.path, side: e.side, startLine: e.lines[0].number, endLine: e.lines[e.lines.length - 1].number, quote: e.lines.map((l) => l.text).join('\n') };
    const request = e.reattach ? { op: 'reattach', noteId: e.noteId, ...lines }
      : e.noteId ? { op: 'edit', noteId: e.noteId, body: e.body }
      : { op: 'add', path: e.path, side: e.side, startLine: e.lines[0].number, endLine: e.lines[e.lines.length - 1].number, quote: e.lines.map((l) => l.text).join('\n'), body: e.body };
    this.#patch(key, { editor: { ...e, saving: true, error: null } });
    const shown = () => this.#state(key)?.editor;
    try {
      await this.#write(key, request);
    } catch (error) {
      if (this.deps.failed(error)) return;
      const now = shown();
      if (now) this.#patch(key, { editor: { ...now, saving: false, error: this.deps.describe(error) } });
      else this.deps.say(key, this.deps.describe(error));
      // A refused reattach may mean the note was deleted at the desk: re-read, so the move ends with it.
      if (e.reattach) await this.load();
      return;
    }
    if (e.reattach) {
      if (this.#state(key)) this.#patch(key, { editor: null, moving: null });
      return this.deps.say(key, 'Review note reattached.');
    }
    this.deps.store.saveDraft(editorDraftKey(key, e), '').catch(() => {});
    if (shown()) this.#patch(key, { editor: null });
    this.deps.say(key, e.noteId ? 'Review note updated.' : 'Review note saved.');
  }

  resolve(noteId) {
    return this.#simple({ op: 'resolve', noteId }, 'Review note resolved.');
  }

  delete(noteId) {
    return this.#simple({ op: 'delete', noteId }, 'Review note deleted.');
  }

  /** The ticked open notes go to the agent with the next message: their token joins the draft. */
  attach() {
    const c = this.deps.current();
    const s = c?.notes;
    if (!s || s.busy || s.selected.length === 0) return;
    const n = s.selected.length;
    const said = n === 1 ? '1 review note attached to your message. Send it to deliver.' : `${n} review notes attached to your message. Send it to deliver.`;
    return this.#busy(c.key, { op: 'attach', noteIds: [...s.selected].sort() }, (answer) => this.#deliver(c.key, answer, said));
  }

  /** Feedback that failed, or whose delivery is unknown, goes back into the message to send again. */
  retry(batchId) {
    const c = this.deps.current();
    if (!c?.notes || c.notes.busy) return;
    return this.#busy(c.key, { op: 'retry', batchId }, (answer) => this.#deliver(c.key, answer, 'Review feedback is back in the message. Send it to try again.'));
  }

  /** A different machine: nothing here means anything there. */
  forget() {
    this.uncertain = null;
  }

  /**
   * The composer's chips read [key]'s list with Changes closed too; it is adopted as any answer is,
   * and a read older than a later answer is dropped.
   */
  async read(key) {
    const bridge = this.deps.bridge();
    if (!bridge) return;
    const gen = this.deps.generation();
    const seq = ++this.seq;
    let data;
    try {
      data = await bridge.reviewNotes(key);
    } catch (error) {
      if (gen !== this.deps.generation() || this.deps.failed(error)) return;
      if (seq === this.seq && this.#state(key)?.loading) this.#patch(key, { loading: false });
      return;
    }
    if (gen !== this.deps.generation() || seq !== this.seq) return;
    // It supersedes a Changes read in flight, which would otherwise leave "Loading…" up.
    if (this.#state(key)?.loading) this.#patch(key, { loading: false });
    this.#adopt(key, data);
  }

  /**
   * One write for the composer's chips (`retry`, `detach-file`, `detach`), with Changes open or not:
   * the answer, or the bridge's error — a lost answer keeps its id for the identical retry.
   */
  writeFeedback(key, request) {
    return this.#write(key, request);
  }

  async #deliver(key, answer, said) {
    if (!answer.token) return this.deps.say(key, 'The machine attached nothing. Update the plugin, or attach the notes in the IDE.');
    if (this.#state(key)) this.#patch(key, { listing: false, selected: [] });
    await this.deps.attached(key, answer.token, said);
  }

  async #simple(request, done) {
    const c = this.deps.current();
    if (!c?.notes || c.notes.busy) return;
    this.#patch(c.key, { editor: null });
    return this.#busy(c.key, request, () => this.deps.say(c.key, done));
  }

  async #busy(key, request, done) {
    this.#patch(key, { busy: true, error: null });
    let answer;
    try {
      answer = await this.#write(key, request);
    } catch (error) {
      if (this.deps.failed(error)) return;
      if (this.#state(key)) this.#patch(key, { busy: false });
      return this.deps.say(key, this.deps.describe(error));
    }
    if (this.#state(key)) this.#patch(key, { busy: false });
    await done(answer);
  }

  /** Throws the bridge's error; a lost answer leaves its id for the identical retry. */
  async #write(key, request) {
    const bridge = this.deps.bridge();
    if (!bridge) throw new Error('Not connected to a machine.');
    const gen = this.deps.generation();
    const json = JSON.stringify([key, request]);
    // A detach is idempotent and never replayed: it neither reuses nor displaces a lost Save's or Attach's id (the phone's `replayed`).
    const replayed = request.op !== 'detach' && request.op !== 'detach-file';
    const operationId = replayed && this.uncertain?.json === json ? this.uncertain.operationId : this.deps.mintId();
    let answer;
    try {
      answer = await bridge.reviewNote(key, noteRequestBody(key, request, operationId));
    } catch (error) {
      if (replayed && gen === this.deps.generation()) this.uncertain = error?.maybeDelivered ? { json, operationId } : null;
      throw error;
    }
    if (gen !== this.deps.generation()) throw Object.assign(new Error('unpaired'), { stale: true });
    if (replayed) this.uncertain = null;
    this.seq += 1;
    if (this.#state(key)?.loading) this.#patch(key, { loading: false });
    this.#adopt(key, answer);
    return answer;
  }
}

// ---- views ------------------------------------------------------------------------------------

/** "Review notes · 2 open" above the files; opens the list. While a note is being reattached: where it is now and a way out. */
export function notesRow(notes, deck) {
  const moving = notes.moving && notes.data?.notes.find((n) => n.id === notes.moving);
  if (moving) {
    return h('div', { class: 'note-moving', role: 'status' },
      h('span', {}, `Click a line in a diff to reattach the note on ${noteLocation(moving)}`),
      h('button', { class: 'link', 'aria-label': 'Cancel reattaching', disabled: notes.editor?.saving, onclick: () => deck.notes.cancelMove() }, 'Cancel'));
  }
  const open = notes.data?.notes.filter((n) => n.state === 'open').length ?? 0;
  const pending = notes.data?.pending.length ?? 0;
  const tail = [open > 0 && `${open} open`, pending > 0 && `${pending} to retry`].filter(Boolean).join(' · ');
  return h('button', { class: 'link notes-row', 'aria-expanded': notes.listing ? 'true' : 'false', onclick: () => (notes.listing ? deck.notes.closeList() : deck.notes.openList()) },
    'Review notes', tail && h('span', { class: 'dim' }, ` · ${tail}`));
}

/** The list: pending feedback with Retry, then each note with a tick for attaching and its actions. */
export function notesListView(notes, deck) {
  const all = notes.data?.notes ?? [];
  const shown = notes.history ? all : all.filter((n) => n.state === 'open');
  const busy = notes.busy;
  const reattach = reattachOffered(deck.state.hello?.capabilities);
  return h('div', { class: 'notes', role: 'group', 'aria-label': 'Review notes' },
    h('h3', {}, 'Review notes'),
    (notes.loading || busy) && h('p', { class: 'dim' }, 'Loading…'),
    notes.error && h('p', { class: 'notice', role: 'alert' }, notes.error),
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', 'aria-label': 'Show resolved and delivered notes', checked: notes.history, onchange: () => deck.notes.toggleHistory() }),
      ' Show resolved and delivered notes'),
    notes.data?.pending.map((p) => h('div', { class: 'pending' },
      h('span', {}, pendingText(p)),
      h('button', { class: 'link', disabled: busy, onclick: () => deck.notes.retry(p.batchId) }, 'Retry'))),
    notes.data && shown.length === 0 && h('p', { class: 'dim' },
      notes.history ? 'No saved review notes.' : 'No open review notes. Click a line in a file\'s diff to add one.'),
    shown.length > 0 && h('ul', {}, shown.map((note) => h('li', {},
      h('label', { class: 'file' },
        h('input', {
          type: 'checkbox', class: 'tick', 'aria-label': `Attach: ${fileName(note.path)} ${lineLabel(note.startLine, note.endLine)}`,
          checked: notes.selected.includes(note.id), disabled: busy || note.state !== 'open',
          onchange: () => deck.notes.toggle(note.id),
        }),
        h('span', {}, noteLocation(note), h('div', { class: 'dim' }, noteStatus(note)))),
      note.quote && h('pre', { class: 'quote dim' }, note.quote),
      h('p', { class: 'body' }, note.body),
      h('div', { class: 'row' },
        h('button', { class: 'link', disabled: busy, onclick: () => deck.notes.startEdit(note) }, 'Edit'),
        note.state === 'open' && h('button', { class: 'link', disabled: busy, onclick: () => deck.notes.resolve(note.id) }, 'Resolve'),
        reattach && h('button', { class: 'link', disabled: busy, 'aria-label': `Reattach: ${noteLocation(note)}`, onclick: () => deck.notes.startMove(note.id) }, 'Reattach'),
        h('button', { class: 'link', disabled: busy, onclick: () => deck.notes.delete(note.id) }, 'Delete'))))),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: busy || notes.selected.length === 0, onclick: () => deck.notes.attach() }, attachLabel(notes.selected.length)),
      h('button', { class: 'link', onclick: () => deck.notes.closeList() }, 'Close')));
}

/** Writing one note: the lines it is about above the text, as the desk's "Add review note" dialog shows them. */
export function noteEditorView(editor, deck) {
  const first = editor.lines[0].number;
  const last = editor.lines[editor.lines.length - 1].number;
  const tooLong = bytes(editor.body) > BODY_BYTES;
  const title = editor.reattach ? 'Reattach review note' : editor.noteId ? 'Edit review note' : 'Add review note';
  let box;
  if (editor.reattach) box = h('p', { class: 'body' }, editor.body);
  else {
    box = h('textarea', {
      rows: 3, class: 'note-body', 'aria-label': 'Review note', disabled: editor.saving,
      oninput: (e) => deck.notes.editBody(e.target.value),
    });
    box.value = editor.body;
  }
  return h('div', { class: 'note-editor', role: 'group', 'aria-label': title },
    h('h3', {}, title),
    h('p', { class: 'dim' }, `${editor.path} · ${sideLabel(editor.side)} · ${lineLabel(first, last)}`),
    h('pre', { class: 'quote' }, editor.lines.map((l) => l.text).join('\n')),
    (!editor.noteId || editor.reattach) && editor.following.length > 0 && h('button', { class: 'link', disabled: editor.saving, onclick: () => deck.notes.extend() }, 'Next line'),
    box,
    tooLong && h('p', { class: 'notice', role: 'alert' }, 'Review notes can contain up to 16 KiB of text.'),
    editor.saving && h('p', { class: 'dim' }, 'Saving…'),
    editor.error && h('p', { class: 'notice', role: 'alert' }, editor.error),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: !canSave(editor), onclick: () => deck.notes.save() }, editor.reattach ? 'Reattach' : 'Save'),
      h('button', { class: 'link', disabled: editor.saving, onclick: () => deck.notes.cancelEditor() }, 'Cancel')));
}

/**
 * One hunk's lines; with [notes] each numbered line takes a note on click (or Enter), and each open
 * note on this file shows under the line it ends on, as the desk's diff paints its banner.
 */
export function hunkLines(path, hunk, notes, deck, lineClass) {
  const rows = numberedLines(hunk);
  const here = notes?.data?.notes.filter((n) => n.path === path && n.state === 'open' && !n.outdated) ?? [];
  return rows.flatMap((row, i) => {
    const side = sideOf(row);
    const n = numberOn(row, side);
    const add = notes && n !== undefined && (() => deck.notes.startAdd(path, rows, i));
    const span = h('span', add ? {
      class: `${lineClass(row.text)} notable`, role: 'button', tabindex: '0',
      'aria-label': `${notes.moving ? 'Reattach review note to' : 'Add review note on'} ${sideLabel(side)} line ${n}: ${row.text.slice(1)}`,
      onclick: add, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); } },
    } : { class: lineClass(row.text) }, row.text);
    const ending = here.filter((note) => numberOn(row, note.side) === note.endLine);
    return [span, ...ending.map((note) => h('span', { class: 'note-banner', role: 'button', tabindex: '0', 'aria-label': `Edit review note: ${note.body}`,
      onclick: () => deck.notes.startEdit(note),
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); deck.notes.startEdit(note); } } },
      h('b', {}, `Note · ${lineLabel(note.startLine, note.endLine)}`), ' ', note.body))];
  });
}
