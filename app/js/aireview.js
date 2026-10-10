// Codex review runs on the machine; closing the sheet stops polling, not the run.
// Optional rule/location operations require ai-review-rules/ai-review-location.
// Lenient decoders match core/mobile via test/fixtures/ai-review.json.

import { h } from './dom.js';
import { PROTOCOL_VERSION } from './wire.js';

const str = (o, k) => (typeof o?.[k] === 'string' ? o[k] : undefined);
const nonBlank = (s) => (s && s.trim() ? s : undefined);
const int = (o, k) => (Number.isInteger(o?.[k]) ? o[k] : undefined);
const objects = (o, k) => (Array.isArray(o?.[k]) ? o[k].filter((e) => e && typeof e === 'object') : []);
const strings = (o, k) => (Array.isArray(o?.[k]) ? o[k].filter((e) => typeof e === 'string') : []);
/** Null when [k] is absent, so an older machine's silence is not read as an empty list. */
const stringsOrNull = (o, k) => (Array.isArray(o?.[k]) ? strings(o, k) : null);

export const UNCOMMITTED = 'uncommitted';
export const BASE = 'base';
export const COMMIT = 'commit';
const KINDS = new Set([UNCOMMITTED, BASE, COMMIT]);
const kindOf = (s) => (KINDS.has(s) ? s : UNCOMMITTED);

/** `AiReviewFlow.POLL_MS`: how often a running review is read while its sheet is open. */
export const POLL_MS = 2000;

/** The desk dialog's status after "Never report this", as the phone's `LEARNED`. */
export const LEARNED = 'Rule added. The next review skips findings like this one — edit it in Review rules.';

/** The desk's Review Rules hint, word for word. */
export const RULES_HINT = 'One rule per line. Every review in this project — manual or automatic — is held to them.';

/** `MobileAiReviewFinding`; a finding without a title is dropped, as the machine's decoder drops it. */
export const decodeFinding = (o) => {
  const title = nonBlank(str(o, 'title'));
  if (!title) return null;
  const startLine = Math.max(1, int(o, 'startLine') ?? 1);
  const priority = int(o, 'priority');
  const confidence = int(o, 'confidence');
  return {
    title,
    body: str(o, 'body') ?? '',
    priority: priority !== undefined && priority >= 0 && priority <= 3 ? priority : undefined,
    confidence: confidence !== undefined && confidence >= 0 && confidence <= 100 ? confidence : undefined,
    path: str(o, 'path') ?? '',
    startLine,
    endLine: Math.max(startLine, int(o, 'endLine') ?? startLine),
    fixPrompt: str(o, 'fixPrompt') ?? '',
  };
};

/** `MobileAiReviewReport`: empty findings with no failure is a real answer — nothing found. */
export const decodeReport = (o) => ({
  findings: objects(o, 'findings').map(decodeFinding).filter(Boolean),
  summary: str(o, 'summary') ?? '',
  correctness: nonBlank(str(o, 'correctness')),
  explanation: nonBlank(str(o, 'explanation')),
  failure: nonBlank(str(o, 'failure')),
  message: nonBlank(str(o, 'message')),
  omitted: Math.max(0, int(o, 'omitted') ?? 0),
});

/** `MobileAiReviewState`: the project's review as the machine holds it. */
export const decodeAiReviewState = (o) => {
  const startedAtMs = int(o, 'startedAtMs');
  return {
    key: str(o, 'key') ?? '',
    kind: kindOf(str(o, 'kind')),
    branch: str(o, 'branch') ?? '',
    commit: str(o, 'commit') ?? '',
    running: o?.running === true,
    stopping: o?.stopping === true,
    target: nonBlank(str(o, 'target')),
    startedAtMs: startedAtMs > 0 ? startedAtMs : undefined,
    report: o?.report && typeof o.report === 'object' ? decodeReport(o.report) : undefined,
    refused: nonBlank(str(o, 'refused')),
    spendNote: nonBlank(str(o, 'spendNote')),
    rules: stringsOrNull(o, 'rules'),
  };
};

/** `MobileAiReviewExcerpt`: empty [lines] always come with [message]. */
export const decodeExcerpt = (o) => {
  const startLine = Math.max(1, int(o, 'startLine') ?? 1);
  return {
    path: str(o, 'path') ?? '',
    startLine,
    endLine: Math.max(startLine, int(o, 'endLine') ?? startLine),
    firstLine: Math.max(1, int(o, 'firstLine') ?? 1),
    lines: strings(o, 'lines'),
    message: nonBlank(str(o, 'message')),
  };
};

/** `POST /v1/review/{key}/ai-review` (`MobileAiReviewRequest`): a start, a stop, or a rules write. */
export const aiReviewBody = ({ key, kind = UNCOMMITTED, branch = '', commit = '', stop = false, operationId, neverReport, rules, expectedRules }) => {
  const body = { v: PROTOCOL_VERSION, key, kind };
  if (branch) body.branch = branch;
  if (commit) body.commit = commit;
  if (stop) body.stop = true;
  if (operationId) body.operationId = operationId;
  if (neverReport) body.neverReport = findingBody(neverReport);
  if (rules) body.rules = rules;
  if (expectedRules) body.expectedRules = expectedRules;
  return body;
};

/** A finding as `MobileAiReviewFinding.toJson` writes it: absent fields stay absent. */
const findingBody = (f) => {
  const o = { title: f.title, body: f.body };
  if (f.priority !== undefined) o.priority = f.priority;
  if (f.confidence !== undefined) o.confidence = f.confidence;
  Object.assign(o, { path: f.path, startLine: f.startLine, endLine: f.endLine });
  if (f.fixPrompt) o.fixPrompt = f.fixPrompt;
  return o;
};

/** `?finding=N&path=&line=`: the machine reads only a file its reviewer named, finding N of its current report. */
export const excerptQuery = (index, finding) =>
  `?${new URLSearchParams({ finding: String(index), path: finding.path, line: String(finding.startLine) })}`;

/**
 * Under `ai-review`, on a Codex chat: the desk's `/review` is Codex's, and a Claude chat's is its
 * Changes. [vendor] is the fleet row's — a machine's keys are opaque (`v2:…`) and name no vendor.
 */
export const aiReviewOffered = (capabilities, vendor) => !!capabilities?.includes('ai-review') && vendor === 'CODEX';

/** The desk's own words: `P0`…`P3`, or "Unranked" — never a bare number. */
export const priorityLabel = (f) => (f.priority !== undefined ? `P${f.priority}` : 'Unranked');

/** `src/File.kt:12` or `src/File.kt:12-18`. */
export const locationLabel = (f) => (f.endLine > f.startLine ? `${f.path}:${f.startLine}-${f.endLine}` : `${f.path}:${f.startLine}`);

/** The chat's draft with a fix request under it, a blank line apart — the desk's `AskAnywhere.appended`. */
export const withFix = (draft, fixPrompt) => {
  const kept = (draft ?? '').trimEnd();
  if (!kept) return fixPrompt;
  if (!fixPrompt) return kept;
  return `${kept}\n\n${fixPrompt}`;
};

/** A branch or commit review needs its name; the machine validates it before it reaches an argv. */
export const canStart = (sheet) =>
  !!sheet?.state && !sheet.state.running && !sheet.sending &&
  (sheet.kind === UNCOMMITTED || /\S/.test(sheet.kind === BASE ? sheet.branch : sheet.commit));

export class AiReview {
  /**
   * @param {object} deps
   * @param {()=>({key:string, review:object|null})|null} deps.current the open chat with Changes shown
   * @param {(key:string, sheet:object|null, opening?:boolean)=>void} deps.patch replaces that chat's sheet; opening also clears the panel's other sheets and status
   * @param {()=>import('./bridge.js').Bridge|null} deps.bridge
   * @param {(error:any)=>boolean} deps.failed a revoked token, handled: true
   * @param {(error:any)=>string} deps.describe
   * @param {(key:string, fixPrompt:string)=>void} deps.fix a finding's fix request joins the chat's draft
   * @param {()=>number} deps.generation the pairing; an answer from an older one is dropped
   * @param {()=>string} deps.mintId
   * @param {(fn:()=>void, ms:number)=>any} deps.setTimer
   * @param {(t:any)=>void} deps.clearTimer
   */
  constructor(deps) {
    this.deps = deps;
    /** The start whose answer never arrived; only the identical retry reuses its operation id. */
    this.uncertain = null;
    this.timer = null;
    /** Bumped by every open and close: a state read for an older sheet is dropped. */
    this.seq = 0;
  }

  #sheet(key) {
    const c = this.deps.current();
    return c?.key === key ? c.review : null;
  }

  #update(key, change) {
    const sheet = this.#sheet(key);
    if (sheet) this.deps.patch(key, change(sheet));
  }

  /** Opens the sheet over the machine's state: a run still going, its findings, or the desk's saved form. */
  async open() {
    const c = this.deps.current();
    if (!c || !this.deps.bridge()) return;
    this.#stopPolling();
    const seq = ++this.seq;
    this.deps.patch(c.key, {
      state: null, kind: UNCOMMITTED, branch: '', commit: '', sending: false, error: null,
      rulesText: null, rulesOpenedOn: null, notice: null, location: null, expanded: [],
    }, true);
    await this.#read(c.key, seq, true);
  }

  close() {
    const c = this.deps.current();
    this.seq += 1;
    this.#stopPolling();
    if (c?.review) this.deps.patch(c.key, null);
  }

  edit(patch) {
    const c = this.deps.current();
    const s = c?.review;
    if (!s || s.sending || s.state?.running) return;
    this.deps.patch(c.key, {
      ...s, error: null,
      ...(patch.kind !== undefined && { kind: kindOf(patch.kind) }),
      ...(patch.branch !== undefined && { branch: patch.branch }),
      ...(patch.commit !== undefined && { commit: patch.commit }),
    });
  }

  /** Opening a finding is the desk's selecting it: its whole body and "Never report this" show. */
  toggle(index) {
    const c = this.deps.current();
    const s = c?.review;
    if (!s) return;
    const expanded = s.expanded.includes(index) ? s.expanded.filter((i) => i !== index) : [...s.expanded, index];
    this.deps.patch(c.key, { ...s, expanded });
  }

  /**
   * Starts the review. A start whose answer was lost keeps its operation id, so the identical
   * retry is answered with that run rather than starting a second.
   */
  start() {
    const c = this.deps.current();
    const s = c?.review;
    if (!canStart(s)) return;
    const asked = { key: c.key, kind: s.kind, branch: s.kind === BASE ? s.branch.trim() : '', commit: s.kind === COMMIT ? s.commit.trim() : '' };
    const u = this.uncertain;
    const same = u && u.key === asked.key && u.kind === asked.kind && u.branch === asked.branch && u.commit === asked.commit;
    const request = same ? u : { ...asked, operationId: this.deps.mintId() };
    this.uncertain = request;
    return this.#send(c.key, request, null);
  }

  stop() {
    const c = this.deps.current();
    const s = c?.review;
    if (!s || s.sending || !s.state?.running || s.state.stopping) return;
    return this.#send(c.key, { key: c.key, stop: true }, null);
  }

  /** "Never report this": the next review, from either side, skips findings like this one. */
  neverReport(index) {
    const c = this.deps.current();
    const s = c?.review;
    const finding = s?.state?.report?.findings[index];
    if (!finding || s.sending || !s.state.rules) return;
    return this.#send(c.key, { key: c.key, neverReport: finding }, LEARNED, true);
  }

  openRules() {
    const c = this.deps.current();
    const rules = c?.review?.state?.rules;
    if (!rules || c.review.sending) return;
    this.deps.patch(c.key, { ...c.review, rulesText: rules.join('\n'), rulesOpenedOn: rules, error: null, notice: null });
  }

  editRules(text) {
    const c = this.deps.current();
    if (c?.review?.rulesText != null && !c.review.sending) this.deps.patch(c.key, { ...c.review, rulesText: text, error: null });
  }

  closeRules() {
    const c = this.deps.current();
    if (c?.review && !c.review.sending) this.deps.patch(c.key, { ...c.review, rulesText: null, rulesOpenedOn: null, error: null });
  }

  /** Saved only on Save, over the list the editor opened on: a list changed since on the machine is refused, not overwritten. */
  saveRules() {
    const c = this.deps.current();
    const s = c?.review;
    if (s?.rulesText == null || s.sending) return;
    return this.#send(c.key, { key: c.key, rules: s.rulesText.split('\n'), expectedRules: s.rulesOpenedOn ?? undefined }, null, true);
  }

  /** Finding [index] at its lines, the desk dialog's opening it in the editor; Back returns to the findings. */
  async openLocation(index) {
    const c = this.deps.current();
    const finding = c?.review?.state?.report?.findings[index];
    const bridge = this.deps.bridge();
    if (!finding || !bridge) return;
    const gen = this.deps.generation();
    const opened = { index, finding, excerpt: null, error: null };
    this.deps.patch(c.key, { ...c.review, location: opened });
    let patch;
    try {
      patch = { excerpt: await bridge.aiReviewExcerpt(c.key, index, finding) };
    } catch (error) {
      if (this.deps.failed(error) || gen !== this.deps.generation()) return;
      patch = { error: this.deps.describe(error) };
    }
    if (gen !== this.deps.generation()) return;
    // Only onto the same opening: Back, then another finding, must not show this file.
    this.#update(c.key, (s) => (s.location === opened ? { ...s, location: { ...opened, ...patch } } : s));
  }

  closeLocation() {
    const c = this.deps.current();
    if (c?.review?.location) this.deps.patch(c.key, { ...c.review, location: null });
  }

  /** The desk marker's button: the request goes under the draft and waits for Send. */
  askToFix(index) {
    const c = this.deps.current();
    const finding = c?.review?.state?.report?.findings[index];
    if (!finding?.fixPrompt) return;
    this.close();
    this.deps.fix(c.key, finding.fixPrompt);
  }

  /** A different machine: its runs and ids mean nothing there. */
  forget() {
    this.uncertain = null;
    this.seq += 1;
    this.#stopPolling();
  }

  async #send(key, request, notice, rules = false) {
    const bridge = this.deps.bridge();
    const s = this.#sheet(key);
    if (!bridge || !s) return;
    const gen = this.deps.generation();
    const seq = this.seq;
    this.deps.patch(key, { ...s, sending: true, error: null, notice: null });
    let state;
    try {
      state = await bridge.aiReview(key, aiReviewBody(request));
    } catch (error) {
      if (this.deps.failed(error) || gen !== this.deps.generation()) return;
      // A start that may have reached the machine keeps its id; any other failure retires it.
      if (request.operationId && !error?.maybeDelivered) this.uncertain = null;
      if (seq === this.seq) this.#update(key, (x) => ({ ...x, sending: false, error: this.deps.describe(error) }));
      return;
    }
    if (gen !== this.deps.generation()) return;
    if (request.operationId) this.uncertain = null;
    // Closed and opened again meanwhile: the new sheet reads its own state and keeps what it has typed.
    if (seq !== this.seq) return;
    this.#land(key, state, false);
    this.#update(key, (x) => {
      if (!rules) return { ...x, sending: false, error: state.refused ?? null };
      // Refused: the editor stays open on what was typed, the reason under it, and now knows the
      // machine's list — so a second Save replaces it knowingly rather than being refused forever.
      if (state.refused) return { ...x, sending: false, error: state.refused, rulesOpenedOn: state.rules ?? x.rulesOpenedOn };
      return { ...x, sending: false, rulesText: null, rulesOpenedOn: null, notice };
    });
  }

  async #read(key, seq, first) {
    const bridge = this.deps.bridge();
    if (!bridge) return;
    const gen = this.deps.generation();
    let state;
    try {
      state = await bridge.aiReviewState(key);
    } catch (error) {
      if (this.deps.failed(error) || gen !== this.deps.generation() || seq !== this.seq) return;
      // A poll that missed is skipped, as the phone's: the next one answers, and no alert outlives the blip.
      if (!first) return this.#sheet(key)?.state?.running ? this.#poll(key) : undefined;
      this.#update(key, (s) => ({ ...s, error: this.deps.describe(error) }));
      return;
    }
    if (gen !== this.deps.generation() || seq !== this.seq) return;
    this.#land(key, state, first);
  }

  /** The machine's state onto the open sheet; the form is taken from it only when first read. */
  #land(key, state, first) {
    const s = this.#sheet(key);
    if (!s) return;
    // A run starting or ending replaces the findings, so what was opened by index is closed.
    const replaced = !!s.state && s.state.running !== state.running;
    this.deps.patch(key, {
      ...s, state,
      ...(first && { kind: state.kind, branch: state.branch, commit: state.commit }),
      ...(first && state.refused && { error: state.refused }),
      ...(replaced && { expanded: [], location: null }),
    });
    // Nothing running: whatever the unanswered start became, it has ended or never arrived.
    if (!state.running && this.uncertain?.key === key) this.uncertain = null;
    if (state.running) this.#poll(key);
    else this.#stopPolling();
  }

  #poll(key) {
    if (this.timer !== null) return;
    const seq = this.seq;
    this.timer = this.deps.setTimer(async () => {
      this.timer = null;
      if (seq !== this.seq || !this.#sheet(key)?.state?.running) return;
      await this.#read(key, seq, false);
    }, POLL_MS);
  }

  #stopPolling() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}

const CHOICES = [
  [UNCOMMITTED, 'Uncommitted changes'],
  [BASE, 'Changes against a branch'],
  [COMMIT, 'One commit'],
];

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "Review with Codex": what to review, then the findings, P0 first, with the reviewer's verdict
 * in its own words. The run is the machine's; Close leaves it going.
 * @param {object} sheet the deck's `open.changes.aiReview`
 */
export function aiReviewView(sheet, deck) {
  const caps = deck.state.hello?.capabilities ?? [];
  if (sheet.rulesText != null) return rulesView(sheet, deck);
  if (sheet.location) return locationView(sheet.location, deck);
  const state = sheet.state;
  const running = !!state?.running;
  const locked = running || sheet.sending;
  const report = !running ? state?.report : undefined;
  const learn = !!state?.rules && caps.includes('ai-review-rules') && !sheet.sending;
  const locate = caps.includes('ai-review-location');
  const field = (kind, label, value) => {
    const box = h('input', {
      type: 'text', class: 'ai-review-field', 'aria-label': label, disabled: locked, autocomplete: 'off', spellcheck: 'false',
      oninput: (e) => deck.aiReview.edit({ [kind === BASE ? 'branch' : 'commit']: e.target.value }),
    });
    box.value = value;
    return box;
  };
  return h('div', { class: 'ai-review', role: 'group', 'aria-label': 'Review with Codex' },
    h('h3', {}, 'Review with Codex'),
    !state && h('p', { class: 'dim' }, 'Loading…'),
    state && h('fieldset', { class: 'ai-review-kind' },
      h('legend', { class: 'dim' }, 'Review'),
      CHOICES.flatMap(([kind, label]) => [
        h('label', {},
          h('input', { type: 'radio', name: 'ai-review-kind', 'aria-label': label, checked: sheet.kind === kind, disabled: locked, onchange: () => deck.aiReview.edit({ kind }) }),
          ' ', label),
        sheet.kind === kind && kind === BASE && field(BASE, 'Branch', sheet.branch),
        sheet.kind === kind && kind === COMMIT && field(COMMIT, 'Commit', sheet.commit),
      ])),
    state?.spendNote && !running && h('p', { class: 'dim' }, state.spendNote),
    state?.rules && caps.includes('ai-review-rules') && h('button', { class: 'link', disabled: sheet.sending, onclick: () => deck.aiReview.openRules() },
      `Review rules (${state.rules.length})…`),
    running && h('div', { role: 'status' },
      h('p', {}, state.stopping ? 'Stopping…' : `Reviewing ${state.target ? lowerFirst(state.target) : 'the changes'}…`),
      h('p', { class: 'dim' }, 'You can close this; the review keeps running on the machine.')),
    report && h('div', { class: 'ai-review-summary' },
      state.target && h('p', { class: 'dim' }, state.target),
      h('p', { class: report.failure ? 'notice' : 'verdict' },
        [report.summary, report.correctness && upperFirst(report.correctness)].filter(Boolean).join('  ·  ')),
      report.explanation && h('p', {}, report.explanation)),
    report && report.findings.length > 0 && h('ul', { class: 'ai-review-findings' },
      report.findings.map((f, i) => findingView(f, i, sheet.expanded.includes(i), learn, locate, deck))),
    report && report.omitted > 0 && h('p', { class: 'dim' },
      report.omitted === 1 ? '1 more finding is in the IDE\'s review.' : `${report.omitted} more findings are in the IDE's review.`),
    report?.message && h('p', { class: 'dim ai-review-message' }, report.message),
    sheet.notice && h('p', { class: 'dim', role: 'status' }, sheet.notice),
    sheet.error && h('p', { class: 'notice', role: 'alert' }, sheet.error),
    h('div', { class: 'row' },
      running
        ? h('button', { class: 'link', disabled: sheet.sending || state.stopping, onclick: () => deck.aiReview.stop() }, 'Stop')
        : h('button', { class: 'primary', disabled: !canStart(sheet), onclick: () => deck.aiReview.start() },
          state?.report ? 'Review again' : 'Review'),
      h('button', { class: 'link', onclick: () => deck.aiReview.close() }, 'Close')));
}

function findingView(f, i, expanded, learn, locate, deck) {
  const high = f.priority !== undefined && f.priority <= 1;
  return h('li', { class: 'ai-review-finding' },
    h('div', { class: `dim${high ? ' high' : ''}` }, [priorityLabel(f), f.confidence !== undefined && `confidence ${f.confidence}%`].filter(Boolean).join(' · ')),
    h('button', {
      class: 'finding-title', 'aria-expanded': expanded ? 'true' : 'false', onclick: () => deck.aiReview.toggle(i),
    }, f.title),
    locate
      ? h('button', { class: 'link mono', 'aria-label': `Open the finding's lines: ${locationLabel(f)}`, onclick: () => deck.aiReview.openLocation(i) }, locationLabel(f))
      : h('div', { class: 'dim mono' }, locationLabel(f)),
    f.body && h('p', { class: expanded ? 'finding-body' : 'finding-body clipped' }, f.body),
    h('div', { class: 'row' },
      f.fixPrompt && h('button', { class: 'link', 'aria-label': 'Ask the agent to fix this finding', onclick: () => deck.aiReview.askToFix(i) }, 'Ask to fix'),
      expanded && learn && h('button', { class: 'link', onclick: () => deck.aiReview.neverReport(i) }, 'Never report this')));
}

/** The desk's Review Rules dialog: the list as text, saved only on Save, so Cancel edits nothing. */
function rulesView(sheet, deck) {
  const box = h('textarea', {
    rows: 6, class: 'ai-review-rules', 'aria-label': 'Review rules', disabled: sheet.sending,
    oninput: (e) => deck.aiReview.editRules(e.target.value),
  });
  box.value = sheet.rulesText;
  // Not the box's own label: `render` refocuses the first element carrying it, which must be the box.
  return h('div', { class: 'ai-review', role: 'group', 'aria-label': 'Review rules editor' },
    h('h3', {}, 'Review rules'),
    h('p', { class: 'dim' }, RULES_HINT),
    box,
    sheet.error && h('p', { class: 'notice', role: 'alert' }, sheet.error),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: sheet.sending, onclick: () => deck.aiReview.saveRules() }, sheet.sending ? 'Saving…' : 'Save'),
      h('button', { class: 'link', disabled: sheet.sending, onclick: () => deck.aiReview.closeRules() }, 'Cancel')));
}

/** The finding's file around its lines, the named ones marked; Back returns to the findings. */
function locationView(location, deck) {
  const { finding, excerpt, error } = location;
  const lines = excerpt?.lines ?? [];
  const width = excerpt ? String(excerpt.firstLine + lines.length - 1).length : 0;
  return h('div', { class: 'ai-review', role: 'group', 'aria-label': `${finding.title} at ${locationLabel(finding)}` },
    h('button', { class: 'link', onclick: () => deck.aiReview.closeLocation() }, '‹ Back'),
    h('h3', {}, finding.title),
    h('div', { class: 'dim mono' }, locationLabel(finding)),
    error && h('p', { class: 'notice', role: 'alert' }, error),
    !error && !excerpt && h('p', { class: 'dim' }, 'Loading…'),
    excerpt && lines.length === 0 && h('p', { class: 'dim' }, excerpt.message ?? ''),
    lines.length > 0 && h('pre', { class: 'ai-review-lines', 'data-scroll': `ai-review-${location.index}` },
      h('span', { class: 'lines' }, lines.map((line, i) => {
        const n = excerpt.firstLine + i;
        const named = n >= excerpt.startLine && n <= excerpt.endLine;
        return h('span', named ? { class: 'named' } : {}, `${String(n).padStart(width)}  ${line}`);
      }))));
}
