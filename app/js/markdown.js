// Just enough Markdown for an assistant's answer: fenced code blocks, paragraphs and `inline code`.
//
// Parsed to plain data and rendered by the view with text nodes only. There is no HTML path at all —
// this origin holds a token, and the text is whatever a model or a web page put in a conversation —
// so anything richer (links, images, tables) would have to earn its way in through the same door.

/** @returns {{type:'code', lang:string, text:string}|{type:'p', parts:{code:boolean, text:string}[]}} blocks */
export function blocks(source) {
  const out = [];
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  let prose = [];
  const flush = () => {
    const text = prose.join('\n').trim();
    prose = [];
    if (!text) return;
    for (const paragraph of text.split(/\n{2,}/)) out.push({ type: 'p', parts: inline(paragraph) });
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,})\s*([^\s`]*)/.exec(lines[i]);
    if (!open) { prose.push(lines[i]); continue; }
    flush();
    const body = [];
    let j = i + 1;
    const close = new RegExp(`^ {0,3}\`{${open[1].length},}\\s*$`);
    while (j < lines.length && !close.test(lines[j])) body.push(lines[j++]);
    out.push({ type: 'code', lang: open[2], text: body.join('\n') });
    i = j; // an unterminated fence runs to the end of the text, as CommonMark reads it
  }
  flush();
  return out;
}

function inline(text) {
  const parts = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}
