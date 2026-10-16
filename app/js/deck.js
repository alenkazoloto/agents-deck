// The app's state machine, with no DOM: pairing, the live fleet, and what to show when the machine
// cannot be reached. `app.js` renders whatever [Deck.state] says.

import { Bridge, BridgeError } from './bridge.js';
import { ReconnectPolicy } from './sse.js';
import { Outbox } from './outbox.js';
import { Push, PushError } from './push.js';
import { decodeFleet, decodeRunFrame, deviceLabel, parsePairing, searchEligible, typedOrigin } from './wire.js';
import { complete, continuedWith, newSearch, pageKeys, plus } from './search.js';
import { normalizeFolderName, withFolderResult, withSessionResult } from './folders.js';
import { NEW_CHAT_DRAFT, defaultTarget, picksFor, projectName } from './newchat.js';
import { editDraft, editInitial, editUnchanged, laterDefault, scheduleEditBody, whenText } from './scheduled.js';
import { requestRevertOffered, revertable, reviewOffered } from './review.js';
import { ReviewNotes, notesOffered, withToken } from './notes.js';
import { FeedbackChips, chipsOffered, tokensIn } from './feedback.js';
import { ReviewCommit } from './commit.js';
import { AiReview, aiReviewOffered, withFix } from './aireview.js';

const MESSAGES = {
  empty: 'Paste the pairing link, or type the address and the code.',
  'not-a-pairing-link': "That isn't a pairing link. Copy it again from the IDE, under Settings › Connections › Mobile.",
  'unsupported-version': 'That pairing code is from a different version of Agents Deck.',
  'web-origin-refused': "That link names an address this app won't send a token to. Only https …ts.net addresses are accepted.",
  'no-web-origin': 'This pairing code has no browser address. Turn on Browser access in the IDE, under Settings › Connections › Mobile, then open Pair again.',
  'bad-address': 'Type the machine\'s Tailscale name, like mac.tail1234.ts.net.',
  'bad-code': 'The code is 8 digits.',
  'origin-not-allowed': 'This machine only answers the Agents Deck web app. Open it from the Agents Deck site.',
  'network-not-allowed': 'This machine does not accept connections from the Tailscale network yet. Allow it in the IDE, under Settings › Connections › Mobile.',
  unreachable: "Can't reach the machine — is Tailscale on?",
  'not-found': 'That conversation is no longer on this machine.',
  'push-denied': "Notifications are blocked for this app. Allow them in your browser's site settings, then tap again.",
  'push-dismissed': 'Notifications stay off until you allow them.',
};

const vendorOf = (key) => key.split(':')[0] || 'CLAUDE';

/** The phone's key too (`DeckViewModel.scheduleEditDraftKey`): one unsaved edit per queued prompt. */
const scheduleEditDraftKey = (id) => `scheduled-edit:${id}`;

/** What a scheduled command did, in the phone app's words. */
const SCHEDULED_SAID = { pause: 'Paused.', resume: 'Resumed.', 'run-now': 'Running it now.', cancel: 'Cancelled the prompt.' };

export const messageFor = (error) => MESSAGES[error.code] ?? error.message ?? MESSAGES.unreachable;

/** [list] with each file's tick replaced by [tick]'s answer, where it has one. */
const withTicks = (list, tick) => {
  const files = list.files.map((f) => { const r = tick(f); return r === undefined || r === f.reviewed ? f : { ...f, reviewed: r }; });
  return { ...list, files, reviewedFiles: files.filter((f) => f.reviewed).length };
};

/**
 * @param {object} deps
 * @param {import('./store.js').Store} deps.store
 * @param {(origin:string, token:string|null)=>Bridge} [deps.bridgeFor]
 * @param {()=>number} [deps.now]
 * @param {(fn:()=>void, ms:number)=>any} [deps.setTimer]
 * @param {(t:any)=>void} [deps.clearTimer]
 * @param {string} [deps.userAgent]
 * @param {()=>string} [deps.mintId] a fresh client message id
 * @param {Push|null} [deps.push] web push in this browser; null is a browser with none to offer
 * @param {((key:string)=>void)|null} [deps.navigate] opens a conversation the deck made (a fork); the app routes through the address bar
 * @param {((screen:'list'|'new-chat')=>void)|null} [deps.show] moves between the list and the New chat screen, through the address bar in the app
 */
export class Deck {
  constructor({ store, bridgeFor = (o, t) => new Bridge(o, t), now = () => Date.now(),
    setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), userAgent = '',
    mintId = () => crypto.randomUUID(), push = null, navigate = null, show = null }) {
    this.store = store;
    this.bridgeFor = bridgeFor;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.userAgent = userAgent;
    this.push = push;
    this.mintId = mintId;
    this.navigate = navigate ?? ((key) => this.openConversation(key));
    this.show = show ?? ((screen) => (screen === 'new-chat' ? this.openNewChat() : this.closeNewChat()));
    this.listeners = new Set();
    this.policy = new ReconnectPolicy();
    /**
     * phase: loading | pairing | paired.
     * live: a stream is open and delivering. reachable: the last contact succeeded.
     * receivedAtMs: when this browser last heard from the machine (drives the offline stamp).
     */
    this.state = {
      phase: 'loading', session: null, fleet: null, receivedAtMs: 0,
      live: false, reachable: true, polling: false, notice: null, pending: null, busy: false,
      hello: null, open: null,
      /** The Usage screen while it is open: `{report, receivedAtMs, agent, account, loading, notice}`; [report] may be the cached one. */
      usage: null,
      /** The search box's message half (`search.js`) while one is asked; null otherwise. */
      messageSearch: null,
      /** `{offered, support, permission, subscribed, busy, notice}` once the machine has said whether it offers push. */
      push: null,
      /** The list's folder editor: `{busy, notice}` while a folder write is asked or after one said something. */
      folders: null,
      /** The New chat screen while it is open: `{target, draft}`; [target] null means the machine has no project open. */
      newChat: null,
      /** What the last new chat's delivery said, on the list until dismissed. */
      startNotice: null,
      /** The Scheduled screen while it is open: `{list, receivedAtMs, loading, busy, notice}`; [list] may be the cached one. */
      scheduled: null,
    };
    this.abort = null;
    this.timer = null;
    this.generation = 0;
    this.outbox = new Outbox({
      store, now, mintId,
      onChange: () => this.#set({}),
      onDelivered: (item, accepted) => this.#delivered(item, accepted),
    });
    this.outboxTimer = null;
    /**
     * The open conversation, or null: `{key, page, receivedAtMs, draft, notice, loading, olderLoading,
     * forkPoints, forking, forkNotice, folderPicker, folderBusy, folderNotice}` — [forkPoints] is the "New chat from before…" picker while it is open,
     * [forkNotice] what the last fork said, shown beside the message box rather than in the banner the page scrolled past;
     * [folderPicker] is "Move to folder…" while it is open, and [folderNotice] what the last move said.
     * [page] is the last transcript decoded (cached ones open instantly, stamped), never a live-looking guess.
     */
    this.open = null;
    this.openBusy = false;
    this.openDirty = false;
    /** Answers to Changes reads are shown only while theirs is the latest ask of its kind. */
    this.changesSeq = { list: 0, diff: 0 };
    /** Bumped whenever the Usage screen closes, refilters or the pairing ends; a load from an older one is dropped. */
    this.usageGen = 0;
    /** Bumped whenever a message search is replaced or cleared; a page for an older one is dropped. */
    this.searchGen = 0;
    /**
     * One operation id per fork target until the machine answers it: a retry after a dropped link
     * is then the same fork, which the machine answers again rather than copying the chat twice.
     */
    this.forkOperations = new Map();
    /** The revert whose answer never arrived (`{key, previewToken, paths, operationId}`); only the identical retry reuses its id. */
    this.revertUncertain = null;
    /** Called before the deck itself rewrites a chat's draft, so the view drops the text it mirrors. */
    this.onDraftWritten = null;
    this.notes = new ReviewNotes({
      current: () => (this.open?.changes ? { key: this.open.key, notes: this.open.changes.notes ?? null } : null),
      patch: (key, patch) => {
        const changes = this.open?.key === key ? this.open.changes : null;
        if (changes) this.#patchChanges(key, { notes: { ...changes.notes, ...patch } });
      },
      bridge: () => this.#bridge(),
      failed: (error) => {
        if (error?.stale) return true;
        if (error instanceof BridgeError && error.revoked) { this.#revoked(error); return true; }
        return false;
      },
      describe: (error) => (error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable),
      say: (key, message) => this.#say(key, message),
      attached: (key, token, message) => this.#attachFeedback(key, token, message),
      generation: () => this.pairingGen,
      mintId: () => this.mintId(),
      store,
      adopted: (key, data) => this.feedback.adopted(key, data),
    });
    this.feedback = new FeedbackChips({
      current: () => (this.feedbackOffered ? this.open : null),
      patch: (key, patch) => { if (this.open?.key === key) this.#setOpen({ feedback: { ...this.open.feedback, ...patch } }); },
      notes: this.notes,
      failed: (error) => {
        if (error?.stale) return true;
        if (error instanceof BridgeError && error.revoked) { this.#revoked(error); return true; }
        return false;
      },
      describe: (error) => (error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable),
      say: (key, message) => this.#say(key, message),
      attached: (key, token, message) => this.#attachFeedback(key, token, message),
      rewrite: async (key, draft) => {
        this.onDraftWritten?.(key);
        await this.setDraft(key, draft);
        if (this.open?.key === key) this.#set({ open: this.open });
      },
    });
    this.commit = new ReviewCommit({
      current: () => (this.open?.changes ? { key: this.open.key, commit: this.open.changes.commit ?? null } : null),
      patch: (key, sheet, opening = false) => this.#patchChanges(key, { commit: sheet, ...(opening && { revert: null, aiReview: null, said: null, notice: null }) }),
      bridge: () => this.#bridge(),
      failed: (error) => (error instanceof BridgeError && error.revoked ? (this.#revoked(error), true) : false),
      describe: (error) => (error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable),
      say: (key, message) => this.#say(key, message),
      committed: (key, message) => this.#committed(key, message),
      generation: () => this.pairingGen,
      mintId: () => this.mintId(),
    });
    this.aiReview = new AiReview({
      current: () => (this.open?.changes ? { key: this.open.key, review: this.open.changes.aiReview ?? null } : null),
      patch: (key, sheet, opening = false) => this.#patchChanges(key, { aiReview: sheet, ...(opening && { commit: null, revert: null, said: null, notice: null }) }),
      bridge: () => this.#bridge(),
      failed: (error) => (error instanceof BridgeError && error.revoked ? (this.#revoked(error), true) : false),
      describe: (error) => (error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable),
      fix: (key, fixPrompt) => this.#askToFix(key, fixPrompt),
      generation: () => this.pairingGen,
      mintId: () => this.mintId(),
      setTimer: (fn, ms) => this.setTimer(fn, ms),
      clearTimer: (t) => this.clearTimer(t),
    });
    /** `{key, notice}`: what a fork said, shown when the conversation it made opens. */
    this.arrival = null;
    /**
     * Bumped the moment an unpair or revoke starts — before `session` is dropped, which waits on
     * the machine — so a fork answered meanwhile writes nothing into the store being cleared.
     */
    this.pairingGen = 0;
    /** The last New chat pick, so reopening the screen starts where the reader left it. */
    this.newChatTarget = null;
    /** When the next New chat opens on Later: set by "Schedule a prompt" and by Edit on a parked scheduled start. */
    this.newChatDueAtMs = null;
    /** Bumped whenever the Scheduled screen closes or the pairing ends; a load from an older one is dropped. */
    this.scheduledGen = 0;
    this.scheduledBusy = false;
    this.scheduledDirty = false;
    /** A command's words waiting for the follow-up read it asked for. */
    this.scheduledNotice = undefined;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  async start() {
    const session = await this.store.session();
    await this.outbox.load();
    if (!session) return this.#set({ phase: 'pairing' });
    const snapshot = await this.store.snapshot();
    this.#set({
      phase: 'paired', session,
      fleet: snapshot?.fleet ?? null, receivedAtMs: snapshot?.receivedAtMs ?? 0,
      // Not live until a stream opens, so the view is stamped "as of"; unreachable is only claimed
      // after a contact fails, so a slow connect does not flash a banner.
    });
    this.connect();
  }

  // ---- pairing --------------------------------------------------------------------------------

  /** Reads what the user pasted or opened; sets [state.pending] to the confirm card, or a notice. */
  async prepare(text) {
    const parsed = parsePairing(text);
    if (parsed.error) return this.#set({ notice: MESSAGES[parsed.error] ?? MESSAGES.empty, pending: null });
    if (!parsed.origin) return this.#set({ notice: MESSAGES['no-web-origin'], pending: null });
    return this.#confirmCard(parsed.origin, parsed.code, parsed.machine);
  }

  /** The typed route: an address and a code. The machine names itself before anything is sent to it. */
  async prepareTyped(address, code) {
    const origin = typedOrigin(address);
    if (!origin) return this.#set({ notice: MESSAGES['bad-address'], pending: null });
    const digits = (code ?? '').replace(/\s+/g, '');
    if (!/^\d{8}$/.test(digits)) return this.#set({ notice: MESSAGES['bad-code'], pending: null });
    return this.#confirmCard(origin, digits, '');
  }

  async #confirmCard(origin, code, machine) {
    this.#set({ busy: true, notice: null });
    try {
      // The certificate's name is the trust root: hello is answered over that certificate, so the
      // name shown is the one the browser verified, not the one the payload claims.
      const hello = await this.bridgeFor(origin, null).hello();
      this.#set({ busy: false, pending: { origin, code, machine: hello.machine || machine } });
    } catch (error) {
      this.#set({ busy: false, pending: null, notice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
    }
  }

  cancelPending() {
    this.#set({ pending: null, notice: null });
  }

  /** A one-line banner the shell raises itself, e.g. a pairing link opened in an already-paired browser. */
  notify(notice) {
    this.#set({ notice });
  }

  async confirmPairing() {
    const pending = this.state.pending;
    if (!pending) return;
    this.#set({ busy: true, notice: null });
    try {
      const accepted = await this.bridgeFor(pending.origin, null).pair(pending.code, deviceLabel(this.userAgent));
      const session = { origin: pending.origin, token: accepted.token, deviceId: accepted.deviceId, machine: accepted.machine || pending.machine };
      await this.store.saveSession(session);
      await this.outbox.keepOnlyOrigin(session.origin);
      this.#set({ phase: 'paired', session, pending: null, busy: false, fleet: null, receivedAtMs: 0, reachable: true, notice: null });
      this.connect();
    } catch (error) {
      const known = error instanceof BridgeError;
      this.#set({ busy: false, notice: known ? messageFor(error) : MESSAGES.unreachable });
    }
  }

  /** Asks the machine to forget this browser, then forgets the machine. Local state goes even if the machine is unreachable. */
  async unpair() {
    const { session } = this.state;
    this.pairingGen += 1;
    this.revertUncertain = null;
    this.notes.forget();
    this.commit.forget();
    this.aiReview.forget();
    this.disconnect();
    this.closeUsage();
    this.closeScheduled();
    this.clearMessageSearch();
    if (session) {
      try {
        await this.bridgeFor(session.origin, session.token).unpair();
      } catch {
        // Unreachable or already revoked: the desk's device list can still revoke this browser.
      }
    }
    await this.push?.forget();
    await this.store.clear();
    this.outbox.items = [];
    this.open = null;
    this.#set({ phase: 'pairing', session: null, fleet: null, receivedAtMs: 0, live: false, pending: null, notice: null, hello: null, open: null, usage: null, messageSearch: null, push: null, folders: null, newChat: null, startNotice: null, scheduled: null });
  }

  // ---- live fleet -----------------------------------------------------------------------------

  /** Opens the stream now (also the "machine came back" path: online, visible, tapped Retry). */
  connect() {
    if (this.state.phase !== 'paired') return;
    this.disconnect();
    const generation = ++this.generation;
    const { session } = this.state;
    const bridge = this.bridgeFor(session.origin, session.token);
    const controller = new AbortController();
    this.abort = controller;
    this.#run(bridge, controller, generation);
  }

  disconnect() {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.outboxTimer !== null) this.clearTimer(this.outboxTimer);
    this.outboxTimer = null;
    if (this.state.live || this.state.polling) this.#set({ live: false, polling: false });
  }

  async #run(bridge, controller, generation) {
    const current = () => generation === this.generation;
    let outcome = { action: 'retry', delayMs: 0 };
    try {
      let bye = false;
      await bridge.stream({
        signal: controller.signal,
        onOpen: () => {
          if (!current()) return;
          this.#set({ live: true, reachable: true, polling: false });
          this.#contacted(bridge);
        },
        onFrame: (frame) => {
          if (!current()) return false;
          this.policy.onFrame();
          if (frame.event === 'fleet') this.#adopt(safeJson(frame.data));
          else if (frame.event === 'bye') { bye = true; return false; }
          else if (frame.event === 'run') this.#ran(decodeRunFrame(safeJson(frame.data)));
          return true;
        },
      });
      if (!current()) return;
      outcome = bye ? this.policy.onBye(this.now()) : this.policy.onFailure();
    } catch (error) {
      if (!current()) return;
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (error instanceof BridgeError && (error.code === 'origin-not-allowed' || error.code === 'network-not-allowed')) {
        return this.#set({ live: false, reachable: true, notice: messageFor(error) });
      }
      outcome = this.policy.onFailure();
      this.#set({ reachable: false });
    }
    this.#set({ live: false });
    this.#reschedule(bridge, outcome, generation);
  }

  #reschedule(bridge, outcome, generation) {
    if (outcome.action === 'poll') {
      this.#set({ polling: true });
      return this.#poll(bridge, outcome.untilMs, generation);
    }
    this.timer = this.setTimer(() => {
      if (generation === this.generation) this.connect();
    }, outcome.delayMs);
  }

  async #poll(bridge, untilMs, generation) {
    if (generation !== this.generation) return;
    try {
      const fleet = await bridge.fleet();
      if (generation !== this.generation) return;
      this.#adopt(fleet, true);
      this.#contacted(bridge);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      this.#set({ reachable: false });
    }
    if (this.now() >= untilMs) {
      this.#set({ polling: false });
      return this.connect();
    }
    this.timer = this.setTimer(() => this.#poll(bridge, untilMs, generation), ReconnectPolicy.POLL_MS);
  }

  #adopt(raw, decoded = false) {
    if (!raw) return;
    const fleet = decoded ? raw : decodeFleet(raw);
    const receivedAtMs = this.now();
    // A New chat screen opened before the machine said which projects are open gets its destination now, and one
    // aimed at a project the IDE has since closed moves off it — the screen must never show one project and send another.
    const shown = this.state.newChat;
    const stale = shown && (!shown.target || !fleet.openProjects.includes(shown.target.projectPath));
    const newChat = stale ? { ...shown, target: defaultTarget(fleet, shown.target ?? this.newChatTarget) } : shown;
    this.#set({ fleet, receivedAtMs, reachable: true, notice: null, newChat });
    this.store.saveSnapshot(fleet, receivedAtMs).catch(() => {});
  }

  // ---- conversations --------------------------------------------------------------------------

  #bridge() {
    const { session } = this.state;
    return session ? this.bridgeFor(session.origin, session.token) : null;
  }

  #setOpen(patch) {
    this.open = this.open ? { ...this.open, ...patch } : null;
    this.#set({ open: this.open });
  }

  /** The machine just proved it is there: learn what it honours, then deliver what is owed and refresh what is open. */
  async #contacted(bridge) {
    try {
      const hello = await bridge.hello();
      this.#set({ hello });
      this.#refreshPush(bridge, hello);
    } catch (error) {
      // Not fatal: an unknown machine is treated as one that cannot recognise a repeat.
      if (error instanceof BridgeError && error.revoked) return;
    }
    this.#deliver();
    // A chat opened before hello (a reload on `#c=`, a tapped notification) learns only now that it has chips.
    if (this.open) { this.#loadOpen(); this.feedback.load(); }
    if (this.state.usage) this.#loadUsage();
    if (this.state.scheduled) this.#loadScheduled();
  }

  // ---- usage ----------------------------------------------------------------------------------

  /** Whether this machine serves the Usage screen; an older plugin answers `/v1/usage` with `unknown-route`. */
  get usageOffered() {
    return !!this.state.hello?.capabilities?.includes('usage');
  }

  /**
   * Opens with the last report read (stamped), then asks the machine for the current one. The screen
   * is set before the cache read so a Back or an unpair during it is seen; [usageGen] then drops any
   * answer for a screen, filter or pairing the reader has left.
   */
  async openUsage() {
    if (this.state.phase !== 'paired' || this.state.usage) return;
    const gen = ++this.usageGen;
    this.#set({ usage: { report: null, receivedAtMs: 0, loading: true, notice: null } });
    const cached = await this.store.usage();
    if (gen !== this.usageGen) return;
    this.#set({
      usage: {
        report: cached?.report ?? null, receivedAtMs: cached?.receivedAtMs ?? 0,
        agent: cached?.agent, account: cached?.account, loading: true, notice: null,
      },
    });
    await this.#loadUsage();
  }

  closeUsage() {
    this.usageGen += 1;
    if (this.state.usage) this.#set({ usage: null });
  }

  /** The desk's Agent and Account filters; [agent] or [account] undefined is "all". */
  async filterUsage({ agent, account }) {
    const usage = this.state.usage;
    if (!usage) return;
    this.usageGen += 1;
    this.#set({ usage: { ...usage, agent, account, loading: true } });
    await this.#loadUsage();
  }

  async #loadUsage() {
    const asked = this.state.usage;
    if (!asked) return;
    const gen = this.usageGen;
    const { agent, account } = asked;
    try {
      const report = await this.#bridge().usage({ agent, account });
      if (gen !== this.usageGen) return;
      // The machine echoes the filter it cut by: a choice it no longer offers comes back as "all".
      const saved = { report, receivedAtMs: this.now(), agent: report.filter.agent, account: report.filter.account };
      this.#set({ usage: { ...saved, loading: false, notice: null } });
      this.store.saveUsage(saved).catch(() => {});
    } catch (error) {
      if (gen !== this.usageGen) return;
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      const usage = this.state.usage;
      // Unreachable over a report already shown: the "as of" stamp says it; anything else is said out loud.
      const notice = usage.report && error.code === 'unreachable' ? null : error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable;
      this.#set({ usage: { ...usage, loading: false, notice } });
    }
  }

  // ---- scheduled ------------------------------------------------------------------------------

  /** Whether this machine lists its scheduled prompts; an older plugin answers `/v1/scheduled` with `unknown-route`. */
  get scheduledOffered() {
    return !!this.state.hello?.capabilities?.includes('scheduled');
  }

  /** Whether `/v1/send` honours `dueAtMs`; an older plugin ignores it and runs the prompt now, so "Later" is not offered. */
  get scheduleCreateOffered() {
    return !!this.state.hello?.capabilities?.includes('schedule-create');
  }

  /** Opens with the last list read (stamped), then asks the machine; [scheduledGen] drops an answer for a screen already left. */
  async openScheduled() {
    if (this.state.phase !== 'paired' || this.state.scheduled) return;
    const gen = ++this.scheduledGen;
    this.#set({ scheduled: { list: null, receivedAtMs: 0, loading: true, busy: false, notice: null } });
    const cached = await this.store.scheduled();
    if (gen !== this.scheduledGen) return;
    this.#set({ scheduled: { ...this.state.scheduled, list: cached?.list ?? null, receivedAtMs: cached?.receivedAtMs ?? 0 } });
    await this.#loadScheduled();
  }

  closeScheduled() {
    this.scheduledGen += 1;
    if (this.state.scheduled) this.#set({ scheduled: null });
  }

  /** Overlapping reads collapse into one follow-up (as [#loadOpen]), so a burst of `run` frames costs two and an older answer never lands last. */
  async #loadScheduled(notice) {
    if (!this.state.scheduled) return;
    if (this.scheduledBusy) { this.scheduledDirty = true; if (notice !== undefined) this.scheduledNotice = notice; return; }
    this.scheduledBusy = true;
    const gen = this.scheduledGen;
    try {
      const list = await this.#bridge().scheduled();
      if (gen !== this.scheduledGen || !this.state.scheduled) return;
      const receivedAtMs = this.now();
      // A good answer clears an earlier failure; only a command's own words ride along.
      this.#set({ scheduled: { ...this.state.scheduled, list, receivedAtMs, loading: false, notice: notice ?? null } });
      this.store.saveScheduled({ list, receivedAtMs }).catch(() => {});
    } catch (error) {
      if (gen !== this.scheduledGen || !this.state.scheduled) return;
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      const shown = this.state.scheduled;
      // Unreachable over a list already shown: the "as of" stamp says it; anything else is said out loud.
      const said = shown.list && error.code === 'unreachable' ? notice ?? null : error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable;
      this.#set({ scheduled: { ...shown, loading: false, notice: said } });
    } finally {
      this.scheduledBusy = false;
      if (this.scheduledDirty) {
        this.scheduledDirty = false;
        const pending = this.scheduledNotice;
        this.scheduledNotice = undefined;
        this.#loadScheduled(pending);
      }
    }
  }

  /** Pause, Resume, Run now or Cancel one row; the machine is asked, then the list is read again (W5: never pre-refused). */
  async commandScheduled(action, id) {
    const shown = this.state.scheduled;
    const bridge = this.#bridge();
    if (!shown || shown.busy || !bridge) return;
    const gen = this.scheduledGen;
    this.#set({ scheduled: { ...shown, busy: true, notice: null } });
    let notice;
    try {
      const affected = await bridge.scheduledCommand({ action, ids: [id] });
      notice = affected === 0 ? 'That prompt had already left the queue.' : SCHEDULED_SAID[action];
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      notice = error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable;
    }
    if (gen !== this.scheduledGen || !this.state.scheduled) return;
    this.#set({ scheduled: { ...this.state.scheduled, busy: false, notice } });
    await this.#loadScheduled(notice);
  }

  /** Whether `/v1/scheduled/<id>` reads and rewrites one row; an older plugin has no such route. */
  get scheduleEditOffered() {
    return !!this.state.hello?.capabilities?.includes('schedule-edit');
  }

  /**
   * Edit on a queue row: asks the machine for the row as it would edit it now, and opens on what the
   * reader left unsaved for it (drafts survive Cancel and a failed save; only a save consumes them).
   */
  async openScheduleEdit(id) {
    const shown = this.state.scheduled;
    const bridge = this.#bridge();
    if (!shown || !bridge || shown.edit?.saving) return;
    const gen = this.scheduledGen;
    const edit = { id, detail: null, form: null, loading: true, saving: false, error: null };
    this.#set({ scheduled: { ...shown, edit } });
    const current = () => gen === this.scheduledGen && this.state.scheduled?.edit?.id === id;
    try {
      const [detail, saved] = await Promise.all([bridge.scheduleEditDetail(id), this.store.draft(scheduleEditDraftKey(id))]);
      if (!current()) return;
      let draft = null;
      try { draft = saved ? JSON.parse(saved) : null; } catch { /* a draft from nowhere: open on the row */ }
      this.#set({ scheduled: { ...this.state.scheduled, edit: { ...edit, detail, form: editInitial(detail, draft), loading: false } } });
      // A draft equal to the row as the machine has it now says nothing; left, it would shadow the next change made on the desk.
      if (saved && editUnchanged(this.state.scheduled.edit.form, detail)) this.store.saveDraft(scheduleEditDraftKey(id), '').catch(() => {});
    } catch (error) {
      if (!current()) return;
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      this.#set({ scheduled: { ...this.state.scheduled, edit: { ...edit, loading: false, error: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable } } });
    }
  }

  /**
   * One change to the open edit, kept as typed; only a form that differs from the row is a draft.
   * [quiet] records it without a re-render, which would rebuild a time or number field and send its caret back to the start.
   */
  setScheduleEditForm(patch, { quiet = false } = {}) {
    const edit = this.state.scheduled?.edit;
    if (!edit?.form || edit.saving) return;
    const form = { ...edit.form, ...patch };
    const next = { scheduled: { ...this.state.scheduled, edit: { ...edit, form } } };
    if (quiet) this.state = { ...this.state, ...next };
    else this.#set(next);
    return this.store.saveDraft(scheduleEditDraftKey(edit.id), editDraft(form, edit.detail)).catch(() => {});
  }

  /** Back to the queue; what was typed stays for the next Edit of that row. */
  closeScheduleEdit() {
    const shown = this.state.scheduled;
    if (!shown?.edit || shown.edit.saving) return;
    this.#set({ scheduled: { ...shown, edit: null } });
  }

  /** Asks the machine to rewrite the row (W5: its refusal is reported, never pre-empted); a save consumes the draft. */
  async saveScheduleEdit() {
    const shown = this.state.scheduled;
    const edit = shown?.edit;
    const bridge = this.#bridge();
    if (!edit?.detail?.editable || !edit.form || edit.saving || !bridge) return;
    const gen = this.scheduledGen;
    const sent = edit.form;
    this.#set({ scheduled: { ...shown, edit: { ...edit, saving: true, error: null } } });
    try {
      await bridge.saveScheduleEdit(edit.id, scheduleEditBody(sent, edit.detail));
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (gen !== this.scheduledGen || this.state.scheduled?.edit?.id !== edit.id) return;
      const said = error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable;
      this.#set({ scheduled: { ...this.state.scheduled, edit: { ...this.state.scheduled.edit, saving: false, error: said } } });
      return;
    }
    await this.store.saveDraft(scheduleEditDraftKey(edit.id), '').catch(() => {});
    if (gen !== this.scheduledGen || !this.state.scheduled) return;
    this.#set({ scheduled: { ...this.state.scheduled, edit: null, notice: 'Saved.' } });
    await this.#loadScheduled('Saved.');
  }

  /** The Scheduled screen's "Schedule a prompt": New chat, opened on Later. */
  scheduleNewChat() {
    this.newChatDueAtMs = laterDefault(this.now());
    this.show('new-chat');
  }

  // ---- message search -------------------------------------------------------------------------

  /** Whether this machine searches messages; an older plugin answers `/v1/session-search` with `unknown-route`. */
  get messageSearchOffered() {
    return !!this.state.hello?.capabilities?.includes('session-search');
  }

  /**
   * Searches the messages of [keys] for [query], one page — the desk's own bound of 200 chats.
   * Nothing is asked again for a search already answered or in flight, which is what lets the
   * list call this whenever its query or population changes.
   */
  searchMessages(query, keys) {
    const q = query.trim();
    const current = this.state.messageSearch;
    // A timer armed before an unpair must not ask the old machine with the token being revoked.
    if (this.state.phase !== 'paired' || !searchEligible(q) || !keys.length) {
      if (current) this.clearMessageSearch();
      return;
    }
    const continued = current && continuedWith(current, q, keys);
    // A failed page is retried by the reader (Retry), not by the next fleet frame.
    if (current && continued === current) return;
    if (continued) {
      this.#set({ messageSearch: continued });
      // Only a finished search reads the newcomers by itself; a bounded one waits for its button.
      if (complete(current)) this.searchMoreMessages();
      return;
    }
    this.searchGen += 1;
    this.#set({ messageSearch: newSearch(q, keys) });
    this.#fetchMessagePage();
  }

  /** The next page, from where the last one stopped (also Retry). */
  searchMoreMessages() {
    const current = this.state.messageSearch;
    if (!current || current.searching || current.nextCursor === null) return;
    this.#set({ messageSearch: { ...current, searching: true, error: null } });
    this.#fetchMessagePage();
  }

  clearMessageSearch() {
    this.searchGen += 1;
    if (this.state.messageSearch) this.#set({ messageSearch: null });
  }

  async #fetchMessagePage() {
    const asked = this.state.messageSearch;
    const bridge = this.#bridge();
    if (!asked) return;
    if (!bridge) return this.#set({ messageSearch: { ...asked, searching: false, error: 'Not connected to this machine.' } });
    const gen = this.searchGen;
    const start = asked.nextCursor ?? 0;
    let page;
    try {
      page = await bridge.searchMessages({ query: asked.query, keys: pageKeys(asked) });
    } catch (error) {
      if (gen !== this.searchGen) return;
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      const now = this.state.messageSearch;
      if (now) this.#set({ messageSearch: { ...now, searching: false, error: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable } });
      return;
    }
    // A newer query or a cleared search owns the box now. Keys only ever grow at the end while one
    // search lasts, so the asked prefix still names the same chats.
    const now = this.state.messageSearch;
    if (gen !== this.searchGen || !now) return;
    this.#set({ messageSearch: plus(now, start, page) });
  }

  // ---- web push -------------------------------------------------------------------------------

  /** What the browser and the machine each say about push; re-sends a rotated endpoint. Never prompts. */
  async #refreshPush(bridge, hello, notice = null) {
    if (!this.push) return;
    try {
      await this.push.sync(bridge, hello);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return;
      // Not fatal: the flag stays and the next contact tries again.
    }
    const status = await this.push.status();
    this.#set({ push: { ...status, offered: Push.offered(hello), busy: false, notice } });
  }

  /** On the reader's tap; the permission dialog is the first thing it does. */
  async enablePush() {
    const { hello, push } = this.state;
    if (!this.push || !hello || push?.busy) return;
    this.#set({ push: { ...push, busy: true, notice: null } });
    const bridge = this.#bridge();
    let notice = null;
    try {
      const outcome = await this.push.enable(bridge, hello);
      if (outcome === 'denied') notice = MESSAGES['push-denied'];
      else if (outcome === 'dismissed') notice = MESSAGES['push-dismissed'];
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      notice = error instanceof BridgeError ? messageFor(error) : error instanceof PushError ? error.message : MESSAGES.unreachable;
    }
    await this.#refreshPush(bridge, hello, notice);
  }

  async disablePush() {
    const { hello, push } = this.state;
    if (!this.push || !hello || push?.busy) return;
    this.#set({ push: { ...push, busy: true, notice: null } });
    const bridge = this.#bridge();
    await this.push.disable(bridge);
    await this.#refreshPush(bridge, hello);
  }

  #canDeliver() {
    return this.state.phase === 'paired' && (this.state.live || (this.state.polling && this.state.reachable));
  }

  /** Delivers what is due; a revoked token returns to pairing with the words kept. */
  async #deliver() {
    const { session } = this.state;
    if (!session) return;
    if (this.outboxTimer !== null) this.clearTimer(this.outboxTimer);
    this.outboxTimer = null;
    try {
      await this.outbox.drain(this.#bridge(), { origin: session.origin, hello: this.state.hello, reachable: this.#canDeliver() });
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
    }
    const wake = this.outbox.nextWakeMs(session.origin);
    if (wake !== null && this.state.phase === 'paired') this.outboxTimer = this.setTimer(() => this.#deliver(), Math.max(wake, 1000));
  }

  #delivered(item, accepted) {
    if (!item.key) {
      // Confirmed after an unpair or a pairing to another machine: that notice belongs to no list shown now.
      if (item.origin !== this.state.session?.origin) return;
      const machine = this.state.session?.machine || 'the machine';
      if (this.state.scheduled) this.#loadScheduled();
      if (item.dueAtMs > this.now()) {
        return this.#set({ startNotice: accepted.notice ?? `Scheduled a chat in ${item.label} on ${machine} ${whenText(item.dueAtMs, this.now())}. It is under Scheduled until then.` });
      }
      // The row appears once the agent writes its first turn; until then this is the only sign it started.
      return this.#set({ startNotice: accepted.notice ?? `Started a chat in ${item.label} on ${machine}. It shows here once the agent writes its first turn.` });
    }
    if (this.open?.key === item.key) {
      if (accepted.notice) this.#setOpen({ notice: accepted.notice });
      this.#loadOpen();
    }
  }

  async openConversation(key) {
    if (this.state.phase !== 'paired' || !key) return;
    const cached = await this.store.transcript(key);
    const draft = await this.store.draft(key);
    const forkNotice = this.arrival?.key === key ? this.arrival.notice : null;
    this.arrival = null;
    this.open = { key, page: cached?.page ?? null, receivedAtMs: cached?.receivedAtMs ?? 0, draft, notice: null, loading: true, olderLoading: false, forkPoints: null, forking: false, forkNotice, folderPicker: false, folderBusy: false, folderNotice: null, changes: null, feedback: { data: null, busy: false, reading: null } };
    this.#set({ open: this.open });
    await Promise.all([this.#loadOpen(), this.feedback.load()]);
  }

  closeConversation() {
    if (!this.open) return;
    this.open = null;
    this.#set({ open: null });
  }

  /** The latest page; overlapping requests collapse into one follow-up so a burst of `run` frames costs two reads. */
  async #loadOpen() {
    if (!this.open) return;
    if (this.openBusy) { this.openDirty = true; return; }
    this.openBusy = true;
    const key = this.open.key;
    try {
      const page = await this.#bridge().session(key);
      if (this.open?.key !== key) return;
      const receivedAtMs = this.now();
      // A newer page keeps the older turns already paged in, so refreshing does not throw away the reader's place.
      const merged = mergeLatest(this.open.page, page);
      this.#setOpen({ page: merged, receivedAtMs, loading: false, notice: this.open.notice });
      this.store.saveTranscript(key, merged, receivedAtMs).catch(() => {});
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (this.open?.key === key) {
        const notice = error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable;
        this.#setOpen({ loading: false, notice: this.open.page && error.code === 'unreachable' ? null : notice });
      }
    } finally {
      this.openBusy = false;
      if (this.openDirty) { this.openDirty = false; this.#loadOpen(); }
    }
  }

  async loadOlder() {
    const open = this.open;
    const cursor = open?.page?.previousCursor;
    if (!cursor || open.olderLoading) return;
    this.#setOpen({ olderLoading: true });
    try {
      const older = await this.#bridge().session(open.key, { before: cursor });
      if (this.open?.key !== open.key) return;
      const page = this.open.page;
      const seen = new Set(page.turns.map((t) => t.id));
      this.#setOpen({
        olderLoading: false,
        page: { ...page, turns: [...older.turns.filter((t) => !seen.has(t.id)), ...page.turns], hasMore: older.hasMore, previousCursor: older.previousCursor },
      });
    } catch (error) {
      if (this.open?.key !== open.key) return;
      // The conversation moved under the cursor: start again from the newest page instead of guessing.
      if (error instanceof BridgeError && error.code === 'stale-cursor') {
        this.#setOpen({ olderLoading: false, page: { ...this.open.page, previousCursor: undefined } });
        return this.#loadOpen();
      }
      this.#setOpen({ olderLoading: false, notice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
    }
  }

  #ran({ keys }) {
    if (this.open && (keys.length === 0 || keys.includes(this.open.key))) {
      this.#loadOpen();
      if (this.open.changes) this.#loadChanges();
      this.feedback.load();
    }
    // A run starting or ending is when a queued prompt turns running or leaves the queue.
    if (this.state.scheduled) this.#loadScheduled();
  }

  // ---- changes ---------------------------------------------------------------------------------

  /** Changes for the open chat: its review list and one file's diff at a time, read-only. */
  get changesOffered() {
    return !!this.open && reviewOffered(this.state.hello?.capabilities, this.open.key);
  }

  /** Opens the Changes panel, or refreshes it; the file shown stays unfolded when it is still in the list. */
  openChanges() {
    if (!this.open) return;
    const changes = this.open.changes ?? { list: null, loading: false, dirty: false, notice: null, path: null, diff: null, diffLoading: false, notes: null };
    this.#setOpen({ changes, forkPoints: null, folderPicker: false });
    return Promise.all([this.#loadChanges(), this.notesOffered && this.notes.load()]);
  }

  /** The composer's review-feedback chips, under `review-feedback-chips`; an ACP chat has none. */
  get feedbackOffered() {
    return !!this.open && chipsOffered(this.state.hello?.capabilities, this.open.key);
  }

  /** Review notes on the open chat's diff: the desk's own, under `review-notes`; an ACP chat has none (its key is not a desk session's). */
  get notesOffered() {
    return this.changesOffered && !this.open.key.startsWith('acp:') && notesOffered(this.state.hello?.capabilities);
  }

  /**
   * An attach or a retry answered [token]: it joins [key]'s draft and Changes closes, so the
   * message it rides is what the reader sees next (the phone's `attached`).
   */
  async #attachFeedback(key, token, message) {
    if (this.open?.key !== key) {
      await this.store.saveDraft(key, withToken(await this.store.draft(key), token));
      return this.notify(message);
    }
    this.onDraftWritten?.(key);
    await this.setDraft(key, withToken(this.open.draft, token));
    if (this.open?.key === key) this.#setOpen({ changes: null, notesNotice: message });
  }

  /** Codex's `/review` of the open chat's project, from its Changes, under `ai-review`. */
  get aiReviewOffered() {
    const row = this.changesOffered ? this.state.fleet?.rows.find((r) => r.key === this.open.key) : null;
    return !!row && aiReviewOffered(this.state.hello?.capabilities, row.vendor);
  }

  /** A finding's "Ask to fix": its request goes under the draft and waits for Send, as the desk marker's button. */
  async #askToFix(key, fixPrompt) {
    const message = 'The fix request is in your message. Send it when ready.';
    if (this.open?.key !== key) {
      await this.store.saveDraft(key, withFix(await this.store.draft(key), fixPrompt));
      return this.notify(message);
    }
    this.onDraftWritten?.(key);
    await this.setDraft(key, withFix(this.open.draft, fixPrompt));
    if (this.open?.key === key) this.#setOpen({ changes: null, notesNotice: message });
  }

  /** Said under Changes when it is open, else in the chat's banner, else the page's (Android's snack). */
  #say(key, message) {
    if (this.open?.key === key && this.open.changes) this.#patchChanges(key, { said: message });
    else if (this.open?.key === key) this.#setOpen({ notice: message });
    else this.notify(message);
  }

  /** A landed commit moves the fleet's "Done, unreviewed" row and empties the list, so both are read again. */
  async #committed(key, message) {
    const gen = this.pairingGen;
    try {
      const fleet = await this.#bridge()?.fleet();
      if (fleet && gen === this.pairingGen && this.state.phase === 'paired') this.#adopt(fleet, true);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
    }
    if (gen !== this.pairingGen) return;
    this.#say(key, message);
    if (this.open?.key === key && this.open.changes) this.#loadChanges();
  }

  closeChanges() {
    if (this.open?.changes) this.#setOpen({ changes: null });
  }

  #patchChanges(key, patch) {
    if (this.open?.key === key && this.open.changes) this.#setOpen({ changes: { ...this.open.changes, ...patch } });
  }

  /** Overlapping refreshes (a burst of `run` frames) collapse into one follow-up, as the transcript's do. */
  async #loadChanges() {
    const open = this.open;
    const bridge = this.#bridge();
    if (!open?.changes || !bridge) return;
    if (open.changes.loading) return this.#patchChanges(open.key, { dirty: true });
    const seq = ++this.changesSeq.list;
    const latest = () => seq === this.changesSeq.list && this.open?.key === open.key && !!this.open.changes;
    this.#patchChanges(open.key, { loading: true, dirty: false });
    let list;
    try {
      list = await bridge.review(open.key);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (latest()) this.#patchChanges(open.key, { loading: false, notice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
      return this.#changesFollowUp(open.key);
    }
    if (!latest()) return;
    const path = this.open.changes.path;
    const kept = path && list.files.some((f) => f.path === path);
    this.#patchChanges(open.key, { list, loading: false, notice: null, ...(kept ? {} : { path: null, diff: null, diffLoading: false }) });
    // The unfolded file changed too, or the run would not have been worth a refresh.
    if (kept) this.openChangedFile(path);
    this.#changesFollowUp(open.key);
  }

  #changesFollowUp(key) {
    if (this.open?.key === key && this.open.changes?.dirty && !this.open.changes.loading) this.#loadChanges();
  }

  /** Unfolds [path]'s diff; a second tap on another file replaces it, so only one diff is ever held. */
  async openChangedFile(path) {
    const open = this.open;
    const bridge = this.#bridge();
    if (!open?.changes || !bridge) return;
    const seq = ++this.changesSeq.diff;
    // A newer ask — another file, or this one again after a run — wins over this answer.
    const latest = () => seq === this.changesSeq.diff && this.open?.key === open.key && this.open.changes?.path === path;
    const same = open.changes.path === path;
    this.#patchChanges(open.key, { path, diff: same ? open.changes.diff : null, diffLoading: true, notice: null });
    let diff;
    try {
      diff = await bridge.reviewFile(open.key, path);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (latest()) this.#patchChanges(open.key, { diffLoading: false, notice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
      return;
    }
    if (latest()) this.#patchChanges(open.key, { diff, diffLoading: false });
  }

  /** Ticks or clears [paths] on the desk's checklist ([] = every file); the receipt's ticks merge into the list shown. */
  async markReviewed(paths, reviewed) {
    const open = this.open;
    const bridge = this.#bridge();
    if (!open?.changes?.list || open.changes.marking || !bridge) return;
    const gen = this.pairingGen;
    const live = () => gen === this.pairingGen && this.state.phase === 'paired';
    // Shown ticked at once, so the box the reader just changed does not flip back for the round trip.
    const asked = new Set(paths);
    const before = new Map(open.changes.list.files.map((f) => [f.path, f.reviewed]));
    this.#patchChanges(open.key, { marking: true, notice: null, list: withTicks(open.changes.list, (f) => (paths.length === 0 || asked.has(f.path) ? reviewed : undefined)) });
    let marked;
    try {
      marked = await bridge.markReviewed(open.key, paths, reviewed);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      const list = this.open?.key === open.key ? this.open.changes?.list : null;
      return this.#patchChanges(open.key, {
        marking: false,
        notice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable,
        ...(list ? { list: withTicks(list, (f) => before.get(f.path)) } : {}),
      });
    }
    const changes = this.open?.key === open.key ? this.open.changes : null;
    if (!changes?.list) return;
    // The receipt's rows carry ticks only (no status or counts), so they never replace the list's rows.
    const ticks = new Map(marked.files.map((f) => [f.path, f.reviewed]));
    this.#patchChanges(open.key, {
      marking: false,
      list: withTicks(changes.list, (f) => ticks.get(f.path)),
      // A read already in flight may predate the tick: one more read after it, as for a run frame.
      dirty: changes.loading || changes.dirty,
    });
    // The fleet's "Done, unreviewed" row moves once the chat is reviewed.
    try {
      const fleet = await bridge.fleet();
      if (live()) this.#adopt(fleet, true);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
    }
  }

  closeChangedFile() {
    if (this.open?.changes) this.#patchChanges(this.open.key, { path: null, diff: null, diffLoading: false });
  }

  // ---- revert (Changes › Revert…) ---------------------------------------------------------------

  #patchRevert(key, patch) {
    const revert = this.open?.key === key ? this.open.changes?.revert : null;
    if (revert) this.#patchChanges(key, { revert: { ...revert, ...patch } });
  }

  /**
   * Opens "Revert to session start" over a fresh preview; [keep] is the reader's selection to carry
   * over a re-read (a stale preview), which never re-ticks a file the reader unticked. [target]
   * (`chooseRevert`) switches to another revert of the chat; a re-read stays on the sheet's own.
   */
  async openRevert(notice = null, keep = null, target = null) {
    const open = this.open;
    const bridge = this.#bridge();
    if (!open?.changes || !bridge) return;
    const prior = target ?? open.changes.revert;
    const scope = prior?.scope ?? 'session';
    const request = scope === 'session' ? null : prior.request;
    const reading = { preview: null, chosen: [], loading: true, reverting: false, error: notice, scope, request, requests: prior?.requests ?? [] };
    this.#patchChanges(open.key, { revert: reading, commit: null, aiReview: null, said: null, notice: null });
    const current = () => this.open?.key === open.key && this.open.changes?.revert === reading;
    let preview;
    try {
      preview = await bridge.revertPreview(open.key, scope, request?.request);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (current()) this.#patchChanges(open.key, { revert: null, notice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
      return;
    }
    if (!current()) return;
    // An answer for another revert than the one asked is never shown as one to confirm.
    if (preview.scope !== scope || (request && !preview.refused && preview.request?.request !== request.request)) {
      return this.#patchChanges(open.key, { revert: null, notice: "This machine answered a different revert. Update the plugin, or revert in the IDE." });
    }
    // Listed only by a machine that also takes the scope; one without would revert the whole session instead.
    const requests = scope === 'session' ? (requestRevertOffered(this.state.hello?.capabilities) ? preview.requests : []) : reading.requests;
    // One request's refusal ("nothing after it") stays in its sheet, with Back to the whole session; so does
    // the whole session's while it lists requests, since a request rebuilds from the transcript, not the start copy.
    if (preview.refused) {
      if (!request && requests.length === 0) return this.#patchChanges(open.key, { revert: null, notice: preview.refused });
      return this.#patchRevert(open.key, { loading: false, error: preview.refused, requests, ...(request ? {} : { preview }) });
    }
    const offered = preview.files.filter(revertable).map((f) => f.path);
    this.#patchRevert(open.key, {
      preview,
      loading: false,
      chosen: keep ? offered.filter((p) => keep.includes(p)) : offered,
      request: request && (preview.request ?? request),
      requests,
    });
  }

  /** Switches the open sheet to [request]'s own changes (`request`), everything after it (`after`), or the whole session again. */
  chooseRevert(scope, request = null) {
    const revert = this.open?.changes?.revert;
    if (!revert || revert.reverting || !['session', 'request', 'after'].includes(scope) || (scope !== 'session' && !request?.request)) return;
    return this.openRevert(null, null, { scope, request: scope === 'session' ? null : request, requests: revert.requests });
  }

  toggleRevertFile(path) {
    const revert = this.open?.changes?.revert;
    if (!revert?.preview || revert.reverting || !revert.preview.files.some((f) => f.path === path && revertable(f))) return;
    const chosen = revert.chosen.includes(path) ? revert.chosen.filter((p) => p !== path) : [...revert.chosen, path];
    this.#patchRevert(this.open.key, { chosen });
  }

  closeRevert() {
    if (this.open?.changes?.revert && !this.open.changes.revert.reverting) this.#patchChanges(this.open.key, { revert: null });
  }

  /**
   * The confirmed revert. An answer that never arrived keeps its operation id, so the identical
   * retry is answered with the first attempt's outcome instead of writing again (the phone's
   * `ReviewRevertFlow`); any definite answer retires it.
   */
  async confirmRevert() {
    const open = this.open;
    const revert = open?.changes?.revert;
    const bridge = this.#bridge();
    const preview = revert?.preview;
    if (!preview || preview.refused || revert.reverting || revert.loading || revert.chosen.length === 0 || !bridge) return;
    const gen = this.pairingGen;
    const paths = [...revert.chosen].sort();
    const scope = revert.scope ?? 'session';
    const request = scope === 'session' ? null : revert.request?.request ?? null;
    const same = (u) => u && u.key === open.key && u.previewToken === preview.previewToken && u.paths.join('\n') === paths.join('\n') && u.scope === scope && u.request === request;
    const operationId = same(this.revertUncertain) ? this.revertUncertain.operationId : this.mintId();
    const asked = { key: open.key, previewToken: preview.previewToken, paths, operationId, scope, request };
    this.#patchRevert(open.key, { reverting: true, error: null });
    // The answer belongs to this sheet only: the reader may close Changes meanwhile and open another revert.
    const sheet = this.open.changes.revert;
    const shown = () => this.open?.key === open.key && this.open.changes?.revert === sheet;
    // Never dropped: under the sheet, else in the chat's own banner, else the page's (Android's snack).
    const tell = (message, { keepSheet }) => {
      if (shown()) return this.#patchChanges(open.key, keepSheet ? { revert: { ...sheet, reverting: false, error: message } } : { revert: null, said: message });
      if (this.open?.key === open.key) return this.#setOpen({ notice: message });
      this.notify(message);
    };
    let result;
    try {
      result = await bridge.revert(open.key, preview.previewToken, paths, operationId, scope, request);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (gen !== this.pairingGen) return;
      const said = error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable;
      if (error instanceof BridgeError && error.code === 'revert-preview-stale') {
        this.revertUncertain = null;
        // The files moved: read them again and let the reader look before reverting.
        return shown() ? this.openRevert(said, paths) : tell(said, { keepSheet: true });
      }
      this.revertUncertain = error instanceof BridgeError && (error.code === 'revert-unconfirmed' || error.maybeDelivered) ? asked : null;
      return tell(said, { keepSheet: true });
    }
    if (gen !== this.pairingGen) return;
    this.revertUncertain = null;
    // The machine's message already names any file it could not revert.
    if (!result.reverted) return tell(result.message || 'Nothing was reverted.', { keepSheet: true });
    try {
      const fleet = await bridge.fleet();
      if (gen === this.pairingGen && this.state.phase === 'paired') this.#adopt(fleet, true);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
    }
    if (gen !== this.pairingGen) return;
    tell(result.message, { keepSheet: false });
    if (this.open?.key === open.key && this.open.changes) this.#loadChanges();
  }

  // ---- fork -----------------------------------------------------------------------------------

  /** A Claude chat forks at one of the reader's messages; an older plugin answers `/v1/session-fork` with `unknown-route`. */
  get forkOffered() {
    return !!this.state.hello?.capabilities?.includes('session-fork');
  }

  /** Branch chat: Codex's `thread/fork` came with `session-fork`; a whole Claude copy needs `session-branch`. */
  branchOffered(vendor) {
    return !!this.state.hello?.capabilities?.includes(vendor === 'CODEX' ? 'session-fork' : 'session-branch');
  }

  /** Asks the machine which messages the open Claude chat can be forked from; the picker opens with them. */
  async startFork() {
    const open = this.open;
    const bridge = this.#bridge();
    if (!open || open.forking || !bridge) return;
    const gen = this.pairingGen;
    this.#setOpen({ forking: true, forkNotice: null, folderPicker: false, changes: null });
    let points;
    try {
      points = await bridge.forkPoints(open.key);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (this.open?.key === open.key) this.#setOpen({ forking: false, forkNotice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
      return;
    }
    if (gen !== this.pairingGen || this.open?.key !== open.key) return;
    if (points.refused) return this.#setOpen({ forking: false, forkNotice: points.refused });
    if (!points.points.length) return this.#setOpen({ forking: false, forkNotice: 'This chat has no earlier turn to fork from — start a new chat instead.' });
    this.#setOpen({ forking: false, forkPoints: points });
  }

  dismissFork() {
    if (this.open?.forkPoints) this.#setOpen({ forkPoints: null });
  }

  /** "New chat from here": the fork keeps everything before [pointId] and puts that message in the new chat's message box. */
  forkAt(pointId) {
    const open = this.open;
    // A pick while a branch is under way would be dropped silently; the picker stays for after it.
    if (!open?.forkPoints || open.forking) return;
    this.#setOpen({ forkPoints: null });
    return this.#runFork({ key: open.key, point: pointId });
  }

  /** The desk's Branch chat: the whole open chat copied onto a new one, opened with an empty message box. */
  branchChat() {
    if (!this.open || this.open.forking) return;
    this.#setOpen({ forkPoints: null });
    return this.#runFork({ key: this.open.key, whole: true });
  }

  #forkOperation(key, point) {
    const id = `${key}\n${point ?? ''}`;
    if (!this.forkOperations.has(id)) this.forkOperations.set(id, this.mintId());
    return this.forkOperations.get(id);
  }

  /**
   * Asks for the fork, then opens it — only if the reader is still in the chat it was asked from,
   * so a slow fork never moves them out of what they went on to do. The message forked from goes
   * into the new chat's message box, only when that box is empty.
   */
  async #runFork({ key, point, whole = false }) {
    const bridge = this.#bridge();
    if (!bridge || this.open?.forking) return;
    const gen = this.pairingGen;
    const live = () => gen === this.pairingGen && this.state.phase === 'paired';
    const title = this.open?.page?.title || this.state.fleet?.rows.find((r) => r.key === key)?.title || 'this chat';
    this.#setOpen({ forking: true, forkNotice: `${whole ? 'Branching' : 'Forking'} “${title}”…` });
    let result;
    try {
      result = await bridge.fork({ key, point, whole, operationId: this.#forkOperation(key, point) });
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (this.open?.key === key) this.#setOpen({ forking: false, forkNotice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
      return;
    }
    this.forkOperations.delete(`${key}\n${point ?? ''}`);
    if (!live()) return;
    const here = this.open?.key === key;
    if (!result.forked || !result.newKey) {
      if (here) this.#setOpen({ forking: false, forkNotice: result.message });
      return;
    }
    // Each await can end with the pairing gone: nothing is written back into a cleared store.
    if (result.promptText?.trim() && !(await this.store.draft(result.newKey))?.trim() && live()) {
      await this.store.saveDraft(result.newKey, result.promptText).catch(() => {});
    }
    try {
      const fleet = await bridge.fleet();
      if (live()) this.#adopt(fleet, true);
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      // otherwise the stream brings the row soon enough
    }
    if (!live()) return;
    if (!here || this.open?.key !== key) return;
    if (!result.listed) return this.#setOpen({ forking: false, forkNotice: result.message });
    this.#setOpen({ forking: false, forkNotice: null });
    this.arrival = { key: result.newKey, notice: result.message };
    this.navigate(result.newKey);
  }

  // ---- folders --------------------------------------------------------------------------------

  /** The desk's Sessions folders; an older plugin sends none, which must not read as "this machine has none". */
  get foldersOffered() {
    return !!this.state.hello?.capabilities?.includes('session-folders');
  }

  /** Rename, note, done and delete of a folder; an older plugin answers `/v1/folder-actions` with `unknown-route`. */
  get folderEditOffered() {
    return !!this.state.hello?.capabilities?.includes('folder-actions');
  }

  openFolderPicker() {
    if (this.open) this.#setOpen({ folderPicker: true, forkPoints: null, folderNotice: null, changes: null });
  }

  dismissFolderPicker() {
    if (this.open?.folderPicker) this.#setOpen({ folderPicker: false });
  }

  /** Files the open chat under [folderId]; blank takes it out of its folder. */
  fileIn(folderId) {
    return this.#file({ action: 'folder', folderId });
  }

  /** Creates a folder named [name] and files the open chat in it — the desk's "New folder" from a row. */
  fileInNew(name) {
    return this.#file({ action: 'folder-new', title: normalizeFolderName(name) });
  }

  /** True once the machine filed the chat; the list takes its answer before the next fleet frame. */
  async #file(request) {
    const open = this.open;
    const bridge = this.#bridge();
    if (!open || open.folderBusy || !bridge) return false;
    const gen = this.pairingGen;
    this.#setOpen({ folderBusy: true, folderNotice: null });
    let result;
    try {
      result = await bridge.sessionAction({ key: open.key, ...request });
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) { this.#revoked(error); return false; }
      if (this.open?.key === open.key) this.#setOpen({ folderBusy: false, folderNotice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
      return false;
    }
    if (gen !== this.pairingGen) return false;
    this.#adopt(withSessionResult(this.state.fleet, result), true);
    const name = result.folders.find((f) => f.id === result.folderId)?.name;
    const notice = request.action === 'folder-new' ? `Created “${name ?? request.title}” and moved the chat there.`
      : name ? `Moved to “${name}”.` : 'Removed from its folder.';
    if (this.open?.key === open.key) this.#setOpen({ folderBusy: false, folderPicker: false, folderNotice: notice });
    return true;
  }

  /** Saves [changes] (`{name?, note?, done?}`) on a folder; true once the machine wrote them. */
  editFolder(folderId, changes) {
    return this.#folderWrite(folderId, { action: 'edit', ...changes });
  }

  /** Deletes a folder; its chats stay listed, in no folder. The desk has no Undo for it either. */
  deleteFolder(folderId) {
    return this.#folderWrite(folderId, { action: 'delete' });
  }

  async #folderWrite(folderId, request) {
    const bridge = this.#bridge();
    if (!bridge || this.state.folders?.busy) return false;
    const gen = this.pairingGen;
    const before = this.state.fleet?.folders?.find((f) => f.id === folderId)?.name;
    this.#set({ folders: { busy: true, notice: null } });
    let result;
    try {
      result = await bridge.folderAction({ folderId, ...request });
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) { this.#revoked(error); return false; }
      if (gen === this.pairingGen) this.#set({ folders: { busy: false, notice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable } });
      return false;
    }
    if (gen !== this.pairingGen) return false;
    const deleted = request.action === 'delete';
    this.#adopt(withFolderResult(this.state.fleet, folderId, result, deleted), true);
    const name = result.folders.find((f) => f.id === folderId)?.name ?? before ?? request.name ?? '';
    this.#set({ folders: { busy: false, notice: deleted ? `Deleted the folder “${name}”.` : `Saved the folder “${name}”.` } });
    return true;
  }

  // ---- new chat -------------------------------------------------------------------------------

  /** Opens with the last pick while its project is still open; the words typed earlier come back. */
  async openNewChat() {
    if (this.state.phase !== 'paired' || this.state.newChat) return;
    const gen = this.pairingGen;
    // "Later" only while the machine honours it; otherwise the pick would silently run now.
    const dueAtMs = this.scheduleCreateOffered ? this.newChatDueAtMs ?? null : null;
    this.newChatDueAtMs = null;
    this.#set({ newChat: { target: defaultTarget(this.state.fleet, this.newChatTarget), draft: '', dueAtMs } });
    const draft = await this.store.draft(NEW_CHAT_DRAFT);
    if (gen === this.pairingGen && this.state.newChat) this.#set({ newChat: { ...this.state.newChat, draft } });
  }

  closeNewChat() {
    if (this.state.newChat) this.#set({ newChat: null });
  }

  /**
   * New chat's When: null is now, else the instant the machine should start it. [quiet] records a
   * typed "Run at" without a re-render, which would rebuild the field and put the caret back on its first segment.
   */
  setNewChatDue(dueAtMs, { quiet = false } = {}) {
    if (!this.state.newChat) return;
    const patch = { newChat: { ...this.state.newChat, dueAtMs } };
    if (quiet) this.state = { ...this.state, ...patch };
    else this.#set(patch);
  }

  /** Another agent's model, effort and account are not this one's: switching the agent drops them. */
  setNewChatTarget(patch) {
    const current = this.state.newChat?.target;
    if (!current) return;
    const vendorChanged = patch.vendor !== undefined && patch.vendor !== current.vendor;
    const target = vendorChanged ? { projectPath: current.projectPath, ...patch } : { ...current, ...patch };
    this.newChatTarget = target;
    this.#set({ newChat: { ...this.state.newChat, target } });
  }

  /**
   * Queues [text] as a new chat and goes back to the list, where it shows until the machine takes it.
   * Only empty input or no open project declines (W5); an unreachable machine gets it when it is back.
   */
  async startNewChat(text) {
    const prompt = (text ?? '').trim();
    const target = this.state.newChat?.target;
    if (!prompt || !target || this.state.phase !== 'paired') return false;
    const dueAtMs = this.scheduleCreateOffered ? this.state.newChat.dueAtMs ?? undefined : undefined;
    await this.outbox.enqueue({
      origin: this.state.session.origin, key: '', projectPath: target.projectPath, vendor: target.vendor,
      label: projectName(target.projectPath), prompt, start: picksFor(this.state.hello, target), dueAtMs,
    });
    await this.setDraft(NEW_CHAT_DRAFT, '');
    this.#set({ newChat: null, startNotice: null });
    this.show('list');
    this.#deliver();
    return true;
  }

  dismissStartNotice() {
    if (this.state.startNotice) this.#set({ startNotice: null });
  }

  /** A new chat that did not start goes back into the New chat screen, words and picks, above anything typed since. */
  async editNewChat(id) {
    const item = this.outbox.items.find((i) => i.id === id && !i.key);
    if (!item) return;
    await this.outbox.discard(id);
    const typed = await this.store.draft(NEW_CHAT_DRAFT);
    await this.store.saveDraft(NEW_CHAT_DRAFT, typed ? `${item.prompt}\n\n${typed}` : item.prompt);
    this.newChatTarget = { projectPath: item.projectPath, vendor: item.vendor, ...item.start };
    // A time that passed while the start sat parked would run it at once; Later reopens on the next free hour instead.
    this.newChatDueAtMs = item.dueAtMs ? (item.dueAtMs > this.now() ? item.dueAtMs : laterDefault(this.now())) : null;
    this.show('new-chat');
  }

  /** Persists the message box as typed; a draft is cleared only when its words are consumed. */
  setDraft(key, text) {
    if (this.open?.key === key) this.open = { ...this.open, draft: text };
    return this.store.saveDraft(key, text);
  }

  /** The reader typed in the open chat's box: a review-notes token they erased detaches its feedback. */
  editDraft(key, text) {
    const before = this.open?.key === key ? this.open.draft : null;
    const saved = this.setDraft(key, text);
    if (before !== null && this.open.feedback?.data?.chips.length) {
      this.feedback.draftEdited(key, before ?? '', text);
      // Which chips show follows the typed tokens; the box keeps focus and caret across the repaint.
      if (tokenSet(before) !== tokenSet(text)) this.#set({ open: this.open });
    }
    return saved;
  }

  /**
   * Queues [text] for the open conversation and tries to deliver it. Empty input is the one thing
   * declined (W5); anything else is the outbox's, durably, before the draft is cleared.
   */
  async send(text) {
    const open = this.open;
    const prompt = (text ?? '').trim();
    if (!open || !prompt) return false;
    const row = this.state.fleet?.rows.find((r) => r.key === open.key);
    await this.outbox.enqueue({
      origin: this.state.session.origin, key: open.key, projectPath: row?.projectPath ?? '',
      vendor: row?.vendor ?? vendorOf(open.key), label: open.page?.title || row?.title || '', prompt,
    });
    await this.setDraft(open.key, '');
    this.#setOpen({ notice: null, forkNotice: null, folderNotice: null, notesNotice: null });
    this.#deliver();
    return true;
  }

  /** Stop is never pre-refused: the machine is asked, then the outcome is reported (W5). */
  async stop() {
    const open = this.open;
    if (!open) return;
    try {
      await this.#bridge().stop(open.key);
      if (this.open?.key === open.key) this.#setOpen({ notice: null });
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (this.open?.key === open.key) this.#setOpen({ notice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
    }
    this.#loadOpen();
  }

  /** Answers the open conversation's parked question; [answers] is keyed by question, values are option labels or typed words. */
  async answer({ askId, answers, typed = [] }) {
    const open = this.open;
    if (!open) return;
    try {
      const accepted = await this.#bridge().answer({ key: open.key, askId, answers, typed });
      if (this.open?.key === open.key) {
        this.#setOpen({ notice: accepted.parked ? null : 'That question had already been settled, so your answer was sent as a new message.' });
      }
    } catch (error) {
      if (error instanceof BridgeError && error.revoked) return this.#revoked(error);
      if (this.open?.key === open.key) this.#setOpen({ notice: error instanceof BridgeError ? messageFor(error) : MESSAGES.unreachable });
    }
    this.#loadOpen();
  }

  async retryOutgoing(id) {
    await this.outbox.retry(id);
    this.#deliver();
  }

  discardOutgoing(id) {
    return this.outbox.discard(id);
  }

  /** Puts a queued prompt's words back into the message box, above whatever has been typed since. */
  async editOutgoing(id) {
    const words = await this.outbox.edit(id);
    if (words === null || !this.open) return;
    const draft = this.open.draft ? `${words}\n\n${this.open.draft}` : words;
    this.onDraftWritten?.(this.open.key);
    await this.setDraft(this.open.key, draft);
    this.#set({ open: this.open });
  }

  async #revoked(error) {
    this.pairingGen += 1;
    this.revertUncertain = null;
    this.notes.forget();
    this.commit.forget();
    this.aiReview.forget();
    this.disconnect();
    this.closeUsage();
    this.closeScheduled();
    this.clearMessageSearch();
    await this.push?.forget();
    await this.store.clearKeepingWords();
    this.open = null;
    this.#set({ phase: 'pairing', session: null, fleet: null, receivedAtMs: 0, live: false, notice: messageFor(error), hello: null, open: null, usage: null, messageSearch: null, push: null, folders: null, newChat: null, startNotice: null, scheduled: null });
  }
}

const tokenSet = (text) => [...tokensIn(text)].sort().join(' ');

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The newest page with the older turns the reader already paged in kept in front of it. Turns are
 * matched by id, so a turn the machine rewrote in place (a streaming one) is replaced, not doubled.
 */
export function mergeLatest(previous, latest) {
  if (!previous || previous.key !== latest.key) return latest;
  const ids = new Set(latest.turns.map((t) => t.id));
  const first = latest.turns[0]?.id;
  const at = previous.turns.findIndex((t) => t.id === first);
  const older = at >= 0 ? previous.turns.slice(0, at) : [];
  if (!older.length) return latest;
  return {
    ...latest,
    turns: [...older.filter((t) => !ids.has(t.id)), ...latest.turns],
    hasMore: previous.hasMore,
    previousCursor: previous.previousCursor,
  };
}
