// New chat: where a chat started from this browser runs, and the screen that picks it (the phone
// app's `NewChat`, ported). Each picker shows only under the hello capability that named its list —
// an older plugin forwards these strings onto the CLI's command line unread, so a list invented
// here would run whatever it guessed.

import { h } from './dom.js';
import { clock } from './format.js';
import { chipLine } from './outbox.js';

/** The draft key the new chat's words are kept under; never a conversation key. */
export const NEW_CHAT_DRAFT = 'new-chat';

const VENDOR_NAMES = { CLAUDE: 'Claude', CODEX: 'Codex' };
export const vendorName = (v) => VENDOR_NAMES[v] ?? v;

const has = (hello, capability) => !!hello?.capabilities?.includes(capability);

export const projectName = (path) => path.replace(/\/+$/, '').split('/').pop() || path;

/**
 * What the screen opens on: the previous pick while its project is still open, else the project the
 * reader last worked in, else the first open one. Null when the machine has nothing open — a state
 * the screen explains rather than a destination it can invent.
 */
export function defaultTarget(fleet, previous) {
  const open = fleet?.openProjects ?? [];
  if (!open.length) return null;
  const newest = (fleet.rows ?? []).filter((r) => open.includes(r.projectPath)).sort((a, b) => b.lastActivityMs - a.lastActivityMs)[0];
  const projectPath = open.includes(previous?.projectPath) ? previous.projectPath : newest?.projectPath ?? open[0];
  const vendor = previous?.vendor ?? newest?.vendor ?? 'CLAUDE';
  // A model slug or an account id belongs to one agent; they survive only where the agent did.
  return previous?.vendor === vendor ? { ...previous, projectPath } : { projectPath, vendor };
}

/** The agents the fleet holds, plus every one a machine advertising `effort` names a ladder for. */
export function vendorOptions(fleet, hello) {
  const found = new Set((fleet?.rows ?? []).map((r) => r.vendor));
  if (has(hello, 'effort')) Object.keys(hello.effort).forEach((v) => found.add(v));
  const ordered = ['CLAUDE', 'CODEX'].filter((v) => found.has(v));
  return ordered.length ? ordered : ['CLAUDE'];
}

export const modelOptions = (hello, vendor) => (has(hello, 'models') ? hello.models[vendor] ?? [] : []);
export const effortOptions = (hello, vendor) => (has(hello, 'effort') ? hello.effort[vendor] ?? [] : []);
export const modeOptions = (hello, vendor) => (has(hello, 'permission-modes') ? hello.permissionModes?.[vendor] ?? [] : []);
export const togglesOffered = (hello) => has(hello, 'run-toggles');

/** No picker unless the machine honours the pick (`accounts`) and there is more than one to choose. */
export function accountOptions(hello, vendor) {
  const listed = has(hello, 'accounts') ? hello.accounts[vendor] ?? [] : [];
  return listed.length >= 2 ? listed : [];
}

/** The picked account while still listed, else the machine's active one; absent without `accounts`. */
export function accountFor(hello, vendor, picked) {
  if (!has(hello, 'accounts')) return undefined;
  const listed = hello.accounts[vendor] ?? [];
  if (picked && listed.some((a) => a.id === picked)) return picked;
  return hello.activeAccounts?.[vendor] ?? listed[0]?.id;
}

/** What a request names: each pick only while the machine still lists it. */
export function picksFor(hello, target) {
  const listed = (options, slug) => (slug && options.some((o) => o.slug === slug) ? slug : undefined);
  const start = {
    model: listed(modelOptions(hello, target.vendor), target.model),
    effort: listed(effortOptions(hello, target.vendor), target.effort),
    accountId: accountFor(hello, target.vendor, target.accountId),
  };
  return Object.fromEntries(Object.entries(start).filter(([, v]) => v !== undefined));
}

/** An account row names why it cannot run right now, with the reset the desk would wait for. */
export function accountLabel(account) {
  // An open window has a reset too; only a drained one is a reason the account cannot run.
  if (!account.resetAtMs || !account.limitReached) return account.label;
  return `${account.label} · ${account.weeklyLimit ? 'weekly limit reached' : 'limit reached'}, resets ${clock(account.resetAtMs)}`;
}

// ---- view ---------------------------------------------------------------------------------------

function select(label, options, value, pick) {
  const el = h('select', { 'aria-label': label, onchange: (e) => pick(e.target.value || undefined) },
    options.map((o) => h('option', { value: o.value }, o.label)));
  el.value = value ?? '';
  return el;
}

/** A project's name, or its whole path where two open projects share a name. */
function projectLabels(paths) {
  const names = paths.map(projectName);
  return paths.map((p, i) => (names.indexOf(names[i]) !== names.lastIndexOf(names[i]) ? p : names[i]));
}

/**
 * @param {object} state Deck state with `newChat` set
 * @param {import('./deck.js').Deck} deck
 * @param {{back:()=>void, text:Map<string,string>, when?:Node|false}} nav [text] is the per-render message box mirror; [when] the
 *   Now/Later picker, present only while the machine honours a due time
 */
export function newChatView(state, deck, nav) {
  const { newChat, hello } = state;
  const machine = state.session?.machine || 'your machine';
  const target = newChat.target;
  const header = h('header', {},
    h('button', { class: 'link', onclick: nav.back, 'aria-label': 'Back to conversations' }, '‹ Back'),
    h('h1', {}, 'New chat'),
    state.live ? h('span', { class: 'pill live' }, 'Live') : h('span', { class: 'pill' }, 'not connected'));
  if (!target) {
    return h('div', { class: 'new-chat' }, header,
      h('p', { class: 'dim empty' }, state.fleet ? `Open a project in the IDE on ${machine} to start a chat there.` : 'Connect once to see which projects are open.'));
  }
  const open = state.fleet?.openProjects ?? [];
  const labels = projectLabels(open);
  const vendors = vendorOptions(state.fleet, hello);
  const models = modelOptions(hello, target.vendor);
  const efforts = effortOptions(hello, target.vendor);
  const accounts = accountOptions(hello, target.vendor);
  const set = (patch) => deck.setNewChatTarget(patch);

  const box = h('textarea', {
    rows: 4, placeholder: 'What should the agent do?', 'aria-label': 'New chat message', enterkeyhint: 'send',
    oninput: (e) => { nav.text.set(NEW_CHAT_DRAFT, e.target.value); deck.setDraft(NEW_CHAT_DRAFT, e.target.value); },
  });
  box.value = nav.text.get(NEW_CHAT_DRAFT) ?? newChat.draft ?? '';
  const submit = async () => {
    const words = box.value;
    if (!words.trim()) return;
    nav.text.delete(NEW_CHAT_DRAFT);
    box.value = '';
    let taken = false;
    try { taken = await deck.startNewChat(words); } catch { /* storage refused: keep the words */ }
    if (!taken) { nav.text.set(NEW_CHAT_DRAFT, words); box.value = words; }
  };

  return h('div', { class: 'new-chat' }, header,
    !state.reachable && h('div', { class: 'banner', role: 'status' }, `Can't reach ${machine} — is Tailscale on? The chat starts once it is back.`),
    h('div', { class: 'pickers' },
      h('label', {}, h('span', { class: 'dim' }, 'Project'),
        open.length > 1 ? select('Project', open.map((p, i) => ({ value: p, label: labels[i] })), target.projectPath, (projectPath) => set({ projectPath }))
          : h('span', { title: target.projectPath }, labels[0])),
      vendors.length > 1 && h('label', {}, h('span', { class: 'dim' }, 'Agent'),
        select('Agent', vendors.map((v) => ({ value: v, label: vendorName(v) })), target.vendor, (vendor) => set({ vendor }))),
      accounts.length > 0 && h('label', {}, h('span', { class: 'dim' }, 'Account'),
        select('Account', accounts.map((a) => ({ value: a.id, label: accountLabel(a) })), accountFor(hello, target.vendor, target.accountId), (accountId) => set({ accountId }))),
      models.length > 0 && h('label', {}, h('span', { class: 'dim' }, 'Model'),
        select('Model', [{ value: '', label: 'Default' }, ...models.map((m) => ({ value: m.slug, label: m.label }))], picksFor(hello, target).model, (model) => set({ model }))),
      efforts.length > 0 && h('label', {}, h('span', { class: 'dim' }, 'Effort'),
        select('Effort', [{ value: '', label: 'Default' }, ...efforts.map((m) => ({ value: m.slug, label: m.label }))], picksFor(hello, target).effort, (effort) => set({ effort }))),
      nav.when),
    h('div', { class: 'composer' }, box,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: submit }, nav.when && newChat.dueAtMs != null ? 'Schedule' : 'Start chat'))));
}

/**
 * New chats this browser still owes the machine, on the list: queued ones say so, a refused or
 * unconfirmed one keeps its words behind Retry, Edit and Discard until the reader decides.
 */
export function startingView(items, deck, deliveringId) {
  if (!items.length) return null;
  return h('section', { class: 'starting' },
    h('h2', {}, 'Starting ', h('span', { class: 'count' }, String(items.length))),
    h('ul', {}, items.map((item) => h('li', { class: `row-item starting-item${item.parked ? ' parked' : ''}` },
      h('div', { class: 'title' }, item.prompt),
      h('div', { class: 'dim' }, [item.label, vendorName(item.vendor), item.dueAtMs && `for ${clock(item.dueAtMs)}`].filter(Boolean).join(' · ')),
      h('div', { class: item.parked ? 'notice' : 'dim', role: 'status' }, chipLine([item], deliveringId)),
      item.parked && h('div', { class: 'row' },
        h('button', { onclick: () => deck.retryOutgoing(item.id) }, 'Retry'),
        h('button', { onclick: () => deck.editNewChat(item.id) }, 'Edit'),
        h('button', { class: 'link', onclick: () => deck.discardOutgoing(item.id) }, 'Discard'))))));
}
