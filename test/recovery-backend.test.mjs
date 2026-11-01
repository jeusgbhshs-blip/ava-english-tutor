/** Recovery regressions. All provider calls use local mocks and fabricated keys. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { startMockVolc } from './mock-volc-realtime.mjs';
import { VolcRealtimeSession } from '../lib/volcRealtime.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const storedTextKey = 'fabricated-stored-text-key';
const suppliedTextKey = 'fabricated-supplied-text-key';
const storedVoiceKey = 'fabricated-stored-voice-key';
const storedVoiceToken = 'fabricated-stored-voice-token';
const suppliedVoiceToken = 'fabricated-supplied-voice-token';
let scratch;
let appRoot;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'ava-recovery-backend-'));
  appRoot = join(scratch, 'app');
  await mkdir(appRoot);
  for (const entry of ['server.js', 'package.json', 'lib', 'content']) {
    await cp(join(root, entry), join(appRoot, entry), { recursive: true });
  }
});
after(async () => { await rm(scratch, { recursive: true, force: true }); });

async function withDeadline(promise, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation timed out')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function startApp(t, { open = false, withoutLauncher = false, environment = {}, initialSettings } = {}) {
  const dataDir = await mkdtemp(join(scratch, 'data-'));
  if (initialSettings) await writeFile(join(dataDir, 'settings.json'), JSON.stringify(initialSettings));
  const env = { ...process.env };
  // The suite must never inherit a real provider credential or endpoint.
  for (const key of Object.keys(env)) if (key.startsWith('AVA_')) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, environment);
  env.AVA_DATA_DIR = dataDir;
  if (withoutLauncher) {
    env.PATH = join(scratch, 'empty-bin');
    await mkdir(env.PATH, { recursive: true });
  }
  const child = spawn(process.execPath, [join(appRoot, 'server.js'), '--port', '0', '--host', '127.0.0.1', ...(open ? ['--open'] : [])], {
    cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await withDeadline(exited, 2500).catch(async () => {
        child.kill('SIGKILL');
        await exited;
      });
    }
  });
  const url = await withDeadline(new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/Ava ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
  }));
  return { url, dataDir, child, logs: () => ({ output, stderr }) };
}

async function captureHttp(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [], choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function jsonRequest(app, path, { method = 'POST', body = {} } = {}) {
  const res = await fetch(app.url + path, {
    method, headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(3000),
  });
  return { status: res.status, data: await res.json() };
}
const saveSettings = (app, body) => jsonRequest(app, '/api/settings', { method: 'PUT', body });

async function rawRequest(app, host) {
  return await withDeadline(new Promise((resolve, reject) => {
    const request = http.request(app.url + '/api/health', { headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    request.on('error', reject);
    request.end();
  }));
}

test('malformed Host returns 400 and the same server remains healthy', async (t) => {
  const app = await startApp(t);
  assert.equal(await rawRequest(app, '['), 400);
  assert.equal((await jsonRequest(app, '/api/health', { method: 'GET' })).status, 200);
  assert.equal(app.child.exitCode, null);
});

test('--open keeps the server alive when no browser launcher is installed', async (t) => {
  const app = await startApp(t, { open: true, withoutLauncher: true });
  // Observe the async spawn error before verifying the service stayed alive.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(app.child.exitCode, null, app.logs().stderr);
  assert.equal((await jsonRequest(app, '/api/health', { method: 'GET' })).status, 200);
});

test('text connection test binds stored keys to the configured origin', async (t) => {
  const original = await captureHttp(t);
  const other = await captureHttp(t);
  const app = await startApp(t);
  assert.equal((await saveSettings(app, { baseUrl: original.url + '/v1', apiKey: storedTextKey })).status, 200);
  const blocked = await jsonRequest(app, '/api/settings/test', { body: { baseUrl: other.url + '/v1' } });
  assert.equal(blocked.status, 400);
  assert.equal(other.requests.length, 0, 'a changed origin must receive no request with the stored key');
  const sameOrigin = await jsonRequest(app, '/api/settings/test', { body: { baseUrl: original.url + '/compatible/v1' } });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.data.ok, true);
  assert.equal(original.requests.at(-1).authorization, `Bearer ${storedTextKey}`);
  const explicit = await jsonRequest(app, '/api/settings/test', { body: { baseUrl: other.url + '/v1', apiKey: suppliedTextKey } });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.data.ok, true);
  assert.equal(other.requests.at(-1).authorization, `Bearer ${suppliedTextKey}`);
  const invalid = await jsonRequest(app, '/api/settings/test', { body: { baseUrl: 'file:///not-a-provider', apiKey: suppliedTextKey } });
  assert.equal(invalid.status, 400);
});

test('saving a new text origin requires a new key or explicit clear, closing the PUT then test bypass', async (t) => {
  const original = await captureHttp(t);
  const other = await captureHttp(t);
  const app = await startApp(t);
  await saveSettings(app, { baseUrl: original.url + '/v1', apiKey: storedTextKey });
  const blocked = await saveSettings(app, { baseUrl: other.url + '/v1' });
  assert.equal(blocked.status, 400);
  const unchanged = await jsonRequest(app, '/api/settings', { method: 'GET' });
  assert.equal(unchanged.data.baseUrl, original.url + '/v1');
  await jsonRequest(app, '/api/settings/test');
  assert.equal(other.requests.length, 0);
  assert.equal(original.requests.at(-1).authorization, `Bearer ${storedTextKey}`);
  assert.equal((await saveSettings(app, { baseUrl: original.url + '/another-path' })).status, 200);
  const changed = await saveSettings(app, { baseUrl: other.url + '/v1', apiKey: suppliedTextKey });
  assert.equal(changed.status, 200);
  await jsonRequest(app, '/api/settings/test');
  assert.equal(other.requests.at(-1).authorization, `Bearer ${suppliedTextKey}`);
  const cleared = await saveSettings(app, { baseUrl: original.url + '/v2', clearKey: true });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.hasKey, false);
  const before = original.requests.length;
  const noKey = await jsonRequest(app, '/api/settings/test');
  assert.equal(noKey.data.ok, false);
  assert.equal(original.requests.length, before);
  const stored = JSON.parse(await readFile(join(app.dataDir, 'settings.json'), 'utf8'));
  assert.equal(stored.apiKey, '');
});

test('voice connection test requires explicit credentials for a different origin and drops stored alternatives', async (t) => {
  const original = await startMockVolc();
  const other = await startMockVolc();
  t.after(() => original.close());
  t.after(() => other.close());
  const app = await startApp(t);
  await saveSettings(app, { volc: { appId: 'local-test-app', endpoint: original.wsUrl, apiKey: storedVoiceKey, accessToken: storedVoiceToken } });
  const blocked = await jsonRequest(app, '/api/volc/test', { body: { endpoint: other.wsUrl } });
  assert.equal(blocked.status, 400);
  assert.equal(other.connections.length, 0);
  const explicit = await jsonRequest(app, '/api/volc/test', { body: { endpoint: other.wsUrl, accessToken: suppliedVoiceToken } });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.data.ok, true);
  assert.equal(other.connections.at(-1).headers['x-api-key'], undefined);
  assert.equal(other.connections.at(-1).headers['x-api-access-key'], suppliedVoiceToken);
  const sameOrigin = await jsonRequest(app, '/api/volc/test', { body: { endpoint: original.wsUrl } });
  assert.equal(sameOrigin.data.ok, true);
  assert.equal(original.connections.at(-1).headers['x-api-key'], storedVoiceKey);
});

test('saving a new voice origin never carries an old API key or alternate access token', async (t) => {
  const original = await startMockVolc();
  const other = await startMockVolc();
  t.after(() => original.close());
  t.after(() => other.close());
  const app = await startApp(t);
  await saveSettings(app, { volc: { appId: 'local-test-app', endpoint: original.wsUrl, apiKey: storedVoiceKey, accessToken: storedVoiceToken } });
  assert.equal((await saveSettings(app, { volc: { endpoint: other.wsUrl } })).status, 400);
  const unchanged = JSON.parse(await readFile(join(app.dataDir, 'settings.json'), 'utf8'));
  assert.equal(unchanged.volc.endpoint, original.wsUrl);
  const changed = await saveSettings(app, { volc: { endpoint: other.wsUrl, accessToken: suppliedVoiceToken } });
  assert.equal(changed.status, 200);
  const stored = JSON.parse(await readFile(join(app.dataDir, 'settings.json'), 'utf8'));
  assert.equal(stored.volc.apiKey, '');
  assert.equal(stored.volc.accessToken, suppliedVoiceToken);
  const checked = await jsonRequest(app, '/api/volc/test');
  assert.equal(checked.data.ok, true);
  assert.equal(other.connections.at(-1).headers['x-api-key'], undefined);
  assert.equal(other.connections.at(-1).headers['x-api-access-key'], suppliedVoiceToken);
  const cleared = await saveSettings(app, { volc: { endpoint: original.wsUrl, clearKey: true } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.volc.hasKey, false);
  const empty = JSON.parse(await readFile(join(app.dataDir, 'settings.json'), 'utf8'));
  assert.equal(empty.volc.apiKey, '');
  assert.equal(empty.volc.accessToken, '');
});

test('an environment text key cannot be rebound by saving a new origin with a different key or clear', async (t) => {
  const original = await captureHttp(t);
  const other = await captureHttp(t);
  const app = await startApp(t, {
    initialSettings: { baseUrl: original.url + '/v1' },
    environment: { AVA_API_KEY: storedTextKey },
  });
  assert.equal((await saveSettings(app, { baseUrl: other.url + '/v1', apiKey: suppliedTextKey })).status, 400);
  assert.equal((await saveSettings(app, { baseUrl: other.url + '/v1', clearKey: true })).status, 400);
  assert.equal((await saveSettings(app, { baseUrl: original.url + '/compatible/v1' })).status, 200);
  assert.equal((await jsonRequest(app, '/api/settings/test')).data.ok, true);
  assert.equal(other.requests.length, 0);
  assert.equal(original.requests.at(-1).authorization, `Bearer ${storedTextKey}`);
});

test('environment voice credentials cannot revive on a new saved origin', async (t) => {
  const original = await startMockVolc();
  const other = await startMockVolc();
  t.after(() => original.close());
  t.after(() => other.close());
  const app = await startApp(t, {
    initialSettings: { volc: { appId: 'local-test-app', endpoint: original.wsUrl } },
    environment: { AVA_VOLC_ACCESS_TOKEN: storedVoiceToken },
  });
  assert.equal((await saveSettings(app, { volc: { endpoint: other.wsUrl, apiKey: storedVoiceKey } })).status, 400);
  assert.equal((await saveSettings(app, { volc: { endpoint: other.wsUrl, clearKey: true } })).status, 400);
  assert.equal((await jsonRequest(app, '/api/volc/test')).data.ok, true);
  assert.equal(other.connections.length, 0);
  assert.equal(original.connections.at(-1).headers['x-api-access-key'], storedVoiceToken);
});

for (const event of ['error', 'close']) {
  test(`assistant settles a pending ${event} once and can answer the next request`, async (t) => {
    const { assistantReply } = await import(pathToFileURL(join(root, 'lib/assistant.js')).href + `?recovery=${event}`);
    const sessions = [];
    const callbackErrors = [];
    let failing = true;
    t.mock.method(VolcRealtimeSession.prototype, 'connect', async function () {
      this.ready = true;
      sessions.push(this);
      return true;
    });
    t.mock.method(VolcRealtimeSession.prototype, 'sendTextQuery', function () {
      queueMicrotask(() => {
        try {
          if (failing) {
            if (event === 'error') this.handlers.onError(new Error('fabricated upstream failure'));
            this.handlers.onClose('fabricated close');
            this.handlers.onClose('duplicate close');
          } else {
            // A late close from the old session must not cancel this new turn.
            sessions[0].handlers.onClose('late old-session close');
            this.handlers.onChat({ text: '已经恢复，可以继续。', final: false });
            this.handlers.onChat({ text: '', final: true });
          }
        } catch (error) { callbackErrors.push(error); }
      });
      return true;
    });
    const settings = { volc: { appId: 'local-test-app', apiKey: storedVoiceKey, endpoint: 'ws://127.0.0.1:1/never-connect' } };
    const pending = assistantReply({ message: '你好', settings });
    let first;
    try { first = await withDeadline(pending, 500); }
    finally {
      // Also release the old implementation's waiter after a failed regression.
      sessions[0]?.handlers.onChat({ text: '', final: true });
    }
    assert.equal(callbackErrors.length, 0);
    assert.equal(first.demo, true);
    failing = false;
    const next = await withDeadline(assistantReply({ message: '你好', settings }), 500);
    assert.equal(next.demo, false);
    assert.equal(next.reply, '已经恢复，可以继续。');
  });
}

test('summary vocabulary updates preserve learned status and SRS scheduling; defaults apply only to new words', async (t) => {
  const isolated = await mkdtemp(join(scratch, 'review-'));
  await cp(join(root, 'lib'), join(isolated, 'lib'), { recursive: true });
  await cp(join(root, 'package.json'), join(isolated, 'package.json'));
  // config.js derives a fresh data directory from the isolated module root.
  const inheritedDataDir = process.env.AVA_DATA_DIR;
  delete process.env.AVA_DATA_DIR;
  t.after(() => {
    if (inheritedDataDir === undefined) delete process.env.AVA_DATA_DIR;
    else process.env.AVA_DATA_DIR = inheritedDataDir;
  });
  const review = await import(pathToFileURL(join(isolated, 'lib/review.js')).href);
  review.upsertWords([{ word: 'journey', meaning: '旧释义' }]);
  review.updateWord('journey', { status: 'known' });
  const before = review.getWord('journey');
  review.syncFromSummary([{ word: 'journey', meaning: '旅程' }, { word: 'destination', meaning: '目的地' }]);
  const after = review.getWord('journey');
  for (const key of ['status', 'due', 'interval', 'ease', 'reps', 'lapses', 'lastGrade']) assert.equal(after[key], before[key], key);
  assert.equal(after.meaning, '旅程');
  assert.equal(review.getWord('destination').status, 'new');
  review.upsertWords([{ word: 'journey', status: 'learning' }]);
  assert.equal(review.getWord('journey').status, 'learning', 'an explicit status edit must still work');
});
