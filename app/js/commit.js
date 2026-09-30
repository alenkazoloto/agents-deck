// Changes › Commit…: commit what the open conversation changed, behind `review-commit` — the
// phone app's `ReviewCommitFlow`. The machine previews the chat's own files and the message the
// desk would seed; the confirm names exactly the ticked paths and the preview's fingerprint, so
// the rest of the index and a tree that moved since are never committed.
// Decoders follow `wire.js`: lenient, pinned to `core/mobile` by test/fixtures/review-commit.json.

import { h } from './dom.js';
import { PROTOCOL_VERSION } from './wire.js';

const str = (o, k) => (typeof o?.[k] === 'string' ? o[k] : undefined);
const count = (o, k) => (Number.isInteger(o?.[k]) && o[k] > 0 ? o[k] : 0);
const nonBlank = (s) => (s && s.trim() ? s : undefined);
const objects = (o, k) => (Array.isArray(o?.[k]) ? o[k].filter((e) => e && typeof e === 'object') : []);

/** `MobileReviewCommitRequest.MAX_MESSAGE_CHARS`; the phone's field stops there too. */
export const MAX_MESSAGE_CHARS = 8000;

const STATUSES = new Set(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']);

/** `MobileReviewCommitFile`; a status this client does not know reads as a plain modification. */
const decodeCommitFile = (o) => ({
  path: str(o, 'path') ?? '',
  status: STATUSES.has(str(o, 'status')) ? o.status : 'modified',
  included: o?.included === true,
});

export const committable = (f) => f.status !== 'conflicted';

/** `GET /v1/review/{key}/commit` (`MobileReviewCommitPreview`): with `refused`, why nothing can be committed — never a sheet to confirm. */
export const decodeCommitPreview = (o) => ({
  key: str(o, 'key') ?? '',
  branch: nonBlank(str(o, 'branch')),
  message: str(o, 'message') ?? '',
  files: objects(o, 'files').map(decodeCommitFile).filter((f) => f.path),
  alreadyCommitted: count(o, 'alreadyCommitted'),
  outside: count(o, 'outside'),
  previewToken: str(o, 'previewToken') ?? '',
  refused: nonBlank(str(o, 'refused')),
});

/** `MobileReviewCommitResult`: `committed` false means git recorded nothing and `message` is its reason. */
export const decodeCommitResult = (o) => ({
  key: str(o, 'key') ?? '',
  committed: o?.committed === true,
  message: str(o, 'message') ?? '',
  commit: nonBlank(str(o, 'commit')),
});

/** `POST /v1/review/{key}/commit` (`MobileReviewCommitRequest`). */
export const commitRequestBody = ({ key, previewToken, paths, message, operationId }) =>
  ({ v: PROTOCOL_VERSION, key, previewToken, paths, message, operationId });

/** Under `review-commit`, as the phone's "Commit…"; never while the machine sends a `writerNotice` (a running or ACP chat). */
export const commitOffered = (capabilities, list) =>
  !!capabilities?.includes('review-commit') && !!list && !list.writerNotice && list.files.length > 0;

/** A subject line is required, as in the desk's commit UI. */
export const canCommit = (sheet) =>
  !!sheet?.preview && !sheet.preview.refused && !!sheet.preview.previewToken && !sheet.loading && !sheet.committing &&
  sheet.chosen.length > 0 && /\S/.test(sheet.message);

/** What a row's status means for this commit; a plain modification needs no words (the phone's `commitStatus`). */
export const commitStatus = (f) => ({
  untracked: 'New, not in git yet',
  added: 'New file',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Has merge conflicts. Resolve them in the IDE first.',
})[f.status];

/** The chat's files this commit cannot include, counted rather than silently missing. */
export const leftOut = (preview) => {
  const parts = [
    preview.alreadyCommitted > 0 && `${preview.alreadyCommitted} already committed`,
    preview.outside > 0 && `${preview.outside} outside this repository`,
  ].filter(Boolean);
  return parts.length ? `Also changed by this chat: ${parts.join(' · ')}` : null;
};

export const commitLabel = (n) => (n === 1 ? 'Commit 1 file' : `Commit ${n} files`);

export class ReviewCommit {
  /**
   * @param {object} deps
   * @param {()=>({key:string, commit:object|null})|null} deps.current the open chat with Changes shown
   * @param {(key:string, sheet:object|null, opening?:boolean)=>void} deps.patch replaces that chat's sheet; opening also clears the panel's other sheet and status
   * @param {()=>import('./bridge.js').Bridge|null} deps.bridge
   * @param {(error:any)=>boolean} deps.failed a revoked token, handled: true
   * @param {(error:any)=>string} deps.describe
   * @param {(key:string, message:string)=>void} deps.say the panel's status line, or the chat's when Changes closed
   * @param {(key:string, message:string)=>void} deps.committed a commit landed: re-read what it moved, then say [message]
   * @param {()=>number} deps.generation the pairing; an answer from an older one is dropped
   * @param {()=>string} deps.mintId
   */
  constructor(deps) {
    this.deps = deps;
    /** The typed message and ticks per chat, kept over a close or a failed commit; only a landed commit clears them. */
    this.drafts = new Map();
    /** The commit whose answer never arrived; only the identical retry reuses its operation id. */
    this.uncertain = null;
    /** Bumped by every open: a preview answered after the sheet was closed and opened again is dropped. */
    this.seq = 0;
  }

  #sheet(key) {
    const c = this.deps.current();
    return c?.key === key ? c.commit : null;
  }

  /**
   * Opens "Commit changes" over a fresh preview. [keep] is the reader's ticks carried over a
   * re-read after a stale answer, never re-ticking a file the reader left out.
   */
  async open(notice = null, keep = null) {
    const c = this.deps.current();
    const bridge = this.deps.bridge();
    if (!c || !bridge) return;
    const { key } = c;
    const seq = ++this.seq;
    const draft = this.drafts.get(key);
    const reading = { preview: null, message: draft?.message ?? '', chosen: [], loading: true, committing: false, error: notice };
    this.deps.patch(key, reading, true);
    let preview;
    try {
      preview = await bridge.commitPreview(key);
    } catch (error) {
      if (this.deps.failed(error) || seq !== this.seq || !this.#sheet(key)?.loading) return;
      this.deps.patch(key, null);
      return this.deps.say(key, this.deps.describe(error));
    }
    // Typing while the preview loads writes the draft, and the sheet shown is then no longer `reading`.
    const shown = this.#sheet(key);
    if (seq !== this.seq || !shown?.loading) return;
    if (preview.refused) {
      // Nothing the reader could confirm: said once, and no empty sheet left behind.
      this.deps.patch(key, null);
      return this.deps.say(key, preview.refused);
    }
    const offered = preview.files.filter(committable).map((f) => f.path);
    const within = (paths) => offered.filter((p) => paths.includes(p));
    const saved = this.drafts.get(key);
    const chosen = keep ? within(keep)
      : saved?.chosen && within(saved.chosen).length > 0 ? within(saved.chosen)
        : preview.files.filter((f) => f.included && committable(f)).map((f) => f.path);
    this.deps.patch(key, { ...shown, preview, loading: false, message: saved?.message ?? preview.message, chosen });
  }

  #edit(change) {
    const c = this.deps.current();
    if (!c?.commit || c.commit.committing) return;
    const next = change(c.commit);
    this.deps.patch(c.key, next);
    this.drafts.set(c.key, { message: next.message, chosen: next.preview ? next.chosen : this.drafts.get(c.key)?.chosen });
  }

  editMessage(text) {
    this.#edit((s) => ({ ...s, message: text.slice(0, MAX_MESSAGE_CHARS) }));
  }

  toggle(path) {
    const s = this.deps.current()?.commit;
    if (!s?.preview?.files.some((f) => f.path === path && committable(f))) return;
    this.#edit((x) => ({ ...x, chosen: x.chosen.includes(path) ? x.chosen.filter((p) => p !== path) : [...x.chosen, path] }));
  }

  close() {
    const c = this.deps.current();
    if (c?.commit && !c.commit.committing) this.deps.patch(c.key, null);
  }

  /**
   * The confirmed commit. An answer that never arrived keeps its operation id, so the identical
   * retry is answered with the first attempt's outcome instead of a second commit; any definite
   * answer retires it.
   */
  async confirm() {
    const c = this.deps.current();
    const sheet = c?.commit;
    const bridge = this.deps.bridge();
    if (!canCommit(sheet) || !bridge) return;
    const { key } = c;
    const gen = this.deps.generation();
    const paths = [...sheet.chosen].sort();
    const { previewToken } = sheet.preview;
    const same = (u) => u && u.key === key && u.previewToken === previewToken && u.paths.join('\n') === paths.join('\n') && u.message === sheet.message;
    const operationId = same(this.uncertain) ? this.uncertain.operationId : this.deps.mintId();
    const asked = { key, previewToken, paths, message: sheet.message, operationId };
    const busy = { ...sheet, committing: true, error: null };
    this.deps.patch(key, busy);
    // The answer belongs to this sheet only: the reader may close Changes meanwhile.
    const shown = () => this.#sheet(key) === busy;
    const fail = (message) => (shown() ? this.deps.patch(key, { ...busy, committing: false, error: message }) : this.deps.say(key, message));
    let result;
    try {
      result = await bridge.commit(key, commitRequestBody(asked));
    } catch (error) {
      if (this.deps.failed(error) || gen !== this.deps.generation()) return;
      const said = this.deps.describe(error);
      if (error?.code === 'commit-preview-stale') {
        this.uncertain = null;
        // The tree moved: read it again with the reader's ticks and let them look before committing.
        return shown() ? this.open(said, paths) : this.deps.say(key, said);
      }
      this.uncertain = error?.code === 'commit-unconfirmed' || error?.maybeDelivered ? asked : null;
      return fail(said);
    }
    if (gen !== this.deps.generation()) return;
    this.uncertain = null;
    if (!result.committed) return fail(result.message || 'Nothing was committed.');
    this.drafts.delete(key);
    if (shown()) this.deps.patch(key, null);
    this.deps.committed(key, result.commit ? `${result.message} (${result.commit})` : result.message);
  }

  /** A different machine: another repository's drafts and a pending id mean nothing there. */
  forget() {
    this.drafts.clear();
    this.uncertain = null;
  }
}

/**
 * "Commit changes" over the machine's preview: the branch, the message the desk would seed, and
 * the conversation's own files ticked as the desk's commit UI ticks them. Nothing else in the
 * repository is listed, because nothing else can be committed from here.
 * @param {{preview, message, chosen, loading, committing, error}} sheet the deck's `open.changes.commit`
 */
export function commitView(sheet, deck) {
  const preview = sheet.preview;
  const box = h('textarea', {
    rows: 4, class: 'commit-message', 'aria-label': 'Commit message', maxlength: String(MAX_MESSAGE_CHARS), disabled: sheet.committing,
    oninput: (e) => deck.commit.editMessage(e.target.value),
  });
  box.value = sheet.message;
  const left = preview && leftOut(preview);
  return h('div', { class: 'commit', role: 'group', 'aria-label': 'Commit changes' },
    h('h3', {}, 'Commit changes'),
    preview?.branch && h('p', { class: 'dim' }, `On ${preview.branch}`),
    (sheet.loading || sheet.committing) && h('p', { class: 'dim' }, sheet.committing ? 'Committing…' : 'Loading…'),
    box,
    preview && h('ul', {}, preview.files.map((f) => h('li', {},
      h('label', { class: 'file' },
        h('input', {
          type: 'checkbox', class: 'tick', 'aria-label': `Commit: ${f.path}`, checked: sheet.chosen.includes(f.path),
          disabled: !committable(f) || sheet.committing, onchange: () => deck.commit.toggle(f.path),
        }),
        h('span', {}, f.path, commitStatus(f) && h('div', { class: 'dim' }, commitStatus(f))))))),
    left && h('p', { class: 'dim' }, left),
    sheet.error && h('p', { class: 'notice', role: 'alert' }, sheet.error),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: !canCommit(sheet), onclick: () => deck.commit.confirm() }, commitLabel(sheet.chosen.length)),
      h('button', { class: 'link', disabled: sheet.committing, onclick: () => deck.commit.close() }, 'Cancel')));
}
