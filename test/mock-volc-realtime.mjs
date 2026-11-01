/**
 * test/mock-volc-realtime.mjs —— 本地假「火山引擎端到端实时语音大模型」WebSocket 服务
 *
 * 用途：给 /ws/voice 桥、/api/volc/test 与 UI 提供可控的火山实时语音上游，零依赖。
 * 协议编解码直接复用 `lib/volcProtocol.js`（与真实客户端一致）。
 *
 * 最小会话流程（SPEC v1.4 §B4/B6，与 Lead 冒烟通过的临时 mock 对齐）：
 *   StartConnection(1)  → ConnectionStarted(50)（必须带 connectId，否则解析端会把负载误当 id）
 *   StartSession(100)   → SessionStarted(150)（记录收到的 session 配置）
 *   TaskRequest(200)    → 统计音频帧/字节；首帧后按场景推送 ASR/Chat/TTS
 *   FinishSession(102)  → SessionFinished(152)
 *   FinishConnection(2) → ConnectionFinished(52) 并关闭
 *   ClientInterrupt(515)→ 记录打断；补一个 TtsEnded(359)
 *
 * 服务端事件格式（与 lib/volcRealtime.js 对齐）：
 *   - ASR 451: JSON {text, is_final}；ASR 450 = 用户开口（打断信号）；ASR 459 = 识别结束
 *   - Chat 550: JSON {text}（逐段）；559 = 本轮回复结束（final）
 *   - TTS 350: JSON {text}；352 = RAW PCM（24kHz mono s16le）负载；359 = 播报结束
 *   - 错误：51 ConnectionFailed / 153 SessionFailed / 599 DialogCommonError，负载 {error}
 *
 * 场景（热切换，无需重启）：
 *   - 'ok'            正常：ready → ASR → Chat → TTS(350/352/359)
 *   - 'auth-fail'     StartConnection 后推 ConnectionFailed(51) 并断开（鉴权失败）
 *   - 'model-fail'    StartSession 后推 SessionFailed(153)（模型不支持）
 *   - 'speaker-fail'  StartSession 后推 SessionFailed(153)（音色不匹配）
 *   - 'error-599'     StartSession 后推 DialogCommonError(599)
 *   - 'mid-disconnect' 收到第 2 帧音频后直接断开连接
 *   - 'no-session'    连接成功但 StartSession 永不响应（超时用例，谨慎）
 *   - 'no-events'     会话正常但不上推任何 ASR/Chat/TTS
 *   - 'translate-fail' 文本翻译请求（ChatTextQuery 501）返回英文（应被服务端丢弃→翻译失败）
 *
 * 用法：
 *   import { startMockVolc } from './mock-volc-realtime.mjs'
 *   const mock = await startMockVolc()
 *   mock.wsUrl                 // ws://127.0.0.1:PORT/ws/voice（填到 volc.endpoint）
 *   mock.setScenario('auth-fail')
 *   mock.sessionConfigs        // 收到的 StartSession 配置（断言 persona/asr/tts/dialog）
 *   mock.connections           // [{headers, connectId, sessionId, audioFrames, audioBytes, closed}]
 *   mock.audioFrames / mock.audioBytes
 *   mock.events                // 事件流水（调试）
 *   await mock.close()
 */

import http from 'node:http'
import { fileURLToPath } from 'node:url'

import {
  CLIENT_EVENT,
  MSG_TYPE,
  SERIALIZATION,
  SERVER_EVENT,
  encodeEvent,
  parseFrame,
  generateId,
} from '../lib/volcProtocol.js'
import { attachWsServer } from '../lib/wsServer.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 24kHz mono s16le 正弦波 PCM（模拟 TTS 下行音频） */
export function makePcm24k({ ms = 20, freq = 440, amplitude = 0.25 } = {}) {
  const sampleRate = 24_000
  const samples = Math.max(1, Math.round((sampleRate * ms) / 1000))
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude * 32767)
    buf.writeInt16LE(v, i * 2)
  }
  return buf
}

/** 文本模式（翻译）默认中文译文池 */
export const DEFAULT_TRANSLATIONS = [
  '你好，今天过得怎么样？',
  '我喜欢喝咖啡。',
  '这是一篇关于阅读的短文。',
  '很高兴认识你，我们开始吧。',
  '这篇材料讲的是如何通过每天阅读提高英语。',
]

/** 默认上推载荷（可在 startMockVolc({ payloads }) / mock.setPayloads() 覆盖） */
export const DEFAULT_PAYLOADS = {
  asrPartial: { results: [{ text: 'Hello Ava', is_interim: true }] },
  asrFinal: { results: [{ text: 'Hello Ava, how are you?', is_interim: false }], extra: { endpoint: true } },
  asrEnded: {},
  chatPartial1: { content: 'Hi there! ' },
  chatPartial2: { content: 'I am doing really well, thanks for asking.' },
  chatEnded: {},
  ttsSentenceStart: { text: 'Hi there! I am doing really well, thanks for asking.' },
  ttsEnded: {},
}

/**
 * 启动 mock 火山实时语音服务。
 * @param {object} [options]
 * @param {string} [options.scenario='ok']
 * @param {number} [options.chunkDelayMs=8] 推事件间隔
 * @param {number} [options.audioFrames=3] 每次 TTS 下发音频帧数
 * @param {boolean} [options.pushOnAudio=true] 首帧上行音频后自动推事件
 * @param {object} [options.payloads]
 * @returns {Promise<object>}
 */
export async function startMockVolc(options = {}) {
  const state = {
    scenario: options.scenario || 'ok',
    chunkDelayMs: options.chunkDelayMs ?? 8,
    audioFrames: options.audioFrames ?? 3,
    pushOnAudio: options.pushOnAudio !== false,
    payloads: { ...DEFAULT_PAYLOADS, ...(options.payloads || {}) },
    connections: [],
    sessionConfigs: [],
    events: [],
    audioFramesCount: 0,
    audioBytes: 0,
    textQueries: [],
    translationIndex: 0,
    startedAt: Date.now(),
  }
  /** @type {Set<any>} */
  const openConnections = new Set()

  const record = (type, detail = {}) => {
    state.events.push({ type, at: Date.now() - state.startedAt, ...detail })
    if (state.events.length > 800) state.events.splice(0, state.events.length - 800)
  }

  const sendServerEvent = (conn, eventId, payload, extra = {}) => {
    if (conn.destroyed) return false
    conn.sendBinary(
      encodeEvent({
        msgType: MSG_TYPE.FULL_SERVER_RESPONSE,
        eventId,
        payload,
        sessionId: conn.sessionId || '',
        connectId: conn.connectId || '',
        ...extra,
      }),
    )
    record('server-event', { eventId, payload })
    return true
  }

  async function pushScenarioEvents(conn) {
    const { payloads } = state
    const push = async (eventId, payload) => {
      if (conn.destroyed) return false
      sendServerEvent(conn, eventId, payload)
      await sleep(state.chunkDelayMs)
      return true
    }
    await push(SERVER_EVENT.ASR_RESPONSE, payloads.asrPartial)
    await push(SERVER_EVENT.ASR_RESPONSE, payloads.asrFinal)
    await push(SERVER_EVENT.ASR_ENDED, payloads.asrEnded)
    await push(SERVER_EVENT.CHAT_RESPONSE, payloads.chatPartial1)
    await push(SERVER_EVENT.CHAT_RESPONSE, payloads.chatPartial2)
    await push(SERVER_EVENT.CHAT_ENDED, payloads.chatEnded)
    await push(SERVER_EVENT.TTS_SENTENCE_START, payloads.ttsSentenceStart)
    for (let i = 0; i < state.audioFrames; i++) {
      if (conn.destroyed) return
      const pcm = makePcm24k({ freq: 440 + i * 110 })
      conn.sendBinary(
        encodeEvent({
          msgType: MSG_TYPE.FULL_SERVER_RESPONSE,
          eventId: SERVER_EVENT.TTS_RESPONSE,
          sessionId: conn.sessionId,
          payload: pcm,
          serialization: SERIALIZATION.RAW,
        }),
      )
      record('server-audio', { bytes: pcm.length, index: i })
      await sleep(state.chunkDelayMs)
    }
    await push(SERVER_EVENT.TTS_ENDED, payloads.ttsEnded)
    record('push-complete')
  }

  async function handleFrame(conn, frame, entry) {
    if (frame.msgType === MSG_TYPE.AUDIO_ONLY_REQUEST) {
      if (frame.eventId === CLIENT_EVENT.TASK_REQUEST) {
        const bytes = frame.payload ? frame.payload.length : 0
        entry.audioFrames += 1
        entry.audioBytes += bytes
        state.audioFramesCount += 1
        state.audioBytes += bytes
        record('client-audio', { bytes, total: state.audioFramesCount, sessionId: frame.sessionId })
        if (state.scenario === 'mid-disconnect' && entry.audioFrames >= 2) {
          record('mid-disconnect')
          conn.destroy()
          return
        }
        if (state.pushOnAudio && state.scenario !== 'no-events' && entry.audioFrames === 1 && !entry.pushed) {
          entry.pushed = true
          await pushScenarioEvents(conn)
        }
      }
      return
    }

    if (frame.msgType !== MSG_TYPE.FULL_CLIENT_REQUEST) return
    const eventId = frame.eventId
    entry.events.push(eventId)
    record('client-event', { eventId, sessionId: frame.sessionId, connectId: frame.connectId })

    if (eventId === CLIENT_EVENT.START_CONNECTION) {
      entry.connectId = frame.connectId || generateId()
      conn.connectId = entry.connectId
      if (state.scenario === 'auth-fail') {
        sendServerEvent(conn, SERVER_EVENT.CONNECTION_FAILED, {
          error: 'auth failed: invalid app id or access key (401 unauthorized)',
          status_code: 1001,
        })
        await sleep(state.chunkDelayMs)
        conn.destroy()
        return
      }
      // ConnectionStarted 是 connect 级事件，必须带 connectId（parseFrame 依赖）
      conn.sendBinary(
        encodeEvent({
          msgType: MSG_TYPE.FULL_SERVER_RESPONSE,
          eventId: SERVER_EVENT.CONNECTION_STARTED,
          payload: { connect_id: entry.connectId },
          connectId: entry.connectId,
        }),
      )
      record('server-event', { eventId: SERVER_EVENT.CONNECTION_STARTED })
      return
    }

    if (eventId === CLIENT_EVENT.START_SESSION) {
      entry.sessionId = frame.sessionId || generateId()
      conn.sessionId = entry.sessionId
      entry.sessionConfig = frame.json || {}
      state.sessionConfigs.push(entry.sessionConfig)
      record('session-config', { config: entry.sessionConfig })
      if (state.scenario === 'no-session') return
      if (state.scenario === 'model-fail') {
        sendServerEvent(conn, SERVER_EVENT.SESSION_FAILED, {
          error: 'model not supported: realtime dialog 3.0 is not enabled for this app (invalid model)',
          status_code: 1002,
        })
        return
      }
      if (state.scenario === 'speaker-fail') {
        sendServerEvent(conn, SERVER_EVENT.SESSION_FAILED, {
          error: 'speaker not supported: en_female_dacey_uranus_bigtts is invalid for this model',
          status_code: 1003,
        })
        return
      }
      sendServerEvent(conn, SERVER_EVENT.SESSION_STARTED, { session_id: entry.sessionId, dialog_id: 'mock-dialog-1' })
      if (state.scenario === 'error-599') {
        await sleep(state.chunkDelayMs)
        sendServerEvent(conn, SERVER_EVENT.DIALOG_COMMON_ERROR, { error: 'dialog common error: internal error', status_code: 599 })
      }
      return
    }

    if (eventId === CLIENT_EVENT.FINISH_SESSION) {
      sendServerEvent(conn, SERVER_EVENT.SESSION_FINISHED, {})
      return
    }

    if (eventId === CLIENT_EVENT.FINISH_CONNECTION) {
      conn.sendBinary(
        encodeEvent({
          msgType: MSG_TYPE.FULL_SERVER_RESPONSE,
          eventId: SERVER_EVENT.CONNECTION_FINISHED,
          payload: {},
          connectId: entry.connectId,
        }),
      )
      record('server-event', { eventId: SERVER_EVENT.CONNECTION_FINISHED })
      await sleep(state.chunkDelayMs)
      conn.close(1000, 'finished')
      return
    }

    if (eventId === CLIENT_EVENT.CLIENT_INTERRUPT) {
      entry.interrupted = true
      record('client-interrupt')
      sendServerEvent(conn, SERVER_EVENT.TTS_ENDED, {})
      return
    }

    if (eventId === CLIENT_EVENT.CHAT_TEXT_QUERY) {
      // 文本模式（翻译）：只回 Chat 文本，不推任何 TTS 音频
      const content = String((frame.json && (frame.json.content || frame.json.text)) || '')
      state.textQueries.push(content)
      record('client-text-query', { content: content.slice(0, 200) })
      const translation =
        state.scenario === 'translate-fail'
          ? 'Hello, this is an English non-translation and should be discarded.'
          : DEFAULT_TRANSLATIONS[state.translationIndex % DEFAULT_TRANSLATIONS.length]
      if (state.scenario !== 'translate-fail') state.translationIndex += 1
      sendServerEvent(conn, SERVER_EVENT.CHAT_RESPONSE, { content: translation, text: translation })
      await sleep(state.chunkDelayMs)
      sendServerEvent(conn, SERVER_EVENT.CHAT_ENDED, {})
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, scenario: state.scenario }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('mock volc realtime: not found')
  })
  server.on('connection', (socket) => socket.on('error', () => {}))

  attachWsServer(server, '/ws/voice', (conn, req) => {
    openConnections.add(conn)
    conn.on('close', () => openConnections.delete(conn))
    const entry = {
      headers: { ...req.headers },
      connectId: null,
      sessionId: null,
      sessionConfig: null,
      audioFrames: 0,
      audioBytes: 0,
      events: [],
      pushed: false,
      interrupted: false,
      closed: false,
    }
    state.connections.push(entry)
    conn.on('close', () => {
      entry.closed = true
      record('client-close', { sessionId: entry.sessionId, audioFrames: entry.audioFrames })
    })
    conn.on('message', (data, isBinary) => {
      if (!isBinary) {
        record('unexpected-text', { text: String(data).slice(0, 200) })
        return
      }
      try {
        void handleFrame(conn, parseFrame(data), entry)
      } catch (err) {
        record('parse-error', { error: String(err && err.message ? err.message : err) })
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()

  const mock = {
    port,
    get wsUrl() {
      return `ws://127.0.0.1:${port}/ws/voice`
    },
    get url() {
      return `ws://127.0.0.1:${port}`
    },
    get scenario() {
      return state.scenario
    },
    get connections() {
      return state.connections
    },
    get sessionConfigs() {
      return state.sessionConfigs
    },
    get events() {
      return state.events
    },
    get audioFrames() {
      return state.audioFramesCount
    },
    get audioBytes() {
      return state.audioBytes
    },
    get textQueries() {
      return state.textQueries
    },
    setScenario(next) {
      state.scenario = next
      return mock
    },
    setPayloads(payloads) {
      state.payloads = { ...state.payloads, ...(payloads || {}) }
      return mock
    },
    reset() {
      state.scenario = 'ok'
      state.connections.length = 0
      state.sessionConfigs.length = 0
      state.events.length = 0
      state.audioFramesCount = 0
      state.audioBytes = 0
      state.textQueries.length = 0
      state.translationIndex = 0
      return mock
    },
    async close() {
      for (const conn of openConnections) {
        try {
          conn.destroy()
        } catch {
          /* ignore */
        }
      }
      openConnections.clear()
      await Promise.race([new Promise((resolve) => server.close(resolve)), sleep(1500)])
    },
  }
  return mock
}

// CLI：直接运行可常驻一个 mock 供手工排查（node --test 扫描时 NODE_TEST_CONTEXT 存在，不启动）
const isCli =
  !process.env.NODE_TEST_CONTEXT && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isCli) {
  const mock = await startMockVolc()
  console.log(`[mock-volc] listening on ${mock.wsUrl}`)
  console.log('[mock-volc] 把设置里的 volc.endpoint 指向该地址（ws://...）即可联调')
  console.log('[mock-volc] Ctrl+C 退出')
}
