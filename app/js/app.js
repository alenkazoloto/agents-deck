import { Deck } from './deck.js';
import { h } from './dom.js';
import { ago, clock } from './format.js';
import { SECTION_CAP, groupOf, searchEligible, searchPopulation, sections, stateLabel } from './wire.js';
import { complete, newSearch, searchStatus, visibleHits } from './search.js';
import { Store, idbBackend } from './store.js';
import { conversationView, ui } from './conversation.js';
import { Push, browserEnv } from './push.js';
import { usageView } from './usage.js';
import { folderFilterView, forgetFolderDrafts, inFolder, liveChoice } from './folders.js';
import { NEW_CHAT_DRAFT, newChatView, startingView } from './newchat.js';
import { scheduledView, whenView } from './scheduled.js';

const root = document.getElementById('app');
const store = new Store(idbBackend());
// A fork the deck made opens through the address bar, like a tapped row, so Back returns to the chat it came from.
const deck = new Deck({
  store, userAgent: navigator.userAgent, push: new Push(browserEnv(), store),
  navigate: (key) => { location.hash = `c=${encodeURIComponent(key)}`; },
  show: (screen) => { location.hash = screen === 'new-chat' ? 'new' : ''; },
});

// Drafts survive a failed pairing: only a successful pair clears them.
const drafts = { link: '', address: '', code: '' };
const expanded = new Set();
let search = '';
/** The list's folder filter: undefined is all folders, `UNFILED` the chats in none. */
let folderChoice;
// The message search is asked after a pause in typing, so a word typed letter by letter asks once.
const MESSAGE_SEARCH_PAUSE_MS = 400;
let searchAsked = '';
let searchTimer = null;

// ---- pairing --------------------------------------------------------------------------------------

function pairingView(state) {
  if (state.pending) {
    return h('section', { class: 'card' },
      h('h1', {}, `Pair with ${state.pending.machine || 'this machine'}?`),
      h('p', { class: 'dim' }, state.pending.origin.replace('https://', '')),
      h('p', {}, 'Pairing lets this browser see your conversations and send to them. You can remove it later from the IDE, under Settings › Connections › Mobile.'),
      state.notice && h('p', { class: 'notice', role: 'alert' }, state.notice),
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: state.busy, onclick: () => deck.confirmPairing() }, 'Pair'),
        h('button', { disabled: state.busy, onclick: () => deck.cancelPending() }, 'Cancel')));
  }
  const link = h('textarea', {
    rows: 3, placeholder: 'Paste pairing link', 'aria-label': 'Pairing link', spellcheck: 'false', autocapitalize: 'off',
    oninput: (e) => { drafts.link = e.target.value; },
  });
  link.value = drafts.link;
  const address = h('input', {
    type: 'text', placeholder: 'mac.tail1234.ts.net', 'aria-label': 'Machine address', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
    oninput: (e) => { drafts.address = e.target.value; },
  });
  address.value = drafts.address;
  const code = h('input', {
    type: 'text', inputmode: 'numeric', placeholder: '8-digit code', 'aria-label': 'Pairing code', autocomplete: 'off',
    oninput: (e) => { drafts.code = e.target.value; },
  });
  code.value = drafts.code;
  return h('section', { class: 'card' },
    h('h1', {}, 'Agents Deck'),
    h('p', {}, 'Pair this browser with your machine. In the IDE, open Settings › Connections › Mobile, turn on Browser access and press Pair.'),
    state.notice && h('p', { class: 'notice', role: 'alert' }, state.notice),
    link,
    h('button', { class: 'primary', disabled: state.busy, onclick: () => deck.prepare(drafts.link) }, 'Continue'),
    h('p', { class: 'dim' }, 'Or type it:'),
    address, code,
    h('button', { disabled: state.busy, onclick: () => deck.prepareTyped(drafts.address, drafts.code) }, 'Continue'));
}

// ---- fleet ----------------------------------------------------------------------------------------

function rowView(row, groupId, nowMs, snippet, folders) {
  // The folder is named only while the list is not already narrowed to it.
  const folder = folders?.find((f) => f.id === row.folderId)?.name;
  const detail = [row.projectName, row.gitBranch, folder].filter(Boolean).join(' · ');
  return h('li', { class: `row-item ${row.attention ?? ''}` },
    h('button', { class: 'row-open', onclick: () => { location.hash = `c=${encodeURIComponent(row.key)}`; } },
      h('div', { class: 'title' }, row.title || '(untitled)'),
      detail && h('div', { class: 'dim' }, detail),
      snippet && h('div', { class: 'snippet' }, snippet),
      h('div', { class: 'state' }, stateLabel(row, groupId), row.liveLine ? ` — ${row.liveLine}` : ''),
      h('div', { class: 'dim' }, ago(row.lastActivityMs, nowMs))));
}

/** Asks the machine once the query or the chats to read have held still for a moment; an ineligible query clears at once. */
function askMessageSearch(query, keys) {
  // Sorted: fleet frames reorder running chats, and that alone must not keep re-arming the pause.
  const asked = `${query}\n${[...keys].sort().join('\n')}`;
  if (asked === searchAsked) return;
  searchAsked = asked;
  clearTimeout(searchTimer);
  // Never synchronously: this runs while a frame is being built, and the answer re-renders.
  searchTimer = setTimeout(() => deck.searchMessages(query, keys), keys.length ? MESSAGE_SEARCH_PAUSE_MS : 0);
}

function messageSearchView(ms, hits, fleet, folders) {
  const status = searchStatus(ms, hits.length);
  return h('section', {},
    hits.length > 0 && h('h2', {}, 'In messages ', h('span', { class: 'count' }, String(hits.length))),
    hits.length > 0 && h('ul', {}, hits.map(({ row, snippet }) => rowView(row, groupOf(row, fleet.generatedAtMs), fleet.generatedAtMs, snippet, folders))),
    h('p', { class: `dim search-status${ms.error ? ' notice' : ''}`, role: 'status' }, status.text,
      status.action && h('button', { class: 'link', onclick: () => deck.searchMoreMessages() }, status.action)));
}

function listView(state) {
  const everything = state.fleet;
  const narrowed = deck.foldersOffered && liveChoice(everything, folderChoice) !== undefined;
  const fleet = deck.foldersOffered ? inFolder(everything, folderChoice) : everything;
  const folders = deck.foldersOffered && !narrowed ? everything?.folders : undefined;
  if (!fleet) return h('p', { class: 'dim empty' }, state.reachable ? 'Loading…' : 'Nothing saved yet — connect once to see your conversations.');
  const groups = sections(fleet, search);
  const query = search.trim();
  const keys = deck.messageSearchOffered && searchEligible(query) ? searchPopulation(fleet, query) : [];
  askMessageSearch(query, keys);
  // During the typing pause nothing has been asked yet, and that reads as searching: an empty list
  // there would say "No conversation matches" about messages nobody has read.
  const ms = !keys.length ? null : state.messageSearch?.query === query ? state.messageSearch : newSearch(query, keys);
  const byKey = new Map(fleet.rows.map((r) => [r.key, r]));
  const hits = ms ? visibleHits(ms, keys).filter((x) => byKey.has(x.key)).map((x) => ({ row: byKey.get(x.key), snippet: x.snippet })) : [];
  // "No conversation matches" is said only once the messages were searched too, and found nothing.
  if (!groups.length && (!ms || (complete(ms) && !ms.timedOut && !hits.length))) {
    return h('p', { class: 'dim empty' }, search ? 'No conversation matches.' : narrowed ? 'No conversations in this folder.' : 'No conversations yet.');
  }
  return h('div', {}, groups.map((g) => {
    const capped = groups.length > 1 && !expanded.has(g.id) && g.rows.length > SECTION_CAP;
    const rows = capped ? g.rows.slice(0, SECTION_CAP) : g.rows;
    return h('section', {},
      h('h2', {}, `${g.title} `, h('span', { class: 'count' }, String(g.rows.length))),
      h('ul', {}, rows.map((r) => rowView(r, g.id, fleet.generatedAtMs, undefined, folders))),
      capped && h('button', { class: 'link', onclick: () => { expanded.add(g.id); render(deck.state); } }, `Show all ${g.rows.length}`));
  }), ms && messageSearchView(ms, hits, fleet, folders));
}

// Offered only when the machine says it will push and this browser can receive one; never asks by itself.
function pushView(state) {
  const push = state.push;
  if (!push?.offered) return null;
  if (push.support === 'needs-install') {
    return h('p', { class: 'dim push' }, 'To get notifications on this iPhone, add Agents Deck to your Home Screen and open it from there.');
  }
  if (push.support !== 'ready') return null;
  const blocked = push.permission === 'denied';
  return h('div', { class: 'push' },
    push.subscribed
      ? h('p', { class: 'dim' }, 'Notifications are on for runs that need you, fail or finish.',
        h('button', { class: 'link', disabled: push.busy, onclick: () => deck.disablePush() }, 'Turn off'))
      : h('button', { disabled: push.busy || blocked, onclick: () => deck.enablePush() }, 'Notify me when a run needs you'),
    blocked && !push.subscribed && h('p', { class: 'dim' }, "Notifications are blocked for this app. Allow them in your browser's site settings."),
    push.notice && h('p', { class: 'notice', role: 'alert' }, push.notice));
}

function statusView(state) {
  const stamp = state.fleet?.generatedAtMs || state.receivedAtMs;
  if (state.live) return h('span', { class: 'pill live' }, 'Live');
  return h('span', { class: 'pill' }, stamp ? `as of ${clock(stamp)}` : 'not connected');
}

function fleetView(state) {
  const machine = state.session?.machine || 'your machine';
  const searchBox = h('input', {
    type: 'search', placeholder: 'Search conversations', 'aria-label': 'Search conversations', autocomplete: 'off',
    oninput: (e) => { search = e.target.value; render(deck.state); },
  });
  searchBox.value = search;
  return h('div', {},
    h('header', {}, h('h1', {}, machine), statusView(state)),
    h('div', { class: 'row new-chat-row' }, h('button', { class: 'primary', onclick: () => { location.hash = 'new'; } }, 'New chat')),
    !state.reachable && h('div', { class: 'banner', role: 'status' },
      `Can't reach ${machine} — is Tailscale on?`,
      h('button', { class: 'link', onclick: () => deck.connect() }, 'Retry')),
    state.polling && h('div', { class: 'banner', role: 'status' }, 'Another device took the live stream; refreshing every 30 seconds.'),
    state.notice && h('div', { class: 'banner', role: 'alert' }, state.notice),
    state.startNotice && h('div', { class: 'banner', role: 'status' }, state.startNotice,
      h('button', { class: 'link', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => deck.dismissStartNotice() }, '✕')),
    startingView(deck.outbox.items.filter((i) => !i.key && i.origin === state.session?.origin), deck, deck.outbox.deliveringId),
    searchBox,
    folderFilterView(state, deck, folderChoice, (c) => { folderChoice = c; render(deck.state); }, () => render(deck.state)),
    listView(state),
    // Only a machine advertising `usage` answers the route; an older plugin would say `unknown-route`.
    deck.usageOffered && h('div', { class: 'usage-link' }, h('button', { class: 'link', onclick: () => { location.hash = 'usage'; } }, 'Usage and plan limits')),
    deck.scheduledOffered && h('div', { class: 'usage-link' }, h('button', { class: 'link', onclick: () => { location.hash = 'scheduled'; } }, 'Scheduled prompts')),
    pushView(state),
    h('footer', {}, h('button', { class: 'link', onclick: () => { if (confirm(`Unpair this browser from ${machine}?`)) deck.unpair(); } }, 'Unpair this browser')));
}

// ---- shell ----------------------------------------------------------------------------------------

// A view is rebuilt on every frame, so what the reader is in the middle of — the search box, the
// message box, an answer's own text box (caret included), the scroll position and a diff's own scroll — is handed back
// to the new elements. Boxes are found again by their aria-label, which each view sets.
function render(state) {
  const active = document.activeElement;
  const label = root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName) ? active.getAttribute('aria-label') : null;
  const kind = label ? `[aria-label="${CSS.escape(label)}"]` : null;
  const caret = kind && typeof active.selectionStart === 'number' ? { start: active.selectionStart, end: active.selectionEnd } : null;
  const atBottom = state.open && innerHeight + scrollY >= document.documentElement.scrollHeight - 120;
  // A box that scrolls on its own (a diff's long lines) is found again by its `data-scroll` name.
  const inner = [...root.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollLeft, el.scrollTop]);
  // The memo belongs to one pairing: after an unpair or revoke the same query must ask the new one.
  if (state.phase !== 'paired') { clearTimeout(searchTimer); searchAsked = ''; folderChoice = undefined; forgetFolderDrafts(); }
  const view = state.phase === 'loading' ? h('p', { class: 'dim empty' }, 'Loading…')
    : state.phase === 'pairing' ? pairingView(state)
    : state.usage ? usageView(state, deck, { back: () => { location.hash = ''; } })
    : state.scheduled ? scheduledView(state, deck, { back: () => { location.hash = ''; } })
    : state.newChat ? newChatView(state, deck, { back: () => { location.hash = ''; }, text: ui.text, when: deck.scheduleCreateOffered && whenView(state.newChat.dueAtMs, deck) })
    : state.open ? conversationView(state, deck, { back: () => { location.hash = ''; }, rerender: () => render(deck.state) })
    : fleetView(state);
  root.replaceChildren(view);
  // Unpaired or revoked while a conversation was open: its address must not linger, or opening the same row again is no navigation.
  if (state.phase === 'pairing' && (location.hash.startsWith('#c=') || SCREENS.has(location.hash))) history.replaceState(null, '', location.pathname + location.search);
  for (const [name, left, top] of inner) {
    const box = root.querySelector(`[data-scroll="${CSS.escape(name)}"]`);
    if (box) { box.scrollLeft = left; box.scrollTop = top; }
  }
  if (kind) {
    const box = root.querySelector(kind);
    box?.focus();
    if (caret) box?.setSelectionRange?.(caret.start, caret.end);
  }
  // A review note opened by click or Enter on a diff line: its text box, not the top of the page.
  const opened = deck.notes.takeFocus();
  if (opened) root.querySelector(`[aria-label="${CSS.escape(opened)}"]`)?.focus();
  // A successful pair consumes the pairing drafts; after Unpair the form starts empty.
  if (state.phase === 'paired') { drafts.link = ''; drafts.address = ''; drafts.code = ''; }
  if (state.open && (atBottom || openedNow)) { scrollTo(0, document.documentElement.scrollHeight); openedNow = false; }
}
let openedNow = false;

// The address bar is the router: `#c=<key>` is an open conversation, `#usage` the Usage screen,
// `#scheduled` the Scheduled screen and `#new` the New chat screen, so the back button closes any of them.
const SCREENS = new Set(['#usage', '#scheduled', '#new']);
function route() {
  if (location.hash === '#usage') {
    deck.closeConversation();
    deck.closeNewChat();
    deck.closeScheduled();
    if (!deck.state.usage) deck.openUsage();
    return;
  }
  deck.closeUsage();
  if (location.hash === '#scheduled') {
    deck.closeConversation();
    deck.closeNewChat();
    if (!deck.state.scheduled) deck.openScheduled();
    return;
  }
  deck.closeScheduled();
  if (location.hash === '#new') {
    deck.closeConversation();
    // As for a conversation: the box's mirror would otherwise shadow a draft the deck just wrote (Edit on a parked start).
    if (!deck.state.newChat) ui.text.delete(NEW_CHAT_DRAFT);
    deck.openNewChat();
    return;
  }
  deck.closeNewChat();
  const m = /^#c=(.+)$/.exec(location.hash);
  if (!m) return deck.closeConversation();
  let key;
  try { key = decodeURIComponent(m[1]); } catch { return deck.closeConversation(); }
  if (deck.state.open?.key === key) return;
  openedNow = true;
  ui.text.delete(key);
  deck.openConversation(key);
}
addEventListener('hashchange', route);

// The deck rewrote a draft (an attached note, an edited queued prompt): the box shows the new text, not its mirror.
deck.onDraftWritten = (key) => ui.text.delete(key);
deck.subscribe(render);
render(deck.state);

// A link opened straight from the OS camera or the site's /pair page: `#p=…`. The fragment is
// removed at once so the one-time code is not left in the address bar or the history.
async function boot() {
  await deck.start();
  if (location.hash.startsWith('#c=') || SCREENS.has(location.hash)) route();
  if (location.hash.startsWith('#p=')) {
    const link = location.href;
    history.replaceState(null, '', location.pathname + location.search);
    if (deck.state.phase === 'pairing') await deck.prepare(link);
    else deck.notify('This browser is already paired. Unpair it first, then open the pairing link again.');
  }
}
boot();

// Coming back to the app is the moment a stream has most likely died; do not wait out the backoff.
// Not while polling: that fallback means another device holds the stream, and reconnecting restarts the tug of war.
const wake = () => { if (deck.state.phase === 'paired' && !deck.state.live && !deck.state.polling && document.visibilityState === 'visible') deck.connect(); };
document.addEventListener('visibilitychange', wake);
addEventListener('online', wake);

if ('serviceWorker' in navigator) {
  // A tapped notification: the worker focuses this window and names the conversation.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'open-conversation') return;
    location.hash = event.data.key ? `c=${encodeURIComponent(event.data.key)}` : '';
  });
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
}
