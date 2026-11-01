/**
 * Ava 手机版 · 角色原声朗读 helper（SPEC v3.1）
 *
 * 修复「所有角色音色只有一种」：优先调用后端 `POST /api/tts {text, characterId}`
 * 播放角色原声 mp3（Elena / Maya / Hikari 不同 speaker）；请求或播放失败时，
 * 自动回退浏览器 `speechSynthesis`（按角色 pitch/rate 区分声线）。
 *
 * 设计要点：
 * - **永不 throw**：网络/HTTP/播放失败都静默回退，`onEnd` 在播放结束或回退结束/失败后调用一次；
 * - 同 `characterId + text` 的 **Blob 缓存**（≤20 条 LRU）：避免重复请求，但每次播放新建 objectURL、
 *   `stopCharacterText()` 时 revoke 当前 URL（缓存的是 Blob，不会因 revoke 失效）；
 * - 同一时间只播一条：新的 `playCharacterText()` 会先静默停掉上一条（不触发上一条 onEnd）；
 * - 不依赖 call.js；浏览器原生 ESM。
 *
 * @example
 * import { playCharacterText, stopCharacterText } from './voice-audio.js'
 * await playCharacterText('This painting really catches my eye.', {
 *   characterId: 'elena',
 *   onStart: () => setSpeaking(true),
 *   onEnd: () => setSpeaking(false),
 * })
 *
 * @module mobile/voice-audio
 */

import { tts } from '../speech.js'

/** TTS 接口。 */
const TTS_ENDPOINT = '/api/tts'

/** 请求超时（毫秒）：角色原声首次合成可能较慢。 */
const REQUEST_TIMEOUT_MS = 75_000

/** Blob 缓存上限（同角色+文本复用）。 */
const CACHE_LIMIT = 20

/** 角色浏览器兜底声线（pitch / rate）。 */
const VOICE_PROFILES = {
  elena: { pitch: 1.0, rate: 0.95 },
  maya: { pitch: 0.94, rate: 1.02 },
  hikari: { pitch: 1.08, rate: 1.05 },
}

const DEFAULT_VOICE_PROFILE = { pitch: 1.0, rate: 1.0 }

/**
 * 角色 id 归一化（小写去空格）。
 * @param {unknown} characterId
 * @returns {string}
 */
function normalizeCharacterId(characterId) {
  return String(characterId == null ? '' : characterId)
    .trim()
    .toLowerCase()
}

/**
 * 角色浏览器兜底音高（speechSynthesis.pitch）。
 * @param {string} [characterId]
 * @returns {number} Elena 1.0 / Maya 0.94 / Hikari 1.08；未知 1.0
 */
export function characterPitch(characterId) {
  const profile = VOICE_PROFILES[normalizeCharacterId(characterId)] || DEFAULT_VOICE_PROFILE
  return profile.pitch
}

/**
 * 角色浏览器兜底语速（speechSynthesis.rate）。
 * @param {string} [characterId]
 * @returns {number} Elena 0.95 / Maya 1.02 / Hikari 1.05；未知 1.0
 */
export function characterRate(characterId) {
  const profile = VOICE_PROFILES[normalizeCharacterId(characterId)] || DEFAULT_VOICE_PROFILE
  return profile.rate
}

/**
 * 安全执行回调（回调抛错不影响播放/结束流程）。
 * @param {Function|undefined|null} fn
 * @param {...unknown} args
 */
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return
  try {
    fn(...args)
  } catch (err) {
    console.error('[voice-audio] 回调执行出错：', err)
  }
}

/**
 * revoke 一个 objectURL（静默失败）。
 * @param {string} url
 */
function revokeUrl(url) {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch {
    /* 忽略 */
  }
}

/* -------------------------------------------------------------------------- */
/* Blob 缓存（同角色+文本复用；上限 20 LRU）                                      */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, {blob: Blob, at: number}>} */
const blobCache = new Map()

/**
 * @param {string} characterId
 * @param {string} text
 * @returns {string}
 */
function cacheKey(characterId, text) {
  return `${normalizeCharacterId(characterId)}\u0000${text}`
}

/**
 * 读取缓存（LRU 触达：命中后移到队尾）。
 * @param {string} key
 * @returns {Blob|null}
 */
function cacheGet(key) {
  const entry = blobCache.get(key)
  if (!entry) return null
  blobCache.delete(key)
  entry.at = Date.now()
  blobCache.set(key, entry)
  return entry.blob
}

/**
 * 写入缓存并淘汰最旧条目（缓存的是 Blob，不涉及 objectURL revoke）。
 * @param {string} key
 * @param {Blob} blob
 */
function cacheSet(key, blob) {
  if (blobCache.has(key)) blobCache.delete(key)
  blobCache.set(key, { blob, at: Date.now() })
  while (blobCache.size > CACHE_LIMIT) {
    const oldestKey = blobCache.keys().next().value
    if (oldestKey === undefined) break
    blobCache.delete(oldestKey)
  }
}

/**
 * 清空角色原声 Blob 缓存（测试/释放内存用）。
 * @returns {void}
 */
export function clearCharacterAudioCache() {
  blobCache.clear()
}

/* -------------------------------------------------------------------------- */
/* 播放状态                                                                    */
/* -------------------------------------------------------------------------- */

/** @type {HTMLAudioElement|null} */
let currentAudio = null
/** 当前播放的 objectURL（stop 时 revoke） */
let currentUrl = ''
/** 播放代次：新播放/stop 时自增，旧异步回调据此静默退出 */
let currentSeq = 0
/** 当前 API 播放的 settle 函数（stop 时用于立即结束 Promise） @type {((result: {ok: boolean, cancelled?: boolean, error?: string}) => void)|null} */
let currentApiFinish = null
/** 是否处于浏览器 TTS 回退播放中 */
let currentFallbackActive = false
/** 当前回退播放的 settle 函数（stop 时用于立即结束 Promise） @type {((ok: boolean, extra?: {error?: string, cancelled?: boolean}) => void)|null} */
let currentFallbackFinish = null

/**
 * 停止当前角色朗读：暂停 Audio、revoke 当前 objectURL、取消浏览器 TTS 回退。
 * 不触发 onEnd（静默停止；新一轮播放会自行 onStart/onEnd）。
 * @returns {boolean} 是否确实停掉了内容
 */
export function stopCharacterText() {
  const hadContent = !!currentAudio || currentFallbackActive
  currentSeq += 1
  const fallbackFinish = currentFallbackFinish
  currentFallbackFinish = null
  if (fallbackFinish) {
    try {
      fallbackFinish(false, { error: 'cancelled', cancelled: true })
    } catch {
      /* 忽略 */
    }
  }
  const finish = currentApiFinish
  currentApiFinish = null
  if (finish) {
    try {
      finish({ ok: false, cancelled: true })
    } catch {
      /* 忽略 */
    }
  }
  if (currentAudio) {
    const audio = currentAudio
    currentAudio = null
    try {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.currentTime = 0
    } catch {
      /* 忽略 */
    }
    try {
      audio.removeAttribute('src')
      audio.load()
    } catch {
      /* 忽略 */
    }
  }
  if (currentUrl) {
    revokeUrl(currentUrl)
    currentUrl = ''
  }
  currentFallbackActive = false
  try {
    tts.cancel()
  } catch {
    /* 忽略 */
  }
  return hadContent
}

/**
 * 把音量归一化到 0..1。
 * @param {unknown} volume
 * @returns {number}
 */
function normalizeVolume(volume) {
  const n = Number(volume)
  if (!Number.isFinite(n)) return 1
  return Math.min(1, Math.max(0, n))
}

/**
 * 请求 /api/tts 并返回 mp3 Blob（30s 超时）。
 * @param {string} text
 * @param {string} characterId
 * @returns {Promise<Blob>}
 */
async function fetchTtsBlob(text, characterId) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort()
    } catch {
      /* 忽略 */
    }
  }, REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text, characterId }),
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        /* 忽略 */
      }
      throw new Error(`角色语音请求失败（HTTP ${res.status}）${detail ? `：${String(detail).slice(0, 120)}` : ''}`)
    }
    const blob = await res.blob()
    if (!blob || !blob.size) throw new Error('角色语音返回空音频。')
    return blob
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 用 Blob 播放一次（API 路径）。不触发 onEnd/onStart，只返回结果。
 * @param {Blob} blob
 * @param {{ rate?: number, volume?: number, onPlaying?: () => void }} options
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function playAudioBlob(blob, options = {}) {
  return new Promise((resolve) => {
    let url = ''
    try {
      url = URL.createObjectURL(blob)
    } catch {
      resolve({ ok: false, error: 'object-url-failed' })
      return
    }
    /** @type {HTMLAudioElement} */
    let audio
    try {
      audio = new Audio(url)
    } catch {
      revokeUrl(url)
      resolve({ ok: false, error: 'audio-unsupported' })
      return
    }

    let settled = false
    /** @param {{ok: boolean, error?: string, cancelled?: boolean}} result */
    const settle = (result) => {
      if (settled) return
      settled = true
      if (currentApiFinish === settle) currentApiFinish = null
      if (currentAudio === audio) currentAudio = null
      if (currentUrl === url) currentUrl = ''
      // 先解除 media 元素对 blob URL 的引用（pause + 清空 src + load），
      // 再在下一个宏任务 revoke，避免 Chrome 媒体栈在释放途中继续读该 URL
      // 而产生 "Failed to load resource: net::ERR_FILE_NOT_FOUND (blob: Media)" 噪音。
      try {
        audio.onended = null
        audio.onerror = null
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      } catch {
        /* 忽略 */
      }
      setTimeout(() => revokeUrl(url), 0)
      resolve(result)
    }

    currentAudio = audio
    currentUrl = url
    currentApiFinish = settle

    try {
      audio.volume = normalizeVolume(options.volume)
      const playbackRate = Number(options.rate)
      if (Number.isFinite(playbackRate) && playbackRate > 0) {
        audio.playbackRate = Math.min(2, Math.max(0.5, playbackRate))
      }
    } catch {
      /* 忽略 */
    }

    audio.onended = () => settle({ ok: true })
    audio.onerror = () => settle({ ok: false, error: 'audio-error' })

    Promise.resolve()
      .then(() => audio.play())
      .then(() => {
        if (settled) return
        try {
          if (typeof options.onPlaying === 'function') options.onPlaying()
        } catch {
          /* 忽略 */
        }
      })
      .catch(() => settle({ ok: false, error: 'play-rejected' }))
  })
}

/**
 * 浏览器 TTS 回退（按角色 pitch/rate）；结束/失败后调用 onEnd 一次。
 * @param {{
 *   text: string,
 *   characterId: string,
 *   rate?: number,
 *   seq: number,
 *   onStart?: Function,
 *   onEnd?: Function,
 * }} ctx
 * @returns {Promise<boolean>}
 */
function playTtsFallback(ctx) {
  return new Promise((resolve) => {
    let settled = false
    /** @param {boolean} ok @param {{error?: string}} [extra] */
    const finish = (ok, extra = {}) => {
      if (settled) return
      settled = true
      if (currentFallbackFinish === finish) currentFallbackFinish = null
      if (currentSeq === ctx.seq) {
        currentFallbackActive = false
        safeCall(ctx.onEnd, {
          engine: ok ? 'tts' : 'none',
          ok,
          text: ctx.text,
          characterId: ctx.characterId,
          fallback: true,
          ...extra,
        })
        resolve(ok)
        return
      }
      // 已被 stop/新播放取代：静默结束
      resolve(false)
    }

    const pitch = characterPitch(ctx.characterId)
    const requestedRate = Number(ctx.rate)
    const rate = Number.isFinite(requestedRate) && requestedRate > 0 ? requestedRate : characterRate(ctx.characterId)
    currentFallbackActive = true
    currentFallbackFinish = finish
    let speakPromise = null
    try {
      speakPromise = tts.speak(ctx.text, {
        lang: 'en-US',
        pitch,
        rate,
        onStart: () => {
          if (currentSeq === ctx.seq) {
            safeCall(ctx.onStart, {
              engine: 'tts',
              text: ctx.text,
              characterId: ctx.characterId,
              fallback: true,
              pitch,
              rate,
            })
          }
        },
        onEnd: () => finish(true),
        onError: () => finish(false, { error: 'tts-error' }),
      })
    } catch {
      finish(false, { error: 'tts-throw' })
      return
    }
    // tts.speak 正常以回调结束；这里兜底处理 Promise 结果（含测试 stub/异常）
    Promise.resolve(speakPromise)
      .then((result) => {
        if (settled) return
        if (result && result.ok) finish(true)
        else finish(false, { error: result && result.error ? String(result.error) : 'tts-failed' })
      })
      .catch(() => finish(false, { error: 'tts-reject' }))
  })
}

/**
 * 播放角色原声朗读（SPEC v3.1）。
 *
 * 流程：停上一条 → 命中 Blob 缓存 / `POST /api/tts` → Audio 播放；
 * 任何失败（网络/非 2xx/空音频/播放失败）自动回退浏览器 `tts.speak`（按角色 pitch/rate）。
 * **永不 throw**；同一时间只播一条；`onEnd` 在播放结束、回退结束或回退失败后调用一次。
 *
 * @example
 * const played = await playCharacterText('I love how warm the colors are.', {
 *   characterId: 'maya',
 *   volume: 0.9,
 *   onStart: ({ engine }) => console.log('开始播放', engine),
 *   onEnd: ({ engine, ok }) => console.log('结束', engine, ok),
 * })
 *
 * @param {string} text 要朗读的英文/中英文本（trim 后为空直接返回 false）
 * @param {{
 *   characterId?: string,
 *   rate?: number,
 *   volume?: number,
 *   onStart?: (detail: {engine: 'api'|'tts', text: string, characterId: string, fallback?: boolean, pitch?: number, rate?: number}) => void,
 *   onEnd?: (detail: {engine: 'api'|'tts'|'none', ok: boolean, text: string, characterId: string, fallback?: boolean, error?: string}) => void,
 * }} [options]
 * @returns {Promise<boolean>} true=已通过 API 或浏览器 TTS 播放（或开始回退）；false=空文本/被新播放或 stop 取代/两条路径都失败
 */
export async function playCharacterText(text, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const content = String(text == null ? '' : text).trim()
  if (!content) return false
  const characterId = normalizeCharacterId(opts.characterId) || 'elena'
  const rateOption = Number(opts.rate)

  // 同一时间只播一条：静默停掉上一条（不触发上一条 onEnd）
  stopCharacterText()
  const seq = ++currentSeq
  const key = cacheKey(characterId, content)

  try {
    let blob = cacheGet(key)
    if (!blob) {
      blob = await fetchTtsBlob(content, characterId)
      if (seq !== currentSeq) return false
      cacheSet(key, blob)
    }
    if (seq !== currentSeq) return false

    const result = await playAudioBlob(blob, {
      rate: Number.isFinite(rateOption) && rateOption > 0 ? rateOption : undefined,
      volume: opts.volume,
      onPlaying: () => {
        if (seq !== currentSeq) return
        safeCall(opts.onStart, { engine: 'api', text: content, characterId })
      },
    })
    if (seq !== currentSeq) return false
    if (result.ok) {
      safeCall(opts.onEnd, { engine: 'api', ok: true, text: content, characterId })
      return true
    }
    // 播放失败 → 回退浏览器 TTS
  } catch {
    if (seq !== currentSeq) return false
    // 请求失败 → 回退浏览器 TTS
  }

  if (seq !== currentSeq) return false
  return playTtsFallback({
    text: content,
    characterId,
    rate: rateOption,
    seq,
    onStart: opts.onStart,
    onEnd: opts.onEnd,
  })
}

export default {
  playCharacterText,
  stopCharacterText,
  characterPitch,
  characterRate,
  clearCharacterAudioCache,
}
