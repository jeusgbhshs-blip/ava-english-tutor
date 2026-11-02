/** Real HTTP upload contract; isolated data and no cloud/provider credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('HTTP uploads accept larger binary PDFs, advertise configured limits and preserve preview/legacy contracts', { timeout: 15000 }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'ava-large-upload-test-'));
  const appRoot = join(scratch, 'app');
  await mkdir(appRoot);
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });
  for (const entry of ['server.js', 'package.json', 'lib', 'content']) {
    await cp(join(root, entry), join(appRoot, entry), { recursive: true });
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AVA_')) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  env.AVA_DATA_DIR = join(scratch, 'data');
  env.AVA_MAX_UPLOAD_MB = '16';
  const child = spawn(process.execPath, [join(appRoot, 'server.js'), '--port', '0'], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  });
  let output = '';
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upload test server did not start')), 5000);
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/Ava ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
  const limitsResponse = await fetch(base + '/api/kb/upload-limits');
  const limits = await limitsResponse.json();
  assert.equal(limits.maxFileBytes, 16 * 1024 * 1024);
  assert.equal(limits.maxTextChars, 60000);
  assert.ok(limits.extensions.includes('.tsv'));
  const text = 'Learning English helps people explore new places and share their stories with others.';
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Subtype /Image >>\nstream\n'),
    Buffer.alloc(13 * 1024 * 1024),
    Buffer.from(`\nendstream\nendobj\n2 0 obj\n<< /Length 120 >>\nstream\nBT (${text}) Tj ET\nendstream\nendobj\n%%EOF`),
  ]);
  const upload = (name, body) => fetch(base + '/api/kb/upload?name=' + encodeURIComponent(name), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body,
  });
  const pdfResponse = await upload('英语资料.pdf', pdf);
  assert.equal(pdfResponse.status, 200);
  const document = await pdfResponse.json();
  assert.equal(document.ok, true);
  assert.equal(document.extracted.kind, 'pdf');
  assert.equal(document.extracted.truncated, false);
  const previewResponse = await fetch(base + '/api/kb/preview-file?name=preview.txt', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: text,
  });
  const preview = await previewResponse.json();
  assert.equal(preview.text, text);
  const beforeLegacy = await (await fetch(base + '/api/kb/list')).json();
  assert.equal(beforeLegacy.docs.length, 1, 'preview must not persist a second document');
  const legacyResponse = await fetch(base + '/api/kb/upload', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'legacy.txt', dataBase64: Buffer.from(text).toString('base64') }),
  });
  assert.equal(legacyResponse.status, 200);
  assert.equal((await legacyResponse.json()).ok, true);
  const largeLegacyDoc = await fetch(base + '/api/doc/upload', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'legacy-large.txt', dataBase64: Buffer.alloc(12 * 1024 * 1024 + 1, 65).toString('base64') }),
  });
  assert.equal(largeLegacyDoc.status, 400);
  assert.match((await largeLegacyDoc.json()).error, /太大.*12MB/);
  const overLimit = await upload('too-large.txt', Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  assert.equal(overLimit.status, 413);
  assert.match((await overLimit.json()).error, /16MB/);
  const unsupported = await upload('unsafe.exe', Buffer.from('binary'));
  assert.equal(unsupported.status, 400);
  const longText = await upload('long.tsv', Buffer.from('English practice is useful every day. '.repeat(3000)));
  const longDoc = await longText.json();
  assert.equal(longDoc.extracted.truncated, true);
  assert.equal(longDoc.extracted.chars, 60000);
  assert.match(longDoc.extracted.warnings.join(' '), /60k/);
});
