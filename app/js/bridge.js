// The bridge as one origin: hello, pair, fleet and the fleet stream, over `fetch`.
//
// The browser cannot pin the bridge's certificate, so the trust root is the certificate's own
// name (a Let's Encrypt `*.ts.net` certificate) and this client only ever talks to an origin
// `wire.webOrigin` accepted.

import {
  answerBody, decodeAnswerAccepted, decodeFleet, decodeHello, decodePairAccepted, decodeRefusal, decodeSendAccepted,
  decodeFolderActionResult, decodeForkPoints, decodeForkResult, decodeSearchResult, decodeSessionActionResult, decodeTranscript,
  decodeUsage, folderActionBody, forkBody, newChatBody, PROTOCOL_VERSION, searchBody, sendBody, sessionActionBody, stopBody,
} from './wire.js';
import { decodeScheduleEditDetail, decodeScheduled, scheduledCommandBody } from './scheduled.js';
import { decodeCommitPreview, decodeCommitResult } from './commit.js';
import { decodeAiReviewState, decodeExcerpt, excerptQuery } from './aireview.js';
import { decodeReviewFileDiff, decodeReviewList, decodeRevertPreview, decodeRevertResult, reviewMarkBody, reviewRevertBody, revertQuery } from './review.js';
import { decodeNotes } from './notes.js';
import { SseParser, WATCHDOG_MS } from './sse.js';

/** A refusal the machine sent (`status` and `code` are its own) or a transport failure (`code` 'unreachable'). */
export class BridgeError extends Error {
  constructor(code, message, status = 0, maybeDelivered = false) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
    /** A write whose request may have reached the machine before the link failed: it may have run. */
    this.maybeDelivered = maybeDelivered;
  }

  /** The token is no longer good: go back to pairing. */
  get revoked() {
    return this.code === 'device-revoked' || this.code === 'unauthorized';
  }
}

async function refusalFrom(response) {
  let body = null;
  try {
    body = decodeRefusal(await response.json());
  } catch {
    // not JSON: fall through to the generic answer
  }
  return new BridgeError(body?.code ?? `http-${response.status}`, body?.message ?? `The machine answered ${response.status}.`, response.status);
}

export class Bridge {
  /** @param {string} origin @param {string|null} token @param {typeof fetch} [fetchImpl] */
  constructor(origin, token = null, fetchImpl = (...a) => fetch(...a)) {
    this.origin = origin;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #request(path, { method = 'GET', body, authorized = true, signal } = {}) {
    const headers = {};
    if (authorized && this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    let response;
    try {
      response = await this.fetch(this.origin + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // A browser cannot tell "never connected" from "connected, then dropped", so any failed write is
      // possibly delivered; the outbox decides what that allows.
      throw new BridgeError('unreachable', 'Could not reach the machine.', 0, method !== 'GET');
    }
    if (!response.ok) throw await refusalFrom(response);
    return response;
  }

  async hello() {
    return decodeHello(await (await this.#request('/v1/hello', { authorized: false })).json());
  }

  async pair(code, label) {
    const response = await this.#request('/v1/pair', {
      method: 'POST',
      authorized: false,
      body: { v: PROTOCOL_VERSION, code, label },
    });
    const accepted = decodePairAccepted(await response.json());
    if (!accepted) throw new BridgeError('bad-answer', 'The machine accepted the code but sent no token.');
    return accepted;
  }

  async fleet(signal) {
    return decodeFleet(await (await this.#request('/v1/fleet', { signal })).json());
  }

  /** One page of a conversation, newest turn last; [before] is a page's `previousCursor` for older turns. */
  async session(key, { before, signal } = {}) {
    const query = before ? `?paging=1&before=${encodeURIComponent(before)}` : '?paging=1';
    return decodeTranscript(await (await this.#request(`/v1/session/${encodeURIComponent(key)}${query}`, { signal })).json());
  }

  /** `GET /v1/usage`, narrowed as the desk's Agent and Account filters narrow it; only asked of a machine advertising `usage`. */
  async usage({ agent, account, signal } = {}) {
    const query = new URLSearchParams();
    if (agent) query.set('agent', agent);
    if (account) query.set('account', account);
    const q = query.toString();
    return decodeUsage(await (await this.#request(`/v1/usage${q ? `?${q}` : ''}`, { signal })).json());
  }

  /** `GET /v1/scheduled`: the machine's queue, recent runs and schedules made elsewhere; only asked under `scheduled`. */
  async scheduled() {
    return decodeScheduled(await (await this.#request('/v1/scheduled')).json());
  }

  /** `POST /v1/scheduled`: pause, resume, run now or cancel the rows [ids] name; answers how many it changed, or null when the answer does not say. */
  async scheduledCommand({ action, ids }) {
    const answer = await (await this.#request('/v1/scheduled', { method: 'POST', body: scheduledCommandBody({ action, ids }) })).json().catch(() => ({}));
    return typeof answer?.affected === 'number' ? answer.affected : null;
  }

  /** `GET /v1/review/{key}`: the files [key] changed, without their content; only asked under `review`. */
  async review(key) {
    return decodeReviewList(await (await this.#request(`/v1/review/${encodeURIComponent(key)}`)).json());
  }

  /** `GET /v1/review/{key}/file`: one file's diff; [path] exactly as the list named it, which is what the desk matches. */
  async reviewFile(key, path) {
    const query = new URLSearchParams({ path });
    return decodeReviewFileDiff(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/file?${query}`)).json());
  }

  /** `POST /v1/review/{key}`: ticks or clears [paths] ([] = every file); answers the ticks now set, by path, without counts. */
  async markReviewed(key, paths, reviewed) {
    return decodeReviewList(await (await this.#request(`/v1/review/${encodeURIComponent(key)}`, { method: 'POST', body: reviewMarkBody(paths, reviewed) })).json());
  }

  /**
   * `GET /v1/review/{key}/revert`: what reverting the whole session — or with [scope] `request`/`after`,
   * one [request]'s changes or everything after it — would do; reserves nothing. Only asked under `review-revert`.
   */
  async revertPreview(key, scope = 'session', request = null) {
    return decodeRevertPreview(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/revert${revertQuery(scope, request)}`)).json());
  }

  /** `POST /v1/review/{key}/revert`: the confirmed revert of [paths]; a retry with the same [operationId] gets the first attempt's answer. */
  async revert(key, previewToken, paths, operationId, scope = 'session', request = null) {
    const body = reviewRevertBody(key, previewToken, paths, operationId, scope, request);
    return decodeRevertResult(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/revert`, { method: 'POST', body })).json());
  }

  /** `GET /v1/review/{key}/commit`: the chat's own files git would commit, and the desk's seed message; reserves nothing. Only asked under `review-commit`. */
  async commitPreview(key) {
    return decodeCommitPreview(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/commit`)).json());
  }

  /** `POST /v1/review/{key}/commit` ([body] from `commitRequestBody`); a retry with the same operation id gets the first attempt's answer. */
  async commit(key, body) {
    return decodeCommitResult(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/commit`, { method: 'POST', body })).json());
  }

  /** `GET /v1/review/{key}/ai-review`: Codex's review of the chat's project — its form, a run going, or the last findings. Only asked under `ai-review`. */
  async aiReviewState(key) {
    return decodeAiReviewState(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/ai-review`)).json());
  }

  /** `POST /v1/review/{key}/ai-review` ([body] from `aiReviewBody`): starts, stops or writes rules, and answers the state at once. */
  async aiReview(key, body) {
    return decodeAiReviewState(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/ai-review`, { method: 'POST', body })).json());
  }

  /** Finding [index] of the machine's current report at its lines; only asked under `ai-review-location`. */
  async aiReviewExcerpt(key, index, finding) {
    return decodeExcerpt(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/ai-review${excerptQuery(index, finding)}`)).json());
  }

  /** `GET /v1/review/{key}/notes`: the chat's saved review notes and its feedback awaiting a retry; only asked under `review-notes`. */
  async reviewNotes(key) {
    return decodeNotes(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/notes`)).json());
  }

  /** `POST /v1/review/{key}/notes` ([body] from `noteRequestBody`): answers the whole list after the write. */
  async reviewNote(key, body) {
    return decodeNotes(await (await this.#request(`/v1/review/${encodeURIComponent(key)}/notes`, { method: 'POST', body })).json());
  }

  /** `GET /v1/scheduled/<id>`: one queued prompt as the machine would edit it; only asked under `schedule-edit`. */
  async scheduleEditDetail(id) {
    return decodeScheduleEditDetail(await (await this.#request(`/v1/scheduled/${encodeURIComponent(id)}`)).json());
  }

  /** `POST /v1/scheduled/<id>`: rewrites that row in place ([body] from `scheduleEditBody`); a refusal throws. */
  async saveScheduleEdit(id, body) {
    await this.#request(`/v1/scheduled/${encodeURIComponent(id)}`, { method: 'POST', body });
  }

  /** `POST /v1/session-search`: one page of the desk's message search over [keys]; only asked of a machine advertising `session-search`. */
  async searchMessages({ query, keys }) {
    return decodeSearchResult(await (await this.#request('/v1/session-search', { method: 'POST', body: searchBody({ query, keys }) })).json());
  }

  /** `POST /v1/session-fork` without a point: the messages [key] can be forked from; nothing is written. */
  async forkPoints(key) {
    return decodeForkPoints(await (await this.#request('/v1/session-fork', { method: 'POST', body: forkBody({ key }) })).json());
  }

  /** `POST /v1/session-fork` naming a [point] (Claude) or [whole] (Branch chat): the desk's own fork. */
  async fork(request) {
    return decodeForkResult(await (await this.#request('/v1/session-fork', { method: 'POST', body: forkBody(request) })).json());
  }

  /** `POST /v1/session-actions`: files a chat into a desk folder, or a new one; only asked of a machine advertising `session-folders`. */
  async sessionAction(request) {
    return decodeSessionActionResult(await (await this.#request('/v1/session-actions', { method: 'POST', body: sessionActionBody(request) })).json());
  }

  /** `POST /v1/folder-actions`: renames, notes, marks done or deletes a desk folder; only asked under `folder-actions`. */
  async folderAction(request) {
    return decodeFolderActionResult(await (await this.#request('/v1/folder-actions', { method: 'POST', body: folderActionBody(request) })).json());
  }

  /** `/v1/send` into an existing conversation, or a new chat when [request] names no key. A 200 is acceptance; the body is read leniently. */
  async send(request) {
    const response = await this.#request('/v1/send', { method: 'POST', body: request.key ? sendBody(request) : newChatBody(request) });
    return decodeSendAccepted(await response.json().catch(() => ({})));
  }

  async stop(key) {
    await this.#request('/v1/stop', { method: 'POST', body: stopBody(key) });
  }

  async answer(request) {
    const response = await this.#request('/v1/answer', { method: 'POST', body: answerBody(request) });
    return decodeAnswerAccepted(await response.json().catch(() => ({})));
  }

  /** `/v1/push/register` with a flattened `PushSubscription` ([subscriptionBody]). */
  async pushRegister(body) {
    await this.#request('/v1/push/register', { method: 'POST', body });
  }

  async pushUnregister() {
    await this.#request('/v1/push/unregister', { method: 'POST', body: { v: PROTOCOL_VERSION } });
  }

  async unpair() {
    await this.#request('/v1/unpair', { method: 'POST', body: { v: PROTOCOL_VERSION } });
  }

  /**
   * `fetch()` streaming, because `EventSource` cannot send `Authorization`. Resolves when the
   * stream ends (or [signal] aborts); throws [BridgeError] on a refusal or a dead socket. The
   * read watchdog aborts a socket that stops delivering even keep-alives, which a half-open
   * connection otherwise holds forever.
   *
   * [onOpen] fires once the machine has said 200 — the moment "live" becomes true.
   * [onFrame] receives `{id, event, data}`; returning false ends the stream.
   */
  async stream({ onOpen = () => {}, onFrame, signal, watchdogMs = WATCHDOG_MS }) {
    const link = new AbortController();
    const abort = () => link.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let silent = false;
    let timer;
    const rearm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { silent = true; link.abort(); }, watchdogMs);
    };
    try {
      rearm();
      let response;
      try {
        response = await this.fetch(this.origin + '/v1/fleet/stream', {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
          cache: 'no-store',
          credentials: 'omit',
          signal: link.signal,
        });
      } catch (error) {
        if (silent) throw new BridgeError('unreachable', 'The machine stopped answering.');
        if (error?.name === 'AbortError') return;
        throw new BridgeError('unreachable', 'Could not reach the machine.');
      }
      if (!response.ok) throw await refusalFrom(response);
      onOpen();
      const parser = new SseParser(rearm);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
            if (onFrame(frame) === false) return;
          }
        }
      } catch (error) {
        if (silent) throw new BridgeError('unreachable', 'The machine stopped answering.');
        if (error?.name === 'AbortError') return;
        throw new BridgeError('unreachable', 'The connection to the machine dropped.');
      } finally {
        reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      link.abort();
    }
  }
}
