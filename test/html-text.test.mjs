import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlTextOnly, decodeHtmlEntities } from '../lib/htmlText.js';
import { htmlToText } from '../lib/kb.js';
import { extractHtmlText } from '../lib/docExtract.js';

test('HTML tokenizer removes executable/hidden/navigation blocks and preserves readable breaks/entities', () => {
  const html = '<!DOCTYPE html><html><head><style>.private{display:none}</style><script>const x="<p>secret</p>";</script></head><body><header>Header</header><nav><nav>Nested</nav>Navigation</nav><p>Hello &amp; welcome.</p><div>Learn<br>English &lt;safely&gt;.</div><form>Private form</form><noscript>Hidden alternative</noscript><footer>Footer</footer></body></html>';
  assert.equal(htmlTextOnly(html), 'Hello & welcome.\n Learn\nEnglish <safely>.'.replace('\n ', '\n'));
});

test('webpage and uploaded HTML use the same plain-text extraction rules', () => {
  const source = '<p title="a > b">One &quot;quoted&quot; lesson.</p><!-- comment --><p>Line two &#65; &#x42; &nbsp; C.</p>';
  assert.equal(htmlToText(source), extractHtmlText(Buffer.from(source)));
  assert.match(htmlToText(source), /One "quoted" lesson\./);
  assert.match(htmlToText(source), /Line two A B C\./);
});

test('malformed repeated script/tag openings terminate without regex backtracking', { timeout: 1000 }, () => {
  assert.equal(htmlTextOnly('<script>'.repeat(50000)), '');
  assert.equal(htmlTextOnly('<'.repeat(500000)), '');
  assert.equal(htmlTextOnly('<p>Visible lesson</p><script>never closed'), 'Visible lesson');
  assert.equal(htmlTextOnly('<style>' + '</stylex>'.repeat(30000)), '');
});

test('invalid numeric character references are replaced without throwing', () => {
  assert.equal(decodeHtmlEntities('&#x110000; &#55296; &#0; &#65; &nbsp;'), '\uFFFD \uFFFD \uFFFD A  ');
});
