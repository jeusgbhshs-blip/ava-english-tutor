import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { deflateSync, deflateRawSync } from 'node:zlib';
import {
  extractText, extractDocxZipText, extractOdtText, extractPptxText, extractPdfText, extractPdfContentText,
  readZip, MAX_TEXT_CHARS, MAX_UPLOAD_BYTES, MAX_ARCHIVE_ENTRY_BYTES,
} from '../lib/docExtract.js';
import { readBinaryUpload, withUploadedFile, uploadCapabilities } from '../lib/fileUpload.js';

function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.text || '');
    const payload = file.compressed ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(file.compressed ? 8 : 0, 8);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(file.declaredSize ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, payload);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(file.compressed ? 8 : 0, 10);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(file.declaredSize ?? data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const tail = Buffer.alloc(22);
  tail.writeUInt32LE(0x06054b50, 0);
  tail.writeUInt16LE(files.length, 8);
  tail.writeUInt16LE(files.length, 10);
  tail.writeUInt32LE(directory.length, 12);
  tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, tail]);
}

function request(chunks, headers = {}) {
  const req = Readable.from(chunks);
  req.headers = headers;
  return req;
}

const english = 'Learning English gives us new ways to connect with people and understand the world.';

test('100MB source limit is distinct from the visible teaching-text cap', async () => {
  assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024);
  const source = Buffer.alloc(13 * 1024 * 1024, 'A');
  const result = await extractText({ filename: 'large.tsv', buffer: source });
  assert.equal(result.chars, MAX_TEXT_CHARS);
  assert.equal(result.truncated, true);
  assert.match(result.warnings.join(' '), /60k/);
  assert.equal(uploadCapabilities().maxTextChars, MAX_TEXT_CHARS);
});

test('large image-heavy PDF imports its text without decoding embedded images', async () => {
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Subtype /Image >>\nstream\n'),
    Buffer.alloc(13 * 1024 * 1024, 0),
    Buffer.from(`\nendstream\nendobj\n2 0 obj\n<< /Length 100 >>\nstream\nBT (${english}) Tj ET\nendstream\nendobj\n%%EOF`),
  ]);
  const result = await extractText({ filename: 'illustrated-book.pdf', buffer: pdf });
  assert.equal(result.text, english);
  assert.equal(result.truncated, false);
});

test('DOCX reads only document XML and ignores oversized embedded media', () => {
  const source = zip([
    { name: 'word/media/photo.bin', text: 'unused', declaredSize: 200 * 1024 * 1024 },
    { name: 'word/document.xml', text: `<w:document><w:p><w:t>${english}</w:t></w:p></w:document>`, compressed: true },
  ]);
  assert.equal(extractDocxZipText(source), english);
});

test('ODT, HTML and TSV are portable document inputs', async () => {
  const odt = zip([{ name: 'content.xml', text: `<office:text><text:p>${english}</text:p></office:text>` }]);
  assert.equal(extractOdtText(odt), english);
  const extractedOdt = await extractText({ filename: 'lesson.odt', buffer: odt });
  assert.equal(extractedOdt.text, english);
  const html = await extractText({ filename: 'lesson.html', buffer: Buffer.from(`<script>do not import this code</script><p>${english}</p>`) });
  assert.equal(html.text, english);
  const tsv = await extractText({ filename: 'lesson.tsv', buffer: Buffer.from(english + '\tLesson one') });
  assert.ok(tsv.text.includes('Lesson one'));
});

test('PPTX slides keep numeric reading order', () => {
  const source = zip([
    { name: 'ppt/slides/slide10.xml', text: '<a:t>Tenth slide.</a:t>' },
    { name: 'ppt/slides/slide2.xml', text: '<a:t>Second slide.</a:t>' },
  ]);
  assert.equal(extractPptxText(source), 'Second slide.\n\nTenth slide.');
});

test('ZIP rejects declared and disguised decompression bombs', () => {
  assert.throws(() => readZip(zip([{ name: 'body', text: 'x', declaredSize: MAX_ARCHIVE_ENTRY_BYTES + 1 }])), /解压后的内容过大/);
  const dishonest = zip([{ name: 'body', text: 'x'.repeat(10000), declaredSize: 20, compressed: true }]);
  assert.throws(() => readZip(dishonest), /安全解压/);
  const truncated = zip([{ name: 'body', text: 'hello' }]).subarray(0, -4);
  assert.throws(() => readZip(truncated), /目录结构损坏/);
});

test('PDF rejects a compressed stream exceeding its extraction budget', () => {
  const bomb = deflateSync(Buffer.alloc(MAX_ARCHIVE_ENTRY_BYTES + 1, 65));
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n<< /Filter /FlateDecode >>\nstream\n'), bomb, Buffer.from('\nendstream\n%%EOF')]);
  assert.throws(() => extractPdfText(pdf), /单页内容过大/);
});

test('binary reader spools chunks, checks announced and actual sizes, and recovers', async () => {
  const source = Buffer.from(english);
  const result = await readBinaryUpload(request([source.subarray(0, 10), source.subarray(10)]), { limit: 1000 });
  assert.deepEqual(result, source);
  await assert.rejects(readBinaryUpload(request([], { 'content-length': '1001' }), { limit: 1000 }), (err) => err.status === 413);
  await assert.rejects(readBinaryUpload(request([Buffer.alloc(700), Buffer.alloc(400)]), { limit: 1000 }), (err) => err.status === 413);
  assert.deepEqual(await readBinaryUpload(request([source]), { limit: 1000 }), source);
});

test('file upload serializes extraction and releases its slot after failure', async () => {
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const pending = withUploadedFile(request([Buffer.from(english)], { 'content-type': 'application/octet-stream' }), new URL('http://local/api/kb/upload?name=book.txt'), null, async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    throw new Error('simulated extraction error');
  });
  await ready;
  await assert.rejects(withUploadedFile(request([]), new URL('http://local'), null, () => {}), (err) => err.status === 429);
  release();
  await assert.rejects(pending, /simulated extraction error/);
  const legacy = await withUploadedFile(request([]), new URL('http://local'), async () => ({ name: 'lesson.txt', dataBase64: Buffer.from(english).toString('base64') }), ({ buffer }) => buffer.toString());
  assert.equal(legacy, english);
  await assert.rejects(withUploadedFile(request([]), new URL('http://local'), async () => ({ name: 'bad.txt', dataBase64: '????' }), () => {}), /合法的 base64/);
});


test('PDF token scanning handles nested strings, hex arrays and damaged large arrays without backtracking', () => {
  assert.match(extractPdfContentText('BT (Hello (nested) world) Tj ET'), /Hello \(nested\) world/);
  assert.match(extractPdfContentText('BT [(Hello ) -20 <576f726c64>] TJ ET'), /Hello World/);
  assert.equal(extractPdfContentText('[' + '('.repeat(250000)), '');
});
