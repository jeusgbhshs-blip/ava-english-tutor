/**
 * Ava 手机版 · 核心状态 / API 包装 / 通用 UI
 * 只 import 现有模块（api.js / speech.js / store.js 可按需），不修改它们。
 * @module mobile/core
 */
import { api, getJSON, postJSON, chatStream } from '../api.js'

/* ------------------------------ 基础工具 ------------------------------ */
export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

/** HTML 转义 */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 内联 SVG 图标 */
export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#m-${esc(name)}"></use></svg>`
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** mm:ss */
export function mmss(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds))
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

/* ------------------------------ 全局状态 ------------------------------ */
export const M = {
  tab: 'courses',
  characters: [],
  plan: null,
  // SPEC v3.0：`GET /api/plan` 同时返回的课程列表（每阶段 1 节，含常用句/3 步）
  lessons: [],
  settings: null,
  content: null,
  progress: null,
  wordbook: null,
  nickname: (() => {
    try {
      return localStorage.getItem('ava.mobile.nickname') || '英语学习者'
    } catch {
      return '英语学习者'
    }
  })(),
  assistantThread: [],
  activeCharId: 'elena',
  profile: null,
  loaded: false,
}

/** 供 app.js 注册的跨模块动作 */
export const ui = {
  switchTab: () => {},
  openCall: () => {},
  openSheet: () => {},
  closeSheet: () => {},
  isSheetCurrent: () => false,
  updateSheet: () => false,
  openWordbookSheet: () => {},
  refreshCourses: () => {},
}

/* ------------------------------ Toast ------------------------------ */
let toastSeq = 0
export function toast(message, type = 'info', ms = 2600) {
  const box = $('#toasts')
  if (!box) return
  const id = 'mt' + ++toastSeq
  const node = document.createElement('div')
  node.className = 'toast ' + type
  node.id = id
  node.setAttribute('role', type === 'bad' ? 'alert' : 'status')
  node.setAttribute('aria-atomic', 'true')
  node.innerHTML = `${icon(type === 'ok' ? 'check' : type === 'bad' ? 'close' : 'spark')}<span>${esc(message)}</span>`
  box.appendChild(node)
  while (box.children.length > 3) box.firstElementChild.remove()
  setTimeout(() => {
    node.classList.add('is-out')
    setTimeout(() => node.remove(), 260)
  }, Math.max(type === 'bad' ? 5000 : 1200, ms))
}

/* ---------------------------- 角色 / 场景 ---------------------------- */
/** v1.7 用户指定人物素材 + 主题色（禁止改画人物，只允许 cover 裁切） */
export const KNOWN_CHARACTER_ASSETS = {
  elena: { cover: '/assets/characters/elena.jpg', themeColor: '#d9b477' },
  maya: { cover: '/assets/characters/maya.jpg', themeColor: '#6f8fd6' },
  hikari: { cover: '/assets/characters/hikari.jpg', themeColor: '#9fc3e8' },
}

/** 角色封面（jpg 优先，svg 兜底） */
export function characterCover(character, { fallback = true } = {}) {
  if (!character) return ''
  const known = KNOWN_CHARACTER_ASSETS[character.id]
  if (known) return known.cover
  return character.cover || (fallback ? `./assets/characters/${character.id}.jpg` : '')
}

/** 角色主题色 */
export function characterTheme(character) {
  if (!character) return '#6ff2dd'
  return KNOWN_CHARACTER_ASSETS[character.id]?.themeColor || character.themeColor || '#6ff2dd'
}

export const CHARACTER_FALLBACK = [
  {
    id: 'elena',
    name: 'Elena',
    nameZh: '艾莲娜',
    city: '伦敦',
    role: '27 岁 · 画廊策展人',
    style: '半写实女性（暖色画廊、风衣、盘发）',
    tags: ['温柔', '艺术', '下午茶'],
    voiceLabel: 'Dacey · 温柔女声',
    cover: './assets/characters/elena.jpg',
    themeColor: '#d9b477',
    level: 'A2',
    greeting: "Hi, I'm Elena. I just finished hanging a new exhibition — tell me, what's the last beautiful thing you noticed today?",
    scenes: [
      { id: 'gallery', label: '在画廊聊艺术', emoji: '🎨' },
      { id: 'tea', label: '英式下午茶', emoji: '🫖' },
      { id: 'london', label: '伦敦街头问路', emoji: '🧭' },
    ],
  },
  {
    id: 'maya',
    name: 'Maya',
    nameZh: '玛雅',
    city: '纽约',
    role: '29 岁 · 广告创意总监',
    style: '半写实女性（干练短发、纽约 loft / 霓虹窗景）',
    tags: ['直爽', '幽默', '职场'],
    voiceLabel: 'Stokie · 直爽女声',
    cover: './assets/characters/maya.jpg',
    themeColor: '#6f8fd6',
    level: 'B1',
    greeting: "Hey, Maya here. I just pitched a wild idea to a client and I'm still buzzing — what's the boldest thing you've done this week?",
    scenes: [
      { id: 'cafe', label: '纽约咖啡店点单', emoji: '☕' },
      { id: 'pitch', label: '创意提案会议', emoji: '💡' },
      { id: 'gym', label: '健身房偶遇', emoji: '🏋️' },
    ],
  },
  {
    id: 'hikari',
    name: 'Hikari',
    nameZh: '光',
    city: '东京',
    role: '20 岁 · 虚拟偶像练习生',
    style: '二次元（粉发、霓虹街头 / 游戏房）',
    tags: ['元气', '二次元', '游戏'],
    voiceLabel: 'VV · 元气女声',
    cover: './assets/characters/hikari.jpg',
    themeColor: '#9fc3e8',
    level: 'A2',
    greeting: "Hikari 来啦～ I just finished dance practice and my legs are dead! Do you play any games? Let's talk about something fun!",
    scenes: [
      { id: 'akiba', label: '秋叶原逛店', emoji: '🛍' },
      { id: 'gaming', label: '游戏语音房', emoji: '🎮' },
      { id: 'comic', label: '漫展聊天', emoji: '🌸' },
    ],
  },
]

export function characterById(id) {
  return M.characters.find((c) => c.id === id) || M.characters[0] || CHARACTER_FALLBACK[0]
}

export function sceneIndex(character, sceneId) {
  if (!character || !Array.isArray(character.scenes)) return 0
  const idx = character.scenes.findIndex((s) => s.id === sceneId)
  return idx >= 0 ? idx : 0
}

/* ------------------------------ 数据 API ------------------------------ */
const readGeneration = { plan: 0, settings: 0, content: 0, wordbook: 0, progress: 0, profile: 0 }
let settingsWriteGeneration = 0

async function safeCall(fn, fallback = null) {
  try {
    const value = await fn()
    return value == null ? fallback : value
  } catch {
    return fallback
  }
}

export async function loadCharacters() {
  const res = await safeCall(async () => {
    if (api && typeof api.getCharacters === 'function') return api.getCharacters()
    return getJSON('/api/characters')
  })
  const list = res && Array.isArray(res.characters) ? res.characters : Array.isArray(res) ? res : []
  M.characters = (list.length ? list : CHARACTER_FALLBACK).map((c) => {
    const fb = CHARACTER_FALLBACK.find((f) => f.id === c.id) || {}
    const known = KNOWN_CHARACTER_ASSETS[c.id]
    return {
      ...fb,
      ...c,
      tags: Array.isArray(c.tags) ? c.tags : fb.tags || [],
      scenes: Array.isArray(c.scenes) && c.scenes.length ? c.scenes : fb.scenes || [],
      // v1.7：严格使用用户提供的三张人物原图（cover 裁切），themeColor 用新主题色
      cover: (known && known.cover) || c.cover || fb.cover || `./assets/characters/${c.id}.jpg`,
      themeColor: (known && known.themeColor) || c.themeColor || fb.themeColor || '#6ff2dd',
      role: c.role || fb.role || '',
      greeting: c.greeting || fb.greeting || "Hi! It's so nice to finally talk to you. How's your day going?",
    }
  })
  return M.characters
}

export async function loadPlan() {
  const generation = ++readGeneration.plan
  const res = await safeCall(async () => {
    if (api && typeof api.getPlan === 'function') return api.getPlan()
    return getJSON('/api/plan')
  })
  // 更新的读取或已确认的计划保存拥有当前状态；迟到响应不能清缓存或改课件。
  if (generation !== readGeneration.plan) return M.plan
  const apiOk = !!(res && typeof res === 'object' && res.ok !== false)
  if (!apiOk && M.plan) return M.plan
  let plan = apiOk ? res.plan || null : null
  // 服务端明确返回“没有计划”时，不要再用 localStorage 旧计划兜底（否则会一直显示旧课件/生成中）
  if (apiOk && !plan) {
    try {
      localStorage.removeItem('ava.mobile.plan')
    } catch {
      /* ignore */
    }
  } else if (!apiOk) {
    plan = loadLocalPlan()
  }
  // 旧版本计划（没有 v3 lessons）不再展示，避免看起来一直加载
  if (plan && Number(plan.version) !== 3) {
    plan = null
    try {
      localStorage.removeItem('ava.mobile.plan')
    } catch {
      /* ignore */
    }
  }
  M.plan = plan || null
  // SPEC v3.1：课件在 plan.lessons（map，用户自定义 3 节课）；兼容旧接口 res.lessons
  if (plan && plan.lessons && typeof plan.lessons === 'object') {
    M.lessons = Object.values(plan.lessons)
  } else {
    M.lessons = plan && res && Array.isArray(res.lessons) ? res.lessons : []
  }
  return M.plan
}

export async function loadSettings() {
  const generation = ++readGeneration.settings
  const res = await safeCall(async () => {
    if (api && typeof api.getSettings === 'function') return api.getSettings()
    return getJSON('/api/settings')
  })
  if (!res || typeof res !== 'object' || res.ok === false) return null
  if (generation === readGeneration.settings) M.settings = res
  return M.settings
}

export async function loadContent() {
  const generation = ++readGeneration.content
  const res = await safeCall(async () => {
    if (api && typeof api.getContent === 'function') return api.getContent()
    return getJSON('/api/content')
  })
  if (!res || typeof res !== 'object' || res.ok === false) return null
  if (generation === readGeneration.content) M.content = res
  return M.content
}

export async function loadWordbook() {
  const generation = ++readGeneration.wordbook
  const res = await safeCall(async () => {
    if (api && typeof api.getWordbook === 'function') return api.getWordbook(7)
    return getJSON('/api/wordbook?days=7')
  })
  if (!res || typeof res !== 'object' || res.ok === false) return null
  if (generation === readGeneration.wordbook) M.wordbook = res
  return M.wordbook
}

export async function loadProgress() {
  const generation = ++readGeneration.progress
  const res = await safeCall(async () => {
    if (api && typeof api.getProgress === 'function') return api.getProgress()
    return getJSON('/api/progress')
  })
  if (!res || typeof res !== 'object' || res.ok === false) return null
  if (generation === readGeneration.progress) M.progress = res
  return M.progress
}

export async function saveSettings(patch) {
  const generation = ++settingsWriteGeneration
  readGeneration.settings++
  const res = await safeCall(async () => {
    if (api && typeof api.saveSettings === 'function') return api.saveSettings(patch)
    return postJSON('/api/settings', patch)
  })
  if (generation === settingsWriteGeneration && res && typeof res === 'object' && res.ok !== false) {
    // Reads started while this write was pending may still contain old settings.
    readGeneration.settings++
    M.settings = { ...(M.settings || {}), ...res }
  }
  return res
}

export async function assistantChat(message, extra = {}) {
  const body = { message, history: M.assistantThread.slice(-12).map((m) => ({ role: m.role, content: m.content })), ...extra }
  const res = await safeCall(async () => {
    if (api && typeof api.assistantChat === 'function') return api.assistantChat(body)
    return postJSON('/api/assistant', body)
  })
  return res && typeof res === 'object' ? res : null
}

export async function translateTexts(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === 'string' && t.trim())
  if (!list.length) return null
  try {
    let res
    if (api && typeof api.translate === 'function') res = await api.translate(list, 'zh')
    else res = await postJSON('/api/translate', { texts: list, target: 'zh' }, { timeoutMs: 30000 })
    if (!res || res.ok === false || !Array.isArray(res.texts)) return null
    return res.texts.map((v) => (typeof v === 'string' && v.trim() ? v.trim() : null))
  } catch {
    return null
  }
}

export async function fetchSummary(messages) {
  try {
    if (api && typeof api.summarizeConversation === 'function') {
      return await api.summarizeConversation({ messages, mode: 'free' })
    }
    return await postJSON('/api/summary', { messages, mode: 'free' }, { timeoutMs: 70000 })
  } catch {
    return null
  }
}

export { chatStream, api, getJSON, postJSON }


/* ------------------------------ 知识库 / 兴趣档案（v1.8） ------------------------------ */
/** 通用 JSON 请求兜底（api.js 尚未提供 kb/profile 方法时直连后端）。 */
async function requestJSON(path, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1000, timeoutMs)) : null
  try {
    const res = await fetch(path, {
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
      const message = (data && (data.error || data.message)) || `请求失败（HTTP ${res.status}）`
      return { ok: false, error: message, status: res.status }
    }
    if (data && typeof data === 'object') return data
    return { ok: true }
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
    return { ok: false, error: aborted ? '请求超时，请稍后重试' : (err && err.message) || '网络异常，请检查本地服务' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function apiOrFallback(method, path, options) {
  if (api && typeof api[method] === 'function') {
    return Promise.resolve()
      .then(() => api[method](options))
      .catch((err) => ({ ok: false, error: (err && err.message) || '请求失败，请稍后重试' }))
  }
  return null
}

/** 上传知识库文件（base64）。 */
export async function kbUpload({ name, dataBase64, mime } = {}) {
  const viaApi = apiOrFallback('kbUpload', null, { name, dataBase64, mime })
  if (viaApi) return viaApi
  return requestJSON('/api/kb/upload', { method: 'POST', body: { name, dataBase64, mime }, timeoutMs: 90000 })
}

/** 导入网页链接到知识库。 */
export async function kbImportUrl(url) {
  const viaApi = apiOrFallback('kbImportUrl', null, url)
  if (viaApi) return viaApi
  return requestJSON('/api/kb/url', { method: 'POST', body: { url }, timeoutMs: 60000 })
}

/** 知识库材料列表。 */
export async function kbList() {
  const viaApi = apiOrFallback('kbList', null)
  if (viaApi) return viaApi
  return requestJSON('/api/kb/list', { timeoutMs: 20000 })
}

/** 单篇材料详情（含预览/分块）。 */
export async function kbGet(id) {
  const viaApi = apiOrFallback('kbGet', null, id)
  if (viaApi) return viaApi
  return requestJSON(`/api/kb/${encodeURIComponent(id)}`, { timeoutMs: 20000 })
}

/** 删除材料。 */
export async function kbDelete(id) {
  const viaApi = apiOrFallback('kbDelete', null, id)
  if (viaApi) return viaApi
  return requestJSON(`/api/kb/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 20000 })
}

/** 知识库检索（引用卡片/调试用）。 */
export async function kbSearch(query, options = {}) {
  if (api && typeof api.kbSearch === 'function') {
    try {
      return await api.kbSearch(query, options)
    } catch (err) {
      return { ok: false, error: (err && err.message) || '检索失败', results: [] }
    }
  }
  return requestJSON('/api/kb/search', { method: 'POST', body: { query, ...(options || {}) }, timeoutMs: 45000 })
}

/** 重新生成某篇材料的摘要/关键词。 */
export async function kbEnrich(id) {
  const viaApi = apiOrFallback('kbEnrich', null, id)
  if (viaApi) return viaApi
  return requestJSON(`/api/kb/${encodeURIComponent(id)}/enrich`, { method: 'POST', timeoutMs: 120000 })
}

/** 兴趣档案（对话导演/记忆）。 */
export async function getProfile() {
  const viaApi = apiOrFallback('getProfile', null)
  if (viaApi) return viaApi
  return requestJSON('/api/profile', { timeoutMs: 15000 })
}

/** 保存兴趣档案。 */
export async function saveProfile(patch = {}) {
  const viaApi = apiOrFallback('saveProfile', null, patch)
  if (viaApi) return viaApi
  return requestJSON('/api/profile', { method: 'PUT', body: patch, timeoutMs: 20000 })
}

/** 读取兴趣列表（通用规范化）。 */
export async function loadProfile() {
  const generation = ++readGeneration.profile
  const res = await getProfile()
  const profile = res && typeof res === 'object' && res.ok !== false ? res.profile || res : null
  if (!profile || typeof profile !== 'object') return null
  if (generation === readGeneration.profile) M.profile = profile
  return M.profile
}

/* ------------------------------ 本地计划 ------------------------------ */
export function saveLocalPlan(plan) {
  readGeneration.plan++
  try {
    localStorage.setItem('ava.mobile.plan', JSON.stringify(plan))
  } catch {
    /* 忽略 */
  }
  M.plan = plan
  M.lessons = plan && plan.lessons && typeof plan.lessons === 'object' ? Object.values(plan.lessons) : []
}

export function loadLocalPlan() {
  try {
    const raw = localStorage.getItem('ava.mobile.plan')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** 规则版“创建学习计划”（/api/assistant 未就绪或失败时兜底）。 */
export function buildLocalPlan(goal = '提升英语日常会话', characterId = 'elena') {
  const now = Date.now()
  return {
    id: 'plan_local_' + now,
    characterId,
    goal,
    level: (M.settings && M.settings.level) || 'A2',
    createdAt: now,
    updatedAt: now,
    stages: [
      {
        id: 'stage-warmup',
        title: '热身：敢开口',
        emoji: '🌤',
        progress: 0,
        scenes: [
          { characterId: 'elena', sceneId: 'tea', label: '英式下午茶闲聊' },
          { characterId: 'maya', sceneId: 'cafe', label: '纽约咖啡店点单' },
        ],
      },
      {
        id: 'stage-scene',
        title: '情景：真实对话',
        emoji: '🎬',
        progress: 0,
        scenes: [
          { characterId: 'maya', sceneId: 'pitch', label: '创意提案会议' },
          { characterId: 'elena', sceneId: 'gallery', label: '在画廊聊艺术' },
          { characterId: 'hikari', sceneId: 'akiba', label: '秋叶原逛店' },
        ],
      },
      {
        id: 'stage-free',
        title: '自由：聊什么都行',
        emoji: '✨',
        progress: 0,
        scenes: [
          { characterId: 'hikari', sceneId: 'gaming', label: '游戏语音房' },
          { characterId: 'elena', sceneId: 'london', label: '伦敦街头问路' },
        ],
      },
    ],
  }
}

/* ------------------------------ 单词本弹层 ------------------------------ */
export async function showWordbookSheet() {
  const token = ui.openSheet('今日单词表', `<div class="summary-loading"><span class="spinner"></span>正在读取今日单词表…</div>`)
  const book = await loadWordbook()
  if (!ui.isSheetCurrent(token)) return
  if (!book) {
    ui.updateSheet(token, '今日单词表', `<div class="empty-card"><strong>暂时无法读取单词表</strong><p>已有单词会保留。请检查本地服务后重试。</p><button type="button" class="btn btn-primary" id="wordbook-retry">重新加载</button></div>`)
    $('#wordbook-retry')?.addEventListener('click', () => { if (ui.isSheetCurrent(token)) void showWordbookSheet() })
    return
  }
  const days = book && Array.isArray(book.days) ? book.days : []
  const words = days.flatMap((d) => (Array.isArray(d.words) ? d.words : []))
  if (!words.length) {
    ui.updateSheet(
      token,
      '今日单词表',
      `<div class="empty-card"><span class="empty-orb">${icon('book')}</span><strong>还没有单词</strong><p>通话或聊天后，Ava 会把重点单词和纠错自动整理进今日单词表。</p></div>`,
    )
    return
  }
  const list = words
    .slice(0, 30)
    .map(
      (w) => `<div class="summary-item">
        <div><b style="font-family:var(--font-en)">${esc(w.word)}</b>
        ${w.phonetic ? `<span style="color:var(--m-faint);font-size:10.5px"> ${esc(w.phonetic)}</span>` : ''}</div>
        <div class="zh">${esc(w.meaning || '')}</div>
        ${w.example ? `<div class="en" style="font-size:11px;color:var(--m-muted);margin-top:2px">${esc(w.example)}</div>` : ''}
      </div>`,
    )
    .join('')
  ui.updateSheet(token, '今日单词表', `<div class="muted" style="font-size:12px">共 ${words.length} 个单词</div><div class="summary-kw" style="grid-template-columns:1fr">${list}</div>`)
}
