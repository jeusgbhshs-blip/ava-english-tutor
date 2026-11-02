/** iPhone playback regressions using the real helper and fake network/audio hardware. */
import test from 'node:test'
import assert from 'node:assert/strict'

const tick = () => new Promise((resolve) => setImmediate(resolve))
let moduleSequence = 0

function replaceGlobals(t, values) {
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

async function harness(t, { delayDecode = false } = {}) {
  const state = { gesture: true, contexts: [], sources: [], requests: [], releaseDecode: null, events: new Map() }
  const node = () => ({ connect() {}, disconnect() {} })
  class AudioContext {
    constructor() {
      this.state = 'suspended'
      this.destination = {}
      state.contexts.push(this)
    }
    resume() {
      if (!state.gesture) return Promise.reject(new Error('user activation required'))
      this.state = 'running'
      return Promise.resolve()
    }
    decodeAudioData() {
      return delayDecode
        ? new Promise((resolve) => { state.releaseDecode = () => resolve({ duration: 1 }) })
        : Promise.resolve({ duration: 1 })
    }
    createGain() { return { ...node(), gain: { value: 1 } } }
    createBufferSource() {
      const source = { ...node(), playbackRate: { value: 1 }, starts: 0, stops: 0,
        start() { this.starts++ }, stop() { this.stops++ } }
      state.sources.push(source)
      return source
    }
  }
  replaceGlobals(t, {
    window: { AudioContext, addEventListener() {} },
    document: { visibilityState: 'visible', addEventListener: (type, handler) => state.events.set(type, handler) },
    fetch: (url, options) => new Promise((resolve, reject) => {
      const request = { url, options, resolve }
      state.requests.push(request)
      options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
    }),
    Audio: class { constructor() { throw new Error('should use the context unlocked during the tap') } },
  })
  const module = await import(`../web/js/mobile/voice-audio.js?ios-test=${++moduleSequence}`)
  t.after(() => module.stopCharacterText())
  const respond = (index = state.requests.length - 1) => state.requests[index].resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
  return { state, module, respond }
}

test('iOS TTS: delayed synthesis plays through the context unlocked by the original tap', async (t) => {
  const { state, module, respond } = await harness(t)
  let starts = 0
  let ends = 0
  const played = module.playCharacterText('Hello Ava.', { onStart: () => starts++, onEnd: () => ends++ })
  assert.equal(state.contexts.length, 1)
  assert.equal(state.contexts[0].state, 'running')
  state.gesture = false
  respond()
  await tick()
  assert.equal(starts, 1)
  assert.equal(state.sources.length, 1)
  state.sources[0].onended()
  assert.equal(await played, true)
  assert.equal(ends, 1)
})

test('iOS TTS: stop aborts pending synthesis and settles without late callbacks or fallback', async (t) => {
  const { state, module } = await harness(t)
  let callbacks = 0
  const played = module.playCharacterText('Cancel this request.', { onStart: () => callbacks++, onEnd: () => callbacks++ })
  assert.equal(module.stopCharacterText(), true)
  assert.equal(state.requests[0].options.signal.aborted, true)
  assert.equal(await played, false)
  assert.equal(callbacks, 0)
  assert.equal(state.sources.length, 0)
})

test('iOS TTS: a decode finishing after cancellation cannot start audio', async (t) => {
  const { state, module, respond } = await harness(t, { delayDecode: true })
  const played = module.playCharacterText('Do not speak after I leave.')
  respond()
  await tick()
  assert.equal(typeof state.releaseDecode, 'function')
  module.stopCharacterText()
  state.releaseDecode()
  assert.equal(await played, false)
  assert.equal(state.sources.length, 0)
})

test('iOS TTS: backgrounding immediately stops current playback', async (t) => {
  const { state, module, respond } = await harness(t)
  let ends = 0
  const played = module.playCharacterText('Stop on background.', { onEnd: () => ends++ })
  respond()
  await tick()
  assert.equal(state.sources[0].starts, 1)
  document.visibilityState = 'hidden'
  state.events.get('visibilitychange')()
  assert.equal(await played, false)
  assert.equal(state.sources[0].stops, 1)
  assert.equal(ends, 0)
})
