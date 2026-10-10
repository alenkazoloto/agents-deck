// Review operations are capability-gated; ACP changes are read-only.
// Notes, commits and AI review have separate controllers.
// Lenient decoders match core/mobile via test/fixtures/review.json.

import { h } from './dom.js';
import { PROTOCOL_VERSION } from './wire.js';
import { hunkLines, noteEditorView, notesListView, notesRow } from './notes.js';
import { commitOffered, commitView } from './commit.js';
import { aiReviewView } from './aireview.js';

const str = (o, k) => (typeof o?.[k] === 'string' ? o[k] : undefined);
const count = (o, k) => (Number.isInteger(o?.[k]) && o[k] > 0 ? o[k] : 0);
const nonBlank = (s) => (s && s.trim() ? s : undefined);
const objects = (o, k) => (Array.isArray(o?.[k]) ? o[k].filter((e) => e && typeof e === 'object') : []);

const STATUSES = new Set(['added', 'modified', 'removed', 'unknown']);

/** `MobileReviewFile`; a status this client does not know reads as `unknown`, never as "no change". */
export const decodeReviewFile = (o) => ({
  path: str(o, 'path') ?? '',
  directory: str(o, 'directory'),
  status: STATUSES.has(str(o, 'status')) ? o.status : 'unknown',
  added: count(o, 'added'),
  removed: count(o, 'removed'),
  reviewed: o?.reviewed === true,
  note: nonBlank(str(o, 'note')),
});

/** `GET /v1/review/{key}` (`MobileReviewList`); a row without a path is one no diff could be asked for. */
export const decodeReviewList = (o) => ({
  key: str(o, 'key') ?? '',
  files: objects(o, 'files').map(decodeReviewFile).filter((f) => f.path),
  added: count(o, 'added'),
  removed: count(o, 'removed'),
  reviewedFiles: count(o, 'reviewedFiles'),
  writerNotice: nonBlank(str(o, 'writerNotice')),
});

/** `GET /v1/review/{key}/file?path=` (`MobileReviewFileDiff`); lines keep their `+`/`-`/space prefix. */
export const decodeReviewFileDiff = (o) => ({
  file: decodeReviewFile(o?.file && typeof o.file === 'object' ? o.file : {}),
  hunks: objects(o, 'hunks').map((x) => ({
    beforeStart: count(x, 'beforeStart'),
    afterStart: count(x, 'afterStart'),
    lines: Array.isArray(x.lines) ? x.lines.filter((l) => typeof l === 'string') : [],
  })),
  omittedBytes: count(o, 'omittedBytes'),
  ignoreWhitespace: o?.ignoreWhitespace === true,
});

/** `POST /v1/review/{key}` (`MobileReviewMark`): [paths] empty is the header's "Mark all reviewed". */
export const reviewMarkBody = (paths, reviewed) => ({ v: PROTOCOL_VERSION, action: 'mark-reviewed', paths, reviewed });

const REVERT_ACTIONS = new Set(['restore', 'delete']);

/** `MobileReviewRevertFile`; an action this client does not know is `skip`, never offered as a write. */
const decodeRevertFile = (o) => ({
  path: str(o, 'path') ?? '',
  action: REVERT_ACTIONS.has(str(o, 'action')) ? o.action : 'skip',
});

export const revertable = (f) => f.action !== 'skip';

/** `MobileReviewRevertChoice`: one request, numbered as the desk's "Group by request" numbers it. */
const decodeRevertChoice = (o) => ({
  request: str(o, 'request') ?? '',
  number: Number.isInteger(o?.number) ? o.number : 0,
  prompt: str(o, 'prompt') ?? '',
  files: count(o, 'files'),
  laterFiles: count(o, 'laterFiles'),
});

/**
 * `GET /v1/review/{key}/revert` (`MobileReviewRevertPreview`): what the desk's "Revert…" would do,
 * or with `refused` why it will not — one shape, so a refusal is never confirmed.
 */
export const decodeRevertPreview = (o) => ({
  key: str(o, 'key') ?? '',
  files: objects(o, 'files').map(decodeRevertFile).filter((f) => f.path),
  notes: Array.isArray(o?.notes) ? o.notes.filter((n) => typeof n === 'string' && n.trim()) : [],
  previewToken: str(o, 'previewToken') ?? '',
  refused: nonBlank(str(o, 'refused')),
  scope: str(o, 'scope') ?? 'session',
  request: o?.request && typeof o.request === 'object' ? decodeRevertChoice(o.request) : null,
  requests: objects(o, 'requests').map(decodeRevertChoice).filter((c) => c.request),
});

/** `MobileReviewRevertResult`: `reverted` false means nothing was written, `message` says why. */
export const decodeRevertResult = (o) => ({
  key: str(o, 'key') ?? '',
  reverted: o?.reverted === true,
  message: str(o, 'message') ?? '',
  failed: Array.isArray(o?.failed) ? o.failed.filter((p) => typeof p === 'string') : [],
});

/**
 * `POST /v1/review/{key}/revert` (`MobileReviewRevertRequest`). [scope] is the preview's own:
 * `session`, or `request`/`after` with the [request] id it names.
 */
export const reviewRevertBody = (key, previewToken, paths, operationId, scope = 'session', request = null) =>
  ({ v: PROTOCOL_VERSION, key, previewToken, paths, operationId, scope, ...(scope !== 'session' && request ? { request } : {}) });

/** The preview's query: none for the whole session, so an older machine is asked what it knows. */
export const revertQuery = (scope = 'session', request = null) =>
  (scope === 'session' || !request ? '' : `?scope=${encodeURIComponent(scope)}&request=${encodeURIComponent(request)}`);

/** The phone app's `offersChanges`: an ACP chat's review came later than the rest. */
export const reviewOffered = (capabilities, key) =>
  !!capabilities?.includes('review') && (!key.startsWith('acp:') || capabilities.includes('acp-review'));

/** Under `review-revert`, as the phone's "Revert…"; never while the machine sends a `writerNotice`. */
export const revertOffered = (capabilities, list) =>
  !!capabilities?.includes('review-revert') && !!list && !list.writerNotice && list.files.length > 0;

/**
 * Only a machine with `review-request-revert` lists requests; one without would ignore the scope
 * and revert the whole session, so it is never asked for one.
 */
export const requestRevertOffered = (capabilities) => !!capabilities?.includes('review-request-revert');

/** The desk dialog's three words per file, with each scope's reasons (`SessionRevert`), as the phone's `revertAction`. */
const REVERT_ACTION_LABEL = {
  session: { delete: 'Delete (created by this chat)', skip: 'Skip (no recorded session-start content)' },
  request: { delete: 'Delete (created by the request)', skip: "Skip (later changes overlap or the content isn't reconstructable)" },
  after: { delete: 'Delete (created after this request)', skip: "Skip (content at that point isn't reconstructable)" },
};

export const revertAction = (action, scope = 'session') =>
  (action === 'restore' ? 'Restore' : (REVERT_ACTION_LABEL[scope] ?? REVERT_ACTION_LABEL.session)[action]);

/** The sheet's title, in the desk request menu's words. */
export const revertTitle = (scope, number) =>
  (scope === 'after' ? `Revert to after request ${number}` : scope === 'request' ? `Undo request ${number}'s changes` : 'Revert to session start');

export const revertLabel = (n) => (n === 1 ? 'Revert 1 file' : `Revert ${n} files`);

const STATUS_LABEL = { added: 'Added', modified: 'Modified', removed: 'Deleted', unknown: 'Changed' };

const counts = (f) => f.note ?? `+${f.added} −${f.removed}`;

const fileName = (path) => path.slice(path.lastIndexOf('/') + 1) || path;

/** `-` and `+` are the two sides; anything else (a space, `\ No newline…`) is context. */
const lineClass = (line) => (line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx');

function diffView(file, diff, busy, notes, deck) {
  if (busy && !diff) return h('p', { class: 'dim' }, 'Loading…');
  if (!diff) return null;
  const f = diff.file.path ? diff.file : file;
  return h('div', { class: 'diff' },
    // An unestablished baseline has no hunks, only the sentence saying why.
    diff.hunks.length === 0 && h('p', { class: 'dim' }, f.note ?? 'No changed lines to show.'),
    diff.hunks.map((hunk, i) => h('pre', { 'data-scroll': `diff:${f.path}:${i}` }, h('div', { class: 'lines' },
      h('span', { class: 'hunk dim' }, `@@ −${hunk.beforeStart} +${hunk.afterStart} @@`),
      hunkLines(f.path, hunk, notes, deck, lineClass)))),
    diff.ignoreWhitespace && h('p', { class: 'dim' }, 'Whitespace-only changes are hidden, as in the IDE.'),
    diff.omittedBytes > 0 && h('p', { class: 'dim' }, `The rest of this diff (${diff.omittedBytes} bytes) is too long to show here — open it in the IDE.`));
}

/**
 * "Revert to session start" over the machine's preview: its notes, then a tick per file (every
 * revertable one starts ticked, as the desk's dialog covers all), and a confirm naming the count.
 * Under the whole session's sheet, a machine that lists requests offers each one's "Undo this
 * request" and, when later requests changed files, "Revert to after it" (the phone's `RevertSheet`).
 * @param {{preview, chosen, loading, reverting, error, scope, request, requests}} revert the deck's `open.changes.revert`
 */
function revertView(revert, deck) {
  const preview = revert.preview;
  const busy = revert.loading || revert.reverting;
  const confirmable = !!preview && !preview.refused && !!preview.previewToken && revert.chosen.length > 0 && !busy;
  const scoped = revert.scope !== 'session' && revert.request;
  const title = scoped ? revertTitle(revert.scope, revert.request.number) : revertTitle('session');
  return h('div', { class: 'revert', role: 'group', 'aria-label': title },
    scoped
      ? h('div', { class: 'row' },
        h('button', { class: 'link', disabled: revert.reverting, onclick: () => deck.chooseRevert('session'), 'aria-label': 'Back to reverting the whole session' }, '‹ Back'),
        h('h3', {}, title))
      : h('h3', {}, title),
    scoped && h('p', { class: 'prompt' }, `“${revert.request.prompt}”`),
    busy && h('p', { class: 'dim' }, revert.reverting ? 'Reverting…' : 'Loading…'),
    preview && preview.notes.map((n) => h('p', { class: 'dim' }, n)),
    preview && !preview.refused && h('ul', {}, preview.files.map((f) => h('li', {},
      h('label', { class: 'file' },
        h('input', {
          type: 'checkbox', class: 'tick', 'aria-label': `Revert: ${f.path}`, checked: revert.chosen.includes(f.path), disabled: !revertable(f) || busy,
          onchange: () => deck.toggleRevertFile(f.path),
        }),
        h('span', {}, f.path, h('div', { class: 'dim' }, revertAction(f.action, revert.scope))))))),
    revert.error && h('p', { class: 'notice', role: 'alert' }, revert.error),
    h('div', { class: 'row' },
      h('button', { class: 'confirm-danger', disabled: !confirmable, onclick: () => deck.confirmRevert() }, revertLabel(revert.chosen.length)),
      h('button', { class: 'link', onclick: () => deck.closeRevert() }, 'Cancel')),
    !scoped && preview && revert.requests.length > 0 && h('div', { class: 'requests', role: 'group', 'aria-label': 'Or revert one request' },
      h('h4', {}, 'Or revert one request'),
      revert.requests.map((c) => h('div', { class: 'request' },
        h('p', { class: 'prompt' }, `${c.number}. ${c.prompt}`),
        h('div', { class: 'dim' }, c.files === 1 ? '1 file' : `${c.files} files`),
        h('div', { class: 'row' },
          h('button', { class: 'link', disabled: revert.reverting, onclick: () => deck.chooseRevert('request', c) }, 'Undo this request'),
          c.laterFiles > 0 && h('button', { class: 'link', disabled: revert.reverting, onclick: () => deck.chooseRevert('after', c) }, 'Revert to after it'))))));
}

/**
 * The Changes panel beside the message box: the checklist's files, one of them unfolded to its diff.
 * @param {{list, loading, notice, path, diff, diffLoading}} changes the deck's `open.changes`
 */
export function changesView(changes, deck) {
  const list = changes.list;
  // The machine's `writerNotice` (a chat still running, or an ACP chat) is what drops every tick, as on the phone.
  const markable = !!list && !list.writerNotice && list.files.length > 0;
  const allReviewed = markable && list.files.every((f) => f.reviewed);
  // Notes take no writerNotice gate: the desk saves them while a chat runs, as its own diff does.
  const notes = deck.notesOffered ? changes.notes : null;
  const editor = notes?.editor;
  return h('section', { class: 'changes', role: 'dialog', 'aria-label': 'Changes' },
    h('h2', {}, 'Changes',
      list && list.files.length > 0 && h('span', { class: 'dim' }, ` · ${list.files.length} ${list.files.length === 1 ? 'file' : 'files'} · +${list.added} −${list.removed}`)),
    changes.notice && h('p', { class: 'notice', role: 'status' }, changes.notice),
    changes.said && h('p', { class: 'dim', role: 'status' }, changes.said),
    list?.writerNotice && h('p', { class: 'dim' }, list.writerNotice),
    !list && changes.loading && h('p', { class: 'dim' }, 'Loading…'),
    list && list.files.length === 0 && h('p', { class: 'dim' }, 'This chat has not changed any files.'),
    list && list.files.length > 0 && h('ul', {}, list.files.map((f) => {
      const shown = changes.path === f.path;
      return h('li', { class: shown ? 'open' : '' },
        h('div', { class: 'file' },
          // Never disabled and one label either way: the rebuilt box is found again by it and keeps focus.
          markable && h('input', {
            type: 'checkbox', class: 'tick', checked: f.reviewed, 'aria-label': `Reviewed: ${f.path}`,
            onchange: () => deck.markReviewed([f.path], !f.reviewed),
          }),
          h('button', {
          class: 'row-open', 'aria-expanded': shown ? 'true' : 'false',
          'aria-label': `${STATUS_LABEL[f.status]} ${f.path}, ${counts(f)}`,
          onclick: () => (shown ? deck.closeChangedFile() : deck.openChangedFile(f.path)),
        },
          h('span', { class: `status ${f.status}` }, STATUS_LABEL[f.status]), ' ',
          fileName(f.path),
          f.reviewed && h('span', { class: 'dim' }, ' · reviewed'),
          h('div', { class: 'dim' }, f.path !== fileName(f.path) && `${f.path} · `, counts(f)))),
        shown && diffView(f, changes.diff, changes.diffLoading, notes, deck),
        // A new note is written under the diff it was clicked in; an edit opens under the list.
        shown && editor && (!editor.noteId || editor.reattach) && editor.path === f.path && noteEditorView(editor, deck));
    })),
    notes && notesRow(notes, deck),
    notes?.listing && notesListView(notes, deck),
    editor && ((editor.noteId && !editor.reattach) || editor.path !== changes.path) && noteEditorView(editor, deck),
    changes.revert && revertView(changes.revert, deck),
    changes.commit && commitView(changes.commit, deck),
    changes.aiReview && aiReviewView(changes.aiReview, deck),
    h('div', { class: 'row' },
      !changes.commit && !changes.revert && !changes.aiReview && commitOffered(deck.state.hello?.capabilities, list) && h('button', { class: 'link', onclick: () => deck.commit.open() }, 'Commit…'),
      !changes.commit && !changes.revert && !changes.aiReview && revertOffered(deck.state.hello?.capabilities, list) && h('button', { class: 'link', onclick: () => deck.openRevert() }, 'Revert…'),
      !changes.commit && !changes.revert && !changes.aiReview && deck.aiReviewOffered && h('button', { class: 'link', onclick: () => deck.aiReview.open() }, 'Review with Codex…'),
      markable && h('button', { class: 'link', disabled: changes.marking, onclick: () => deck.markReviewed([], !allReviewed) },
        allReviewed ? 'Clear all' : 'Mark all reviewed'),
      h('button', { class: 'link', disabled: changes.loading, onclick: () => deck.openChanges() }, changes.loading ? 'Refreshing…' : 'Refresh'),
      h('button', { class: 'link', onclick: () => deck.closeChanges() }, 'Close')));
}
