// The search box's second half: chats whose *messages* hold the query, asked of the machine
// (`/v1/session-search`) after the title search has answered in the browser. A port of the
// Android client's `MessageSearch`, so both clients page, resume and word it alike.
//
// A search is `{query, keys, hits, scanned, nextCursor, searching, timedOut, error}`: [keys] are the
// chats asked about, newest first; [nextCursor] indexes where the next page starts, null once every
// key was looked at.

import { SEARCH_PAGE_FILES } from './wire.js';

export const newSearch = (query, keys) =>
  ({ query, keys, hits: [], scanned: 0, nextCursor: 0, searching: true, timedOut: false, error: null });

export const complete = (s) => s.nextCursor === null && !s.searching && !s.error;

/** The keys the next page asks about — one page, never the whole list (the body cap). */
export const pageKeys = (s) => (s.nextCursor === null ? [] : s.keys.slice(s.nextCursor, s.nextCursor + SEARCH_PAGE_FILES));

/**
 * [s], still answering [keys] for [query] — or null when it is a different search.
 *
 * Fleet frames re-sort a running chat and move one between title hit and not with its live line,
 * and restarting on each would keep a search on a busy machine from ever finishing, so a dropped
 * key changes nothing ([visibleHits] hides its hit). A chat never asked about joins the end of the
 * list rather than restarting the pages already read; a finished search becomes resumable to read it.
 */
export function continuedWith(s, query, keys) {
  if (s.query !== query) return null;
  const known = new Set(s.keys);
  const added = keys.filter((k) => !known.has(k));
  if (!added.length) return s;
  return { ...s, keys: [...s.keys, ...added], nextCursor: s.nextCursor ?? s.keys.length };
}

export function visibleHits(s, keys) {
  const wanted = new Set(keys);
  return s.hits.filter((h) => wanted.has(h.key));
}

/** The page asked from [start] folded in. A hit already listed stays where it is. */
export function plus(s, start, page) {
  const known = new Set(s.hits.map((h) => h.key));
  const next = start + page.examined;
  return {
    ...s,
    hits: [...s.hits, ...page.hits.filter((h) => !known.has(h.key) && known.add(h.key))],
    scanned: s.scanned + page.scanned,
    nextCursor: next < s.keys.length ? next : null,
    searching: false,
    timedOut: page.timedOut,
    error: null,
  };
}

/** The status sentence and the button beside it, if any (`messageSearchStatus` on Android). */
export function searchStatus(s, hits) {
  const chats = s.scanned === 1 ? '1 chat' : `${s.scanned} chats`;
  if (s.searching) return { text: s.scanned === 0 ? 'Searching messages…' : 'Searching older chats…', action: null };
  if (s.error) return { text: s.error, action: 'Retry' };
  // Cut off inside the last chat: nothing left to continue with, and not a clean "no match".
  if (s.timedOut && s.nextCursor === null) return { text: `Messages searched in ${chats}; one was too long to finish`, action: null };
  if (s.timedOut) return { text: `The machine stopped after reading messages in ${chats}`, action: 'Continue' };
  if (s.nextCursor !== null) {
    return { text: s.scanned === 1 ? 'Messages searched in the newest chat' : `Messages searched in the ${s.scanned} newest chats`, action: 'Search older chats' };
  }
  return { text: hits === 0 ? `No messages match in ${chats}` : `Messages searched in ${chats}`, action: null };
}
