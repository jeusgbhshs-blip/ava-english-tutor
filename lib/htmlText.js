/** Linear, text-only HTML extraction. It never evaluates or returns markup. */
const EXCLUDED = new Set(['nav', 'header', 'footer', 'aside', 'form', 'script', 'style', 'noscript']);
const RAW_TEXT = new Set(['script', 'style', 'noscript']);
const LINE_ENDS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr']);

export function decodeHtmlEntities(html) {
  const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const codepoint = (number) => Number.isInteger(number) && number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
    ? String.fromCodePoint(number) : '\uFFFD';
  return String(html || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codepoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codepoint(Number(d)))
    .replace(/&([a-z]+);/gi, (match, key) => names[key.toLowerCase()] ?? match);
}

function tagEnd(source, start) {
  let quote = '';
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

function rawTextEnd(lower, tag, start) {
  const closing = `</${tag}`;
  let position = start;
  for (;;) {
    const index = lower.indexOf(closing, position);
    if (index < 0) return lower.length;
    const after = index + closing.length;
    if (/[\s/>]/.test(lower[after] || '>')) {
      const end = tagEnd(lower, after);
      return end < 0 ? lower.length : end + 1;
    }
    position = after;
  }
}

export function htmlTextOnly(html) {
  const source = String(html || '');
  const lower = source.toLowerCase();
  const pieces = [];
  let cursor = 0;
  let suppressed = '';
  let suppressedDepth = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) {
      if (!suppressed) pieces.push(source.slice(cursor));
      break;
    }
    if (!suppressed && start > cursor) pieces.push(source.slice(cursor, start));
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      cursor = end < 0 ? source.length : end + 3;
      if (!suppressed) pieces.push(' ');
      continue;
    }
    const end = tagEnd(source, start + 1);
    if (end < 0) break; // An incomplete tag is not document text.
    const token = source.slice(start + 1, end);
    const match = token.match(/^\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i);
    cursor = end + 1;
    if (!match) { if (!suppressed) pieces.push(' '); continue; }
    const closing = Boolean(match[1]);
    const tag = match[2].toLowerCase();
    if (!closing && RAW_TEXT.has(tag)) {
      cursor = rawTextEnd(lower, tag, cursor);
      if (!suppressed) pieces.push(' ');
      continue;
    }
    if (suppressed) {
      if (tag === suppressed) {
        if (closing) { if (--suppressedDepth === 0) { suppressed = ''; pieces.push(' '); } }
        else if (!/\/\s*$/.test(token)) suppressedDepth++;
      }
      continue;
    }
    if (!closing && EXCLUDED.has(tag) && !/\/\s*$/.test(token)) {
      suppressed = tag;
      suppressedDepth = 1;
      pieces.push(' ');
      continue;
    }
    pieces.push(tag === 'br' || (closing && LINE_ENDS.has(tag)) ? '\n' : ' ');
  }
  return decodeHtmlEntities(pieces.join(''))
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
