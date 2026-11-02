/**
 * Ava · 豆包实时语音浏览器客户端（O2.0 二进制接口）（SPEC v1.4 §C3）
 *
 * 浏览器原生 ESM，零第三方依赖、不接触任何豆包/火山密钥。
 * 链路：麦克风 → AudioWorklet 重采样 16k mono s16le（20ms/640B）→
 *      本地服务桥 WebSocket `/ws/voice` → 火山端到端实时语音；
 *      服务端回传 JSON 事件 + 24k mono s16le PCM → 本模块队列播放并回调。
 *
 * AudioWorklet 不可用（旧 Safari 等）时自动回退 ScriptProcessor 重采样。
 *
 * @example
 * import { createDoubaoVoice } from './doubao-voice.js'
 *
 * const voice = createDoubaoVoice({
 *   level: 'A2',
 *   teacherName: 'Ava',
 *   onReady: ({ model, speaker }) => console.log('ready', model, speaker),
 *   onASR: ({ text, final }) => renderInterim(text, final),
 *   onChat: ({ text, final }) => renderReply(text, final),
 *   onAudioStart: () => avatar.beginSpeech({ text: '' }),
 *   onAudioEnd: () => avatar.endSpeech(),
 *   onLevel: (level) => avatar.setSpeechLevel(level),
 *   onError: (err) => toast(err.message),
 *   onEnded: ({ reason }) => setPhase('idle'),
 * })
 *
 * if (voice.isSupported) await voice.start({ mode: 'free' })
 * voice.interrupt() // 打断当前播放
 * voice.stop()      // 结束通话
 * voice.dispose()
 *
 * @module doubao-voice
 */

/* -------------------------------------------------------------------------- */
/* 常量 / 环境                                                                 */
/* -------------------------------------------------------------------------- */

import { apiWebSocketUrl } from './backend.js'

const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined'

/** Reserve an unlocked context during the tap, before a lazy module or network wait. */
let preparedAudioContext = null

function resumeAudioContext(ctx) {
  if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return
  try { Promise.resolve(ctx.resume()).catch(() => {}) } catch { /* next tap can retry */ }
}

export function prepareDoubaoAudio() {
  if (!IS_BROWSER) return false
  try {
    if (!preparedAudioContext || preparedAudioContext.state === 'closed') {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return false
      preparedAudioContext = new Ctx({ latencyHint: 'interactive' })
    }
    resumeAudioContext(preparedAudioContext)
    return true
  } catch { return false }
}

/** 本地服务桥 WebSocket 路径（SPEC v1.4 §B4）。 */
export const VOICE_WS_PATH = '/ws/voice'

/** 上行音频：16kHz mono s16le，20ms = 640 字节。 */
export const INPUT_SAMPLE_RATE = 16000
export const INPUT_CHUNK_BYTES = 640
export const INPUT_CHUNK_MS = 20

/** 下行音频：24kHz mono s16le（SPEC v1.4 §B4/B6）。 */
export const OUTPUT_SAMPLE_RATE = 24000

/** 建立 WebSocket 的超时（毫秒）。 */
const WS_OPEN_TIMEOUT_MS = 10_000
const SESSION_READY_TIMEOUT_MS = 25_000

/** stop() 后等待服务端 ended/close 的上限（毫秒）。 */
const STOP_TIMEOUT_MS = 4_000

/** 播放端最小调度粒度（约 20ms 的 24k 样本数）。 */
const PLAYBACK_MIN_SAMPLES = 480

/** 连接未就绪时待发音频缓冲上限（20ms/帧 → 100 帧≈2s，避免无限增长）。 */
const MAX_PENDING_AUDIO_FRAMES = 100

/** AudioWorklet 处理器名（需与 pcm-worklet.js 中 registerProcessor 一致）。 */
const WORKLET_PROCESSOR_NAME = 'ava-pcm-16k'

/* -------------------------------------------------------------------------- */
/* 错误文案                                                                    */
/* -------------------------------------------------------------------------- */

/** 语音链路错误码 → 中文可读文案。 */
export const VOICE_ERROR_MESSAGES = {
  unsupported: '当前环境不支持实时语音（需要麦克风、WebSocket 与 Web Audio），请更新系统或使用 Safari / Chrome。',
  denied: '麦克风权限被拒绝：请在系统设置中允许 Ava 使用麦克风；使用浏览器时，请同时检查网站麦克风权限。',
  'not-found': '未检测到麦克风：请连接麦克风后重试。',
  busy: '麦克风被占用：请关闭其它正在使用麦克风的程序后重试。',
  'secure-context': '麦克风需要安全上下文：请通过 http://127.0.0.1 或 https 打开本页面。',
  timeout: '语音连接超时：请检查网络和 Ava 服务连接后重试。',
  network: '语音连接失败：请检查网络和 Ava 服务连接后重试。',
  server: '语音服务返回错误，请重试。',
  closed: '语音连接已断开，请重新开始通话。',
  'not-configured': '尚未配置豆包实时语音凭据：请到设置页填写 App ID 与 API Key 后再试。',
  'audio-failed': '音频设备初始化失败，请检查系统声音输出设置后重试。',
  unknown: '实时语音出现未知错误，请重试。',
}

/**
 * 构造带 `code` 的语音错误（onError 参数风格：Error & {code}）。
 * @param {string} code
 * @param {string} [message]
 * @returns {Error & {code: string}}
 */
export function makeVoiceError(code, message) {
  const normalized = String(code || 'unknown')
  const text = message || VOICE_ERROR_MESSAGES[normalized] || VOICE_ERROR_MESSAGES.unknown
  const err = /** @type {Error & {code: string}} */ (new Error(text))
  err.name = 'VoiceError'
  err.code = normalized
  return err
}

/**
 * 把 getUserMedia 的底层异常翻译成中文语音错误。
 * @param {unknown} err
 * @returns {Error & {code: string}}
 */
export function mapMediaError(err) {
  const raw = /** @type {any} */ (err)
  const name = String((raw && raw.name) || '')
  if (IS_BROWSER && window.isSecureContext === false) {
    return makeVoiceError('secure-context')
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return makeVoiceError('denied')
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return makeVoiceError('not-found')
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return makeVoiceError('busy')
  }
  if (name === 'OverconstrainedError') {
    return makeVoiceError('denied', '麦克风不满足音频参数要求，请更换设备后重试。')
  }
  return makeVoiceError('denied', `无法访问麦克风：${(raw && raw.message) || name || '未知原因'}`)
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 安全执行回调：回调抛错不影响语音主流程。
 * @param {Function|undefined|null} fn
 * @param {...unknown} args
 * @returns {unknown}
 */
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return undefined
  try {
    return fn(...args)
  } catch (err) {
    console.error('[doubao-voice] 回调执行出错：', err)
    return undefined
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 当前浏览器是否具备实时语音所需能力（麦克风 + Web Audio + WebSocket）。
 * @returns {boolean}
 */
export function isDoubaoVoiceSupported() {
  if (!IS_BROWSER) return false
  const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null
  const Ctx = window.AudioContext || window.webkitAudioContext
  const hasWs = typeof window.WebSocket === 'function'
  const secure = window.isSecureContext !== false
  return !!(mediaDevices && typeof mediaDevices.getUserMedia === 'function' && Ctx && hasWs && secure)
}

/**
 * 线性插值重采样器（ScriptProcessor 回退路径用；与 pcm-worklet.js 算法一致）。
 */
class LinearResampler {
  /**
   * @param {number} inputRate
   * @param {number} targetRate
   * @param {number} chunkSamples 每个输出块样本数（16k × 20ms = 320）
   */
  constructor(inputRate, targetRate, chunkSamples) {
    this.ratio = Number(inputRate) / Number(targetRate)
    this.chunkSamples = Math.max(1, Math.round(chunkSamples))
    /** @type {Int16Array} */
    this.int16 = new Int16Array(this.chunkSamples)
    this.count = 0
    /** @type {Float32Array} */
    this.carry = new Float32Array(0)
    this.pos = 0
    /** @type {((chunk: Int16Array) => void)|null} */
    this.onChunk = null
  }

  /**
   * @param {number} value
   */
  emit(value) {
    const v = value > 1 ? 1 : value < -1 ? -1 : value
    this.int16[this.count] = v < 0 ? v * 0x8000 : v * 0x7fff
    this.count += 1
    if (this.count < this.chunkSamples) return
    const copy = this.int16.slice(0, this.chunkSamples)
    this.count = 0
    if (this.onChunk) this.onChunk(copy)
  }

  /**
   * 处理一块 Float32 音频（设备采样率）并回调 16k Int16 块。
   * @param {Float32Array} channel
   * @param {(chunk: Int16Array) => void} onChunk
   */
  process(channel, onChunk) {
    this.onChunk = onChunk
    if (!channel || !channel.length) return
    const src = new Float32Array(this.carry.length + channel.length)
    if (this.carry.length) src.set(this.carry, 0)
    src.set(channel, this.carry.length)
    let pos = this.pos
    const ratio = this.ratio
    while (pos + 1 < src.length) {
      const index = Math.floor(pos)
      const frac = pos - index
      const s0 = src[index]
      const s1 = src[index + 1]
      this.emit(s0 + (s1 - s0) * frac)
      pos += ratio
    }
    let keep = Math.floor(pos)
    if (keep > src.length - 1) keep = src.length - 1
    if (keep < 0) keep = 0
    this.carry = src.slice(keep)
    this.pos = pos - keep
  }
}

/* -------------------------------------------------------------------------- */
/* createDoubaoVoice                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 创建豆包实时语音客户端（浏览器侧）。
 *
 * 回调：
 * - `onReady({model, speaker, demo, character?, kb?, kbDocs?, kbMode?, kbDocIds?})`：服务端已建立火山会话；
 *   v1.6 起角色信息（`character:{id,name,voiceLabel}`）、v1.8 起知识库相关字段（若有）都会原样透传；
 * - `onASR({text, final})`：用户语音识别（interim 上字幕，final 记录用户消息并触发教练分析）；
 * - `onChat({text, final})`：Ava 回复文本流式字幕（与音频并行）；
 * - `onAudioStart()` / `onAudioEnd({reason})`：Ava 开始/结束说话（end 在播放队列真正排空后触发）；
 * - `onAudioProgress({bytes, at})`：每块下行音频的字节数与到达时间（供播放健康检查）；
 * - `onLevel(level01)`：0..1 播放振幅（RMS），直接驱动数字人口型；停止后回调 0；
 * - `onMicLevel(level01)`：可选，麦克风输入振幅（倾听光环）；
 * - `onError(err)`：`Error & {code, message 中文}`；
 * - `onEnded({reason})`：会话真正结束（服务端 ended / 连接关闭 / 失败）。
 *
 * 方法：`start(opts) → Promise<boolean>`、`stop() → boolean`、`interrupt() → boolean`、
 * `commit() → boolean`（PTT 松手提交本轮，服务端补静音触发 VAD 出句）、
 * `cancelTurn() → boolean`（取消本轮：清本地待发音频 + 发 interrupt）、
 * `pauseMic() → boolean`（暂停上行 PCM，保持麦克风/Worklet/WS 会话存活，PTT 结轮用）、
 * `resumeMic() → boolean`（恢复上行 PCM，下一轮 PTT 用）、
 * `dispose()`、`setHandlers(handlers)`；`isSupported` / `isActive` 为**布尔 getter 属性**。
 *
 * 诊断（只读、不改变行为，v2.6 PTT 排障用）：`isMicPaused`（boolean）、
 * `framesSent`（累计成功发送 PCM 帧数）、`lastFrameAt`（最后一次发送时间戳，未发为 0）、
 * `wsState`（readyState，无连接 -1）、`isReady`（会话是否 ready）。
 *
 * @param {{
 *   wsUrl?: string,
 *   url?: string,
 *   workletUrl?: string,
 *   readyTimeoutMs?: number,
 *   mode?: string,
 *   level?: string,
 *   teacherName?: string,
 *   docId?: string,
 *   characterId?: string,
 *   kbDocIds?: string[],
 *   kbMode?: 'free'|'grounded'|'divergent'|string,
 *   sceneId?: string,
 *   lessonId?: string,
 *   stageId?: string,
 *   lessonStep?: 1|2|3|number,
 *   onReady?: Function,
 *   onASR?: Function,
 *   onChat?: Function,
 *   onAudioStart?: Function,
 *   onAudioProgress?: Function,
 *   onAudioEnd?: Function,
 *   onLevel?: Function,
 *   onMicLevel?: Function,
 *   onError?: Function,
 *   onEnded?: Function,
 * }} [opts]
 * @returns {{
 *   start: (opts?: {mode?: string, level?: string, teacherName?: string, docId?: string, characterId?: string, kbDocIds?: string[], kbMode?: string, sceneId?: string, lessonId?: string, stageId?: string, lessonStep?: number}) => Promise<boolean>,
 *   stop: () => boolean,
 *   interrupt: () => boolean,
 *   commit: () => boolean,
 *   cancelTurn: () => boolean,
 *   pauseMic: () => boolean,
 *   resumeMic: () => boolean,
 *   dispose: () => void,
 *   setHandlers: (handlers: object) => void,
 *   isSupported: boolean,
 *   isActive: boolean,
 *   isReady: boolean,
 *   isMicPaused: boolean,
 *   framesSent: number,
 *   lastFrameAt: number,
 *   wsState: number,
 * }}
 */
export function createDoubaoVoice(opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {}

  /** @type {{onReady?: Function, onASR?: Function, onChat?: Function, onAudioStart?: Function, onAudioProgress?: Function, onAudioEnd?: Function, onLevel?: Function, onMicLevel?: Function, onError?: Function, onEnded?: Function}} */
  const handlers = {
    onReady: options.onReady,
    onASR: options.onASR,
    onChat: options.onChat,
    onAudioStart: options.onAudioStart,
    onAudioProgress: options.onAudioProgress,
    onAudioEnd: options.onAudioEnd,
    onLevel: options.onLevel,
    onMicLevel: options.onMicLevel,
    onError: options.onError,
    onEnded: options.onEnded,
  }

  /* ------------------------------ 运行状态 ------------------------------ */

  /** @type {WebSocket|null} */
  let ws = null
  /** 已 start、尚未结束。 */
  let active = false
  /** start() 进行中（WS 建链/权限/音频图初始化）。 */
  let starting = false
  /** stop() 已发出、等待服务端结束。 */
  let stopping = false
  /** 服务端 ready 事件已收到。 */
  let ready = false
  /** 本次会话是否已尝试过重连（只重连一次）。 */
  let reconnectTried = false
  /** onEnded 只回调一次。 */
  let endedEmitted = false
  /** 正在关闭/已摘除事件，忽略在途消息（避免 "Data frame received after close" 噪音） */
  let closingSocket = false
  let disposed = false
  /** @type {object|null} */
  let startFrame = null
  let startPromise = null
  let sessionGeneration = 0
  let cancelSocketOpen = null
  let cancelCaptureStart = null
  let readyWaiter = null
  let pendingReadyInfo = null

  /** @type {ReturnType<typeof setTimeout>|null} */
  let stopTimer = null
  let outputMuted = options.outputMuted === true

  /* ------------------------------ 音频采集 ------------------------------ */

  /** @type {MediaStream|null} */
  let mediaStream = null
  /** @type {AudioContext|null} */
  let audioCtx = null
  /** @type {MediaStreamAudioSourceNode|null} */
  let micSource = null
  /** @type {AudioWorkletNode|null} */
  let workletNode = null
  /** @type {ScriptProcessorNode|null} */
  let scriptNode = null
  /** @type {GainNode|null} */
  let muteGain = null
  /** @type {LinearResampler|null} */
  let fallbackResampler = null
  let micLevelAt = 0
  /** 连接未就绪时的极小待发音频缓冲（≤2s）；正常连接时始终为空、逐帧直发 */
  /** @type {ArrayBuffer[]} */
  let pendingAudio = []
  /** 麦克风暂停（PTT 结轮后停止上行 PCM，但保持 getUserMedia/Worklet/WS 会话存活） */
  let micPaused = false
  // v3.7：PTT 模式静音门限（只发送有效声音帧，避免服务端 VAD 被呼吸/长停顿触发自动出句）
  let pttGateMode = false
  let pttGateLastLoudAt = 0
  let pttGateFrames = 0
  const PTT_GATE_RMS = 0.0025
  const PTT_GATE_HANGOVER_MS = 500
  /** 诊断计数：自创建以来成功 ws.send 的 PCM 帧数（每帧 640B）；经只读 getter 暴露 */
  let framesSent = 0
  let lastAudioAt = 0
  /** 诊断时间戳：最后一次成功发送 PCM 的 Date.now（从未发送为 0） */
  let lastFrameAt = 0

  /* ------------------------------ 播放队列 ------------------------------ */

  /** @type {GainNode|null} */
  let playbackGain = null
  /** @type {Set<AudioBufferSourceNode>} */
  const sources = new Set()
  /** @type {Int16Array[]} */
  let pendingChunks = []
  let pendingSamples = 0
  let nextPlayTime = 0
  let speaking = false
  let audioEndPending = false
  /** @type {ReturnType<typeof setTimeout>|null} */
  let audioEndTimer = null
  let lastLevel = 0
  let levelEmitAt = 0

  /* ------------------------------ 通用回调 ------------------------------ */

  /**
   * @param {Error & {code: string}} err
   */
  function emitError(err) {
    safeCall(handlers.onError, err)
  }

  /**
   * @param {string} reason
   */
  function emitEnded(reason) {
    if (endedEmitted || disposed) return
    endedEmitted = true
    ready = false
    safeCall(handlers.onEnded, { reason })
  }

  /* ------------------------------ WebSocket ------------------------------ */

  /**
   * @returns {string} ws(s)://<host>/ws/voice（可用 opts.wsUrl / opts.url 覆盖）
   */
  function buildWsUrl() {
    if (typeof options.wsUrl === 'string' && options.wsUrl) return options.wsUrl
    if (typeof options.url === 'string' && options.url) return options.url
    return apiWebSocketUrl(VOICE_WS_PATH)
  }

  /**
   * 发送 JSON 文本帧（未连接时静默丢弃）。
   * @param {object} payload
   * @returns {boolean}
   */
  function sendJSON(payload) {
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  /**
   * 重连未就绪时暂存一帧音频（上限 100 帧≈2s）；初次启动在 ready 后才采音。
   * @param {ArrayBuffer} buffer
   */
  function queueAudioFrame(buffer) {
    if (!buffer) return
    if (pendingAudio.length >= MAX_PENDING_AUDIO_FRAMES) pendingAudio.shift()
    pendingAudio.push(buffer)
  }

  /**
   * 记录一帧 PCM 成功发送（仅诊断计数，不改变任何行为）。
   */
  function recordFrameSent() {
    framesSent += 1
    lastFrameAt = Date.now()
  }

  /**
   * 把待发音频缓冲按顺序发出去（连接未就绪时返回 false）。
   * @returns {boolean} 是否确实发出了缓冲帧
   */
  function flushPendingAudio() {
    if (!pendingAudio.length) return false
    if (!ready || !ws || ws.readyState !== 1) return false
    const frames = pendingAudio
    pendingAudio = []
    for (const frame of frames) {
      try {
        ws.send(frame)
        recordFrameSent()
      } catch {
        /* 连接中途坏了，剩余帧丢弃 */
      }
    }
    return true
  }

  /**
   * 发送 16k s16le 二进制音频帧（640 字节/20ms）。
   * 正常连接时立即发送（与旧版行为一致）；未连接/发送失败时暂存到待发缓冲，
   * 供 `commit()` 前 flush 或 `cancelTurn()` 丢弃。
   * @param {ArrayBuffer} buffer
   */
  function frameRms(buffer) {
    try {
      const pcm = new Int16Array(buffer)
      let sum = 0
      const len = Math.min(pcm.length, 4096)
      for (let i = 0; i < len; i += 1) {
        const v = pcm[i] / 32768
        sum += v * v
      }
      return len ? Math.sqrt(sum / len) : 0
    } catch {
      return 0
    }
  }

  function reportMicLevel(rms) {
    if (typeof handlers.onMicLevel !== 'function') return
    const time = Date.now()
    if (time - micLevelAt < 80) return
    micLevelAt = time
    safeCall(handlers.onMicLevel, Math.max(0, Math.min(1, rms * 4)))
  }

  function sendPCM(buffer) {
    if (!buffer || !active) return
    // PTT 结轮后暂停上行：不发送、不暂存、不更新麦克风电平（音频图/连接仍存活）
    if (micPaused) return
    const rms = frameRms(buffer)
    reportMicLevel(rms)
    // v3.7：PTT 录音期间只发送“有声音”的帧（含 320ms hangover）。
    // 否则呼吸/长停顿的连续静音帧会让服务端 VAD 在用户点结束前自动断句并让角色自说自话。
    if (pttGateMode) {
      const now = Date.now()
      if (rms >= PTT_GATE_RMS) {
        pttGateLastLoudAt = now
      } else if (now - pttGateLastLoudAt > PTT_GATE_HANGOVER_MS) {
        pttGateFrames += 1
        return
      }
    }
    if (ready && ws && ws.readyState === 1) {
      try {
        flushPendingAudio()
        ws.send(buffer)
        recordFrameSent()
      } catch {
        /* 连接已坏：暂存，等 commit 前尝试补发 */
        queueAudioFrame(buffer)
      }
    } else {
      queueAudioFrame(buffer)
    }
  }

  /**
   * 暂停麦克风上行（PTT 结轮用，SPEC v2.4）：**只停止把采集 PCM 发到 WS**，
   * getUserMedia / AudioWorklet / WebSocket 会话全部保持存活（不断连、不触发 onEnded）。
   *
   * 用于修复「点结束只发 commit、麦克风还在推流 → 服务端 VAD 继续识别/回话」的问题。
   * 暂停期间会丢弃待发缓冲，避免恢复后补发过期音频；`commit()` / `cancelTurn()` 仍可正常发送。
   *
   * @returns {boolean} 是否已进入暂停状态（未激活/已 dispose 返回 false，不抛错）
   */
  function pauseMic() {
    if (disposed || !active) return false
    micPaused = true
    pendingAudio = []
    return true
  }

  /**
   * 恢复麦克风上行（下一轮 PTT 按下时调用）。音频图与连接原本就存活，恢复后继续按 20ms/640B 发送。
   * @returns {boolean} 是否已恢复发送（未激活/已 dispose 返回 false，不抛错）
   */
  function resumeMic() {
    if (disposed || !active || !ready) return false
    prepareAudio()
    micPaused = false
    return true
  }

  /** 本地 WebSocket 已打开不代表上游会话已就绪。所有启动/重连共用这个门禁。 */
  function waitForReady() {
    if (ready) return Promise.resolve(true)
    if (readyWaiter) return readyWaiter.promise
    const requested = Number(options.readyTimeoutMs)
    const timeoutMs = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, 60_000)
      : SESSION_READY_TIMEOUT_MS
    const waiter = { promise: null, resolve: null, reject: null, timer: null }
    waiter.promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve
      waiter.reject = reject
    })
    waiter.timer = setTimeout(() => {
      settleReady(makeVoiceError('timeout', '上游语音会话未能就绪，请重试。'))
    }, timeoutMs)
    readyWaiter = waiter
    return waiter.promise
  }

  function settleReady(error = null) {
    const waiter = readyWaiter
    if (!waiter) return false
    readyWaiter = null
    clearTimeout(waiter.timer)
    if (error) waiter.reject(error)
    else waiter.resolve(true)
    return true
  }

  function cancelPendingStart() {
    sessionGeneration += 1
    startPromise = null
    pendingReadyInfo = null
    settleReady(makeVoiceError('cancelled', '语音连接已取消。'))
    if (cancelSocketOpen) cancelSocketOpen()
    if (cancelCaptureStart) cancelCaptureStart()
  }

  /**
   * 打开 WebSocket，resolve 已 connected 的 socket。
   * @returns {Promise<WebSocket>}
   */
  function openSocket() {
    return new Promise((resolve, reject) => {
      let socket = null
      let settled = false
      let timer = null
      const cleanupOpening = () => {
        if (timer) clearTimeout(timer)
        if (cancelSocketOpen === cancel) cancelSocketOpen = null
      }
      const rejectOpening = (error) => {
        if (settled) return
        settled = true
        cleanupOpening()
        if (socket) {
          socket.onopen = null
          socket.onmessage = null
          socket.onclose = null
          socket.onerror = null
          try { socket.close() } catch { /* ignored */ }
        }
        reject(error)
      }
      const cancel = () => rejectOpening(makeVoiceError('cancelled', '语音连接已取消。'))
      cancelSocketOpen = cancel
      timer = setTimeout(() => rejectOpening(makeVoiceError('timeout')), WS_OPEN_TIMEOUT_MS)

      const connect = (url) => {
        // A ticket may finish after hangup. Never open that cancelled transport.
        if (settled) return
        try { socket = new WebSocket(url) } catch {
          rejectOpening(makeVoiceError('network', '无法建立语音连接，请检查服务地址与网络。'))
          return
        }
        socket.binaryType = 'arraybuffer'
        socket.onopen = () => {
          if (settled) return
          settled = true
          cleanupOpening()
          resolve(socket)
        }
        socket.onerror = () => {
          if (!settled) rejectOpening(makeVoiceError('network'))
        }
        socket.onmessage = (event) => {
          if (settled && ws === socket) handleSocketMessage(event)
        }
        socket.onclose = (event) => {
          if (!settled) {
            rejectOpening(makeVoiceError('closed'))
            return
          }
          if (ws === socket) handleSocketClosed(event)
        }
      }
      try {
        const url = buildWsUrl()
        if (url && typeof url.then === 'function') {
          url.then(connect, () => rejectOpening(makeVoiceError('network', '语音连接授权失败，请检查服务连接后重试。')))
        } else connect(url)
      } catch {
        rejectOpening(makeVoiceError('network'))
      }
    })
  }

  /**
   * 处理服务端消息（JSON 文本或 24k PCM 二进制）。
   * @param {MessageEvent} event
   */
  function handleSocketMessage(event) {
    if (disposed || closingSocket) return
    const data = event.data
    if (typeof data === 'string') {
      handleServerEvent(data)
      return
    }
    if (data instanceof ArrayBuffer) {
      handleBinaryPcm(data)
      return
    }
    if (data && typeof data.arrayBuffer === 'function') {
      const generation = sessionGeneration
      data
        .arrayBuffer()
        .then((buffer) => { if (generation === sessionGeneration) handleBinaryPcm(buffer) })
        .catch(() => {})
    }
  }

  /**
   * 处理服务端 JSON 事件（SPEC v1.4 §B4）。
   * @param {string} raw
   */
  function handleServerEvent(raw) {
    /** @type {any} */
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (!payload || typeof payload !== 'object') return
    if (stopping && payload.type !== 'ended') return

    switch (payload.type) {
      case 'ready': {
        if (!active || stopping) return
        ready = true
        settleReady()
        if (!micPaused) flushPendingAudio()
        /** @type {{model: string, speaker: string, demo: boolean, character?: object}} */
        const readyInfo = {
          model: typeof payload.model === 'string' ? payload.model : '',
          speaker: typeof payload.speaker === 'string' ? payload.speaker : '',
          demo: !!payload.demo,
        }
        // SPEC v1.6 §B5：服务端可能带 character:{id,name,voiceLabel}，原样透传
        if (payload.character && typeof payload.character === 'object') readyInfo.character = payload.character
        // SPEC v1.8 §A5：服务端可能带知识库相关字段（kb / kbDocs / kbMode / kbDocIds），有则透传
        for (const key of ['kb', 'kbDocs', 'kbMode', 'kbDocIds']) {
          if (payload[key] !== undefined && payload[key] !== null) readyInfo[key] = payload[key]
        }
        // 初次启动还需取得麦克风；避免权限弹窗期间 UI 已显示“正在录音”。
        if (starting) pendingReadyInfo = readyInfo
        else safeCall(handlers.onReady, readyInfo)
        break
      }
      case 'asr':
        safeCall(handlers.onASR, {
          text: typeof payload.text === 'string' ? payload.text : '',
          final: !!payload.final,
        })
        break
      case 'chat':
        safeCall(handlers.onChat, {
          text: typeof payload.text === 'string' ? payload.text : '',
          final: !!payload.final,
        })
        break
      case 'audio-start':
        beginSpeaking()
        break
      case 'audio-end':
        handleServerAudioEnd()
        break
      case 'error': {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : VOICE_ERROR_MESSAGES.server
        const err = makeVoiceError('server', message);
        /** @type {any} */ (err).code = typeof payload.code === 'string' ? payload.code : 'server'
        if (!settleReady(err)) emitError(err)
        break
      }
      case 'ended':
        finish('ended')
        break
      default:
        break
    }
  }

  /**
   * WebSocket 关闭处理：意外断线尝试重连一次，其余情况收尾。
   * @param {CloseEvent} event
   */
  function handleSocketClosed(event) {
    ws = null
    ready = false
    if (disposed) return
    if (settleReady(makeVoiceError('closed'))) return
    if (stopping) {
      finish('closed')
      return
    }
    if (!active && !starting) {
      finish('closed')
      return
    }
    if (!reconnectTried) {
      reconnectTried = true
      emitError(makeVoiceError('closed', '语音连接断开，正在尝试重新连接…'))
      void attemptReconnect()
      return
    }
    emitError(makeVoiceError('closed'))
    finish('closed')
  }

  /** 断线后尝试重连一次（麦克风采集保持，重连成功后重发 start 帧）。 */
  async function attemptReconnect() {
    const generation = sessionGeneration
    try {
      await delay(300)
      if (!active || disposed || generation !== sessionGeneration) return
      const socket = await openSocket()
      if (!active || disposed || generation !== sessionGeneration) {
        socket.close()
        return
      }
      ws = socket
      ready = false
      const readyPromise = waitForReady()
      if (startFrame) sendJSON(startFrame)
      await readyPromise
    } catch {
      if (!active || disposed || generation !== sessionGeneration) return
      emitError(makeVoiceError('network', '语音重连失败，请重新开始通话。'))
      if (generation !== sessionGeneration) return
      finish('error')
    }
  }

  /* ------------------------------ 音频播放 ------------------------------ */

  /** 确保 AudioContext（采集与播放共用）。 @returns {AudioContext|null} */
  function ensureAudioContext() {
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    try {
      audioCtx = preparedAudioContext && preparedAudioContext.state !== 'closed'
        ? preparedAudioContext : new Ctx({ latencyHint: 'interactive' })
      preparedAudioContext = null
      playbackGain = audioCtx.createGain()
      playbackGain.gain.value = outputMuted ? 0 : 1
      playbackGain.connect(audioCtx.destination)
    } catch (err) {
      console.error('[doubao-voice] 创建 AudioContext 失败：', err)
      audioCtx = null
      return null
    }
    return audioCtx
  }

  /** Call synchronously from the user gesture, before any network await. */
  function prepareAudio() {
    const ctx = ensureAudioContext()
    resumeAudioContext(ctx)
    return !!ctx
  }

  /** 开始说话（audio-start 事件或首个音频帧）。 */
  function beginSpeaking() {
    if (speaking) return
    speaking = true
    audioEndPending = false
    safeCall(handlers.onAudioStart, {})
  }

  /**
   * 收到二进制 PCM（24k s16le mono）。
   * @param {ArrayBuffer} buffer
   */
  function handleBinaryPcm(buffer) {
    if (disposed || !active || stopping || closingSocket || !buffer) return
    const bytes = buffer.byteLength
    if (bytes < 2) return
    const usable = bytes - (bytes % 2)
    const int16 = new Int16Array(buffer.slice(0, usable))
    lastAudioAt = Date.now()
    safeCall(handlers.onAudioProgress, { bytes: usable, at: lastAudioAt })
    pendingChunks.push(int16)
    pendingSamples += int16.length
    if (pendingSamples >= PLAYBACK_MIN_SAMPLES) flushPlayback()
  }

  /** 把累积的 PCM 合并后调度播放。 */
  function flushPlayback() {
    if (!pendingSamples) return
    const ctx = ensureAudioContext()
    if (!ctx) return
    const total = pendingSamples
    const merged = new Int16Array(total)
    let offset = 0
    for (const chunk of pendingChunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    pendingChunks = []
    pendingSamples = 0
    schedulePcm(merged)
  }

  /**
   * 调度一块 24k PCM 播放。
   * @param {Int16Array} int16
   */
  function schedulePcm(int16) {
    const ctx = ensureAudioContext()
    if (!ctx || !int16.length) return
    resumeAudioContext(ctx)
    let buffer
    try {
      buffer = ctx.createBuffer(1, int16.length, OUTPUT_SAMPLE_RATE)
    } catch {
      return
    }
    const channel = buffer.getChannelData(0)
    let sum = 0
    for (let i = 0; i < int16.length; i += 1) {
      const v = int16[i] / 32768
      channel[i] = v
      sum += v * v
    }
    const rms = Math.sqrt(sum / int16.length)

    beginSpeaking()

    let source
    try {
      source = ctx.createBufferSource()
      source.buffer = buffer
      if (playbackGain) source.connect(playbackGain)
      else source.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime + 0.03, nextPlayTime)
      source.start(startAt)
      nextPlayTime = startAt + buffer.duration
    } catch (err) {
      console.warn('[doubao-voice] 播放调度失败：', err)
      return
    }
    sources.add(source)
    source.onended = () => {
      sources.delete(source)
      try { source.disconnect() } catch { /* already disconnected */ }
    }
    emitLevel(rms)
    if (audioEndPending) scheduleAudioEndCheck()
  }

  /**
   * 把播放 RMS 平滑成 0..1 电平回调（驱动数字人口型）。
   * @param {number} rms
   */
  function emitLevel(rms) {
    const scaled = Math.max(0, Math.min(1, rms * 3.2))
    lastLevel = lastLevel * 0.55 + scaled * 0.45
    safeCall(handlers.onLevel, lastLevel)
  }

  /** 服务端 audio-end：等播放队列真正排空后再回调 onAudioEnd。 */
  function handleServerAudioEnd() {
    flushPlayback()
    if (!speaking) {
      safeCall(handlers.onAudioEnd, { reason: 'ended' })
      return
    }
    audioEndPending = true
    scheduleAudioEndCheck()
  }

  /** 轮询播放队列，播完后触发 onAudioEnd 并复位电平。 */
  function scheduleAudioEndCheck() {
    if (audioEndTimer) return
    const tick = () => {
      audioEndTimer = null
      if (disposed || !audioEndPending) return
      const ctx = audioCtx
      const remaining = ctx ? nextPlayTime - ctx.currentTime : 0
      if (!ctx || remaining <= 0.03) {
        audioEndPending = false
        speaking = false
        lastLevel = 0
        safeCall(handlers.onLevel, 0)
        safeCall(handlers.onAudioEnd, { reason: 'ended' })
        return
      }
      audioEndTimer = setTimeout(tick, Math.max(30, Math.min(200, remaining * 1000)))
    }
    audioEndTimer = setTimeout(tick, 30)
  }

  /**
   * 清空播放队列（打断/结束时用）。
   * @param {string} reason
   */
  function clearPlayback(reason) {
    if (audioEndTimer) {
      clearTimeout(audioEndTimer)
      audioEndTimer = null
    }
    audioEndPending = false
    pendingChunks = []
    pendingSamples = 0
    nextPlayTime = 0
    for (const source of sources) {
      try {
        source.stop()
      } catch {
        /* 已结束 */
      }
      try {
        source.disconnect()
      } catch {
        /* 忽略 */
      }
    }
    sources.clear()
    const wasSpeaking = speaking
    speaking = false
    lastLevel = 0
    if (wasSpeaking) {
      safeCall(handlers.onLevel, 0)
      safeCall(handlers.onAudioEnd, { reason })
    }
  }

  /* ------------------------------ 音频采集 ------------------------------ */

  /** 释放麦克风与音频图（不关闭 AudioContext，播放还要用）。 */
  function stopCapture() {
    // 停止采集时丢弃尚未发出的音频帧（PTT cancelTurn/stop 语义）
    pendingAudio = []
    if (workletNode) {
      try {
        workletNode.port.onmessage = null
      } catch {
        /* 忽略 */
      }
      try {
        workletNode.disconnect()
      } catch {
        /* 忽略 */
      }
      workletNode = null
    }
    if (scriptNode) {
      try {
        scriptNode.onaudioprocess = null
      } catch {
        /* 忽略 */
      }
      try {
        scriptNode.disconnect()
      } catch {
        /* 忽略 */
      }
      scriptNode = null
    }
    if (micSource) {
      try {
        micSource.disconnect()
      } catch {
        /* 忽略 */
      }
      micSource = null
    }
    if (muteGain) {
      try {
        muteGain.disconnect()
      } catch {
        /* 忽略 */
      }
      muteGain = null
    }
    fallbackResampler = null
    if (mediaStream) {
      try {
        for (const track of mediaStream.getTracks()) track.stop()
      } catch {
        /* 忽略 */
      }
      mediaStream = null
    }
  }

  /**
   * 启动麦克风采集：AudioWorklet 优先，失败回退 ScriptProcessor。
   * @returns {Promise<void>}
   */
  async function startCapture(generation) {
    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw makeVoiceError('unsupported')
    }
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      })
      if (generation !== sessionGeneration || !active || stopping || disposed) {
        for (const track of stream.getTracks()) track.stop()
        throw makeVoiceError('cancelled', '语音连接已取消。')
      }
      mediaStream = stream
    } catch (err) {
      if (err && err.code === 'cancelled') throw err
      throw mapMediaError(err)
    }

    const ctx = ensureAudioContext()
    if (!ctx) {
      throw makeVoiceError('audio-failed', '当前浏览器不支持 Web Audio，无法采集麦克风。')
    }
    let resumeTimer
    try {
      if (ctx.state !== 'running') {
        await Promise.race([
          ctx.resume(),
          new Promise((_, reject) => {
            resumeTimer = setTimeout(() => reject(makeVoiceError('audio-failed', '音频暂未启动，请再次点击麦克风；若有来电或其他音频，请结束后重试。')), 4_000)
          }),
        ])
        if (ctx.state !== 'running') throw makeVoiceError('audio-failed', '音频已被系统暂停，请再次点击麦克风继续。')
      }
    } catch (err) {
      if (err && err.name === 'VoiceError') throw err
      throw makeVoiceError('audio-failed', '音频启动失败，请再次点击麦克风并检查系统权限。')
    } finally { clearTimeout(resumeTimer) }
    if (generation !== sessionGeneration || !active || stopping || disposed) {
      throw makeVoiceError('cancelled', '语音连接已取消。')
    }
    try {
      micSource = ctx.createMediaStreamSource(mediaStream)
    } catch (err) {
      throw makeVoiceError('audio-failed', `麦克风音频图初始化失败：${(err && /** @type {any} */ (err).message) || err}`)
    }
    muteGain = ctx.createGain()
    muteGain.gain.value = 0
    muteGain.connect(ctx.destination)

    if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function' && typeof AudioWorkletNode === 'function') {
      try {
        const workletUrl = typeof options.workletUrl === 'string' && options.workletUrl
          ? options.workletUrl
          : new URL('./pcm-worklet.js', import.meta.url).href
        await ctx.audioWorklet.addModule(workletUrl)
        if (generation !== sessionGeneration || !active || stopping || disposed) {
          throw makeVoiceError('cancelled', '语音连接已取消。')
        }
        const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          processorOptions: { targetRate: INPUT_SAMPLE_RATE, chunkMs: INPUT_CHUNK_MS },
        })
        node.port.onmessage = (event) => {
          const message = event.data
          if (message && message.type === 'pcm' && message.buffer) sendPCM(message.buffer)
        }
        micSource.connect(node)
        node.connect(muteGain)
        workletNode = node
        return
      } catch (err) {
        if (err && err.code === 'cancelled') throw err
        console.warn('[doubao-voice] AudioWorklet 不可用，回退 ScriptProcessor：', err)
        if (workletNode) {
          try {
            workletNode.disconnect()
          } catch {
            /* 忽略 */
          }
          workletNode = null
        }
      }
    }

    // ScriptProcessor 回退（旧 Safari / AudioWorklet 加载失败）
    const processor = ctx.createScriptProcessor ? ctx.createScriptProcessor(2048, 1, 1) : null
    if (!processor) {
      throw makeVoiceError('audio-failed', '当前浏览器无法进行麦克风重采样，请改用 Chrome / Edge。')
    }
    const chunkSamples = Math.round((INPUT_SAMPLE_RATE * INPUT_CHUNK_MS) / 1000)
    fallbackResampler = new LinearResampler(ctx.sampleRate, INPUT_SAMPLE_RATE, chunkSamples)
    processor.onaudioprocess = (event) => {
      if (!active || disposed) return
      const input = event.inputBuffer.getChannelData(0)
      fallbackResampler.process(input, (int16) => {
        const copy = new Int16Array(int16)
        sendPCM(copy.buffer)
      })
    }
    micSource.connect(processor)
    processor.connect(muteGain)
    scriptNode = processor
  }

  async function waitForCapture(generation) {
    let cancel
    const cancelled = new Promise((resolve, reject) => {
      cancel = () => reject(makeVoiceError('cancelled', '语音连接已取消。'))
    })
    cancelCaptureStart = cancel
    try {
      // 浏览器权限弹窗不可取消；停止通话先结束等待，迟到的 stream 会按 generation 释放。
      await Promise.race([startCapture(generation), cancelled])
    } finally {
      if (cancelCaptureStart === cancel) cancelCaptureStart = null
    }
  }

  /* ------------------------------ 会话生命周期 ------------------------------ */

  /**
   * 构造 start 帧（**绝不包含任何密钥**，凭据只在服务端）。
   * @param {object} startOpts
   * @returns {object}
   */
  function buildStartFrame(startOpts) {
    const merged = {
      mode: startOpts.mode || options.mode || 'free',
      level: startOpts.level || options.level || 'A2',
      teacherName: startOpts.teacherName || options.teacherName || 'Ava',
      docId: startOpts.docId || options.docId || '',
      // SPEC v1.6 §B5：手机版角色会话，服务端按 characterId 选择人设 + 音色；不传则与旧版完全一致
      characterId: startOpts.characterId || options.characterId || '',
      // SPEC v1.8 §A5：知识库讨论参数（服务端据此注入 KB 要点）；不传则与旧版完全一致
      kbMode: startOpts.kbMode || options.kbMode || '',
      kbDocIds: Array.isArray(startOpts.kbDocIds)
        ? startOpts.kbDocIds
        : Array.isArray(options.kbDocIds)
          ? options.kbDocIds
          : [],
      // SPEC v3.0：课程-场景教学字段（有值才写入；不传时 start 帧与旧版完全一致）
      sceneId: startOpts.sceneId || options.sceneId || '',
      lessonId: startOpts.lessonId || options.lessonId || '',
      stageId: startOpts.stageId || options.stageId || '',
      lessonStep: startOpts.lessonStep !== undefined ? startOpts.lessonStep : options.lessonStep,
      // v3.6：最近对话上下文（会话重连/重置后仍然记得前文）
      history: Array.isArray(startOpts.history) ? startOpts.history : Array.isArray(options.history) ? options.history : [],
      // v3.7：PTT 模式（服务端据此使用更长的 VAD 窗口 + commit 静音）
      ptt: startOpts.ptt === true || options.ptt === true,
    }
    /** @type {Record<string, unknown>} */
    const frame = {
      type: 'start',
      mode: String(merged.mode || 'free'),
      level: String(merged.level || 'A2'),
      teacherName: String(merged.teacherName || 'Ava'),
    }
    if (merged.ptt) frame.ptt = true
    if (merged.docId) frame.docId = String(merged.docId)
    if (merged.characterId) frame.characterId = String(merged.characterId)
    if (merged.kbMode) frame.kbMode = String(merged.kbMode)
    if (Array.isArray(merged.kbDocIds) && merged.kbDocIds.length) {
      const kbDocIds = merged.kbDocIds
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim())
        .slice(0, 50)
      if (kbDocIds.length) frame.kbDocIds = kbDocIds
    }
    // 课程字段：只有有值/合法时才写入
    if (merged.sceneId) frame.sceneId = String(merged.sceneId)
    if (merged.lessonId) frame.lessonId = String(merged.lessonId)
    if (merged.stageId) frame.stageId = String(merged.stageId)
    const lessonStep = Number(merged.lessonStep)
    if (Number.isFinite(lessonStep) && lessonStep > 0) {
      frame.lessonStep = Math.min(3, Math.max(1, Math.round(lessonStep)))
    }
    // 最近对话历史：只传 user/assistant 文本，限 24 条、每条 300 字，避免超过服务端限制
    if (Array.isArray(merged.history) && merged.history.length) {
      const history = merged.history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-24)
        .map((m) => ({ role: m.role, content: String(m.content).trim().slice(0, 300) }))
      if (history.length) frame.history = history
    }
    return frame
  }

  /** 清理定时器。 */
  function clearTimers() {
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
    if (audioEndTimer) {
      clearTimeout(audioEndTimer)
      audioEndTimer = null
    }
  }

  /**
   * 收尾：停采集、清播放、关连接、触发 onEnded。
   * @param {'ended'|'closed'|'error'|'dispose'} reason
   */
  function finish(reason) {
    cancelPendingStart()
    micPaused = false
    if (endedEmitted && (reason === 'ended' || reason === 'closed')) {
      // 已结束过，只做资源清理
      stopCapture()
      clearPlayback(reason)
      closeSocket()
      return
    }
    stopping = false
    active = false
    starting = false
    clearTimers()
    stopCapture()
    clearPlayback(reason)
    // 服务端 ended 后通常还会自行关闭连接：客户端稍等再关，避免"关闭后仍有在途帧"的浏览器告警
    closeSocket(reason === 'ended' ? 250 : 0)
    emitEnded(reason)
  }

  /**
   * 关闭 WebSocket（先摘除事件并置 closingSocket，忽略在途消息）。
   * @param {number} [delayMs=0] 延迟关闭毫秒数（服务端 ended 后留出收尾时间）
   */
  function closeSocket(delayMs = 0) {
    if (cancelSocketOpen) cancelSocketOpen()
    if (!ws) return
    const socket = ws
    ws = null
    closingSocket = true
    ready = false
    try {
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.onopen = null
    } catch {
      /* 忽略 */
    }
    const doClose = () => {
      try {
        socket.close(1000, 'bye')
      } catch {
        /* 忽略 */
      }
    }
    if (delayMs > 0) setTimeout(doClose, delayMs)
    else doClose()
  }

  /**
   * 开始实时语音通话。
   * @param {{mode?: string, level?: string, teacherName?: string, docId?: string, characterId?: string, kbDocIds?: string[], kbMode?: string, sceneId?: string, lessonId?: string, stageId?: string, lessonStep?: number}} [startOpts]
   * @returns {Promise<boolean>} true=上游 ready 且麦克风采集已启动；false=失败或取消（取消不报错）
   */
  async function start(startOpts = {}) {
    if (startPromise) return startPromise
    if (active || starting) return ready && active
    if (disposed) {
      emitError(makeVoiceError('unsupported', '语音客户端已释放，请重新创建。'))
      return false
    }
    if (!isDoubaoVoiceSupported()) {
      emitError(makeVoiceError('unsupported'))
      return false
    }
    if (typeof options.wsUrl !== 'string' && typeof options.url !== 'string' && IS_BROWSER) {
      // 同源 ws 由 location 推导，无需额外校验
    }

    prepareAudio()

    // stop() 会等待旧服务端收尾；立即 start() 时先隔离旧连接，避免迟到 ended 结束新会话。
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
    closeSocket()
    starting = true
    endedEmitted = false
    reconnectTried = false
    closingSocket = false
    ready = false
    stopping = false
    pendingReadyInfo = null
    micPaused = Boolean(startOpts && startOpts.startPaused === true)
    pttGateMode = Boolean(startOpts && startOpts.ptt === true)
    pttGateLastLoudAt = 0
    pttGateFrames = 0
    startFrame = buildStartFrame(startOpts && typeof startOpts === 'object' ? startOpts : {})
    const generation = ++sessionGeneration
    startPromise = (async () => {
      try {
        const socket = await openSocket()
        if (generation !== sessionGeneration || disposed || stopping) {
          socket.close()
          return false
        }
        ws = socket
        active = true
        const readyPromise = waitForReady()
        // ready 前不采音、不宣告启动成功，避免首句被尚未就绪的上游静默丢弃。
        if (!sendJSON(startFrame)) settleReady(makeVoiceError('network'))
        await readyPromise
        if (generation !== sessionGeneration || !active || disposed || stopping) return false
        await waitForCapture(generation)
        if (generation !== sessionGeneration || !active || disposed || stopping) return false
        starting = false
        const readyInfo = pendingReadyInfo
        pendingReadyInfo = null
        if (readyInfo) safeCall(handlers.onReady, readyInfo)
        return generation === sessionGeneration && active && ready
      } catch (err) {
        if (generation !== sessionGeneration || disposed || stopping) return false
        const mapped = err && /** @type {any} */ (err).name === 'VoiceError' ? /** @type {any} */ (err) : makeVoiceError('network')
        if (mapped.code !== 'cancelled') emitError(mapped)
        // onError 可能同步让上层停止/重建；不要再清理新一轮资源。
        if (generation !== sessionGeneration) return false
        finish('error')
        return false
      } finally {
        if (generation === sessionGeneration) startPromise = null
      }
    })()
    return startPromise
  }

  /**
   * 结束通话：停止采集、发送 `{type:'stop'}`，等待服务端 ended/close（最多 4s）。
   * @returns {boolean} 是否有进行中的会话
   */
  function stop() {
    if (!active && !starting) return false
    if (stopping) return true
    if (starting) {
      sendJSON({ type: 'stop' })
      finish('closed')
      return true
    }
    cancelPendingStart()
    stopping = true
    active = false
    micPaused = false
    stopCapture()
    clearPlayback('stop')
    sendJSON({ type: 'stop' })
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = setTimeout(() => {
      stopTimer = null
      if (stopping) finish('closed')
    }, STOP_TIMEOUT_MS)
    return true
  }

  /**
   * 打断 Ava 当前说话：通知服务端清空生成，并立即清空本地播放队列。
   * @returns {boolean}
   */
  function interrupt() {
    if (!active) return false
    sendJSON({ type: 'interrupt' })
    clearPlayback('interrupt')
    return true
  }

  /**
   * 提交本轮说话（PTT 松手）：向服务端发送 `{type:'commit'}`，
   * 服务端会向火山会话补约 1.6s 静音以触发 VAD 出句（SPEC v2.2 方案 A）。
   *
   * 会先把连接未就绪期间暂存的音频帧按顺序补发，再发 commit（保证「音频在前、commit 在后」）。
   * 未连接/未激活/已 dispose 时返回 `false`，**不抛错**。
   *
   * @returns {boolean} 是否已把 commit 帧发给服务端
   */
  function commit() {
    if (disposed || !active || !ready) return false
    if (!ws || ws.readyState !== 1) return false
    // PTT 快速点击时可能仍有连接建立瞬间暂存的音频：先补齐再 commit
    flushPendingAudio()
    return sendJSON({ type: 'commit' })
  }

  /**
   * 取消本轮（PTT 划出/重按）：清空本地待发音频缓冲，并向服务端发送 `{type:'interrupt'}`
   * 清空本次输入；若正在播放 Ava 语音也会立即停止（与 interrupt 的播放清理一致）。
   *
   * 未连接/未激活时仅清空本地缓冲并返回 `false`（no-op），**不抛错**。
   *
   * @returns {boolean} 是否已把 interrupt 帧发给服务端
   */
  function cancelTurn() {
    if (disposed) return false
    pendingAudio = []
    if (!active) return false
    const connected = !!(ws && ws.readyState === 1)
    if (connected) sendJSON({ type: 'interrupt' })
    clearPlayback('interrupt')
    return connected
  }

  /**
   * 补/换回调（便于 app 在创建后接入 UI）。
   * @param {object} nextHandlers
   */
  function setHandlers(nextHandlers) {
    if (!nextHandlers || typeof nextHandlers !== 'object') return
    for (const key of Object.keys(handlers)) {
      if (typeof nextHandlers[key] === 'function') handlers[key] = nextHandlers[key]
    }
  }

  /** 释放全部资源（幂等）。 */
  function dispose() {
    if (disposed) return
    cancelPendingStart()
    active = false
    starting = false
    stopping = false
    micPaused = false
    clearTimers()
    stopCapture()
    clearPlayback('dispose')
    closeSocket()
    stoppedCleanup()
    disposed = true
    endedEmitted = true
  }

  /** 关闭 AudioContext（dispose 专用；正常 stop 保留上下文以便快速重开）。 */
  function stoppedCleanup() {
    if (audioCtx) {
      try {
        Promise.resolve(audioCtx.close()).catch(() => {})
      } catch {
        /* 忽略 */
      }
      audioCtx = null
    }
    playbackGain = null
    sources.clear()
  }

  return {
    start,
    prepareAudio,
    stop,
    interrupt,
    commit,
    cancelTurn,
    pauseMic,
    resumeMic,
    setPttGateMode(enabled) {
      pttGateMode = enabled === true
      pttGateLastLoudAt = Date.now()
      return pttGateMode
    },
    getMicInfo() {
      const track = mediaStream && mediaStream.getAudioTracks ? mediaStream.getAudioTracks()[0] : null
      const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {}
      return {
        active,
        micPaused,
        trackLive: Boolean(track && track.readyState === 'live'),
        trackMuted: Boolean(track && track.muted),
        trackEnabled: Boolean(track && track.enabled),
        trackState: track ? track.readyState : 'none',
        label: track && track.label ? String(track.label) : '',
        sampleRate: settings.sampleRate || 0,
        audioContextState: audioCtx ? audioCtx.state : 'none',
        gateMode: pttGateMode,
        gateFrames: pttGateFrames,
        framesSent,
        lastFrameAt,
      }
    },
    setOutputMuted(value) {
      outputMuted = value === true
      if (playbackGain) {
        try {
          playbackGain.gain.value = outputMuted ? 0 : 1
        } catch {
          /* 忽略 */
        }
      }
    },
    dispose,
    setHandlers,
    /** @returns {boolean} 当前浏览器是否支持实时语音 */
    get isSupported() {
      return isDoubaoVoiceSupported()
    },
    /** @returns {boolean} 是否处于通话会话中（含建链/权限等待） */
    get isActive() {
      return !disposed && (active || starting)
    },
    /** @returns {boolean} 服务端是否已 ready */
    get isReady() {
      return ready
    },
    /**
     * 诊断用只读：当前是否处于 `pauseMic()` 暂停状态（不改变行为）。
     * @returns {boolean}
     */
    get isMicPaused() {
      return micPaused
    },
    /**
     * 诊断用只读：自本客户端创建以来**成功 `ws.send` 的 PCM 帧累计数**（每帧 640B）。
     * 直发与 `commit()` 前 flush 的帧都计入；暂存/发送失败不计。可在 PTT 第二轮
     * 录音前后取差值判断「麦克风是否真的在推流」。
     * @returns {number}
     */
    get gatedFrames() {
      return pttGateFrames
    },
    get isPttGated() {
      return pttGateMode
    },
    get lastAudioAt() {
      return lastAudioAt
    },
    get framesSent() {
      return framesSent
    },
    /**
     * 诊断用只读：最后一次成功发送 PCM 的 `Date.now()` 时间戳（从未发送过为 `0`）。
     * @returns {number}
     */
    get lastFrameAt() {
      return lastFrameAt
    },
    /**
     * 诊断用只读：底层 WebSocket readyState（`0` 连接中 / `1` 已连接 / `2` 关闭中 / `3` 已关闭），
     * 没有连接时为 `-1`。
     * @returns {number}
     */
    get wsState() {
      return ws ? ws.readyState : -1
    },
  }
}

export default createDoubaoVoice
