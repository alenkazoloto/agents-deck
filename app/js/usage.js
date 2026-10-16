// The Usage screen: every account's plan windows, then what the machine has spent. Pure view over
// `Deck.state.usage`; the filters go back through the deck.

import { h } from './dom.js';
import { clock, tokens } from './format.js';
import { money } from './wire.js';

const VENDORS = { CLAUDE: 'Claude', CODEX: 'Codex' };
const vendorName = (v) => VENDORS[v] ?? v;

// `style-src 'self'` refuses a `style` attribute but not CSSOM, so sizes are set as properties.
const sized = (el, prop, pct) => { el.style[prop] = `${pct}%`; return el; };

const spent = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;

// A plan caps several windows on separate clocks; each is its own row, never one blended percentage.
function windowView(w) {
  const pct = Math.max(0, Math.min(100, w.percent));
  return h('li', { class: `window${w.reached ? ' reached' : ''}` },
    h('div', { class: 'line' }, h('span', {}, w.label), h('span', {}, w.reached ? 'Limit reached' : `${pct}% used`)),
    h('div', { class: 'meter', role: 'img', 'aria-label': `${w.label}: ${pct}% used` }, sized(h('span'), 'width', pct)),
    w.resetText && h('div', { class: 'dim' }, `Resets ${w.resetText}`));
}

function accountView(a, both) {
  return h('section', { class: 'account' },
    h('div', { class: 'title' }, a.label, both && a.label !== vendorName(a.vendor) && h('span', { class: 'dim' }, ` · ${vendorName(a.vendor)}`), a.active && h('span', { class: 'dim' }, ' · in use')),
    a.windows.length ? h('ul', {}, a.windows.map(windowView)) : h('p', { class: 'dim' }, a.note || 'No plan limits reported for this account.'));
}

const figureRow = (name, usage, detail) => h('li', { class: 'figure' },
  h('div', { class: 'line' }, h('span', { class: 'name' }, name), h('span', { class: 'cost' }, money(usage))),
  h('div', { class: 'dim' }, [detail, spent(usage) > 0 && `${tokens(spent(usage))} tokens`].filter(Boolean).join(' · ')));

// The desk's 14-day chart as bars; a day with no spend is a zero bar, not a gap.
function daysView(days) {
  const top = Math.max(...days.map((d) => d.usage.costUsd), 0);
  if (top <= 0) return null;
  return h('div', { class: 'days', role: 'img', 'aria-label': `Daily cost, last ${days.length} days` },
    days.map((d) => sized(h('span', { class: 'bar', title: `${d.day} — ${money(d.usage)}` }),
      'height', Math.max(d.usage.costUsd > 0 ? 3 : 0, Math.round((d.usage.costUsd / top) * 100)))));
}

function filtersView(usage, deck) {
  const { filter } = usage.report;
  const select = (label, all, options, value, pick) => {
    const el = h('select', { 'aria-label': label, onchange: (e) => pick(e.target.value || undefined) },
      h('option', { value: '' }, all),
      options.map((o) => h('option', { value: o.value }, o.label)));
    el.value = value ?? '';
    return el;
  };
  return h('div', { class: 'row filters' },
    filter.agents.length > 0 && select('Agent', 'All agents', filter.agents.map((v) => ({ value: v, label: vendorName(v) })), usage.agent,
      (agent) => deck.filterUsage({ agent, account: usage.account })),
    filter.accounts.length > 0 && select('Account', 'All accounts', filter.accounts.map((a) => ({ value: a.id, label: a.label })), usage.account,
      (account) => deck.filterUsage({ agent: usage.agent, account })));
}

/** @param {object} state Deck state with `usage` set @param {import('./deck.js').Deck} deck @param {{back:()=>void}} nav */
export function usageView(state, deck, nav) {
  const { usage } = state;
  const report = usage.report;
  const machine = state.session?.machine || 'your machine';
  const fresh = usage.receivedAtMs && !usage.loading && !usage.notice && state.reachable;
  const both = new Set(report?.accounts.map((a) => a.vendor)).size > 1;
  return h('div', { class: 'usage' },
    h('header', {},
      h('button', { class: 'link', onclick: nav.back, 'aria-label': 'Back to conversations' }, '‹ Back'),
      h('h1', {}, 'Usage'),
      h('span', { class: 'pill' }, usage.loading ? 'Loading…' : usage.receivedAtMs ? `as of ${clock(usage.receivedAtMs)}` : 'not connected')),
    !state.reachable && h('div', { class: 'banner', role: 'status' }, `Can't reach ${machine} — is Tailscale on?`),
    usage.notice && h('div', { class: 'banner', role: 'alert' }, usage.notice),
    !report && h('p', { class: 'dim empty' }, usage.loading ? 'Loading…' : 'Nothing saved yet — connect once to see usage.'),
    report?.indexing && fresh && h('div', { class: 'banner', role: 'status' }, `${machine} is still reading its transcripts; these totals will grow.`),
    report && (report.filter.agents.length > 0 || report.filter.accounts.length > 0) && filtersView(usage, deck),
    report?.accounts.length > 0 && h('section', {}, h('h2', {}, 'Plan limits'), report.accounts.map((a) => accountView(a, both))),
    report?.caps.length > 0 && h('ul', {}, report.caps.map((c) => h('li', { class: 'figure' },
      h('div', { class: 'line' }, h('span', { class: 'name' }, c.title), h('span', { class: 'cost' }, c.value)),
      c.detail && h('div', { class: 'dim' }, c.detail)))),
    report?.cards.length > 0 && h('section', {}, h('h2', {}, 'Spend'), h('ul', {}, report.cards.map((c) => figureRow(c.label, c.usage)))),
    report?.days.some((d) => d.usage.costUsd > 0) && h('section', {}, h('h2', {}, `Daily cost, last ${report.days.length} days`), daysView(report.days)),
    report?.models.length > 0 && h('section', {}, h('h2', {}, 'By model'), h('ul', {}, report.models.map((m) => figureRow(m.label, m.usage)))),
    report?.projects.length > 0 && h('section', {}, h('h2', {}, 'By project'),
      h('ul', {}, report.projects.map((p) => figureRow(p.name, p.usage, p.sessions === 1 ? '1 conversation' : `${p.sessions} conversations`)))));
}
