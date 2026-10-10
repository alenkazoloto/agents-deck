// The SSE line grammar and the rules for redialling — pure, so the interesting cases (a keep-alive
// comment, a frame split across chunks, two evictions in a minute) are asked as questions.

/** `MobileProtocol.Stream.CLIENT_WATCHDOG_MS`: three missed 15 s keep-alives. */
export const WATCHDOG_MS = 45_000;

/**
 * Incremental parser mirroring the phone's `SseReader`. [feed] takes decoded text in any chunking
 * and returns the frames completed by it; [onAlive] fires per line (comments included), because an
 * idle machine sends nothing but `: keep-alive` for minutes and that is what proves the socket lives.
 */
export class SseParser {
  #buffer = '';
  #id = null;
  #event = null;
  #data = [];

  constructor(onAlive = () => {}) {
    this.onAlive = onAlive;
  }

  feed(text) {
    this.#buffer += text;
    const frames = [];
    let at;
    while ((at = this.#buffer.indexOf('\n')) >= 0) {
      let line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.onAlive();
      if (line === '') {
        if (this.#event !== null || this.#data.length) {
          frames.push({ id: this.#id, event: this.#event, data: this.#data.join('\n') });
        }
        this.#event = null;
        this.#data = [];
      } else if (line.startsWith('id:')) {
        this.#id = line.slice(3).trim();
      } else if (line.startsWith('event:')) {
        this.#event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const v = line.slice(5);
        this.#data.push(v.startsWith(' ') ? v.slice(1) : v);
      }
      // ':' comments and unknown fields carry no frame — but they did carry a line.
    }
    return frames;
  }
}

/**
 * When to redial. Backoff doubles from 1 s to 30 s and resets once a stream has delivered a frame.
 * The bridge keeps at most three streams per machine and evicts the oldest with a `bye`, so two
 * `bye`s inside a minute means another device is fighting for the slot: rather than trade the slot
 * back and forth, fall back to polling `/v1/fleet` and try the stream again later.
 */
export class ReconnectPolicy {
  static BASE_MS = 1_000;
  static MAX_MS = 30_000;
  static EVICTIONS_BEFORE_POLLING = 2;
  static EVICTION_WINDOW_MS = 60_000;
  static POLL_MS = 30_000;
  /** How long polling lasts before the stream is tried again. */
  static POLL_SPELL_MS = 5 * 60_000;

  #failures = 0;
  #evictions = [];
  #pollingUntil = 0;

  /** A stream delivered a frame: the link is good. */
  onFrame() {
    this.#failures = 0;
  }

  /** The stream could not be opened, or died without a `bye`. */
  onFailure() {
    this.#failures += 1;
    return { action: 'retry', delayMs: this.backoffMs() };
  }

  /** The machine said `bye`: evicted for a newer stream, or shutting down. */
  onBye(nowMs) {
    this.#evictions = this.#evictions.filter((t) => nowMs - t < ReconnectPolicy.EVICTION_WINDOW_MS);
    this.#evictions.push(nowMs);
    if (this.#evictions.length >= ReconnectPolicy.EVICTIONS_BEFORE_POLLING) {
      this.#evictions = [];
      this.#pollingUntil = nowMs + ReconnectPolicy.POLL_SPELL_MS;
      return { action: 'poll', intervalMs: ReconnectPolicy.POLL_MS, untilMs: this.#pollingUntil };
    }
    return { action: 'retry', delayMs: ReconnectPolicy.BASE_MS };
  }

  backoffMs() {
    return Math.min(ReconnectPolicy.MAX_MS, ReconnectPolicy.BASE_MS * 2 ** Math.max(0, this.#failures - 1));
  }
}
