// Web push, the browser's half: subscribe with the machine's application-server key, hand the
// subscription to `/v1/push/register`, and take it back on "Turn off" or unpair.
//
// Nothing here prompts by itself. `enable` runs on the reader's tap, because iOS only shows the
// permission dialog from a gesture in an installed app and a page that asks unprompted is one the
// reader learns to refuse. The notification itself is drawn by sw.js from the cached fleet — the
// push body carries no titles.

import { PROTOCOL_VERSION } from './wire.js';

/** A push step failed for a reason the browser (not the machine) gave. */
export class PushError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PushError';
    this.code = code;
  }
}

/** The machine's VAPID key (base64url, unpadded) as the bytes `subscribe` wants. */
export function applicationServerKey(vapid) {
  const standard = vapid.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Whether a subscription's stored key is [key], so a machine whose key changed gets a fresh one. */
export function sameKey(stored, key) {
  if (!stored) return false;
  const bytes = new Uint8Array(stored);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

/** `/v1/push/register`'s body from a `PushSubscription` (or its `toJSON()`), flattened as the machine reads it. */
export function subscriptionBody(subscription) {
  const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
  return { v: PROTOCOL_VERSION, endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth };
}

/**
 * ready — this browser can subscribe now. needs-install — an iPhone tab: web push exists only for a
 * Home-Screen app there, and the reader has to know why the button is missing. unsupported — nothing to offer.
 */
export function supportOf({ serviceWorker, pushManager, notification, ios, standalone }) {
  if (ios && !standalone) return 'needs-install';
  return serviceWorker && pushManager && notification ? 'ready' : 'unsupported';
}

/** The environment of a real page; tests pass a stand-in. */
export function browserEnv(win = globalThis) {
  const nav = win.navigator ?? {};
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  return {
    support: supportOf({
      serviceWorker: 'serviceWorker' in nav, pushManager: 'PushManager' in win, notification: 'Notification' in win,
      ios, standalone: nav.standalone === true || win.matchMedia?.('(display-mode: standalone)').matches === true,
    }),
    permission: () => win.Notification?.permission ?? 'denied',
    requestPermission: () => win.Notification.requestPermission(),
    registration: () => nav.serviceWorker.ready,
  };
}

export class Push {
  /** @param {ReturnType<typeof browserEnv>} env @param {import('./store.js').Store} store */
  constructor(env, store) {
    this.env = env;
    this.store = store;
  }

  /** Whether this machine offers push at all: the capability is only advertised while its owner has it on. */
  static offered(hello) {
    return !!hello && hello.capabilities.includes('push') && !!hello.vapid;
  }

  async #subscription() {
    return (await this.env.registration()).pushManager.getSubscription();
  }

  /** `{support, permission, subscribed}` — subscribed means this browser is registered with the machine. */
  async status() {
    const { support } = this.env;
    if (support !== 'ready') return { support, permission: 'default', subscribed: false };
    const permission = this.env.permission();
    const registered = await this.store.push();
    const subscribed = permission === 'granted' && !!registered && !!(await this.#subscription().catch(() => null));
    return { support, permission, subscribed };
  }

  /**
   * On the reader's tap. Returns `'denied'` or `'dismissed'` when the permission dialog did not end
   * in a yes; throws [PushError] when the browser would not subscribe and lets the bridge's own
   * refusal (`push-disabled`, unreachable, revoked) through.
   */
  async enable(bridge, hello) {
    if (this.env.support !== 'ready') throw new PushError('unsupported', 'This browser cannot receive notifications.');
    // The permission call comes first: anything awaited before it can cost iOS the gesture.
    const permission = await this.env.requestPermission();
    if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'dismissed';
    const key = applicationServerKey(hello.vapid);
    let subscription;
    try {
      const { pushManager } = await this.env.registration();
      subscription = await pushManager.getSubscription();
      if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (error) {
      throw new PushError('subscribe-failed', error?.message ?? 'The browser would not subscribe.');
    }
    await bridge.pushRegister(subscriptionBody(subscription));
    await this.store.savePush({ endpoint: subscription.endpoint });
    return 'subscribed';
  }

  /**
   * Called each time the machine answers. A push service can rotate an endpoint while the app is
   * closed, and a machine that keeps the old one pushes into a void, so the registered endpoint is
   * compared and re-sent when it moved. Never prompts; a revoked permission just forgets the flag.
   */
  async sync(bridge, hello) {
    const registered = await this.store.push();
    if (!registered || this.env.support !== 'ready') return;
    if (this.env.permission() !== 'granted' || !Push.offered(hello)) return;
    let subscription = await this.#subscription();
    if (!subscription) {
      const { pushManager } = await this.env.registration();
      subscription = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(hello.vapid) });
    }
    if (subscription.endpoint === registered.endpoint) return;
    await bridge.pushRegister(subscriptionBody(subscription));
    await this.store.savePush({ endpoint: subscription.endpoint });
  }

  /** "Turn off": the machine is asked to forget, and the browser's subscription goes even if it cannot be reached. */
  async disable(bridge) {
    try {
      await bridge.pushUnregister();
    } catch {
      // Unreachable: the machine's next push to this dead endpoint gets a 410 and it forgets it.
    }
    await this.forget();
  }

  /** Unpair or a revoked token: the browser drops its subscription; the machine already dropped the device. */
  async forget() {
    try {
      await (await this.#subscription())?.unsubscribe();
    } catch {
      // Nothing to release, or the browser already did.
    }
    await this.store.savePush(null);
  }
}
