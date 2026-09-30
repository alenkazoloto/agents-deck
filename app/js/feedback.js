// The composer's review-feedback chips, behind `review-feedback-chips`: one per file of notes the
// message carries, as the desk's `ReviewFeedbackChips` paints them — an attached batch's files
// while its `@review-notes:` token is in the draft, feedback that was not delivered (or whose
// delivery is unknown) until retried or removed. The phone app's `ReviewFeedbackChips`.
// The list is the one `notes.js` reads; every answer it adopts repaints the chips too.

import { h } from './dom.js';
import { BASELINE } from './notes.js';

export const chipsOffered = (capabilities, key) => !!capabilities?.includes('review-feedback-chips') && !key.startsWith('acp:');

const TOKEN = /@review-notes:\S+/g;

/** The `@review-notes:` tokens in [draft] (the phone's `ReviewNotesFlow.tokens`). */
export const tokensIn = (draft) => new Set((draft ?? '').match(TOKEN) ?? []);

/** [draft] without [token] and the space before it; null when it is not there (`ReviewNotesFlow.withoutToken`). */
export const withoutToken = (draft, token) => {
  if (!(draft ?? '').includes(token)) return null;
  return draft.split(` ${token}`).join('').split(token).join('').trimEnd();
};

export const retryable = (chip) => chip.state !== 'attached';

/** The chips over [draft], as the desk chooses them: undelivered feedback always, an attached batch while its token is typed. */
export const chipsFor = (data, draft) => {
  const typed = tokensIn(draft);
  return (data?.chips ?? []).filter((c) => retryable(c) || typed.has(c.token));
};

/** "Settings.kt · 2 notes · not delivered": the desk chip's words, with the file's name for a narrow screen. */
export const chipLabel = (chip) => {
  const n = chip.notes.length;
  const status = chip.state === 'failed' ? ' · not delivered' : chip.state === 'unknown' ? ' · delivery unknown' : '';
  return `${chip.path.slice(chip.path.lastIndexOf('/') + 1) || chip.path} · ${n} ${n === 1 ? 'note' : 'notes'}${status}`;
};

const same = (a, b) => !!a && !!b && a.batchId === b.batchId && a.path === b.path;

/**
 * The open chat's chips, kept by the deck in `open.feedback`: `{data, busy, reading}`, [reading]
 * the chip whose notes are shown. Writes go through [deps.notes], so a lost answer's operation id
 * is the one the Changes panel's writes also reuse.
 */
export class FeedbackChips {
  /**
   * @param {object} deps
   * @param {()=>({key:string, draft:string, feedback:object|null})|null} deps.current the open chat, while chips are offered
   * @param {(key:string, patch:object)=>void} deps.patch merges into that chat's `feedback`
   * @param {import('./notes.js').ReviewNotes} deps.notes reads and writes the list
   * @param {(error:any)=>boolean} deps.failed a revoked token or a dropped pairing handled: true when handled
   * @param {(error:any)=>string} deps.describe
   * @param {(key:string, message:string)=>void} deps.say
   * @param {(key:string, token:string, message:string)=>Promise<void>} deps.attached a retry's token joins the draft
   * @param {(key:string, draft:string)=>Promise<void>} deps.rewrite the deck writes [key]'s draft (the view drops its mirror)
   */
  constructor(deps) {
    this.deps = deps;
    /** Reads collapse into one follow-up, as the page's do: a burst of `run` frames costs two. */
    this.reading = false;
    this.again = false;
  }

  #open(key) {
    const c = this.deps.current();
    return c?.key === key ? c : null;
  }

  /** On opening the chat, and whenever a run moves: that is when a send's feedback turns delivered or failed. */
  async load() {
    const c = this.deps.current();
    if (!c) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    try {
      await this.deps.notes.read(c.key);
    } finally {
      this.reading = false;
      if (this.again) { this.again = false; this.load(); }
    }
  }

  /** Every list the machine answered, from a read or any note write, Changes open or not. */
  adopted(key, data) {
    const c = this.#open(key);
    if (!c) return;
    const reading = c.feedback?.reading;
    this.deps.patch(key, { data, reading: reading && data.chips.find((chip) => same(chip, reading)) || null });
  }

  show(chip) {
    const c = this.deps.current();
    if (c) this.deps.patch(c.key, { reading: chip });
  }

  hide() {
    const c = this.deps.current();
    if (c?.feedback?.reading) this.deps.patch(c.key, { reading: null });
  }

  /** Undelivered feedback goes back into the message, to be sent again. */
  retry(chip) {
    return this.#busy({ op: 'retry', batchId: chip.batchId }, async (key, answer) => {
      if (!answer.token) return this.deps.say(key, 'The machine attached nothing. Update the plugin, or retry the feedback in the IDE.');
      await this.deps.attached(key, answer.token, 'Review feedback is back in the message. Send it to try again.');
    });
  }

  /** ✕: that file's notes leave the feedback and stay saved; the batch's last file takes its token out of the draft. */
  remove(chip) {
    return this.#busy({ op: 'detach-file', batchId: chip.batchId, path: chip.path }, async (key, answer) => {
      if (answer.chips.some((c) => c.batchId === chip.batchId)) return;
      const c = this.#open(key);
      const draft = c && withoutToken(c.draft, chip.token);
      if (draft !== null && draft !== undefined) await this.deps.rewrite(key, draft);
    });
  }

  /**
   * The reader edited [key]'s draft: an attached batch whose token they erased is detached on the
   * machine, as the desk's draft listener detaches it, so the desk does not put it back into its
   * own composer. A send clears the draft by another path; its batch is staged, not detached.
   */
  draftEdited(key, before, after) {
    const c = this.#open(key);
    if (!c?.feedback?.data) return;
    const kept = tokensIn(after);
    const erased = [...tokensIn(before)].filter((t) => !kept.has(t));
    if (erased.length === 0) return;
    const batches = new Set(c.feedback.data.chips.filter((chip) => erased.includes(chip.token) && !retryable(chip)).map((chip) => chip.batchId));
    for (const batchId of batches) {
      this.deps.notes.writeFeedback(key, { op: 'detach', batchId }).catch((error) => {
        if (!this.deps.failed(error)) this.deps.say(key, this.deps.describe(error));
      });
    }
  }

  async #busy(request, done) {
    const c = this.deps.current();
    if (!c?.feedback || c.feedback.busy) return;
    const { key } = c;
    this.deps.patch(key, { busy: true });
    let answer;
    try {
      answer = await this.deps.notes.writeFeedback(key, request);
    } catch (error) {
      if (this.deps.failed(error)) return;
      if (this.#open(key)) this.deps.patch(key, { busy: false });
      return this.deps.say(key, this.deps.describe(error));
    }
    if (this.#open(key)) this.deps.patch(key, { busy: false });
    await done(key, answer);
  }
}

// ---- views ------------------------------------------------------------------------------------

const lines = (note) => (note.startLine === note.endLine ? `Line ${note.startLine}` : `Lines ${note.startLine}–${note.endLine}`);

/** Above the message box: the chips, wrapped rather than scrolled, and the notes of the one opened. */
export function feedbackChipsView(open, deck) {
  const feedback = open.feedback;
  const chips = chipsFor(feedback?.data, open.draft);
  if (chips.length === 0) return null;
  const busy = feedback.busy;
  const reading = feedback.reading;
  return h('div', { class: 'feedback' },
    h('div', { class: 'feedback-chips', role: 'group', 'aria-label': 'Review feedback in this message' }, chips.map((chip) => {
      const label = chipLabel(chip);
      return h('span', { class: `feedback-chip${retryable(chip) ? ' undelivered' : ''}` },
        h('button', { class: 'link', title: chip.path, 'aria-label': `Show the review notes: ${label}`, 'aria-expanded': same(chip, reading) ? 'true' : 'false',
          onclick: () => (same(chip, reading) ? deck.feedback.hide() : deck.feedback.show(chip)) }, label),
        retryable(chip) && h('button', { class: 'link icon', disabled: busy, title: 'Retry saved review feedback', 'aria-label': `Retry saved review feedback: ${label}`,
          onclick: () => deck.feedback.retry(chip) }, '↻'),
        h('button', { class: 'link icon', disabled: busy, title: "Remove this file's review feedback from the message", 'aria-label': `Remove this file's review feedback from the message: ${label}`,
          onclick: () => deck.feedback.remove(chip) }, '✕'));
    })),
    reading && chips.some((chip) => same(chip, reading)) && h('div', { class: 'feedback-notes', role: 'group', 'aria-label': `Review notes: ${reading.path}` },
      h('h3', {}, reading.path),
      reading.notes.map((note) => h('div', { class: 'feedback-note' },
        h('div', { class: 'dim' }, lines(note) + (note.side === BASELINE ? ' · before the chat' : '')),
        note.quote && h('pre', { class: 'quote dim' }, note.quote),
        h('p', { class: 'body' }, note.body))),
      h('button', { class: 'link', onclick: () => deck.feedback.hide() }, 'Close')));
}
