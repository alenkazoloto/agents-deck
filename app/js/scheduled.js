// Scheduled prompts: the machine's queue (the phone app's `ScheduledScreen`, ported to the list the
// desk's Settings › Scheduled shows) and the "Later" choice New chat gains under `schedule-create`.
// Decoders follow `wire.js`: lenient, pinned to `core/mobile` by test/fixtures/scheduled.json.

import { h } from './dom.js';
import { ago, clock } from './format.js';
import { PROTOCOL_VERSION } from './wire.js';
import { effortOptions, modeOptions, modelOptions, projectName, togglesOffered, vendorName } from './newchat.js';

const str = (o, k) => (typeof o?.[k] === 'string' ? o[k] : undefined);
const num = (o, k) => (typeof o?.[k] === 'number' && Number.isFinite(o[k]) ? o[k] : undefined);
const bool = (o, k) => o?.[k] === true;
const nonBlank = (s) => (s && s.trim() ? s : undefined);
const objects = (o, k) => (Array.isArray(o?.[k]) ? o[k].filter((e) => e && typeof e === 'object') : []);

const STATES = new Set(['queued', 'paused', 'running']);

/** `MobileScheduledRow`; [lastRunAtMs] 0 is "never ran", which is also what an older plugin says. */
export const decodeScheduledRow = (o) => ({
  id: str(o, 'id') ?? '',
  prompt: str(o, 'prompt') ?? '',
  projectPath: nonBlank(str(o, 'projectPath')),
  sessionId: nonBlank(str(o, 'sessionId')),
  dueAtMs: num(o, 'dueAtMs') ?? 0,
  state: STATES.has(str(o, 'state')) ? o.state : 'queued',
  repeating: bool(o, 'repeating'),
  lastRunAtMs: num(o, 'lastRunAtMs') > 0 ? o.lastRunAtMs : 0,
  lastRunFailed: bool(o, 'lastRunFailed'),
  waiting: nonBlank(str(o, 'waiting')),
  cadence: nonBlank(str(o, 'cadence')),
  agent: nonBlank(str(o, 'agent')),
});

/** `GET /v1/scheduled` (`MobileScheduledList`); a row without an id is one no command could name, so it is dropped. */
export function decodeScheduled(o) {
  return {
    rows: objects(o, 'rows').map(decodeScheduledRow).filter((r) => r.id),
    outcomes: objects(o, 'outcomes').map((e) => ({
      taskId: str(e, 'taskId') ?? '',
      prompt: str(e, 'prompt') ?? '',
      projectPath: nonBlank(str(e, 'projectPath')),
      key: nonBlank(str(e, 'key')),
      vendor: str(e, 'vendor'),
      finishedAtMs: num(e, 'finishedAtMs') ?? 0,
      failed: bool(e, 'failed'),
      detail: nonBlank(str(e, 'detail')),
    })),
    outside: objects(o, 'outside').map((e) => ({
      id: str(e, 'id') ?? '',
      source: str(e, 'source') ?? '',
      schedule: str(e, 'schedule') ?? '',
      scope: str(e, 'scope') ?? '',
      prompt: str(e, 'prompt') ?? '',
      note: nonBlank(str(e, 'note')),
    })),
  };
}

export const SCHEDULED_ACTIONS = ['pause', 'resume', 'run-now', 'cancel'];

/** `MobileScheduledCommand.toJson`: ids are always explicit, so a command never reaches a row the reader did not see. */
export const scheduledCommandBody = ({ action, ids }) => ({ v: PROTOCOL_VERSION, action, ids });

// ---- edit ---------------------------------------------------------------------------------------

/** `MobileScheduleEditDetail`: the row as the machine would edit it now, and whether it still can. */
export const decodeScheduleEditDetail = (o) => ({
  id: str(o, 'id') ?? '',
  prompt: str(o, 'prompt') ?? '',
  projectPath: nonBlank(str(o, 'projectPath')),
  sessionId: nonBlank(str(o, 'sessionId')),
  dueAtMs: num(o, 'dueAtMs') ?? 0,
  repeatEveryMs: num(o, 'repeatEveryMs') > 0 ? o.repeatEveryMs : 0,
  repeatAtTime: nonBlank(str(o, 'repeatAtTime')),
  model: nonBlank(str(o, 'model')),
  vendor: str(o, 'vendor') ?? '',
  accountId: str(o, 'accountId') ?? '',
  afterSessionId: nonBlank(str(o, 'afterSessionId')),
  timeZoneId: nonBlank(str(o, 'timeZoneId')) ?? 'UTC',
  editable: bool(o, 'editable'),
  canRepeat: bool(o, 'canRepeat'),
  waitsForSessions: objects(o, 'selectedDependencies').length > 0,
  editUnavailableReason: nonBlank(str(o, 'editUnavailableReason')),
  accountOptions: objects(o, 'accountOptions').map((a) => ({
    id: str(a, 'id') ?? '', label: str(a, 'label') ?? '', resetAtMs: num(a, 'resetAtMs') > 0 ? a.resetAtMs : null, weeklyLimit: bool(a, 'weeklyLimit'),
  })),
  dependencySources: objects(o, 'dependencySources').map((d) => ({ id: str(d, 'id') ?? '', label: str(d, 'label') ?? '', status: str(d, 'status') ?? '' }))
    .filter((d) => d.id),
  selectedDependencies: objects(o, 'selectedDependencies').filter((d) => nonBlank(str(d, 'id')))
    .map((d) => ({ id: d.id, inheritContext: bool(d, 'inheritContext') })),
  effort: nonBlank(str(o, 'effort')),
  permissionMode: nonBlank(str(o, 'permissionMode')),
  // False from a plugin that ignores them in an edit: the picks would go nowhere.
  runOptionsEditable: bool(o, 'runOptionsEditable'),
  // Fast: true, else null (off). Thinking: true, false or null (inherits). Same meaning of the flag.
  fastMode: typeof o?.fastMode === 'boolean' ? o.fastMode : null,
  thinking: typeof o?.thinking === 'boolean' ? o.thinking : null,
  runTogglesEditable: bool(o, 'runTogglesEditable'),
});

const HOUR_MS = 3_600_000;

/** A Fast or Thinking cell as the picker holds it: a string, so a draft keeps it by the same `typeof` check as the rest. */
const toggleOf = (value) => (value === true ? 'on' : value === false ? 'off' : 'default');
const toggleValue = (choice) => (choice === 'on' ? true : choice === 'off' ? false : null);

/** `ClaudeModels.isOpus`: Claude's Fast is Opus-only, and the machine refuses it on any other model, the default included. */
const isOpus = (slug) => { const s = (slug ?? '').trim().toLowerCase().split('/').pop(); return s === 'opus' || s.startsWith('claude-opus-'); };

/** Whether Fast can be offered for the model the form now names; a Codex tier depends on the account, so the machine decides. */
export const fastOffered = (form, detail) => detail.vendor === 'CODEX' || (detail.vendor === 'CLAUDE' && isOpus(form.model ?? detail.model));

/** "HH:mm" of [ms] on the machine's clock, which is the one an "At" time is read against. */
export function machineTime(ms, zone) {
  const format = (timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  try { return format(zone); } catch { return format(undefined); }
}

/** The form an Edit opens on: what the reader left unsaved for this row, else the row as the machine has it (the phone's `scheduleEditInitial`). */
export function editInitial(detail, saved) {
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    const initial = editInitial(detail, null);
    // Only the keys a draft holds (`editDraft`): everything else is the row as the machine has it now.
    const kept = Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in initial && typeof v === typeof initial[k]));
    if (!Object.keys(kept).length) return initial;
    const form = { ...initial, ...kept };
    // A choice the machine no longer offers would leave a picker blank and Save dead with no reason.
    if (!detail.accountOptions.some((a) => a.id === form.accountId)) form.accountId = detail.accountId;
    if (!Array.isArray(form.dependencies)) form.dependencies = [];
    form.dependencies = form.dependencies.filter((d) => detail.dependencySources.some((s) => s.id === d?.id));
    if (form.whenChoice === 'dependencies' && !form.dependencies.length) form.whenChoice = 'keep';
    return settle(form, detail);
  }
  const every = detail.repeatEveryMs;
  const wholeHours = every > 0 && every % HOUR_MS === 0 && every / HOUR_MS <= 999;
  return {
    prompt: detail.prompt,
    whenChoice: 'keep',
    delayAmount: every <= 0 ? 1 : wholeHours ? every / HOUR_MS : Math.min(999, Math.max(1, Math.floor(every / 60_000))),
    delayUnit: every > 0 && !wholeHours ? 'minutes' : 'hours',
    timeOfDay: detail.repeatAtTime ?? machineTime(detail.dueAtMs, detail.timeZoneId),
    repeat: every > 0 || !!detail.repeatAtTime,
    newChat: !detail.sessionId,
    accountId: detail.accountId,
    model: detail.model ?? '',
    effort: detail.effort ?? '',
    permissionMode: detail.permissionMode ?? '',
    fast: toggleOf(detail.fastMode),
    thinking: toggleOf(detail.thinking),
    dependencies: detail.selectedDependencies ?? [],
  };
}

/**
 * What of [form] differs from the row, as the draft to keep, or '' for none. Only those keys: a whole form
 * would carry the model, effort or account read when Edit opened back over a change made on the desk since.
 * An account a chat cannot use and sessions no choice sends are not differences.
 */
export function editDraft(form, detail) {
  const initial = editInitial(detail, null);
  const said = { ...form };
  if (!said.newChat) said.accountId = initial.accountId;
  if (said.whenChoice !== 'dependencies') said.dependencies = initial.dependencies;
  const changed = Object.keys(initial).filter((k) => JSON.stringify(said[k]) !== JSON.stringify(initial[k]));
  return changed.length ? JSON.stringify(Object.fromEntries(changed.map((k) => [k, said[k]]))) : '';
}

/** Whether [form] asks nothing the row does not already say. */
export const editUnchanged = (form, detail) => editDraft(form, detail) === '';

/** A reset the account now picked does not report falls back to Unchanged, rather than a blank Run and a dead Save. */
export const settle = (form, detail) =>
  (form.whenChoice === 'reset' && resetFor(detail, editAccount(form, detail)) == null ? { ...form, whenChoice: 'keep' } : form);

/** The account the edited row would run on: only a new chat can change it — a chat keeps the account it was written with. */
export const editAccount = (form, detail) => (form.newChat && form.accountId ? form.accountId : detail.accountId);

/** A row that waits for a run or for sessions keeps no clock to repeat on; the machine refuses Repeat there. */
export const keepsWaiting = (form, detail) => form.whenChoice === 'keep' && (!!detail.afterSessionId || detail.waitsForSessions);

/** The reset [accountId] (the row's own by default) is waiting on, or null when it reports none. */
export const resetFor = (detail, accountId = detail.accountId) => detail.accountOptions.find((a) => a.id === accountId)?.resetAtMs ?? null;

export function editValid(form, detail) {
  if (!form.prompt.trim()) return false;
  if (form.whenChoice === 'in') return Number.isInteger(form.delayAmount) && form.delayAmount >= 1 && form.delayAmount <= 999;
  if (form.whenChoice === 'at') return /^([01]?\d|2[0-3]):[0-5]\d$/.test(form.timeOfDay.trim());
  if (form.whenChoice === 'reset') return resetFor(detail, editAccount(form, detail)) != null;
  if (form.whenChoice === 'dependencies') return form.dependencies.length >= 1 && form.dependencies.length <= 32;
  return true;
}

/** Repeat needs a clock: a row waiting for a run or for sessions has none, and the machine refuses it there. */
const repeatable = (form, detail) => form.whenChoice !== 'dependencies' && !keepsWaiting(form, detail);

/**
 * `MobileScheduleEditRequest.toJson`. [form.repeat] always goes as held: false stops a repeating row. A blank
 * model goes as none, which the machine reads as the default. An account is named only for a new chat and only
 * when it changed; effort and mode only when one of them changed, and then both — the machine reads a missing one
 * as the default; Fast and Thinking likewise go together, only when one changed. "keep" leaves the sessions a
 * row waits for to the machine.
 */
export function scheduleEditBody(form, detail) {
  const newChat = !detail.sessionId || !!form.newChat;
  const body = {
    v: PROTOCOL_VERSION, prompt: form.prompt.trim(), whenChoice: form.whenChoice,
    delayAmount: form.delayAmount, delayUnit: form.delayUnit, timeOfDay: form.timeOfDay.trim(),
    repeat: form.repeat && repeatable(form, detail), newChat,
  };
  const model = (form.model ?? detail.model ?? '').trim();
  if (model) body.model = model;
  const accountId = editAccount({ ...form, newChat }, detail);
  if (accountId !== detail.accountId) body.accountId = accountId;
  const effort = form.effort ?? detail.effort ?? '';
  const mode = form.permissionMode ?? detail.permissionMode ?? '';
  if (detail.runOptionsEditable && (effort !== (detail.effort ?? '') || mode !== (detail.permissionMode ?? ''))) {
    body.effort = effort || null;
    body.permissionMode = mode || null;
  }
  // A Claude row moved off Opus drops Fast, which the machine would otherwise keep on a model that has none.
  const fast = fastOffered(form, detail) ? form.fast ?? toggleOf(detail.fastMode) : 'default';
  const thinking = form.thinking ?? toggleOf(detail.thinking);
  if (detail.runTogglesEditable && (fast !== toggleOf(detail.fastMode) || thinking !== toggleOf(detail.thinking))) {
    body.fastMode = toggleValue(fast);
    body.thinking = toggleValue(thinking);
  }
  body.dependencies = form.whenChoice === 'dependencies' ? form.dependencies.map((d) => ({ id: d.id, inheritContext: !!d.inheritContext })) : [];
  return body;
}

/** What the Repeat box repeats on, in the phone's words. */
export function repeatLabel(form, detail) {
  if (form.whenChoice === 'in') return `Repeat every ${form.delayAmount} ${form.delayUnit}`;
  if (form.whenChoice === 'reset') return detail.accountOptions.find((a) => a.id === editAccount(form, detail))?.weeklyLimit ? 'Repeat each week' : 'Repeat each usage window (~5 h)';
  if (form.whenChoice === 'keep' && !detail.repeatAtTime && detail.repeatEveryMs > 0) return `Repeat every ${Math.round(detail.repeatEveryMs / 60_000)} minutes`;
  return 'Repeat daily';
}

// ---- when -----------------------------------------------------------------------------------------

/** The next whole hour at least half an hour away: the choice "Later" opens on. */
export function laterDefault(nowMs) {
  const d = new Date(nowMs + 30 * 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

const pad = (n) => String(n).padStart(2, '0');

/** A `datetime-local` value in this browser's zone; the machine is handed the instant, so its zone does not matter. */
export function localInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The instant a `datetime-local` value names, or null for an empty or malformed one. */
export function fromLocalInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value ?? '')) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** "at 14:00" today, "Tue 14:00" within the week, else the date: when a prompt runs, as the reader reads a clock. */
export function whenText(ms, nowMs, locale) {
  const d = new Date(ms);
  const today = new Date(nowMs);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = clock(ms, locale);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`;
}

/** A row's present tense: running and paused first, then what it waits for, else when it is due. */
export function dueLine(row, nowMs, locale) {
  if (row.state === 'running') return 'Running now';
  if (row.state === 'paused') return 'Paused';
  if (row.waiting) return row.waiting;
  return row.dueAtMs <= nowMs ? 'Due now' : `Runs ${whenText(row.dueAtMs, nowMs, locale)}`;
}

// ---- view ---------------------------------------------------------------------------------------

function rowView(row, deck, busy, nowMs) {
  const detail = [row.projectPath && projectName(row.projectPath), row.agent, row.cadence].filter(Boolean).join(' · ');
  const act = (action) => () => deck.commandScheduled(action, row.id);
  return h('li', { class: `row-item scheduled-item ${row.state}` },
    h('div', { class: 'title' }, row.prompt || '(no prompt)'),
    detail && h('div', { class: 'dim' }, detail),
    h('div', { class: 'state' }, dueLine(row, nowMs)),
    row.lastRunAtMs > 0 && h('div', { class: row.lastRunFailed ? 'notice' : 'dim' },
      `${row.lastRunFailed ? 'Last run failed' : 'Last ran'} ${ago(row.lastRunAtMs, nowMs)}`),
    h('div', { class: 'row' },
      row.state !== 'running' && deck.scheduleEditOffered && h('button', { disabled: busy, onclick: () => deck.openScheduleEdit(row.id) }, 'Edit'),
      row.state === 'paused' ? h('button', { disabled: busy, onclick: act('resume') }, 'Resume')
        : row.state !== 'running' && h('button', { disabled: busy, onclick: act('pause') }, 'Pause'),
      row.state !== 'running' && h('button', { disabled: busy, onclick: act('run-now') }, 'Run now'),
      // A cancelled prompt's words exist nowhere else; the desk has no Undo for it either.
      h('button', { class: 'link', disabled: busy, onclick: () => { if (confirm('Cancel this prompt? It is removed from the machine\'s queue.')) act('cancel')(); } }, 'Cancel')));
}

function outcomeView(o, nowMs) {
  const where = [o.projectPath && projectName(o.projectPath), ago(o.finishedAtMs, nowMs)].filter(Boolean).join(' · ');
  const said = o.failed ? `Failed — ${o.detail ?? 'no detail reported'}` : o.key ? 'Ran' : 'Ran — no chat recorded';
  const body = [h('div', { class: 'title' }, o.prompt), h('div', { class: o.failed ? 'notice' : 'dim' }, said), where && h('div', { class: 'dim' }, where)];
  return h('li', { class: `row-item${o.key ? '' : ' scheduled-item'}` }, o.key
    ? h('button', { class: 'row-open', 'aria-label': `Open the chat this run wrote: ${o.prompt}`, onclick: () => { location.hash = `c=${encodeURIComponent(o.key)}`; } }, body)
    : body);
}

/** @param {object} state Deck state with `scheduled` set @param {import('./deck.js').Deck} deck @param {{back:()=>void}} nav */
export function scheduledView(state, deck, nav) {
  const { scheduled } = state;
  if (scheduled.edit) return editView(state, deck);
  const list = scheduled.list;
  const machine = state.session?.machine || 'your machine';
  const nowMs = Date.now();
  return h('div', { class: 'scheduled' },
    h('header', {},
      h('button', { class: 'link', onclick: nav.back, 'aria-label': 'Back to conversations' }, '‹ Back'),
      h('h1', {}, 'Scheduled'),
      h('span', { class: 'pill' }, scheduled.loading ? 'Loading…' : scheduled.receivedAtMs ? `as of ${clock(scheduled.receivedAtMs)}` : 'not connected')),
    !state.reachable && h('div', { class: 'banner', role: 'status' }, `Can't reach ${machine} — is Tailscale on?`),
    scheduled.notice && h('div', { class: 'banner', role: 'status' }, scheduled.notice),
    deck.scheduleCreateOffered && h('div', { class: 'row new-chat-row' }, h('button', { class: 'primary', onclick: () => deck.scheduleNewChat() }, 'Schedule a prompt')),
    !list && h('p', { class: 'dim empty' }, scheduled.loading ? 'Loading…' : 'Nothing saved yet — connect once to see the queue.'),
    list && !list.rows.length && h('p', { class: 'dim empty' }, 'Nothing is scheduled on this machine.'),
    list?.rows.length > 0 && h('section', {}, h('h2', {}, 'Queue ', h('span', { class: 'count' }, String(list.rows.length))),
      h('ul', {}, list.rows.map((r) => rowView(r, deck, scheduled.busy, nowMs)))),
    list?.outcomes.length > 0 && h('section', {}, h('h2', {}, 'Recent runs'), h('ul', {}, list.outcomes.map((o) => outcomeView(o, nowMs)))),
    list?.outside.length > 0 && h('section', {}, h('h2', {}, 'Created outside the IDE'),
      h('p', { class: 'dim' }, 'Change them where they were created.'),
      h('ul', {}, list.outside.map((o) => h('li', { class: 'row-item scheduled-item' },
        h('div', { class: 'title' }, o.prompt),
        h('div', { class: 'state' }, o.schedule),
        h('div', { class: 'dim' }, [o.source, o.scope, o.note].filter(Boolean).join(' · ')))))));
}

function keepLabel(detail) {
  if (detail.afterSessionId) return 'Keep waiting for the current run';
  if (detail.waitsForSessions) return 'Keep waiting for its sessions';
  return `Unchanged · ${whenText(detail.dueAtMs, Date.now())}`;
}

/** Edit one queued prompt: its words, when it runs and Repeat (the phone's `ScheduleEditDialog`, first half). */
function editView(state, deck) {
  const { edit } = state.scheduled;
  const { detail, form } = edit;
  const set = (patch) => {
    deck.setScheduleEditForm({ ...patch, whenChoice: settle({ ...form, ...patch }, detail).whenChoice });
  };
  let save = null;
  // Typed without a rebuild; Save follows by hand until `change` renders the form again.
  const quiet = (patch) => {
    deck.setScheduleEditForm(patch, { quiet: true });
    const now = deck.state.scheduled?.edit;
    if (save && now?.form) save.disabled = !editValid(now.form, now.detail);
  };
  const header = h('header', {},
    h('button', { class: 'link', disabled: edit.saving, onclick: () => deck.closeScheduleEdit(), 'aria-label': 'Back to scheduled prompts' }, '‹ Back'),
    h('h1', {}, 'Edit scheduled prompt'));
  const failed = edit.error && h('div', { class: 'notice', role: 'alert' }, edit.error);
  if (!detail || !form) {
    return h('div', { class: 'scheduled schedule-edit' }, header,
      edit.loading && h('p', { class: 'dim empty' }, 'Loading schedule…'),
      failed, !edit.loading && h('div', { class: 'row' }, h('button', { onclick: () => deck.openScheduleEdit(edit.id) }, 'Retry')));
  }
  const where = [detail.projectPath && projectName(detail.projectPath), !detail.sessionId && 'a new chat'].filter(Boolean).join(' · ');
  if (!detail.editable) {
    return h('div', { class: 'scheduled schedule-edit' }, header,
      h('p', { class: 'notice' }, detail.editUnavailableReason ?? 'This prompt is already running and cannot be edited.'),
      h('p', {}, detail.prompt));
  }
  const reset = resetFor(detail, editAccount(form, detail));
  const box = h('textarea', { rows: 4, class: 'schedule-edit-text', 'aria-label': 'Scheduled prompt', oninput: (e) => set({ prompt: e.target.value }) });
  box.value = form.prompt;
  const run = h('select', { 'aria-label': 'Run', onchange: (e) => set({ whenChoice: e.target.value }) },
    h('option', { value: 'keep' }, keepLabel(detail)),
    h('option', { value: 'in' }, 'In…'),
    h('option', { value: 'at' }, 'At a time of day'),
    reset != null && h('option', { value: 'reset' }, 'After the usage limit resets'),
    detail.dependencySources.length > 0 && h('option', { value: 'dependencies' }, 'After sessions finish'));
  run.value = form.whenChoice;
  let choice = null;
  if (form.whenChoice === 'in') {
    const amount = h('input', { type: 'number', min: 1, max: 999, inputmode: 'numeric', 'aria-label': 'Amount',
      oninput: (e) => quiet({ delayAmount: Number.parseInt(e.target.value, 10) || 0 }), onchange: () => set({}) });
    amount.value = form.delayAmount > 0 ? String(form.delayAmount) : '';
    const unit = h('select', { 'aria-label': 'Unit', onchange: (e) => set({ delayUnit: e.target.value }) },
      h('option', { value: 'hours' }, 'hours'), h('option', { value: 'minutes' }, 'minutes'));
    unit.value = form.delayUnit;
    choice = h('div', { class: 'row' }, amount, unit);
  } else if (form.whenChoice === 'at') {
    const at = h('input', { type: 'time', 'aria-label': 'Time', oninput: (e) => quiet({ timeOfDay: e.target.value }), onchange: () => set({}) });
    at.value = form.timeOfDay;
    choice = [h('label', {}, h('span', { class: 'dim' }, 'At'), at), h('div', { class: 'dim' }, `${detail.timeZoneId} · a time already past today runs tomorrow`)];
  } else if (form.whenChoice === 'reset' && reset != null) {
    choice = h('div', { class: 'dim' }, `Runs ${whenText(reset + 120_000, Date.now())}`);
  } else if (form.whenChoice === 'dependencies') {
    choice = sourcesView(detail.dependencySources, form.dependencies, (dependencies) => set({ dependencies }));
  }
  // As the phone: `canRepeat` is the machine's own answer, and a row that already repeats keeps its box so it can stop.
  const repeatShown = (detail.canRepeat || form.repeat) && repeatable(form, detail);
  const repeat = repeatShown && h('input', { type: 'checkbox', 'aria-label': 'Repeat', onchange: (e) => set({ repeat: e.target.checked }) });
  if (repeat) repeat.checked = form.repeat;
  const valid = editValid(form, detail);
  return h('div', { class: 'scheduled schedule-edit' }, header,
    where && h('div', { class: 'dim' }, where),
    box,
    h('div', { class: 'pickers' },
      h('label', {}, h('span', { class: 'dim' }, 'Run'), run),
      choice,
      repeat && h('label', { class: 'check' }, repeat, h('span', {}, repeatLabel(form, detail))),
      runsWithView(state.hello, detail, form, set, quiet)),
    failed,
    edit.error && h('p', { class: 'dim' }, 'Your edits are kept. Try saving again.'),
    h('div', { class: 'row' },
      save = h('button', { class: 'primary', disabled: edit.saving || !valid, onclick: () => deck.saveScheduleEdit() }, edit.saving ? 'Saving…' : 'Save'),
      h('button', { class: 'link', disabled: edit.saving, onclick: () => deck.closeScheduleEdit() }, 'Cancel')));
}

function pick(label, options, value, onPick) {
  const el = h('select', { 'aria-label': label, onchange: (e) => onPick(e.target.value) },
    options.map((o) => h('option', { value: o.value }, o.label)));
  el.value = value;
  return el;
}

const TOGGLE_ROWS = [{ value: 'default', label: 'Default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];

/** A catalogue with Default first, and the row's own value kept as a choice where the catalogue lacks it. */
function catalogue(listed, current) {
  const rows = [{ value: '', label: 'Default' }, ...listed.map((o) => ({ value: o.slug, label: o.label }))];
  return current && !listed.some((o) => o.slug === current) ? [...rows, { value: current, label: current }] : rows;
}

/**
 * Where it runs, on which account, model and run options (the phone's `ScheduleEditDialog`, second half).
 * Each list is the machine's own — the hello catalogue, the row's account options — and a picker shows only
 * with something to choose; a model with no catalogue is typed.
 */
function runsWithView(hello, detail, form, set, quiet) {
  const vendor = detail.vendor;
  const labelled = (label, control) => h('label', {}, h('span', { class: 'dim' }, label), control);
  const where = detail.sessionId && labelled('Where', pick('Where',
    [{ value: 'chat', label: 'This chat' }, { value: 'new', label: `New ${vendorName(vendor)} chat` }],
    form.newChat ? 'new' : 'chat', (v) => set({ newChat: v === 'new' })));
  const account = form.newChat && detail.accountOptions.length >= 2 && labelled('Account', pick('Account',
    detail.accountOptions.map((a) => ({ value: a.id, label: a.label })), editAccount(form, detail), (accountId) => set({ accountId })));
  const models = modelOptions(hello, vendor);
  let model;
  if (models.length) {
    model = pick('Model', catalogue(models, form.model), form.model, (v) => set({ model: v }));
  } else {
    model = h('input', { type: 'text', placeholder: 'Default model', 'aria-label': 'Model', autocomplete: 'off',
      oninput: (e) => quiet({ model: e.target.value }), onchange: () => set({}) });
    model.value = form.model;
  }
  // Only from a plugin that applies them in an edit, and only with a ladder to pick from.
  const efforts = detail.runOptionsEditable ? effortOptions(hello, vendor) : [];
  const modes = detail.runOptionsEditable ? modeOptions(hello, vendor) : [];
  // As the phone's `RunToggleSelector`: Fast is Claude's Opus flag and Codex's priority tier, Thinking is Claude's alone.
  const toggles = detail.runTogglesEditable && togglesOffered(hello);
  const toggle = (label, key) => labelled(label, pick(label, TOGGLE_ROWS, form[key], (v) => set({ [key]: v })));
  return [where, account, labelled('Model', model),
    efforts.length > 0 && labelled('Effort', pick('Effort', catalogue(efforts, form.effort), form.effort, (effort) => set({ effort }))),
    modes.length > 0 && labelled('Mode', pick('Mode', catalogue(modes, form.permissionMode), form.permissionMode, (permissionMode) => set({ permissionMode }))),
    toggles && fastOffered(form, detail) && toggle('Fast', 'fast'),
    toggles && vendor === 'CLAUDE' && toggle('Thinking', 'thinking')];
}

/** "After sessions finish": each source a checkbox, and a picked one its own "Include context". */
function sourcesView(sources, selected, change) {
  return h('ul', { class: 'schedule-sources' }, sources.map((source) => {
    const chosen = selected.find((d) => d.id === source.id);
    const box = h('input', { type: 'checkbox', 'aria-label': source.label, onchange: (e) => change(e.target.checked
      ? [...selected.filter((d) => d.id !== source.id), { id: source.id, inheritContext: false }]
      : selected.filter((d) => d.id !== source.id)) });
    box.checked = !!chosen;
    const context = chosen && h('input', { type: 'checkbox', 'aria-label': `Include context from ${source.label}`,
      onchange: (e) => change(selected.map((d) => (d.id === source.id ? { ...d, inheritContext: e.target.checked } : d))) });
    if (context) context.checked = chosen.inheritContext;
    return h('li', {},
      h('label', { class: 'check' }, box, h('span', {}, source.label, source.status && h('span', { class: 'dim' }, ` · ${source.status}`))),
      context && h('label', { class: 'check nested' }, context, h('span', {}, 'Include context')));
  }));
}

/** New chat's "When": Now, or Later at a time this browser picks. Only under `schedule-create` — an older plugin would run it now. */
export function whenView(dueAtMs, deck) {
  const later = dueAtMs != null;
  const choice = h('select', { 'aria-label': 'When', onchange: (e) => deck.setNewChatDue(e.target.value === 'later' ? laterDefault(Date.now()) : null) },
    h('option', { value: 'now' }, 'Now'), h('option', { value: 'later' }, 'Later'));
  choice.value = later ? 'later' : 'now';
  const at = later && h('input', {
    type: 'datetime-local', 'aria-label': 'Run at', min: localInput(Date.now()),
    onchange: (e) => { const ms = fromLocalInput(e.target.value); if (ms !== null) deck.setNewChatDue(ms, { quiet: true }); },
  });
  if (at) at.value = localInput(dueAtMs);
  // Its own row: beside the choice a phone-width field shows the date and cuts the time off.
  return [h('label', {}, h('span', { class: 'dim' }, 'When'), choice), at && h('label', {}, h('span', { class: 'dim' }, 'Run at'), at)];
}
