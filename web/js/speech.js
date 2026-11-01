/**
 * Ava 前端底层 · 语音识别（STT）+ 语音合成朗读（TTS）
 *
 * 浏览器原生 ESM：无构建、无 importmap、无外部依赖。
 * STT 基于 Chrome `webkitSpeechRecognition`；TTS 基于 `window.speechSynthesis`。
 * Node 中 import 本模块是安全的（不会触碰 `window`），纯函数可直接单测。
 *
 * 关键纯函数（QA 可用 `node --input-type=module` 直接测）：
 * - {@link pickVoiceFromList} 从音色列表挑选英文女声（Samantha/Ava/Google US English 优先）
 * - {@link splitSentences} 英文句子切分
 * - {@link buildSpeechChunks} 长文本分块（规避 Chrome 长句截断）
 * - {@link mapSTTError} / {@link mapTTSError} 错误码 → 中文文案
 *
 * @module speech
 */

/* -------------------------------------------------------------------------- */
/* 常量 / 运行环境                                                             */
/* -------------------------------------------------------------------------- */

const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined'

/** STT 静音判定默认值（毫秒）：静音超过该时长即把已听内容作为一句 onFinal 上抛。 */
export const DEFAULT_SILENCE_MS = 1200

/** TTS 单块最大字符数：规避 Chrome 长句约 15s 被截断的问题。 */
export const MAX_CHUNK_CHARS = 180

/** TTS 默认语速（SPEC：rate=0.95）。 */
const TTS_DEFAULT_RATE = 0.95

/** Chrome 识别实例自动结束（约 15s）后的重启延迟。 */
const RESTART_DELAY_MS = 160

/** 连续重启失败上限。 */
const MAX_RESTART_ATTEMPTS = 8

/** TTS 启动看门狗：迟迟等不到 onstart 时给出中文提示。 */
const START_WATCHDOG_MS = 8000

/**
 * 读取 SpeechRecognition 构造函数（Chrome 前缀版兼容）。
 * @returns {any|null}
 */
function getSpeechRecognitionCtor() {
  if (!IS_BROWSER) return null
  try {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null
  } catch {
    return null
  }
}

/**
 * 读取 speechSynthesis 单例。
 * @returns {SpeechSynthesis|null}
 */
function getSynth() {
  if (!IS_BROWSER) return null
  try {
    return window.speechSynthesis || null
  } catch {
    return null
  }
}

/**
 * 读取 SpeechSynthesisUtterance 构造函数。
 * @returns {any|null}
 */
function getUtteranceCtor() {
  if (!IS_BROWSER) return null
  try {
    return window.SpeechSynthesisUtterance || null
  } catch {
    return null
  }
}

/**
 * 高精度当前时间（毫秒）。
 * @returns {number}
 */
function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  return Date.now()
}

/**
 * 安全执行回调：回调抛错只打印 console，不影响识别/朗读主流程。
 * @param {Function|undefined|null} fn
 * @param {...unknown} args
 * @returns {unknown}
 */
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return undefined
  try {
    return fn(...args)
  } catch (err) {
    console.error('[speech] 回调执行出错：', err)
    return undefined
  }
}

/**
 * 微任务延迟执行（避免在 start()/speak() 同步栈内触发错误回调，打乱调用方状态）。
 * @param {() => void} fn
 * @returns {void}
 */
function defer(fn) {
  if (typeof queueMicrotask === 'function') queueMicrotask(fn)
  else setTimeout(fn, 0)
}

/**
 * 构造带 code 的 Error（统一 onError 参数风格）。
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function makeSpeechError(code, message) {
  const err = /** @type {Error & {code: string}} */ (new Error(message))
  err.name = 'SpeechError'
  err.code = code
  return err
}

/* -------------------------------------------------------------------------- */
/* 错误码 → 中文                                                               */
/* -------------------------------------------------------------------------- */

/** STT 错误码 → 中文可读文案。 */
export const STT_ERROR_MESSAGES = {
  unsupported: '当前浏览器不支持语音识别，请使用桌面版 Chrome。',
  denied: '麦克风权限被拒绝：请点击地址栏左侧图标，允许本页面使用麦克风后重试。',
  'not-allowed': '麦克风权限被拒绝：请点击地址栏左侧图标，允许本页面使用麦克风后重试。',
  'service-not-allowed': '浏览器禁止了语音识别服务：请检查系统麦克风权限与 Chrome 站点设置。',
  'audio-capture': '未检测到麦克风：请确认已连接麦克风，并在系统设置中允许 Chrome 使用。',
  network: '语音识别网络错误：Chrome 语音识别需要联网（Google 服务），请检查网络或代理后重试。',
  'language-not-supported': '当前语音识别不支持该语言（en-US），请检查 Chrome 语言设置。',
  'no-speech': '没有检测到语音，请靠近麦克风再试一次。',
  'bad-grammar': '语音识别语法错误，请重试。',
  aborted: '语音识别已取消。',
  busy: '语音识别正忙，请稍后重试。',
  'start-failed': '无法启动语音识别，请重试或刷新页面。',
  disposed: '语音识别已释放。',
  unknown: '语音识别出现未知错误，请重试。',
}

/**
 * STT 错误码归一化 + 中文文案（纯函数）。
 * `not-allowed` / `service-not-allowed` 统一归一为 `denied`。
 * @param {string|{error?: string}} codeOrEvent
 * @returns {{code: string, message: string, originalCode: string}}
 */
export function mapSTTError(codeOrEvent) {
  const originalCode =
    typeof codeOrEvent === 'string'
      ? codeOrEvent
      : String(codeOrEvent && typeof codeOrEvent === 'object' && codeOrEvent.error ? codeOrEvent.error : 'unknown')
  const normalized = originalCode === 'not-allowed' || originalCode === 'service-not-allowed' ? 'denied' : originalCode
  const message = STT_ERROR_MESSAGES[originalCode] || STT_ERROR_MESSAGES[normalized] || `语音识别失败（${originalCode}）。`
  return { code: normalized, message, originalCode }
}

/* -------------------------------------------------------------------------- */
/* v1.2 中英切换纯函数（SPEC v1.2 §B）                                           */
/* -------------------------------------------------------------------------- */

/** CJK 统一表意文字范围（SPEC v1.2 §B：`/[\u4e00-\u9fff]/`）。 */
const CJK_CHAR_RE = /[\u4e00-\u9fff]/

/** 支持的 STT 语言：英文（默认）。 */
export const STT_LANG_EN = 'en-US'

/** 支持的 STT 语言：中文求助。 */
export const STT_LANG_ZH = 'zh-CN'

/**
 * **纯函数**：判断文本中是否含中文字符（CJK 统一表意文字）。
 *
 * 用于「中文求助」判定：文本输入含中文时应走 `chineseHelp` 流程，
 * 语音识别则应切换到 `zh-CN`。
 *
 * @example
 * isChineseText('I am tired')      // false
 * isChineseText('我今天很累')        // true
 * isChineseText('我有点 tired')     // true
 * isChineseText('')                // false
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isChineseText(text) {
  return CJK_CHAR_RE.test(String(text == null ? '' : text))
}

/**
 * **纯函数**：按模式/输入偏好给出 STT 语言代码。
 *
 * - `'zh'`（以及 `'zh-CN'` / `'cn'` / `'chinese'` / `'中文'`）→ `'zh-CN'`
 * - 其它（`'en'` / `'free'` / 空 / 非法值）→ `'en-US'`
 *
 * @example
 * pickSTTLang('zh')    // 'zh-CN'
 * pickSTTLang('free')  // 'en-US'
 * pickSTTLang()        // 'en-US'
 *
 * @param {string} [mode] 模式名或语言偏好
 * @returns {'zh-CN'|'en-US'}
 */
export function pickSTTLang(mode) {
  return canonicalSTTLang(mode)
}

/**
 * 把外部传入的语言/模式归一化为受支持的 STT 语言（内部工具）。
 * 中文系统一 `zh-CN`，其余（含非法值）回落 `en-US`。
 * @param {string} [lang]
 * @returns {'zh-CN'|'en-US'}
 */
function canonicalSTTLang(lang) {
  const value = String(lang == null ? '' : lang).trim().toLowerCase()
  if (value.startsWith('zh') || value === 'cn' || value === 'chinese' || value === '中文') return STT_LANG_ZH
  return STT_LANG_EN
}

/** TTS 错误码 → 中文可读文案。 */
export const TTS_ERROR_MESSAGES = {
  unsupported: '当前浏览器不支持语音合成朗读。',
  'not-allowed': '浏览器阻止了朗读：请先点击页面任意位置后再试。',
  'synthesis-unavailable': '当前设备没有可用的语音合成引擎。',
  'synthesis-failed': '语音合成失败：请检查系统「朗读内容 / 声音」设置与语音包。',
  'audio-busy': '音频设备忙：请关闭其它占用音频的应用后重试。',
  'audio-hardware': '没有可用的音频输出设备。',
  network: '语音合成需要网络连接（当前音色需要联网）。',
  'language-unavailable': '当前设备缺少该语言的语音包，请在系统设置中安装英文语音。',
  'voice-unavailable': '所选音色不可用，已改用系统默认音色。',
  'text-too-long': '朗读文本过长，已自动分块朗读。',
  interrupted: '朗读被新的朗读打断。',
  canceled: '朗读已取消。',
  'speech-blocked': '浏览器未能开始朗读：请先点击页面任意位置后再试。',
  'start-timeout': '朗读启动超时，请重试。',
  unknown: '朗读出现未知错误。',
}

/**
 * TTS 错误码 → 中文文案（纯函数）。
 * @param {string|{error?: string}} codeOrEvent
 * @returns {{code: string, message: string, originalCode: string}}
 */
export function mapTTSError(codeOrEvent) {
  const originalCode =
    typeof codeOrEvent === 'string'
      ? codeOrEvent
      : String(codeOrEvent && typeof codeOrEvent === 'object' && codeOrEvent.error ? codeOrEvent.error : 'unknown')
  const code = originalCode || 'unknown'
  const message = TTS_ERROR_MESSAGES[code] || TTS_ERROR_MESSAGES.unknown
  return { code, message, originalCode }
}

/* -------------------------------------------------------------------------- */
/* 音色挑选（纯函数）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 英文女声优先级（按 SPEC：本地 en-US 女声 Samantha / Ava / Google US English 优先）。
 * 名字命中越靠前得分越高。
 */
const PREFERRED_FEMALE_VOICES = [
  'samantha',
  'ava',
  'google us english',
  'karen',
  'moira',
  'tessa',
  'victoria',
  'fiona',
  'serena',
  'allison',
  'susan',
  'aria',
  'jenny',
  'libby',
  'michelle',
  'catherine',
  'kate',
  'sonia',
  'natasha',
  'google uk english female',
]

/** 男声/非目标音色降权关键词（子串匹配）。 */
const MALE_VOICE_HINTS = [
  'male',
  'daniel',
  'alex',
  'fred',
  'aaron',
  'david',
  'mark',
  'james',
  'guy',
  'george',
  'oliver',
  'arthur',
  'rishi',
  'albert',
  'zarvox',
]

/**
 * **纯函数**：从音色列表挑选最适合 Ava 的英文女声。
 *
 * 规则（按权重）：
 * 1. `prefName` 精确/包含匹配 +200/+140；也支持传 BCP-47 语言（如 `en-US`）；
 * 2. 英文音色 +50，en-US +30 / en-GB +12；
 * 3. 女声优先列表（Samantha、Ava、Google US English…）按序 +40 递减；
 * 4. 本地音色（`localService === true`）+15；
 * 5. 男声关键词 -35。
 *
 * @param {Array<{name?: string, lang?: string, localService?: boolean}>} voices
 * @param {string} [prefName] 偏好音色名或语言（如 `'Samantha'` / `'en-US'`）
 * @returns {{name?: string, lang?: string, localService?: boolean}|null} 选中的音色对象；列表为空返回 null
 */
export function pickVoiceFromList(voices, prefName = '') {
  const list = Array.isArray(voices) ? voices.filter((v) => v && typeof v === 'object') : []
  if (!list.length) return null

  const pref = String(prefName || '').trim().toLowerCase()
  let best = null
  let bestScore = -Infinity

  for (const voice of list) {
    const rawName = typeof voice.name === 'string' ? voice.name : ''
    const name = rawName.toLowerCase()
    const lang = typeof voice.lang === 'string' ? voice.lang.toLowerCase().replace(/_/g, '-') : ''
    let score = 0
    let exactPref = false

    if (pref) {
      if (name && name === pref) {
        score += 200
        exactPref = true
      } else if (name && name.includes(pref)) {
        score += 140
      } else if (lang && lang === pref) {
        score += 120
      } else if (lang && pref.startsWith('en') && lang.startsWith(pref)) {
        score += 60
      }
    }

    const isEnglish = lang.startsWith('en')
    if (isEnglish) score += 50
    if (lang === 'en-us') score += 30
    else if (lang.startsWith('en-us')) score += 25
    else if (lang.startsWith('en-gb')) score += 12
    else if (isEnglish) score += 5

    for (let i = 0; i < PREFERRED_FEMALE_VOICES.length; i += 1) {
      if (name.includes(PREFERRED_FEMALE_VOICES[i])) {
        score += 40 - Math.min(i, 18)
        break
      }
    }
    for (const hint of MALE_VOICE_HINTS) {
      if (name.includes(hint)) {
        score -= 35
        break
      }
    }
    if (voice.localService === true) score += 15
    if (!name) score -= 10
    if (!isEnglish && !exactPref) score -= 60

    if (score > bestScore) {
      bestScore = score
      best = voice
    }
  }

  return best
}

/* -------------------------------------------------------------------------- */
/* 句子切分 / 长文本分块（纯函数）                                              */
/* -------------------------------------------------------------------------- */

/**
 * 扫描句子及其在原文中的偏移（内部用，供分块保持 charIndex 精确映射）。
 * @param {string} text
 * @returns {Array<{text: string, start: number, end: number}>}
 */
function scanSentences(text) {
  const source = typeof text === 'string' ? text : ''
  /** @type {Array<{text: string, start: number, end: number}>} */
  const sentences = []
  if (!source.trim()) return sentences

  // 以 . ! ? … 中英标点分句；保留句尾标点与右引号；换行（\n）同样视为句子边界
  const re = /[^.!?…。！？\n]+(?:[.!?…。！？]+["')\]]*|(?=\n|$))/g
  let match
  while ((match = re.exec(source)) !== null) {
    const raw = match[0]
    if (!raw) break
    const trimmed = raw.trim()
    if (trimmed) {
      const offset = raw.indexOf(trimmed)
      const start = match.index + (offset >= 0 ? offset : 0)
      sentences.push({ text: trimmed, start, end: start + trimmed.length })
    }
    if (re.lastIndex === match.index) re.lastIndex += 1 // 保险：避免零宽匹配死循环
  }
  return sentences
}

/**
 * **纯函数**：把英文文本切分为句子数组（保留句尾标点）。
 *
 * @example
 * splitSentences('Hello there. How are you? I am fine!')
 * // → ['Hello there.', 'How are you?', 'I am fine!']
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return scanSentences(String(text == null ? '' : text)).map((s) => s.text)
}

/**
 * **纯函数**：把长文本切成适合 speechSynthesis 的块（默认 ≤180 字符），
 * 优先按句子聚合、单句过长时按空格/逗号硬切。
 *
 * 返回的每块带 `start`/`end` 偏移（相对于原始 text），供 TTS 把
 * `onboundary.charIndex` 换算回整段文本。
 *
 * @param {string} text
 * @param {number} [maxLen=MAX_CHUNK_CHARS]
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function buildSpeechChunks(text, maxLen = MAX_CHUNK_CHARS) {
  const source = String(text == null ? '' : text)
  if (!source.trim()) return []
  const limit = Number.isFinite(maxLen) && maxLen >= 20 ? Math.floor(maxLen) : MAX_CHUNK_CHARS

  const sentences = scanSentences(source)
  if (!sentences.length) {
    const trimmed = source.trim()
    const start = source.indexOf(trimmed)
    return [{ text: trimmed, start: Math.max(0, start), end: Math.max(0, start) + trimmed.length }]
  }

  /** @type {Array<{text: string, start: number, end: number}>} */
  const grouped = []
  /** @type {{start: number, end: number}|null} */
  let current = null
  for (const sentence of sentences) {
    if (current && sentence.end - current.start > limit) {
      grouped.push({ text: source.slice(current.start, current.end), start: current.start, end: current.end })
      current = null
    }
    if (!current) current = { start: sentence.start, end: sentence.end }
    else current.end = sentence.end
  }
  if (current) grouped.push({ text: source.slice(current.start, current.end), start: current.start, end: current.end })

  /** @type {Array<{text: string, start: number, end: number}>} */
  const chunks = []
  for (const group of grouped) {
    if (group.end - group.start <= limit) {
      const text = group.text.trim()
      if (text) {
        const start = group.start + group.text.indexOf(text)
        chunks.push({ text, start, end: start + text.length })
      }
      continue
    }
    // 单句过长：按空格/逗号硬切
    let start = group.start
    while (start < group.end) {
      let end = Math.min(start + limit, group.end)
      if (end < group.end) {
        const slice = source.slice(start, end)
        const cut = Math.max(
          slice.lastIndexOf(' '),
          slice.lastIndexOf(','),
          slice.lastIndexOf(';'),
          slice.lastIndexOf('，'),
          slice.lastIndexOf('、'),
        )
        if (cut > limit * 0.35) end = start + cut + 1
      }
      const piece = source.slice(start, end)
      const trimmed = piece.trim()
      if (trimmed) {
        const offset = piece.indexOf(trimmed)
        chunks.push({ text: trimmed, start: start + offset, end: start + offset + trimmed.length })
      }
      start = end
    }
  }
  return chunks
}

/**
 * 取 `charIndex` 所在的英文单词（纯内部工具，也用于 onboundary 缺 name 时兜底）。
 * @param {string} text
 * @param {number} charIndex
 * @returns {string}
 */
function wordAt(text, charIndex) {
  if (!text) return ''
  const idx = Math.max(0, Math.min(Number(charIndex) || 0, text.length - 1))
  let start = idx
  let end = idx
  while (start > 0 && /[A-Za-z'-]/.test(text[start - 1])) start -= 1
  while (end < text.length && /[A-Za-z'-]/.test(text[end])) end += 1
  const word = text.slice(start, end)
  if (word) return word
  const match = text.slice(idx).match(/[A-Za-z][A-Za-z'-]*/)
  return match ? match[0] : ''
}

/* ========================================================================== */
/* STT：createSTT                                                              */
/* ========================================================================== */

/**
 * 创建多语言语音识别器（Chrome `webkitSpeechRecognition`，支持 `en-US` / `zh-CN`）。
 *
 * 行为约定（app-dev 请按此对接）：
 * - `start()` 是**会话**开始：内部 `continuous=true` / `interimResults=true`；
 *   Chrome 约 15s 自动 end 时会自动重启，**不会**重复触发 `onStart`；
 * - 听的过程中实时 `onInterim(interimText, {final, text})`；
 * - 静音 `silenceMs` 后（或调用 `stop()` 时）把这一句作为 `onFinal(fullText, {reason, durationMs})` 上抛，
 *   然后自动重启继续听下一句；
 * - `stop()` 结束会话并礼貌地收尾（最后一句会上抛 onFinal）；`abort()` 立即丢弃并结束；
 * - **v1.2**：`setLang(lang)` 可在运行中切换语言（如中文求助按钮 → `'zh-CN'`，说完切回 `'en-US'`）。
 *   未开启会话时只更新配置（下次 `start()` 生效）；正在监听时会丢弃当前未上抛的半句并安全重启，
 *   连续模式 / 静音判定 / 自动重启 / 错误映射保持不变，不会触发额外的 onStart/onEnd；
 *   非法语言回落 `'en-US'`；
 * - `onError(err)` 收到的 `err` 是带 `message`（中文）和 `code`
 *   （`unsupported` | `denied` | `network` | `audio-capture` | ...）的 Error 对象；
 * - `onEnd({reason})` 在会话真正结束时触发一次（`stop` | `abort` | `error`）。
 *
 * 返回对象上的 `isSupported` / `isActive` 是 **getter 布尔属性**（不是函数），
 * 与 SPEC 3.2 的 `{ start(), stop(), abort(), isSupported, isActive }` 完全一致。
 *
 * @param {{
 *   lang?: string,
 *   silenceMs?: number,
 *   onInterim?: (interim: string, detail: {final: string, text: string}) => void,
 *   onFinal?: (text: string, detail: {reason: string, durationMs: number}) => void,
 *   onError?: (err: Error & {code: string}) => void,
 *   onStart?: (detail: {lang: string}) => void,
 *   onEnd?: (detail: {reason: string}) => void,
 *   autoRestart?: boolean,
 *   restartDelayMs?: number,
 *   maxRestarts?: number,
 * }} [opts]
 * @returns {{
 *   start: () => boolean,
 *   stop: () => boolean,
 *   abort: () => void,
 *   dispose: () => void,
 *   setLang: (lang: string) => ('zh-CN'|'en-US'),
 *   isSupported: boolean,
 *   isActive: boolean,
 *   lang: string,
 * }}
 */
export function createSTT(opts = {}) {
  const options = {
    lang: STT_LANG_EN,
    silenceMs: DEFAULT_SILENCE_MS,
    autoRestart: true,
    restartDelayMs: RESTART_DELAY_MS,
    maxRestarts: MAX_RESTART_ATTEMPTS,
    onInterim: undefined,
    onFinal: undefined,
    onError: undefined,
    onStart: undefined,
    onEnd: undefined,
    ...(opts && typeof opts === 'object' ? opts : {}),
  }
  // SPEC v1.2：非法/未知语言统一回落 en-US，中文系列归一到 zh-CN
  options.lang = canonicalSTTLang(options.lang)

  const SR = getSpeechRecognitionCtor()
  const supported = !!SR

  /** @type {any} */
  let recognition = null
  /** start() 之后、stop()/abort()/致命错误之前为 true（含自动重启间隙）。 */
  let requested = false
  /** recognition 实例是否处于 onstart..onend 之间。 */
  let running = false
  /** recognition.start() 已调用、尚等 onstart。 */
  let startPending = false
  /** 本次会话是否已触发 onStart。 */
  let sessionActive = false
  let userStopped = false
  let disposed = false

  let finalText = ''
  let interimText = ''
  let utteranceStartedAt = 0

  /** 本次 flush 后到下一轮 onstart 前的残余 result 需要忽略。 */
  let suppressResults = false

  /** @type {ReturnType<typeof setTimeout>|null} */
  let silenceTimer = null
  /** @type {ReturnType<typeof setTimeout>|null} */
  let restartTimer = null
  let restartAttempts = 0

  const silenceMs = Number(options.silenceMs) > 0 ? Number(options.silenceMs) : DEFAULT_SILENCE_MS
  const maxRestarts =
    Number(options.maxRestarts) > 0 ? Math.floor(Number(options.maxRestarts)) : MAX_RESTART_ATTEMPTS

  /**
   * 拼接英文转写片段（中文模式不加空格）。
   * @param {string} a
   * @param {string} b
   * @returns {string}
   */
  function joinTranscript(a, b) {
    const left = String(a || '').trim()
    const right = String(b || '').trim()
    if (!left) return right
    if (!right) return left
    return /^zh/i.test(String(options.lang || '')) ? left + right : `${left} ${right}`
  }

  /** 清空当前句缓冲区。 */
  function resetUtterance() {
    finalText = ''
    interimText = ''
    utteranceStartedAt = 0
  }

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
  }

  function clearRestartTimer() {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  function clearTimers() {
    clearSilenceTimer()
    clearRestartTimer()
  }

  /**
   * @param {string} code
   * @param {{detail?: string, originalCode?: string}} [extra]
   */
  function emitSTTError(code, extra = {}) {
    if (disposed && code !== 'disposed') return
    const mapped = mapSTTError(extra.originalCode || code)
    const finalCode = code || mapped.code
    const err = makeSpeechError(finalCode, mapped.message)
    if (extra.detail) /** @type {any} */ (err).detail = extra.detail
    if (extra.originalCode) /** @type {any} */ (err).originalCode = extra.originalCode
    safeCall(options.onError, err)
  }

  function emitStart() {
    safeCall(options.onStart, { lang: String(options.lang || 'en-US') })
  }

  /**
   * @param {'stop'|'abort'|'error'|'end'} reason
   */
  function emitEnd(reason) {
    if (!sessionActive) return
    sessionActive = false
    safeCall(options.onEnd, { reason })
  }

  /**
   * 把当前累积的转写作为一句 onFinal 上抛。
   * @param {'silence'|'stop'|'auto-restart'} reason
   * @returns {boolean} 是否真的有内容上抛
   */
  function flushUtterance(reason) {
    clearSilenceTimer()
    const text = joinTranscript(finalText, interimText)
    const startedAt = utteranceStartedAt
    resetUtterance()
    suppressResults = true
    if (!text) return false
    const durationMs = startedAt ? Math.max(0, Math.round(now() - startedAt)) : 0
    safeCall(options.onFinal, text, { reason, durationMs })
    return true
  }

  /** 静音计时：静音 silenceMs 且有内容 → 收尾当前句并重启识别（进入下一句）。 */
  function armSilenceTimer() {
    clearSilenceTimer()
    silenceTimer = setTimeout(() => {
      silenceTimer = null
      if (!requested || disposed) return
      if (!finalText.trim() && !interimText.trim()) return // 无内容：交给 Chrome 自身超时/重启
      flushUtterance('silence')
      stopRecognition(false)
    }, silenceMs)
  }

  /**
   * @param {boolean} useAbort true 用 abort()（丢弃），false 用 stop()（收尾）
   */
  function stopRecognition(useAbort) {
    if (!recognition) return
    const rec = recognition
    try {
      if (useAbort) rec.abort()
      else rec.stop()
    } catch {
      /* 已经停止，忽略 InvalidStateError */
    }
  }

  function scheduleRestart(delay) {
    if (!requested || disposed || restartTimer) return
    if (restartAttempts >= maxRestarts) {
      requested = false
      userStopped = true
      clearTimers()
      emitSTTError('start-failed', { detail: `语音识别连续 ${restartAttempts} 次重启失败` })
      emitEnd('error')
      return
    }
    restartAttempts += 1
    const wait = Number.isFinite(delay) ? Math.max(0, Number(delay)) : RESTART_DELAY_MS
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (requested && !disposed) beginRecognition()
    }, wait)
  }

  function handleStart() {
    running = true
    startPending = false
    restartAttempts = 0
    suppressResults = false
    if (!sessionActive) {
      sessionActive = true
      emitStart()
    }
  }

  /**
   * @param {any} event SpeechRecognitionEvent
   */
  function handleResult(event) {
    if (suppressResults || !requested) return
    const results = event && event.results
    if (!results || !results.length) return

    let finals = ''
    let interim = ''
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i]
      if (!result) continue
      const alternative = result[0]
      const transcript =
        alternative && typeof alternative.transcript === 'string' ? alternative.transcript : ''
      if (!transcript) continue
      if (result.isFinal) finals = joinTranscript(finals, transcript)
      else interim = joinTranscript(interim, transcript)
    }

    const changed = finals !== finalText || interim !== interimText
    finalText = finals
    interimText = interim
    if (!changed) return

    if (!utteranceStartedAt) utteranceStartedAt = now()
    safeCall(options.onInterim, interim, {
      final: finalText,
      text: joinTranscript(finalText, interim),
    })
    armSilenceTimer()
  }

  /**
   * @param {any} event SpeechRecognitionErrorEvent
   */
  function handleError(event) {
    const code = String((event && event.error) || 'unknown')
    if (code === 'aborted') return // 主动 abort/stop 的正常副产物
    if (code === 'no-speech') return // 静音：Chrome 随后会 onend，由自动重启接管

    if (
      code === 'not-allowed' ||
      code === 'service-not-allowed' ||
      code === 'audio-capture' ||
      code === 'language-not-supported' ||
      code === 'network'
    ) {
      requested = false
      userStopped = true
      clearTimers()
      emitSTTError(code, { originalCode: code })
      emitEnd('error')
      return
    }

    // 其它未知错误：提示一次，但若仍在收听则让 onend 走自动重启
    emitSTTError(code, { originalCode: code })
  }

  function handleEnd() {
    running = false
    startPending = false
    recognition = null
    if (disposed) return
    if (!requested || userStopped) {
      // 会话真正结束；onEnd 已由 stop()/abort()/错误路径触发
      return
    }
    // Chrome 约 15s 自动 end：先把残余内容上抛，再重启
    if (finalText.trim() || interimText.trim()) flushUtterance('auto-restart')
    if (options.autoRestart === false) {
      requested = false
      emitEnd('end')
      return
    }
    scheduleRestart(options.restartDelayMs)
  }

  function beginRecognition() {
    if (!supported || !requested || disposed || running || startPending || restartTimer) return
    let rec
    try {
      rec = new SR()
    } catch (err) {
      requested = false
      emitSTTError('start-failed', { detail: String((err && /** @type {any} */ (err).message) || err) })
      emitEnd('error')
      return
    }
    recognition = rec
    try {
      rec.lang = String(options.lang || 'en-US')
      rec.continuous = true
      rec.interimResults = true
      rec.maxAlternatives = 1
    } catch {
      /* 部分实现不支持某些属性，忽略 */
    }
    rec.onstart = handleStart
    rec.onresult = handleResult
    rec.onerror = handleError
    rec.onend = handleEnd
    rec.onnomatch = () => {}

    startPending = true
    try {
      rec.start()
    } catch (err) {
      startPending = false
      const name = err && /** @type {any} */ (err).name
      if (name === 'InvalidStateError') {
        // 上一个实例尚未彻底结束：稍后重试
        scheduleRestart(400)
        return
      }
      requested = false
      emitSTTError('start-failed', {
        detail: String((err && /** @type {any} */ (err).message) || err),
      })
      emitEnd('error')
    }
  }

  /** 开始一次连续识别会话（可重复调用，运行中调用是幂等的）。 */
  function start() {
    if (disposed) {
      defer(() => emitSTTError('disposed'))
      return false
    }
    if (!supported) {
      defer(() => emitSTTError('unsupported'))
      return false
    }
    if (requested) return true // 防重入

    requested = true
    userStopped = false
    sessionActive = false
    restartAttempts = 0
    suppressResults = false
    resetUtterance()
    beginRecognition()
    return true
  }

  /**
   * 切换识别语言（SPEC v1.2 §B.3 中文求助）。
   *
   * - 归一化：`zh*` / `cn` / `chinese` / `中文` → `'zh-CN'`，其余（含非法值）→ `'en-US'`；
   * - 未开启会话（`start()` 之前）：只更新配置，下次 `start()` 生效；
   * - 会话进行中（含 Chrome 自动重启间隙）：**安全重启**——
   *   丢弃当前尚未上抛的半句 → abort 当前实例 → 走既有 `onend → scheduleRestart` 链路用新语言重建，
   *   连续模式 / 静音判定 / 自动重启 / 错误映射均保持不变；不会额外触发 onStart/onEnd；
   * - 返回归一化后的语言代码（可直接用于 UI 状态）。
   *
   * @param {string} lang 目标语言，如 `'zh-CN'` / `'zh'` / `'en-US'`
   * @returns {'zh-CN'|'en-US'} 归一化后的语言
   */
  function setLang(lang) {
    const next = canonicalSTTLang(lang)
    const changed = next !== options.lang
    options.lang = next
    if (!changed || disposed || !supported) return next

    // 未处于收听会话：只改配置，下次 start() 使用新语言
    if (!requested) return next

    // 会话进行中：丢弃当前半句并安全重启（不触发 onFinal/onEnd，会话保持）
    clearTimers()
    resetUtterance()
    suppressResults = true
    if (recognition) {
      // abort 不产生 final 结果；onend → handleEnd → scheduleRestart → beginRecognition 用新语言重建
      stopRecognition(true)
    } else {
      // 正处于自动重启间隙（无当前实例）：立即按新语言重建
      beginRecognition()
    }
    return next
  }

  /** 优雅结束：最后一句若还没上抛，会作为 onFinal 触发；随后触发 onEnd({reason:'stop'})。 */
  function stop() {
    if (disposed) return false
    userStopped = true
    requested = false
    clearTimers()
    flushUtterance('stop')
    stopRecognition(false)
    emitEnd('stop')
    return true
  }

  /** 立即中止：丢弃未上抛的内容，不触发 onFinal；触发 onEnd({reason:'abort'})。 */
  function abort() {
    if (disposed) return
    userStopped = true
    requested = false
    clearTimers()
    resetUtterance()
    suppressResults = true
    stopRecognition(true)
    emitEnd('abort')
  }

  /** 释放实例（停止识别，之后事件不再回调）。 */
  function dispose() {
    if (disposed) return
    abort()
    disposed = true
    requested = false
    try {
      if (recognition) {
        recognition.onstart = null
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
      }
    } catch {
      /* 忽略 */
    }
    recognition = null
  }

  const stt = {
    start,
    stop,
    abort,
    dispose,
    setLang,
    /** @returns {boolean} 当前浏览器是否支持语音识别 */
    get isSupported() {
      return supported
    },
    /** @returns {boolean} 是否正处于收听会话中（含自动重启间隙） */
    get isActive() {
      // 以「会话是否被 start() 开启且未 stop/abort/致命错误」为准：
      // 这样在 Chrome 自动 end 的瞬间（onFinal 回调里）调用 stop() 也能立即关闭会话，不会误触发自动重启。
      return requested && !disposed
    },
    /** @returns {string} 当前识别语言（`'en-US'` | `'zh-CN'`） */
    get lang() {
      return String(options.lang || STT_LANG_EN)
    },
  }

  return /** @type {any} */ (stt)
}

/* ========================================================================== */
/* TTS：tts                                                                   */
/* ========================================================================== */

/** 稳定朗读任务的自增 id。 */
let ttsJobSeq = 0

/** 待播放队列（每个 speak() 一个 job）。 */
/** @type {Array<any>} */
const ttsQueue = []

let ttsPlaying = false
/** @type {any} */
let ttsCurrentJob = null
/** @type {any} */
let ttsCurrentUtterance = null
/** @type {ReturnType<typeof setTimeout>|null} */
let ttsStartWatchdog = null

function clearStartWatchdog() {
  if (ttsStartWatchdog) {
    clearTimeout(ttsStartWatchdog)
    ttsStartWatchdog = null
  }
}

/**
 * 解析 speak 的 voice 选项：对象直接用；字符串按名字/语言挑选；缺省自动挑最优英文女声。
 * @param {unknown} voice
 * @returns {SpeechSynthesisVoice|null}
 */
function resolveVoice(voice) {
  if (voice && typeof voice === 'object' && typeof /** @type {any} */ (voice).name === 'string') {
    return /** @type {SpeechSynthesisVoice} */ (voice)
  }
  const synth = getSynth()
  /** @type {SpeechSynthesisVoice[]} */
  let voices = []
  try {
    voices = (synth && typeof synth.getVoices === 'function' && synth.getVoices()) || []
  } catch {
    voices = []
  }
  if (typeof voice === 'string' && voice.trim()) {
    const matched = pickVoiceFromList(voices, voice)
    if (matched) return /** @type {SpeechSynthesisVoice} */ (matched)
    return null
  }
  return /** @type {SpeechSynthesisVoice|null} */ (pickVoiceFromList(voices, ''))
}

/**
 * 结束一个朗读任务（正常完成 / 取消共用）。
 * @param {any} job
 * @param {{ok: boolean, cancelled?: boolean, error?: string, empty?: boolean}} result
 */
function finishJob(job, result) {
  const wasCurrent = ttsCurrentJob === job
  const elapsedMs = job.startAt ? Math.max(0, Math.round(now() - job.startAt)) : 0
  clearStartWatchdog()
  if (wasCurrent) {
    ttsCurrentJob = null
    ttsCurrentUtterance = null
    ttsPlaying = false
  }
  const resolve = job.resolve
  job.resolve = null
  if (resolve) resolve({ ...result, elapsedMs })
  if (!result.cancelled) {
    safeCall(job.handlers.onEnd, {
      text: job.text,
      elapsedMs,
      cancelled: false,
      error: result.error || null,
    })
  }
  if (wasCurrent) pumpQueue()
}

/**
 * 朗读失败：触发 onError（中文），随后按“完成”收尾（onEnd 带 error 字段）。
 * @param {any} job
 * @param {string} code
 */
function failJob(job, code) {
  const mapped = mapTTSError(code)
  safeCall(job.handlers.onError, makeSpeechError(mapped.code, mapped.message))
  finishJob(job, { ok: false, error: mapped.code })
}

/**
 * 播放任务中的第 index 块。
 * @param {any} job
 * @param {number} index
 */
function playChunk(job, index) {
  if (job.cancelled) {
    finishJob(job, { ok: false, cancelled: true })
    return
  }
  const synth = getSynth()
  const Utterance = getUtteranceCtor()
  if (!synth || !Utterance) {
    failJob(job, 'unsupported')
    return
  }
  if (index >= job.chunks.length) {
    finishJob(job, { ok: true })
    return
  }

  const chunk = job.chunks[index]
  /** @type {any} */
  let utterance
  try {
    utterance = new Utterance(chunk.text)
  } catch {
    failJob(job, 'synthesis-failed')
    return
  }
  ttsCurrentUtterance = utterance

  if (job.voice) {
    try {
      utterance.voice = job.voice
    } catch {
      /* 忽略 */
    }
  }
  try {
    utterance.lang = (job.voice && job.voice.lang) || job.lang || 'en-US'
    utterance.rate = job.rate
    utterance.pitch = job.pitch
    utterance.volume = 1
  } catch {
    /* 忽略 */
  }

  utterance.onstart = () => {
    if (job.cancelled) return
    if (!job.started) {
      job.started = true
      job.startAt = now()
      clearStartWatchdog()
      safeCall(job.handlers.onStart, {
        text: job.text,
        voice: job.voice,
        rate: job.rate,
        lang: job.lang,
      })
    }
  }

  utterance.onboundary = (event) => {
    if (job.cancelled || !job.started) return
    const rawIndex = event && Number.isFinite(event.charIndex) ? Number(event.charIndex) : 0
    // 换算到整段文本（chunk.start 是当前块在原始文本中的偏移）
    const globalIndex = Math.max(0, Math.min(chunk.start + Math.max(0, rawIndex), job.text.length))
    const eventName = event && typeof event.name === 'string' ? event.name.trim() : ''
    const word = eventName || wordAt(job.text, globalIndex)
    if (!word) return
    const elapsedMs = job.startAt ? Math.max(0, Math.round(now() - job.startAt)) : 0
    safeCall(job.handlers.onWordBoundary, {
      word,
      charIndex: globalIndex,
      elapsedMs,
      name: (utterance.voice && utterance.voice.name) || (job.voice && job.voice.name) || '',
    })
  }

  utterance.onend = () => {
    if (job.cancelled || ttsCurrentJob !== job) return
    playChunk(job, index + 1)
  }

  utterance.onerror = (event) => {
    if (job.cancelled) return
    const code = String((event && event.error) || 'unknown')
    if (code === 'interrupted' || code === 'canceled') {
      if (ttsCurrentJob === job) finishJob(job, { ok: false, cancelled: true })
      return
    }
    failJob(job, code)
  }

  try {
    synth.speak(utterance)
  } catch {
    failJob(job, 'synthesis-failed')
  }
}

/** 从队列取下一个任务开始播放。 */
function pumpQueue() {
  if (ttsPlaying) return
  const job = ttsQueue.shift()
  if (!job) return
  if (job.cancelled) {
    const resolve = job.resolve
    job.resolve = null
    if (resolve) resolve({ ok: false, cancelled: true, elapsedMs: 0 })
    pumpQueue()
    return
  }
  if (!getSynth() || !getUtteranceCtor()) {
    failJob(job, 'unsupported')
    return
  }
  ttsPlaying = true
  ttsCurrentJob = job
  job.chunks = buildSpeechChunks(job.text, MAX_CHUNK_CHARS)
  if (!job.chunks.length) {
    finishJob(job, { ok: true, empty: true })
    return
  }
  clearStartWatchdog()
  ttsStartWatchdog = setTimeout(() => {
    ttsStartWatchdog = null
    if (ttsCurrentJob === job && !job.started && !job.cancelled) {
      failJob(job, 'start-timeout')
    }
  }, START_WATCHDOG_MS)
  playChunk(job, 0)
}

/**
 * 朗读一段文本（自动按句切成 ≤180 字符的块，规避 Chrome 长句截断）。
 *
 * - 支持“边流式边朗读”：多次调用 `speak()` 会**排队依次**播放，不会互相打断；
 * - `onWordBoundary({word, charIndex, elapsedMs, name})` 的 `charIndex` 已换算到**本次 text** 的整段偏移；
 * - 返回 Promise：在本次任务结束/取消/失败时 resolve（不会 reject）：
 *   `{ok, cancelled, error?, elapsedMs}`；
 * - 同一个任务只会触发一次 `onStart` / `onEnd` / `onError`。
 *
 * @param {string} text
 * @param {{
 *   voice?: SpeechSynthesisVoice|string|null,
 *   rate?: number,
 *   pitch?: number,
 *   lang?: string,
 *   onStart?: (detail: {text: string, voice: unknown, rate: number, lang: string}) => void,
 *   onWordBoundary?: (detail: {word: string, charIndex: number, elapsedMs: number, name: string}) => void,
 *   onEnd?: (detail: {text: string, elapsedMs: number, cancelled: boolean, error: string|null}) => void,
 *   onError?: (err: Error & {code: string}) => void,
 * }} [options]
 * @returns {Promise<{ok: boolean, cancelled?: boolean, error?: string, empty?: boolean, elapsedMs?: number}>}
 */
let browserTTSEnabled = true

/**
 * 是否允许使用浏览器内置语音合成（speechSynthesis）。
 * 手机版会关闭它（只用豆包角色原声）；旧版桌面 app 保持默认开启。
 * @param {boolean} enabled
 */
export function setBrowserTTSEnabled(enabled) {
  browserTTSEnabled = enabled !== false
  if (!browserTTSEnabled) {
    try {
      const synth = getSynth()
      if (synth) synth.cancel()
    } catch {
      /* 忽略 */
    }
  }
}

/** @returns {boolean} */
export function isBrowserTTSEnabled() {
  return browserTTSEnabled
}

function speak(text, options = {}) {
  if (!browserTTSEnabled) {
    return Promise.resolve({ ok: false, disabled: true, elapsedMs: 0 })
  }
  const content = String(text == null ? '' : text)
  const synth = getSynth()
  const Utterance = getUtteranceCtor()

  if (!synth || !Utterance) {
    const mapped = mapTTSError('unsupported')
    defer(() =>
      safeCall(options.onError, makeSpeechError('unsupported', mapped.message)),
    )
    return Promise.resolve({ ok: false, error: 'unsupported', elapsedMs: 0 })
  }
  if (!content.trim()) return Promise.resolve({ ok: true, empty: true, elapsedMs: 0 })

  const voice = resolveVoice(options.voice)
  const rate = Number.isFinite(Number(options.rate)) ? Math.min(2, Math.max(0.5, Number(options.rate))) : TTS_DEFAULT_RATE

  /** @type {any} */
  const job = {
    id: (ttsJobSeq += 1),
    text: content,
    voice,
    rate,
    pitch: Number.isFinite(Number(options.pitch)) ? Number(options.pitch) : 1,
    lang: String(options.lang || (voice && voice.lang) || 'en-US'),
    handlers: {
      onStart: options.onStart,
      onWordBoundary: options.onWordBoundary,
      onEnd: options.onEnd,
      onError: options.onError,
    },
    cancelled: false,
    started: false,
    startAt: 0,
    chunks: /** @type {Array<{text: string, start: number, end: number}>} */ ([]),
    resolve: null,
  }
  job.promise = new Promise((resolve) => {
    job.resolve = resolve
  })

  ttsQueue.push(job)
  pumpQueue()
  return job.promise
}

/**
 * 取消**所有**朗读（正在播放 + 排队中的）。
 * 当前任务会收到一次 `onEnd({cancelled:true})`，便于 UI 复位状态；排队中的任务静默丢弃。
 * @returns {boolean} 是否确实取消了内容
 */
function cancel() {
  const hadContent = !!ttsCurrentJob || ttsQueue.length > 0
  const current = ttsCurrentJob
  const pending = ttsQueue.splice(0, ttsQueue.length)

  clearStartWatchdog()
  ttsCurrentJob = null
  ttsCurrentUtterance = null
  ttsPlaying = false

  const synth = getSynth()
  if (synth) {
    try {
      synth.cancel()
    } catch {
      /* 忽略 */
    }
  }

  const cancelledJobs = current ? [current, ...pending] : pending
  for (const job of cancelledJobs) {
    job.cancelled = true
    const resolve = job.resolve
    job.resolve = null
    if (resolve) resolve({ ok: false, cancelled: true, elapsedMs: 0 })
  }
  if (current) {
    safeCall(current.handlers.onEnd, {
      text: current.text,
      elapsedMs: current.startAt ? Math.max(0, Math.round(now() - current.startAt)) : 0,
      cancelled: true,
      error: null,
    })
  }
  return hadContent
}

/** @returns {boolean} 是否正在朗读（含排队中） */
function isSpeaking() {
  if (ttsCurrentJob && !ttsCurrentJob.cancelled) return true
  if (ttsQueue.length > 0) return true
  const synth = getSynth()
  try {
    return !!(synth && (synth.speaking || synth.pending))
  } catch {
    return false
  }
}

/**
 * 读取系统可用音色，等待 `voiceschanged`（首次加载异步）。
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
function getVoices() {
  const synth = getSynth()
  if (!synth || typeof synth.getVoices !== 'function') return Promise.resolve([])

  let immediate = []
  try {
    immediate = synth.getVoices() || []
  } catch {
    immediate = []
  }
  if (immediate.length) return Promise.resolve(Array.from(immediate))

  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let usedProperty = false
    const onChanged = () => {
      let list = []
      try {
        list = synth.getVoices() || []
      } catch {
        list = []
      }
      if (list.length) finish(list)
    }
    const finish = (list) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        synth.removeEventListener('voiceschanged', onChanged)
      } catch {
        /* 忽略 */
      }
      if (usedProperty) {
        try {
          synth.onvoiceschanged = null
        } catch {
          /* 忽略 */
        }
      }
      if (Array.isArray(list)) {
        resolve(list)
        return
      }
      try {
        resolve(Array.from(synth.getVoices() || []))
      } catch {
        resolve([])
      }
    }

    timer = setTimeout(() => finish(undefined), 1500)
    try {
      synth.addEventListener('voiceschanged', onChanged)
    } catch {
      usedProperty = true
      synth.onvoiceschanged = onChanged
    }
    // 某些平台 voiceschanged 在下一拍才触发；再兜底检查一次
    setTimeout(() => {
      if (settled) return
      try {
        const list = synth.getVoices() || []
        if (list.length) finish(Array.from(list))
      } catch {
        /* 忽略 */
      }
    }, 0)
  })
}

/**
 * 同步读取当前已加载音色（首次可能为空数组）。
 * @returns {SpeechSynthesisVoice[]}
 */
function getVoicesSync() {
  const synth = getSynth()
  if (!synth || typeof synth.getVoices !== 'function') return []
  try {
    return Array.from(synth.getVoices() || [])
  } catch {
    return []
  }
}

/**
 * 挑选最佳音色（同步；音色列表未加载时可能返回 null，可用 `await tts.getVoices()` 预热）。
 * @param {string} [prefName]
 * @returns {SpeechSynthesisVoice|null}
 */
function pickVoice(prefName) {
  return /** @type {SpeechSynthesisVoice|null} */ (pickVoiceFromList(getVoicesSync(), prefName || ''))
}

/**
 * TTS 单例（全应用共用一个 speechSynthesis 队列）。
 * 方法签名严格遵循 SPEC 3.2。
 */
export const tts = {
  setBrowserTTSEnabled,
  isBrowserTTSEnabled,
  /** @returns {Promise<SpeechSynthesisVoice[]>} 等待 voiceschanged 后返回音色列表 */
  getVoices,
  /** @returns {SpeechSynthesisVoice[]} 同步读取当前音色 */
  getVoicesSync,
  /** @param {string} [prefName] @returns {SpeechSynthesisVoice|null} */
  pickVoice,
  /** @param {string} text @param {object} [options] @returns {Promise<object>} */
  speak,
  /** @returns {boolean} */
  cancel,
  /** @returns {boolean} */
  isSpeaking,
  /** @returns {boolean} 当前浏览器是否支持语音合成 */
  get supported() {
    return !!getSynth() && !!getUtteranceCtor()
  },
}

export default tts
