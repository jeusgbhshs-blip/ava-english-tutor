import { apiFetch } from '../backend.js'
/**
 * Ava 手机版 · 第 6 个 Tab「复习」
 *
 * 功能（SPEC v2.7 §B，方案 A + C）：
 * - 复习首页：今日到期数 / 生词本 / 已掌握 / 掌握进度环 / 开始复习 / 词库管理 / 小游戏入口；
 * - 复习会话：单词卡（点击单词或 🔊 用浏览器 TTS 朗读）→ 翻转看音标/释义/例句/来源 →
 *   四档评分（again / hard / good / easy）走 SRS → 进度 x/y → 结束统计 + 再来一轮；
 * - 词库管理：生词本 / 已掌握 / 全部 + 搜索 + 发音 + 状态切换 + 删除 + 新增单词；
 * - 小游戏：词义配对、听音选词、拼写填空（用复习库单词；不足时用内置示例词并提示）；
 * - 每日提醒：初始化 / 切到复习 Tab 时拉 summary，due>0 且当天未提醒过 → toast + Tab 徽标。
 *
 * 数据接口由 `web/js/api.js` 的 v2.7 方法提供（永不 throw）；若尚未加载到这些方法，
 * 内部会直接 fetch `/api/review/*` 兜底，因此模块可独立运行。
 * @module mobile/review
 */
import { api } from '../api.js'
import { $, esc, icon, toast, M, ui, mmss, translateTexts } from './core.js'
import { tts } from '../speech.js'
import { playCharacterText, stopCharacterText } from './voice-audio.js'

/* ==========================================================================
   常量 / 本地图标
   ========================================================================== */
const REMIND_KEY = 'ava.review.remindedDate'
const MATCH_SCORE_KEY = 'ava.mobile.review.match.score'
const DAILY_REVIEW_KEY = 'ava.review.daily.v1'
const SESSION_DRAFT_KEY = 'ava.review.session.draft.v1'
const GAME_ROUND = { match: 5, listen: 6, spell: 5 }

/** 复习模块专用内联图标（不在 mobile.html 的 sprite 里）。 */
const R_ICONS = {
  review:
    '<rect x="3" y="5" width="12" height="16" rx="2.6"/><path d="M8 2.6h9.4A2.6 2.6 0 0 1 20 5.2V16"/><path d="M6.8 10h4.4M6.8 13.5h4.4M6.8 17h2.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash:
    '<path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.9 12.1A1.9 1.9 0 0 0 9.3 21h5.4a1.9 1.9 0 0 0 1.9-1.9L17.5 7M10 11v6M14 11v6"/>',
  play: '<path d="m8 4.8 11 7.2-11 7.2V4.8Z"/>',
  trophy:
    '<path d="M8 4h8v5.2a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5.2A1.2 1.2 0 0 0 4 7.2 3.8 3.8 0 0 0 7.8 11M16 6h2.8A1.2 1.2 0 0 1 20 7.2 3.8 3.8 0 0 1 16.2 11"/><path d="M12 13.2V17M8.6 21h6.8M9.6 17h4.8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.2-4.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.2V12l3.2 2"/>',
  cards:
    '<rect x="2.8" y="4.2" width="13.2" height="15.6" rx="2.4"/><path d="M18.4 6.6v12.8a2 2 0 0 1-2 2H7.6"/><path d="M7.2 9.4h4.4M7.2 12.8h4.4M7.2 16.2h2.4"/>',
  spell:
    '<path d="M3.5 20.5 9.4 4h1.7l5.9 16.5M5.9 15h8.6"/><path d="M19 20.5l1.8-4.6.5 4.6H19Z"/>',
}

/** 内置示例词（复习库为空时的小游戏兜底）。 */
const SAMPLE_WORDS = [
  { word: 'delicious', meaning: '美味的', phonetic: '/dɪˈlɪʃəs/' },
  { word: 'journey', meaning: '旅程；旅行', phonetic: '/ˈdʒɜːrni/' },
  { word: 'curious', meaning: '好奇的', phonetic: '/ˈkjʊriəs/' },
  { word: 'exhibition', meaning: '展览', phonetic: '/ˌeksɪˈbɪʃn/' },
  { word: 'confident', meaning: '自信的', phonetic: '/ˈkɑːnfɪdənt/' },
  { word: 'schedule', meaning: '日程；安排', phonetic: '/ˈskedʒuːl/' },
  { word: 'creative', meaning: '有创意的', phonetic: '/kriˈeɪtɪv/' },
  { word: 'recommend', meaning: '推荐', phonetic: '/ˌrekəˈmend/' },
  { word: 'convenient', meaning: '方便的', phonetic: '/kənˈviːniənt/' },
  { word: 'adventure', meaning: '冒险；奇遇', phonetic: '/ədˈventʃər/' },
  { word: 'practice', meaning: '练习', phonetic: '/ˈpræktɪs/' },
  { word: 'encourage', meaning: '鼓励', phonetic: '/ɪnˈkɜːrɪdʒ/' },
  { word: 'neighborhood', meaning: '街区；社区', phonetic: '/ˈneɪbərhʊd/' },
  { word: 'appreciate', meaning: '感激；欣赏', phonetic: '/əˈpriːʃieɪt/' },
  { word: 'opportunity', meaning: '机会', phonetic: '/ˌɑːpərˈtuːnəti/' },
  { word: 'conversation', meaning: '对话；交谈', phonetic: '/ˌkɑːnvərˈseɪʃn/' },
  { word: 'challenge', meaning: '挑战', phonetic: '/ˈtʃælɪndʒ/' },
  { word: 'progress', meaning: '进步', phonetic: '/ˈprɑːɡres/' },
]

const STATUS_LABEL = { new: '新词', learning: '生词本', known: '已掌握' }
const GRADE_LABEL = { again: '不认识', hard: '模糊', good: '认识', easy: '简单' }
const GAME_META = [
  { kind: 'match', title: '词义配对', sub: '英文 ↔ 中文，两两配对', icon: 'cards', tone: '' },
  { kind: 'listen', title: '听音选词', sub: '听发音，从 4 个选项里选单词', icon: 'volume', tone: 'violet' },
  { kind: 'spell', title: '拼写填空', sub: '看释义和音标，拼出英文单词', icon: 'spell', tone: 'warm' },
]

/* ==========================================================================
   运行期状态
   ========================================================================== */
function emptySummary() {
  return { total: 0, dueCount: 0, newCount: 0, learningCount: 0, knownCount: 0 }
}

const R = {
  inited: false,
  view: 'home', // home | session | finish | manage | game
  token: 0,
  summary: emptySummary(),
  summaryLoaded: false,
  summaryLoading: false,
  summaryError: '',
  session: null,
  finish: null,
  manage: {
    status: 'unfamiliar',
    q: '',
    words: [],
    counts: null,
    loading: false,
    loadToken: 0,
    pendingWord: '',
    adding: false,
    addOpen: false,
    deleting: '',
    deleteTimer: 0,
    queued: false,
    error: '',
  },
  game: { kind: 'match', token: 0, cleanup: null },
  wordsCache: null,
  wordsCacheAt: 0,
  recent: [],
  dailyReviewed: [],
  dailyTarget: 0,
  recentAt: 0,
  recentLoading: false,
  pollTimer: 0,
}

let summaryPromise = null
let reviewSpeechToken = 0

/* ==========================================================================
   小工具
   ========================================================================== */
function rIcon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${R_ICONS[name] || ''}</svg>`
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function todayKey() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function loadDailyState() {
  try {
    const raw = JSON.parse(localStorage.getItem(DAILY_REVIEW_KEY) || 'null')
    if (!raw || raw.date !== todayKey()) return { words: [], target: 0 }
    return {
      words: Array.isArray(raw.words) ? [...new Set(raw.words.map(String).filter(Boolean))] : [],
      target: Math.max(0, Math.floor(Number(raw.target) || 0)),
    }
  } catch {
    return { words: [], target: 0 }
  }
}

function saveDailyState() {
  try {
    localStorage.setItem(
      DAILY_REVIEW_KEY,
      JSON.stringify({ date: todayKey(), words: R.dailyReviewed, target: R.dailyTarget }),
    )
  } catch {
    /* 忽略 */
  }
}

function markReviewedToday(word) {
  const value = String(word || '').trim()
  if (!value) return
  if (!Array.isArray(R.dailyReviewed)) R.dailyReviewed = []
  if (R.dailyReviewed.includes(value)) return
  R.dailyReviewed.push(value)
  saveDailyState()
}

function loadSessionDraft(mode) {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_DRAFT_KEY) || 'null')
    if (!raw || raw.date !== todayKey() || raw.mode !== mode) return null
    if (!Array.isArray(raw.words) || !raw.words.length) return null
    const index = Math.max(0, Math.min(raw.words.length - 1, Math.floor(Number(raw.index) || 0)))
    return { ...raw, index }
  } catch {
    return null
  }
}

function loadAnySessionDraft() {
  for (const mode of ['due', 'again', 'extra']) {
    const draft = loadSessionDraft(mode)
    if (draft && draft.index < draft.words.length) return draft
  }
  return null
}

function saveSessionDraft(s) {
  if (!s || !Array.isArray(s.words) || !s.words.length) return
  // 已成功评分的词不能因为反馈动画尚未结束，再次成为恢复入口。
  const resumeIndex = s.index + (s.advancePending ? 1 : 0)
  if (resumeIndex >= s.words.length) {
    clearSessionDraft()
    return
  }
  try {
    localStorage.setItem(
      SESSION_DRAFT_KEY,
      JSON.stringify({
        date: todayKey(),
        mode: s.mode,
        words: s.words,
        index: resumeIndex,
        answers: s.answers || [],
        startedAt: s.startedAt || Date.now(),
      }),
    )
  } catch {
    /* 忽略 */
  }
}

function clearSessionDraft() {
  try {
    localStorage.removeItem(SESSION_DRAFT_KEY)
  } catch {
    /* 忽略 */
  }
}

function shuffle(list) {
  const arr = Array.isArray(list) ? list.slice() : []
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

function reviewHost() {
  return document.getElementById('screen-review')
}

function errorMessage(err) {
  if (!err) return '网络异常，请稍后重试'
  if (typeof err === 'string') return err
  return String(err.message || err.error || '网络异常，请稍后重试')
}

/** 学习来源标签（对话 / 文章 / 手动）。 */
function sourceLabel(word) {
  const source = String((word && word.source) || 'manual')
  const title = String((word && word.sourceTitle) || '').trim()
  if (source === 'conversation') {
    const clean = title.replace(/[·•|]\s*(对话|conversation)\s*$/i, '').trim()
    return clean ? `来自对话 · ${clean}` : '来自对话'
  }
  if (source === 'reading' || source === 'doc' || source === 'article') {
    const clean = title.replace(/[·•|]\s*(文章|阅读|reading)\s*$/i, '').trim()
    return clean ? `来自文章 · ${clean}` : '来自文章'
  }
  if (source === 'wordbook') return '来自单词表'
  if (source === 'manual') return title ? `手动添加 · ${title}` : '手动添加'
  return title || '自定义'
}

/** 到期文案（优先用服务端 dueLabel）。 */
function dueText(word) {
  const label = String((word && word.dueLabel) || '').trim()
  if (!label) return ''
  return label === '现在' ? '现在可以复习' : `${label}复习`
}

/** 复习关键事件日志（QA / CDP 探针，不影响产品逻辑）。 */
function logReviewEvent(type, detail = {}) {
  try {
    if (!Array.isArray(window.__avaReviewEvents)) window.__avaReviewEvents = []
    window.__avaReviewEvents.push({ type, at: Date.now(), ...detail })
    if (window.__avaReviewEvents.length > 60) window.__avaReviewEvents.shift()
  } catch {
    /* 忽略 */
  }
}

function localDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/* ==========================================================================
   数据接口（api.js v2.7 方法优先；未就绪时直连 /api/review/*）
   ========================================================================== */
function apiMethod(name) {
  return api && typeof api[name] === 'function' ? api[name].bind(api) : null
}

function normalizeResult(data, fallbackError) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: fallbackError || '复习服务暂不可用，请稍后重试' }
  }
  if (data.ok === false) {
    return { ...data, ok: false, error: data.error || fallbackError || '操作失败，请稍后重试' }
  }
  return data
}

/** 直连后端的 JSON 请求（api.js 方法缺失时的兜底，永不 throw）。 */
async function fetchJSON(path, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1500, timeoutMs)) : null
  try {
    const res = await apiFetch(path, {
      method,
      headers: body == null ? undefined : { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    if (!res.ok) {
      return {
        ok: false,
        error: (data && (data.error || data.message)) || `请求失败（HTTP ${res.status}）`,
        status: res.status,
      }
    }
    return data && typeof data === 'object' ? data : { ok: true }
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
    return { ok: false, error: aborted ? '请求超时，请稍后重试' : '网络异常，无法连接本地服务' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 统一调用复习接口：优先 api.js 的 v2.7 方法（永不 throw），否则直连后端。
 * @param {{name:string,args?:any[],path:string,method?:string,body?:any,timeoutMs?:number}} options
 */
async function callReview({ name, args = [], path, method = 'GET', body = null, timeoutMs = 20000 }) {
  const fn = apiMethod(name)
  if (fn) {
    try {
      return normalizeResult(await fn(...args))
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }
  try {
    return normalizeResult(await fetchJSON(path, { method, body, timeoutMs }))
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

const getSummaryApi = () =>
  callReview({ name: 'getReviewSummary', path: '/api/review/summary', timeoutMs: 12000 })
const getDueApi = (limit = 40) =>
  callReview({
    name: 'getReviewDue',
    args: [limit],
    path: `/api/review/due?limit=${encodeURIComponent(String(limit))}`,
    timeoutMs: 15000,
  })
const listApi = ({ status = 'all', q = '', limit = 500 } = {}) =>
  callReview({
    name: 'listReview',
    args: [{ status, q, limit }],
    path: `/api/review/list?status=${encodeURIComponent(status)}${q ? `&q=${encodeURIComponent(q)}` : ''}&limit=${encodeURIComponent(String(limit))}`,
    timeoutMs: 15000,
  })
const addApi = (words) =>
  callReview({ name: 'addReviewWords', args: [words], path: '/api/review/add', method: 'POST', body: { words } })
const patchApi = (word, patch) =>
  callReview({
    name: 'updateReviewWord',
    args: [word, patch],
    path: '/api/review/word',
    method: 'PATCH',
    body: { word, patch },
  })
const deleteApi = (word) =>
  callReview({
    name: 'deleteReviewWord',
    args: [word],
    path: `/api/review/word?word=${encodeURIComponent(word)}`,
    method: 'DELETE',
  })
const gradeApi = (word, grade) =>
  callReview({
    name: 'gradeReviewWord',
    args: [word, grade],
    path: '/api/review/grade',
    method: 'POST',
    body: { word, grade },
  })

/* ==========================================================================
   Summary / Tab 徽标 / 每日提醒
   ========================================================================== */
function applySummary(raw) {
  if (!raw || raw.ok === false) return false
  R.summary = {
    total: num(raw.total),
    dueCount: num(raw.dueCount),
    newCount: num(raw.newCount),
    learningCount: num(raw.learningCount),
    knownCount: num(raw.knownCount),
  }
  updateBadge()
  return true
}

/** 底部 Tab 的 dueCount 徽标 + aria-label。 */
export function updateBadge() {
  const due = num(R.summary.dueCount)
  const badge = document.getElementById('tab-due')
  if (badge) {
    badge.textContent = due > 99 ? '99+' : String(due)
    badge.hidden = due <= 0
  }
  const tab = document.querySelector('#tabbar .tab[data-tab="review"]')
  if (tab) {
    tab.setAttribute('aria-label', due > 0 ? `复习，${due} 个单词今日到期` : '复习')
    tab.classList.toggle('has-due', due > 0)
  }
}

/** 拉取复习概览（并发去重；永不 throw）。 */
async function refreshSummary() {
  if (summaryPromise) return summaryPromise
  summaryPromise = (async () => {
    R.summaryLoading = true
    const res = await getSummaryApi()
    R.summaryLoading = false
    summaryPromise = null
    if (!res || res.ok === false) {
      R.summaryError = (res && res.error) || '复习服务暂不可用，请稍后重试'
      return false
    }
    R.summaryError = ''
    R.summaryLoaded = true
    applySummary(res)
    return true
  })()
  return summaryPromise
}

/** 当天首次且 due>0 → toast 提醒（localStorage 按日期去重）。 */
function maybeDailyReminder(summary) {
  const due = num(summary && summary.dueCount)
  if (due <= 0) return false
  const today = localDateKey()
  let last = ''
  try {
    last = localStorage.getItem(REMIND_KEY) || ''
  } catch {
    /* 无痕模式忽略 */
  }
  if (last === today) return false
  try {
    localStorage.setItem(REMIND_KEY, today)
  } catch {
    /* 忽略 */
  }
  logReviewEvent('daily-reminder', { due, date: today })
  toast(`今天有 ${due} 个单词要复习，花 3 分钟巩固一下？`, 'info', 4200)
  return true
}

/** App 初始化时调用：加载概览 + 更新徽标 + 每日提醒 + 轻量刷新。 */
export function initReview() {
  if (R.inited) return
  R.inited = true
  const daily = loadDailyState()
  R.dailyReviewed = daily.words
  R.dailyTarget = daily.target
  updateBadge()
  void refreshSummary().then((ok) => {
    if (!ok) return
    setTimeout(() => {
      maybeDailyReminder(R.summary)
    }, 1500)
  })
  // 回到页面时刷新（通话结束总结会自动往复习库加词）
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refreshSummary()
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => void refreshSummary())
    window.addEventListener('ava:review-updated', () => void refreshSummary())
    R.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSummary()
    }, 90000)
  }
}

/** 切到复习 Tab：刷新概览 + 每日提醒 + 按当前视图更新。 */
export async function onReviewTabEnter() {
  const ok = await refreshSummary()
  maybeDailyReminder(R.summary)
  if (M.tab !== 'review') return ok
  if (R.view === 'home') paintHome()
  else if (R.view === 'manage') {
    updateManageCounts()
    void loadManageWords({ quiet: true })
  }
  return ok
}

/** 离开复习 Tab：停止小游戏计时器与朗读（复习会话保留，回来可继续）。 */
export function onReviewTabLeave() {
  cancelSessionFocus()
  if (R.session) saveSessionDraft(R.session)
  cleanupGame()
  if (R.view === 'game') R.view = 'home'
}

/** 复习页返回键：有子视图时回到复习首页。 */
export function reviewHandleBack() {
  if (M.tab !== 'review') return false
  if (R.view === 'home') return false
  stopReviewAudio()
  cancelSessionFocus()
  if (R.session) {
    saveSessionDraft(R.session)
    R.session = null
    R.view = 'home'
    paintHome()
    void refreshSummary()
    return true
  }
  cleanupGame()
  R.view = 'home'
  paintHome()
  return true
}

/* ==========================================================================
   复习首页
   ========================================================================== */
function paintHome() {
  const host = reviewHost()
  if (!host) return
  const s = R.summary
  const due = num(s.dueCount)
  const total = num(s.total)
  const known = num(s.knownCount)
  const unfamiliar = num(s.newCount) + num(s.learningCount)
  const reviewedToday = Array.isArray(R.dailyReviewed) ? R.dailyReviewed.length : 0
  const remainingToday = due
  if (!R.dailyTarget && reviewedToday > 0) R.dailyTarget = reviewedToday + remainingToday
  const targetToday = Math.max(R.dailyTarget || 0, reviewedToday)
  const pct = total === 0 || !targetToday ? 0 : Math.min(100, Math.round((reviewedToday / targetToday) * 100))
  const empty = total === 0
  const pendingDraft = loadAnySessionDraft()
  const pendingLeft = pendingDraft ? pendingDraft.words.length - pendingDraft.index : 0
  const canStart = due > 0 || !!pendingDraft
  const loading = !R.summaryLoaded && R.summaryLoading

  const gameCards = GAME_META.map(
    (game) => `<button type="button" class="rv-game-card" data-act="game" data-game="${esc(game.kind)}">
      <span class="rv-game-top">
        <span class="rv-game-icon ${esc(game.tone)}">${game.icon === 'volume' ? icon('volume') : rIcon(game.icon)}</span>
        <span><span class="rv-game-title">${esc(game.title)}</span></span>
      </span>
      <span class="rv-game-sub">${esc(game.sub)}</span>
      <span class="rv-game-go">${rIcon('play')}开始玩</span>
    </button>`,
  ).join('')

  host.innerHTML = `
    <div class="rv-wrap">
      <div class="rv-head">
        <div>
          <div class="m-eyebrow">Review &amp; words</div>
          <h1 class="m-title">复习</h1>
          <p class="m-sub">把聊过、读过的单词变成你自己的 —— 间隔重复，每天几分钟。</p>
        </div>
        <div class="rv-head-actions">
          <span class="rv-chip teal">${rIcon('clock')}今日到期 ${due}</span>
          <button type="button" class="rv-iconbtn" data-act="refresh" aria-label="刷新复习数据">${icon('refresh')}</button>
        </div>
      </div>

      ${R.summaryError ? `<div class="rv-game-notice" style="margin-bottom:12px">${esc(R.summaryError)}</div>` : ''}

      <div class="rv-hero">
        <div class="rv-hero-copy">
          <div class="rv-hero-label">${icon('spark')}Today's review</div>
          <div class="rv-hero-count">
            <strong>${loading ? '·' : esc(due)}</strong><span>${empty ? '词库还是空的' : '个单词今天到期'}</span>
          </div>
          <div class="rv-hero-stats">
            <span><b>${esc(unfamiliar)}</b>生词本</span>
            <span><b>${esc(known)}</b>已掌握</span>
            <span><b>${esc(total)}</b>词库总数</span>
          </div>
          <div class="rv-hero-actions">
            <button type="button" class="btn btn-primary" data-act="start" ${canStart ? '' : 'disabled'}>${rIcon('play')}${pendingDraft ? `继续复习 · ${pendingLeft}` : canStart ? `开始复习 · ${due}` : '开始复习'}</button>
            ${total > 0 ? `<button type="button" class="btn btn-ghost" data-act="extra">${icon('refresh')}随便复习一轮</button>` : ''}
            ${empty ? `<button type="button" class="btn btn-ghost" data-act="add">${rIcon('plus')}先加几个单词</button>` : ''}
          </div>
          ${!canStart && total > 0 ? `<div class="rv-hero-stats" style="color:var(--m-faint)"><span>今天没有到期单词，休息一下，或者「随便复习一轮」练练手。</span></div>` : ''}
        </div>
        <div class="rv-ring" style="--pct:${pct}" title="今日复习完成度：已复习 ${reviewedToday} / ${targetToday} 个">
          <div class="rv-ring-track"></div>
          <div class="rv-ring-inner"><strong>${pct}%</strong><span>今日复习</span></div>
        </div>
      </div>

      ${
        empty
          ? `<div class="rv-empty" style="margin-top:16px">
              <span class="rv-empty-orb">${icon('book')}</span>
              <strong>词库还是空的</strong>
              <p>结束一次对话后，Ava 会自动把重点单词收进复习库；也可以点「手动添加单词」，先放几个自己遇到的词进来。</p>
              <div class="rv-empty-actions">
                <button type="button" class="btn btn-primary btn-sm" data-act="add">${rIcon('plus')}手动添加</button>
                <button type="button" class="btn btn-ghost btn-sm" data-act="go-chat">${icon('chat')}去和角色聊聊</button>
              </div>
            </div>`
          : ''
      }

      <div class="rv-section-row"><span class="section-title">${icon('book')}我的词库</span><span class="section-more">${total} 个单词</span></div>
      <div class="rv-entries">
        <button type="button" class="rv-entry" data-act="manage">
          <span class="rv-entry-orb">${icon('book')}</span>
          <span class="rv-entry-copy"><strong>词库管理</strong><small>生词本 ${unfamiliar} · 已掌握 ${known} · 搜索 / 新增 / 删除</small></span>
          <span class="rv-entry-go">${icon('chevron')}</span>
        </button>
        <button type="button" class="rv-entry" data-act="add">
          <span class="rv-entry-orb warm">${rIcon('plus')}</span>
          <span class="rv-entry-copy"><strong>手动添加单词</strong><small>把自己遇到的词加进来，Ava 会安排复习</small></span>
          <span class="rv-entry-go">${icon('chevron')}</span>
        </button>
      </div>

      <div class="rv-section-row"><span class="section-title">${icon('game')}小游戏</span><span class="section-more">用词库里的单词玩</span></div>
      <div class="rv-games">${gameCards}</div>

      ${
        total > 0
          ? `<div class="rv-section-row"><span class="section-title">${rIcon('clock')}最近加入</span><span class="section-more">点 🔊 听发音 · 可单独练一个词</span></div>
             <div class="rv-recent" id="rv-recent">${'<div class="rv-recent-skel"></div>'.repeat(4)}</div>`
          : ''
      }

      <div class="rv-foot">SRS 间隔重复：不认识 → 10 分钟后再来；模糊 / 认识 / 简单 → 间隔逐步拉长，最久一年。<br>所有复习数据只保存在这台设备的本地服务里。</div>
    </div>`

  host.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'start') {
      if (!canStart) {
        toast('今天没有到期单词了，可以先「随便复习一轮」', 'info', 2600)
        return
      }
      void startSession('due')
    } else if (act === 'extra') void startSession('extra')
    else if (act === 'manage') openManage()
    else if (act === 'add') openManage({ addOpen: true })
    else if (act === 'go-chat') ui.switchTab('chat')
    else if (act === 'game') {
      const kind = target.getAttribute('data-game') || 'match'
      openGame(kind)
    } else if (act === 'refresh') void refreshHome()
    else if (act === 'speak-recent') speakWord(target.getAttribute('data-word'))
    else if (act === 'single') {
      const word = R.recent.find((item) => item.word === target.getAttribute('data-word'))
      if (word) void startSession('single', [word])
    }
  }

  if (total > 0) void loadRecentWords()
}

/** 最近加入的单词（首页底部，按 updatedAt 倒序）。 */
async function loadRecentWords() {
  const box = document.getElementById('rv-recent')
  if (!box) return
  if (R.recent.length && Date.now() - R.recentAt < 30000) {
    paintRecentWords()
    return
  }
  if (R.recentLoading) return
  R.recentLoading = true
  const res = await listApi({ status: 'all', limit: 6 })
  R.recentLoading = false
  if (!document.getElementById('rv-recent')) return
  if (!res || res.ok === false) {
    box.innerHTML = `<div class="rv-list-more">${esc((res && res.error) || '最近单词加载失败')}</div>`
    return
  }
  R.recent = (Array.isArray(res.words) ? res.words : []).filter((w) => w && w.word).slice(0, 6)
  R.recentAt = Date.now()
  paintRecentWords()
}

function paintRecentWords() {
  const box = document.getElementById('rv-recent')
  if (!box) return
  if (!R.recent.length) {
    box.innerHTML = '<div class="rv-list-more">词库里还没有单词。</div>'
    return
  }
  box.innerHTML = R.recent
    .map((word) => {
      const status = word.status === 'known' ? 'known' : word.status === 'learning' ? 'learning' : 'new'
      return `<div class="rv-recent-row" data-word="${esc(word.word)}">
        <button type="button" class="rv-row-audio" data-act="speak-recent" data-word="${esc(word.word)}" aria-label="朗读 ${esc(word.word)}">${icon('volume')}</button>
        <div class="rv-recent-main">
          <div class="rv-recent-top">
            <b>${esc(word.word)}</b>
            ${word.phonetic ? `<span class="rv-row-phonetic">${esc(word.phonetic)}</span>` : ''}
            <span class="rv-status ${status}">${esc(STATUS_LABEL[status] || status)}</span>
          </div>
          <div class="rv-recent-meaning">${esc(word.meaning || '（暂无释义）')}</div>
        </div>
        <button type="button" class="rv-mini" data-act="single" data-word="${esc(word.word)}">${rIcon('play')}单独练</button>
      </div>`
    })
    .join('')
}

/** 复习数据变化后让「最近加入」下次重新拉取。 */
function invalidateRecent() {
  R.recentAt = 0
}

async function refreshHome() {
  const host = reviewHost()
  invalidateRecent()
  const btn = host && host.querySelector('[data-act="refresh"]')
  if (btn) btn.disabled = true
  const ok = await refreshSummary()
  if (btn) btn.disabled = false
  if (M.tab === 'review' && R.view === 'home') paintHome()
  if (ok) toast('复习数据已更新', 'ok', 1800)
  else toast(R.summaryError || '刷新失败，请稍后重试', 'bad', 2800)
}

/* ==========================================================================
   复习会话
   ========================================================================== */
async function startSession(mode = 'due', presetWords = null) {
  cancelSessionFocus()
  let draft = !(Array.isArray(presetWords) && presetWords.length) ? loadSessionDraft(mode) : null
  if (!draft && !(Array.isArray(presetWords) && presetWords.length) && mode === 'due') draft = loadAnySessionDraft()
  if (draft && draft.index < draft.words.length) {
    const resumed = {
      mode: draft.mode || mode,
      words: draft.words,
      index: draft.index,
      flipped: false,
      answers: Array.isArray(draft.answers) ? draft.answers : [],
      loading: false,
      grading: false,
      feedback: '',
      feedbackTone: '',
      startedAt: Number(draft.startedAt) || Date.now(),
    }
    R.session = resumed
    R.finish = null
    R.view = 'session'
    // 补齐今日已复习记录
    ;(resumed.answers || []).forEach((a) => markReviewedToday(a.word))
    paintSession()
    saveSessionDraft(resumed)
    toast(`继续上次复习：第 ${resumed.index + 1} / ${resumed.words.length} 个`, 'info', 2400)
    return { ok: true, resumed: true, mode: resumed.mode, total: resumed.words.length }
  }
  const s = {
    mode,
    words: [],
    index: 0,
    flipped: false,
    answers: [],
    loading: true,
    grading: false,
    feedback: '',
    feedbackTone: '',
    startedAt: Date.now(),
  }
  R.session = s
  R.finish = null
  R.view = 'session'
  paintSession()

  let words = []
  if (Array.isArray(presetWords) && presetWords.length) {
    words = presetWords.slice()
  } else if (mode === 'extra') {
    const res = await listApi({ status: 'all', limit: 500 })
    if (R.session !== s) return { ok: false, error: '会话已取消或替换' }
    if (!res || res.ok === false) {
      toast((res && res.error) || '读取词库失败，请稍后重试', 'bad', 3000)
      R.session = null
      R.view = 'home'
      paintHome()
      return { ok: false, error: (res && res.error) || '读取词库失败' }
    }
    words = shuffle((res.words || []).filter((w) => w && w.word)).slice(0, 12)
  } else {
    const res = await getDueApi(40)
    if (R.session !== s) return { ok: false, error: '会话已取消或替换' }
    if (!res || res.ok === false) {
      toast((res && res.error) || '读取今日到期单词失败', 'bad', 3000)
      R.session = null
      R.view = 'home'
      paintHome()
      return { ok: false, error: (res && res.error) || '读取今日到期单词失败' }
    }
    words = (res.words || []).filter((w) => w && w.word)
  }

  if (R.session !== s) return { ok: false, error: '会话已被新的复习替换' }
  if (!words.length) {
    R.session = null
    R.view = 'home'
    paintHome()
    toast('今天没有到期单词啦，去「词库管理」加几个新词吧', 'info', 3200)
    return { ok: false, error: '暂时没有可复习的单词' }
  }
  s.words = words
  s.loading = false
  R.dailyTarget = Math.max(R.dailyTarget || 0, R.dailyReviewed.length + words.length)
  saveDailyState()
  saveSessionDraft(s)
  paintSession()
  logReviewEvent('session-start', { mode, total: words.length })
  return { ok: true, mode, total: words.length }
}

function currentWord() {
  const s = R.session
  if (!s || !s.words.length) return null
  return s.words[Math.min(s.index, s.words.length - 1)] || null
}

function paintSession({ focusCard = false } = {}) {
  const host = reviewHost()
  if (!host) return
  host.onkeydown = onSessionKeydown
  const s = R.session
  if (!s) {
    paintHome()
    return
  }
  if (s.loading) {
    host.innerHTML = `
      <div class="rv-wrap narrow">
        <div class="rv-session">
          <div class="rv-session-top">
            <button type="button" class="rv-iconbtn" data-act="exit" aria-label="退出复习">${icon('back')}</button>
            <div class="rv-session-progress">
              <div class="rv-session-progress-row"><span>正在准备今天的单词…</span><span></span></div>
              <div class="rv-progress-bar"><i style="width:12%"></i></div>
            </div>
          </div>
          <div class="rv-card" style="display:grid;place-items:center">
            <div class="rv-loading"><span class="spinner"></span>正在读取复习卡片…</div>
          </div>
        </div>
      </div>`
    host.onclick = (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
      if (target && target.getAttribute('data-act') === 'exit') {
        R.session = null
        R.view = 'home'
        paintHome()
      }
    }
    return
  }

  const word = currentWord()
  if (!word) {
    paintHome()
    return
  }
  const total = s.words.length
  const position = s.index + 1
  const goodCount = s.answers.filter((a) => a.grade === 'good' || a.grade === 'easy').length
  const progress = Math.round((position / total) * 100)

  host.innerHTML = `
    <div class="rv-wrap narrow">
      <div class="rv-session">
        <div class="rv-session-top">
          <button type="button" class="rv-iconbtn" data-act="exit" aria-label="结束本轮复习">${icon('back')}</button>
          <div class="rv-session-progress">
            <div class="rv-session-progress-row"><span>第 <b>${position}</b> / ${total} 个</span><span>${esc(sessionModeLabel(s.mode))}</span></div>
            <div class="rv-progress-bar"><i style="width:${progress}%"></i></div>
          </div>
          <span class="rv-chip ok rv-session-score">${icon('check')}认识 ${goodCount}</span>
        </div>

        <div class="rv-card${s.flipped ? ' is-flipped' : ''}" data-act="card" role="button" tabindex="0" aria-keyshortcuts="Enter Space" aria-label="单词卡片，按回车或空格查看释义">
          <div class="rv-card-inner">
            <div class="rv-face front" aria-hidden="${s.flipped ? 'true' : 'false'}"${s.flipped ? ' inert' : ''}>
              <div class="rv-card-eyebrow">Word card · 点击卡片翻转</div>
              <div class="rv-word-row">
                <span class="rv-word" data-act="speak" role="button" tabindex="0" title="点击朗读">${esc(word.word)}</span>
                <button type="button" class="rv-speak" data-act="speak" aria-label="朗读 ${esc(word.word)}">${icon('volume')}</button>
              </div>
              <div class="rv-card-tip">点单词或喇叭听发音 · 点卡片看释义</div>
              <button type="button" class="rv-flip-btn" data-act="flip">查看释义 →</button>
            </div>
            <div class="rv-face back" aria-hidden="${s.flipped ? 'false' : 'true'}"${s.flipped ? '' : ' inert'}>
              <div class="rv-back-word">
                <span class="rv-word small">${esc(word.word)}</span>
                <button type="button" class="rv-speak" style="width:42px;height:42px" data-act="speak" aria-label="朗读 ${esc(word.word)}">${icon('volume')}</button>
              </div>
              ${word.phonetic ? `<div class="rv-phonetic">${esc(word.phonetic)}</div>` : ''}
              <div class="rv-meaning">${esc(word.meaning || '（暂无释义，可以在词库管理里补上）')}</div>
              ${word.example ? `<div class="rv-example"><span class="rv-example-bulb">${icon('bulb')}</span><span class="rv-example-en">${esc(word.example)}</span><button type="button" class="rv-example-speak" data-act="speak-example" data-example="${esc(word.example)}" aria-label="朗读例句">${icon('volume')}</button></div>
                <div class="rv-example-zh" data-example-zh="${esc(word.example)}" hidden></div>` : ''}
              <div class="rv-meta-row">
                <span class="rv-src">${esc(sourceLabel(word))}</span>
                ${dueText(word) ? `<span class="rv-due">${esc(dueText(word))}</span>` : ''}
                ${word.reps ? `<span class="rv-due">已复习 ${esc(num(word.reps))} 次</span>` : ''}
              </div>
            </div>
          </div>
        </div>

        <div class="rv-grades">
          <button type="button" class="rv-grade" data-grade="again" aria-keyshortcuts="1" ${s.grading ? 'disabled' : ''}><strong>不认识</strong><em>1 · Again · 10 分钟后</em></button>
          <button type="button" class="rv-grade" data-grade="hard" aria-keyshortcuts="2" ${s.grading ? 'disabled' : ''}><strong>模糊</strong><em>2 · Hard · 稍后</em></button>
          <button type="button" class="rv-grade" data-grade="good" aria-keyshortcuts="3" ${s.grading ? 'disabled' : ''}><strong>认识</strong><em>3 · Good · 间隔加长</em></button>
          <button type="button" class="rv-grade" data-grade="easy" aria-keyshortcuts="4" ${s.grading ? 'disabled' : ''}><strong>简单</strong><em>4 · Easy · 更久以后</em></button>
        </div>
        <div class="rv-session-hint ${esc(s.feedbackTone || '')}" id="rv-session-hint" role="status" aria-live="polite">${esc(s.feedback || '先翻转卡片看释义，再按真实记忆程度评分。')}</div>
      </div>
    </div>`
  host.onclick = onSessionClick
  void hydrateExampleTranslations(host)
  if (focusCard && M.tab === 'review' && R.view === 'session' && R.session === s) {
    host.querySelector('.rv-card')?.focus({ preventScroll: true })
  }
}

/** 只在复习会话内处理快捷键，不抢输入法、编辑框或原生按钮的 Enter/Space。 */
function onSessionKeydown(event) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  if (M.tab !== 'review' || R.view !== 'session' || !R.session || R.session.loading) return
  const target = event.target
  const tag = target && target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return
  if (/^[1-4]$/.test(event.key)) {
    event.preventDefault()
    void gradeCurrent(['again', 'hard', 'good', 'easy'][Number(event.key) - 1])
    return
  }
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (!target || tag === 'BUTTON' || tag === 'A' || typeof target.getAttribute !== 'function') return
  const act = target.getAttribute('data-act')
  if (act === 'card') {
    event.preventDefault()
    flipCard()
  } else if (act === 'speak') {
    event.preventDefault()
    speakWord(currentWord() && currentWord().word)
  }
}

function onSessionClick(event) {
  const s = R.session
  if (!s || s.loading) return
  const gradeBtn = event.target instanceof Element ? event.target.closest('[data-grade]') : null
  if (gradeBtn) {
    const grade = gradeBtn.getAttribute('data-grade') || ''
    void gradeCurrent(grade)
    return
  }
  const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
  if (!target) return
  const act = target.getAttribute('data-act')
  if (act === 'exit') {
    stopReviewAudio()
    cancelSessionFocus()
    saveSessionDraft(s)
    R.session = null
    R.view = 'home'
    paintHome()
    void refreshSummary()
  } else if (act === 'speak') {
    speakWord(currentWord() && currentWord().word)
  } else if (act === 'speak-example') {
    speakWord(target.getAttribute('data-example') || '')
  } else if (act === 'flip') {
    flipCard()
  } else if (act === 'card') {
    const card = target.classList.contains('rv-card') ? target : target.closest('.rv-card')
    if (card) flipCard()
  }
}

/** 翻转卡片（同时把提示改成评分引导）。 */
function flipCard() {
  const s = R.session
  if (!s || s.loading) return
  s.flipped = true
  const host = reviewHost()
  const card = host && host.querySelector('.rv-card')
  if (card) {
    const front = card.querySelector('.front')
    const back = card.querySelector('.back')
    // 查看释义按钮会随正面隐藏，先把其焦点移到一直可用的卡片容器。
    if (front && front.contains(document.activeElement) && M.tab === 'review' && R.view === 'session') {
      card.focus({ preventScroll: true })
    }
    if (front) { front.inert = true; front.setAttribute('aria-hidden', 'true') }
    if (back) { back.inert = false; back.setAttribute('aria-hidden', 'false') }
    card.classList.add('is-flipped')
  }
  const hint = document.getElementById('rv-session-hint')
  if (hint) {
    hint.className = 'rv-session-hint'
    hint.textContent = '按真实记忆程度选择下方评分，Ava 会安排下次复习时间。'
  }
}

const exampleZhCache = new Map()
const exampleZhPending = new Map()

/** 取例句中文翻译并回填（批量、缓存、失败静默）。 */
async function translateExampleBatch(texts) {
  const list = [...new Set(texts.filter(Boolean))]
  for (let i = 0; i < list.length; i += 8) {
    const chunk = list.slice(i, i + 8)
    const pending = chunk.filter((en) => !exampleZhCache.has(en) && !exampleZhPending.has(en))
    if (!pending.length) continue
    const promise = translateTexts(pending)
      .then((res) => {
        if (Array.isArray(res)) {
          pending.forEach((en, index) => {
            const zh = res[index]
            if (zh) exampleZhCache.set(en, zh)
          })
        }
      })
      .catch(() => {})
      .finally(() => {
        pending.forEach((en) => exampleZhPending.delete(en))
      })
    pending.forEach((en) => exampleZhPending.set(en, promise))
    await promise
  }
  return exampleZhCache
}

function paintExampleTranslations(root, cache) {
  if (!root) return
  root.querySelectorAll('[data-example-zh]').forEach((el) => {
    const en = el.getAttribute('data-example-zh') || ''
    const zh = cache.get(en)
    if (zh && el.textContent !== zh) {
      el.textContent = zh
      el.hidden = false
    }
  })
}

function hydrateExampleTranslations(root) {
  if (!root) return
  const nodes = [...root.querySelectorAll('[data-example-zh]')]
  if (!nodes.length) return
  paintExampleTranslations(root, exampleZhCache)
  const missing = []
  for (const el of nodes) {
    if (el.hidden) {
      const en = el.getAttribute('data-example-zh') || ''
      if (en && !exampleZhCache.has(en) && !exampleZhPending.has(en)) missing.push(en)
    }
  }
  if (!missing.length) return
  void translateExampleBatch([...new Set(missing)].slice(0, 32)).then((cache) => paintExampleTranslations(root, cache))
}

let ttsErrorNotified = false

/** 复习会话的模式文案。 */
function sessionModeLabel(mode) {
  if (mode === 'due') return '今日到期'
  if (mode === 'again') return '再练一遍'
  if (mode === 'single') return '单词加练'
  return '自由复习'
}

function notifyTtsUnavailable() {
  if (ttsErrorNotified) return
  ttsErrorNotified = true
  toast('发音暂不可用，请稍后再试', 'info', 2600)
}

/** 页面离开与新朗读共用同一取消代次，避免迟到的音频/错误提示打扰新页面。 */
function stopReviewAudio() {
  reviewSpeechToken += 1
  try { stopCharacterText() } catch { /* 忽略 */ }
  try { tts.cancel() } catch { /* 忽略 */ }
}

/** 朗读单词：使用当前计划的老师原声（豆包 TTS）；浏览器 TTS 已关闭。 */
function speakWord(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return
  stopReviewAudio()
  const token = reviewSpeechToken
  void (async () => {
    try {
      const characterId = (M.plan && M.plan.teacherId) || 'elena'
      const ok = await playCharacterText(text, { characterId })
      if (!ok && token === reviewSpeechToken && M.tab === 'review') notifyTtsUnavailable()
    } catch {
      if (token === reviewSpeechToken && M.tab === 'review') notifyTtsUnavailable()
    }
  })()
}

function cancelSessionFocus(s = R.session) {
  if (s && s.cancelFocusRestore) s.cancelFocusRestore()
}

/** 只延续仍在操作卡片/评分区的焦点；离页、移焦或点其他区域立即放弃。 */
function trackSessionCardFocus(s, host) {
  cancelSessionFocus(s)
  const card = host && host.querySelector('.rv-card')
  const grades = host && host.querySelector('.rv-grades')
  const inside = (target) => !!target && !!((card && card.contains(target)) || (grades && grades.contains(target)))
  if (!card || M.tab !== 'review' || R.view !== 'session' || !inside(document.activeElement)) return () => false
  let active = true
  const outside = (event) => { if (!inside(event.target)) cancel() }
  const cancel = () => {
    active = false
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('focusin', outside, true)
    window.removeEventListener?.('blur', cancel)
    if (s.cancelFocusRestore === cancel) s.cancelFocusRestore = null
  }
  s.cancelFocusRestore = cancel
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('focusin', outside, true)
  window.addEventListener?.('blur', cancel)
  // 禁用当前评分按钮可能使焦点退到 body；提前留在不会被禁用的卡片上。
  card.focus({ preventScroll: true })
  return () => {
    const restore = active && R.session === s && R.view === 'session' && M.tab === 'review'
      && inside(document.activeElement) && (typeof document.hasFocus !== 'function' || document.hasFocus())
    cancel()
    return restore
  }
}

async function gradeCurrent(grade) {
  const s = R.session
  if (!s || s.grading || s.advancePending) return
  const word = currentWord()
  if (!word) return
  if (!s.flipped) {
    flipCard()
    return
  }
  if (!GRADE_LABEL[grade]) return
  const host = reviewHost()
  const finishFocusTracking = trackSessionCardFocus(s, host)
  s.grading = true
  if (host) {
    host.querySelectorAll('.rv-grade').forEach((btn) => {
      btn.disabled = true
    })
  }
  setSessionHint('正在记录这次复习…', '')

  const res = await gradeApi(word.word, grade)
  if (R.session !== s) { finishFocusTracking(); return }
  if (!res || res.ok === false) {
    finishFocusTracking()
    s.grading = false
    if (host) {
      host.querySelectorAll('.rv-grade').forEach((btn) => {
        btn.disabled = false
      })
    }
    setSessionHint((res && res.error) || '评分失败，再点一次试试', 'bad')
    return
  }

  const updated = (res && res.word) || {}
  markReviewedToday(word.word)
  if (res.summary) applySummary(res.summary)
  const dueLabel = String(updated.dueLabel || '').trim()
  s.answers.push({
    word: word.word,
    grade,
    dueLabel,
    status: updated.status || word.status || '',
  })
  s.feedback = `${GRADE_LABEL[grade]} · ${dueLabel ? `${dueLabel}复习` : '已记录'}${grade === 'again' || grade === 'hard' ? ' · 很快会再见到它' : ''}`
  s.feedbackTone = 'ok'
  s.advancePending = true
  setSessionHint(s.feedback, 'ok')
  saveSessionDraft(s)
  window.setTimeout(() => {
    const focusCard = finishFocusTracking()
    if (R.session !== s) return
    s.grading = false
    s.advancePending = false
    if (s.index + 1 >= s.words.length) {
      finishSession()
    } else {
      s.index += 1
      s.flipped = false
      s.feedback = ''
      s.feedbackTone = ''
      saveSessionDraft(s)
      paintSession({ focusCard })
    }
  }, 520)
}

function setSessionHint(text, tone) {
  const hint = document.getElementById('rv-session-hint')
  if (!hint) return
  hint.className = 'rv-session-hint' + (tone ? ' ' + tone : '')
  hint.textContent = text
}

function finishSession() {
  const s = R.session
  if (!s) return
  clearSessionDraft()
  const answers = s.answers.slice()
  const goodAnswers = answers.filter((a) => a.grade === 'good' || a.grade === 'easy')
  const againAnswers = answers.filter((a) => a.grade === 'again' || a.grade === 'hard')
  const againWords = s.words.filter((w) => againAnswers.some((a) => a.word === w.word))
  R.finish = {
    total: answers.length,
    good: goodAnswers.length,
    again: againAnswers.length,
    answers,
    againWords,
    mode: s.mode,
    durationMs: Math.max(0, Date.now() - (s.startedAt || Date.now())),
    nextDue: null,
  }
  R.session = null
  R.view = 'finish'
  invalidateRecent()
  paintFinish()
  void refreshSummary().then((ok) => {
    if (!ok || !R.finish || R.view !== 'finish') return
    R.finish.nextDue = num(R.summary.dueCount)
    const el = document.getElementById('rv-finish-next')
    if (el) {
      el.textContent =
        R.finish.nextDue > 0
          ? `还有 ${R.finish.nextDue} 个单词今天到期，随时可以再来一轮。`
          : '今天的到期单词已经清空啦，明天见。'
    }
  })
}

function paintFinish() {
  const host = reviewHost()
  if (!host) return
  const f = R.finish
  if (!f) {
    paintHome()
    return
  }
  const rows = f.answers
    .map((a) => {
      const isGood = a.grade === 'good' || a.grade === 'easy'
      return `<div class="rv-finish-list-row">
        <b>${esc(a.word)}</b>
        <span class="rv-status ${isGood ? 'known' : a.grade === 'hard' ? 'learning' : 'new'}">${esc(GRADE_LABEL[a.grade] || a.grade)}</span>
        <span class="rv-due">${esc(a.dueLabel ? `${a.dueLabel}复习` : '已记录')}</span>
      </div>`
    })
    .join('')

  host.innerHTML = `
    <div class="rv-wrap narrow">
      <div class="rv-finish">
        <div class="rv-finish-hero">
          <div class="rv-finish-orb">${rIcon('trophy')}</div>
          <h2>这一轮复习完成！</h2>
          <p class="rv-finish-sub">刚刚复习了 ${f.total} 个单词${f.again > 0 ? `，其中 ${f.again} 个还会很快再见到` : '，全部记住了，超棒'}。用时 ${esc(mmss(Math.round(f.durationMs / 1000)))}。</p>
          <div class="rv-finish-stats">
            <div class="rv-finish-stat total"><strong>${f.total}</strong><span>复习单词</span></div>
            <div class="rv-finish-stat good"><strong>${f.good}</strong><span>认识 / 简单</span></div>
            <div class="rv-finish-stat again"><strong>${f.again}</strong><span>需再复习</span></div>
          </div>
          <div class="rv-finish-actions">
            <button type="button" class="btn btn-primary" data-act="again">${icon('refresh')}${f.againWords.length ? `再来一轮（再练 ${f.againWords.length} 个）` : '再来一轮'}</button>
            <button type="button" class="btn btn-ghost" data-act="home">${icon('book')}回复习首页</button>
          </div>
          <p class="rv-finish-sub" id="rv-finish-next" style="font-size:11.5px">正在更新今日到期数据…</p>
        </div>
        <div class="rv-section-row" style="margin-top:4px"><span class="section-title">${icon('book')}本轮单词</span><span class="section-more">${f.total} 个</span></div>
        <div class="rv-finish-list">${rows || '<div class="rv-list-more">这一轮没有记录到评分。</div>'}</div>
      </div>
    </div>`

  host.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'again') {
      if (f.againWords.length) void startSession('again', f.againWords)
      else if (num(R.summary.total) > 0) void startSession('extra')
      else {
        toast('词库还是空的，先添加几个单词吧', 'info', 2600)
        openManage({ addOpen: true })
      }
    } else if (act === 'home') {
      R.finish = null
      R.view = 'home'
      paintHome()
    }
  }
}

/* ==========================================================================
   词库管理
   ========================================================================== */
function openManage({ addOpen = false } = {}) {
  R.manage.addOpen = !!addOpen
  R.manage.deleting = ''
  R.manage.error = ''
  R.view = 'manage'
  paintManage()
  void loadManageWords()
}

function initialCounts() {
  const s = R.summary
  return {
    total: num(s.total),
    dueCount: num(s.dueCount),
    newCount: num(s.newCount),
    learningCount: num(s.learningCount),
    knownCount: num(s.knownCount),
  }
}

function manageCounts() {
  return R.manage.counts || initialCounts()
}

function paintManage() {
  const host = reviewHost()
  if (!host) return
  const m = R.manage
  const counts = manageCounts()
  const filters = [
    { key: 'unfamiliar', label: '生词本', count: num(counts.newCount) + num(counts.learningCount) },
    { key: 'known', label: '已掌握', count: num(counts.knownCount) },
    { key: 'all', label: '全部', count: num(counts.total) },
  ]
    .map(
      (f) => `<button type="button" class="rv-filter${m.status === f.key ? ' is-active' : ''}" data-filter="${esc(f.key)}">
        ${esc(f.label)} <em data-count="${esc(f.key)}">${esc(f.count)}</em>
      </button>`,
    )
    .join('')

  host.innerHTML = `
    <div class="rv-wrap narrow">
      <div class="rv-manage">
        <div class="rv-manage-head">
          <button type="button" class="rv-iconbtn" data-act="back" aria-label="回复习首页">${icon('back')}</button>
          <div class="rv-manage-head-main">
            <div class="m-eyebrow">Word library</div>
            <h1 class="m-title">词库管理</h1>
          </div>
          <button type="button" class="btn btn-primary btn-sm" data-act="toggle-add">${rIcon('plus')}新增单词</button>
        </div>

        <div class="rv-manage-tabs">${filters}</div>

        <div class="rv-tools">
          <div class="rv-search">
            ${rIcon('search')}
            <input type="search" id="rv-search-input" placeholder="搜索单词、释义或例句…" maxlength="60" autocomplete="off" spellcheck="false" value="${esc(m.q)}" aria-label="搜索单词">
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-act="reload">${icon('refresh')}刷新</button>
        </div>

        <div class="rv-add" id="rv-add-panel" ${m.addOpen ? '' : 'hidden'}>
          <div class="rv-add-head">
            <span class="rv-add-title">${rIcon('plus')}新增单词</span>
            <button type="button" class="rv-iconbtn" data-act="toggle-add" aria-label="收起新增表单">${icon('close')}</button>
          </div>
          <form id="rv-add-form" autocomplete="off">
            <div class="rv-add-grid">
              <div class="rv-field">
                <label for="rv-add-word">英文单词 *</label>
                <input type="text" id="rv-add-word" placeholder="例如 serendipity" maxlength="60" spellcheck="false">
              </div>
              <div class="rv-field">
                <label for="rv-add-meaning">中文释义 *</label>
                <input type="text" id="rv-add-meaning" placeholder="例如 意外发现美好事物的运气" maxlength="120">
              </div>
              <div class="rv-field">
                <label for="rv-add-phonetic">音标（可选）</label>
                <input type="text" id="rv-add-phonetic" placeholder="例如 /ˌserənˈdɪpəti/" maxlength="60" spellcheck="false">
              </div>
              <div class="rv-field">
                <label for="rv-add-example">例句（可选）</label>
                <input type="text" id="rv-add-example" placeholder="例如 Meeting you was pure serendipity." maxlength="200" spellcheck="false">
              </div>
            </div>
            <div class="rv-add-actions" style="margin-top:10px">
              <button type="button" class="btn btn-ghost btn-sm" data-act="toggle-add">取消</button>
              <button type="submit" class="btn btn-primary btn-sm" id="rv-add-submit">${icon('check')}添加单词</button>
            </div>
          </form>
        </div>

        <div class="rv-wordlist" id="rv-wordlist"></div>
        <div class="rv-list-more" id="rv-list-more"></div>
      </div>
    </div>`

  bindManage(host)
  renderWordList()
}

function bindManage(host) {
  host.onclick = async (event) => {
    const filterBtn = event.target instanceof Element ? event.target.closest('[data-filter]') : null
    if (filterBtn) {
      const next = filterBtn.getAttribute('data-filter') || 'unfamiliar'
      if (next === R.manage.status) return
      R.manage.status = next
      R.manage.deleting = ''
      host.querySelectorAll('[data-filter]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-filter') === next)
      })
      void loadManageWords()
      return
    }
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    const row = target.closest('.rv-row')
    const word = row ? row.getAttribute('data-word') || '' : ''
    if (act === 'back') {
      R.view = 'home'
      R.manage.deleting = ''
      paintHome()
      void refreshSummary()
    } else if (act === 'toggle-add') {
      toggleAddPanel()
    } else if (act === 'reload') {
      if (R.manage.loading) return
      const loaded = await loadManageWords()
      if (loaded && R.view === 'manage' && M.tab === 'review') toast('词库已刷新', 'ok', 1600)
    } else if (act === 'speak') {
      speakWord(word)
    } else if (act === 'speak-example') {
      speakWord(target.getAttribute('data-example') || '')
    } else if (act === 'status') {
      const status = target.getAttribute('data-status') || 'known'
      void updateWordStatus(word, status)
    } else if (act === 'delete' || act === 'remove' || act === 'del') {
      void requestDeleteWord(word)
    } else if (act === 'clear-search') {
      const input = document.getElementById('rv-search-input')
      if (input) input.value = ''
      R.manage.q = ''
      void loadManageWords()
    }
  }

  const search = document.getElementById('rv-search-input')
  if (search) {
    let timer = 0
    search.addEventListener('input', () => {
      window.clearTimeout(timer)
      const value = search.value.trim()
      timer = window.setTimeout(() => {
        if (R.manage.q === value) return
        R.manage.q = value
        void loadManageWords()
      }, 280)
      if (!value) {
        R.manage.q = ''
        window.clearTimeout(timer)
        void loadManageWords()
      }
    })
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        R.manage.q = search.value.trim()
        void loadManageWords()
      }
    })
  }

  const form = document.getElementById('rv-add-form')
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void submitAddWord()
    })
  }
  if (R.manage.addOpen) {
    const input = document.getElementById('rv-add-word')
    if (input) setTimeout(() => input.focus(), 60)
  }
}

function toggleAddPanel() {
  const panel = document.getElementById('rv-add-panel')
  const next = panel ? panel.hidden : !R.manage.addOpen
  R.manage.addOpen = next
  if (panel) panel.hidden = !next
  if (next) {
    const input = document.getElementById('rv-add-word')
    if (input) setTimeout(() => input.focus(), 40)
  }
}

function renderWordListLoading() {
  const list = document.getElementById('rv-wordlist')
  if (list) list.innerHTML = '<div class="rv-loading"><span class="spinner"></span>正在读取词库…</div>'
  const more = document.getElementById('rv-list-more')
  if (more) more.textContent = ''
}

function renderWordList() {
  const m = R.manage
  const list = document.getElementById('rv-wordlist')
  const more = document.getElementById('rv-list-more')
  if (!list) return
  list.setAttribute('aria-busy', String(m.loading))
  const host = reviewHost()
  if (host) host.querySelectorAll('[data-act="reload"]').forEach((button) => { button.disabled = m.loading })
  if (m.loading && !m.words.length) {
    renderWordListLoading()
    return
  }
  if (m.error && !m.words.length) {
    list.innerHTML = `<div class="rv-empty">
      <span class="rv-empty-orb">${icon('close')}</span>
      <strong>词库读取失败</strong>
      <p>${esc(m.error)}</p>
      <div class="rv-empty-actions"><button type="button" class="btn btn-primary btn-sm" data-act="reload">${icon('refresh')}重新加载</button></div>
    </div>`
    if (more) more.textContent = ''
    return
  }
  if (!m.words.length) {
    let title = '词库还是空的'
    let desc = '结束一次对话后重点单词会自动进来，也可以点右上角「新增单词」手动添加。'
    let actions = `<button type="button" class="btn btn-primary btn-sm" data-act="toggle-add">${rIcon('plus')}新增单词</button>`
    if (m.q) {
      title = '没有搜索到匹配的单词'
      desc = `换个关键词试试，或者清空搜索「${m.q}」。`
      actions = `<button type="button" class="btn btn-ghost btn-sm" data-act="clear-search">${icon('close')}清空搜索</button><button type="button" class="btn btn-primary btn-sm" data-act="toggle-add">${rIcon('plus')}新增单词</button>`
    } else if (m.status === 'unfamiliar') {
      title = '生词本是空的'
      desc = '在「全部」里把想复习的词标为「标为掌握」即可移出；也可以直接新增单词。'
      actions = `<button type="button" class="btn btn-ghost btn-sm" data-act="filter" data-filter="all">查看全部单词</button><button type="button" class="btn btn-primary btn-sm" data-act="toggle-add">${rIcon('plus')}新增单词</button>`
    } else if (m.status === 'known') {
      title = '还没有已掌握单词'
      desc = '复习几轮、或在「生词本」里点「标为掌握」，掌握的词会出现在这里。'
      actions = `<button type="button" class="btn btn-ghost btn-sm" data-act="filter" data-filter="unfamiliar">去生词本</button>`
    }
    list.innerHTML = `<div class="rv-empty">
      <span class="rv-empty-orb">${icon('book')}</span>
      <strong>${esc(title)}</strong>
      <p>${esc(desc)}</p>
      <div class="rv-empty-actions">${actions}</div>
    </div>`
    if (more) more.textContent = ''
    return
  }

  const deleting = m.deleting
  const notice = m.loading
    ? '<div class="rv-list-more" role="status">正在更新词库，保留上次读取的内容…</div>'
    : m.error
      ? `<div class="rv-list-more" role="alert"><strong>刷新失败：</strong>${esc(m.error)}。以下保留上次读取的内容。<button type="button" class="btn btn-ghost btn-sm" data-act="reload">${icon('refresh')}重试</button></div>`
      : ''
  list.innerHTML = notice + m.words
    .map((word, index) => {
      const status = word.status === 'known' ? 'known' : word.status === 'learning' ? 'learning' : 'new'
      const isKnown = status === 'known'
      const actionLabel = isKnown ? '加入生词本' : '标为掌握'
      const actionStatus = isKnown ? 'learning' : 'known'
      const confirm = deleting && deleting === word.word
      return `<div class="rv-row" data-word="${esc(word.word)}" style="animation-delay:${Math.min(index * 18, 220)}ms">
        <button type="button" class="rv-row-audio" data-act="speak" aria-label="朗读 ${esc(word.word)}">${icon('volume')}</button>
        <div class="rv-row-main">
          <div class="rv-row-top">
            <b>${esc(word.word)}</b>
            ${word.phonetic ? `<span class="rv-row-phonetic">${esc(word.phonetic)}</span>` : ''}
            <span class="rv-status ${status}">${esc(STATUS_LABEL[status] || status)}</span>
          </div>
          <div class="rv-row-meaning">${esc(word.meaning || '（暂无释义）')}</div>
          ${word.example ? `<div class="rv-row-example"><button type="button" class="rv-row-example-speak" data-act="speak-example" data-example="${esc(word.example)}" aria-label="朗读例句">${icon('volume')}</button><span>${esc(word.example)}</span></div><div class="rv-row-example-zh" data-example-zh="${esc(word.example)}" hidden></div>` : ''}
          <div class="rv-row-meta">
            <span class="rv-src">${esc(sourceLabel(word))}</span>
            ${dueText(word) ? `<span class="rv-due">${esc(dueText(word))}</span>` : ''}
            ${word.reps ? `<span class="rv-due">复习 ${esc(num(word.reps))} 次</span>` : ''}
          </div>
        </div>
        <div class="rv-row-actions">
          <button type="button" class="rv-mini primary" data-act="status" data-status="${esc(actionStatus)}">${esc(actionLabel)}</button>
          <button type="button" class="rv-mini rv-del danger${confirm ? ' is-confirm' : ''}" data-act="delete" aria-label="删除 ${esc(word.word)}">${confirm ? '确认删除' : '删除'}</button>
        </div>
      </div>`
    })
    .join('')
  if (more) {
    more.textContent = `共 ${m.words.length} 个单词${m.status === 'unfamiliar' ? '（生词本）' : m.status === 'known' ? '（已掌握）' : ''}`
  }
  void hydrateExampleTranslations(list)
}

function updateManageCounts() {
  const counts = manageCounts()
  const values = {
    unfamiliar: num(counts.newCount) + num(counts.learningCount),
    known: num(counts.knownCount),
    all: num(counts.total),
  }
  Object.keys(values).forEach((key) => {
    const el = document.querySelector(`[data-count="${key}"]`)
    if (el) el.textContent = String(values[key])
  })
}

function normalizeCounts(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    total: num(raw.total),
    dueCount: num(raw.dueCount),
    newCount: num(raw.newCount),
    learningCount: num(raw.learningCount),
    knownCount: num(raw.knownCount),
  }
}

async function loadManageWords({ quiet = false } = {}) {
  const m = R.manage
  if (m.loading) {
    m.queued = true
    return false
  }
  const token = (m.loadToken += 1)
  m.loading = true
  m.error = ''
  m.deleting = ''
  renderWordList()
  const res = await listApi({ status: 'all', q: m.q, limit: 500 })
  if (token !== m.loadToken) return false
  m.loading = false
  if (!res || res.ok === false) {
    m.error = (res && res.error) || '词库读取失败，请稍后重试'
    renderWordList()
    if (!quiet) toast(m.error, 'bad', 3000)
    if (m.queued) {
      m.queued = false
      window.setTimeout(() => void loadManageWords({ quiet: true }), 0)
    }
    return false
  }
  m.counts = normalizeCounts(res.counts) || m.counts
  if (m.counts) applySummary(m.counts)
  let words = (Array.isArray(res.words) ? res.words : []).filter((w) => w && w.word)
  const keyword = m.q.trim().toLowerCase()
  if (keyword) {
    words = words.filter(
      (w) =>
        String(w.word || '').toLowerCase().includes(keyword) ||
        String(w.meaning || '').toLowerCase().includes(keyword) ||
        String(w.example || '').toLowerCase().includes(keyword),
    )
  }
  if (m.status === 'unfamiliar') words = words.filter((w) => w.status !== 'known')
  else if (m.status === 'known') words = words.filter((w) => w.status === 'known')
  m.words = words
  updateManageCounts()
  renderWordList()
  if (m.queued) {
    m.queued = false
    window.setTimeout(() => void loadManageWords({ quiet: true }), 0)
  }
  return true
}

async function updateWordStatus(word, status) {
  if (!word || !status) return
  const m = R.manage
  if (m.pendingWord) return
  m.pendingWord = word
  const row = document.querySelector(`.rv-row[data-word="${cssEscape(word)}"]`)
  if (row) row.classList.add('is-pending')
  const res = await patchApi(word, { status })
  m.pendingWord = ''
  if (row) row.classList.remove('is-pending')
  if (!res || res.ok === false) {
    toast((res && res.error) || '状态修改失败，请稍后重试', 'bad', 3000)
    return
  }
  if (res.summary) applySummary(res.summary)
  invalidateRecent()
  toast(status === 'known' ? `「${word}」已标记为掌握` : `「${word}」已加入生词本`, 'ok', 2400)
  await loadManageWords({ quiet: true })
}

async function requestDeleteWord(word) {
  if (!word) return
  const m = R.manage
  if (m.deleting !== word) {
    m.deleting = word
    renderWordList()
    window.clearTimeout(m.deleteTimer)
    m.deleteTimer = window.setTimeout(() => {
      if (m.deleting === word) {
        m.deleting = ''
        if (R.view === 'manage') renderWordList()
      }
    }, 3200)
    return
  }
  m.deleting = ''
  window.clearTimeout(m.deleteTimer)
  const row = document.querySelector(`.rv-row[data-word="${cssEscape(word)}"]`)
  if (row) row.classList.add('is-pending')
  const res = await deleteApi(word)
  if (!res || res.ok === false) {
    if (row) row.classList.remove('is-pending')
    toast((res && res.error) || '删除失败，请稍后重试', 'bad', 3000)
    return
  }
  m.words = m.words.filter((w) => w.word !== word)
  invalidateRecent()
  if (res.summary) applySummary(res.summary)
  m.counts = normalizeCounts(res.summary) || m.counts
  updateManageCounts()
  renderWordList()
  toast(`已删除「${word}」`, 'ok', 2200)
  void refreshSummary()
}

/** 简单 CSS.escape 兜底（老浏览器 / 特殊字符单词）。 */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return String(value).replace(/["\\]/g, '\\$&')
}

async function submitAddWord() {
  const m = R.manage
  if (m.adding) return
  const getValue = (id) => {
    const el = document.getElementById(id)
    return el && typeof el.value === 'string' ? el.value.trim() : ''
  }
  const word = getValue('rv-add-word')
  const meaning = getValue('rv-add-meaning')
  const phonetic = getValue('rv-add-phonetic')
  const example = getValue('rv-add-example')
  if (!word) {
    toast('先输入要添加的英文单词', 'info', 2600)
    const input = document.getElementById('rv-add-word')
    if (input) input.focus()
    return
  }
  if (!meaning) {
    toast('再补一个中文释义，复习的时候更好记', 'info', 2600)
    const input = document.getElementById('rv-add-meaning')
    if (input) input.focus()
    return
  }
  m.adding = true
  const submit = document.getElementById('rv-add-submit')
  if (submit) {
    submit.disabled = true
    submit.textContent = '添加中…'
  }
  const res = await addApi([{ word, meaning, phonetic, example, source: 'manual' }])
  m.adding = false
  if (submit) {
    submit.disabled = false
    submit.innerHTML = `${icon('check')}添加单词`
  }
  if (!res || res.ok === false) {
    toast((res && res.error) || '添加失败，请稍后重试', 'bad', 3200)
    return
  }
  const updated = num(res.updated) > 0 && num(res.added) === 0
  invalidateRecent()
  if (res.summary) applySummary(res.summary)
  m.counts = normalizeCounts(res.summary) || m.counts
  updateManageCounts()
  toast(updated ? `「${word}」已存在，已更新` : `已添加「${word}」，Ava 会安排复习`, 'ok', 2600)
  ;['rv-add-word', 'rv-add-meaning', 'rv-add-phonetic', 'rv-add-example'].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.value = ''
  })
  m.addOpen = false
  const panel = document.getElementById('rv-add-panel')
  if (panel) panel.hidden = true
  await loadManageWords({ quiet: true })
}

/* ==========================================================================
   小游戏（词义配对 / 听音选词 / 拼写填空）
   ========================================================================== */
function openGame(kind) {
  R.game.kind = GAME_META.some((g) => g.kind === kind) ? kind : 'match'
  R.view = 'game'
  paintGame()
}

function cleanupGame() {
  if (R.game.cleanup) {
    try {
      R.game.cleanup()
    } catch {
      /* 忽略 */
    }
    R.game.cleanup = null
  }
  stopReviewAudio()
}

function paintGame() {
  const host = reviewHost()
  if (!host) return
  const tabs = GAME_META.map(
    (game) => `<button type="button" class="rv-game-tab${R.game.kind === game.kind ? ' is-active' : ''}" data-act="switch-game" data-game="${esc(game.kind)}">
      ${game.icon === 'volume' ? icon('volume') : rIcon(game.icon)}${esc(game.title)}
    </button>`,
  ).join('')
  host.innerHTML = `
    <div class="rv-wrap narrow">
      <div class="rv-game-view">
        <div class="rv-game-view-head">
          <button type="button" class="rv-iconbtn" data-act="back" aria-label="回复习首页">${icon('back')}</button>
          <div style="flex:1;min-width:0">
            <div class="m-eyebrow">Play &amp; review</div>
            <h1 class="m-title">单词小游戏</h1>
          </div>
        </div>
        <div class="rv-game-tabs">${tabs}</div>
        <div class="rv-game-host" id="rv-game-host"><div class="rv-loading"><span class="spinner"></span>正在准备单词…</div></div>
      </div>
    </div>`
  host.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'back') {
      cleanupGame()
      R.view = 'home'
      paintHome()
      void refreshSummary()
    } else if (act === 'switch-game') {
      const kind = target.getAttribute('data-game') || 'match'
      if (kind === R.game.kind) return
      cleanupGame()
      R.game.kind = kind
      paintGame()
    }
  }
  const token = (R.game.token += 1)
  void mountGame(R.game.kind, token)
}

function gameHostEl() {
  return document.getElementById('rv-game-host')
}

/** 拉复习库词（缓存 60s），不足时补内置示例词并标记。 */
async function ensureWordPool() {
  if (R.wordsCache && Date.now() - R.wordsCacheAt < 60000) {
    return { words: R.wordsCache, reviewCount: R.wordsCache.length }
  }
  const res = await listApi({ status: 'all', limit: 500 })
  const words = ((res && res.ok !== false && Array.isArray(res.words) ? res.words : []) || [])
    .filter((w) => w && w.word && w.meaning)
    .map((w) => ({
      word: String(w.word).trim(),
      meaning: String(w.meaning).trim(),
      phonetic: String(w.phonetic || '').trim(),
      status: w.status || 'new',
    }))
  R.wordsCache = words
  R.wordsCacheAt = Date.now()
  return { words, reviewCount: words.length }
}

async function buildGamePool(minNeeded) {
  const { words, reviewCount } = await ensureWordPool()
  const seenWord = new Set()
  const seenMeaning = new Set()
  const pool = []
  const push = (item) => {
    if (!item || !item.word || !item.meaning) return false
    const key = item.word.toLowerCase()
    if (seenWord.has(key) || seenMeaning.has(item.meaning)) return false
    seenWord.add(key)
    seenMeaning.add(item.meaning)
    pool.push({ word: item.word, meaning: item.meaning, phonetic: item.phonetic || '' })
    return true
  }
  for (const item of shuffle(words)) {
    if (pool.length >= 20) break
    push(item)
  }
  let usedSample = false
  if (pool.length < minNeeded) {
    usedSample = true
    for (const item of shuffle(SAMPLE_WORDS)) {
      if (pool.length >= 20) break
      push(item)
    }
  }
  return { pool, usedSample, reviewCount }
}

async function mountGame(kind, token) {
  const host = gameHostEl()
  if (!host) return
  const minNeeded = kind === 'match' ? GAME_ROUND.match : 4
  const built = await buildGamePool(minNeeded)
  if (token !== R.game.token || R.view !== 'game' || R.game.kind !== kind) return
  if (built.pool.length < minNeeded) {
    host.innerHTML = `<div class="rv-empty">
      <span class="rv-empty-orb">${icon('game')}</span>
      <strong>单词不够，先攒几个词</strong>
      <p>小游戏至少需要 ${minNeeded} 个带中文释义的单词。结束一次对话或到词库手动添加后再来玩。</p>
      <div class="rv-empty-actions"><button type="button" class="btn btn-primary btn-sm" data-act="back">回复习首页</button></div>
    </div>`
    return
  }
  if (kind === 'match') mountMatchGame(host, built)
  else if (kind === 'listen') mountListenGame(host, built)
  else mountSpellGame(host, built)
}

function sampleNotice(built, minNeeded) {
  if (!built.usedSample) return ''
  if (built.reviewCount > 0) {
    return `<div class="rv-game-notice">复习库可用单词不足 ${minNeeded} 个，已补充示例词一起玩。多和角色聊聊，词库会越来越丰富。</div>`
  }
  return `<div class="rv-game-notice">复习库还没有单词，先用内置示例词练习。结束一次对话或到词库手动添加后，这里就会用你自己的单词。</div>`
}

/** 词义配对（英文 ↔ 中文，5 对/局）。 */
function mountMatchGame(host, built) {
  const pairsPerRound = GAME_ROUND.match
  const matchScore = 10
  const roundBonus = 20
  let score = readStoredNumber(MATCH_SCORE_KEY)
  let matched = 0
  let selected = null
  let lock = false
  let finished = false
  let timers = []
  let pairs = []

  host.innerHTML = `
    <div class="rv-game-panel">
      <div class="rv-game-panel-head">
        <div>
          <div class="rv-game-panel-title">${rIcon('cards')}词义配对</div>
          <div class="rv-game-panel-sub">先点英文，再点它对应的中文释义，配成一对</div>
        </div>
        <span class="rv-game-score">${icon('star')}<span class="js-score">${esc(score)}</span> 分</span>
      </div>
      ${sampleNotice(built, pairsPerRound)}
      <div class="match-grid js-board" role="group" aria-label="词义配对棋盘"></div>
      <div class="rv-game-actions">
        <button type="button" class="btn btn-ghost btn-sm js-new">${icon('refresh')}再来一局</button>
        <span class="rv-game-msg js-msg" role="status" aria-live="polite">准备好就开始吧</span>
      </div>
    </div>`

  const board = host.querySelector('.js-board')
  const scoreEl = host.querySelector('.js-score')
  const msgEl = host.querySelector('.js-msg')
  const newBtn = host.querySelector('.js-new')
  if (!board || !scoreEl || !msgEl || !newBtn) return

  const addTimer = (fn, ms) => {
    const id = window.setTimeout(() => {
      timers = timers.filter((t) => t !== id)
      fn()
    }, ms)
    timers.push(id)
    return id
  }
  const clearTimers = () => {
    timers.forEach((id) => window.clearTimeout(id))
    timers = []
  }
  const setMessage = (text, tone = '') => {
    msgEl.className = 'rv-game-msg js-msg' + (tone ? ' ' + tone : '')
    msgEl.textContent = text
  }
  const updateScore = () => {
    scoreEl.textContent = String(score)
  }
  const clearSelection = () => {
    if (selected) selected.classList.remove('is-selected')
    selected = null
  }
  const selectTile = (tile) => {
    clearSelection()
    selected = tile
    tile.classList.add('is-selected')
  }
  const spawnConfetti = () => {
    const old = host.querySelector('.match-confetti')
    if (old) old.remove()
    const layer = document.createElement('div')
    layer.className = 'match-confetti'
    layer.setAttribute('aria-hidden', 'true')
    const colors = ['#6ff2dd', '#b49cff', '#ffc57a', '#5eea9d', '#ff8fa3']
    for (let i = 0; i < 16; i++) {
      const bit = document.createElement('i')
      bit.style.left = Math.round(Math.random() * 94) + '%'
      bit.style.background = colors[i % colors.length]
      bit.style.setProperty('--dx', Math.round((Math.random() - 0.5) * 90) + 'px')
      bit.style.setProperty('--rot', Math.round(180 + Math.random() * 540) + 'deg')
      bit.style.animationDelay = (Math.random() * 0.22).toFixed(2) + 's'
      layer.appendChild(bit)
    }
    host.querySelector('.rv-game-panel').appendChild(layer)
    addTimer(() => layer.remove(), 1600)
  }
  const finishRound = () => {
    finished = true
    score += roundBonus
    writeStoredNumber(MATCH_SCORE_KEY, score)
    updateScore()
    setMessage(`太棒了！这一局全部配对成功 +${roundBonus} 分，再来一局？`, 'ok')
    spawnConfetti()
  }
  const startRound = () => {
    clearTimers()
    matched = 0
    lock = false
    finished = false
    clearSelection()
    pairs = shuffle(built.pool).slice(0, pairsPerRound)
    const tiles = []
    pairs.forEach((pair, index) => {
      tiles.push({ pair: index, lang: 'en', text: pair.word })
      tiles.push({ pair: index, lang: 'zh', text: pair.meaning })
    })
    board.innerHTML = shuffle(tiles)
      .map(
        (tile) => `<button type="button" class="match-tile ${tile.lang}" data-pair="${tile.pair}" data-lang="${tile.lang}"
          aria-label="${tile.lang === 'en' ? '英文单词' : '中文释义'}：${esc(tile.text)}">${esc(tile.text)}</button>`,
      )
      .join('')
    setMessage(`本轮 0 / ${pairsPerRound}`)
    updateScore()
  }

  board.addEventListener('click', (event) => {
    const tile = event.target instanceof Element ? event.target.closest('.match-tile') : null
    if (!tile || !board.contains(tile) || lock || finished) return
    if (tile.classList.contains('is-done')) return
    if (!selected) {
      selectTile(tile)
      return
    }
    if (tile === selected) {
      clearSelection()
      return
    }
    if (tile.dataset.lang === selected.dataset.lang) {
      selectTile(tile)
      return
    }
    const first = selected
    const second = tile
    if (first.dataset.pair === second.dataset.pair) {
      first.classList.remove('is-selected')
      first.classList.add('is-done')
      second.classList.add('is-done')
      selected = null
      matched += 1
      score += matchScore
      writeStoredNumber(MATCH_SCORE_KEY, score)
      updateScore()
      if (matched >= pairsPerRound) finishRound()
      else {
        setMessage(`配对成功 +${matchScore} 分 · 本轮 ${matched} / ${pairsPerRound}`, 'ok')
        addTimer(() => {
          if (!finished) setMessage(`本轮 ${matched} / ${pairsPerRound}`)
        }, 900)
      }
      return
    }
    lock = true
    first.classList.remove('is-selected')
    first.classList.add('is-wrong')
    second.classList.add('is-wrong')
    setMessage('这两个不是一对，再想想～')
    addTimer(() => {
      first.classList.remove('is-wrong')
      second.classList.remove('is-wrong')
      lock = false
      if (!finished) setMessage(`本轮 ${matched} / ${pairsPerRound}`)
    }, 480)
  })
  newBtn.addEventListener('click', () => startRound())

  R.game.cleanup = () => {
    clearTimers()
    const confetti = host.querySelector('.match-confetti')
    if (confetti) confetti.remove()
  }
  startRound()
}

/** 听音选词（点 🔊 听发音，4 选 1，6 题/局）。 */
function mountListenGame(host, built) {
  const questions = GAME_ROUND.listen
  const perScore = 10
  let index = 0
  let score = 0
  let correctCount = 0
  let answered = false
  let current = null
  let options = []
  let timers = []

  host.innerHTML = `
    <div class="rv-game-panel">
      <div class="rv-game-panel-head">
        <div>
          <div class="rv-game-panel-title">${icon('volume')}听音选词</div>
          <div class="rv-game-panel-sub">点喇叭听发音，从 4 个英文单词里选出你听到的那个</div>
        </div>
        <span class="rv-game-score">${icon('star')}<span class="js-score">0</span> 分</span>
      </div>
      ${sampleNotice(built, 4)}
      <div class="rv-game-progress">
        <div class="rv-progress-bar"><i class="js-progress" style="width:0%"></i></div>
        <span class="js-progress-label">第 1 / ${questions} 题</span>
      </div>
      <div class="rv-listen">
        <button type="button" class="rv-listen-speak js-play" aria-label="播放单词发音">${icon('volume')}</button>
        <div class="rv-listen-hint js-listen-hint">点击喇叭听发音 · 选出你听到的单词</div>
        <div class="rv-options js-options"></div>
      </div>
      <div class="rv-game-actions">
        <button type="button" class="btn btn-ghost btn-sm js-new">${icon('refresh')}再来一局</button>
        <span class="rv-game-msg js-msg" role="status" aria-live="polite">听音选词开始</span>
      </div>
    </div>`

  const scoreEl = host.querySelector('.js-score')
  const progressEl = host.querySelector('.js-progress')
  const progressLabel = host.querySelector('.js-progress-label')
  const optionsEl = host.querySelector('.js-options')
  const playBtn = host.querySelector('.js-play')
  const hintEl = host.querySelector('.js-listen-hint')
  const msgEl = host.querySelector('.js-msg')
  const newBtn = host.querySelector('.js-new')
  if (!scoreEl || !optionsEl || !playBtn || !newBtn) return

  const addTimer = (fn, ms) => {
    const id = window.setTimeout(() => {
      timers = timers.filter((t) => t !== id)
      fn()
    }, ms)
    timers.push(id)
    return id
  }
  const clearTimers = () => {
    timers.forEach((id) => window.clearTimeout(id))
    timers = []
  }
  const setMessage = (text, tone = '') => {
    if (!msgEl) return
    msgEl.className = 'rv-game-msg js-msg' + (tone ? ' ' + tone : '')
    msgEl.textContent = text
  }

  const speakCurrent = () => {
    if (current) speakWord(current.word)
  }

  const renderQuestion = () => {
    const correct = shuffle(built.pool)[0]
    current = correct
    const distractors = shuffle(built.pool.filter((item) => item.word !== correct.word)).slice(0, 3)
    options = shuffle([correct, ...distractors])
    answered = false
    optionsEl.innerHTML = options
      .map(
        (item) => `<button type="button" class="rv-option" data-word="${esc(item.word)}"><span class="rv-option-en">${esc(item.word)}</span><span class="rv-option-zh">${esc(item.meaning)}</span></button>`,
      )
      .join('')
    if (progressEl) progressEl.style.width = `${Math.round((index / questions) * 100)}%`
    if (progressLabel) progressLabel.textContent = `第 ${index + 1} / ${questions} 题`
    if (hintEl) hintEl.textContent = '点击喇叭听发音 · 选出你听到的单词'
    setMessage(`第 ${index + 1} 题`)
    speakCurrent()
  }

  const finish = () => {
    optionsEl.innerHTML = ''
    if (progressEl) progressEl.style.width = '100%'
    if (progressLabel) progressLabel.textContent = `完成 ${questions} 题`
    if (hintEl) {
      hintEl.innerHTML = `本局结束：答对 <b>${correctCount}</b> / ${questions} 题，得分 <b>${score}</b>。`
    }
    setMessage(score >= questions * perScore ? '全部答对，太厉害了！' : '不错，再来一局试试更高的分数？', 'ok')
  }

  const nextQuestion = () => {
    index += 1
    if (index >= questions) {
      finish()
      return
    }
    renderQuestion()
  }

  optionsEl.addEventListener('click', (event) => {
    const btn = event.target instanceof Element ? event.target.closest('.rv-option') : null
    if (!btn || answered || !current) return
    answered = true
    const picked = btn.getAttribute('data-word') || ''
    const isRight = picked === current.word
    if (isRight) {
      score += perScore
      correctCount += 1
      btn.classList.add('is-right')
      setMessage('答对了 +10 分！', 'ok')
    } else {
      btn.classList.add('is-wrong')
      setMessage(`选的是 ${picked}，正确答案是 ${current.word}`, 'bad')
      const right = optionsEl.querySelector('[data-word="' + cssEscape(current.word) + '"]')
      if (right) right.classList.add('is-right')
    }
    scoreEl.textContent = String(score)
    optionsEl.querySelectorAll('.rv-option').forEach((el) => {
      el.disabled = true
    })
    addTimer(nextQuestion, isRight ? 900 : 1400)
  })

  playBtn.addEventListener('click', () => speakCurrent())
  newBtn.addEventListener('click', () => {
    clearTimers()
    index = 0
    score = 0
    correctCount = 0
    scoreEl.textContent = '0'
    renderQuestion()
  })

  R.game.cleanup = () => {
    clearTimers()
  }
  renderQuestion()
}

/** 拼写填空（看中文释义 + 音标，拼出英文，5 题/局）。 */
function mountSpellGame(host, built) {
  const questions = GAME_ROUND.spell
  const perScore = 15
  let index = 0
  let score = 0
  let correctCount = 0
  let current = null
  let answered = false
  let timers = []

  host.innerHTML = `
    <div class="rv-game-panel">
      <div class="rv-game-panel-head">
        <div>
          <div class="rv-game-panel-title">${rIcon('spell')}拼写填空</div>
          <div class="rv-game-panel-sub">看中文释义和音标，把英文单词拼出来</div>
        </div>
        <span class="rv-game-score">${icon('star')}<span class="js-score">0</span> 分</span>
      </div>
      ${sampleNotice(built, 4)}
      <div class="rv-game-progress">
        <div class="rv-progress-bar"><i class="js-progress" style="width:0%"></i></div>
        <span class="js-progress-label">第 1 / ${questions} 题</span>
      </div>
      <div class="rv-spell">
        <div class="rv-spell-prompt">
          <div class="rv-spell-meaning js-meaning">…</div>
          <div class="rv-spell-meta"><span class="rv-phonetic js-phonetic"></span><span class="js-length"></span></div>
          <div class="rv-spell-blanks js-blanks"></div>
        </div>
        <form class="rv-spell-form js-form" autocomplete="off">
          <input type="text" class="js-input" placeholder="输入英文单词" maxlength="40" spellcheck="false" aria-label="拼写英文单词">
          <button type="submit" class="btn btn-primary">提交</button>
        </form>
        <div class="rv-spell-tools">
          <button type="button" class="rv-spell-tool js-hint">${icon('bulb')}提示一个字母</button>
          <button type="button" class="rv-spell-tool js-skip">不会，看答案</button>
        </div>
        <div class="rv-spell-msg js-msg" role="status" aria-live="polite">按回车提交答案</div>
      </div>
      <div class="rv-game-actions">
        <button type="button" class="btn btn-ghost btn-sm js-new">${icon('refresh')}再来一局</button>
        <span class="rv-game-msg js-tip">提示：拼错也没关系，会显示正确答案</span>
      </div>
    </div>`

  const scoreEl = host.querySelector('.js-score')
  const progressEl = host.querySelector('.js-progress')
  const progressLabel = host.querySelector('.js-progress-label')
  const meaningEl = host.querySelector('.js-meaning')
  const phoneticEl = host.querySelector('.js-phonetic')
  const lengthEl = host.querySelector('.js-length')
  const blanksEl = host.querySelector('.js-blanks')
  const form = host.querySelector('.js-form')
  const input = host.querySelector('.js-input')
  const msgEl = host.querySelector('.js-msg')
  const hintBtn = host.querySelector('.js-hint')
  const skipBtn = host.querySelector('.js-skip')
  const newBtn = host.querySelector('.js-new')
  if (!scoreEl || !form || !input || !newBtn) return
  let revealed = 1

  const addTimer = (fn, ms) => {
    const id = window.setTimeout(() => {
      timers = timers.filter((t) => t !== id)
      fn()
    }, ms)
    timers.push(id)
    return id
  }
  const clearTimers = () => {
    timers.forEach((id) => window.clearTimeout(id))
    timers = []
  }
  const setMessage = (text, tone = '') => {
    if (!msgEl) return
    msgEl.className = 'rv-spell-msg js-msg' + (tone ? ' ' + tone : '')
    msgEl.textContent = text
  }

  const paintBlanks = () => {
    if (!blanksEl || !current) return
    const chars = current.word.split('')
    blanksEl.textContent = chars
      .map((ch, i) => (i < revealed || ch === ' ' ? (ch === ' ' ? '  ' : ch) : '_'))
      .join(' ')
  }

  const setSpellTools = (enabled) => {
    ;[hintBtn, skipBtn].forEach((btn) => {
      if (btn) btn.disabled = !enabled
    })
  }

  const renderQuestion = () => {
    current = shuffle(built.pool)[0]
    answered = false
    revealed = 1
    if (meaningEl) meaningEl.textContent = current.meaning
    if (phoneticEl) phoneticEl.textContent = current.phonetic || ''
    if (lengthEl) {
      const letters = current.word.replace(/\s+/g, '').length
      lengthEl.textContent = `${letters} 个字母${/\s/.test(current.word) ? '（词组）' : ''}`
    }
    paintBlanks()
    if (progressEl) progressEl.style.width = `${Math.round((index / questions) * 100)}%`
    if (progressLabel) progressLabel.textContent = `第 ${index + 1} / ${questions} 题`
    input.value = ''
    input.disabled = false
    form.querySelector('button').disabled = false
    setSpellTools(true)
    setMessage('按回车提交答案 · 不会可以点「看答案」')
    if (typeof window !== 'undefined') {
      if (input && document.activeElement !== input) input.focus({ preventScroll: true })
    }
  }

  const finish = () => {
    if (meaningEl) meaningEl.textContent = '本局结束'
    if (phoneticEl) phoneticEl.textContent = ''
    if (lengthEl) lengthEl.textContent = ''
    if (blanksEl) blanksEl.textContent = `答对 ${correctCount} / ${questions}`
    if (progressEl) progressEl.style.width = '100%'
    if (progressLabel) progressLabel.textContent = `完成 ${questions} 题`
    input.disabled = true
    form.querySelector('button').disabled = true
    setSpellTools(false)
    setMessage(
      score >= questions * perScore ? `全部拼对，得分 ${score}，太厉害了！` : `本局得分 ${score}，再来一局挑战全对？`,
      'ok',
    )
  }

  const nextQuestion = () => {
    index += 1
    if (index >= questions) finish()
    else renderQuestion()
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (answered || !current) return
    const answer = input.value.trim().toLowerCase()
    if (!answer) {
      setMessage('先输入你拼的单词再提交', 'bad')
      return
    }
    answered = true
    input.disabled = true
    form.querySelector('button').disabled = true
    setSpellTools(false)
    const isRight = answer === current.word.toLowerCase()
    if (isRight) {
      score += perScore
      correctCount += 1
      scoreEl.textContent = String(score)
      setMessage(`拼对了！+${perScore} 分`, 'ok')
      addTimer(nextQuestion, 900)
    } else {
      revealed = current.word.length
      paintBlanks()
      setMessage(`正确答案是 ${current.word}，下一题继续加油`, 'bad')
      addTimer(nextQuestion, 1600)
    }
  })

  if (hintBtn) {
    hintBtn.addEventListener('click', () => {
      if (answered || !current) return
      const chars = current.word.split('')
      let index2 = revealed
      while (index2 < chars.length && chars[index2] === ' ') index2 += 1
      if (index2 >= chars.length) {
        setMessage('字母已经全部提示出来了，试试提交吧', 'ok')
        return
      }
      revealed = index2 + 1
      paintBlanks()
      setMessage(`提示：第 ${index2 + 1} 个字母是「${chars[index2]}」`)
    })
  }
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      if (answered || !current) return
      answered = true
      input.disabled = true
      form.querySelector('button').disabled = true
      setSpellTools(false)
      revealed = current.word.length
      paintBlanks()
      setMessage(`不会没关系，正确答案是 ${current.word}（${current.meaning}）`, 'bad')
      addTimer(nextQuestion, 1800)
    })
  }

  newBtn.addEventListener('click', () => {
    clearTimers()
    index = 0
    score = 0
    correctCount = 0
    scoreEl.textContent = '0'
    renderQuestion()
  })

  R.game.cleanup = () => {
    clearTimers()
  }
  renderQuestion()
}

/* ------------------------------ 本地分数存取 ------------------------------ */
function readStoredNumber(key) {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  } catch {
    return 0
  }
}

function writeStoredNumber(key, value) {
  try {
    localStorage.setItem(key, String(Math.max(0, Math.floor(Number(value) || 0))))
  } catch {
    /* 忽略 */
  }
}

/* ==========================================================================
   对外：渲染入口 / QA 调试
   ========================================================================== */
/** 渲染复习屏（由 screens.renderTab 调用）。 */
export function renderReview() {
  const host = reviewHost()
  if (!host) return
  R.token += 1
  updateBadge()
  if (R.view === 'session') paintSession()
  else if (R.view === 'finish') paintFinish()
  else if (R.view === 'manage') {
    paintManage()
    if (!R.manage.loading && !R.manage.words.length) void loadManageWords()
  } else if (R.view === 'game') paintGame()
  else paintHome()

  if (R.view === 'home' && !R.summaryLoaded && !R.summaryLoading) {
    void refreshSummary().then(() => {
      if (M.tab === 'review' && R.view === 'home') paintHome()
    })
  }
}

/** 复习状态（QA / CDP 断言用）。 */
export function getReviewState() {
  const s = R.session
  const word = s && s.words.length ? s.words[Math.min(s.index, s.words.length - 1)] : null
  return {
    view: R.view,
    summary: { ...R.summary },
    summaryLoaded: R.summaryLoaded,
    summaryLoading: R.summaryLoading,
    summaryError: R.summaryError,
    dueBadge: (() => {
      const badge = document.getElementById('tab-due')
      return badge && !badge.hidden ? badge.textContent : ''
    })(),
    session: s
      ? {
          mode: s.mode,
          index: s.index,
          position: s.index + 1,
          total: s.words.length,
          flipped: s.flipped,
          grading: s.grading,
          word: word ? word.word : '',
          answers: s.answers.map((a) => ({ word: a.word, grade: a.grade })),
        }
      : null,
    finish: R.finish
      ? { total: R.finish.total, good: R.finish.good, again: R.finish.again }
      : null,
    manage: {
      status: R.manage.status,
      q: R.manage.q,
      loading: R.manage.loading,
      count: R.manage.words.length,
      words: R.manage.words.slice(0, 12).map((w) => ({ word: w.word, status: w.status })),
    },
    game: { kind: R.game.kind },
  }
}

/** QA 可直接调用的复习调试接口（挂到 window.__avaMobile.review）。 */
export function reviewDebug() {
  return {
    state: getReviewState,
    refresh: async () => {
      const ok = await refreshSummary()
      if (R.view === 'home') paintHome()
      return ok
    },
    openHome: () => {
      cleanupGame()
      R.session = null
      R.finish = null
      R.view = 'home'
      paintHome()
    },
    startSession: (mode = 'due') => {
      if (mode === 'again' && R.finish && Array.isArray(R.finish.againWords) && R.finish.againWords.length) {
        return startSession('again', R.finish.againWords)
      }
      return startSession(mode)
    },
    openManage: (options) => openManage(options),
    openGame: (kind) => openGame(kind),
    /** 供 CDP 联调：批量加词后刷新列表/徽标。 */
    addWords: async (words) => {
      const res = await addApi(words)
      if (res && res.summary) applySummary(res.summary)
      return res
    },
    grade: (grade) => gradeCurrent(grade),
    flip: () => flipCard(),
    speak: (word) => speakWord(word || (currentWord() && currentWord().word)),
    back: () => reviewHandleBack(),
    loadManageWords: () => loadManageWords(),
    filterWords: (status) => {
      R.manage.status = status
      if (R.view === 'manage') paintManage()
      return loadManageWords()
    },
    /** 清空每日提醒记录（便于重复验证提醒）。 */
    resetReminder: () => {
      try {
        localStorage.removeItem(REMIND_KEY)
      } catch {
        /* 忽略 */
      }
    },
  }
}

/** 供 app.js 判断是否处于复习子视图（返回键用）。 */
export function isReviewSubView() {
  return R.view !== 'home'
}
