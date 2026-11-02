import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/config.js'
import {
  DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_SPEAKER, LEGACY_APP_KEY,
  buildSessionConfig, buildVolcHeaders, volcCompatibilityWarning, VolcRealtimeSession,
} from '../lib/volcRealtime.js'
import { startMockVolc } from './mock-volc-realtime.mjs'

test('Doubao compatibility: binary API defaults to documented O2.0 with the English Dacey voice', () => {
  assert.equal(DEFAULT_MODEL, '1.2.1.1')
  assert.equal(DEFAULT_SETTINGS.volc.model, DEFAULT_MODEL)
  const cfg = buildSessionConfig()
  assert.equal(cfg.dialog.extra.model, DEFAULT_MODEL)
  assert.equal(cfg.tts.speaker, DEFAULT_SPEAKER)
  assert.equal(cfg.tts.audio_config.format, 'pcm_s16le')
  assert.equal(cfg.tts.audio_config.sample_rate, 24000)
  assert.equal(cfg.asr.audio_info.sample_rate, 16000)
})

test('Doubao compatibility: existing explicit model values are preserved and the incompatible public 3.0 setup is explained', () => {
  const saved = normalizeSettings({ volc: { model: '3.0' } })
  assert.equal(saved.volc.model, '3.0')
  assert.equal(buildSessionConfig({ volc: saved.volc }).dialog.extra.model, '3.0')
  assert.match(volcCompatibilityWarning(saved.volc), /3\.0.*不兼容/)
  assert.equal(volcCompatibilityWarning({ model: '1.2.1.1' }), '')
  assert.equal(volcCompatibilityWarning({ model: '2.2.0.0' }), '')
  assert.equal(volcCompatibilityWarning({ model: '3.0', endpoint: 'wss://custom.example/dialog' }), '')
  assert.match(volcCompatibilityWarning({ endpoint: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue' }), /JSON/)
})

test('Doubao compatibility: invalid public protocol/model combinations fail before opening a paid provider connection', async (t) => {
  let opened = 0
  t.mock.method(globalThis, 'WebSocket', function () { opened++; throw new Error('must not connect') })
  for (const volc of [
    { endpoint: DEFAULT_ENDPOINT, model: '3.0' },
    { endpoint: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', model: '1.2.6.1' },
  ]) {
    const session = new VolcRealtimeSession({ volc: { appId: 'fabricated-app', accessToken: 'fabricated-token', ...volc } })
    await assert.rejects(session.connect(), /3\.0/)
  }
  assert.equal(opened, 0)
})

test('Doubao compatibility: legacy access-token authentication includes the public App-Key constant', () => {
  const legacy = buildVolcHeaders({ appId: 'fabricated-app', accessToken: 'fabricated-token' })
  assert.equal(legacy['X-Api-App-Key'], LEGACY_APP_KEY)
  assert.equal(legacy['X-Api-Access-Key'], 'fabricated-token')
  assert.equal(legacy['X-Api-Key'], undefined)
  const modern = buildVolcHeaders({ appId: 'fabricated-app', apiKey: 'fabricated-key', accessToken: 'old-token' })
  assert.equal(modern['X-Api-Key'], 'fabricated-key')
  assert.equal(modern['X-Api-Access-Key'], undefined)
  assert.equal(modern['X-Api-App-Key'], undefined)
})

test('Doubao compatibility: paused microphone mode keeps VAD sessions alive without changing text-only mode', () => {
  for (const pttMode of [false, true]) {
    const cfg = buildSessionConfig({ pttMode })
    assert.equal(cfg.dialog.extra.input_mod, 'keep_alive')
    assert.equal(cfg.asr.extra.enable_custom_vad, true)
    assert.equal(cfg.asr.extra.end_smooth_window_ms, pttMode ? 2000 : 1200)
  }
  assert.equal(buildSessionConfig({ textMode: true }).dialog.extra.input_mod, 'text')
})

test('Doubao compatibility: real local handshake carries legacy auth, trace ID, and O2.0 keep-alive session payload', async (t) => {
  const mock = await startMockVolc({ chunkDelayMs: 2 })
  const session = new VolcRealtimeSession({ volc: {
    endpoint: mock.wsUrl, appId: 'fabricated-app', accessToken: 'fabricated-token',
  }, pttMode: true })
  t.after(async () => { session.close('test-complete'); await mock.close() })
  await session.connect()
  const headers = mock.connections[0].headers
  assert.equal(headers['x-api-app-key'], LEGACY_APP_KEY)
  assert.equal(headers['x-api-access-key'], 'fabricated-token')
  assert.equal(headers['x-api-connect-id'], session.connectId)
  assert.equal(mock.sessionConfigs[0].dialog.extra.model, '1.2.1.1')
  assert.equal(mock.sessionConfigs[0].dialog.extra.input_mod, 'keep_alive')
  await session.finish()
})

test('Doubao compatibility: settings visibly warn about saved 3.0 without rewriting the field', async () => {
  const source = await readFile(new URL('../web/js/main.js', import.meta.url), 'utf8')
  const start = source.indexOf('function updateVolcModelWarning()')
  const end = source.indexOf('/** 设置页：填充', start)
  const D = { volcModel: { value: '3.0' }, volcEndpoint: { value: DEFAULT_ENDPOINT }, volcModelWarning: { hidden: true, textContent: '' } }
  const context = vm.createContext({ D, URL, VOLC_DEFAULT_ENDPOINT: DEFAULT_ENDPOINT })
  vm.runInContext(source.slice(start, end) + '\nupdateVolcModelWarning()', context)
  assert.equal(D.volcModel.value, '3.0')
  assert.equal(D.volcModelWarning.hidden, false)
  assert.match(D.volcModelWarning.textContent, /未被自动修改/)
  D.volcModel.value = '1.2.1.1'
  vm.runInContext('updateVolcModelWarning()', context)
  assert.equal(D.volcModelWarning.hidden, true)
})
