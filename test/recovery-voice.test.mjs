/** Offline recovery regressions: real client/session logic, fake transport and audio only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { VolcRealtimeSession } from '../lib/volcRealtime.js'
import { encodeError, encodeServerEvent, SERVER_EVENT } from '../lib/volcProtocol.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function deadline(promise, milliseconds = 500) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('operation did not settle')), milliseconds)
    }),
  ]).finally(() => clearTimeout(timer))
}

function globals(t, values) {
  const originals = new Map()
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
}

function transport() {
  const sockets = []
  class FakeWebSocket {
    constructor() {
      this.readyState = 0
      this.sent = []
      this.closeCalls = 0
      sockets.push(this)
    }
    open() {
      this.readyState = 1
      this.onopen?.({})
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('socket is not open')
      this.sent.push(data)
    }
    receive(data) { this.onmessage?.({ data }) }
    remoteClose() {
      this.readyState = 3
      this.onclose?.({ code: 1006 })
    }
    close() {
      this.closeCalls += 1
      this.readyState = 3
      queueMicrotask(() => this.onclose?.({ code: 1000 }))
    }
  }
  return { sockets, FakeWebSocket }
}

function upstream(t) {
  const fake = transport()
  globals(t, { WebSocket: fake.FakeWebSocket })
  const seen = { ready: 0, errors: [], closes: [] }
  const session = new VolcRealtimeSession({
    volc: { appId: 'test-app', apiKey: 'test-key', endpoint: 'ws://offline.invalid' },
    connectTimeoutMs: 100,
    handlers: {
      onReady() { seen.ready += 1 },
      onError(error) { seen.errors.push(error) },
      onClose(reason) { seen.closes.push(reason) },
    },
  })
  t.after(() => session.close('test-cleanup'))
  const readyFrame = () => encodeServerEvent({
    eventId: SERVER_EVENT.SESSION_STARTED,
    sessionId: session.sessionId,
    payload: { dialog_id: 'offline-dialog' },
  })
  return { ...fake, session, seen, readyFrame }
}

test('upstream: concurrent connect waits for session ready; close callback fires once', async (t) => {
  const { session, sockets, seen, readyFrame } = upstream(t)
  const first = session.connect()
  const second = session.connect()
  assert.strictEqual(first, second)
  let settled = false
  first.then(() => { settled = true })
  sockets[0].open()
  await tick()
  assert.equal(settled, false)
  sockets[0].receive(readyFrame())
  assert.equal(await deadline(first), true)
  assert.equal(seen.ready, 1)
  session.close('requested')
  session.close('duplicate')
  await tick()
  sockets[0].remoteClose()
  sockets[0].receive(readyFrame())
  assert.deepEqual(seen.closes, ['requested'])
  assert.equal(seen.ready, 1, 'late frames must not resurrect a closed session')
  assert.equal(session.ready, false)
})

test('upstream: a remote close before ready rejects connect instead of hanging', async (t) => {
  const { session, sockets, seen } = upstream(t)
  const result = assert.rejects(deadline(session.connect()), /就绪前已关闭/)
  sockets[0].open()
  sockets[0].remoteClose()
  await result
  session.close('again')
  assert.equal(seen.closes.length, 1)
})

test('upstream: protocol ERROR rejects pending connect and reports one useful error', async (t) => {
  const { session, sockets, seen } = upstream(t)
  const result = assert.rejects(deadline(session.connect()), /鉴权失败/)
  sockets[0].open()
  sockets[0].receive(encodeError({ code: 401, message: 'mock unauthorized' }))
  await result
  await tick()
  assert.equal(seen.errors.length, 1)
  assert.equal(seen.closes.length, 1)
  assert.match(seen.errors[0].message, /鉴权失败/)
})

test('upstream: explicit cancellation before ready settles and ignores late ready', async (t) => {
  const { session, sockets, seen, readyFrame } = upstream(t)
  const result = assert.rejects(deadline(session.connect()), /就绪前已关闭/)
  sockets[0].open()
  session.close('cancelled')
  await result
  sockets[0].receive(readyFrame())
  await tick()
  assert.deepEqual(seen.closes, ['cancelled'])
  assert.equal(seen.ready, 0)
})

test('upstream: protocol ERROR after ready still closes the active session once', async (t) => {
  const { session, sockets, seen, readyFrame } = upstream(t)
  const connected = session.connect()
  sockets[0].open()
  sockets[0].receive(readyFrame())
  await connected
  sockets[0].receive(encodeError({ code: 429, message: 'quota exceeded' }))
  await tick()
  assert.equal(seen.errors.length, 1)
  assert.match(seen.errors[0].message, /额度|频率/)
  assert.equal(seen.closes.length, 1)
  assert.equal(session.ready, false)
})

let moduleSequence = 0
async function browserClient(t, { deferCapture = false } = {}) {
  const fake = transport()
  const audio = { requests: 0, processors: [], stoppedTracks: 0, releaseCapture: null }
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } })
  const stream = { getTracks: () => [{ stop() { audio.stoppedTracks += 1 } }] }
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
    }
    createGain() { return node() }
    createMediaStreamSource() { return node() }
    createScriptProcessor() {
      const processor = node()
      audio.processors.push(processor)
      return processor
    }
    createBuffer(channels, length, rate) {
      return { duration: length / rate, getChannelData: () => new Float32Array(length) }
    }
    createBufferSource() { return { ...node(), start() {}, stop() {} } }
    close() {}
  }
  globals(t, {
    window: {
      AudioContext: FakeAudioContext,
      WebSocket: fake.FakeWebSocket,
      isSecureContext: true,
      location: { protocol: 'http:', host: 'offline.invalid' },
    },
    document: {},
    WebSocket: fake.FakeWebSocket,
    AudioWorkletNode: undefined,
    navigator: {
      mediaDevices: {
        getUserMedia() {
          audio.requests += 1
          return deferCapture
            ? new Promise((resolve) => { audio.releaseCapture = () => resolve(stream) })
            : Promise.resolve(stream)
        },
      },
    },
  })
  const module = await import(`../web/js/doubao-voice.js?recovery=${++moduleSequence}`)
  const clients = []
  t.after(() => clients.forEach((client) => client.dispose()))
  const create = (options = {}) => {
    const client = module.createDoubaoVoice({ readyTimeoutMs: 200, ...options })
    clients.push(client)
    return client
  }
  const pcm = () => audio.processors[0].onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(960).fill(0.2) },
  })
  const ready = (socket = fake.sockets.at(-1)) => socket.receive(JSON.stringify({ type: 'ready', model: 'mock' }))
  const binary = (socket = fake.sockets.at(-1)) => socket.sent.filter((item) => item instanceof ArrayBuffer)
  return { ...fake, audio, create, pcm, ready, binary }
}

test('browser: socket open is not ready; first recorded PCM is sent only after ready', async (t) => {
  const env = await browserClient(t)
  let readyCalls = 0
  const client = env.create({ onReady() { readyCalls += 1 } })
  const started = client.start({ ptt: true })
  const concurrent = client.start({ ptt: true })
  let settled = false
  started.then(() => { settled = true })
  env.sockets[0].open()
  await tick()
  assert.equal(settled, false)
  assert.equal(client.isReady, false)
  assert.equal(env.audio.requests, 0, 'do not capture and silently lose the first sentence')
  assert.equal(client.resumeMic(), false)
  assert.equal(client.commit(), false)
  assert.equal(env.binary().length, 0)
  env.ready()
  assert.equal(await deadline(started), true)
  assert.equal(await deadline(concurrent), true)
  assert.equal(client.isReady, true)
  assert.equal(readyCalls, 1)
  assert.equal(env.audio.requests, 1)
  env.pcm()
  assert.equal(env.binary().length, 1)
  assert.equal(env.binary()[0].byteLength, 640)
})

test('browser: startPaused warms the session without transmitting PCM until resume', async (t) => {
  const env = await browserClient(t)
  const client = env.create()
  const started = client.start({ ptt: true, startPaused: true })
  env.sockets[0].open()
  await tick()
  env.ready()
  assert.equal(await deadline(started), true)
  assert.equal(client.isMicPaused, true)
  env.pcm()
  assert.equal(env.binary().length, 0)
  assert.equal(client.resumeMic(), true)
  env.pcm()
  assert.equal(env.binary().length, 1)
  assert.equal(client.pauseMic(), true)
  env.pcm()
  assert.equal(env.binary().length, 1)
  assert.equal(client.commit(), true, 'PTT may commit while microphone is paused')
})

test('browser: every incoming PCM packet reports progress, including more than five seconds', async (t) => {
  const env = await browserClient(t)
  const progress = []
  const client = env.create({ onAudioProgress: (packet) => progress.push(packet) })
  const started = client.start({ startPaused: true })
  env.sockets[0].open()
  await tick()
  env.ready()
  await started
  let clock = 10_000
  t.mock.method(Date, 'now', () => clock)
  for (let index = 0; index < 251; index += 1) {
    clock += 20
    env.sockets[0].receive(new Int16Array(480).buffer)
    assert.equal(progress.at(-1)?.at, clock, 'a continuous packet must keep the caller watchdog alive')
  }
  assert.equal(progress.length, 251)
  assert.equal(progress.reduce((sum, packet) => sum + packet.bytes, 0), 251 * 960)
  let replacementBytes = 0
  client.setHandlers({ onAudioProgress: ({ bytes }) => { replacementBytes += bytes } })
  env.sockets[0].receive(new Int16Array(480).buffer)
  assert.equal(replacementBytes, 960)
})

test('browser: stop cancels transport opening immediately without microphone or error', async (t) => {
  const env = await browserClient(t)
  const errors = []
  let ended = 0
  const client = env.create({ onError: (error) => errors.push(error), onEnded() { ended += 1 } })
  const started = client.start()
  assert.equal(client.stop(), true)
  assert.equal(await deadline(started), false)
  assert.equal(env.sockets[0].readyState, 3)
  assert.equal(env.audio.requests, 0)
  assert.equal(errors.length, 0)
  assert.equal(ended, 1)
})

test('browser: stop during upstream readiness cancels, and a new start remains usable', async (t) => {
  const env = await browserClient(t)
  const errors = []
  const client = env.create({ onError: (error) => errors.push(error) })
  const first = client.start()
  env.sockets[0].open()
  await tick()
  client.stop()
  assert.equal(await deadline(first), false)
  assert.equal(client.isActive, false)
  const second = client.start({ startPaused: true })
  env.sockets[1].open()
  await tick()
  env.ready(env.sockets[0])
  assert.equal(client.isReady, false, 'late ready from the cancelled socket must be ignored')
  env.ready(env.sockets[1])
  assert.equal(await deadline(second), true)
  assert.equal(env.audio.requests, 1)
  assert.equal(errors.length, 0)
})

test('browser: stop while microphone permission is pending resolves and releases a late stream', async (t) => {
  const env = await browserClient(t, { deferCapture: true })
  const errors = []
  let recordingNotifications = 0
  const client = env.create({
    onError: (error) => errors.push(error),
    onReady() { recordingNotifications += 1 },
  })
  const started = client.start()
  env.sockets[0].open()
  await tick()
  env.ready()
  await tick()
  assert.equal(env.audio.requests, 1)
  assert.equal(recordingNotifications, 0, 'permission pending must not show recording yet')
  client.stop()
  assert.equal(await deadline(started), false)
  env.audio.releaseCapture()
  await tick()
  assert.equal(env.audio.stoppedTracks, 1)
  assert.equal(env.audio.processors.length, 0)
  assert.equal(client.isActive, false)
  assert.equal(errors.length, 0)
  assert.equal(recordingNotifications, 0)
})

test('browser: stop then immediate start ignores the old session ending before the new socket opens', async (t) => {
  const env = await browserClient(t)
  const errors = []
  let ended = 0
  const client = env.create({ onError: (error) => errors.push(error), onEnded() { ended += 1 } })
  const initial = client.start({ startPaused: true })
  env.sockets[0].open()
  await tick()
  env.ready()
  assert.equal(await deadline(initial), true)
  client.stop()
  const next = client.start({ startPaused: true })
  const previousSocket = env.sockets[0]
  previousSocket.receive(JSON.stringify({ type: 'ended' }))
  previousSocket.remoteClose()
  previousSocket.receive(JSON.stringify({ type: 'error', message: 'stale session error' }))
  await tick()
  assert.equal(client.isActive, true)
  assert.equal(env.sockets[1].readyState, 0, 'old session cannot close the replacement transport')
  assert.equal(previousSocket.closeCalls, 1)
  env.sockets[1].open()
  await tick()
  env.ready(env.sockets[1])
  assert.equal(await deadline(next), true)
  assert.equal(env.audio.requests, 2)
  assert.equal(env.audio.stoppedTracks, 1)
  assert.equal(client.isMicPaused, true)
  assert.equal(errors.length, 0)
  assert.equal(ended, 0, 'the superseded session must not end the new call in the UI')
})

test('browser: dispose before ready settles start without an error callback', async (t) => {
  const env = await browserClient(t)
  const errors = []
  const client = env.create({ onError: (error) => errors.push(error) })
  const started = client.start()
  env.sockets[0].open()
  await tick()
  client.dispose()
  assert.equal(await deadline(started), false)
  assert.equal(env.audio.requests, 0)
  assert.equal(errors.length, 0)
})

test('browser: no upstream ready has a bounded timeout and never starts the microphone', async (t) => {
  const env = await browserClient(t)
  const errors = []
  const client = env.create({ readyTimeoutMs: 30, onError: (error) => errors.push(error) })
  const started = client.start()
  env.sockets[0].open()
  assert.equal(await deadline(started), false)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'timeout')
  assert.equal(env.audio.requests, 0)
  assert.equal(client.isActive, false)
  assert.equal(env.sockets[0].readyState, 3)
})

test('browser: an upstream error before ready reports once and settles startup', async (t) => {
  const env = await browserClient(t)
  const errors = []
  const client = env.create({ onError: (error) => errors.push(error) })
  const started = client.start()
  env.sockets[0].open()
  await tick()
  env.sockets[0].receive(JSON.stringify({ type: 'error', message: 'mock credentials rejected' }))
  assert.equal(await deadline(started), false)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /credentials rejected/)
  assert.equal(env.audio.requests, 0)
})

test('browser: transport close before ready fails startup instead of leaving it pending', async (t) => {
  const env = await browserClient(t)
  const errors = []
  const client = env.create({ onError: (error) => errors.push(error) })
  const started = client.start()
  env.sockets[0].open()
  await tick()
  env.sockets[0].remoteClose()
  assert.equal(await deadline(started), false)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'closed')
  assert.equal(env.audio.requests, 0)
})

test('browser: reconnect buffers PCM until the new upstream session is ready', async (t) => {
  const env = await browserClient(t)
  const client = env.create()
  const started = client.start()
  env.sockets[0].open()
  await tick()
  env.ready()
  await started
  env.sockets[0].remoteClose()
  assert.equal(client.isReady, false)
  env.pcm()
  await new Promise((resolve) => setTimeout(resolve, 320))
  assert.equal(env.sockets.length, 2)
  env.sockets[1].open()
  await tick()
  assert.equal(env.binary().length, 0)
  env.ready()
  await tick()
  assert.equal(env.binary().length, 1, 'buffered first frame must survive reconnect readiness')
  assert.equal(env.binary()[0].byteLength, 640)
  assert.equal(env.audio.requests, 1, 'reconnect reuses the microphone')
})

// Evaluate the actual call controller functions with external UI/audio dependencies stubbed.
// This guards the client/controller contract rather than duplicating the PTT state machine.
function pttController({ warmed = false, afterReady = null } = {}) {
  const filename = new URL('../web/js/mobile/call.js', import.meta.url)
  const source = readFileSync(filename, 'utf8')
  const section = (start, end) => {
    const from = source.indexOf(start)
    const to = source.indexOf(end, from)
    assert.ok(from >= 0 && to > from, `cannot locate PTT controller section: ${start}`)
    return source.slice(from, to)
  }
  const callback = source.match(/        onReady\(info\) \{([\s\S]*?)\n        \},\n        onASR/)
  assert.ok(callback, 'cannot locate the real onReady callback')
  const logic = [
    section('function bumpPttToken()', 'function clearPttTimers()'),
    section('function isVolcSessionActive()', 'async function toggleVolc()'),
    section('async function tryStartVolcSession()', 'function startBrowserPtt()'),
    section('async function startVolcPtt(generation)', '/** 结束本轮录音'),
    `function onReady(info) {${callback[1]}\n}`,
  ].join('\n')
  const state = { open: true, engine: 'volc', ptt: 'idle', pttToken: 0, volcToken: -1 }
  const seen = { starts: 0, resumes: 0, watchdogs: 0, stateAtReady: null }
  let context
  const voice = {
    isActive: warmed,
    isMicPaused: true,
    commit() {},
    stop() { this.isActive = false },
    async start() {
      seen.starts += 1
      this.isActive = true
      context.onReady({ model: 'mock' })
      seen.stateAtReady = state.ptt
      await afterReady?.(state)
      return true
    },
    resumeMic() {
      seen.resumes += 1
      this.isMicPaused = false
      return true
    },
  }
  state.volc = voice
  const noop = () => {}
  context = vm.createContext({
    C: state, D: { textForm: { hidden: true } }, console,
    tts: { cancel: noop }, stopCharacterVoice: noop,
    clearVolcWarmup: noop, ensureMicMonitor: noop,
    resetPttForNewTurn: noop, clearPttTimers: noop,
    showTextForm: noop, updateEngineLabel: noop,
    setPttState(value) { state.ptt = value },
    setState(value) { state.state = value },
    withTimeout: (promise) => promise,
    ensureVolc: async () => voice,
    volcStartOptions: () => ({}), extractKbHits: () => null,
    startPttWatchdog() { seen.watchdogs += 1 },
    resetVolcSession() { throw new Error('unexpected PTT reset') },
    recoverVolcConnection() { throw new Error('unexpected PTT recovery') },
    toast: noop,
  })
  vm.runInContext(logic, context, { filename: filename.pathname })
  return { state, seen, start: () => context.startPtt() }
}

for (const warmed of [false, true]) {
  test(`PTT: ${warmed ? 'warmed' : 'fresh'} session enters recording after mic resume and starts its watchdog`, async () => {
    const controller = pttController({ warmed })
    assert.equal(await controller.start(), true)
    assert.equal(controller.state.ptt, 'recording')
    assert.equal(controller.state.state, 'listening')
    assert.equal(controller.seen.starts, warmed ? 0 : 1)
    assert.equal(controller.seen.resumes, 1)
    assert.equal(controller.seen.watchdogs, 1)
    if (!warmed) assert.equal(controller.seen.stateAtReady, 'connecting', 'paused ready is not yet recording')
  })
}

test('PTT: cancelling after ready but before start resolves does not resume mic or arm watchdog', async () => {
  const controller = pttController({ afterReady(state) {
    state.pttToken += 1
    state.ptt = 'idle'
  } })
  assert.equal(await controller.start(), false)
  assert.equal(controller.state.ptt, 'idle')
  assert.equal(controller.seen.resumes, 0)
  assert.equal(controller.seen.watchdogs, 0)
})
