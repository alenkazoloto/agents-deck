// Durable sends follow OutgoingQueue's backoff and parking rules; offline Send remains available.
// Failed writes may have arrived: retry only with send-dedupe on the same machine instance.
// An IDE restart loses accepted IDs. Refusals always park.

import { BridgeError } from './bridge.js';

export const MAX_ITEMS = 50;
export const FIRST_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const SEND_DEDUPE = 'send-dedupe';
export const INTERRUPTED = 'The page closed before this was confirmed.';

/** 5 s, doubling to 5 min. */
export function backoffMs(attempts) {
  let delay = FIRST_BACKOFF_MS;
  for (let i = 0; i < Math.min(Math.max(attempts - 1, 0), 12); i++) delay = Math.min(delay * 2, MAX_BACKOFF_MS);
  return Math.min(delay, MAX_BACKOFF_MS);
}

/**
 * [key] empty is a new chat, started in [projectPath] with the picks in [start] (`{model, effort, accountId}`, each
 * absent for the machine's default); new chats for one agent and project start in the order they were asked.
 * [dueAtMs] set is a prompt the machine queues to run then (only enqueued under `schedule-create`).
 *
 * @typedef {{id:string, origin:string, key:string, projectPath:string, vendor:string, label:string, prompt:string, start?:object, dueAtMs?:number,
 *   createdAtMs:number, attempts:number, nextAttemptAtMs:number, lastError?:string, parked:boolean, refused:boolean,
 *   uncertain:boolean, inFlight:boolean, sentTo?:string}} OutgoingSend
 */

/**
 * A conversation's line: nothing queued behind another prompt for the same conversation overtakes it.
 * New chats line up per agent and project (Android's `OutgoingQueue`), so one parked start never holds another project's.
 */
const laneOf = (item) => item.key || `new:${item.vendor}:${item.projectPath}`;

/** The oldest item the link may carry now, and never one queued behind another for its conversation. */
export function due(items, nowMs, origin) {
  const blocked = new Set();
  for (const item of items) {
    if (item.origin !== origin || blocked.has(laneOf(item))) continue;
    if (!item.parked && item.nextAttemptAtMs <= nowMs) return item;
    blocked.add(laneOf(item));
  }
  return null;
}

/** Ms until the drain should look again, or null when nothing is merely waiting on the clock. */
export function nextWakeMs(items, nowMs, origin) {
  const blocked = new Set();
  let soonest = null;
  for (const item of items) {
    if (item.origin !== origin || blocked.has(laneOf(item))) continue;
    if (item.parked) { blocked.add(laneOf(item)); continue; }
    const wait = Math.max(item.nextAttemptAtMs - nowMs, 0);
    if (soonest === null || wait < soonest) soonest = wait;
  }
  return soonest;
}

export function afterFailure(item, { nowMs, error, refused, reachedMachine, dedupes }) {
  const attempts = item.attempts + 1;
  const park = refused || (reachedMachine && !dedupes);
  const uncertain = item.uncertain || reachedMachine;
  return {
    ...item, attempts, lastError: error, parked: park, refused, inFlight: false, uncertain,
    sentTo: uncertain ? item.sentTo : undefined,
    nextAttemptAtMs: park ? 0 : nowMs + backoffMs(attempts),
  };
}

export const resumed = (item) => ({ ...item, parked: false, refused: false, nextAttemptAtMs: 0, lastError: undefined });

/** The reader's own Retry: they looked and decided it did not run, so it goes out as a fresh send. */
export const retried = (item) => ({ ...resumed(item), uncertain: false, sentTo: undefined });

/** Marked before the bytes go out, so a page that dies mid-request leaves evidence an attempt began. */
export const attempting = (item, instance) => ({ ...item, inFlight: true, sentTo: item.uncertain ? item.sentTo : instance });

/** What a queue read back from storage means: an attempt with no recorded end may have run. */
export function restored(items) {
  return items.map((i) => (i.inFlight ? { ...i, inFlight: false, uncertain: true, parked: true, lastError: INTERRUPTED } : i));
}

/** Items a dedupe-honouring machine may take back: parked only for uncertainty, sent to this same instance. */
export function resumable(items, instance) {
  return items.map((i) => (i.parked && i.uncertain && !i.refused && instance && i.sentTo === instance ? resumed(i) : i));
}

export const chipLine = (items, deliveringId) => {
  if (!items.length) return null;
  const parked = items.find((i) => i.parked);
  if (parked) return `Not sent · ${parked.lastError?.trim() || 'The machine did not confirm it.'}`;
  if (items.some((i) => i.id === deliveringId)) return 'Sending…';
  return items.length === 1 ? 'Queued · waiting for the machine' : `Queued (${items.length}) · waiting for the machine`;
};

export class Outbox {
  /**
   * @param {{store: import('./store.js').Store, now?: ()=>number, mintId?: ()=>string, onChange?: ()=>void,
   *   onDelivered?: (item: OutgoingSend, accepted: object)=>void}} deps
   */
  constructor({ store, now = () => Date.now(), mintId = () => crypto.randomUUID(), onChange = () => {}, onDelivered = () => {} }) {
    this.store = store;
    this.now = now;
    this.mintId = mintId;
    this.onChange = onChange;
    this.onDelivered = onDelivered;
    /** @type {OutgoingSend[]} */
    this.items = [];
    this.deliveringId = null;
    this.draining = null;
  }

  async load() {
    this.items = restored(await this.store.outbox());
    await this.#persist();
  }

  forKey(key) {
    return this.items.filter((i) => i.key === key);
  }

  async #persist() {
    await this.store.saveOutbox(this.items);
    this.onChange();
  }

  /** Durable before this returns: from here the prompt is the outbox's, and the caller may clear its draft. */
  async enqueue({ origin, key, projectPath, vendor, label, prompt, start, dueAtMs }) {
    const item = {
      id: this.mintId(), origin, key, projectPath, vendor, label, prompt, ...(start ? { start } : {}), ...(dueAtMs ? { dueAtMs } : {}), createdAtMs: this.now(),
      attempts: 0, nextAttemptAtMs: 0, parked: false, refused: false, uncertain: false, inFlight: false,
    };
    this.items = [...this.items, item].slice(-MAX_ITEMS);
    await this.#persist();
    return item;
  }

  #replace(item) {
    this.items = this.items.map((i) => (i.id === item.id ? item : i));
  }

  async retry(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    this.#replace(retried(item));
    await this.#persist();
  }

  async discard(id) {
    this.items = this.items.filter((i) => i.id !== id);
    await this.#persist();
  }

  /** Takes an item back out of the queue and returns its words, so they can go back into the draft. */
  async edit(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    await this.discard(id);
    return item.prompt;
  }

  /** A pairing to another machine leaves nothing behind that could be delivered to the wrong one. */
  async keepOnlyOrigin(origin) {
    this.items = this.items.filter((i) => i.origin === origin);
    await this.#persist();
  }

  nextWakeMs(origin) {
    return nextWakeMs(this.items, this.now(), origin);
  }

  /**
   * Delivers what is due, oldest first, one at a time. Serialised: a second call while one is
   * running joins it rather than racing it for the same item.
   *
   * [bridge] is used only while [reachable]; [hello] is the machine's last answer, which says
   * whether a repeat is safe (`send-dedupe`) and which instance would recognise it.
   * Rejects with a revoked [BridgeError] so the caller can return to pairing; the item stays queued.
   */
  drain(bridge, { origin, hello, reachable }) {
    if (this.draining) return this.draining;
    this.draining = this.#drain(bridge, { origin, hello, reachable }).finally(() => { this.draining = null; });
    return this.draining;
  }

  async #drain(bridge, { origin, hello, reachable }) {
    const dedupeCapable = !!hello?.capabilities?.includes(SEND_DEDUPE);
    if (reachable && dedupeCapable && hello.sendInstance) {
      const next = resumable(this.items, hello.sendInstance);
      if (next.some((n, i) => n !== this.items[i])) {
        this.items = next;
        await this.#persist();
      }
    }
    while (reachable) {
      const item = due(this.items, this.now(), origin);
      if (!item) return;
      const going = attempting(item, dedupeCapable ? hello.sendInstance : undefined);
      this.#replace(going);
      this.deliveringId = item.id;
      await this.#persist();
      try {
        const accepted = await bridge.send({
          key: item.key, projectPath: item.projectPath, vendor: item.vendor, prompt: item.prompt, ...item.start, ...(item.dueAtMs ? { dueAtMs: item.dueAtMs } : {}),
          clientMessageId: item.id, retryOf: going.uncertain ? going.sentTo : undefined,
        });
        this.items = this.items.filter((i) => i.id !== item.id);
        this.deliveringId = null;
        await this.#persist();
        this.onDelivered(item, accepted);
      } catch (error) {
        this.deliveringId = null;
        if (error instanceof BridgeError && error.revoked) {
          this.#replace({ ...going, inFlight: false });
          await this.#persist();
          throw error;
        }
        const known = error instanceof BridgeError;
        const refused = known && error.status > 0;
        this.#replace(afterFailure(going, {
          nowMs: this.now(),
          error: known ? error.message : 'The machine did not confirm it.',
          refused,
          reachedMachine: known ? error.maybeDelivered : true,
          dedupes: dedupeCapable && !!going.sentTo,
        }));
        await this.#persist();
        // A dead link ends this pass; the next contact (or the backoff) tries again.
        if (known && error.code === 'unreachable') return;
      }
    }
  }
}
