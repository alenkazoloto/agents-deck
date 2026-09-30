// `cond && h(...)` is how the views leave a piece out, so `false` (and null) are children to skip —
// appending them would print the word "false" into the page.
//
// Server text (titles, branches, machine names) is only ever assigned as text nodes: a title is
// whatever a conversation was called, and this origin holds a token.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
