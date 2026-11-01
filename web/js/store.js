/**
 * Ava 前端底层 · 本地状态 / 缓存 / 进度
 *
 * 浏览器原生 ESM：无构建、无 importmap、无外部依赖。
 * 设计原则：
 * - `state` 是**唯一**的应用状态单例，UI 状态也放在这里，不污染 `window`；
 * - `loadAll()` 并行拉取 settings/content/progress，**单个失败不阻塞启动**，降级为默认值/本地缓存；
 * - 进度本地乐观更新 + POST 串行队列，网络失败自动排队，下次成功时补交；
 * - 所有纯函数（`mergeProgressDelta` / `normalizeProgress` / `todayKey` …）均可单测。
 *
 * @module store
 */

import { api } from './api.js'

/* -------------------------------------------------------------------------- */
/* 常量 / 默认值                                                               */
/* -------------------------------------------------------------------------- */

/** localStorage 缓存键（设置 + 进度 + 当前模式）。 */
export const CACHE_KEY = 'ava.cache.v1'

/** 未成功提交的进度增量队列键。 */
export const PENDING_KEY = 'ava.pendingProgress.v1'

/** 缓存最多保留的消息条数（会话内容不落盘，仅防误存；当前不持久化 messages）。 */
const MAX_CORRECTIONS = 30
const MAX_WORDS = 300

/**
 * 默认设置（与 GET /api/settings 字段一致）。
 * @returns {{baseUrl: string, model: string, hasKey: boolean, keyHint: string, level: string, teacherName: string, voice: string, explainChinese: boolean, autoListen: boolean}}
 */
export function createDefaultSettings() {
  return {
    baseUrl: '',
    model: '',
    hasKey: false,
    keyHint: '',
    level: 'A2',
    teacherName: 'Ava',
    voice: '',
    explainChinese: true,
    autoListen: false,
  }
}

/**
 * 默认内容库（服务不可用时的空壳，保证 UI 不崩）。
 * 兼容 SPEC v1.1：`openers.free`（自由对话开场白）与 `icebreakers`（聊天灵感）为新增字段。
 * @returns {{topics: Array, scenarios: Array, sentenceBanks: Array, vocabTopics: Array, levels: string[], presets: Array, openers: {free: string[]}, icebreakers: Array, modes: object|null, defaults: object|null, topicsNote: string}}
 */
export function createDefaultContent() {
  return {
    topics: [],
    scenarios: [],
    sentenceBanks: [],
    vocabTopics: [],
    levels: ['A1', 'A2', 'B1', 'B2', 'C1'],
    presets: [],
    openers: { free: [] },
    icebreakers: [],
    modes: null,
    defaults: null,
    topicsNote: '',
  }
}

/**
 * 默认进度（与 GET /api/progress 字段一致）。
 * @returns {{streak: number, totalTurns: number, totalMinutes: number, words: Record<string, object>, days: Array<{date: string, turns: number, minutes: number}>, updatedAt: string|null}}
 */
export function createDefaultProgress() {
  return {
    streak: 0,
    totalTurns: 0,
    totalMinutes: 0,
    words: {},
    days: [],
    updatedAt: null,
  }
}

/** SRS（Leitner）间隔天数，需与 lib/srs.js 保持一致。 */
const SRS_INTERVALS = [0, 1, 2, 4, 7, 14, 30, 60]
const SRS_MAX_BOX = 7

/* -------------------------------------------------------------------------- */
/* 纯函数工具                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 本地日期键 `YYYY-MM-DD`（按本机时区）。
 * @param {Date} [date]
 * @returns {string}
 */
export function todayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 数字兜底（非有限数返回 fallback）。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 规范化进度对象（兼容服务端返回缺字段/类型漂移）。
 * @param {unknown} progress
 * @returns {{streak: number, totalTurns: number, totalMinutes: number, words: Record<string, object>, days: Array<object>, updatedAt: string|null}}
 */
export function normalizeProgress(progress) {
  const base = createDefaultProgress()
  if (!progress || typeof progress !== 'object') return base
  const p = /** @type {Record<string, unknown>} */ (progress)
  const words = p.words && typeof p.words === 'object' ? /** @type {Record<string, object>} */ (p.words) : {}
  const days = Array.isArray(p.days) ? p.days.filter((d) => d && typeof d === 'object') : []
  const updatedAt =
    typeof p.updatedAt === 'string' && p.updatedAt
      ? p.updatedAt
      : typeof p.updatedAt === 'number' && p.updatedAt > 0
        ? new Date(p.updatedAt).toISOString()
        : null
  return {
    // 保留服务端扩展字段（如 lastActive / totalWords / masteredWords / dueWords / dueCount）
    ...p,
    streak: Math.max(0, Math.round(numberOr(p.streak, 0))),
    totalTurns: Math.max(0, Math.round(numberOr(p.totalTurns, 0))),
    totalMinutes: Math.max(0, Math.round(numberOr(p.totalMinutes, 0) * 10) / 10),
    words: { ...words },
    days: days.map((d) => {
      const day = /** @type {Record<string, unknown>} */ (d)
      return {
        ...day,
        date: typeof day.date === 'string' ? day.date : '',
        turns: Math.max(0, Math.round(numberOr(day.turns, 0))),
        minutes: Math.max(0, Math.round(numberOr(day.minutes, 0) * 10) / 10),
      }
    }),
    updatedAt,
  }
}

/**
 * 把进度增量合并进进度对象（**纯函数，不修改入参**）。
 *
 * 语义与后端一致（乐观本地更新用，服务器返回后会以服务器为准覆盖）：
 * - `turns` / `minutes` 累加到总数与今天的 `days` 记录；
 * - `reviewWords` 走简化 Leitner：正确 box+1（上限 7），错误 box 归 0，`due` 按间隔天数推进；
 * - `streak` 按 `days` 连续日期粗略重算（服务器返回后会被覆盖）。
 *
 * @param {object} progress 当前进度（可传 normalizeProgress 结果）
 * @param {{turns?: number, minutes?: number, reviewWords?: Array<{word: string, correct?: boolean}>}} [delta]
 * @param {Date} [nowDate] 可注入当前时间（测试用）
 * @returns {object} 新进度对象
 */
export function mergeProgressDelta(progress, delta = {}, nowDate = new Date()) {
  const base = normalizeProgress(progress)
  const d = delta && typeof delta === 'object' ? delta : {}
  const turns = Math.max(0, numberOr(d.turns, 0))
  const minutes = Math.max(0, numberOr(d.minutes, 0))
  const reviewWords = Array.isArray(d.reviewWords) ? d.reviewWords : []
  const now = nowDate instanceof Date ? nowDate : new Date(nowDate)

  const next = {
    ...base,
    totalTurns: base.totalTurns + Math.round(turns),
    totalMinutes: Math.round((base.totalMinutes + minutes) * 10) / 10,
    words: { ...base.words },
    days: base.days.map((d) => ({ ...d })),
    updatedAt: now.toISOString(),
  }

  // 今天的记录
  if (turns > 0 || minutes > 0) {
    const key = todayKey(now)
    let today = next.days.find((d) => d.date === key)
    if (!today) {
      today = { date: key, turns: 0, minutes: 0 }
      next.days.push(today)
    }
    today.turns = Math.max(0, Math.round(numberOr(today.turns, 0) + turns))
    today.minutes = Math.round((numberOr(today.minutes, 0) + minutes) * 10) / 10
    next.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    // 只保留最近 60 天
    if (next.days.length > 60) next.days = next.days.slice(-60)
  }

  // 单词复习（简化 Leitner）
  for (const item of reviewWords) {
    if (!item || typeof item !== 'object') continue
    const word = String(item.word || '').trim()
    if (!word) continue
    const correct = !!item.correct
    const prev = next.words[word] && typeof next.words[word] === 'object' ? next.words[word] : {}
    const prevBox = Math.max(0, Math.min(SRS_MAX_BOX, Math.round(numberOr(prev.box, 0))))
    const box = correct ? Math.min(SRS_MAX_BOX, prevBox + 1) : 0
    const intervalDays = SRS_INTERVALS[Math.min(box, SRS_INTERVALS.length - 1)]
    const due = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000)
    next.words[word] = {
      ...prev,
      box,
      due: due.toISOString(),
      seen: Math.max(0, Math.round(numberOr(prev.seen, 0))) + 1,
      correct: Math.max(0, Math.round(numberOr(prev.correct, 0))) + (correct ? 1 : 0),
    }
  }

  next.streak = computeStreak(next.days, now)
  return next
}

/**
 * 根据 days 重算连续天数（含今天或昨天起算）。
 * @param {Array<{date: string}>} days
 * @param {Date} [nowDate]
 * @returns {number}
 */
export function computeStreak(days, nowDate = new Date()) {
  const set = new Set((Array.isArray(days) ? days : []).map((d) => (d && d.date ? d.date : '')).filter(Boolean))
  if (!set.size) return 0
  const cursor = new Date(nowDate instanceof Date ? nowDate : new Date(nowDate))
  // 今天还没学，则从昨天开始算
  if (!set.has(todayKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  for (let i = 0; i < 400; i += 1) {
    const key = todayKey(cursor)
    if (!set.has(key)) break
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/**
 * 合并两个进度增量（用于离线排队累积）。
 * @param {{turns?: number, minutes?: number, reviewWords?: Array<{word: string, correct?: boolean}>}} a
 * @param {{turns?: number, minutes?: number, reviewWords?: Array<{word: string, correct?: boolean}>}} b
 * @returns {{turns: number, minutes: number, reviewWords: Array<{word: string, correct?: boolean}>}}
 */
export function mergeDeltas(a = {}, b = {}) {
  const left = a && typeof a === 'object' ? a : {}
  const right = b && typeof b === 'object' ? b : {}
  const reviewWords = [
    ...(Array.isArray(left.reviewWords) ? left.reviewWords : []),
    ...(Array.isArray(right.reviewWords) ? right.reviewWords : []),
  ]
  return {
    turns: Math.max(0, numberOr(left.turns, 0)) + Math.max(0, numberOr(right.turns, 0)),
    minutes:
      Math.round((Math.max(0, numberOr(left.minutes, 0)) + Math.max(0, numberOr(right.minutes, 0))) * 10) / 10,
    reviewWords,
  }
}

/**
 * 判断进度增量是否为空。
 * @param {{turns?: number, minutes?: number, reviewWords?: Array<unknown>}} delta
 * @returns {boolean}
 */
export function isEmptyDelta(delta) {
  if (!delta) return true
  return !(numberOr(delta.turns, 0) > 0 || numberOr(delta.minutes, 0) > 0 || (Array.isArray(delta.reviewWords) && delta.reviewWords.length > 0))
}

/**
 * 把 feedback 里的生词规范化成词库项。
 * @param {unknown} newWords
 * @returns {Array<{word: string, phonetic: string, meaning: string, example: string}>}
 */
export function normalizeNewWords(newWords) {
  if (!Array.isArray(newWords)) return []
  const out = []
  for (const item of newWords) {
    if (!item || typeof item !== 'object') continue
    const w = /** @type {Record<string, unknown>} */ (item)
    const word = String(w.word || '').trim()
    if (!word) continue
    out.push({
      word,
      phonetic: typeof w.phonetic === 'string' ? w.phonetic : '',
      meaning: typeof w.meaning === 'string' ? w.meaning : '',
      example: typeof w.example === 'string' ? w.example : '',
    })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* localStorage（全部 try/catch，隐私模式/配额满也不影响启动）                   */
/* -------------------------------------------------------------------------- */

/**
 * 读取 localStorage（不可用时返回 null）。
 * @param {string} key
 * @returns {string|null}
 */
function readStorage(key) {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * 写入 localStorage（不可用时静默失败）。
 * @param {string} key
 * @param {string|null} value
 * @returns {boolean}
 */
function writeStorage(key, value) {
  try {
    if (typeof localStorage === 'undefined') return false
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/**
 * 读取本地缓存对象。
 * @returns {object|null}
 */
function readCache() {
  const raw = readStorage(CACHE_KEY)
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/**
 * 读取未提交的进度增量。
 * @returns {{turns: number, minutes: number, reviewWords: Array<object>}|null}
 */
export function getPendingProgress() {
  const raw = readStorage(PENDING_KEY)
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
    const merged = {
      turns: Math.max(0, numberOr(data.turns, 0)),
      minutes: Math.max(0, numberOr(data.minutes, 0)),
      reviewWords: Array.isArray(data.reviewWords) ? data.reviewWords : [],
    }
    return isEmptyDelta(merged) ? null : merged
  } catch {
    return null
  }
}

/**
 * 写入未提交的进度增量。
 * @param {object|null} delta
 * @returns {void}
 */
function writePendingProgress(delta) {
  if (!delta || isEmptyDelta(delta)) {
    writeStorage(PENDING_KEY, null)
    return
  }
  try {
    writeStorage(PENDING_KEY, JSON.stringify(delta))
  } catch {
    /* 忽略 */
  }
}

/* -------------------------------------------------------------------------- */
/* state 单例                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 全局唯一状态单例。app-dev 可直接读写（`state.mode = 'free'`、`state.messages.push(...)`）。
 *
 * @type {{
 *   settings: ReturnType<typeof createDefaultSettings>,
 *   content: ReturnType<typeof createDefaultContent>,
 *   progress: ReturnType<typeof createDefaultProgress>,
 *   mode: 'free'|'roleplay'|'vocab'|'pronounce'|string,
 *   level: string,
 *   messages: Array<{role: 'user'|'assistant'|'system', content: string, ts: number, [key: string]: unknown}>,
 *   corrections: Array<object>,
 *   words: Array<object>,
 *   session: {turns: number, minutes: number, startedAt: number|null},
 *   ui: {view: string, rightPanelOpen: boolean, settingsOpen: boolean},
 *   status: 'idle'|'listening'|'thinking'|'speaking'|string,
 *   loading: boolean,
 *   loaded: boolean,
 *   errors: Array<{scope: string, message: string, at: number}>,
 *   progressDirty: boolean,
 *   lastUpdatedAt: number|null,
 * }}
 */
export const state = {
  settings: createDefaultSettings(),
  content: createDefaultContent(),
  progress: createDefaultProgress(),
  mode: 'free',
  level: 'A2',
  messages: [],
  corrections: [],
  words: [],
  session: { turns: 0, minutes: 0, startedAt: null },
  ui: { view: 'chat', rightPanelOpen: true, settingsOpen: false },
  status: 'idle',
  loading: false,
  loaded: false,
  errors: [],
  progressDirty: false,
  lastUpdatedAt: null,
}

/* -------------------------------------------------------------------------- */
/* 状态工具                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 记录一条状态错误（不清除其它错误；UI 可展示最近一条）。
 * @param {string} scope 例如 `'loadAll'` / `'saveProgress'`
 * @param {unknown} error
 * @returns {void}
 */
export function pushError(scope, error) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(/** @type {any} */ (error).message)
      : String(error == null ? '未知错误' : error)
  state.errors.push({ scope, message, at: Date.now() })
  if (state.errors.length > 20) state.errors.splice(0, state.errors.length - 20)
}

/**
 * 应用设置（合并默认值 + 同步 level + 写缓存）。
 * @param {Partial<ReturnType<typeof createDefaultSettings>>|null|undefined} settings
 * @returns {ReturnType<typeof createDefaultSettings>}
 */
export function setSettings(settings) {
  state.settings = { ...createDefaultSettings(), ...(settings && typeof settings === 'object' ? settings : {}) }
  if (state.settings.level) state.level = state.settings.level
  cacheState()
  return state.settings
}

/**
 * 应用内容库（缺字段补空数组，避免 UI `map` 报错）。
 *
 * 注意：除 SPEC 基础字段外，**保留服务端扩展字段**（v1.1 的 `openers.free`、`icebreakers`、
 * `modes`、`defaults`、`topicsNote` 等），app-dev 可直接读 `state.content.openers.free`
 * 与 `state.content.icebreakers`。
 *
 * @param {Partial<ReturnType<typeof createDefaultContent>>|null|undefined} content
 * @returns {ReturnType<typeof createDefaultContent>}
 */
export function setContent(content) {
  const base = createDefaultContent()
  const c = content && typeof content === 'object' ? content : {}
  const openers =
    c.openers && typeof c.openers === 'object'
      ? { ...base.openers, ...c.openers, free: Array.isArray(c.openers.free) ? c.openers.free : base.openers.free }
      : base.openers
  state.content = {
    ...base,
    ...c,
    topics: Array.isArray(c.topics) ? c.topics : base.topics,
    scenarios: Array.isArray(c.scenarios) ? c.scenarios : base.scenarios,
    sentenceBanks: Array.isArray(c.sentenceBanks) ? c.sentenceBanks : base.sentenceBanks,
    vocabTopics: Array.isArray(c.vocabTopics) ? c.vocabTopics : base.vocabTopics,
    levels: Array.isArray(c.levels) && c.levels.length ? c.levels : base.levels,
    presets: Array.isArray(c.presets) ? c.presets : base.presets,
    openers,
    icebreakers: Array.isArray(c.icebreakers) ? c.icebreakers : base.icebreakers,
  }
  return state.content
}

/**
 * 应用服务器权威进度（覆盖本地乐观值）。
 * @param {unknown} progress
 * @returns {ReturnType<typeof createDefaultProgress>}
 */
export function setProgress(progress) {
  state.progress = normalizeProgress(progress)
  state.progressDirty = false
  cacheState()
  return state.progress
}

/**
 * 切换教学模式（free|roleplay|vocab|pronounce）。
 * @param {string} mode
 * @returns {string}
 */
export function setMode(mode) {
  state.mode = String(mode || 'free')
  cacheState()
  return state.mode
}

/**
 * 切换 CEFR 等级。
 * @param {string} level
 * @returns {string}
 */
export function setLevel(level) {
  state.level = String(level || 'A2')
  state.settings.level = state.level
  cacheState()
  return state.level
}

/**
 * 追加一条消息。
 * @param {'user'|'assistant'|'system'} role
 * @param {string} content
 * @param {Record<string, unknown>} [extra]
 * @returns {{role: string, content: string, ts: number, [key: string]: unknown}}
 */
export function addMessage(role, content, extra = {}) {
  const message = {
    role,
    content: String(content == null ? '' : content),
    ts: Date.now(),
    ...(extra && typeof extra === 'object' ? extra : {}),
  }
  state.messages.push(message)
  if (state.messages.length > 400) state.messages.splice(0, state.messages.length - 400)
  return message
}

/** 清空对话消息（新会话）。 */
export function clearMessages() {
  state.messages = []
  state.corrections = []
}

/**
 * 记录一轮 AI 反馈（纠正卡片 + 生词本 + 生词复习）。
 * @param {object|null|undefined} feedback `feedback` 事件 payload
 * @returns {{corrections: Array<object>, words: Array<object>}}
 */
export function applyFeedback(feedback) {
  const fb = feedback && typeof feedback === 'object' ? feedback : {}
  /** @type {Array<object>} */
  const corrections = Array.isArray(fb.corrections) ? fb.corrections.filter((c) => c && typeof c === 'object') : []
  /** @type {Array<object>} */
  const better = Array.isArray(fb.better) ? fb.better.filter((b) => b && typeof b === 'object') : []
  const newWords = normalizeNewWords(fb.newWords)

  const card = {
    at: Date.now(),
    corrections,
    better,
    newWords,
    encouragement_zh: typeof fb.encouragement_zh === 'string' ? fb.encouragement_zh : '',
    followUp: typeof fb.followUp === 'string' ? fb.followUp : '',
  }
  if (corrections.length || better.length || newWords.length || card.encouragement_zh) {
    state.corrections.push(card)
    if (state.corrections.length > MAX_CORRECTIONS) {
      state.corrections.splice(0, state.corrections.length - MAX_CORRECTIONS)
    }
  }

  // 生词本去重合并
  for (const word of newWords) {
    const existing = state.words.find((w) => w && w.word === word.word)
    if (existing) Object.assign(existing, word, { ts: Date.now() })
    else state.words.push({ ...word, ts: Date.now() })
  }
  if (state.words.length > MAX_WORDS) state.words.splice(0, state.words.length - MAX_WORDS)

  return { corrections, words: newWords }
}

/**
 * 取 SRS 到期（或新词）列表，供单词闯关复习。
 * @param {number} [limit=10]
 * @param {Date} [nowDate]
 * @returns {Array<{word: string, box: number, due: string, seen: number, correct: number}>}
 */
export function getDueWords(limit = 10, nowDate = new Date()) {
  const now = nowDate instanceof Date ? nowDate : new Date(nowDate)
  const words = state.progress && state.progress.words ? state.progress.words : {}
  const due = []
  for (const [word, info] of Object.entries(words)) {
    if (!info || typeof info !== 'object') continue
    const item = /** @type {Record<string, unknown>} */ (info)
    const dueAt = typeof item.due === 'string' ? Date.parse(item.due) : 0
    if (!Number.isFinite(dueAt) || dueAt <= now.getTime()) {
      due.push({
        word,
        box: Math.max(0, Math.round(numberOr(item.box, 0))),
        due: typeof item.due === 'string' ? item.due : '',
        seen: Math.max(0, Math.round(numberOr(item.seen, 0))),
        correct: Math.max(0, Math.round(numberOr(item.correct, 0))),
      })
    }
  }
  due.sort((a, b) => a.box - b.box || a.word.localeCompare(b.word))
  const max = Math.max(1, Math.floor(numberOr(limit, 10)))
  return due.slice(0, max)
}

/* -------------------------------------------------------------------------- */
/* 缓存                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 把可缓存字段写入 localStorage（设置 / 进度 / 模式 / 等级）。任何异常静默忽略。
 * @returns {boolean} 是否写入成功
 */
export function cacheState() {
  const payload = {
    savedAt: Date.now(),
    mode: state.mode,
    level: state.level,
    settings: state.settings,
    progress: state.progress,
  }
  try {
    return writeStorage(CACHE_KEY, JSON.stringify(payload))
  } catch {
    return false
  }
}

/**
 * 从 localStorage 恢复缓存（模块加载时自动调用一次；也可手动调用）。
 * @returns {boolean} 是否恢复了缓存
 */
export function restoreCache() {
  const cached = readCache()
  if (!cached) return false
  if (cached.settings && typeof cached.settings === 'object') setSettings(cached.settings)
  if (cached.progress && typeof cached.progress === 'object') {
    state.progress = normalizeProgress(cached.progress)
  }
  if (typeof cached.mode === 'string' && cached.mode) state.mode = cached.mode
  if (typeof cached.level === 'string' && cached.level) state.level = cached.level
  return true
}

/**
 * 清空本地缓存（不含服务器数据）。
 * @returns {void}
 */
export function clearCache() {
  writeStorage(CACHE_KEY, null)
  writeStorage(PENDING_KEY, null)
}

/* -------------------------------------------------------------------------- */
/* 进度保存                                                                    */
/* -------------------------------------------------------------------------- */

/** 串行化 POST，避免并发覆盖。 @type {Promise<unknown>} */
let saveChain = Promise.resolve()
/** @type {ReturnType<typeof setTimeout>|null} */
let autoSaveTimer = null
/** @type {{turns: number, minutes: number, reviewWords: Array<object>}|null} */
let autoSaveDelta = null

/**
 * 把进度增量排进串行队列发给服务器，成功后用服务器返回覆盖本地。
 * @param {{turns: number, minutes: number, reviewWords: Array<object>}} payload
 * @returns {Promise<{ok: boolean, progress: object, error?: unknown, queued?: boolean}>}
 */
function enqueuePersist(payload) {
  const task = saveChain.then(async () => {
    try {
      const merged = await api.saveProgress(payload)
      if (merged && typeof merged === 'object') {
        state.progress = normalizeProgress(merged)
        state.progressDirty = false
        // 成功提交后，若还有历史离线排队增量，继续补交给服务器（不能只本地合并，否则刷新后丢失）
        const pending = getPendingProgress()
        if (pending) {
          writePendingProgress(null)
          if (!isEmptyDelta(pending)) enqueuePersist(pending).catch(() => undefined)
        }
        cacheState()
      }
      state.lastUpdatedAt = Date.now()
      return { ok: true, progress: state.progress }
    } catch (err) {
      // 网络失败：本地已乐观合并过 → 只把增量排队，等下次补交
      const pending = mergeDeltas(getPendingProgress() || { turns: 0, minutes: 0, reviewWords: [] }, payload)
      writePendingProgress(pending)
      state.progressDirty = true
      pushError('saveProgress', err)
      return { ok: false, progress: state.progress, error: err, queued: true }
    }
  })
  saveChain = task.catch(() => undefined)
  return task
}

/**
 * 取消自动保存（有其它显式保存接管时）。
 * @returns {void}
 */
function cancelAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
  autoSaveDelta = null
}

/**
 * recordTurn 的延迟合并保存：连续多轮只在 1.6s 内合并成一次 POST。
 * @param {{turns: number, minutes: number, reviewWords: Array<object>}} delta
 * @returns {void}
 */
function scheduleAutoSave(delta) {
  autoSaveDelta = autoSaveDelta ? mergeDeltas(autoSaveDelta, delta) : { ...delta }
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null
    const pendingDelta = autoSaveDelta
    autoSaveDelta = null
    if (pendingDelta && !isEmptyDelta(pendingDelta)) {
      enqueuePersist(pendingDelta).catch(() => undefined)
    }
  }, 1600)
}

/**
 * 立即提交尚未持久化的 `recordTurn()` 增量（可在切换页面/暂停时调用）。
 * @returns {{ok: boolean, progress: object, error?: unknown, queued?: boolean}|null} 没有待提交内容时返回 null
 */
export function flushProgress() {
  if (!autoSaveTimer && !autoSaveDelta) return null
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
  const delta = autoSaveDelta
  autoSaveDelta = null
  if (!delta || isEmptyDelta(delta)) return null
  return enqueuePersist(delta)
}

/**
 * 保存进度增量（本地立即乐观更新 + 串行 POST）。
 *
 * 失败**不抛错**：返回 `{ok:false, queued:true, error}`，增量排队到 localStorage，
 * 下次 `loadAll()`/`flushPendingProgress()` 时自动补交。
 *
 * @param {{turns?: number, minutes?: number, reviewWords?: Array<{word: string, correct?: boolean}>}} [delta]
 * @returns {Promise<{ok: boolean, progress: object, error?: unknown, queued?: boolean}>}
 */
export function saveProgress(delta = {}) {
  // 显式保存接管：取消 recordTurn 的自动保存，避免重复计数
  cancelAutoSave()
  const d = delta && typeof delta === 'object' ? delta : {}
  const payload = {
    turns: Math.max(0, numberOr(d.turns, 0)),
    minutes: Math.max(0, Math.round(numberOr(d.minutes, 0) * 10) / 10),
    reviewWords: Array.isArray(d.reviewWords) ? d.reviewWords.filter((w) => w && typeof w === 'object') : [],
  }
  if (!isEmptyDelta(payload)) {
    state.progress = mergeProgressDelta(state.progress, payload)
    state.progressDirty = true
  }
  cacheState()
  if (isEmptyDelta(payload)) return Promise.resolve({ ok: true, progress: state.progress })
  return enqueuePersist(payload)
}

/**
 * 补交离线排队的进度增量（loadAll 成功后自动调用；也可手动调用）。
 * @returns {Promise<{ok: boolean, flushed: boolean, progress?: object, error?: unknown}>}
 */
export async function flushPendingProgress() {
  const pending = getPendingProgress()
  if (!pending) return { ok: true, flushed: false, progress: state.progress }
  // 先从队列移除再提交：成功分支不会把它当作“新的历史排队”重复补交；失败时 enqueuePersist 会重新排队
  writePendingProgress(null)
  const result = await enqueuePersist(pending)
  return { ...result, flushed: true }
}

/**
 * 记录一轮对话（本地计数 + 延迟自动持久化）。
 *
 * - 更新 `state.session.turns/minutes` 与 `state.progress`（本地缓存立即生效）；
 * - 1.6s 内的多轮合并为一次 `POST /api/progress`，失败自动排队；
 * - 若随后显式调用 `saveProgress()`，会自动取消这里的自动保存（避免重复计数）。
 *
 * @param {{minutes?: number, reviewWords?: Array<{word: string, correct?: boolean}>}} [delta]
 * @returns {object} 更新后的进度对象
 */
export function recordTurn(delta = {}) {
  const d = delta && typeof delta === 'object' ? delta : {}
  const minutes = Math.max(0, numberOr(d.minutes, 0))
  const reviewWords = Array.isArray(d.reviewWords) ? d.reviewWords.filter((w) => w && typeof w === 'object') : []
  const payload = { turns: 1, minutes, reviewWords }

  state.session.turns += 1
  state.session.minutes = Math.round((state.session.minutes + minutes) * 10) / 10
  if (!state.session.startedAt) state.session.startedAt = Date.now()

  state.progress = mergeProgressDelta(state.progress, payload)
  state.progressDirty = true
  cacheState()
  scheduleAutoSave(payload)
  return state.progress
}

/**
 * 重置本会话计数（保留服务器累计进度）。
 * @returns {void}
 */
export function resetSession() {
  flushProgress()
  state.session = { turns: 0, minutes: 0, startedAt: null }
  state.messages = []
  state.corrections = []
  state.status = 'idle'
}

/* -------------------------------------------------------------------------- */
/* loadAll                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 把 Promise 包装成“永不 reject + 超时”的结果对象。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} scope
 * @returns {Promise<{ok: true, value: T}|{ok: false, error: unknown}>}
 */
function settle(promise, timeoutMs, scope) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: new Error(`${scope} 请求超时（${timeoutMs}ms）`) })
    }, Math.max(200, numberOr(timeoutMs, 8000)))
    promise.then(
      (value) => finish({ ok: true, value }),
      (error) => finish({ ok: false, error }),
    )
  })
}

/** loadAll 单飞 Promise。 @type {Promise<object>|null} */
let loadAllPromise = null

/**
 * 并行加载 `/api/settings`、`/api/content`、`/api/progress`。
 *
 * - **任何一项失败都不会 reject**：settings/content 降级为默认值（或本地缓存），progress 降级为默认值/本地缓存；
 * - 全部页面启动只应 `await loadAll()` 一次；重复调用返回同一个 Promise（`force:true` 可强制刷新）；
 * - 自动读取 localStorage 缓存（模块加载时已恢复一次，这里仍会再合并一次保证数据最新）；
 * - 成功后自动补交离线排队的进度增量。
 *
 * @param {{force?: boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, settings: boolean, content: boolean, progress: boolean, errors: Array<{scope: string, message: string, at: number}>}>}
 */
export function loadAll(opts = {}) {
  const { force = false, timeoutMs = 8000 } = opts || {}
  if (loadAllPromise && !force) return loadAllPromise

  loadAllPromise = (async () => {
    state.loading = true
    state.errors = []
    restoreCache()

    const [settingsResult, contentResult, progressResult] = await Promise.all([
      settle(api.getSettings(), timeoutMs, '设置'),
      settle(api.getContent(), timeoutMs, '内容库'),
      settle(api.getProgress(), timeoutMs, '进度'),
    ])

    if (settingsResult.ok) {
      setSettings(/** @type {any} */ (settingsResult.value))
    } else {
      pushError('settings', /** @type {any} */ (settingsResult).error)
    }
    if (contentResult.ok) {
      setContent(/** @type {any} */ (contentResult.value))
    } else {
      pushError('content', /** @type {any} */ (contentResult).error)
    }
    if (progressResult.ok) {
      state.progress = normalizeProgress(/** @type {any} */ (progressResult).value)
      state.progressDirty = false
      cacheState()
    } else {
      pushError('progress', /** @type {any} */ (progressResult).error)
    }

    state.loading = false
    state.loaded = true
    state.lastUpdatedAt = Date.now()

    // 进度接口恢复后，补交离线期间的增量（不阻塞启动）
    if (progressResult.ok && getPendingProgress()) {
      flushPendingProgress().catch(() => undefined)
    }

    return {
      ok: settingsResult.ok && contentResult.ok && progressResult.ok,
      settings: settingsResult.ok,
      content: contentResult.ok,
      progress: progressResult.ok,
      errors: state.errors.slice(),
    }
  })()

  const current = loadAllPromise
  current.finally(() => {
    if (loadAllPromise === current) loadAllPromise = null
  })
  return current
}

/* -------------------------------------------------------------------------- */
/* 初始化                                                                      */
/* -------------------------------------------------------------------------- */

// 启动瞬间先用本地缓存渲染（不等网络）
restoreCache()

// 页面关闭前，尽量把 recordTurn 的延迟增量提交掉（失败也会排进 localStorage）
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  try {
    window.addEventListener('pagehide', () => {
      const pendingDelta = autoSaveDelta
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer)
        autoSaveTimer = null
        autoSaveDelta = null
      }
      if (pendingDelta && !isEmptyDelta(pendingDelta)) {
        enqueuePersist(pendingDelta).catch(() => undefined)
      }
    })
  } catch {
    /* 忽略 */
  }
}

// 仅当显式打开调试开关时才挂带前缀的调试钩子（不污染 window）
if (typeof window !== 'undefined') {
  try {
    if (/** @type {any} */ (window).__AVA_DEBUG__ === true) {
      /** @type {any} */ (window).__AVA_DEBUG_STORE__ = state
    }
  } catch {
    /* 忽略 */
  }
}

export default state
