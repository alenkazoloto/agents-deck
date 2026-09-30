// Durable state: the paired session and the last fleet snapshot, in IndexedDB.
//
// IndexedDB rather than localStorage because a service worker (M4's push renderer) reads the
// snapshot too, and localStorage is not visible there. The origin is shared with every other
// GitHub Pages project of the account (plan P3), so nothing is stored that is not needed: the
// token, the machine's origin and name, and the last fleet. Unpairing clears all of it.

/** Opened transcripts kept for the offline view (plan: last 20). */
export const TRANSCRIPT_CACHE = 20;

const DB = 'agents-deck';
const STORE = 'kv';

/** @returns {Promise<IDBDatabase>} */
function open(idb) {
  return new Promise((resolve, reject) => {
    const request = idb.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** A key-value backend over IndexedDB. Any object with async get/set/delete/clear can stand in for tests. */
export function idbBackend(idb = globalThis.indexedDB) {
  const run = async (mode, fn) => {
    const db = await open(idb);
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)),
    delete: (key) => run('readwrite', (s) => s.delete(key)),
    clear: () => run('readwrite', (s) => s.clear()),
  };
}

export function memoryBackend() {
  const map = new Map();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => { map.set(k, v); },
    delete: async (k) => { map.delete(k); },
    clear: async () => { map.clear(); },
  };
}

export class Store {
  constructor(backend) {
    this.backend = backend;
  }

  /** `{origin, token, deviceId, machine}` or null. */
  async session() {
    const s = await this.backend.get('session');
    return s && s.origin && s.token ? s : null;
  }

  saveSession(session) {
    return this.backend.set('session', session);
  }

  /** `{fleet, receivedAtMs}` — the last snapshot, kept for the offline "as of" view. */
  async snapshot() {
    return (await this.backend.get('snapshot')) ?? null;
  }

  saveSnapshot(fleet, receivedAtMs) {
    return this.backend.set('snapshot', { fleet, receivedAtMs });
  }

  /** Prompts owed to the machine ([Outbox]); survive a closed page and a revoked token. */
  async outbox() {
    return (await this.backend.get('outbox')) ?? [];
  }

  saveOutbox(items) {
    return this.backend.set('outbox', items);
  }

  /** The unsent words of one conversation's message box, or ''. */
  async draft(key) {
    return (await this.backend.get('drafts'))?.[key] ?? '';
  }

  async saveDraft(key, text) {
    const drafts = { ...((await this.backend.get('drafts')) ?? {}) };
    if (text) drafts[key] = text;
    else delete drafts[key];
    return this.backend.set('drafts', drafts);
  }

  /** `{report, receivedAtMs, agent, account}` — the last Usage screen read, kept for the offline "as of" view. */
  async usage() {
    return (await this.backend.get('usage')) ?? null;
  }

  saveUsage(usage) {
    return this.backend.set('usage', usage);
  }

  /** The Scheduled screen's last list, `{list, receivedAtMs}`, so it opens stamped while the machine is away. */
  async scheduled() {
    return (await this.backend.get('scheduled')) ?? null;
  }

  saveScheduled(scheduled) {
    return this.backend.set('scheduled', scheduled);
  }

  /** The last transcripts opened, newest first: `{key, page, receivedAtMs}`. */
  async transcripts() {
    return (await this.backend.get('transcripts')) ?? [];
  }

  async transcript(key) {
    return (await this.transcripts()).find((t) => t.key === key) ?? null;
  }

  async saveTranscript(key, page, receivedAtMs) {
    const rest = (await this.transcripts()).filter((t) => t.key !== key);
    return this.backend.set('transcripts', [{ key, page, receivedAtMs }, ...rest].slice(0, TRANSCRIPT_CACHE));
  }

  /** `{endpoint}` of the push subscription this browser registered with the machine, or null. */
  async push() {
    return (await this.backend.get('push')) ?? null;
  }

  savePush(registered) {
    return registered ? this.backend.set('push', registered) : this.backend.delete('push');
  }

  /** Unpair: nothing of this machine stays in the browser. */
  clear() {
    return this.backend.clear();
  }

  /**
   * A revoked token: the machine is forgotten, but what the reader typed is not — the drafts and the
   * prompts still owed come back when they pair again (CLAUDE.md: drafts survive a failed submission).
   */
  async clearKeepingWords() {
    const outbox = await this.outbox();
    const drafts = (await this.backend.get('drafts')) ?? {};
    await this.backend.clear();
    if (outbox.length) await this.backend.set('outbox', outbox);
    if (Object.keys(drafts).length) await this.backend.set('drafts', drafts);
  }
}
