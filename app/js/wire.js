// Decoders for the bridge's JSON, written against `core/mobile/*` and pinned to it by the golden
// fixtures in test/fixtures (a Kotlin test re-encodes them and fails on drift).
//
// Defensive on purpose, like the Kotlin `fromJson`s: an unknown key is ignored, a wrong type
// falls back to a default, and nothing here throws on a shape the machine changed.

export const PROTOCOL_VERSION = 1;

/** `MobileFleetRow.RECENT_WINDOW_MS`, mirrored; the fixtures pin the number. */
export const RECENT_WINDOW_MS = 30 * 60_000;

const str = (o, k) => (typeof o?.[k] === 'string' ? o[k] : undefined);
const num = (o, k) => (typeof o?.[k] === 'number' && Number.isFinite(o[k]) ? o[k] : undefined);
const bool = (o, k) => o?.[k] === true;
const strings = (o, k) => (Array.isArray(o?.[k]) ? o[k].filter((s) => typeof s === 'string') : []);
const nonBlank = (s) => (s && s.trim() ? s : undefined);

/** @typedef {{key:string, vendor:string, accountId:string, accountLabel?:string, projectPath:string,
 *   projectName:string, gitBranch?:string, title:string, attention?:string, waitingReason?:string,
 *   lastActivityMs:number, costUsd:number, costKnown:boolean, contextPct?:number, messageCount:number,
 *   liveLine?:string, model?:string, pinned:boolean, done:boolean, pinRank?:number, folderId?:string}} FleetRow */

/** @returns {FleetRow} */
export function decodeRow(o) {
  return {
    key: str(o, 'key') ?? '',
    vendor: str(o, 'vendor') ?? 'CLAUDE',
    accountId: str(o, 'accountId') ?? '',
    accountLabel: nonBlank(str(o, 'accountLabel')),
    projectPath: str(o, 'projectPath') ?? '',
    projectName: str(o, 'projectName') ?? '',
    gitBranch: str(o, 'gitBranch'),
    title: str(o, 'title') ?? '',
    attention: str(o, 'attention'),
    waitingReason: str(o, 'waitingReason'),
    lastActivityMs: num(o, 'lastActivityMs') ?? 0,
    costUsd: num(o, 'costUsd') ?? 0,
    costKnown: bool(o, 'costKnown'),
    contextPct: num(o, 'contextPct'),
    messageCount: num(o, 'messageCount') ?? 0,
    liveLine: str(o, 'liveLine'),
    model: nonBlank(str(o, 'model')),
    pinned: bool(o, 'pinned'),
    done: bool(o, 'done'),
    pinRank: num(o, 'pinRank') >= 0 ? num(o, 'pinRank') : undefined,
    folderId: nonBlank(str(o, 'folderId')),
  };
}

/** `/v1/fleet`, and the `data:` of a `fleet` frame. */
export function decodeFleet(o) {
  const rows = Array.isArray(o?.rows)
    ? o.rows.filter((r) => r && typeof r === 'object').map(decodeRow)
    : [];
  return {
    rows,
    badgeCount: num(o, 'badgeCount') ?? 0,
    openProjects: strings(o, 'openProjects'),
    usageLine: str(o, 'usageLine'),
    generatedAtMs: num(o, 'generatedAtMs') ?? 0,
    folders: decodeFolders(o),
  };
}

/** `/v1/hello`. */
export function decodeHello(o) {
  return {
    protocolVersion: num(o, 'v') ?? 0,
    machine: str(o, 'machine') ?? '',
    ide: str(o, 'ide') ?? '',
    pluginVersion: str(o, 'pluginVersion') ?? '',
    capabilities: strings(o, 'capabilities'),
    servedByOtherIde: str(o, 'servedByOtherIde'),
    vapid: nonBlank(str(o, 'vapid')),
    sendInstance: nonBlank(str(o, 'sendInstance')),
    models: byVendor(o, 'models', option),
    effort: byVendor(o, 'effort', option),
    permissionModes: byVendor(o, 'permissionModes', option),
    accounts: byVendor(o, 'accounts', (e) => (nonBlank(str(e, 'id')) ? {
      id: e.id, label: nonBlank(str(e, 'label')) ?? e.id, resetAtMs: num(e, 'resetAtMs') > 0 ? e.resetAtMs : undefined, weeklyLimit: bool(e, 'weeklyLimit'),
      limitReached: bool(e, 'limitReached'),
    } : null)),
    activeAccounts: Object.fromEntries(Object.entries(o?.activeAccounts && typeof o.activeAccounts === 'object' ? o.activeAccounts : {})
      .filter(([v, id]) => VENDORS.has(v) && typeof id === 'string' && id.trim())),
  };
}

/** `MobileModelOption`: a row without a slug is no choice; a blank label reads as the slug. */
const option = (e) => (nonBlank(str(e, 'slug')) ? { slug: e.slug, label: nonBlank(str(e, 'label')) ?? e.slug } : null);

/** `{CLAUDE: [...], CODEX: [...]}` — an unknown vendor or a malformed row is dropped, never the whole hello. */
function byVendor(o, k, row) {
  const table = o?.[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : {};
  return Object.fromEntries(Object.entries(table).filter(([v, list]) => VENDORS.has(v) && Array.isArray(list))
    .map(([v, list]) => [v, list.filter((e) => e && typeof e === 'object').map(row).filter(Boolean)]));
}

/** The answer to `POST /v1/pair`; null when it carries no token (a machine that answered wrongly). */
export function decodePairAccepted(o) {
  const token = str(o, 'token');
  if (!token) return null;
  return { token, deviceId: str(o, 'deviceId') ?? '', machine: str(o, 'machine') ?? '' };
}

/** A refusal body `{v, error, message}`; null when the body is not one. */
export function decodeRefusal(o) {
  const error = str(o, 'error');
  return error ? { code: error, message: str(o, 'message') ?? error } : null;
}

/** `{v, keys}` of a `run` frame. An empty list means "refresh what is open". */
export function decodeRunFrame(o) {
  return { keys: strings(o, 'keys') };
}

// ---- transcript and writes ----------------------------------------------------------------------

const obj = (o, k) => (o?.[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : undefined);
const objects = (o, k) => (Array.isArray(o?.[k]) ? o[k].filter((e) => e && typeof e === 'object') : []);

export function decodeQuestion(o) {
  return {
    key: str(o, 'key') ?? '',
    header: nonBlank(str(o, 'header')),
    options: objects(o, 'options').map((e) => ({ label: str(e, 'label') ?? '', description: nonBlank(str(e, 'description')) })),
    multiSelect: bool(o, 'multiSelect'),
  };
}

export function decodeToolCall(o) {
  const result = obj(o, 'result');
  return {
    id: str(o, 'id') ?? '',
    name: str(o, 'name') ?? '',
    title: str(o, 'title') ?? '',
    summary: str(o, 'summary') ?? '',
    status: str(o, 'status') ?? 'ok',
    questions: objects(o, 'questions').map(decodeQuestion),
    result: result ? { kind: str(result, 'kind') ?? 'other', input: nonBlank(str(result, 'input')), output: str(result, 'output') ?? '', omittedBytes: num(result, 'omittedBytes') ?? 0 } : undefined,
  };
}

export function decodeTurn(o) {
  return {
    id: str(o, 'id') ?? '',
    role: str(o, 'role') ?? '',
    text: str(o, 'text') ?? '',
    timestampMs: num(o, 'timestampMs') ?? 0,
    toolCalls: objects(o, 'toolCalls').map(decodeToolCall),
    streaming: bool(o, 'streaming'),
    thought: nonBlank(str(o, 'thought')),
    retryPrompt: nonBlank(str(o, 'retryPrompt')),
  };
}

/** `GET /v1/session/{key}`; what this client shows of it (the rest of the page is ignored, not lost). */
export function decodeTranscript(o) {
  const permission = obj(o, 'pendingPermission');
  return {
    key: str(o, 'key') ?? '',
    title: str(o, 'title') ?? '',
    turns: objects(o, 'turns').map(decodeTurn),
    hasMore: bool(o, 'hasMore'),
    running: bool(o, 'running'),
    liveLine: str(o, 'liveLine'),
    model: nonBlank(str(o, 'model')),
    generatedAtMs: num(o, 'generatedAtMs') ?? 0,
    previousCursor: nonBlank(str(o, 'previousCursor')),
    revision: nonBlank(str(o, 'revision')),
    // Decided at the desk in v1; the page says so instead of drawing a card it cannot settle.
    pendingPermission: permission ? { tool: str(permission, 'tool') ?? '', title: str(permission, 'title') ?? '' } : undefined,
    pendingPlan: obj(o, 'pendingPlan') !== undefined,
    goal: nonBlank(str(o, 'goal')),
  };
}

/** `/v1/send` accepted. */
export function decodeSendAccepted(o) {
  return { taskId: str(o, 'taskId') ?? '', state: str(o, 'state') ?? 'queued', notice: nonBlank(str(o, 'notice')) };
}

/** `/v1/answer` accepted; `parked` false means the pick went out as a new prompt instead. */
export function decodeAnswerAccepted(o) {
  return { parked: bool(o, 'parked'), taskId: str(o, 'taskId'), state: str(o, 'state') };
}

/** The body of `POST /v1/send` into an existing conversation (`MobileSendRequest.toJson`). */
export function sendBody({ key, projectPath, vendor, prompt, clientMessageId, retryOf, dueAtMs }) {
  const body = { v: PROTOCOL_VERSION, key, prompt, vendor, newChat: false, clientMessageId };
  if (dueAtMs) body.dueAtMs = dueAtMs;
  // The machine resolves the conversation from its key; a blank path would only be ignored there.
  if (projectPath) body.projectPath = projectPath;
  if (retryOf) body.retryOf = retryOf;
  return body;
}

/**
 * The body of `POST /v1/send` that starts a chat (`MobileSendRequest.toJson` with `newChat`). A pick
 * left at the machine's default is absent, which is what every client sent before there were pickers.
 */
export function newChatBody({ projectPath, vendor, prompt, model, effort, accountId, clientMessageId, retryOf, dueAtMs }) {
  const body = { v: PROTOCOL_VERSION, projectPath, prompt, vendor, newChat: true, clientMessageId };
  if (model) body.model = model;
  if (effort) body.effort = effort;
  if (accountId) body.accountId = accountId;
  if (retryOf) body.retryOf = retryOf;
  // Under `schedule-create` only: an older plugin ignores it and would start the chat now.
  if (dueAtMs) body.dueAtMs = dueAtMs;
  return body;
}

export const stopBody = (key) => ({ v: PROTOCOL_VERSION, key });

/** `MobileAnswerRequest.toJson`; [typed] names the questions answered in the reader's own words. */
export function answerBody({ key, askId, answers, typed = [] }) {
  const body = { v: PROTOCOL_VERSION, key, answers };
  if (askId) body.askId = askId;
  if (typed.length) body.typed = typed;
  return body;
}

// ---- pairing ------------------------------------------------------------------------------------

/**
 * The origin a pairing payload may name. The token is sent to whatever this returns, so it is
 * checked here rather than trusted: https, a `.ts.net` host, no credentials, no path. The page's
 * CSP refuses any other host as well; this makes the refusal a sentence instead of a console error.
 */
export function webOrigin(text) {
  if (typeof text !== 'string') return null;
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  if (!url.hostname.endsWith('.ts.net') || url.hostname === '.ts.net') return null;
  return url.origin;
}

/** The port `MobileDeviceStore.DEFAULT_WEB_PORT` opens the browser listener on. */
export const DEFAULT_WEB_PORT = 63351;

/** A typed address (`mac.tail1234.ts.net`, `…:63351`, or a full https origin) → an origin, or null. */
export function typedOrigin(text) {
  const t = (text ?? '').trim().replace(/\/+$/, '');
  if (!t) return null;
  const withScheme = /^https:\/\//i.test(t) ? t : `https://${t}`;
  const origin = webOrigin(withScheme);
  if (!origin) return null;
  const url = new URL(origin);
  if (url.port || /:\d+$/.test(withScheme)) return origin;
  return `${origin}:${DEFAULT_WEB_PORT}`;
}

function base64UrlToText(b64) {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * The pairing payload out of whatever the user pasted: the `…/pair#p=<base64url>` link, an
 * `agentdeck://pair#p=…` link, the fragment `#p=…` alone, or the raw JSON the IDE's card shows.
 * Returns `{origin, code, machine}` or `{error}`; `origin` is null when the payload carries no
 * `web` field (a machine with Browser access off — the caller says so).
 */
export function parsePairing(text) {
  const t = (text ?? '').trim();
  if (!t) return { error: 'empty' };
  let json = t;
  if (!t.startsWith('{')) {
    const at = t.indexOf('#');
    const fragment = at >= 0 ? t.slice(at + 1) : t;
    const p = new URLSearchParams(fragment).get('p');
    if (!p) return { error: 'not-a-pairing-link' };
    try {
      json = base64UrlToText(p);
    } catch {
      return { error: 'not-a-pairing-link' };
    }
  }
  let o;
  try {
    o = JSON.parse(json);
  } catch {
    return { error: 'not-a-pairing-link' };
  }
  if (!o || typeof o !== 'object' || num(o, 'v') !== PROTOCOL_VERSION) return { error: 'unsupported-version' };
  const code = nonBlank(str(o, 'code'));
  if (!code) return { error: 'not-a-pairing-link' };
  const web = nonBlank(str(o, 'web'));
  const origin = web ? webOrigin(web) : null;
  if (web && !origin) return { error: 'web-origin-refused' };
  return { origin, code, machine: str(o, 'machine') ?? '' };
}

/** What this browser is called in the desk's device list, e.g. "Safari on iPhone". */
export function deviceLabel(userAgent) {
  const ua = userAgent ?? '';
  const platform = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux|X11/.test(ua) ? 'Linux'
    : null;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /(Chrome|CriOS)\//.test(ua) ? 'Chrome'
    : /(Firefox|FxiOS)\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  return platform ? `${browser} on ${platform}` : browser;
}

// ---- fleet grouping (FleetGrouping.kt in the phone app) -----------------------------------------

/** Declaration order is display order, as in the app's `FleetGroup`. */
export const GROUPS = [
  { id: 'WAITING', title: 'Waiting on you' },
  { id: 'RUNNING', title: 'Running' },
  { id: 'FAILED', title: 'Failed' },
  { id: 'RECENT', title: 'Recently active' },
  { id: 'DONE_UNREVIEWED', title: 'Done, unreviewed' },
  { id: 'OTHER', title: 'Everything else' },
];

/** Recency is measured on the snapshot's own stamp, never the reader's clock. */
export function isRecentAt(row, generatedAtMs) {
  return generatedAtMs > 0 && row.lastActivityMs > 0 && generatedAtMs - row.lastActivityMs <= RECENT_WINDOW_MS;
}

export function groupOf(row, generatedAtMs) {
  switch (row.attention) {
    case 'WAITING_ON_YOU': return 'WAITING';
    case 'FAILED': return 'FAILED';
    case 'RUNNING': return 'RUNNING';
    case 'DONE_UNREVIEWED': return 'DONE_UNREVIEWED';
    default: return isRecentAt(row, generatedAtMs) ? 'RECENT' : 'OTHER';
  }
}

/**
 * A row marked Done leaves the everyday list, except while it waits, runs or has failed — Done is a
 * verdict on finished work and must not hide a question (`FleetScope.shelved`).
 */
export function shelved(row) {
  return row.done && !['WAITING_ON_YOU', 'RUNNING', 'FAILED'].includes(row.attention);
}

const pinnedFirst = (a, b) =>
  (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) ||
  (a.pinned ? (a.pinRank ?? Infinity) - (b.pinRank ?? Infinity) || 0 : 0);

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const titleMatches = (row, needle) =>
  !needle || [row.title, row.projectName, row.gitBranch, row.liveLine].some((s) => s?.toLowerCase().includes(needle));

/** Filtered by [query], grouped, pinned then newest first inside each group; empty groups dropped. */
export function sections(fleet, query = '') {
  const needle = query.trim().toLowerCase();
  const kept = fleet.rows.filter((r) => !shelved(r) && titleMatches(r, needle));
  return GROUPS.map((g) => ({
    ...g,
    rows: kept
      .filter((r) => groupOf(r, fleet.generatedAtMs) === g.id)
      .sort((a, b) => pinnedFirst(a, b) || b.lastActivityMs - a.lastActivityMs || byKey(a, b)),
  })).filter((s) => s.rows.length > 0);
}

/** Rows one group shows before the rest go behind "Show all N" (`FleetGrouping.SECTION_CAP`). */
export const SECTION_CAP = 10;

/** A waiting row names what it waits for; every other row reads its group's title. */
export function stateLabel(row, groupId) {
  if (groupId !== 'WAITING') return GROUPS.find((g) => g.id === groupId)?.title ?? '';
  switch (row.waitingReason) {
    case 'PERMISSION': return 'Waiting for tool permission';
    case 'QUESTION': return 'Waiting for your answer';
    case 'PLAN_APPROVAL': return 'Waiting for plan approval';
    default: return 'Waiting on you';
  }
}

// ---- message search -----------------------------------------------------------------------------

/** `MobileSessionSearchRequest.MIN_QUERY` and `PAGE_FILES`, mirrored; the fixtures pin the numbers. */
export const SEARCH_MIN_QUERY = 3;
export const SEARCH_PAGE_FILES = 200;

export const searchEligible = (query) => query.trim().length >= SEARCH_MIN_QUERY;

/**
 * Which chats a message search reads (`MessageSearch.population`): the rows the list would show
 * without the query, minus those the title search already listed — a title hit is the better row.
 * Newest first, the desk's own order for a bounded pass.
 */
export function searchPopulation(fleet, query) {
  const needle = query.trim().toLowerCase();
  return fleet.rows
    .filter((r) => !shelved(r) && !titleMatches(r, needle))
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs || byKey(a, b))
    .map((r) => r.key);
}

export const searchBody = ({ query, keys }) => ({ v: PROTOCOL_VERSION, query, keys });

/** `/v1/session-search`: one page of a message search. */
export function decodeSearchResult(o) {
  const hits = Array.isArray(o?.hits) ? o.hits.filter((x) => nonBlank(str(x, 'key'))).map((x) => ({ key: x.key, snippet: str(x, 'snippet') ?? '' })) : [];
  return {
    query: str(o, 'query') ?? '',
    hits,
    scanned: Math.max(0, num(o, 'scanned') ?? 0),
    examined: Math.max(0, num(o, 'examined') ?? 0),
    timedOut: bool(o, 'timedOut'),
  };
}

// ---- folders ------------------------------------------------------------------------------------

/**
 * `MobileFolder.listFrom`: the desk's Sessions folders in its order; one without an id or a name is
 * dropped rather than drawn as a blank choice. Membership is on each row ([FleetRow.folderId]).
 */
export function decodeFolders(o) {
  const list = Array.isArray(o?.folders) ? o.folders.filter((e) => e && typeof e === 'object') : [];
  return list.filter((f) => nonBlank(str(f, 'id')) && nonBlank(str(f, 'name'))).map((f) => ({
    id: f.id, name: f.name, done: bool(f, 'done'), note: str(f, 'note') ?? '', count: Math.max(0, num(f, 'count') ?? 0),
  }));
}

/** `MobileSessionActionRequest` for `folder` ([folderId] blank takes the chat out of its folder) and `folder-new` ([title]). */
export function sessionActionBody({ key, action, title, folderId }) {
  const body = { v: PROTOCOL_VERSION, key, action };
  if (title !== undefined) body.title = title;
  if (folderId !== undefined) body.folderId = folderId;
  return body;
}

/** `MobileSessionActionResult`: the chat's list state read back from the machine, with its folders after the write. */
export function decodeSessionActionResult(o) {
  return {
    key: str(o, 'key') ?? '',
    title: str(o, 'title') ?? '',
    pinned: bool(o, 'pinned'),
    done: bool(o, 'done'),
    folderId: nonBlank(str(o, 'folderId')),
    folders: decodeFolders(o),
  };
}

/** `MobileFolderActionRequest`: an `edit` carries only the fields changed, so a desk edit to another one survives. */
export function folderActionBody({ folderId, action, name, note, done }) {
  const body = { v: PROTOCOL_VERSION, folderId, action };
  if (name !== undefined) body.name = name;
  if (note !== undefined) body.note = note;
  if (done !== undefined) body.done = done;
  return body;
}

/** `MobileFolderActionResult`: the machine's folders after the write. */
export const decodeFolderActionResult = (o) => ({ folders: decodeFolders(o) });

// ---- fork ---------------------------------------------------------------------------------------

/**
 * `MobileSessionForkRequest`: no [point] and not [whole] lists the messages to fork from; a
 * [point] or [whole] writes the fork. [operationId] makes a retry answer the fork already made.
 */
export function forkBody({ key, point, whole = false, operationId }) {
  const body = { v: PROTOCOL_VERSION, key };
  if (point) body.point = point;
  if (whole) body.whole = true;
  if (operationId) body.operationId = operationId;
  return body;
}

/** `MobileSessionForkPoints`: the reader's own messages, oldest first, or why none can be offered now. */
export function decodeForkPoints(o) {
  return {
    key: str(o, 'key') ?? '',
    whole: bool(o, 'whole'),
    points: objects(o, 'points').filter((p) => nonBlank(str(p, 'id'))).map((p) => ({
      id: p.id,
      label: str(p, 'label') ?? '',
      ordinal: num(p, 'ordinal') ?? 0,
      atMs: num(p, 'atMs') > 0 ? p.atMs : undefined,
    })),
    omitted: Math.max(0, num(o, 'omitted') ?? 0),
    refused: nonBlank(str(o, 'refused')),
  };
}

/** `MobileSessionForkResult`: [forked] false means nothing was written and [message] says why. */
export function decodeForkResult(o) {
  return {
    key: str(o, 'key') ?? '',
    forked: bool(o, 'forked'),
    message: str(o, 'message') ?? '',
    newKey: nonBlank(str(o, 'newKey')),
    title: str(o, 'title') ?? '',
    listed: bool(o, 'listed'),
    promptText: str(o, 'promptText'),
  };
}

// ---- usage --------------------------------------------------------------------------------------

/** `MobileUsageBucket`: absent flags are the honest defaults — a complete, exact figure. */
export function decodeUsageBucket(o) {
  return {
    input: num(o, 'in') ?? 0,
    output: num(o, 'out') ?? 0,
    cacheRead: num(o, 'cr') ?? 0,
    cacheWrite: num(o, 'cw') ?? 0,
    costUsd: num(o, 'usd') ?? 0,
    costKnown: !bool(o, 'partial'),
    costEstimated: bool(o, 'approx'),
  };
}

const labelled = (key) => (e) => (nonBlank(str(e, key)) ? { [key]: str(e, key), usage: decodeUsageBucket(obj(e, 'usage')) } : null);

/** `AgentVendor` names; the Kotlin decoders drop any other, so an unknown agent is never offered back as a filter. */
const VENDORS = new Set(['CLAUDE', 'CODEX']);
const vendor = (s) => (VENDORS.has(s) ? s : undefined);

/** `GET /v1/usage` (`MobileUsageReport`); rows without their name are dropped, as the Kotlin decoder drops them. */
export function decodeUsage(o) {
  const filter = obj(o, 'filter');
  return {
    cards: objects(o, 'cards').map(labelled('label')).filter(Boolean),
    days: objects(o, 'days').map(labelled('day')).filter(Boolean),
    models: objects(o, 'models').map(labelled('label')).filter(Boolean),
    projects: objects(o, 'projects').map((e) => (nonBlank(str(e, 'name'))
      ? { name: str(e, 'name'), sessions: num(e, 'sessions') ?? 0, usage: decodeUsageBucket(obj(e, 'usage')) } : null)).filter(Boolean),
    accounts: objects(o, 'accounts').filter((e) => nonBlank(str(e, 'id')) && vendor(str(e, 'vendor'))).map((e) => ({
      id: str(e, 'id'),
      vendor: str(e, 'vendor'),
      label: nonBlank(str(e, 'label')) ?? str(e, 'id'),
      windows: objects(e, 'windows').filter((w) => nonBlank(str(w, 'label'))).map((w) => ({
        label: str(w, 'label'),
        percent: num(w, 'percent') ?? 0,
        resetAtMs: num(w, 'resetAtMs') > 0 ? num(w, 'resetAtMs') : undefined,
        resetText: nonBlank(str(w, 'resetText')),
        reached: bool(w, 'reached'),
      })),
      note: nonBlank(str(e, 'note')),
      active: bool(e, 'active'),
    })),
    caps: objects(o, 'caps').filter((e) => nonBlank(str(e, 'title')))
      .map((e) => ({ title: str(e, 'title'), value: str(e, 'value') ?? '', detail: nonBlank(str(e, 'detail')) })),
    filter: {
      agents: strings(filter, 'agents').filter(vendor),
      accounts: objects(filter, 'accounts').filter((e) => nonBlank(str(e, 'id')))
        .map((e) => ({ id: str(e, 'id'), label: nonBlank(str(e, 'label')) ?? str(e, 'id') })),
      agent: vendor(str(filter, 'agent')),
      account: nonBlank(str(filter, 'account')),
    },
    generatedAtMs: num(o, 'generatedAtMs') ?? 0,
    indexing: bool(o, 'indexing'),
  };
}

const cents = (usd) => usd.toFixed(2);
const roundsToNothing = (usd) => usd > 0 && cents(usd) === '0.00';

/**
 * `core/spend/Money.bucket`, the one spelling of a cost the desk and the phone share: `$1.23`
 * measured, `~$1.23` partly priced off a sibling model's rate, `≥$1.23` a floor with unpriced
 * tokens folded in, `—` when nothing about it is known. Never `$0.00` over money that exists.
 */
export function money({ costUsd, costKnown, costEstimated }) {
  const usd = (v) => (roundsToNothing(v) ? '<$0.01' : `$${cents(v)}`);
  if (costUsd > 0) {
    if (!costKnown) return roundsToNothing(costUsd) ? '>$0.00' : `≥$${cents(costUsd)}`;
    return costEstimated ? `~${usd(costUsd)}` : usd(costUsd);
  }
  return costKnown ? '$0.00' : '—';
}
