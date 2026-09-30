// Small presentation helpers, pure.

/** "14:32" in the reader's locale, from a machine timestamp. */
export function clock(ms, locale) {
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** How long before [nowMs] a row moved. Both sides are the machine's clock (the snapshot's stamp). */
export function ago(ms, nowMs) {
  if (!ms || !nowMs) return '';
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "840", "12.4K", "3.1M" — a token count at a glance. */
export function tokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
