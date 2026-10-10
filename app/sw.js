// Cache the shell only; bridge data uses stamped IndexedDB snapshots.
// publish-site.sh replaces 32cbdc9495c4 with the shipped-file hash to invalidate old caches.
const CACHE = 'agents-deck-shell-32cbdc9495c4';
const SHELL = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/app.js', 'js/bridge.js', 'js/conversation.js', 'js/deck.js', 'js/dom.js', 'js/folders.js', 'js/format.js', 'js/markdown.js', 'js/newchat.js', 'js/outbox.js',
  'js/push.js', 'js/review.js', 'js/scheduled.js', 'js/search.js', 'js/sse.js', 'js/store.js', 'js/usage.js', 'js/wire.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('agents-deck-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Cache first, refreshed behind: the shell opens with no network, and the next open has the update.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const fresh = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      });
      if (cached) {
        fresh.catch(() => {});
        return cached;
      }
      try {
        return await fresh;
      } catch (error) {
        if (request.mode === 'navigate') return (await cache.match('index.html')) ?? Promise.reject(error);
        throw error;
      }
    }),
  );
});

// ---- web push ---------------------------------------------------------------------------------
//
// The push body names no conversation title (the machine sends only a trigger, opaque keys and a
// count), so the words come from the last fleet the page stored. A push must always end in a
// visible notification: iOS revokes the subscription of a worker that receives one and shows
// nothing, so every path below reaches showNotification, with a generic sentence when the payload
// or the snapshot cannot be read.

const SENTENCES = {
  'needs-you': { one: 'Needs you', many: (n) => `${n} agents need you`, generic: 'A run needs you' },
  failed: { one: 'Run failed', many: (n) => `${n} runs failed`, generic: 'A run failed' },
  finished: { one: 'Run finished', many: (n) => `${n} runs finished`, generic: 'A run finished' },
};

/** What the page stored in IndexedDB (`agents-deck` › `kv` › [key]), or undefined when it cannot be read. */
function readKey(key) {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('agents-deck', 1);
      open.onerror = () => resolve(undefined);
      // The page owns the schema. Opening a database it has not created yet must not create it empty here,
      // or the page's own open (same version) would never get its upgrade and every write would fail.
      open.onupgradeneeded = () => open.transaction.abort();
      open.onsuccess = () => {
        const db = open.result;
        try {
          const get = db.transaction('kv', 'readonly').objectStore('kv').get(key);
          get.onsuccess = () => { db.close(); resolve(get.result); };
          get.onerror = () => { db.close(); resolve(undefined); };
        } catch {
          db.close();
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}

/** The last fleet the page stored, or null. */
async function readSnapshot() {
  return (await readKey('snapshot'))?.fleet ?? null;
}

/** Stores [value] under [key] in the page's database; false when the page never created it or the write failed. */
function writeKey(key, value) {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('agents-deck', 1);
      open.onerror = () => resolve(false);
      open.onupgradeneeded = () => open.transaction.abort();
      open.onsuccess = () => {
        const db = open.result;
        try {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(value, key);
          tx.oncomplete = () => { db.close(); resolve(true); };
          tx.onerror = tx.onabort = () => { db.close(); resolve(false); };
        } catch {
          db.close();
          resolve(false);
        }
      };
    } catch {
      resolve(false);
    }
  });
}

/** `{title, body, tag, key}` for a decoded payload and the stored fleet; never throws, never empty. */
function describePush(payload, fleet) {
  if (payload?.trigger === 'plan-usage' && payload.usage) {
    return { title: `Plan usage at ${payload.usage.percent}%`, body: payload.usage.resetText || '', tag: 'plan-usage', key: null };
  }
  const sentence = SENTENCES[payload?.trigger];
  if (!sentence) return { title: 'Agents Deck', body: 'Something needs a look.', tag: 'agents-deck', key: null };
  const rows = new Map((fleet?.rows ?? []).map((r) => [r.key, r]));
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  const titles = keys.map((k) => rows.get(k)?.title).filter(Boolean);
  const total = Math.max(payload.waiting || 0, keys.length);
  if (total > 1) return { title: sentence.many(total), body: titles.join(' · '), tag: payload.trigger, key: null };
  return { title: titles.length ? sentence.one : sentence.generic, body: titles[0] ?? '', tag: payload.trigger, key: keys[0] ?? null };
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = null;
    try { payload = event.data?.json() ?? null; } catch { /* undecodable: the generic sentence below */ }
    const shown = describePush(payload, await readSnapshot());
    // One notification per trigger, replaced rather than stacked; renotify so a replacement still buzzes.
    await self.registration.showNotification(shown.title, {
      body: shown.body, tag: shown.tag, renotify: true,
      icon: 'icons/icon-192.png', data: { key: shown.key },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const key = event.notification.data?.key ?? null;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => w.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      // The page owns its router: it turns this into `#c=<key>` (or the fleet list for no key).
      open.postMessage({ type: 'open-conversation', key });
      return;
    }
    await self.clients.openWindow(key ? `./#c=${encodeURIComponent(key)}` : './');
  })());
});

// ---- a rotated push endpoint ------------------------------------------------------------------
//
// The push service can replace a subscription while the app is closed. The page re-sends the endpoint
// on its next open (`Push.sync`); this does it at once, so the machine is not pushing into a void until
// then. It only ever completes what the reader already turned on: with no stored push registration or
// no paired machine it does nothing, and it never prompts.

/** `js/wire.js` PROTOCOL_VERSION; sw.test.js fails when the two drift. */
const PROTOCOL_VERSION = 1;

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const [session, registered] = await Promise.all([readKey('session'), readKey('push')]);
      if (!session?.origin || !session.token || !registered) return;
      // The browser may already have made the new subscription; otherwise renew with the old one's options.
      let subscription = event.newSubscription ?? await self.registration.pushManager.getSubscription();
      if (!subscription) {
        const key = event.oldSubscription?.options?.applicationServerKey;
        if (!key) return;
        subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      if (subscription.endpoint === registered.endpoint) return;
      const json = subscription.toJSON();
      const response = await fetch(session.origin + '/v1/push/register', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ v: PROTOCOL_VERSION, endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth }),
        cache: 'no-store',
        credentials: 'omit',
      });
      // A refusal or an unreachable machine leaves the stored endpoint stale on purpose: `Push.sync` compares it on open.
      if (response.ok) await writeKey('push', { endpoint: subscription.endpoint });
    } catch {
      // Same: the next open re-registers.
    }
  })());
});
