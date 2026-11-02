/** Native/backend access regressions. Only local transports and fabricated tokens. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { createAccessControl, assertSafeBinding } from '../lib/access.js'
import { apiFetch, apiUrl, apiWebSocketUrl, configureBackend, normalizeBackendOrigin } from '../web/js/backend.js'
import { installScopedStorage } from '../web/js/scoped-storage.js'

const TOKEN = 'fabricated-ava-installation-token-1234567890'
const NATIVE_ORIGIN = 'capacitor://localhost'

function request({ path = '/api/settings', method = 'GET', origin, auth, host = 'ava.example', headers = {} } = {}) {
  return { url: path, method, headers: { host, ...(origin ? { origin } : {}), ...(auth ? { authorization: auth } : {}), ...headers } }
}
function response() {
  const res = { headers: {}, status: null, body: '', ended: false }
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value }
  res.writeHead = (status, headers) => { res.status = status; for (const [key, value] of Object.entries(headers || {})) res.setHeader(key, value) }
  res.end = value => { res.body = value || ''; res.ended = true }
  return res
}
function handle(control, options) {
  const req = request(options)
  const res = response()
  const handled = control.handle(req, res, new URL(req.url, 'https://ava.example'))
  return { req, res, handled, json: res.body ? JSON.parse(res.body) : null }
}
function issue(control, origin = NATIVE_ORIGIN) {
  const result = handle(control, { path: '/api/access/ws-ticket', method: 'POST', origin, auth: `Bearer ${TOKEN}` })
  assert.equal(result.res.status, 200)
  return result.json.ticket
}
function globalValue(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name] })
}

test('access: remote binding requires an access token; short tokens are refused', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.3']) assert.throws(() => assertSafeBinding(host, ''), /AVA_ACCESS_TOKEN/)
  assert.throws(() => assertSafeBinding('127.0.0.1', 'short'), /32/)
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.doesNotThrow(() => assertSafeBinding(host, ''))
  assert.doesNotThrow(() => assertSafeBinding('0.0.0.0', TOKEN))
  assert.doesNotThrow(() => assertSafeBinding('0.0.0.0', '', true))
})

test('access: unauthenticated reads and mutations fail before reaching the API', () => {
  const control = createAccessControl({ token: TOKEN })
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const result = handle(control, { method, origin: NATIVE_ORIGIN })
    assert.equal(result.handled, true)
    assert.equal(result.res.status, 401)
    assert.equal(result.res.headers['access-control-allow-origin'], NATIVE_ORIGIN)
  }
  for (const auth of ['Basic anything', `Bearer ${TOKEN.slice(1)}`, `Bearer ${'x'.repeat(TOKEN.length)}`]) {
    assert.equal(handle(control, { auth }).res.status, 401)
  }
  assert.equal(handle(control, { auth: `Bearer ${TOKEN}` }).handled, false)
  assert.equal(handle(control, { origin: NATIVE_ORIGIN, auth: `Bearer ${TOKEN}` }).handled, false)
})

test('access: status is public but health and credentials remain authenticated', () => {
  const control = createAccessControl({ token: TOKEN })
  const status = handle(control, { path: '/api/access/status' })
  assert.deepEqual(status.json, { ok: true, authenticationRequired: true })
  assert.equal(status.res.headers['cache-control'], 'no-store')
  for (const path of ['/api/health', '/api/settings', '/api/access/ws-ticket']) {
    assert.equal(handle(control, { path, method: path.endsWith('ticket') ? 'POST' : 'GET' }).res.status, 401)
  }
})

test('access: only allowed origins get CORS headers, including failure responses', () => {
  const control = createAccessControl({ token: TOKEN, allowedOrigins: ['https://approved.example'] })
  for (const origin of [NATIVE_ORIGIN, 'https://ava.example', 'https://approved.example']) {
    const result = handle(control, { origin, auth: `Bearer ${TOKEN}` })
    assert.equal(result.handled, false)
    assert.equal(result.res.headers['access-control-allow-origin'], origin)
    assert.equal(result.res.headers.vary, 'Origin')
  }
  for (const origin of ['https://attacker.example', 'null', 'https://ava.example.attacker.example']) {
    const result = handle(control, { origin, auth: `Bearer ${TOKEN}` })
    assert.equal(result.res.status, 403)
    assert.equal(result.res.headers['access-control-allow-origin'], undefined)
  }
})

test('access: preflight accepts supported native headers and rejects extra headers/methods', () => {
  const control = createAccessControl({ token: TOKEN })
  const options = { method: 'OPTIONS', origin: NATIVE_ORIGIN,
    headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } }
  const result = handle(control, options)
  assert.equal(result.res.status, 204)
  assert.match(result.res.headers['access-control-allow-headers'], /Authorization/)
  assert.equal(handle(control, { ...options, headers: { ...options.headers, 'access-control-request-headers': 'x-custom-secret' } }).res.status, 403)
  assert.equal(handle(control, { ...options, headers: { ...options.headers, 'access-control-request-method': 'TRACE' } }).res.status, 403)
})

test('access: WebSocket tickets are one-use and the long-lived token is never accepted in the URL', () => {
  const control = createAccessControl({ token: TOKEN })
  const ticket = issue(control)
  assert.notEqual(ticket, TOKEN)
  const req = request({ path: `/ws/voice?ticket=${ticket}`, origin: NATIVE_ORIGIN })
  assert.equal(control.authorizeWebSocket(req), true)
  assert.equal(control.authorizeWebSocket(req), false)
  for (const path of [`/ws/voice?token=${TOKEN}`, `/ws/voice?ticket=${TOKEN}`, '/ws/voice']) {
    assert.equal(control.authorizeWebSocket(request({ path, origin: NATIVE_ORIGIN, auth: `Bearer ${TOKEN}` })), false)
  }
})

test('access: tickets expire at thirty seconds and cannot be replayed from another origin', () => {
  let clock = 1000
  const control = createAccessControl({ token: TOKEN, now: () => clock, allowedOrigins: ['https://approved.example'] })
  const expired = issue(control)
  clock += 30_000
  assert.equal(control.authorizeWebSocket(request({ path: `/ws/voice?ticket=${expired}`, origin: NATIVE_ORIGIN })), false)
  const bound = issue(control)
  const path = `/ws/voice?ticket=${bound}`
  assert.equal(control.authorizeWebSocket(request({ path, origin: 'https://approved.example' })), false)
  assert.equal(control.authorizeWebSocket(request({ path })), false)
  assert.equal(control.authorizeWebSocket(request({ path, origin: NATIVE_ORIGIN })), true)
})

test('access: unauthenticated local use remains usable while cross-origin API and WS are refused', () => {
  const control = createAccessControl({ token: '', allowedOrigins: [] })
  const local = { host: '127.0.0.1:5180', origin: 'http://127.0.0.1:5180' }
  assert.equal(handle(control, local).handled, false)
  assert.equal(control.authorizeWebSocket(request({ ...local, path: '/ws/voice' })), true)
  assert.equal(handle(control, { ...local, origin: 'https://attacker.example' }).res.status, 403)
  assert.equal(control.authorizeWebSocket(request({ ...local, path: '/ws/voice', origin: 'https://attacker.example' })), false)
})

test('backend: service origins require HTTPS without credentials, query, path or fragment', () => {
  assert.equal(normalizeBackendOrigin(' https://ava.example/ '), 'https://ava.example')
  for (const input of ['http://ava.example', 'https://user:pass@ava.example', 'https://ava.example/path', 'https://ava.example?x=1', 'https://ava.example#secret', 'javascript:alert(1)', '//ava.example']) {
    assert.throws(() => normalizeBackendOrigin(input))
  }
  assert.equal(normalizeBackendOrigin('http://127.0.0.1:5180', { allowLocalHttp: true }), 'http://127.0.0.1:5180')
  assert.throws(() => normalizeBackendOrigin('http://192.168.1.10', { allowLocalHttp: true }))
})

test('backend: bearer credentials go only to the configured origin and prohibit redirects', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return new Response('{}') })
  configureBackend({ origin: 'https://ava.example', token: TOKEN })
  t.after(() => configureBackend())
  await apiFetch('/api/settings', { headers: { 'Content-Type': 'application/json' }, redirect: 'follow' })
  assert.equal(calls[0].url, 'https://ava.example/api/settings')
  assert.equal(calls[0].init.headers.get('Authorization'), `Bearer ${TOKEN}`)
  assert.equal(calls[0].init.headers.get('Content-Type'), 'application/json')
  assert.equal(calls[0].init.redirect, 'error')
  await apiFetch('https://external.example/file')
  assert.equal(calls[1].init.headers.has('Authorization'), false)
  for (const path of ['//external.example/file', 'relative/api']) assert.throws(() => apiUrl(path))
})

test('backend: native API calls fail before networking when no service was configured', (t) => {
  globalValue(t, 'Capacitor', { isNativePlatform: () => true })
  configureBackend()
  assert.throws(() => apiFetch('/api/settings'), /连接/)
})

test('backend: ordinary web retains relative HTTP calls and immediate same-origin WebSocket URLs', async (t) => {
  configureBackend()
  globalValue(t, 'location', { href: 'https://ava.example/mobile', origin: 'https://ava.example' })
  let captured
  t.mock.method(globalThis, 'fetch', async (url, init) => { captured = { url, init }; return new Response('{}') })
  await apiFetch('/api/health')
  assert.equal(captured.url, '/api/health')
  assert.equal(captured.init.headers.has('Authorization'), false)
  assert.equal(apiWebSocketUrl('/ws/voice'), 'wss://ava.example/ws/voice')
})

test('backend: native WebSocket URLs contain only short-lived tickets and preserve the HTTPS host', async (t) => {
  configureBackend({ origin: 'https://ava.example', token: TOKEN })
  t.after(() => configureBackend())
  let captured
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    captured = { url, init }
    return Response.json({ ticket: 'fabricated-one-use-ticket' })
  })
  const url = await apiWebSocketUrl('/ws/voice')
  assert.equal(captured.url, 'https://ava.example/api/access/ws-ticket')
  assert.equal(captured.init.headers.get('Authorization'), `Bearer ${TOKEN}`)
  assert.equal(url, 'wss://ava.example/ws/voice?ticket=fabricated-one-use-ticket')
  assert.equal(url.includes(TOKEN), false)
  assert.throws(() => apiWebSocketUrl('https://attacker.example/ws/voice'))
})

async function deadline(promise, ms = 5000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms) })]).finally(() => clearTimeout(timer))
}
async function startApp(t) {
  const data = await mkdtemp(join(tmpdir(), 'ava-native-access-test-'))
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('AVA_')) delete env[name]
  delete env.NODE_TEST_CONTEXT
  Object.assign(env, { AVA_DATA_DIR: data, AVA_ACCESS_TOKEN: TOKEN })
  const child = spawn(process.execPath, ['server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await deadline(exited, 2500).catch(async () => { child.kill('SIGKILL'); await exited })
    }
    await rm(data, { recursive: true, force: true })
  })
  return deadline(new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk
      const match = stdout.match(/Ava ready at (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) resolve(match[1])
    })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`server exited ${code}: ${stderr}`)))
  }))
}
async function handshake(base, path, origin) {
  const url = new URL(base)
  const socket = createConnection({ host: url.hostname, port: Number(url.port) })
  try {
    const result = new Promise((resolve, reject) => {
      socket.on('error', reject)
      socket.on('connect', () => socket.write([
        `GET ${path} HTTP/1.1`, `Host: ${url.host}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: ZmFicmljYXRlZC1rZXkhIQ==',
        `Origin: ${origin}`, '', '',
      ].join('\r\n')))
      socket.once('data', data => resolve(data.toString().split('\r\n')[0]))
    })
    return await deadline(result)
  } finally { socket.destroy() }
}

test('server integration: private API rejects missing tokens and accepts native preflight/auth', async (t) => {
  const base = await startApp(t)
  const status = await fetch(base + '/api/access/status')
  assert.equal((await status.json()).authenticationRequired, true)
  for (const method of ['GET', 'POST']) {
    const res = await fetch(base + '/api/settings', { method, headers: { Origin: NATIVE_ORIGIN, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), NATIVE_ORIGIN)
  }
  const preflight = await fetch(base + '/api/settings', { method: 'OPTIONS', headers: { Origin: NATIVE_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } })
  assert.equal(preflight.status, 204)
  const health = await fetch(base + '/api/health', { headers: { Origin: NATIVE_ORIGIN, Authorization: `Bearer ${TOKEN}` } })
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)
  const blocked = await fetch(base + '/api/settings', { headers: { Origin: 'https://attacker.example', Authorization: `Bearer ${TOKEN}` } })
  assert.equal(blocked.status, 403)
})

test('server integration: raw WebSocket upgrade requires a single-use origin-bound ticket', async (t) => {
  const base = await startApp(t)
  assert.match(await handshake(base, '/ws/voice', NATIVE_ORIGIN), /401/)
  const ticketResponse = await fetch(base + '/api/access/ws-ticket', { method: 'POST', headers: { Origin: NATIVE_ORIGIN, Authorization: `Bearer ${TOKEN}` } })
  const { ticket } = await ticketResponse.json()
  assert.ok(ticket)
  const path = `/ws/voice?ticket=${ticket}`
  assert.match(await handshake(base, path, 'https://attacker.example'), /401/)
  assert.match(await handshake(base, path, NATIVE_ORIGIN), /101/)
  assert.match(await handshake(base, path, NATIVE_ORIGIN), /401/)
})


test('access: local unauthenticated mode rejects DNS-rebinding Host headers even with matching or absent Origin', () => {
  const control = createAccessControl({ token: '', allowedOrigins: [], allowInsecureLan: false })
  for (const origin of [undefined, 'http://attacker.example']) {
    const hostile = { host: 'attacker.example', origin }
    assert.equal(handle(control, hostile).res.status, 403)
    assert.equal(control.authorizeWebSocket(request({ ...hostile, path: '/ws/voice' })), false)
  }
  for (const host of ['localhost:5180', '127.0.0.1:5180', '[::1]:5180']) {
    assert.equal(handle(control, { host }).handled, false)
  }
  const explicitlyShared = createAccessControl({ token: '', allowedOrigins: [], allowInsecureLan: true })
  assert.equal(handle(explicitlyShared, { host: '192.168.1.5:5180', origin: 'http://192.168.1.5:5180' }).handled, false)
})


async function bootstrapHarness({ native = false, secureStore = null, initialConnection = null, storageWindow = null } = {}) {
  const code = (await readFile(new URL('../web/js/native-bootstrap.js', import.meta.url), 'utf8'))
    .replace(/^import .*\n/gm, '')
    .replace('import.meta.url', JSON.stringify('https://ava.example/js/native-bootstrap.js?entry=mobile'))
    .replace("await import('./main.js')", "await __importEntry('settings')")
    .replace("await import('./mobile/app.js')", "await __importEntry('mobile')")
    .split('\nstart().catch(')[0]
  const seen = { configured: [], stored: [], panels: [], requests: [], reloaded: 0, scoped: [], imported: [] }
  const fields = { origin: { value: '' }, token: { value: '' }, consent: { checked: false } }
  const events = {}
  const submit = { disabled: false }
  const cancel = { disabled: false, addEventListener: (_, handler) => { events.cancelClick = handler } }
  const disconnect = { disabled: false, addEventListener: (_, handler) => { events.disconnect = handler } }
  const form = { elements: fields, reportValidity: () => true, addEventListener: (_, handler) => { events.submit = handler } }
  const error = { textContent: '' }
  const panel = {
    removed: false, closed: false, setAttribute() {}, showModal() {},
    close() { this.closed = true }, remove() { this.removed = true },
    addEventListener: (event, handler) => { events[event] = handler },
    querySelector: selector => selector === 'form' ? form : selector === '[role=status]' ? error : selector === '[type=submit]' ? submit : selector === '.ava-connection-cancel' ? cancel : selector === '.ava-connection-disconnect' && native && initialConnection ? disconnect : null,
  }
  let resolveHealth
  const storage = new Map()
  const window = storageWindow || { localStorage: {
    get length() { return storage.size }, key: i => [...storage.keys()][i] ?? null,
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: key => storage.delete(key), clear: () => storage.clear(),
  } }
  const context = vm.createContext({
    URL, AbortSignal, console, window, initialConnection,
    installScopedStorage: (target, origin) => { seen.scoped.push(origin); return installScopedStorage(target, origin) },
    __importEntry: async entry => { seen.imported.push({ entry, storage: window.localStorage }) },
    isNativeApp: () => native,
    normalizeBackendOrigin,
    configureBackend: value => seen.configured.push(value),
    apiFetch: (url, options) => new Promise(resolve => { seen.requests.push({ url, options }); resolveHealth = resolve }),
    fetch: (url, options) => new Promise(resolve => { seen.requests.push({ url, options }); resolveHealth = resolve }),
    Capacitor: secureStore ? { registerPlugin: () => secureStore } : {},
    location: { origin: 'https://ava.example', href: 'https://ava.example/mobile', reload: () => seen.reloaded++ },
    sessionStorage: { getItem: () => null, setItem: (key, value) => seen.stored.push({ key, value }) },
    document: { createElement: () => panel, body: { append: item => seen.panels.push(item) }, addEventListener() {} },
  })
  vm.runInContext(code + '\nconnection = initialConnection; this.subject = { connectionPanel, savedConnection, start };', context)
  return { ...context.subject, fields, events, submit, cancel, disconnect, error, panel, seen, window,
    respond: (result = { ok: true, json: async () => ({ ok: true }) }) => resolveHealth(result) }
}

test('bootstrap: Cancel cannot dismiss a connection while verification and secure persistence are pending', async () => {
  const h = await bootstrapHarness()
  const finished = h.connectionPanel()
  h.fields.token.value = TOKEN
  const submission = h.events.submit({ preventDefault() {} })
  assert.equal(h.submit.disabled, true)
  assert.equal(h.seen.configured.length, 0, 'verification must not change the backend used by the running app')
  assert.equal(h.seen.requests[0].url, 'https://ava.example/api/health')
  assert.equal(h.seen.requests[0].options.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(h.seen.requests[0].options.redirect, 'error')
  h.events.cancelClick()
  assert.equal(h.panel.closed, false)
  assert.equal(h.panel.removed, false)
  h.respond()
  await submission
  assert.equal(await finished, true)
  assert.equal(h.seen.stored.length, 1)
  assert.equal(h.seen.configured.length, 1)
  assert.equal(h.seen.configured[0].origin, 'https://ava.example')
})

test('bootstrap: Keychain save failure restores the previous backend and keeps setup open', async () => {
  let saves = 0
  const h = await bootstrapHarness({ native: true, secureStore: { save: async () => { saves++; throw new Error('Keychain save failed') } } })
  h.connectionPanel({ required: true })
  h.fields.origin.value = 'https://ava.example'
  h.fields.token.value = TOKEN
  const submission = h.events.submit({ preventDefault() {} })
  h.respond()
  await submission
  assert.equal(saves, 1)
  assert.equal(h.panel.closed, false)
  assert.equal(h.submit.disabled, false)
  assert.match(h.error.textContent, /Keychain/)
  assert.equal(h.seen.configured.at(-1).origin, '')
  assert.equal(h.seen.configured.at(-1).token, '')
})

test('bootstrap: native startup refuses to use browser storage when the Keychain bridge is unavailable', async () => {
  const h = await bootstrapHarness({ native: true })
  await assert.rejects(h.savedConnection(), /安全存储/)
  assert.equal(h.seen.stored.length, 0)
})


test('bootstrap: a verified candidate stays isolated until Keychain persistence also succeeds', async () => {
  let finishSave
  const h = await bootstrapHarness({ native: true, secureStore: { save: () => new Promise(resolve => { finishSave = resolve }) } })
  const finished = h.connectionPanel()
  h.fields.origin.value = 'https://new-ava.example'
  h.fields.token.value = TOKEN
  const submission = h.events.submit({ preventDefault() {} })
  assert.equal(h.seen.configured.length, 0)
  h.respond()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof finishSave, 'function')
  assert.equal(h.seen.configured.length, 0, 'old app must keep its existing destination while Keychain is pending')
  finishSave()
  await submission
  assert.equal(await finished, true)
  assert.equal(h.seen.configured.length, 1)
  assert.equal(h.seen.configured[0].origin, 'https://new-ava.example')
})


test('bootstrap: disconnect clears only Keychain connection, disables duplicate actions, then reloads', async () => {
  let clears = 0
  let finishClear
  const initialConnection = { origin: 'https://ava.example', token: TOKEN, consentVersion: 1 }
  const h = await bootstrapHarness({ native: true, initialConnection, secureStore: {
    clear: () => { clears++; return new Promise(resolve => { finishClear = resolve }) },
  } })
  h.window.localStorage.setItem('learning-record', 'keep me')
  const finished = h.connectionPanel()
  const clearing = h.events.disconnect()
  assert.equal(h.submit.disabled, true)
  assert.equal(h.cancel.disabled, true)
  assert.equal(h.disconnect.disabled, true)
  await h.events.disconnect()
  assert.equal(clears, 1)
  assert.equal(h.seen.configured.length, 0, 'do not disconnect an active app if Keychain removal fails')
  finishClear()
  await clearing
  assert.equal(await finished, false)
  assert.equal(h.seen.configured.at(-1).origin, '')
  assert.equal(h.seen.configured.at(-1).token, '')
  assert.equal(h.seen.reloaded, 1)
  assert.equal(h.window.localStorage.getItem('learning-record'), 'keep me')
})

test('bootstrap: failed Keychain removal preserves the current connection and learning records', async () => {
  const initialConnection = { origin: 'https://ava.example', token: TOKEN, consentVersion: 1 }
  const h = await bootstrapHarness({ native: true, initialConnection, secureStore: { clear: async () => { throw new Error('device locked') } } })
  h.window.localStorage.setItem('learning-record', 'keep me')
  h.connectionPanel()
  await h.events.disconnect()
  assert.equal(h.panel.closed, false)
  assert.equal(h.seen.reloaded, 0)
  assert.equal(h.seen.configured.length, 0)
  assert.equal(h.fields.token.value, TOKEN)
  assert.equal(h.submit.disabled, false)
  assert.match(h.error.textContent, /device locked/)
  assert.equal(h.window.localStorage.getItem('learning-record'), 'keep me')
})

test('bootstrap: native storage is scoped before the first learning module imports', async () => {
  const connection = { origin: 'https://ava.example', token: TOKEN, consentVersion: 1 }
  const h = await bootstrapHarness({ native: true, secureStore: { load: async () => ({ connection }) } })
  const raw = h.window.localStorage
  raw.setItem('ava.mobile.nickname', 'previous unscoped learner')
  const started = h.start()
  await new Promise(resolve => setImmediate(resolve))
  h.respond()
  await started
  assert.deepEqual(h.seen.scoped, ['https://ava.example'])
  assert.equal(h.seen.imported.length, 1)
  assert.equal(h.seen.imported[0].storage.getItem('ava.mobile.nickname'), null)
  assert.equal(raw.getItem('ava.mobile.nickname'), 'previous unscoped learner')
})

test('bootstrap: inability to replace native localStorage stops startup instead of using shared records', async () => {
  const connection = { origin: 'https://ava.example', token: TOKEN, consentVersion: 1 }
  const window = {}
  Object.defineProperty(window, 'localStorage', { configurable: false, value: {
    length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {},
  } })
  const h = await bootstrapHarness({ native: true, storageWindow: window, secureStore: { load: async () => ({ connection }) } })
  const started = h.start()
  await new Promise(resolve => setImmediate(resolve))
  h.respond()
  await assert.rejects(started, /无法安全隔离/)
  assert.equal(h.seen.imported.length, 0)
})

test('bootstrap: ordinary browser startup keeps its original localStorage', async () => {
  const h = await bootstrapHarness()
  const storage = h.window.localStorage
  const started = h.start()
  await new Promise(resolve => setImmediate(resolve))
  h.respond({ ok: true, json: async () => ({ authenticationRequired: false }) })
  await started
  assert.equal(h.window.localStorage, storage)
  assert.equal(h.seen.scoped.length, 0)
  assert.equal(h.seen.imported.length, 1)
})

test('bootstrap: disconnect from required setup cannot continue into the learning app', async () => {
  const initialConnection = { origin: 'https://ava.example', token: TOKEN, consentVersion: 1 }
  const h = await bootstrapHarness({ native: true, initialConnection, secureStore: {
    load: async () => ({ connection: initialConnection }), clear: async () => {},
  } })
  const started = h.start()
  await new Promise(resolve => setImmediate(resolve))
  h.respond({ ok: false, status: 401 })
  await new Promise(resolve => setImmediate(resolve))
  await h.events.disconnect()
  await started
  assert.equal(h.seen.reloaded, 1)
  assert.equal(h.seen.imported.length, 0)
  assert.equal(h.seen.scoped.length, 0)
})

test('bootstrap: switching services saves the new connection but keeps old page requests and cache on the old service until reload', async () => {
  const initialConnection = { origin: 'https://first.example', token: TOKEN, consentVersion: 1 }
  let saved
  const h = await bootstrapHarness({ native: true, initialConnection, secureStore: {
    load: async () => ({ connection: initialConnection }), save: async ({ connection }) => { saved = connection },
  } })
  const started = h.start()
  await new Promise(resolve => setImmediate(resolve))
  h.respond()
  await started
  const originalStorage = h.window.localStorage
  originalStorage.setItem('progress', 'first service lesson')
  const finished = h.connectionPanel()
  h.fields.origin.value = 'https://second.example'
  h.fields.token.value = TOKEN
  const submission = h.events.submit({ preventDefault() {} })
  h.respond()
  await submission
  assert.equal(await finished, true)
  assert.equal(saved.origin, 'https://second.example')
  assert.equal(h.seen.configured.at(-1).origin, 'https://first.example', 'pagehide progress still belongs to the first service')
  assert.equal(h.window.localStorage, originalStorage)
  assert.equal(h.window.localStorage.getItem('progress'), 'first service lesson')
})
