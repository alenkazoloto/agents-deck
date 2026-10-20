// The open conversation: transcript, the questions it can be answered, and the message box.
// Pure view over `Deck` state; every write goes back through the deck.

import { h } from './dom.js';
import { clock } from './format.js';
import { blocks } from './markdown.js';
import { chipLine } from './outbox.js';
import { movePickerView } from './folders.js';
import { changesView } from './review.js';
import { feedbackChipsView } from './feedback.js';

/** Local, per-render-surviving UI state: what is typed, and which options are picked. */
export const ui = {
  /** conversation key → the message box's current text (mirrors the persisted draft). */
  text: new Map(),
  /** `callId` → Map(questionKey → {labels:Set, typed:string}) */
  picks: new Map(),
  /** call ids whose "Other" box is open */
  other: new Set(),
  /** tool-call ids (and `calls:<turn>` groups) the reader unfolded; a rebuild must not fold them back. */
  unfolded: new Set(),
};

export const composerText = (open) => ui.text.get(open.key) ?? open.draft ?? '';

function textView(text) {
  return h('div', { class: 'text' }, blocks(text).map((b) => (b.type === 'code'
    ? h('pre', {}, h('code', {}, b.text))
    : h('p', {}, b.parts.map((p) => (p.code ? h('code', {}, p.text) : p.text))))));
}

function resultView(call) {
  const r = call.result;
  if (!r) return null;
  return h('div', { class: 'result' },
    r.input && h('pre', { class: 'dim' }, r.input),
    h('pre', {}, r.output || '(no output)'),
    r.omittedBytes > 0 && h('div', { class: 'dim' }, `${r.omittedBytes} bytes not shown.`));
}

function pickFor(callId, questionKey) {
  let byQuestion = ui.picks.get(callId);
  if (!byQuestion) ui.picks.set(callId, byQuestion = new Map());
  let pick = byQuestion.get(questionKey);
  if (!pick) byQuestion.set(questionKey, pick = { labels: new Set(), typed: '' });
  return pick;
}

/** A question the run is parked on. Nothing is sent until every question has an answer and Send answer is tapped. */
function questionsView(call, { canType, rerender, onAnswer }) {
  const answered = (q) => {
    const pick = ui.picks.get(call.id)?.get(q.key);
    return !!pick && (pick.labels.size > 0 || pick.typed.trim() !== '');
  };
  const ready = call.questions.every(answered);
  return h('div', { class: 'ask' },
    call.questions.map((q) => {
      const pick = pickFor(call.id, q.key);
      return h('fieldset', {},
        h('legend', {}, q.header || q.key),
        q.header && q.header !== q.key && h('p', {}, q.key),
        q.options.map((o) => h('label', { class: 'opt' },
          h('input', {
            type: q.multiSelect ? 'checkbox' : 'radio', name: `${call.id}:${q.key}`, checked: pick.labels.has(o.label),
            onchange: (e) => {
              if (!q.multiSelect) pick.labels.clear();
              if (e.target.checked) pick.labels.add(o.label); else pick.labels.delete(o.label);
              pick.typed = '';
              rerender();
            },
          }),
          h('span', {}, o.label, o.description && h('span', { class: 'dim' }, ` — ${o.description}`)))),
        canType && h('input', {
          type: 'text', placeholder: 'Other — type your own answer', 'aria-label': `Your own answer to ${q.header || q.key}`, value: pick.typed,
          // Re-rendered per keystroke so "Send answer" enables with the first letter; render() hands
          // focus and caret back to this box by its aria-label.
          oninput: (e) => { pick.typed = e.target.value; if (pick.typed.trim()) pick.labels.clear(); rerender(); },
        }));
    }),
    h('button', {
      class: 'primary', disabled: !ready,
      onclick: () => {
        const answers = {};
        const typed = [];
        for (const q of call.questions) {
          const pick = ui.picks.get(call.id).get(q.key);
          if (pick.typed.trim()) { answers[q.key] = pick.typed.trim(); typed.push(q.key); } else answers[q.key] = [...pick.labels].join(', ');
        }
        ui.picks.delete(call.id);
        onAnswer({ askId: call.id, answers, typed });
      },
    }, 'Send answer'));
}

function fold(id, open) { if (open) ui.unfolded.add(id); else ui.unfolded.delete(id); }

function callView(call, ctx) {
  const asking = call.status === 'running' && call.questions.length > 0;
  return h('li', { class: `call ${call.status}` },
    h('details', { open: asking || ui.unfolded.has(call.id), ontoggle: (e) => fold(call.id, e.target.open) },
      h('summary', {}, call.title || call.name, call.summary && h('span', { class: 'dim' }, ` ${call.summary}`)),
      resultView(call)),
    asking && questionsView(call, ctx));
}

function turnView(turn, ctx) {
  const who = turn.role === 'user' ? 'You' : turn.role === 'assistant' ? 'Agent' : 'System';
  return h('article', { class: `turn ${turn.role}` },
    h('div', { class: 'who dim' }, who, turn.timestampMs > 0 && ` · ${clock(turn.timestampMs)}`),
    turn.thought && h('details', {}, h('summary', { class: 'dim' }, 'Thinking'), h('pre', {}, turn.thought)),
    turn.text && textView(turn.text),
    turn.toolCalls.length > 0 && h('details', {
      class: 'calls',
      open: turn.toolCalls.some((c) => c.status === 'running' && c.questions.length) || ui.unfolded.has(`calls:${turn.toolCalls[0].id}`),
      ontoggle: (e) => fold(`calls:${turn.toolCalls[0].id}`, e.target.open),
    },
      h('summary', { class: 'dim' }, `Tool calls (${turn.toolCalls.length})`),
      h('ul', {}, turn.toolCalls.map((c) => callView(c, ctx)))),
    turn.streaming && h('div', { class: 'dim' }, '…'));
}

function outgoingView(item, deck) {
  return h('article', { class: `turn user outgoing${item.parked ? ' parked' : ''}` },
    h('div', { class: 'who dim' }, `You · ${item.parked ? 'not sent' : 'waiting for the machine'}`),
    textView(item.prompt),
    item.parked && item.lastError && h('p', { class: 'notice' }, item.lastError),
    item.parked && h('div', { class: 'row' },
      h('button', { onclick: () => deck.retryOutgoing(item.id) }, 'Retry'),
      h('button', { onclick: () => deck.editOutgoing(item.id) }, 'Edit'),
      h('button', { class: 'link', onclick: () => deck.discardOutgoing(item.id) }, 'Discard')));
}

/**
 * The desk's "New chat from before…" picker: the reader's own messages, newest first because a
 * recent turn is picked far more often than the first. Messages the machine left off are counted.
 */
function forkPickerView(points, deck, busy) {
  return h('section', { class: 'fork-picker', role: 'dialog', 'aria-label': 'New chat from before' },
    h('h2', {}, 'New chat from before…'),
    h('p', { class: 'dim' }, 'The new chat keeps everything before the message you pick, and the message waits in its message box. This chat does not change.'),
    h('ul', {}, [...points.points].reverse().map((p) => h('li', {},
      h('button', { class: 'row-open', disabled: busy, 'aria-label': `Fork from message ${p.ordinal}`, onclick: () => deck.forkAt(p.id) },
        h('span', { class: 'dim' }, `${p.ordinal}. `),
        p.label || '(empty message)',
        p.atMs && h('div', { class: 'dim' }, clock(p.atMs)))))),
    points.omitted > 0 && h('p', { class: 'dim' }, points.omitted === 1
      ? '1 older message is not listed here — fork from it in the IDE.'
      : `${points.omitted} older messages are not listed here — fork from them in the IDE.`),
    h('div', { class: 'row' }, h('button', { class: 'link', onclick: () => deck.dismissFork() }, 'Cancel')));
}

/**
 * Fork and Branch chat, withheld while the chat runs: the machine will not copy a conversation
 * mid-write. Filing into a folder touches only the desk's list, so it stays offered.
 */
function chatActions(state, deck, open) {
  const page = open.page;
  const vendor = state.fleet?.rows.find((r) => r.key === open.key)?.vendor ?? (open.key.split(':')[0] || 'CLAUDE');
  const settled = page && !page.running;
  const fork = settled && vendor !== 'CODEX' && deck.forkOffered;
  const branch = settled && deck.branchOffered(vendor);
  const move = deck.foldersOffered && !open.folderPicker;
  // Reading what changed never writes, so it stays offered while the chat runs.
  const changes = deck.changesOffered && !open.changes;
  if (!fork && !branch && !move && !changes) return null;
  return h('div', { class: 'row chat-actions' },
    changes && h('button', { class: 'link', onclick: () => deck.openChanges() }, 'Changes'),
    fork && h('button', { class: 'link', disabled: open.forking, onclick: () => deck.startFork() }, 'New chat from here…'),
    branch && h('button', { class: 'link', disabled: open.forking, onclick: () => deck.branchChat() }, 'Branch chat'),
    move && h('button', { class: 'link', onclick: () => deck.openFolderPicker() }, 'Move to folder…'));
}

/**
 * @param {object} state Deck state
 * @param {import('./deck.js').Deck} deck
 * @param {{back: ()=>void, rerender: ()=>void}} nav
 */
export function conversationView(state, deck, nav) {
  const open = state.open;
  const page = open.page;
  const machine = state.session?.machine || 'your machine';
  const canType = !!state.hello?.capabilities?.includes('answer-typed');
  const ctx = { canType, rerender: nav.rerender, onAnswer: (a) => deck.answer(a) };
  const owed = deck.outbox.forKey(open.key);
  const stamp = state.live ? null : (open.receivedAtMs ? `as of ${clock(open.receivedAtMs)}` : null);
  const chip = chipLine(owed, deck.outbox.deliveringId);

  const box = h('textarea', {
    rows: 3, placeholder: 'Message', 'aria-label': 'Message', enterkeyhint: 'send',
    oninput: (e) => { ui.text.set(open.key, e.target.value); deck.editDraft(open.key, e.target.value); },
  });
  box.value = composerText(open);
  const submit = async () => {
    const words = box.value;
    if (!words.trim()) return;
    ui.text.set(open.key, '');
    box.value = '';
    // The words are the outbox's once enqueued; until then they are still the draft.
    let taken = false;
    try { taken = await deck.send(words); } catch { /* storage refused: keep the words */ }
    if (!taken) { ui.text.set(open.key, words); box.value = words; }
  };

  return h('div', { class: 'conversation' },
    h('header', {},
      h('button', { class: 'link', onclick: nav.back, 'aria-label': 'Back to conversations' }, '‹ Back'),
      h('h1', {}, page?.title || 'Conversation'),
      state.live ? h('span', { class: 'pill live' }, 'Live') : h('span', { class: 'pill' }, stamp ?? 'not connected')),
    !state.reachable && h('div', { class: 'banner', role: 'status' }, `Can't reach ${machine} — is Tailscale on?`),
    open.notice && h('div', { class: 'banner', role: 'alert' }, open.notice),
    page?.pendingPermission && h('div', { class: 'banner', role: 'status' },
      `Waiting for tool permission (${page.pendingPermission.title || page.pendingPermission.tool}) — allow or deny it in the IDE.`),
    page?.pendingPlan && h('div', { class: 'banner', role: 'status' }, 'Waiting for plan approval — approve it in the IDE.'),
    !page && h('p', { class: 'dim empty' }, open.loading ? 'Loading…' : 'Nothing saved for this conversation yet — connect once to load it.'),
    page?.hasMore && h('button', { class: 'link', disabled: open.olderLoading, onclick: () => deck.loadOlder() }, open.olderLoading ? 'Loading…' : 'Load earlier messages'),
    page && h('div', { class: 'turns' }, page.turns.map((t) => turnView(t, ctx))),
    owed.map((item) => outgoingView(item, deck)),
    // A cached page's ticker is history, not news: only a live link may claim the run is still going.
    page?.running && state.live && h('div', { class: 'dim working' }, page.liveLine || 'Working…'),
    // Beside the message box, where the reader already is: the page follows the newest turn.
    open.forkPoints && forkPickerView(open.forkPoints, deck, open.forking),
    open.folderPicker && movePickerView(state, deck, nav.rerender),
    open.changes && changesView(open.changes, deck),
    h('div', { class: 'composer' },
      chip && h('div', { class: 'dim', role: 'status' }, chip),
      open.forkNotice && h('div', { class: 'dim', role: 'status' }, open.forkNotice),
      open.folderNotice && h('div', { class: 'dim', role: 'status' }, open.folderNotice),
      open.notesNotice && h('div', { class: 'dim', role: 'status' }, open.notesNotice),
      deck.feedbackOffered && feedbackChipsView(open, deck),
      box,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: submit }, 'Send'),
        page?.running && h('button', { onclick: () => deck.stop() }, 'Stop')),
      chatActions(state, deck, open)));
}
