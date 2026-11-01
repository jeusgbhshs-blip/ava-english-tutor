/**
 * Ava · 四种教学模式 UI 与交互
 * free（自由对话）/ vocab（单词闯关）/ pronounce（跟读打分）/ roleplay（角色扮演）
 *
 * 本模块只负责「模式面板 + 底部快捷操作 + 模式专属动作」的渲染与事件处理；
 * 语音、TTS、流式对话、进度保存等能力由 main.js 通过 ctx 注入（避免循环依赖）。
 *
 * @module modes
 */
import { api, getJSON, postJSON } from './api.js'
import { $, esc, icon, toast, confetti, renderStars } from './ui.js'

/** @typedef {ReturnType<typeof defaultState>} ModeState */
function defaultState() {
  return {
    current: 'free',
    free: { hintOpen: false, started: false, lastOpener: '', inspireOffset: 0 },
    vocab: {
      topicId: null,
      index: 0,
      flipped: false,
      quizKind: 'choice',
      quiz: null,
      score: null,
      reviewing: false,
      reviewQueue: [],
      reviewIndex: 0,
      reviewDone: false,
    },
    pronounce: { bankId: null, index: 0, result: null, results: {} },
    roleplay: { scenarioId: null, started: false, ended: false, done: [], summary: null },
    reading: {
      docs: [],
      docsLoaded: false,
      docId: null,
      doc: null,
      analysis: null,
      analysisDemo: false,
      listLoading: false,
      listError: '',
      uploading: false,
      uploadingName: '',
      analyzing: false,
      analyzeError: '',
      started: false,
      questionIndex: 0,
      confirmDelete: false,
      scrollToAnalysis: false,
    },
  }
}

const MODE_META = {
  free: { eyebrow: 'FREE TALK', title: '自由对话', icon: 'chat' },
  vocab: { eyebrow: 'VOCABULARY', title: '单词闯关', icon: 'book' },
  pronounce: { eyebrow: 'PRONUNCIATION', title: '跟读打分', icon: 'headphones' },
  roleplay: { eyebrow: 'ROLE-PLAY', title: '角色扮演', icon: 'theater' },
  reading: { eyebrow: 'READING', title: '阅读讲解', icon: 'file-text' },
}

/** @type {ModeState} */
const S = defaultState()

/** @type {any} */
let ctx = null
let bound = false
/** 渲染后的待执行动效（如评分环） */
let afterRender = []

/* -------------------------------------------------------------------------- */
/* 初始化 / 导航                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 注入主应用上下文并绑定事件（幂等）。
 * @param {any} appCtx
 */
export function initModes(appCtx) {
  ctx = appCtx
  if (bound) {
    refresh()
    return
  }
  bound = true
  const panel = document.getElementById('mode-panel')
  const dock = document.getElementById('dock-left')
  panel?.addEventListener('click', (e) => onPanelClick(e))
  panel?.addEventListener('keydown', (e) => {
    const target = e.target
    if (target instanceof HTMLInputElement && target.id === 'vocab-spell' && e.key === 'Enter') {
      e.preventDefault()
      spellCheck()
    }
  })
  dock?.addEventListener('click', (e) => onDockClick(e))
  // 阅读讲解：文件选择 / 拖拽（事件委托，面板重渲染后依然生效）
  panel?.addEventListener('change', (e) => {
    const target = e.target
    if (!(target instanceof HTMLInputElement) || target.id !== 'doc-file-input') return
    const file = target.files && target.files[0]
    target.value = ''
    if (file) handleDocFile(file)
  })
  let dragDepth = 0
  panel?.addEventListener('dragenter', (e) => {
    if (S.current !== 'reading') return
    const zone = e.target instanceof Element ? e.target.closest('.upload-zone') : null
    if (!zone) return
    e.preventDefault()
    dragDepth += 1
    zone.classList.add('is-drag')
  })
  panel?.addEventListener('dragover', (e) => {
    if (S.current !== 'reading') return
    const zone = e.target instanceof Element ? e.target.closest('.upload-zone') : null
    if (!zone) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    zone.classList.add('is-drag')
  })
  panel?.addEventListener('dragleave', (e) => {
    if (S.current !== 'reading') return
    const zone = e.target instanceof Element ? e.target.closest('.upload-zone') : null
    if (!zone) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) zone.classList.remove('is-drag')
  })
  panel?.addEventListener('drop', (e) => {
    if (S.current !== 'reading') return
    const zone = e.target instanceof Element ? e.target.closest('.upload-zone') : null
    if (!zone) return
    e.preventDefault()
    dragDepth = 0
    zone.classList.remove('is-drag')
    const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null
    if (file) handleDocFile(file)
  })
  // 面板内通用 🔊（data-speak）：阅读讲解的重点词/题目朗读
  panel?.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('[data-speak]') : null
    if (!target || S.current !== 'reading') return
    const text = target.getAttribute('data-speak') || ''
    if (text) {
      e.preventDefault()
      ctx.speak(text)
    }
  })
}

/** 当前模式 id。 */
export function getMode() {
  return S.current
}

/**
 * 切换模式（更新 Tab、面板、Dock、字幕与舞台提示）。
 * @param {'free'|'vocab'|'pronounce'|'roleplay'} mode
 * @param {{silent?:boolean}} [opts] silent=true 时开场白不朗读（首屏静默）
 */
export function switchMode(mode, opts = {}) {
  if (!MODE_META[mode]) mode = 'free'
  S.current = mode
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    const active = tab.getAttribute('data-mode') === mode
    tab.classList.toggle('is-active', active)
    tab.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  const showedOpener = ensureModeReady(mode, opts)
  render()
  applyBaseCaption(mode, showedOpener)
  const scroller = document.getElementById('panel-scroll')
  if (scroller) scroller.scrollTop = 0
}

/** 内容/设置变化后刷新面板（例如首次 loadAll 完成）。 */
export function refresh() {
  if (!ctx) return
  ensureModeReady(S.current, { silent: true, force: false })
  render()
}

/**
 * 首次进入模式的填充动作。
 * @param {string} mode
 * @param {{silent?:boolean, force?:boolean}} [opts]
 */
function ensureModeReady(mode, opts = {}) {
  if (mode === 'free') return ensureFree(opts)
  if (mode === 'vocab') { ensureVocab(); return false }
  if (mode === 'pronounce') { ensurePronounce(); return false }
  if (mode === 'roleplay') { ensureRoleplay(opts); return false }
  if (mode === 'reading') { ensureReading(); return false }
  return false
}

/* v1.1 自由对话：数字外国朋友（无话题门槛） */

/** content.openers.free 缺失时的本地兜底开场白。 */
const FALLBACK_OPENERS = [
  "Hey! Good to see you 😊 How's your day been so far?",
  "Hi! I just made a cup of tea and I'm all ears — what's on your mind today?",
  "Hey there! I had such a busy morning. What about you — how are you feeling today?",
  "Hi! Tell me one interesting thing that happened to you today.",
  "Hey! Let's just chat like friends today — no topics, no pressure. What's up?",
  "Hello! I'm in a pretty good mood today. How about you?",
  "Hey, welcome back! Did anything make you smile today?",
  "Hi! Take your time, there's no pressure here. Tell me anything — your day, your plans, or something on your mind.",
]

/** content.icebreakers 缺失时的本地兜底聊天灵感。 */
const FALLBACK_INSPIRATIONS = [
  { label: '今天过得怎么样', en: 'Today was quite a day for me — let me tell you about it.' },
  { label: '最近在忙什么', en: "These days I've been really busy with work and study." },
  { label: '周末打算', en: "I'm thinking about my weekend plans, but I haven't decided yet." },
  { label: '吐槽一下', en: 'Something annoying happened to me today and I need to vent a little.' },
  { label: '推荐一部电影', en: 'I watched a really good movie recently and I want to talk about it.' },
  { label: '聊聊美食', en: "I've been thinking about my favorite food a lot lately." },
  { label: '旅行计划', en: "I'd love to travel somewhere new this year." },
  { label: '工作/学习压力', en: "I'm feeling a bit stressed about work and I need to talk about it." },
  { label: '兴趣爱好', en: 'In my free time I really enjoy doing something creative.' },
  { label: '天气', en: "The weather has been so strange lately — what's it like where you are?" },
  { label: '最近的小确幸', en: 'A small thing made me really happy this week.' },
  { label: '聊聊家人朋友', en: 'I spent some time with my family and friends recently.' },
]

/**
 * 归一化一条开场白（后端可能是字符串，也可能是 {en,zh}）。
 * @param {any} item
 * @returns {{en:string, zh:string}|null}
 */
function normalizeOpenerItem(item) {
  if (typeof item === 'string') {
    const text = item.trim()
    return text ? { en: text, zh: '' } : null
  }
  if (item && typeof item === 'object') {
    const en = String(item.en || item.text || item.opener || '').trim()
    const zh = String(item.zh || item.label || '').trim()
    if (!en && !zh) return null
    return { en: en || zh, zh }
  }
  return null
}

/**
 * 归一化一条聊天灵感（SPEC：{label,en}，兼容纯字符串）。
 * @param {any} item
 * @returns {{label:string, en:string}|null}
 */
function normalizeInspiration(item) {
  if (typeof item === 'string') {
    const label = item.trim()
    if (!label) return null
    const isChinese = /[\u4e00-\u9fa5]/.test(label)
    return { label, en: isChinese ? '' : label }
  }
  if (item && typeof item === 'object') {
    const label = String(item.label || item.zh || item.title || '').trim()
    const en = String(item.en || item.text || item.prompt || '').trim()
    if (!label && !en) return null
    return { label: label || en, en }
  }
  return null
}

/** 当前可用的开场白列表（服务端优先，本地兜底）。 */
function freeOpeners() {
  const content = ctx.getContent() || {}
  const raw = content.openers && Array.isArray(content.openers.free) ? content.openers.free : []
  const list = raw.map(normalizeOpenerItem).filter(Boolean)
  if (list.length) return list
  return FALLBACK_OPENERS.map((en) => ({ en, zh: '' }))
}

/** 当前可用的聊天灵感列表（服务端优先，本地兜底）。 */
function freeInspirations() {
  const content = ctx.getContent() || {}
  const raw = Array.isArray(content.icebreakers) ? content.icebreakers : []
  const list = raw.map(normalizeInspiration).filter(Boolean)
  return list.length ? list : FALLBACK_INSPIRATIONS.slice()
}

/** 随机挑一条开场白（尽量不与上一条重复）。 */
function pickFreeOpener() {
  const list = freeOpeners()
  if (!list.length) return { en: "Hey! I'm Ava. What's on your mind today?", zh: '' }
  if (list.length === 1) {
    S.free.lastOpener = list[0].en
    return list[0]
  }
  let item = list[Math.floor(Math.random() * list.length)]
  let guard = 0
  while (item.en === S.free.lastOpener && guard < 10) {
    item = list[Math.floor(Math.random() * list.length)]
    guard += 1
  }
  S.free.lastOpener = item.en
  return item
}

/**
 * 进入 free 模式：不再选话题，首次进入直接用朋友式开场白。
 * @param {{silent?:boolean}} [opts]
 * @returns {boolean} 是否已经展示开场白
 */
function ensureFree(opts = {}) {
  const firstEnter = !S.free.started
  S.free.started = true
  ctx.setStageChip('💬', '自由对话 · 想聊什么就聊什么')
  if (firstEnter) {
    const opener = pickFreeOpener()
    if (opener && opener.en) {
      ctx.showTeacherText(opener.en, { speak: !opts.silent })
      return true
    }
  }
  return false
}

/**
 * 开始新一轮自由对话（总结弹窗点「继续聊」后由 main.js 调用）：
 * 历史/字幕由 main.js 清空，这里只重置面板并展示新开场白。
 */
export function startNewFreeRound() {
  if (!ctx) return
  if (S.current !== 'free') {
    switchMode('free', { silent: false })
    return
  }
  S.free.started = false
  S.free.hintOpen = false
  S.free.inspireOffset = Math.floor(Math.random() * Math.max(1, freeInspirations().length))
  ensureFree({ silent: false })
  render()
}

function ensureVocab() {
  const content = ctx.getContent() || {}
  const topics = Array.isArray(content.vocabTopics) ? content.vocabTopics : []
  if (!topics.length) return
  if (!S.vocab.topicId || !topics.some((t) => t.id === S.vocab.topicId)) {
    S.vocab.topicId = topics[0].id
    S.vocab.index = 0
    S.vocab.quiz = null
    S.vocab.flipped = false
  }
  if (S.vocab.reviewing && !S.vocab.reviewQueue.length) buildReviewQueue()
}

function ensurePronounce() {
  const content = ctx.getContent() || {}
  const banks = Array.isArray(content.sentenceBanks) ? content.sentenceBanks : []
  if (!banks.length) return
  if (!S.pronounce.bankId || !banks.some((b) => b.id === S.pronounce.bankId)) {
    S.pronounce.bankId = banks[0].id
    S.pronounce.index = 0
    S.pronounce.result = null
  }
  syncPronounceCaption()
}

function ensureRoleplay(opts = {}) {
  const content = ctx.getContent() || {}
  const list = Array.isArray(content.scenarios) ? content.scenarios : []
  if (!list.length) return
  if (!S.roleplay.scenarioId) {
    const defaults = content.defaults || {}
    S.roleplay.scenarioId = (list.find((s) => s.id === defaults.scenarioId) || list[0]).id
  }
}

function syncPronounceCaption() {
  const s = currentSentence()
  if (!s) {
    ctx.clearCaptionTarget()
    return
  }
  ctx.setCaptionTarget({ en: s.en, zh: s.zh })
  const res = S.pronounce.results[s.en]
  ctx.setCaptionScore(res && Array.isArray(res.words) ? res.words : null)
}

/**
 * 模式切换后的基础字幕/提示。
 * @param {string} mode
 * @param {boolean} showedOpener 是否刚刚写入老师开场白（是则不要覆盖字幕）
 */
function applyBaseCaption(mode, showedOpener) {
  if (mode === 'free') {
    ctx.setMicHint('点击麦克风开始说英语 · 也可按空格')
    if (!showedOpener) ctx.setCaptionPlaceholder('点麦克风，想聊什么都可以')
  } else if (mode === 'vocab') {
    ctx.setMicHint('点击麦克风，跟读当前单词')
    ctx.setCaptionPlaceholder('先点 🔊 听发音，再点麦克风跟读单词')
  } else if (mode === 'pronounce') {
    ctx.setMicHint('点击麦克风，跟读当前句子')
    syncPronounceCaption()
  } else if (mode === 'roleplay') {
    ctx.setMicHint('点击麦克风，继续说英语')
    ctx.setCaptionPlaceholder(S.roleplay.started ? '继续和 Ava 用英语对话吧' : '先在右侧选一个场景，开始角色扮演')
  } else if (mode === 'reading') {
    ctx.setMicHint(S.reading.doc && S.reading.doc.id ? '点击麦克风，用英文回答或提问' : '先上传英文材料，再和 Ava 讨论')
    ctx.setCaptionPlaceholder(
      S.reading.doc && S.reading.doc.id
        ? '点「开始讲解」，Ava 会用英文带你读这份材料'
        : '上传一份英文文档或图片，Ava 会先读懂它，再带你精读',
    )
  }
}

/* -------------------------------------------------------------------------- */
/* 渲染                                                                        */
/* -------------------------------------------------------------------------- */

function render() {
  renderPanel()
  renderDockActions()
  syncStageChip()
  const tasks = afterRender
  afterRender = []
  if (tasks.length) requestAnimationFrame(() => tasks.forEach((fn) => fn()))
}

function renderPanel() {
  const host = document.getElementById('mode-panel')
  if (!host) return
  const mode = S.current
  host.innerHTML =
    mode === 'free'
      ? renderFree()
      : mode === 'vocab'
        ? renderVocab()
        : mode === 'pronounce'
          ? renderPronounce()
          : mode === 'reading'
            ? renderReading()
            : renderRoleplay()
}

/** 舞台顶部胶囊：随模式显示当前焦点（free=话题 / vocab=词库 / pronounce=句库 / roleplay=场景）。 */
function syncStageChip() {
  if (!ctx) return
  if (S.current === 'free') {
    ctx.setStageChip('💬', '自由对话 · 想聊什么就聊什么')
    return
  }
  if (S.current === 'vocab') {
    const topic = currentTopic()
    ctx.setStageChip(topic && topic.emoji ? topic.emoji : '📘', topic ? `单词闯关 · ${topic.name || ''}` : '单词闯关')
    return
  }
  if (S.current === 'pronounce') {
    const bank = currentBank()
    ctx.setStageChip('🎙', bank ? `跟读打分 · ${bank.name || ''}` : '跟读打分')
    return
  }
  if (S.current === 'reading') {
    const doc = S.reading.doc
    ctx.setStageChip('📄', doc && doc.id ? `阅读讲解 · ${doc.name}` : '阅读讲解 · 上传英文材料')
    return
  }
  const scenario = currentScenario()
  if (S.roleplay.started && scenario) {
    ctx.setStageChip(scenario.emoji || '🎭', `${scenario.name || '角色扮演'} · 目标 ${(scenario.objectives || []).length}`)
  } else {
    ctx.setStageChip('🎭', '角色扮演 · 选择场景')
  }
}

/**
 * 把右栏滚动到指定元素（面板内动作后的可见性保障）。
 * @param {string} selector
 * @param {number} [offset=74]
 */
function scrollPanelTo(selector, offset = 74) {
  const scroller = document.getElementById('panel-scroll')
  const target = document.querySelector(selector)
  if (!scroller || !target) return
  setTimeout(() => {
    try {
      scroller.scrollTo({ top: Math.max(0, target.offsetTop - offset), behavior: 'smooth' })
    } catch {
      /* 忽略 */
    }
  }, 60)
}

function renderDockActions() {
  const host = document.getElementById('dock-left')
  if (!host) return
  const actions = dockActions()
  host.innerHTML = actions
    .map(
      (a) =>
        `<button type="button" class="dock-action ${a.cls || ''}" data-dock="${esc(a.act)}" title="${esc(a.title)}">${icon(a.icon)}<span class="da-label">${esc(a.label)}</span></button>`,
    )
    .join('')
}

function dockActions() {
  if (S.current === 'free') {
    return [
      { act: 'free-hint', icon: 'bulb', label: '中文提示', title: '看中文提示与常用句型' },
      { act: 'free-end', icon: 'trophy', label: '结束并总结', title: '结束这次对话，让 Ava 整理总结与重点单词', cls: 'warm' },
    ]
  }
  if (S.current === 'vocab') {
    const actions = [
      { act: 'vocab-prev', icon: 'chevron-left', label: '上一个', title: '上一个单词' },
      { act: 'vocab-next', icon: 'chevron-right', label: '下一个', title: '下一个单词' },
    ]
    if (!S.vocab.reviewing) {
      const due = Number((ctx.getProgress() || {}).dueCount) || 0
      if (due > 0) actions.push({ act: 'vocab-review', icon: 'refresh', label: `复习 ${due}`, title: `复习 ${due} 个到期单词`, cls: 'warm' })
    }
    return actions
  }
  if (S.current === 'pronounce') {
    return [
      { act: 'pron-listen', icon: 'volume', label: '听原句', title: '听 Ava 读一遍原句' },
      { act: 'pron-next', icon: 'chevron-right', label: '下一句', title: '跟读下一句' },
    ]
  }
  if (S.current === 'reading') {
    const actions = []
    if (S.reading.doc && S.reading.doc.id && S.reading.analysis) {
      actions.push({ act: 'reading-read', icon: 'volume', label: '朗读原文', title: '朗读原文（或建议朗读片段）' })
      actions.push({ act: 'reading-next', icon: 'chevron-right', label: '下一题', title: '让 Ava 问下一道理解题' })
    }
    return actions
  }
  if (S.roleplay.ended || S.roleplay.summary) {
    return [
      { act: 'rp-restart', icon: 'refresh', label: '再来一次', title: '重新开始当前场景' },
      { act: 'rp-change', icon: 'theater', label: '换场景', title: '选择其它场景' },
    ]
  }
  return [
    { act: 'rp-end', icon: 'trophy', label: '结束并总结', title: '结束角色扮演并查看小结', cls: 'warm' },
    { act: 'rp-change', icon: 'refresh', label: '换场景', title: '重新选择场景' },
  ]
}

/* ------------------------------- 自由对话 --------------------------------- */

function renderFree() {
  const settings = ctx.getSettings() || {}
  const level = settings.level || 'A2'
  const head = `
    <div class="mp-head">
      <div>
        <div class="mp-eyebrow">${MODE_META.free.eyebrow}</div>
        <h2 class="mp-title">${MODE_META.free.title}</h2>
        <p class="mp-sub">Ava 是你的数字外国朋友：不限定话题，想聊什么就聊什么，说错也没关系。</p>
      </div>
      <span class="mp-badge">${esc(level)}</span>
    </div>`
  const inspirations = freeInspirations()
  const start = S.free.inspireOffset % Math.max(1, inspirations.length)
  const picks = []
  for (let i = 0; i < Math.min(4, inspirations.length); i++) {
    picks.push(inspirations[(start + i) % inspirations.length])
  }
  const chipHtml = picks
    .map((item) => {
      const label = item.label || item.en || ''
      const fill = item.en || ''
      const sub = item.en && item.label && item.en !== item.label ? item.en : ''
      return `<button type="button" class="inspire-chip" data-act="free-inspire" data-fill="${esc(fill)}" data-label="${esc(label)}" title="${esc(sub || label)}">
        <b>${esc(label)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}
      </button>`
    })
    .join('')
  const hint = S.free.hintOpen ? renderHint() : ''
  return `<div class="mp">
    ${head}
    <div class="card free-hero">
      <div class="free-hero-top">
        <span class="focus-emoji">🌍</span>
        <div>
          <div class="focus-title">想聊什么就聊什么</div>
          <div class="focus-sub">工作、天气、追剧、烦恼……中英夹着说也可以，Ava 会接住你的话。</div>
        </div>
      </div>
      <div class="section-label">${icon('sparkles')}聊天灵感<span class="spacer">点一下自动填入输入框</span></div>
      <div class="inspire-grid">${chipHtml || '<p class="free-tip">直接说一句英文开始吧。</p>'}</div>
      <div class="chips">
        <button type="button" class="chip" data-act="free-inspire-more">${icon('refresh')}换一个灵感</button>
        <button type="button" class="chip" data-act="free-hint">${icon('bulb')}中文提示</button>
      </div>
      ${hint}
      <button type="button" class="btn btn-block btn-ghost free-end-btn" data-act="free-end">
        ${icon('trophy')}结束对话并总结
      </button>
      <p class="free-tip">聊 2 轮以上就能总结：Ava 会整理话题、亮点、纠错和重点单词，并自动收进<b>今日单词表</b>。</p>
      <p class="free-tip">听不懂或不会说时，直接说/打字用中文，或点麦克风旁的<b>「中文求助」</b>，Ava 会教你怎么用英文表达。</p>
    </div>
  </div>`
}

function renderHint() {
  const patterns = [
    "I'd like to ... / I usually ...",
    'In my opinion, ... / I think ...',
    'Something happened today, so I ...',
    'Could you tell me more about ...?',
    'What about you? / How about you?',
  ]
  return `
    <div class="hint-box">
      <div class="hint-title">${icon('bulb')}中文提示</div>
      <p>不知道怎么开口？用一两句简单英文说说今天发生了什么，Ava 会顺着你的话继续聊。</p>
      <div class="section-label" style="margin-top:2px">可以用这些句型</div>
      <ul class="hint-sentences">${patterns.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <p style="font-size:11px">不会说某个词？直接说中文关键词，让 Ava 教你英文说法；中英夹着说也没关系。</p>
    </div>`
}

/* ------------------------------- 单词闯关 --------------------------------- */

function allVocabWords() {
  const content = ctx.getContent() || {}
  const topics = Array.isArray(content.vocabTopics) ? content.vocabTopics : []
  const list = []
  for (const t of topics) {
    const words = t && Array.isArray(t.words) ? t.words : []
    for (const w of words) if (w && w.word) list.push({ ...w, topicId: t.id, topicName: t.name, emoji: t.emoji })
  }
  return list
}

function currentTopic() {
  const content = ctx.getContent() || {}
  const topics = Array.isArray(content.vocabTopics) ? content.vocabTopics : []
  return topics.find((t) => t.id === S.vocab.topicId) || topics[0] || null
}

function topicWords() {
  const topic = currentTopic()
  return topic && Array.isArray(topic.words) ? topic.words.filter((w) => w && w.word) : []
}

function currentWord() {
  if (S.vocab.reviewing) return S.vocab.reviewQueue[S.vocab.reviewIndex] || null
  const words = topicWords()
  return words[S.vocab.index] || words[0] || null
}

function buildReviewQueue() {
  const progress = ctx.getProgress() || {}
  const due = Array.isArray(progress.dueWords) ? progress.dueWords.slice(0, 20) : []
  const meta = ctx.getWordMeta() || {}
  const all = allVocabWords()
  const queue = due.map((entry) => {
    const word = typeof entry === 'string' ? entry : entry && entry.word
    const found = all.find((w) => String(w.word).toLowerCase() === String(word).toLowerCase())
    if (found) return found
    const info = meta[String(word).toLowerCase()] || {}
    return { word, meaning: info.meaning || '待复习生词', phonetic: info.phonetic || '', example: info.example || '' }
  })
  S.vocab.reviewQueue = queue
  S.vocab.reviewIndex = 0
  S.vocab.reviewDone = queue.length === 0
  S.vocab.quiz = null
  S.vocab.score = null
  S.vocab.flipped = false
}

/**
 * 从进度弹窗入口开启 SRS 到期复习。
 * @returns {boolean} 是否有可复习单词
 */
export function openSrsReview() {
  const progress = ctx.getProgress() || {}
  const due = Number(progress.dueCount) || (Array.isArray(progress.dueWords) ? progress.dueWords.length : 0)
  if (!due) {
    toast('暂时没有到期的生词，继续和 Ava 聊天攒生词吧', 'info')
    return false
  }
  buildReviewQueue()
  if (!S.vocab.reviewQueue.length) {
    toast('没有找到可复习的单词', 'info')
    return false
  }
  S.vocab.reviewing = true
  S.vocab.reviewDone = false
  switchMode('vocab')
  toast(`开始复习 ${S.vocab.reviewQueue.length} 个生词`, 'info')
  return true
}

function ensureQuiz(force = false) {
  const w = currentWord()
  if (!w) {
    S.vocab.quiz = null
    return
  }
  if (!force && S.vocab.quiz && S.vocab.quiz.word === w.word && S.vocab.quiz.kind === S.vocab.quizKind) return
  if (S.vocab.quizKind === 'spell') {
    S.vocab.quiz = { word: w.word, kind: 'spell', answered: false, correct: false, answer: w.word }
    return
  }
  const pool = allVocabWords().filter((x) => String(x.word).toLowerCase() !== String(w.word).toLowerCase() && x.meaning)
  const meanings = new Set([String(w.meaning || '')])
  while (meanings.size < 4 && pool.length) {
    const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]
    if (pick.meaning) meanings.add(String(pick.meaning))
  }
  const options = Array.from(meanings)
    .filter(Boolean)
    .sort(() => Math.random() - 0.5)
    .slice(0, 4)
  S.vocab.quiz = { word: w.word, kind: 'choice', answered: false, correct: false, options, answer: String(w.meaning || '') }
}

function renderVocab() {
  const content = ctx.getContent() || {}
  const topics = Array.isArray(content.vocabTopics) ? content.vocabTopics : []
  const settings = ctx.getSettings() || {}
  if (!topics.length) return `<div class="mp">${vocabHead(settings)}${emptyContent()}</div>`
  const topic = currentTopic()
  const words = topicWords()
  const w = currentWord()
  const inReview = S.vocab.reviewing
  const total = inReview ? S.vocab.reviewQueue.length : words.length
  const pos = inReview ? Math.min(S.vocab.reviewIndex + 1, total) : Math.min(S.vocab.index + 1, total)
  if (S.vocab.reviewing && S.vocab.reviewDone) return `<div class="mp">${vocabHead(settings)}${renderReviewSummary()}</div>`
  if (!w) return `<div class="mp">${vocabHead(settings)}${emptyContent()}</div>`
  ensureQuiz()
  const quiz = S.vocab.quiz
  const topicChips = inReview
    ? `<div class="srs-banner">
        <div class="srs-text"><strong>SRS 复习中 ${pos}/${total}</strong>答对的词会进入更长的复习间隔，答错回到第一盒。</div>
        <button type="button" class="btn btn-mini" data-act="vocab-review-exit">退出复习</button>
      </div>`
    : `<div class="chips-scroll">${topics
        .map(
          (t) =>
            `<button type="button" class="chip ${t.id === S.vocab.topicId ? 'is-active' : ''}" data-act="vocab-topic" data-id="${esc(t.id)}">${esc(t.emoji || '📘')} ${esc(t.name || '')}</button>`,
        )
        .join('')}</div>`
  const dots = total > 1
    ? `<div class="word-progress">${Array.from({ length: Math.min(total, 12) })
        .map((_, i) => {
          const idx = total > 12 ? Math.round((i * (total - 1)) / 11) : i
          const cls = idx === pos - 1 ? 'is-current' : idx < pos - 1 ? 'is-done' : ''
          return `<span class="word-dot ${cls}"></span>`
        })
        .join('')}<span class="word-count">${pos}/${total}</span></div>`
    : ''
  const scoreLine = S.vocab.score
    ? `<div class="inline-score">${icon('headphones')}<span>跟读得分</span><b>${esc(S.vocab.score.score)}</b><span class="score-stars">${renderStars(S.vocab.score.stars)}</span><span style="color:var(--faint)">${esc((S.vocab.score.tips_zh || [])[0] || '')}</span></div>`
    : ''
  const card = `
    <div class="word-stage">
      <div class="word-card ${S.vocab.flipped ? 'is-flipped' : ''}" data-act="vocab-flip" role="button" tabindex="0" aria-label="翻转单词卡">
        <div class="word-face word-front">
          <div class="word-big">${esc(w.word)}</div>
          <div class="phonetic">${esc(w.phonetic || '')}</div>
          <div class="word-actions" data-stop="1">
            <button type="button" class="icon-action" data-act="vocab-say" title="听发音">${icon('volume')}</button>
            <button type="button" class="icon-action" data-act="vocab-read" title="跟读评分">${icon('mic')}</button>
            <button type="button" class="icon-action" data-act="vocab-flip" title="看释义">${icon('refresh')}</button>
            <button type="button" class="icon-action" data-act="vocab-add" title="加入词库">${icon('plus')}</button>
          </div>
          ${dots}
          <span class="word-flip-hint">${icon('refresh')}点卡片翻面看释义</span>
        </div>
        <div class="word-face word-back">
          <div class="word-meaning">${esc(w.meaning || '')}</div>
          ${w.example ? `<p class="word-example">${esc(w.example)}</p>` : ''}
          ${w.exampleZh ? `<p class="word-example-zh">${esc(w.exampleZh)}</p>` : ''}
          <div class="word-actions">
            <button type="button" class="icon-action" data-act="vocab-say" title="听发音">${icon('volume')}</button>
            <button type="button" class="btn btn-mini" data-act="vocab-flip">${icon('refresh')}看单词</button>
          </div>
        </div>
      </div>
    </div>
    ${scoreLine}
    ${renderQuiz(quiz, w)}`
  return `<div class="mp">${vocabHead(settings)}${topicChips}${card}</div>`
}

function vocabHead(settings) {
  const due = Number((ctx.getProgress() || {}).dueCount) || 0
  return `
    <div class="mp-head">
      <div>
        <div class="mp-eyebrow">${MODE_META.vocab.eyebrow}</div>
        <h2 class="mp-title">${MODE_META.vocab.title}</h2>
        <p class="mp-sub">听发音、跟读打分，再做选择题和拼写；答错会自动加入错词本。</p>
      </div>
      <span class="mp-badge violet">${settings.level ? esc(settings.level) : 'A2'}${due ? ` · 待复习 ${due}` : ''}</span>
    </div>`
}

function renderQuiz(quiz, word) {
  if (!quiz) return ''
  const kindChips = `
    <div class="chips">
      <button type="button" class="chip ${quiz.kind === 'choice' ? 'is-active' : ''}" data-act="vocab-quiz-kind" data-kind="choice">${icon('check-circle')}选择题</button>
      <button type="button" class="chip ${quiz.kind === 'spell' ? 'is-active' : ''}" data-act="vocab-quiz-kind" data-kind="spell">${icon('keyboard')}拼写</button>
    </div>`
  if (quiz.kind === 'choice') {
    const opts = (quiz.options || [])
      .map((text, i) => {
        let cls = ''
        if (quiz.answered) {
          if (text === quiz.answer) cls = 'is-correct'
          else if (i === quiz.chosen && !quiz.correct) cls = 'is-wrong'
          else cls = 'is-dim'
        }
        return `<button type="button" class="quiz-opt ${cls}" data-act="vocab-answer" data-i="${i}" ${quiz.answered ? 'disabled' : ''}>
          <span>${esc(text)}</span>${icon(quiz.answered && text === quiz.answer ? 'check' : 'x')}
        </button>`
      })
      .join('')
    return `
      <div class="quiz-card">
        <div class="quiz-head"><span class="quiz-kind">轻松测验 · 选择题</span><span class="mp-badge violet">${esc(word.word)}</span></div>
        <p class="quiz-q">「<b>${esc(word.word)}</b>」的中文意思是？</p>
        <div class="quiz-opts">${opts}</div>
        ${quizFeedback(quiz, word)}
      </div>`
  }
  const hint = quiz.answered && !quiz.correct ? `<div class="spell-clue">正确答案：${esc(quiz.answer)}</div>` : ''
  return `
    <div class="quiz-card">
      <div class="quiz-head"><span class="quiz-kind">拼写挑战</span><span class="mp-badge violet">${esc(word.meaning || '')}</span></div>
      <p class="quiz-q">根据释义拼出英文单词（${esc(word.meaning || '')}）</p>
      ${quiz.answered && quiz.correct ? '' : `<div class="spell-row">
        <input type="text" class="input spell-input" id="vocab-spell" placeholder="输入英文单词…" autocomplete="off" autocapitalize="off" spellcheck="false" value="${quiz.answered ? esc('') : ''}">
        <button type="button" class="btn btn-primary" data-act="vocab-spell-check">检查</button>
      </div>`}
      ${hint}
      ${quizFeedback(quiz, word)}
    </div>`
}

function quizFeedback(quiz, word) {
  if (!quiz || !quiz.answered) return ''
  if (quiz.correct) {
    return `<div class="quiz-feedback ok">${icon('check-circle')} 回答正确！这个词你记得很牢。</div>
      <div class="chips"><button type="button" class="chip is-active" data-act="vocab-next">${icon('chevron-right')}下一个单词</button></div>`
  }
  return `<div class="quiz-feedback bad">${icon('alert')} 正确答案是「${esc(quiz.answer)}」。已加入错词本，之后会安排复习。</div>
    <div class="chips">
      <button type="button" class="chip" data-act="vocab-retry">${icon('refresh')}再试一次</button>
      <button type="button" class="chip is-active" data-act="vocab-next">${icon('chevron-right')}下一个单词</button>
    </div>`
}

function renderReviewSummary() {
  return `
    <div class="summary-card">
      <div class="summary-title">${icon('trophy')}复习完成</div>
      <div class="summary-stats">
        <div class="summary-stat"><strong>${S.vocab.reviewIndex}</strong><span>复习单词</span></div>
        <div class="summary-stat"><strong>${S.vocab.reviewQueue.length}</strong><span>本轮总数</span></div>
        <div class="summary-stat"><strong>+1</strong><span>记忆盒</span></div>
      </div>
      <p class="summary-comment">答对的单词进入了更长的复习间隔，坚持每天复习效果最好。</p>
      <div class="summary-actions">
        <button type="button" class="btn btn-primary" data-act="vocab-back-topic">${icon('book')}回到词卡</button>
        <button type="button" class="btn btn-ghost" data-act="vocab-review-again">${icon('refresh')}再复习一轮</button>
      </div>
    </div>`
}

/* ------------------------------- 跟读打分 --------------------------------- */

function currentBank() {
  const content = ctx.getContent() || {}
  const banks = Array.isArray(content.sentenceBanks) ? content.sentenceBanks : []
  return banks.find((b) => b.id === S.pronounce.bankId) || banks[0] || null
}

function currentSentence() {
  const bank = currentBank()
  const list = bank && Array.isArray(bank.sentences) ? bank.sentences : []
  return list[S.pronounce.index] || list[0] || null
}

function renderPronounce() {
  const content = ctx.getContent() || {}
  const banks = Array.isArray(content.sentenceBanks) ? content.sentenceBanks : []
  const settings = ctx.getSettings() || {}
  const head = `
    <div class="mp-head">
      <div>
        <div class="mp-eyebrow">${MODE_META.pronounce.eyebrow}</div>
        <h2 class="mp-title">${MODE_META.pronounce.title}</h2>
        <p class="mp-sub">选一句英文，点麦克风跟读，Ava 逐词打分并给出中文发音提示。</p>
      </div>
      <span class="mp-badge">${esc(settings.level || 'A2')}</span>
    </div>`
  if (!banks.length) return `<div class="mp">${head}${emptyContent()}</div>`
  const bank = currentBank()
  const sentences = bank && Array.isArray(bank.sentences) ? bank.sentences : []
  const s = currentSentence()
  const bankChips = `<div class="bank-chips">${banks
    .map(
      (b) =>
        `<button type="button" class="chip ${b.id === S.pronounce.bankId ? 'is-active' : ''}" data-act="pron-bank" data-id="${esc(b.id)}">${esc(b.name || b.id)}</button>`,
    )
    .join('')}</div>`
  const list = sentences
    .map((item, i) => {
      const res = S.pronounce.results[item.en]
      const badge = res ? `<span class="box-pill ${res.score >= 80 ? '' : 'due'}" style="margin-left:auto">${res.score}</span>` : ''
      return `<button type="button" class="sentence-item ${i === S.pronounce.index ? 'is-active' : ''} ${res ? 'is-done' : ''}" data-act="pron-sentence" data-i="${i}">
        <span class="s-idx">${i + 1}</span>
        <span class="s-body"><span class="s-en">${esc(item.en)}</span><span class="s-zh">${esc(item.zh || '')}</span></span>
        ${badge}
      </button>`
    })
    .join('')
  const result = S.pronounce.result
  const scoreCard = result ? renderScoreCard(result, s) : `<div class="empty-state">${icon('mic')}<strong>还没有评分</strong><span>点屏幕下方的大麦克风，读完这句英文。</span></div>`
  return `<div class="mp">${head}${bankChips}<div class="section-label">${icon('headphones')}选择句子<span class="spacer">${esc(bank.desc || '')}</span></div><div class="sentence-list">${list}</div>${scoreCard}</div>`
}

function renderScoreCard(result, sentence) {
  const score = Number(result.score) || 0
  const stars = Number(result.stars) || Math.max(1, Math.round(score / 20))
  const words = Array.isArray(result.words) ? result.words : []
  const tips = Array.isArray(result.tips_zh) ? result.tips_zh : []
  const wordChips = words
    .map((w) => `<span class="w-chip ${w.status === 'ok' ? 'ok' : w.status === 'close' ? 'close' : 'miss'}" title="${w.status === 'ok' ? '发音清晰' : w.status === 'close' ? '接近正确' : '没听到'}">${esc(w.text)}</span>`)
    .join('')
  const history = Object.values(S.pronounce.results)
    .slice(-6)
    .map((r) => {
      const cls = r.score >= 80 ? 'good' : r.score >= 60 ? 'mid' : 'bad'
      return `<span class="hist-dot ${cls}" title="${esc(r.score)} 分">${esc(r.score)}</span>`
    })
    .join('')
  return `
    <div class="score-card">
      <div class="score-top">
        <div class="score-ring" style="--p:${Math.max(0, Math.min(100, score))}">
          <span class="score-num">${score}<small>分</small></span>
        </div>
        <div class="score-meta">
          <div class="score-stars">${renderStars(stars)}</div>
          <div class="score-caption">${score >= 85 ? '非常接近母语者，继续保持！' : score >= 70 ? '整体不错，注意标红的词。' : score >= 50 ? '能听懂，再放慢一点会更清楚。' : '别急，先点「听原句」再跟读一次。'}</div>
          ${history ? `<div class="score-history">${history}</div>` : ''}
        </div>
      </div>
      <div class="section-label">${icon('target')}逐词评分</div>
      <div class="word-status">${wordChips || '<span class="muted" style="font-size:11px">没有逐词结果</span>'}</div>
      ${tips.length ? `<ul class="tips-list">${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${sentence ? `<div class="chips"><button type="button" class="chip" data-act="pron-listen">${icon('volume')}听原句</button><button type="button" class="chip is-active" data-act="pron-next">${icon('chevron-right')}下一句</button></div>` : ''}
    </div>`
}

/* ------------------------------- 角色扮演 --------------------------------- */

function currentScenario() {
  const content = ctx.getContent() || {}
  const list = Array.isArray(content.scenarios) ? content.scenarios : []
  return list.find((s) => s.id === S.roleplay.scenarioId) || list[0] || null
}

function renderRoleplay() {
  const content = ctx.getContent() || {}
  const scenarios = Array.isArray(content.scenarios) ? content.scenarios : []
  const settings = ctx.getSettings() || {}
  const head = `
    <div class="mp-head">
      <div>
        <div class="mp-eyebrow">${MODE_ROLEPLAY_EYEBROW}</div>
        <h2 class="mp-title">${MODE_META.roleplay.title}</h2>
        <p class="mp-sub">Ava 扮演对方，你用英文完成真实场景；完成目标后会自动打勾。</p>
      </div>
      <span class="mp-badge violet">${esc(settings.level || 'A2')}</span>
    </div>`
  if (!scenarios.length) return `<div class="mp">${head}${emptyContent()}</div>`
  if (!S.roleplay.started) {
    const cards = scenarios
      .map(
        (s) => `<button type="button" class="scenario-card ${s.id === S.roleplay.scenarioId ? 'is-active' : ''}" data-act="rp-scenario" data-id="${esc(s.id)}">
          <span class="scenario-emoji">${esc(s.emoji || '🎭')}</span>
          <span class="scenario-info">
            <span class="scenario-name">${esc(s.name || '')}</span>
            <span class="scenario-desc">${esc(s.desc || '')}</span>
            ${s.role ? `<span class="scenario-role">Ava 扮演：${esc(s.role)}</span>` : ''}
          </span>
        </button>`,
      )
      .join('')
    return `<div class="mp">${head}<div class="section-label">${icon('theater')}选择场景</div><div class="scenario-grid">${cards}</div></div>`
  }
  const scenario = currentScenario()
  if (!scenario) return `<div class="mp">${head}${emptyContent()}</div>`
  const objectives = Array.isArray(scenario.objectives) ? scenario.objectives : []
  const phrases = Array.isArray(scenario.keyPhrases) ? scenario.keyPhrases : []
  const objList = objectives.length
    ? `<ul class="objectives">${objectives
        .map(
          (text, i) =>
            `<li class="objective ${S.roleplay.done.includes(i) ? 'is-done' : ''}" data-act="rp-obj" data-i="${i}" role="button" tabindex="0">
              <span class="obj-check">${icon('check')}</span><span>${esc(text)}</span>
            </li>`,
        )
        .join('')}</ul>`
    : ''
  const phraseList = phrases.length
    ? `<div class="section-label">${icon('book')}目标句<span class="spacer">点 🔊 听 Ava 读</span></div>
       <div class="objectives">${phrases
         .map(
           (p) => `<li class="objective" style="align-items:center">
             <span style="flex:1">${esc(p.en || '')}<br><span style="font-size:10px;color:var(--faint)">${esc(p.zh || '')}</span></span>
             <button type="button" class="icon-action" style="width:30px;height:30px" data-act="rp-say" data-text="${esc(p.en || '')}" title="听发音">${icon('volume')}</button>
           </li>`,
         )
         .join('')}</div>`
    : ''
  const summary = S.roleplay.summary ? renderRoleplaySummary(scenario) : ''
  const intro = `
    <div class="card focus-card">
      <div class="focus-top">
        <span class="focus-emoji">${esc(scenario.emoji || '🎭')}</span>
        <div>
          <div class="focus-title">${esc(scenario.name || '')}</div>
          <div class="focus-sub">Ava 扮演 ${esc(scenario.role || '对方')} · ${esc(scenario.hintZh || scenario.desc || '')}</div>
        </div>
      </div>
      <div class="chips">
        <button type="button" class="chip" data-act="rp-replay-opener">${icon('volume')}再听开场</button>
        <button type="button" class="chip" data-act="rp-change">${icon('refresh')}换场景</button>
      </div>
    </div>`
  return `<div class="mp">${head}${summary}${intro}<div class="section-label">${icon('target')}完成目标<span class="spacer">${S.roleplay.done.length}/${objectives.length || '—'}</span></div>${objList}${phraseList}</div>`
}

const MODE_ROLEPLAY_EYEBROW = 'ROLE-PLAY'

function renderRoleplaySummary(scenario) {
  const sum = S.roleplay.summary || {}
  const total = (scenario.objectives || []).length || 0
  const done = S.roleplay.done.length
  const ratio = total ? done / total : 0
  const comment =
    ratio >= 0.75
      ? '很流畅！目标句几乎都用上了，下次可以尝试更长的句子。'
      : ratio >= 0.4
        ? '不错，已经完成一部分目标。再练一次，试着把剩下的目标句都用上。'
        : '没关系，先看「目标句」跟着 Ava 读两遍，再完整走一遍场景。'
  return `
    <div class="summary-card">
      <div class="summary-title">${icon('trophy')}本次角色扮演小结</div>
      <div class="summary-stats">
        <div class="summary-stat"><strong>${done}/${total || 0}</strong><span>完成目标</span></div>
        <div class="summary-stat"><strong>${esc(sum.turns ?? 0)}</strong><span>对话轮次</span></div>
        <div class="summary-stat"><strong>${esc(sum.newWords ?? 0)}</strong><span>学到生词</span></div>
      </div>
      <p class="summary-comment">${esc(comment)}</p>
      <div class="summary-actions">
        <button type="button" class="btn btn-primary" data-act="rp-restart">${icon('refresh')}再来一次</button>
        <button type="button" class="btn btn-ghost" data-act="rp-change">${icon('theater')}换场景</button>
      </div>
    </div>`
}

/* -------------------------------------------------------------------------- */
/* 交互：面板                                                                  */
/* -------------------------------------------------------------------------- */

function onPanelClick(event) {
  const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
  if (!target) return
  const act = target.getAttribute('data-act')
  const isInsideStop = target.closest('[data-stop]')
  if (isInsideStop && act !== 'vocab-say' && act !== 'vocab-read' && act !== 'vocab-flip' && act !== 'vocab-add') return
  event.preventDefault()
  handleAction(act, target)
}

function handleAction(act, el) {
  switch (act) {
    /* 自由对话 */
    case 'free-hint':
      S.free.hintOpen = !S.free.hintOpen
      render()
      break
    case 'free-inspire': {
      const fill = el.getAttribute('data-fill') || ''
      const label = el.getAttribute('data-label') || ''
      if (fill) {
        ctx.fillInput(fill)
      } else {
        ctx.fillInput('')
        ctx.toast(label ? '试着用英文聊聊「' + label + '」' : '直接说一句英文开始吧', 'info', 2400)
      }
      break
    }
    case 'free-inspire-more': {
      S.free.inspireOffset = (S.free.inspireOffset + 4) % Math.max(1, freeInspirations().length)
      render()
      break
    }
    case 'free-end': {
      ctx.endConversation()
      break
    }
    /* 阅读讲解 */
    case 'reading-upload': {
      const input = document.getElementById('doc-file-input')
      if (input instanceof HTMLInputElement) input.click()
      break
    }
    case 'reading-pick': {
      const id = el.getAttribute('data-id')
      if (id) void selectReadingDoc(id)
      break
    }
    case 'reading-analyze': {
      const id = el.getAttribute('data-id') || S.reading.docId
      S.reading.scrollToAnalysis = true
      if (id) void analyzeReadingDoc(id)
      break
    }
    case 'reading-retry-list':
      void loadReadingDocs()
      break
    case 'reading-start':
      startReadingLecture()
      break
    case 'reading-read':
      readReadingAloud()
      break
    case 'reading-next':
      nextReadingQuestion()
      break
    case 'reading-del': {
      const id = el.getAttribute('data-id')
      if (!id) break
      if (S.reading.docId === id) {
        S.reading.confirmDelete = true
        render()
      } else {
        void deleteReadingDoc(id)
      }
      break
    }
    case 'reading-del-confirm': {
      const id = el.getAttribute('data-id')
      if (id) void deleteReadingDoc(id)
      break
    }
    case 'reading-del-cancel':
      S.reading.confirmDelete = false
      render()
      break
    /* 单词 */
    case 'vocab-topic': {
      const id = el.getAttribute('data-id')
      if (!id) break
      S.vocab.topicId = id
      S.vocab.index = 0
      S.vocab.quiz = null
      S.vocab.flipped = false
      S.vocab.score = null
      S.vocab.reviewing = false
      render()
      break
    }
    case 'vocab-prev':
    case 'vocab-next': {
      const dir = act === 'vocab-next' ? 1 : -1
      moveWord(dir)
      break
    }
    case 'vocab-flip': {
      S.vocab.flipped = !S.vocab.flipped
      const card = document.querySelector('.word-card')
      if (card) card.classList.toggle('is-flipped', S.vocab.flipped)
      break
    }
    case 'vocab-say': {
      const w = currentWord()
      if (w) ctx.speak(w.word)
      break
    }
    case 'vocab-read': {
      const w = currentWord()
      if (!w) break
      if (!ctx.startListening('word')) toast('当前浏览器不支持语音识别，可以直接做拼写测验', 'info')
      else toast('请跟读这个单词…', 'info', 1500)
      break
    }
    case 'vocab-add': {
      const w = currentWord()
      if (!w) break
      ctx.addWordBank([w])
      toast(`已把 ${w.word} 加入词库`, 'ok')
      break
    }
    case 'vocab-answer': {
      const i = Number(el.getAttribute('data-i'))
      answerChoice(i)
      break
    }
    case 'vocab-spell-check':
      spellCheck()
      break
    case 'vocab-quiz-kind': {
      const kind = el.getAttribute('data-kind')
      if (kind !== 'choice' && kind !== 'spell') break
      S.vocab.quizKind = kind
      ensureQuiz(true)
      render()
      break
    }
    case 'vocab-retry': {
      const w = currentWord()
      if (w) S.vocab.quiz = null
      ensureQuiz(true)
      render()
      break
    }
    case 'vocab-review': {
      openSrsReview()
      break
    }
    case 'vocab-review-exit':
    case 'vocab-back-topic': {
      S.vocab.reviewing = false
      S.vocab.reviewDone = false
      S.vocab.reviewQueue = []
      S.vocab.quiz = null
      S.vocab.score = null
      render()
      break
    }
    case 'vocab-review-again': {
      buildReviewQueue()
      S.vocab.reviewDone = false
      render()
      break
    }
    /* 跟读 */
    case 'pron-bank': {
      const id = el.getAttribute('data-id')
      if (!id) break
      S.pronounce.bankId = id
      S.pronounce.index = 0
      S.pronounce.result = null
      render()
      break
    }
    case 'pron-sentence': {
      const i = Number(el.getAttribute('data-i'))
      if (!Number.isFinite(i)) break
      S.pronounce.index = i
      const s = currentSentence()
      S.pronounce.result = s ? S.pronounce.results[s.en] || null : null
      render()
      break
    }
    case 'pron-listen': {
      const s = currentSentence()
      if (s) ctx.speak(s.en)
      break
    }
    case 'pron-next': {
      const bank = currentBank()
      const list = bank && Array.isArray(bank.sentences) ? bank.sentences : []
      if (!list.length) break
      S.pronounce.index = (S.pronounce.index + 1) % list.length
      const s = currentSentence()
      S.pronounce.result = s ? S.pronounce.results[s.en] || null : null
      render()
      break
    }
    /* 角色扮演 */
    case 'rp-scenario': {
      const id = el.getAttribute('data-id')
      if (id) startScenario(id)
      break
    }
    case 'rp-obj': {
      const i = Number(el.getAttribute('data-i'))
      if (!Number.isFinite(i)) break
      toggleObjective(i)
      break
    }
    case 'rp-say': {
      const text = el.getAttribute('data-text')
      if (text) ctx.speak(text)
      break
    }
    case 'rp-replay-opener': {
      const scenario = currentScenario()
      if (scenario && scenario.opener) ctx.speak(scenario.opener)
      break
    }
    case 'rp-end':
      endRoleplay()
      break
    case 'rp-restart':
      restartRoleplay()
      break
    case 'rp-change':
      S.roleplay.started = false
      S.roleplay.ended = false
      S.roleplay.summary = null
      S.roleplay.done = []
      render()
      break
    default:
      break
  }
}

function onDockClick(event) {
  const target = event.target instanceof Element ? event.target.closest('[data-dock]') : null
  if (!target) return
  const act = target.getAttribute('data-dock') || ''
  if (act === 'free-hint') {
    S.free.hintOpen = !S.free.hintOpen
    render()
  } else if (act === 'free-end') {
    ctx.endConversation()
  } else if (act === 'reading-read') {
    readReadingAloud()
  } else if (act === 'reading-next') {
    nextReadingQuestion()
  } else if (act === 'vocab-prev' || act === 'vocab-next') {
    moveWord(act === 'vocab-next' ? 1 : -1)
  } else if (act === 'vocab-review') {
    openSrsReview()
  } else if (act === 'pron-listen') {
    const s = currentSentence()
    if (s) ctx.speak(s.en)
  } else if (act === 'pron-next') {
    const bank = currentBank()
    const list = bank && Array.isArray(bank.sentences) ? bank.sentences : []
    if (!list.length) return
    S.pronounce.index = (S.pronounce.index + 1) % list.length
    const s = currentSentence()
    S.pronounce.result = s ? S.pronounce.results[s.en] || null : null
    render()
  } else if (act === 'rp-end') {
    endRoleplay()
  } else if (act === 'rp-restart') {
    restartRoleplay()
  } else if (act === 'rp-change') {
    S.roleplay.started = false
    S.roleplay.ended = false
    S.roleplay.summary = null
    S.roleplay.done = []
    render()
  }
}

/* -------------------------------------------------------------------------- */
/* 模式动作                                                                    */
/* -------------------------------------------------------------------------- */

function moveWord(dir) {
  if (S.vocab.reviewing) {
    const next = S.vocab.reviewIndex + dir
    if (next < 0) return
    if (next >= S.vocab.reviewQueue.length) {
      S.vocab.reviewDone = true
      S.vocab.reviewIndex = S.vocab.reviewQueue.length
      render()
      return
    }
    S.vocab.reviewIndex = next
    S.vocab.quiz = null
    S.vocab.flipped = false
    S.vocab.score = null
    render()
    return
  }
  const words = topicWords()
  if (!words.length) return
  S.vocab.index = (S.vocab.index + dir + words.length) % words.length
  S.vocab.quiz = null
  S.vocab.flipped = false
  S.vocab.score = null
  render()
}

function answerChoice(i) {
  const quiz = S.vocab.quiz
  if (!quiz || quiz.answered || quiz.kind !== 'choice') return
  const chosen = quiz.options[i]
  const correct = chosen === quiz.answer
  quiz.answered = true
  quiz.correct = correct
  quiz.chosen = i
  const word = currentWord()
  if (!word) return
  ctx.bumpProgress({ reviewWords: [{ word: word.word, correct }] })
  if (correct) {
    ctx.react('correct')
    ctx.toast('回答正确！', 'ok', 1600)
  } else {
    ctx.react('wrong')
    ctx.addWordBank([word])
    ctx.toast('已加入错词本，稍后会安排复习', 'info')
  }
  render()
  scrollPanelTo('.quiz-card', 110)
}

function spellCheck() {
  const quiz = S.vocab.quiz
  const input = document.getElementById('vocab-spell')
  if (!quiz || quiz.answered || quiz.kind !== 'spell' || !(input instanceof HTMLInputElement)) return
  const word = currentWord()
  if (!word) return
  const value = input.value.trim().toLowerCase()
  if (!value) {
    toast('先输入你记得的拼写', 'info', 1600)
    return
  }
  const answer = String(quiz.answer || word.word).toLowerCase()
  const normalize = (s) => s.replace(/[\s\-']/g, '')
  const correct = normalize(value) === normalize(answer)
  quiz.answered = true
  quiz.correct = correct
  ctx.bumpProgress({ reviewWords: [{ word: word.word, correct }] })
  if (correct) {
    ctx.react('correct')
    ctx.toast('拼写正确！', 'ok', 1600)
  } else {
    ctx.react('wrong')
    ctx.addWordBank([word])
  }
  render()
  scrollPanelTo('.quiz-card', 110)
}

function startScenario(id) {
  const content = ctx.getContent() || {}
  const list = Array.isArray(content.scenarios) ? content.scenarios : []
  const scenario = list.find((s) => s.id === id)
  if (!scenario) return
  S.roleplay.scenarioId = id
  S.roleplay.started = true
  S.roleplay.ended = false
  S.roleplay.summary = null
  S.roleplay.done = []
  ctx.setStageChip(scenario.emoji || '🎭', `${scenario.name || '角色扮演'} · 目标 ${(scenario.objectives || []).length}`)
  if (scenario.opener) ctx.showTeacherText(scenario.opener, { speak: true })
  render()
}

function toggleObjective(i) {
  const idx = S.roleplay.done.indexOf(i)
  if (idx >= 0) S.roleplay.done.splice(idx, 1)
  else S.roleplay.done.push(i)
  render()
}

function endRoleplay() {
  const scenario = currentScenario()
  if (!scenario) return
  const stats = ctx.sessionStats ? ctx.sessionStats() : { turns: 0, newWords: 0, corrections: 0 }
  S.roleplay.ended = true
  S.roleplay.summary = { turns: stats.turns, newWords: stats.newWords, corrections: stats.corrections }
  if (ctx.endSession) ctx.endSession()
  ctx.react('correct')
  if (ctx.celebrate) ctx.celebrate('角色扮演完成，看看你的目标完成了几个？')
  render()
  scrollPanelTo('.summary-card', 74)
}

function restartRoleplay() {
  const scenario = currentScenario()
  if (!scenario) return
  S.roleplay.done = []
  S.roleplay.summary = null
  S.roleplay.ended = false
  ctx.setStageChip(scenario.emoji || '🎭', `${scenario.name || '角色扮演'} · 目标 ${(scenario.objectives || []).length}`)
  if (scenario.opener) ctx.showTeacherText(scenario.opener, { speak: true })
  render()
}

/* ------------------------------- 阅读讲解 --------------------------------- */

/** 支持上传的扩展名（服务端本机提取，SPEC v1.3 §B）。 */
const DOC_ACCEPT_EXT = [
  'txt', 'md', 'markdown', 'csv', 'json', 'log',
  'doc', 'docx', 'rtf', 'odt', 'html', 'htm',
  'pptx', 'pptm', 'pdf',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'tif', 'tiff',
]
const DOC_ACCEPT = DOC_ACCEPT_EXT.map((ext) => '.' + ext).join(',')
const MAX_DOC_SIZE = 12 * 1024 * 1024
const DOC_KIND_LABEL = {
  text: 'TXT', image: 'IMG', office: 'DOCX', slides: 'PPTX',
  txt: 'TXT', md: 'MD', markdown: 'MD', csv: 'CSV', json: 'JSON', log: 'LOG',
  doc: 'DOC', docx: 'DOCX', rtf: 'RTF', odt: 'ODT', html: 'HTML', htm: 'HTML',
  pptx: 'PPTX', pptm: 'PPTX', pdf: 'PDF',
  png: 'IMG', jpg: 'IMG', jpeg: 'IMG', webp: 'IMG', gif: 'IMG', bmp: 'IMG', heic: 'IMG', tif: 'IMG', tiff: 'IMG',
}

/** 文档列表项归一化。 */
function normalizeDocListItem(doc) {
  if (!doc || !doc.id) return null
  return {
    id: String(doc.id),
    name: String(doc.name || '未命名文档'),
    kind: String(doc.kind || fileExt(doc.name || '')).toLowerCase(),
    chars: Number(doc.chars) || 0,
    createdAt: Number(doc.createdAt) || 0,
    analyzed: !!(doc.analyzed || doc.analysis),
    truncated: !!doc.truncated,
    warnings: Array.isArray(doc.warnings) ? doc.warnings : [],
  }
}

function fileExt(name) {
  const parts = String(name || '').split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

function docKindLabel(kind) {
  const key = String(kind || '').toLowerCase()
  return DOC_KIND_LABEL[key] || (key ? key.toUpperCase().slice(0, 5) : 'DOC')
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / M月D日。 */
function fmtDocTime(ts) {
  const t = Number(ts) || 0
  if (!t) return ''
  const diff = Date.now() - t
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前'
  if (diff < 24 * 60 * 60 * 1000) return Math.max(1, Math.round(diff / 3600000)) + ' 小时前'
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/* ------------------------- API 兼容包装（api.js v1.3） -------------------- */

async function uploadDocApi(payload) {
  if (api && typeof api.uploadDoc === 'function') return api.uploadDoc(payload)
  return postJSON('/api/doc/upload', payload, { timeoutMs: 120000 })
}

async function listDocsApi() {
  if (api && typeof api.listDocs === 'function') return api.listDocs()
  return getJSON('/api/doc/list')
}

async function getDocApi(id) {
  if (api && typeof api.getDoc === 'function') return api.getDoc(id)
  return getJSON('/api/doc/' + encodeURIComponent(id))
}

async function analyzeDocApi(id, level) {
  if (api && typeof api.analyzeDoc === 'function') return api.analyzeDoc(id, level)
  return postJSON('/api/doc/analyze', { id, level }, { timeoutMs: 120000 })
}

async function deleteDocApi(id) {
  if (api && typeof api.deleteDoc === 'function') return api.deleteDoc(id)
  const res = await fetch('/api/doc/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) throw new Error((data && data.error) || `删除失败（HTTP ${res.status}）`)
  return data
}

/** 文件 → base64（优先用 api.js 的 helper）。 */
function fileToBase64(file) {
  if (api && typeof api.fileToBase64 === 'function') return api.fileToBase64(file)
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result || '')
        const comma = result.indexOf(',')
        resolve(comma >= 0 ? result.slice(comma + 1) : result)
      }
      reader.onerror = () => reject(new Error('读取文件失败，请重试'))
      reader.readAsDataURL(file)
    } catch (err) {
      reject(err instanceof Error ? err : new Error('读取文件失败'))
    }
  })
}

/* ------------------------------ 数据加载 -------------------------------- */

/** 选中文档/分析完成后，同步舞台字幕与麦克风提示（不打断进行中的对话）。 */
function syncReadingContext() {
  if (S.current !== 'reading' || !ctx) return
  const hasDoc = !!(S.reading.doc && S.reading.doc.id)
  ctx.setMicHint(hasDoc ? '点击麦克风，用英文回答或提问' : '先上传英文材料，再和 Ava 讨论')
  const idle = !ctx.getPhase || ctx.getPhase() === 'idle'
  if (!S.reading.started && idle) {
    ctx.setCaptionPlaceholder(
      hasDoc ? '点「开始讲解」，Ava 会用英文带你读这份材料' : '上传一份英文文档或图片，Ava 会先读懂它，再带你精读',
    )
  }
}

/** 首次进入阅读模式/刷新后拉取最近文档列表。 */
function ensureReading() {
  if (S.reading.docsLoaded || S.reading.listLoading) return
  void loadReadingDocs()
}

async function loadReadingDocs() {
  if (S.reading.listLoading) return
  S.reading.listLoading = true
  S.reading.listError = ''
  render()
  try {
    const res = await listDocsApi()
    const raw = res && Array.isArray(res.docs) ? res.docs : Array.isArray(res) ? res : []
    S.reading.docs = raw.map(normalizeDocListItem).filter(Boolean)
    S.reading.docsLoaded = true
    // 刷新后恢复最近一份文档（SPEC v1.3 §D5）
    if (!S.reading.docId && S.reading.docs.length) {
      S.reading.listLoading = false
      await selectReadingDoc(S.reading.docs[0].id)
      return
    }
  } catch (err) {
    S.reading.listError = err && err.message ? err.message : '文档列表加载失败'
  } finally {
    S.reading.listLoading = false
    render()
  }
}

/** 选中文档：拉取详情，未分析则自动分析。 */
async function selectReadingDoc(id) {
  const docId = String(id || '')
  if (!docId) return
  S.reading.confirmDelete = false
  S.reading.analyzeError = ''
  if (S.reading.docId === docId && S.reading.doc && S.reading.doc.text) {
    render()
    return
  }
  S.reading.docId = docId
  S.reading.analysis = null
  S.reading.started = false
  S.reading.questionIndex = 0
  S.reading.scrollToAnalysis = true
  const listItem = S.reading.docs.find((d) => d.id === docId)
  S.reading.doc = listItem ? { ...listItem } : null
  render()
  try {
    const res = await getDocApi(docId)
    const doc = res && (res.doc || (res.id ? res : null))
    if (doc && doc.id) {
      S.reading.doc = {
        ...doc,
        id: String(doc.id),
        name: String(doc.name || '未命名文档'),
        kind: String(doc.kind || fileExt(doc.name || '')).toLowerCase(),
        chars: Number(doc.chars) || 0,
        warnings: Array.isArray(doc.warnings) ? doc.warnings : [],
      }
      S.reading.analysis = doc.analysis || null
      if (S.reading.analysis) {
        render()
        syncReadingContext()
        if (S.reading.scrollToAnalysis) {
          S.reading.scrollToAnalysis = false
          scrollPanelTo('.reading-summary', 70)
        }
      } else {
        await analyzeReadingDoc(docId)
      }
    }
  } catch (err) {
    S.reading.analyzeError = err && err.message ? err.message : '文档加载失败'
    ctx.toast(S.reading.analyzeError, 'bad', 4200)
    render()
  }
}

/** 分析文档（上传后自动调用 / 手动重试）。 */
async function analyzeReadingDoc(id) {
  const docId = String(id || '')
  if (!docId) return
  S.reading.analyzing = true
  S.reading.analyzeError = ''
  S.reading.analysis = null
  render()
  try {
    const level = ctx.getLevel ? ctx.getLevel() : 'A2'
    const res = await analyzeDocApi(docId, level)
    if (!res || res.ok === false) throw new Error((res && res.error) || '分析失败')
    const analysis = res.analysis || (res.doc && res.doc.analysis) || null
    if (!analysis) throw new Error('分析结果为空，请重试')
    S.reading.analysis = analysis
    S.reading.analysisDemo = !!res.demo
    if (S.reading.doc) S.reading.doc.analysis = analysis
    const item = S.reading.docs.find((d) => d.id === docId)
    if (item) item.analyzed = true
    ctx.toast('Ava 已经读完这份材料了，可以开始讲解', 'ok', 3000)
  } catch (err) {
    S.reading.analyzeError = err && err.message ? err.message : '分析失败，请重试'
    ctx.toast(S.reading.analyzeError, 'bad', 4200)
  } finally {
    S.reading.analyzing = false
    render()
    syncReadingContext()
    if (S.reading.scrollToAnalysis) {
      S.reading.scrollToAnalysis = false
      scrollPanelTo('.reading-summary', 70)
    }
  }
}

/** 删除文档（面板里先二次确认）。 */
async function deleteReadingDoc(id) {
  const docId = String(id || '')
  if (!docId) return
  try {
    const res = await deleteDocApi(docId)
    if (res && res.ok === false) throw new Error(res.error || '删除失败')
    S.reading.docs = S.reading.docs.filter((d) => d.id !== docId)
    if (S.reading.docId === docId) {
      S.reading.docId = null
      S.reading.doc = null
      S.reading.analysis = null
      S.reading.started = false
      S.reading.questionIndex = 0
      S.reading.confirmDelete = false
    }
    if (ctx.endSession) ctx.endSession()
    ctx.toast('已删除这份文档', 'ok', 2400)
    render()
    syncReadingContext()
  } catch (err) {
    ctx.toast(err && err.message ? err.message : '删除失败，请重试', 'bad', 4000)
  }
}

/* ------------------------------ 上传 ------------------------------------ */

function handleDocFile(file) {
  if (!file || !file.name) return
  const ext = fileExt(file.name)
  if (!DOC_ACCEPT_EXT.includes(ext)) {
    ctx.toast(`暂不支持 .${ext || '?'} 格式，请上传 txt/md/docx/pptx/pdf/图片等`, 'bad', 4200)
    return
  }
  if (file.size > MAX_DOC_SIZE) {
    ctx.toast('文件超过 12MB，请压缩或上传更小的文件', 'bad', 4200)
    return
  }
  if (!file.size) {
    ctx.toast('这个文件是空的，换一份试试', 'bad', 3600)
    return
  }
  void uploadDocument(file)
}

async function uploadDocument(file) {
  S.reading.scrollToAnalysis = true
  S.reading.uploading = true
  S.reading.uploadError = ''
  S.reading.uploadingName = file.name || ''
  render()
  try {
    const dataBase64 = await fileToBase64(file)
    const res = await uploadDocApi({
      name: file.name,
      dataBase64,
      mime: file.type || '',
    })
    if (!res || res.ok === false || !res.doc || !res.doc.id) {
      throw new Error((res && res.error) || '上传失败，请重试')
    }
    const item = normalizeDocListItem(res.doc)
    S.reading.docs = item ? [item, ...S.reading.docs.filter((d) => d.id !== item.id)] : S.reading.docs
    S.reading.docId = String(res.doc.id)
    S.reading.doc = {
      ...res.doc,
      id: String(res.doc.id),
      warnings: Array.isArray(res.doc.warnings) ? res.doc.warnings : [],
    }
    S.reading.analysis = null
    S.reading.started = false
    S.reading.questionIndex = 0
    S.reading.confirmDelete = false
    S.reading.uploading = false
    render()
    const chars = Number(res.doc.chars) || 0
    ctx.toast(`已解析「${res.doc.name}」${chars ? ` · ${chars} 字` : ''}`, 'ok', 2800)
    if (res.doc.truncated) ctx.toast('文档较长，已截取前 60k 字符用于讲解', 'info', 4200)
    await analyzeReadingDoc(String(res.doc.id))
  } catch (err) {
    S.reading.uploading = false
    S.reading.uploadError = err && err.message ? err.message : '上传失败，请重试'
    ctx.toast(S.reading.uploadError, 'bad', 4200)
    render()
  }
}

/* ------------------------------ 互动 ------------------------------------ */

/** 当前是否已有可用文档（main.js 用来决定能否进入阅读对话）。 */
export function isReadingReady() {
  return !!(S.reading.doc && S.reading.doc.id)
}

/** 当前选中文档 id。 */
export function getReadingDocId() {
  return S.reading.docId || null
}

/** 供调试/测试读取阅读模式状态。 */
export function getReadingState() {
  return S.reading
}

/** 「开始讲解」：交给 main.js 走 chatStream(mode:'reading', docId)。 */
function startReadingLecture() {
  const doc = S.reading.doc
  if (!doc || !doc.id) {
    ctx.toast('先上传或选择一份英文材料', 'info', 2600)
    return
  }
  if (S.reading.analyzing) {
    ctx.toast('Ava 还在读这份材料，稍等一下', 'info', 2600)
    return
  }
  S.reading.started = true
  S.reading.questionIndex = 0
  render()
  syncReadingContext()
  ctx.startReadingLecture({ id: String(doc.id), name: doc.name, kind: doc.kind })
}

/** 「下一题」：让 Ava 继续问下一道理解题。 */
function nextReadingQuestion() {
  const analysis = S.reading.analysis
  const questions = analysis && Array.isArray(analysis.questions) ? analysis.questions : []
  if (!S.reading.started) {
    ctx.toast('先点「开始讲解」，Ava 会带你读这份材料', 'info', 2800)
    return
  }
  if (questions.length) S.reading.questionIndex = Math.min(questions.length - 1, S.reading.questionIndex + 1)
  render()
  ctx.askNextQuestion()
}

/** 「朗读原文」：TTS 分段朗读 readAloud 或文档开头的文本。 */
function readReadingAloud() {
  const analysis = S.reading.analysis
  const doc = S.reading.doc
  const raw =
    (analysis && (analysis.readAloud || analysis.read_aloud)) ||
    (doc && (doc.text || doc.preview)) ||
    ''
  const text = String(raw || '').trim()
  if (!text) {
    ctx.toast('还没有可朗读的原文', 'info', 2600)
    return
  }
  ctx.speak(text.slice(0, 900))
  ctx.toast('正在朗读原文…', 'info', 2000)
}

/* ------------------------------ 渲染 ------------------------------------ */

function renderReading() {
  const settings = ctx.getSettings() || {}
  const R = S.reading
  const doc = R.doc
  const analysis = R.analysis
  const head = `
    <div class="mp-head">
      <div>
        <div class="mp-eyebrow">${MODE_META.reading.eyebrow}</div>
        <h2 class="mp-title">${MODE_META.reading.title}</h2>
        <p class="mp-sub">上传英文文档或图片，Ava 帮你读懂、讲解，并用英文和你互动问答。</p>
      </div>
      <span class="mp-badge violet">${esc(settings.level || 'A2')}</span>
    </div>`

  const uploadZone = `
    <div class="upload-zone ${R.uploading ? 'is-busy' : ''}" data-act="reading-upload" role="button" tabindex="0" aria-label="上传英文文档或图片">
      <input type="file" id="doc-file-input" class="doc-file-input" accept="${esc(DOC_ACCEPT)}" aria-hidden="true" tabindex="-1">
      <span class="upload-icon">${icon(R.uploading ? 'refresh' : 'upload')}</span>
      ${
        R.uploading
          ? `<span class="upload-title">正在解析「${esc(R.uploadingName || '文档')}」…</span><span class="upload-sub">本机解析中，请稍候</span>`
          : `<span class="upload-title">拖拽文件到这里，或点击选择</span>
             <span class="upload-sub">支持 txt / md / csv / docx / pptx / pdf / png / jpg 等 · ≤12MB</span>
             <span class="upload-sub faint">原始文件只在本机解析，不会上传到第三方</span>`
      }
    </div>`

  const docList = R.docs.length
    ? `<div class="section-label">${icon('book')}最近文档<span class="spacer">${R.docs.length} 份 · 点击切换</span></div>
       <div class="doc-list">${R.docs
         .slice(0, 8)
         .map(
           (d) => `<div class="doc-item ${d.id === R.docId ? 'is-active' : ''}">
             <button type="button" class="doc-pick" data-act="reading-pick" data-id="${esc(d.id)}" title="打开 ${esc(d.name)}">
               <span class="doc-kind">${esc(docKindLabel(d.kind))}</span>
               <span class="doc-main">
                 <span class="doc-name">${esc(d.name)}</span>
                 <span class="doc-meta">${esc(d.chars || 0)} 字${d.createdAt ? ` · ${esc(fmtDocTime(d.createdAt))}` : ''}${d.analyzed ? ' · 已分析' : ''}</span>
               </span>
               ${d.analyzed ? `<span class="doc-done" title="已分析">${icon('check-circle')}</span>` : ''}
             </button>
             <button type="button" class="doc-del" data-act="reading-del" data-id="${esc(d.id)}" title="删除 ${esc(d.name)}" aria-label="删除 ${esc(d.name)}">${icon('trash')}</button>
           </div>`,
         )
         .join('')}</div>`
    : R.listLoading
      ? ''
      : `<div class="empty-state">${icon('file-text')}<strong>还没有文档</strong><span>上传一份英文文章、幻灯片、PDF 或截图，Ava 会先读懂它，再用英文带你精读。</span></div>
         ${R.listError ? `<div class="empty-state">${icon('alert')}<span>${esc(R.listError)}</span><button type="button" class="btn btn-mini" data-act="reading-retry-list">重试</button></div>` : ''}`

  let detail = ''
  if (doc && doc.id) {
    const warnings = Array.isArray(doc.warnings) && doc.warnings.length ? `<p class="reading-warn">${esc(doc.warnings[0])}</p>` : ''
    detail = `
      <div class="reading-doc-head">
        <div class="reading-doc-title">${icon('file-text')}<span>${esc(doc.name)}</span>
          <span class="mp-badge violet" style="margin-left:auto">${esc(docKindLabel(doc.kind))}</span>
        </div>
        <div class="reading-doc-meta">${esc(Number(doc.chars) || 0)} 字${doc.truncated ? ' · 已截断' : ''}</div>
        ${warnings}
      </div>`
  }

  let analysisHtml = ''
  if (R.analyzing) {
    analysisHtml = `<div class="reading-loading"><span class="sum-spinner" aria-hidden="true"></span><p>Ava 正在读这份材料…</p><span>提取摘要、核心要点、重点词汇和理解问题</span></div>`
  } else if (R.analyzeError) {
    analysisHtml = `<div class="empty-state">${icon('alert')}<strong>分析没有成功</strong><span>${esc(R.analyzeError)}</span>
      <button type="button" class="btn btn-primary" data-act="reading-analyze" data-id="${esc(R.docId || '')}">${icon('refresh')}重试分析</button></div>`
  } else if (analysis) {
    analysisHtml = renderReadingAnalysis(analysis)
  } else if (doc && doc.id) {
    analysisHtml = `<div class="empty-state">${icon('sparkles')}<strong>还没有分析</strong><span>让 Ava 先读一遍这份材料，再开始讲解。</span>
      <button type="button" class="btn btn-primary" data-act="reading-analyze" data-id="${esc(doc.id)}">${icon('sparkles')}开始分析</button></div>`
  }

  let actions = ''
  if (doc && doc.id && analysis && !R.analyzing) {
    const delBtn = R.confirmDelete
      ? `<div class="reading-confirm"><p>确认删除「${esc(doc.name)}」？提取的文字与分析结果会一起删除，原始文件不在本机保存。</p>
          <div class="chips">
            <button type="button" class="btn btn-danger-ghost btn-mini" data-act="reading-del-confirm" data-id="${esc(doc.id)}">${icon('trash')}确认删除</button>
            <button type="button" class="btn btn-ghost btn-mini" data-act="reading-del-cancel">取消</button>
          </div></div>`
      : ''
    actions = `
      <div class="reading-actions">
        <button type="button" class="btn btn-primary" data-act="reading-start">${icon('chat')}开始讲解</button>
        <button type="button" class="btn btn-ghost" data-act="reading-read">${icon('volume')}朗读原文</button>
        ${R.started ? `<button type="button" class="btn btn-ghost" data-act="reading-next">${icon('chevron-right')}下一题</button>` : ''}
        <button type="button" class="btn btn-danger-ghost" data-act="reading-del" data-id="${esc(doc.id)}">${icon('trash')}删除</button>
      </div>
      ${delBtn}`
  }

  return `<div class="mp">${head}${uploadZone}${docList}${detail}${analysisHtml}${actions}</div>`
}

function renderReadingAnalysis(analysis) {
  const summary = String(analysis.summary_zh || '').trim()
  const points = Array.isArray(analysis.keyPoints) ? analysis.keyPoints.filter((p) => p && (p.en || p.zh)) : []
  const words = Array.isArray(analysis.keyWords) ? analysis.keyWords.filter((w) => w && w.word) : []
  const questions = Array.isArray(analysis.questions) ? analysis.questions.filter((q) => q && (q.en || q.zh)) : []
  const current = Math.min(S.reading.questionIndex || 0, Math.max(0, questions.length - 1))
  const demoTag = S.reading.analysisDemo ? `<span class="sum-demo">演示分析</span>` : ''
  const summaryHtml = summary
    ? `<div class="reading-summary">${icon('sparkles')}<div><p>${esc(summary)}</p><div class="chips" style="margin-top:6px">${demoTag}</div></div></div>`
    : ''
  const pointsHtml = points.length
    ? `<div class="reading-section"><div class="section-label">${icon('target')}核心要点<span class="spacer">${points.length} 条</span></div>
        ${points
          .map(
            (p) => `<div class="reading-point">${p.en ? `<span class="en">${esc(p.en)}</span>` : ''}${p.zh ? `<span class="zh">${esc(p.zh)}</span>` : ''}</div>`,
          )
          .join('')}</div>`
    : ''
  const wordsHtml = words.length
    ? `<div class="reading-section"><div class="section-label">${icon('book')}重点词汇<span class="spacer">点 🔊 听发音</span></div>
        <div class="kw-grid reading-kw">${words
          .map(
            (w) => `<div class="kw-card">
              <div class="kw-top">
                <span class="kw-word">${esc(w.word)}</span>
                ${w.phonetic ? `<span class="kw-phon">${esc(w.phonetic)}</span>` : ''}
                <button type="button" class="icon-action kw-speak" data-speak="${esc(w.word)}" title="朗读 ${esc(w.word)}" aria-label="朗读 ${esc(w.word)}">${icon('volume')}</button>
              </div>
              ${w.meaning ? `<div class="kw-meaning">${esc(w.meaning)}</div>` : ''}
              ${w.example ? `<p class="kw-example">${esc(w.example)}</p>` : ''}
              ${w.why_zh ? `<p class="kw-why">${esc(w.why_zh)}</p>` : ''}
            </div>`,
          )
          .join('')}</div></div>`
    : ''
  const questionsHtml = questions.length
    ? `<div class="reading-section"><div class="section-label">${icon('chat')}理解题<span class="spacer">${questions.length} 题 · 点题号朗读</span></div>
        ${questions
          .map(
            (q, i) => `<div class="reading-q ${i === current && S.reading.started ? 'is-current' : ''}">
              <button type="button" class="icon-action" style="width:26px;height:26px" data-speak="${esc(q.en || q.zh || '')}" title="朗读这道题">${icon('volume')}</button>
              <div class="q-body">
                ${q.en ? `<span class="q-en">${esc(q.en)}</span>` : ''}
                ${q.zh ? `<span class="q-zh">${esc(q.zh)}</span>` : ''}
              </div>
            </div>`,
          )
          .join('')}</div>`
    : ''
  return `${summaryHtml}${pointsHtml}${wordsHtml}${questionsHtml}`
}

/* -------------------------------------------------------------------------- */
/* 与主流程的接口                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 当前模式需要的对话上下文（chatStream body 片段）。
 * @returns {{mode:string, topicId?:string, scenarioId?:string, focusWords?:string[]}}
 */
export function getChatContext() {
  if (S.current === 'free') return { mode: 'free' }
  if (S.current === 'roleplay') return { mode: 'roleplay', scenarioId: S.roleplay.scenarioId || undefined }
  if (S.current === 'reading') return { mode: 'reading', docId: S.reading.docId || undefined }
  if (S.current === 'vocab') {
    const w = currentWord()
    return { mode: 'vocab', focusWords: w ? [w.word] : [] }
  }
  return { mode: 'pronounce' }
}

/**
 * 语音识别拿到最终文本后，由主流程调用。
 * - 跟读打分：对当前句子评分（接管，不再走闲聊）
 * - 单词闯关：对当前单词跟读评分（接管）
 * @param {string} text
 * @returns {boolean} 是否已接管本次输入
 */
export function handleUtterance(text) {
  const value = String(text || '').trim()
  if (!value) return false
  if (S.current === 'pronounce') {
    scorePronounce(value)
    return true
  }
  if (S.current === 'vocab') {
    scoreWord(value)
    return true
  }
  return false
}

async function scorePronounce(transcript) {
  const sentence = currentSentence()
  if (!sentence) return
  try {
    ctx.setMicHint('正在评分…')
    const result = await api.score({ target: sentence.en, transcript })
    S.pronounce.result = result
    S.pronounce.results[sentence.en] = result
    ctx.setCaptionScore(Array.isArray(result.words) ? result.words : null)
    const score = Number(result.score) || 0
    if (score >= 80) {
      ctx.react('correct')
      if (ctx.celebrate) ctx.celebrate(`跟读得分 ${score} 分，发音很棒！`)
    } else if (score >= 55) {
      ctx.react('idle')
    } else {
      ctx.react('wrong')
    }
    ctx.bumpProgress({ turns: 1, minutes: 0.5 })
    ctx.toast(`本题得分 ${score} 分`, score >= 70 ? 'ok' : 'info')
    render()
    scrollPanelTo('.score-card', 74)
  } catch (err) {
    ctx.toast(err && err.message ? err.message : '评分失败，请稍后重试', 'bad')
  } finally {
    ctx.setMicHint('点击麦克风，跟读当前句子')
  }
}

async function scoreWord(transcript) {
  const word = currentWord()
  const target = word ? word.word : ''
  if (!target) return
  try {
    ctx.setMicHint('正在评分…')
    const result = await api.score({ target, transcript })
    S.vocab.score = result
    const score = Number(result.score) || 0
    if (score >= 75) {
      ctx.react('correct')
      ctx.toast(`单词跟读 ${score} 分`, 'ok', 1800)
    } else {
      ctx.react('wrong')
      ctx.toast(`再听一遍发音，争取更清晰（${score} 分）`, 'info', 2000)
    }
    ctx.bumpProgress({ turns: 1, minutes: 0.2, reviewWords: [{ word: target, correct: score >= 75 }] })
    render()
  } catch (err) {
    ctx.toast(err && err.message ? err.message : '评分失败，请稍后重试', 'bad')
  } finally {
    ctx.setMicHint('点击麦克风，跟读当前单词')
  }
}

/**
 * 用户发出一条消息（打字或语音）后，主流程调用；用于角色扮演目标检测。
 * @param {string} text
 */
export function onUserMessage(text) {
  if (S.current !== 'roleplay' || S.roleplay.ended) return
  const scenario = currentScenario()
  if (!scenario) return
  const phrases = Array.isArray(scenario.keyPhrases) ? scenario.keyPhrases : []
  const spoken = normalizeText(text)
  let changed = false
  for (let i = 0; i < phrases.length; i++) {
    const en = phrases[i] && phrases[i].en
    if (!en) continue
    if (S.roleplay.done.includes(i)) continue
    if (phraseMatched(spoken, en)) {
      S.roleplay.done.push(i)
      changed = true
    }
  }
  if (changed) {
    ctx.react('correct')
    ctx.toast('目标句完成，已打勾！', 'ok', 1800)
    render()
  }
}

/**
 * 收到 AI 反馈（feedback）后由主流程调用。
 * @param {any} feedback
 */
export function onTeacherFeedback(feedback) {
  if (!feedback) return
  if (S.current === 'roleplay') render()
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function phraseMatched(spoken, phraseEn) {
  const target = normalizeText(phraseEn)
  if (!target) return false
  if (spoken.includes(target)) return true
  const words = target.split(' ').filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  if (!words.length) return false
  const spokenWords = new Set(spoken.split(' '))
  let hit = 0
  for (const w of words) {
    if (spokenWords.has(w)) hit += 1
    else if (Array.from(spokenWords).some((s) => s.length > 3 && (s.startsWith(w.slice(0, 4)) || w.startsWith(s.slice(0, 4))))) hit += 0.7
  }
  return hit / words.length >= 0.55
}

const STOP_WORDS = new Set([
  'the', 'and', 'you', 'your', 'for', 'with', 'that', 'this', 'have', 'would', 'could', 'please', 'like', 'want', 'can', 'are', 'what', 'how', 'its', "it's", 'about',
])

/** 内容为空/加载中占位。 */
function emptyContent() {
  return `<div class="empty-state">${icon('alert')}<strong>内容还没有加载出来</strong><span>请确认本地服务已启动，然后刷新页面。</span></div>`
}

/** 供主流程读取当前是否在可接收练习语音的模式。 */
export function isPracticeMode() {
  return S.current === 'pronounce' || S.current === 'vocab'
}

/** 供主流程读取当前跟读模式的目标文本（评分用，便于提示）。 */
export function getPracticeHint() {
  if (S.current === 'pronounce') {
    const s = currentSentence()
    return s ? `请跟读：${s.en}` : ''
  }
  if (S.current === 'vocab') {
    const w = currentWord()
    return w ? `请跟读单词：${w.word}` : ''
  }
  return ''
}

/** 供主流程查询当前模式阶段（角色扮演是否已开始/结束）。 */
export function getModeState() {
  return S
}

/** 重置（测试/重新开始用）。 */
export function resetModes() {
  Object.assign(S, defaultState())
  render()
}

void confetti
void $
