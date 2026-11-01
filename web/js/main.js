/**
 * Ava · 主应用逻辑
 * 状态机：idle → listening → thinking → speaking → idle
 * 语音→大脑→数字人：STT interim 上屏 → onFinal → chatStream 流式字幕
 *   → 按句切分 TTS（边收边播）→ 逐词边界驱动数字人口型与字幕高亮
 *   → feedback 纠正卡/生词/鼓励 → 进度入账
 *
 * 说明：avatar 为可选依赖（动态 import + 容错），缺失时不影响语音与教学模式。
 * @module main
 */
import { api, chatStream, postJSON } from './api.js'
import { createSTT, tts, isChineseText, pickSTTLang } from './speech.js'
import { state, loadAll, saveProgress } from './store.js'
import * as ui from './ui.js'
import * as modes from './modes.js'

const { $, $$, esc, icon } = ui

/* ========================================================================== */
/* 应用状态                                                                    */
/* ========================================================================== */

const A = {
  content: null,
  settings: null,
  progress: null,
  health: null,
  avatar: null,
  /** @type {'idle'|'listening'|'thinking'|'speaking'} */
  phase: 'idle',
  stt: null,
  sttSupported: false,

  // 字幕
  replyText: '',
  revealed: 0,
  revealTarget: 0,
  highlight: -1,
  rafId: 0,
  streamDone: true,
  firstDelta: false,
  captionMode: /** @type {'placeholder'|'thinking'|'reply'|'target'} */ ('placeholder'),
  placeholder: '点麦克风，和 Ava 开始一段英语对话',
  captionUser: '',
  interimText: '',
  targetCaption: null,
  targetWords: null,
  spokenUpTo: 0,

  // 对话
  chatHandle: null,
  history: [],
  session: { turns: 0, newWords: 0, corrections: 0 },
  turnFinished: true,
  lastFeedback: null,
  demo: true,
  lastInputVoice: false,
  micHintIdle: '点击麦克风开始说英语 · 也可按空格',
  voiceName: '',

  // TTS 队列
  speechQueue: [],
  speechRunning: false,
  speechSeq: 0,

  // 进度合并保存
  pendingProgress: null,
  progressTimer: null,

  wordMeta: {},
  onboarded: false,
  // v1.1 结束总结 / 今日单词表
  previewSpeech: false,
  // v1.5 双语字幕
  translateSeq: 0,
  userZhText: '',
  replyZhText: '',
  // v1.4 语音引擎 / 豆包实时语音
  voiceEngine: 'browser',
  volc: {
    appId: '',
    hasKey: false,
    keyHint: '',
    model: '3.0',
    speaker: 'en_female_dacey_uranus_bigtts',
    endpoint: 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue',
    resourceId: 'volc.speech.dialog',
  },
  volcFallback: false,
  volcSession: false,
  volcConnected: false,
  volcAudio: false,
  volcChatStarted: false,
  doubao: null,
  doubaoFactory: null,
  // v1.2 中文求助 / 相关性提示
  sttLang: 'en-US',
  zhRequested: false,
  thinkingChinese: false,
  turnMeta: { demo: false, chinese: false },
  demoHintShown: false,
  followTarget: null,
  followResult: null,
  summaryLoading: false,
  lastSummary: null,
  lastSummaryMessages: [],
  wordbook: null,
}

const D = {}
const LEVELS_FALLBACK = ['A1', 'A2', 'B1', 'B2', 'C1']

/* ========================================================================== */
/* 小工具                                                                      */
/* ========================================================================== */

function getSettings() {
  return A.settings || {}
}
function level() {
  const s = getSettings()
  return s.level || 'A2'
}
function teacherName() {
  const s = getSettings()
  return s.teacherName || 'Ava'
}
function explainChinese() {
  return getSettings().explainChinese !== false
}

function safeAvatar(method, ...args) {
  const avatar = A.avatar
  if (!avatar) return undefined
  try {
    if (typeof avatar[method] === 'function') return avatar[method](...args)
  } catch (err) {
    console.warn('[app] avatar 调用失败：', method, err)
  }
  return undefined
}

function pushHistory(entry) {
  if (!entry || !entry.content) return
  A.history.push(entry)
  if (Array.isArray(state.messages)) {
    try {
      state.messages.push({ role: entry.role, content: entry.content, ts: Date.now() })
    } catch {
      /* 忽略 */
    }
  }
}

function persistWordMeta() {
  try {
    const keys = Object.keys(A.wordMeta)
    const trimmed = {}
    for (const k of keys.slice(-300)) trimmed[k] = A.wordMeta[k]
    localStorage.setItem('ava.wordMeta.v1', JSON.stringify(trimmed))
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

function loadWordMeta() {
  try {
    const raw = localStorage.getItem('ava.wordMeta.v1')
    if (raw) return JSON.parse(raw) || {}
  } catch {
    /* 忽略 */
  }
  return {}
}

function normalizeLevels(list) {
  const source = Array.isArray(list) && list.length ? list : LEVELS_FALLBACK
  return source
    .map((item) => {
      if (typeof item === 'string') return { id: item, name: item, desc: '' }
      if (item && typeof item === 'object') {
        return { id: String(item.id || item.level || ''), name: String(item.name || item.id || ''), desc: String(item.desc || '') }
      }
      return null
    })
    .filter((item) => item && item.id)
}

/* ========================================================================== */
/* 阶段 / 状态标签                                                             */
/* ========================================================================== */

const PHASE_LABEL = {
  idle: '准备就绪',
  listening: '正在聆听…',
  thinking: 'Ava 正在思考…',
  speaking: 'Ava 正在说…',
}

function setPhase(phase) {
  A.phase = phase
  if (!D.statusLabel) return
  D.statusLabel.className = 'status-label'
  if (phase === 'listening') D.statusLabel.classList.add('is-listening')
  if (phase === 'thinking') D.statusLabel.classList.add('is-thinking')
  if (phase === 'speaking') D.statusLabel.classList.add('is-speaking')
  D.statusText.textContent =
    phase === 'listening'
      ? '正在聆听 · 说完停顿一下'
      : phase === 'thinking'
        ? thinkingLabel()
        : phase === 'speaking'
          ? 'Ava 正在说…'
          : A.demo
            ? '准备就绪 · 演示模式'
            : '准备就绪'
  D.stage.classList.toggle('is-listening', phase === 'listening')
  D.stage.classList.toggle('is-speaking', phase === 'speaking')
  const busy = phase === 'listening' || phase === 'thinking' || phase === 'speaking'
  D.micBtn.classList.toggle('is-listening', phase === 'listening')
  D.micBtn.classList.toggle('is-busy', busy)
  D.micBtn.classList.toggle('is-thinking', phase === 'thinking')
  D.micBtn.classList.toggle('is-interrupt', phase === 'speaking' || phase === 'thinking')
  D.micWrap.classList.toggle('is-listening', phase === 'listening')
  if (D.micHint) {
    D.micHint.textContent =
      phase === 'listening'
        ? '正在聆听…说完停顿一下'
        : phase === 'thinking'
          ? thinkingLabel()
          : phase === 'speaking'
            ? 'Ava 正在说，听一听'
            : A.micHintIdle || '点击麦克风开始说英语'
  }
  D.micBtn.setAttribute('aria-pressed', phase === 'listening' ? 'true' : 'false')
  D.micBtn.setAttribute(
    'aria-label',
    phase === 'listening' ? '停止聆听' : phase === 'thinking' ? '停止等待' : phase === 'speaking' ? '打断 Ava' : '开始说话',
  )
  D.micBtn.title =
    phase === 'listening' ? '点击结束聆听' : phase === 'thinking' ? '点击取消' : phase === 'speaking' ? '点击打断 Ava' : '点击开始说话'
}

/**
 * 重新读取 /api/health，同步顶部「演示模式」徽标与状态文案。
 * 保存 / 清除 API Key 后调用，避免需要刷新页面才更新。
 * @returns {Promise<void>}
 */
async function refreshServerMode() {
  try {
    const health = await api.health()
    A.health = health
    const hasKey = A.settings && typeof A.settings === 'object' ? A.settings.hasKey : health.hasKey
    const demo = !hasKey || health.mode === 'demo'
    showDemo(demo)
    if (D.demoPill) {
      D.demoPill.title = demo
        ? '未配置 API Key：Ava 使用内置脚本演示。填入 Key 即可升级为真 AI。'
        : '已连接 AI 模型，Ava 会用真实模型回复。'
    }
  } catch {
    /* 健康检查失败不影响主流程 */
  }
}

function showDemo(show) {
  A.demo = !!show
  if (D.demoPill) D.demoPill.hidden = !show
  if (D.statusLabel && A.phase === 'idle') {
    D.statusText.textContent = show ? '准备就绪 · 演示模式' : '准备就绪'
  }
}

/* ========================================================================== */
/* 字幕渲染                                                                    */
/* ========================================================================== */

const WORD_RE = /[A-Za-z0-9][A-Za-z0-9'’\-]*/g

function tokenizeWords(text) {
  const tokens = []
  WORD_RE.lastIndex = 0
  let m
  while ((m = WORD_RE.exec(text))) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length })
  }
  return tokens
}

function renderReplyHtml() {
  const text = A.replyText
  const visible = text.slice(0, A.revealed)
  const tokens = tokenizeWords(text)
  let html = ''
  let pos = 0
  for (const token of tokens) {
    if (token.start >= visible.length) break
    if (token.start > pos) html += esc(text.slice(pos, token.start))
    const wordEnd = Math.min(token.end, visible.length)
    const shown = text.slice(token.start, wordEnd)
    const speaking = A.highlight >= token.start && A.highlight < token.end
    const said = A.highlight >= 0 && token.start < A.highlight
    const cls = ['w']
    if (speaking) cls.push('w-hl')
    else if (said) cls.push('w-said')
    html += `<span class="${cls.join(' ')}">${esc(shown)}</span>`
    if (wordEnd < token.end) {
      pos = visible.length
      break
    }
    pos = token.end
  }
  if (pos < visible.length) html += esc(text.slice(pos, visible.length))
  if (A.revealed < A.revealTarget || !A.streamDone) html += '<span class="type-caret"></span>'
  return html || '<span class="type-caret"></span>'
}

function renderTargetHtml() {
  const target = A.targetCaption || {}
  const en = String(target.en || '')
  const words = tokenizeWords(en)
  const scores = Array.isArray(A.targetWords) ? A.targetWords : null
  let body = ''
  if (!scores) {
    body = esc(en)
  } else {
    let pos = 0
    words.forEach((token, i) => {
      if (token.start > pos) body += esc(en.slice(pos, token.start))
      const entry = scores[i] || {}
      const status = entry.status
      const cls = status === 'ok' ? 'w-ok' : status === 'close' ? 'w-close' : status === 'miss' ? 'w-miss' : ''
      body += `<span class="w ${cls}" title="${status === 'ok' ? '发音清晰' : status === 'close' ? '接近正确' : status === 'miss' ? '没听到' : ''}">${esc(token.word)}</span>`
      pos = token.end
    })
    if (pos < en.length) body += esc(en.slice(pos))
  }
  const zh = target.zh ? `<div class="tgt-zh">${esc(target.zh)}</div>` : ''
  return `<div class="tgt-head"><span class="tgt-tag">跟读这句</span><span class="tgt-hint">点麦克风跟读，点 🔊 听原句</span></div><div class="tgt-en">${body}</div>${zh}`
}

function renderCaption() {
  if (!D.captionReply) return
  D.caption.classList.toggle('has-reply', A.captionMode === 'reply' || A.captionMode === 'target')
  if (A.captionUser) {
    D.captionUser.hidden = false
    D.captionUser.textContent = A.captionUser
  } else {
    D.captionUser.hidden = true
    D.captionUser.textContent = ""
  }
  if (A.interimText) {
    D.captionInterim.hidden = false
    D.captionInterim.innerHTML = `${esc(A.interimText)}<span class="caret"></span>`
  } else {
    D.captionInterim.hidden = true
    D.captionInterim.textContent = ''
  }
  if (A.captionMode === 'target' && A.targetCaption) {
    D.captionReply.innerHTML = renderTargetHtml()
    return
  }
  if (A.captionMode === 'thinking') {
    D.captionReply.innerHTML = `<span class="thinking-dots"><i></i><i></i><i></i><em>${esc(teacherName())} 正在想怎么回答…</em></span>`
    return
  }
  if (A.captionMode === 'reply' && (A.replyText || !A.streamDone)) {
    D.captionReply.innerHTML = renderReplyHtml()
    return
  }
  D.captionReply.innerHTML = `<span class="caption-ph">${icon('sparkles')}${esc(A.placeholder)}</span>`
  renderBilingual()
}

function beginReveal() {
  if (A.rafId) return
  const step = () => {
    A.rafId = 0
    const remain = A.revealTarget - A.revealed
    if (remain <= 0) {
      renderCaption()
      maybeFinishTurn()
      return
    }
    A.revealed = Math.min(A.revealTarget, A.revealed + Math.max(2, Math.ceil(remain / 9)))
    renderCaption()
    A.rafId = requestAnimationFrame(step)
  }
  A.rafId = requestAnimationFrame(step)
}

function forceRevealTo(charIndex) {
  const target = Math.max(0, Math.min(A.replyText.length, charIndex))
  if (target > A.revealed) {
    A.revealTarget = Math.max(A.revealTarget, target)
    A.revealed = target
  }
}

/* ========================================================================== */
/* TTS 队列：按句朗读 + 逐词驱动口型/高亮                                       */
/* ========================================================================== */

function estimateDuration(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
  return Math.max(700, words * 280 + 340)
}

function speechRate() {
  const lv = level()
  if (lv === 'A1') return 0.84
  if (lv === 'A2') return 0.9
  if (lv === 'B1') return 0.95
  if (lv === 'B2') return 1
  return 1.04
}

function enqueueSpeech(text, offset = 0, options = {}) {
  const clean = String(text || '').trim()
  if (!clean) return
  A.speechQueue.push({ text: clean, offset, silent: !!options.silent })
  void pumpSpeech()
}

function clearSpeech() {
  A.speechSeq += 1
  A.speechQueue = []
  A.previewSpeech = false
  try {
    tts.cancel()
  } catch {
    /* 忽略 */
  }
}

async function pumpSpeech() {
  if (A.speechRunning) return
  A.speechRunning = true
  try {
    while (A.speechQueue.length) {
      const job = A.speechQueue.shift()
      await speakOne(job)
    }
  } finally {
    A.speechRunning = false
    safeAvatar('endSpeech')
    A.highlight = -1
    renderCaption()
    if (A.phase === 'speaking' && A.streamDone) maybeFinishTurn()
  }
}

/**
 * 朗读一句，并用合成时钟兜底逐词高亮（无声音/无 boundary 事件时也能驱动口型）。
 * @param {{text:string, offset:number}} job
 * @returns {Promise<void>}
 */
function speakOne(job) {
  return new Promise((resolve) => {
    const seq = A.speechSeq
    const text = job.text
    const tokens = tokenizeWords(text)
    const duration = estimateDuration(text)
    // headless / CDP 自动化环境：无真实音频，合成时钟加速（真实浏览器不受影响）
    let automation = false
    try {
      automation =
        typeof navigator !== 'undefined' &&
        (!!navigator.webdriver || /HeadlessChrome/i.test(String(navigator.userAgent || '')))
    } catch {
      automation = false
    }
    const synthScale = automation ? 0.34 : 1
    const startGrace = automation ? 550 : 1800
    const synthDuration = duration * synthScale
    const stepMs = Math.max(automation ? 60 : 110, (duration / Math.max(1, tokens.length)) * synthScale)
    let done = false
    let idx = 0
    let started = false
    let startedAt = 0
    let lastRealBoundary = 0
    let clockTimer = null
    let watchdog = null
    let startWatchdog = null

    const cleanup = () => {
      if (clockTimer) clearInterval(clockTimer)
      if (watchdog) clearTimeout(watchdog)
      if (startWatchdog) clearTimeout(startWatchdog)
      clockTimer = watchdog = startWatchdog = null
    }
    const finish = (cancelAudio) => {
      if (done) return
      done = true
      cleanup()
      if (cancelAudio) {
        try {
          tts.cancel()
        } catch {
          /* 忽略 */
        }
      }
      A.highlight = -1
      renderCaption()
      safeAvatar('endSpeech')
      resolve()
    }
    if (seq !== A.speechSeq) {
      resolve()
      return
    }

    const markWord = (tokenIndex) => {
      const token = tokens[tokenIndex]
      if (!token) return
      const abs = job.offset + token.start
      if (!job.silent) {
        A.highlight = abs
        forceRevealTo(job.offset + token.end)
        renderCaption()
      }
      safeAvatar('wordBoundary', { word: token.word, charIndex: abs, elapsedMs: startedAt ? Math.round(performance.now() - startedAt) : 0 })
      idx = tokenIndex + 1
    }

    const startClock = () => {
      if (clockTimer || done) return
      if (!started) {
        started = true
        startedAt = performance.now()
        setPhase('speaking')
        safeAvatar('beginSpeech', { text, durationMs: duration })
      }
      clockTimer = setInterval(() => {
        if (done || seq !== A.speechSeq) {
          if (clockTimer) clearInterval(clockTimer)
          clockTimer = null
          return
        }
        // 真实 boundary 事件仍在驱动 → 合成时钟让位
        if (lastRealBoundary && performance.now() - lastRealBoundary < 850) return
        if (idx >= tokens.length) {
          if (clockTimer) clearInterval(clockTimer)
          clockTimer = null
          return
        }
        markWord(idx)
      }, stepMs)
    }

    // 首句朗读时同步字幕揭示进度，避免高亮出现在未显示的文字上
    forceRevealTo(job.offset + text.length)

    try {
      tts.speak(text, {
        voice: A.voiceName || undefined,
        rate: speechRate(),
        onStart: () => {
          started = true
          startedAt = performance.now()
          if (startWatchdog) clearTimeout(startWatchdog)
          setPhase('speaking')
          safeAvatar('beginSpeech', { text, durationMs: duration })
          startClock()
          if (watchdog) clearTimeout(watchdog)
          watchdog = setTimeout(
            () => finish(true),
            automation ? Math.max(1500, synthDuration + 900) : duration * 1.9 + 2600,
          )
        },
        onWordBoundary: (detail) => {
          if (done || seq !== A.speechSeq) return
          const detailObj = detail && typeof detail === 'object' ? detail : { word: '', charIndex: 0 }
          const abs = job.offset + Math.max(0, Number(detailObj.charIndex) || 0)
          lastRealBoundary = performance.now()
          const tokenIndex = tokens.findIndex((t) => abs >= t.start && abs <= t.end)
          if (tokenIndex >= 0) {
            idx = tokenIndex + 1
            if (!job.silent) {
              A.highlight = job.offset + tokens[tokenIndex].start
              forceRevealTo(job.offset + tokens[tokenIndex].end)
              renderCaption()
            }
          }
          safeAvatar('wordBoundary', {
            word: detailObj.word || '',
            charIndex: abs,
            elapsedMs: Number(detailObj.elapsedMs) || (startedAt ? Math.round(performance.now() - startedAt) : 0),
          })
        },
        onEnd: () => finish(false),
        onError: () => {
          // 无可用语音合成（如无音色/headless）：仍用合成时钟驱动字幕与口型
          if (!done && !started) startClock()
          if (!done && started) finish(true)
        },
      })
    } catch (err) {
      console.warn('[app] TTS 调用失败，使用字幕节奏兜底：', err)
      if (!started) startClock()
      else finish(true)
    }

    // 语音合成迟迟不开始（无音色/被静音/headless）：1.8s 后走合成时钟
    startWatchdog = setTimeout(() => {
      if (done || started) return
      startClock()
      // 合成时钟走完自然结束
      watchdog = setTimeout(() => finish(true), synthDuration + (automation ? 500 : 900))
    }, startGrace)
  })
}

/* ========================================================================== */
/* 对话主流程                                                                  */
/* ========================================================================== */

function thinkingHtml() {
  return `<span class="thinking-dots"><i></i><i></i><i></i><em>${esc(thinkingLabel())}</em></span>`
}

function beginReplySession(userText) {
  resetBilingual()
  A.thinkingChinese = isChineseText(userText)
  A.turnMeta = { demo: false, chinese: A.thinkingChinese }
  A.followTarget = null
  A.followResult = null
  // 中文原文只放在「中文求助卡」里，不混进字幕主文本（SPEC v1.2 §B3）
  A.captionUser = A.thinkingChinese ? '' : userText || ''
  A.captionMode = 'reply'
  A.placeholder = ''
  A.replyText = ''
  A.revealed = 0
  A.revealTarget = 0
  A.highlight = -1
  A.streamDone = false
  A.firstDelta = false
  A.spokenUpTo = 0
  A.targetCaption = null
  A.targetWords = null
  A.interimText = ''
  A.turnFinished = false
  A.lastFeedback = null
  renderFeedbackPanel(null)
  renderCaption()
  D.captionReply.innerHTML = thinkingHtml()
  setPhase('thinking')
  safeAvatar('setState', 'thinking')
  safeAvatar('setEmotion', 'thinking')
}

function consumeSentences(final) {
  const text = A.replyText
  const re = /[.!?…]+["'’)\]]*(?=\s|$)/g
  re.lastIndex = A.spokenUpTo
  let lastEnd = A.spokenUpTo
  let m
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length
    enqueueSentenceRange(lastEnd, end)
    lastEnd = end
  }
  if (final) {
    if (lastEnd < text.length) enqueueSentenceRange(lastEnd, text.length)
    lastEnd = text.length
  }
  A.spokenUpTo = lastEnd
}

function enqueueSentenceRange(start, end) {
  const raw = A.replyText.slice(start, end)
  const trimmed = raw.trim()
  if (!trimmed) return
  const lead = raw.length - raw.trimStart().length
  enqueueSpeech(trimmed, start + lead)
}

async function sendToChat(message, extra = {}) {
  const text = String(message || '').trim()
  const isStart = !!(extra && extra.start)
  if (!text && !isStart) return
  if (A.phase === 'thinking') {
    ui.toast('Ava 还在思考，稍等一下', 'info', 1600)
    return
  }
  if (A.phase === 'speaking') interrupt()
  if (A.stt && A.stt.isActive) {
    try {
      A.stt.abort()
    } catch {
      /* 忽略 */
    }
  }
  A.interimText = ''
  beginReplySession(text)
  void translateUserText(text)
  modes.onUserMessage(text)

  const chatContext = { ...modes.getChatContext(), ...((extra && extra.context) || {}) }
  const historySource = extra && extra.start ? [] : A.history
  const history = historySource.slice(-20).map((m) => ({ role: m.role, content: m.content }))
  if (text) pushHistory({ role: 'user', content: text })
  A.session.turns += 1
  A.lastInputVoice = false

  const body = {
    mode: chatContext.mode || 'free',
    level: level(),
    message: text,
    history,
    teacherName: teacherName(),
    focusWords: Array.isArray(chatContext.focusWords) ? chatContext.focusWords : [],
  }
  if (chatContext.topicId) body.topicId = chatContext.topicId
  if (chatContext.scenarioId) body.scenarioId = chatContext.scenarioId
  if (chatContext.docId) body.docId = chatContext.docId
  if (extra && extra.start) body.start = true

  A.chatHandle = chatStream(body, {
    onMeta(meta) {
      if (!meta) return
      if (meta.demo) {
        showDemo(true)
        if (meta.fallback) ui.toast('上游模型暂不可用，已自动降级为演示模式', 'info', 4200)
      } else {
        showDemo(false)
      }
      A.turnMeta = { demo: !!meta.demo, chinese: !!(meta.chinese || A.thinkingChinese) }
      if (meta.doc && meta.doc.id) {
        A.readingDoc = { id: String(meta.doc.id), name: meta.doc.name || '', kind: meta.doc.kind || '' }
        if (typeof MODE_CTX !== 'undefined' && MODE_CTX.setStageChip) {
          MODE_CTX.setStageChip('📄', '阅读讲解 · ' + (meta.doc.name || '文档'))
        }
      }
      if (meta.chinese) {
        A.thinkingChinese = true
        // 状态已进入 thinking 且还没有正文时，立刻刷新为「教你怎么用英文说…」
        if (A.phase === 'thinking' && !A.firstDelta) {
          renderCaption()
          setPhase('thinking')
        }
      }
    },
    onDelta(deltaText) {
      if (A.phase !== 'thinking' && A.phase !== 'speaking') return
      const piece = String(deltaText || '')
      if (!piece) return
      if (!A.firstDelta) {
        A.firstDelta = true
        if (A.phase === 'thinking') {
          setPhase('thinking')
          safeAvatar('setState', 'thinking')
        }
      }
      A.replyText += piece
      A.revealTarget = A.replyText.length
      beginReveal()
      consumeSentences(false)
    },
    onFeedback(feedback) {
      handleFeedback(feedback)
      maybeDemoFallbackHint(feedback)
    },
    onDone(payload) {
      A.chatHandle = null
      A.streamDone = true
      const full = payload && typeof payload.fullReply === 'string' ? payload.fullReply : ''
      if (full && full.length > A.replyText.length && !A.replyText) A.replyText = full
      if (A.replyText.trim()) pushHistory({ role: 'assistant', content: A.replyText.trim() })
      consumeSentences(true)
      A.revealTarget = Math.max(A.revealTarget, A.replyText.length)
      beginReveal()
      void translateReplyText(A.replyText)
      maybeFinishTurn()
    },
    onError(err) {
      A.chatHandle = null
      A.streamDone = true
      clearSpeech()
      if (!A.replyText.trim()) {
        A.captionMode = 'placeholder'
        A.placeholder = '没有收到回复，再点麦克风试一次吧'
        D.captionReply.innerHTML = `<span class="caption-ph">${icon('alert')}${esc(A.placeholder)}</span>`
      } else {
        renderCaption()
      }
      setPhase('idle')
      safeAvatar('setState', 'idle')
      safeAvatar('setEmotion', 'sad')
      ui.toast(err && err.message ? err.message : '对话失败，请稍后重试', 'bad', 4600)
    },
  })
}

function handleFeedback(feedback) {
  const fb = feedback && typeof feedback === 'object' ? feedback : null
  if (!fb) return
  A.lastFeedback = fb
  const corrections = Array.isArray(fb.corrections) ? fb.corrections : []
  const better = Array.isArray(fb.better) ? fb.better : []
  const newWords = Array.isArray(fb.newWords) ? fb.newWords.filter((w) => w && w.word) : []
  A.session.corrections += corrections.length + better.length
  A.session.newWords += newWords.length

  // v1.5：豆包语音 free/roleplay 的 typed 文本消息同样不显示逐轮说教
  if (isQuietCoachMode() && !fb.chineseHelp) {
    A.lastFeedback = null
    bumpProgress({ turns: 1, minutes: 1 })
    renderFeedbackPanel(null)
    return
  }

  renderFeedbackPanel(fb)
  const reviewWords = addWordBank(newWords, { bump: false })
  bumpProgress({ turns: 1, minutes: 1, reviewWords })
  modes.onTeacherFeedback(fb)

  if (explainChinese() && fb.encouragement_zh) {
    showEncourageBubble(fb.encouragement_zh)
  }
  if (newWords.length || corrections.length) {
    ui.confetti(D.confetti, newWords.length ? 34 : 20)
    safeAvatar('setEmotion', 'proud')
  } else if (A.phase !== 'speaking') {
    safeAvatar('setEmotion', 'encouraging')
  }
  notifyFeedbackOnMobile(fb)
}

/** 移动端抽屉关闭时，用徽标 + 可点击 toast 提示有新的教练反馈。 */
function notifyFeedbackOnMobile(feedback) {
  if (!isMobile()) return
  if (D.main.classList.contains('drawer-open')) return
  const count =
    (Array.isArray(feedback.corrections) ? feedback.corrections.length : 0) +
    (Array.isArray(feedback.better) ? feedback.better.length : 0) +
    (Array.isArray(feedback.newWords) ? feedback.newWords.length : 0)
  const total = Math.max(1, count)
  if (D.drawerBadge) {
    const prev = Number(D.drawerBadge.textContent) || 0
    D.drawerBadge.textContent = String(prev + total)
    D.drawerBadge.hidden = false
  }
  ui.toast(
    `已生成 ${total} 条教练反馈，点这里查看`,
    'ok',
    4600,
    () => openDrawer({ focusFeedback: true }),
  )
}

function maybeFinishTurn() {
  if (A.phase === 'idle') return
  // 弹窗里点 🔊 的单词试听：播完直接回到 idle，不影响对话轮次
  if (A.previewSpeech) {
    if (A.speechRunning || A.speechQueue.length) return
    A.previewSpeech = false
    A.turnFinished = true
    setPhase('idle')
    safeAvatar('endSpeech')
    safeAvatar('setState', 'idle')
    A.highlight = -1
    renderCaption()
    return
  }
  if (A.turnFinished) return
  if (A.phase === 'thinking') return
  if (!A.streamDone) return
  if (A.speechRunning || A.speechQueue.length) return
  if (A.revealed < A.revealTarget) return
  A.turnFinished = true
  A.highlight = -1
  setPhase('idle')
  renderCaption()
  safeAvatar('endSpeech')
  safeAvatar('setState', 'idle')
  safeAvatar('setEmotion', 'neutral')
  safeAvatar('blink')
  if (getSettings().autoListen && A.lastInputVoice && A.sttSupported) {
    setTimeout(() => {
      if (A.phase === 'idle') startListening()
    }, 800)
  }
}

/** 打断：停止朗读、取消请求、回到 idle（保留已显示字幕）。 */
function interrupt() {
  if (A.volcSession || A.volcAudio) stopVolcCall()
  if (A.chatHandle) {
    try {
      A.chatHandle.abort()
    } catch {
      /* 忽略 */
    }
    A.chatHandle = null
  }
  A.streamDone = true
  A.speechSeq += 1
  A.speechQueue = []
  try {
    tts.cancel()
  } catch {
    /* 忽略 */
  }
  if (A.stt && A.stt.isActive) {
    try {
      A.stt.abort()
    } catch {
      /* 忽略 */
    }
  }
  A.interimText = ''
  A.turnFinished = true
  A.previewSpeech = false
  A.highlight = -1
  safeAvatar('endSpeech')
  safeAvatar('setState', 'idle')
  setPhase('idle')
  renderCaption()
}

/* ========================================================================== */
/* 语音识别                                                                    */
/* ========================================================================== */

/* ==========================================================================
   v1.2 中文求助：中文检测 / STT 语言切换 / Dock 中文按钮
   ========================================================================== */

/** thinking 阶段文案：中文求助时改为「教你怎么用英文说」。 */
function thinkingLabel() {
  return A.thinkingChinese ? 'Ava 正在教你怎么用英文说…' : 'Ava 正在思考…'
}

/** STT 回调集合（重建识别实例时复用）。 */
function sttHandlers() {
  return {
    onStart() {
      A.interimText = ''
      renderCaption()
    },
    onInterim(interim, detail) {
      const text = String(interim || (detail && detail.text) || '').trim()
      A.interimText = text
      renderCaption()
    },
    onFinal(text) {
      const value = String(text || '').trim()
      A.interimText = ''
      renderCaption()
      if (A.stt && A.stt.isActive) {
        try {
          A.stt.stop()
        } catch {
          /* 忽略 */
        }
      }
      if (!value) {
        setPhase('idle')
        safeAvatar('setState', 'idle')
        return
      }
      A.lastInputVoice = true
      if (A.zhRequested) resetChineseHelp()
      handleUserInput(value, { fromVoice: true })
    },
    onEnd() {
      A.interimText = ''
      renderCaption()
      if (A.phase === 'listening') {
        setPhase('idle')
        safeAvatar('setState', 'idle')
        D.micHint.textContent = A.micHintIdle || '点击麦克风开始说英语'
      }
    },
    onError(err) {
      A.interimText = ''
      renderCaption()
      setPhase('idle')
      safeAvatar('setState', 'idle')
      const code = err && err.code
      const message = err && err.message ? err.message : '语音识别出错'
      if (code === 'unsupported') {
        ui.toast('当前浏览器不支持语音识别，请使用 Chrome / Edge，或直接打字输入', 'bad', 5000)
        if (D.micHint) D.micHint.textContent = '当前浏览器不支持语音识别，请用下方输入框'
      } else if (code === 'denied' || code === 'not-allowed') {
        ui.toast('麦克风权限被拒绝：请在地址栏左侧允许麦克风后重试，或直接打字输入', 'bad', 5200)
      } else {
        ui.toast(message, 'bad', 4200)
      }
    },
  }
}

/**
 * 创建一个语音识别实例。
 * @param {'en-US'|'zh-CN'|string} lang
 * @returns {any}
 */
function createRecognition(lang) {
  return createSTT({ lang, silenceMs: 1400, ...sttHandlers() })
}

function initSTT() {
  const supported = typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  A.sttSupported = supported
  A.sttLang = A.sttLang || 'en-US'
  if (!supported) {
    if (D.micHint) D.micHint.textContent = '当前浏览器不支持语音识别，请用下方输入框'
    return
  }
  A.stt = createRecognition(A.sttLang)
}

/**
 * 切换语音识别语言（中文求助用）。
 * 优先调用 speech.js 的 `stt.setLang('zh-CN')`；旧版不支持时重建识别实例兜底。
 * @param {'en-US'|'zh-CN'} lang
 */
function setRecognitionLang(lang) {
  const target = pickSTTLang(lang)
  A.sttLang = target
  if (!A.sttSupported || !A.stt) return
  const wasActive = !!A.stt.isActive
  try {
    if (typeof A.stt.setLang === 'function') {
      A.stt.setLang(target)
      return
    }
  } catch {
    /* 忽略，走重建兜底 */
  }
  try {
    if (typeof A.stt.dispose === 'function') A.stt.dispose()
  } catch {
    /* 忽略 */
  }
  A.stt = createRecognition(target)
  if (wasActive) {
    A.phase = 'idle'
    setPhase('idle')
    startListening()
  }
}

/** 更新 Dock「中文求助」按钮的高亮与输入框提示。 */
function setChineseButtonState(on) {
  if (D.btnChinese) {
    D.btnChinese.classList.toggle('is-on', !!on)
    D.btnChinese.setAttribute('aria-pressed', on ? 'true' : 'false')
    D.btnChinese.title = on ? '中文求助已开启：说中文，Ava 教你怎么用英文说' : '中文求助：说中文，Ava 教你怎么用英文说'
  }
  if (D.textInput) {
    D.textInput.placeholder = on ? '现在可以直接打字说中文…' : '也可以打字说英文或中文…'
  }
}

/** 关闭中文求助：识别语言切回英文并取消按钮高亮。 */
function resetChineseHelp() {
  if (!A.zhRequested) return
  A.zhRequested = false
  setChineseButtonState(false)
  setRecognitionLang('en-US')
}

/** Dock「中文求助」按钮：切换中/英识别语言。 */
function toggleChineseHelp() {
  A.zhRequested = !A.zhRequested
  setChineseButtonState(A.zhRequested)
  if (A.zhRequested) {
    setRecognitionLang('zh-CN')
    ui.toast('现在可以说中文，Ava 会教你怎么用英文说', 'info', 3600)
  } else {
    setRecognitionLang('en-US')
    ui.toast('已切回英文识别，继续用英文聊吧', 'info', 2000)
  }
}

function startListening() {
  if (shouldUseVolc()) {
    void beginVolcCall()
    return
  }
  if (A.phase === 'listening') return
  if (!A.sttSupported || !A.stt) {
    ui.toast('当前浏览器不支持语音识别，请在下方输入框打字练习', 'info', 3600)
    D.textInput?.focus()
    return
  }
  if (A.phase === 'thinking') {
    ui.toast('Ava 还在思考，稍等一下', 'info', 1600)
    return
  }
  if (A.phase === 'speaking') interrupt()
  A.interimText = ''
  A.captionUser = ''
  A.targetWords = null
  A.turnFinished = true
  if (modes.getMode() === 'pronounce') {
    // 跟读模式保持目标句字幕
    setPhase('listening')
    renderCaption()
  } else {
    A.captionMode = 'placeholder'
    A.placeholder = '正在聆听…请说英语，说完停顿一下'
    setPhase('listening')
    renderCaption()
  }
  safeAvatar('setState', 'listening')
  safeAvatar('setEmotion', 'curious')
  if (D.micHint) D.micHint.textContent = '正在聆听…说完停顿即可'
  const ok = A.stt.start()
  if (!ok) {
    setPhase('idle')
    safeAvatar('setState', 'idle')
  }
}

function stopListening() {
  if (!A.stt) return
  try {
    A.stt.stop()
  } catch {
    /* 忽略 */
  }
}

/** 用户一条输入（语音或打字）。 */
function handleUserInput(text, opts = {}) {
  const value = String(text || '').trim()
  if (!value) return
  if (!opts.fromVoice) A.lastInputVoice = false
  D.captionUser.textContent = value
  D.captionUser.hidden = false
  D.captionInterim.hidden = true
  A.interimText = ''
  // 中文求助卡的「跟我读」：只评分，不进入闲聊
  if (A.followTarget) {
    const target = A.followTarget
    A.followTarget = null
    if (A.zhRequested) resetChineseHelp()
    void scoreFollowReading(target, value)
    return
  }
  // 阅读讲解：没有选中文档时先引导上传
  if (modes.getMode() === 'reading' && modes.isReadingReady && !modes.isReadingReady()) {
    ui.toast('先上传或选择一份英文材料，再和 Ava 讨论', 'info', 3200)
    return
  }
  // 本轮发送后自动切回英文识别
  if (A.zhRequested) resetChineseHelp()
  // 跟读/单词模式：练习发音，不进入闲聊
  if (modes.handleUtterance(value)) {
    setPhase('idle')
    safeAvatar('setState', 'idle')
    return
  }
  void sendToChat(value)
}

function toggleMic() {
  // 豆包实时语音模式（free / roleplay）：优先走实时语音链路
  if (shouldUseVolc()) {
    if (A.volcAudio) {
      interruptVolc()
      return
    }
    if (A.volcSession) {
      stopVolcCall()
      return
    }
    void beginVolcCall()
    return
  }
  if (A.phase === 'listening') {
    stopListening()
    return
  }
  if (A.phase === 'thinking' || A.phase === 'speaking') {
    interrupt()
    ui.toast('已停止，可以重新开始', 'info', 1400)
    return
  }
  startListening()
}

/* ========================================================================== */
/* 教练反馈 / 词库 / 进度                                                        */
/* ========================================================================== */

function renderFeedbackPanel(feedback) {
  if (!D.feedbackPanel) return
  // v1.5：豆包语音 free/roleplay 不显示逐轮说教（中文求助卡例外）
  if (isQuietCoachMode() && !(feedback && feedback.chineseHelp)) {
    D.feedbackPanel.innerHTML = ui.renderFeedbackQuiet()
    return
  }
  D.feedbackPanel.innerHTML = ui.renderFeedback(feedback, {
    explainChinese: explainChinese(),
    teacherName: teacherName(),
    followResult: A.followResult,
  })
  if (feedback) {
    const panelVisible = window.innerWidth >= 900 || D.main.classList.contains('drawer-open')
    if (panelVisible) {
      setTimeout(() => {
        try {
          D.panelScroll.scrollTo({ top: Math.max(0, D.feedbackPanel.offsetTop - 72), behavior: 'smooth' })
        } catch {
          /* 忽略 */
        }
      }, 90)
    }
  }
}

function showEncourageBubble(text) {
  if (!D.encourageBubble || !text) return
  D.encourageBubble.hidden = false
  D.encourageBubble.innerHTML = `${icon('check-circle')}${esc(text)}`
  clearTimeout(showEncourageBubble._timer)
  showEncourageBubble._timer = setTimeout(() => {
    D.encourageBubble.hidden = true
  }, 5200)
}

function addWordBank(words, opts = {}) {
  const added = []
  if (!Array.isArray(words)) return added
  const progressWords = A.progress && A.progress.words && typeof A.progress.words === 'object' ? A.progress.words : {}
  for (const item of words) {
    if (!item || !item.word) continue
    const key = String(item.word).trim().toLowerCase()
    if (!key) continue
    A.wordMeta[key] = {
      phonetic: item.phonetic || (A.wordMeta[key] && A.wordMeta[key].phonetic) || '',
      meaning: item.meaning || (A.wordMeta[key] && A.wordMeta[key].meaning) || '',
      example: item.example || (A.wordMeta[key] && A.wordMeta[key].example) || '',
    }
    if (!progressWords[key]) {
      progressWords[key] = { box: 0, due: Date.now(), seen: 0, correct: 0 }
      added.push({ word: key, correct: false })
    }
  }
  persistWordMeta()
  if (opts.bump !== false && added.length) bumpProgress({ reviewWords: added })
  return added
}

function bumpProgress(patch) {
  const pending = A.pendingProgress || { turns: 0, minutes: 0, reviewWords: [] }
  if (patch && Number(patch.turns)) pending.turns += Number(patch.turns)
  if (patch && Number(patch.minutes)) pending.minutes += Number(patch.minutes)
  if (patch && Array.isArray(patch.reviewWords)) pending.reviewWords.push(...patch.reviewWords)
  A.pendingProgress = pending
  if (A.progressTimer) clearTimeout(A.progressTimer)
  A.progressTimer = setTimeout(() => void flushProgress(), 650)
}

async function flushProgress() {
  const pending = A.pendingProgress
  A.pendingProgress = null
  A.progressTimer = null
  if (!pending) return
  const body = {}
  if (pending.turns > 0) body.turns = pending.turns
  if (pending.minutes > 0) body.minutes = Math.round(pending.minutes * 10) / 10
  if (pending.reviewWords.length) body.reviewWords = pending.reviewWords.slice(0, 50)
  if (!Object.keys(body).length) return
  try {
    const result = await saveProgress(body)
    const merged = (result && result.progress) || state.progress || A.progress
    if (merged) {
      A.progress = enrichProgress(merged)
      if (state) state.progress = A.progress
      updateStreakBadge()
      if (!D.modalProgress.hidden) renderProgressModal(A.progress)
    }
  } catch (err) {
    console.warn('[app] 进度保存失败：', err)
  }
}

function dueTs(rec) {
  const due = rec && rec.due
  if (typeof due === 'number') return due
  if (typeof due === 'string') {
    const parsed = Date.parse(due)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** 补算 totalWords / masteredWords / dueWords / dueCount（store 本地合并后这些派生字段可能过期）。 */
function enrichProgress(input) {
  const p = input && typeof input === 'object' ? { ...input } : {}
  const words = p.words && typeof p.words === 'object' ? p.words : {}
  const now = Date.now()
  const entries = Object.entries(words)
  const due = entries
    .filter(([, rec]) => dueTs(rec) <= now)
    .sort((a, b) => dueTs(a[1]) - dueTs(b[1]))
    .map(([word]) => word)
  p.words = words
  p.totalWords = entries.length
  p.masteredWords = entries.filter(([, rec]) => (Number(rec && rec.box) || 0) >= 3).length
  p.dueWords = due
  p.dueCount = due.length
  if (!Array.isArray(p.days)) p.days = []
  return p
}

function updateStreakBadge() {
  const streak = Number(A.progress && A.progress.streak) || 0
  if (!D.streakBadge) return
  D.streakBadge.hidden = streak <= 0
  D.streakBadge.textContent = String(streak)
}

/* ========================================================================== */
/* 设置弹窗                                                                    */
/* ========================================================================== */

function fillLevelSelect() {
  if (!D.levelSelect) return
  const levels = normalizeLevels((A.content && A.content.levels) || (A.settings && A.settings.levels))
  D.levelSelect.innerHTML = levels
    .map((lv) => `<option value="${esc(lv.id)}" title="${esc(lv.desc || '')}">${esc(lv.id)} · ${esc(lv.name)}</option>`)
    .join('')
  const current = level()
  D.levelSelect.value = levels.some((lv) => lv.id === current) ? current : levels[0] ? levels[0].id : 'A2'
}

function fillPresets() {
  if (!D.settingsPresets) return
  const list = (A.settings && A.settings.presets) || (A.content && A.content.presets) || []
  if (!Array.isArray(list) || !list.length) {
    D.settingsPresets.hidden = true
    return
  }
  D.settingsPresets.hidden = false
  D.settingsPresets.innerHTML = list
    .map(
      (p) =>
        `<button type="button" class="chip" data-preset="${esc(JSON.stringify({ baseUrl: p.baseUrl || '', model: p.model || '' }))}" title="${esc(p.baseUrl || '')}">${esc(p.name || '预设')}</button>`,
    )
    .join('')
}

async function loadVoices() {
  if (!D.setVoice) return
  let list = []
  try {
    list = await tts.getVoices()
  } catch {
    list = []
  }
  const en = (Array.isArray(list) ? list : []).filter((v) => v && (/^en/i.test(v.lang || '') || /english|ava|samantha|zira|aria|jenny/i.test(v.name || '')))
  const current = getSettings().voice || ''
  const options = [`<option value="">系统默认英文音色（推荐）</option>`]
  for (const v of en) {
    options.push(`<option value="${esc(v.name)}">${esc(v.name)} · ${esc(v.lang || '')}</option>`)
  }
  D.setVoice.innerHTML = options.join('')
  D.setVoice.value = en.some((v) => v.name === current) ? current : ''
  if (D.voiceHint) {
    D.voiceHint.textContent = en.length
      ? `共 ${en.length} 个英文音色可用，选择后点「试听音色」。`
      : '当前系统没有可用的英文音色，将使用浏览器默认音色（不影响对话与口型）。'
  }
}

function openSettings() {
  const s = getSettings()
  if (!D.modalSettings) return
  if (D.setBaseUrl) D.setBaseUrl.value = s.baseUrl || ''
  if (D.setModel) D.setModel.value = s.model || ''
  if (D.setApiKey) {
    D.setApiKey.value = ''
    D.setApiKey.placeholder = s.keyHint ? `已保存 ${s.keyHint}，留空则不修改` : 'sk-…（只保存在本机，不会回显）'
  }
  if (D.setKeyHint) {
    D.setKeyHint.innerHTML = s.keyHint
      ? `已保存密钥：<code>${esc(s.keyHint)}</code>，界面永不回显原文。`
      : '密钥仅保存在本机 <code>data/settings.json</code>，界面永不回显原文。'
  }
  if (D.setTeacher) D.setTeacher.value = s.teacherName || 'Ava'
  if (D.setExplain) D.setExplain.checked = s.explainChinese !== false
  if (D.setAutoListen) D.setAutoListen.checked = !!s.autoListen
  if (D.settingsDemoCallout) D.settingsDemoCallout.hidden = !!s.hasKey
  if (D.testResult) {
    D.testResult.textContent = s.hasKey ? '' : '当前未配置 Key，正在使用演示模式。'
    D.testResult.className = 'test-result ' + (s.hasKey ? '' : 'pending')
  }
  fillPresets()
  populateVoiceEngineSettings()
  void loadVoices()
  ui.openModal('modal-settings')
}

function collectSettingsPatch() {
  const patch = {
    baseUrl: D.setBaseUrl ? D.setBaseUrl.value.trim() : undefined,
    model: D.setModel ? D.setModel.value.trim() : undefined,
    teacherName: D.setTeacher ? D.setTeacher.value.trim() || 'Ava' : undefined,
    voice: D.setVoice ? D.setVoice.value : undefined,
    explainChinese: D.setExplain ? !!D.setExplain.checked : undefined,
    autoListen: D.setAutoListen ? !!D.setAutoListen.checked : undefined,
  }
  const key = D.setApiKey ? D.setApiKey.value.trim() : ''
  if (key) patch.apiKey = key
  // v1.4 语音引擎
  patch.voiceEngine = D.engineVolc && D.engineVolc.checked ? 'volc' : 'browser'
  patch.volc = collectVolcPatch()
  return patch
}

async function testConnection() {
  if (!D.btnTest) return
  const key = D.setApiKey ? D.setApiKey.value.trim() : ''
  const body = {
    baseUrl: D.setBaseUrl ? D.setBaseUrl.value.trim() : undefined,
    model: D.setModel ? D.setModel.value.trim() : undefined,
  }
  if (key) body.apiKey = key
  D.btnTest.disabled = true
  if (D.testResult) {
    D.testResult.textContent = '正在测试连接…'
    D.testResult.className = 'test-result pending'
  }
  try {
    const result = await postJSON('/api/settings/test', body, { timeoutMs: 70000 })
    if (result && result.ok) {
      const latency = Number(result.latencyMs) || 0
      if (D.testResult) {
        D.testResult.textContent = `连接成功 · ${result.model || body.model || ''} · ${latency}ms`
        D.testResult.className = 'test-result ok'
      }
    } else {
      if (D.testResult) {
        D.testResult.textContent = `连接失败：${(result && result.error) || '未知错误'}`
        D.testResult.className = 'test-result bad'
      }
    }
  } catch (err) {
    if (D.testResult) {
      D.testResult.textContent = `连接失败：${err && err.message ? err.message : '请检查网络或 Base URL'}`
      D.testResult.className = 'test-result bad'
    }
  } finally {
    D.btnTest.disabled = false
  }
}

async function saveSettingsFromModal() {
  if (!D.btnSaveSettings) return
  const patch = collectSettingsPatch()
  D.btnSaveSettings.disabled = true
  try {
    const saved = await api.saveSettings(patch)
    if (saved && typeof saved === 'object') {
      A.settings = { ...getSettings(), ...saved }
      A.voiceName = A.settings.voice || ''
      if (state) state.settings = A.settings
      syncVoiceSettingsAfterSave(saved, patch)
      renderFeedbackPanel(A.lastFeedback)
      fillLevelSelect()
      A.voiceName = A.settings.voice || ''
      await refreshServerMode()
      safeAvatar('setTeacherName', teacherName())
      safeAvatar('setLevel', level())
      refreshWordMeta()
      if (D.setApiKey) D.setApiKey.value = ''
      ui.closeModal('modal-settings')
      ui.toast('设置已保存并生效', 'ok')
      if (A.settings.hasKey) renderFeedbackPanel(A.lastFeedback)
    } else {
      ui.toast('保存失败：服务端没有返回设置', 'bad')
    }
  } catch (err) {
    ui.toast(err && err.message ? err.message : '保存设置失败', 'bad', 4200)
  } finally {
    D.btnSaveSettings.disabled = false
  }
}

async function clearSavedKey() {
  try {
    const saved = await api.saveSettings({ clearKey: true })
    if (saved && typeof saved === 'object') {
      A.settings = { ...getSettings(), ...saved }
      if (state) state.settings = A.settings
      await refreshServerMode()
      showDemo(true)
      if (D.settingsDemoCallout) D.settingsDemoCallout.hidden = false
      if (D.setApiKey) D.setApiKey.placeholder = 'sk-…（只保存在本机，不会回显）'
      if (D.setKeyHint) D.setKeyHint.innerHTML = '密钥仅保存在本机 <code>data/settings.json</code>，界面永不回显原文。'
      ui.toast('已清除保存的 API Key，当前为演示模式', 'info')
    }
  } catch (err) {
    ui.toast(err && err.message ? err.message : '清除失败', 'bad')
  }
}

function previewVoice() {
  const voice = D.setVoice ? D.setVoice.value : ''
  const text = "Hi, I'm Ava. Let's practice English together."
  try {
    tts.cancel()
    void tts.speak(text, { voice: voice || undefined, rate: speechRate() })
  } catch {
    ui.toast('当前浏览器不支持语音合成', 'bad')
  }
}

/* ========================================================================== */
/* 进度弹窗                                                                    */
/* ========================================================================== */

function refreshWordMeta() {
  const fromContent = ui.wordMetaFromContent(A.content)
  A.wordMeta = { ...loadWordMeta(), ...fromContent, ...A.wordMeta }
  persistWordMeta()
}

function renderProgressModal(progress) {
  const p = progress || A.progress || {}
  if (D.statGrid) D.statGrid.innerHTML = ui.renderProgressStats(p)
  if (D.progressChart) D.progressChart.innerHTML = ui.renderProgressChart(p)
  if (D.wordbankList) D.wordbankList.innerHTML = ui.renderWordbank(p, A.wordMeta)
  const due = Number(p && p.dueCount) || 0
  if (D.btnReviewWords) {
    D.btnReviewWords.disabled = due <= 0
    D.btnReviewWords.innerHTML = `${icon('refresh')}${due > 0 ? `复习 ${due} 个到期词` : '暂无到期词'}`
  }
}

async function openProgressModal() {
  ui.openModal('modal-progress')
  renderProgressModal(enrichProgress(A.progress))
  try {
    const fresh = await api.getProgress()
    if (fresh) {
      A.progress = enrichProgress(fresh)
      if (state) state.progress = A.progress
      updateStreakBadge()
      renderProgressModal(A.progress)
    }
  } catch (err) {
    ui.toast(err && err.message ? err.message : '进度读取失败', 'bad')
  }
}

/* ==========================================================================
   v1.2 中文求助卡交互（跟我读 / 打分） + 演示模式兜底提示
   ========================================================================== */

/**
 * 中文求助卡「跟我读」：录一段用户朗读，用 /api/score 对目标英文句打分。
 * @param {string} english
 */
function startFollowReading(english) {
  const target = String(english || '').trim()
  if (!target) return
  if (!A.sttSupported) {
    ui.toast('当前浏览器不支持语音识别，可以先点 🔊 听一遍，再自己读一次', 'info', 3800)
    return
  }
  if (A.phase === 'thinking' || A.phase === 'speaking') interrupt()
  A.followTarget = target
  A.followResult = null
  A.thinkingChinese = false
  renderFeedbackPanel(A.lastFeedback)
  startListening()
  ui.toast('请跟读这句英文，读完停顿一下', 'info', 2200)
}

/**
 * 跟读打分并写回中文求助卡。
 * @param {string} target
 * @param {string} transcript
 */
async function scoreFollowReading(target, transcript) {
  A.followTarget = null
  A.followResult = null
  A.thinkingChinese = false
  setPhase('thinking')
  safeAvatar('setState', 'thinking')
  if (D.captionReply) {
    D.captionReply.innerHTML = `<span class="thinking-dots"><i></i><i></i><i></i><em>正在给你的跟读打分…</em></span>`
  }
  try {
    const result = await api.score({ target, transcript })
    A.followResult = result
    const score = Number(result && result.score) || 0
    if (score >= 75) {
      safeAvatar('setEmotion', 'proud')
      safeAvatar('nod')
      ui.toast(`跟读 ${score} 分，这句读得不错`, 'ok', 2800)
    } else {
      safeAvatar('setEmotion', 'encouraging')
      ui.toast(`跟读 ${score} 分，点 🔊 再听一遍原句试试`, 'info', 3200)
    }
    renderFeedbackPanel(A.lastFeedback)
    // 字幕展示刚练的目标英文句（不进入对话历史）
    A.captionUser = ''
    A.captionMode = 'reply'
    A.replyText = target
    A.revealed = target.length
    A.revealTarget = target.length
    A.highlight = -1
    A.streamDone = true
    renderCaption()
    bumpProgress({ turns: 1, minutes: 0.3 })
  } catch (err) {
    ui.toast(err && err.message ? err.message : '跟读评分失败，请重试', 'bad', 3600)
  } finally {
    setPhase('idle')
    safeAvatar('endSpeech')
    safeAvatar('setState', 'idle')
  }
}

/**
 * 演示模式未命中脚本场景时提示一次（每会话最多一次）。
 * 判定：meta.demo=true 且非中文求助，且 feedback 没有 corrections/better/newWords。
 * @param {any} feedback
 */
function maybeDemoFallbackHint(feedback) {
  if (A.demoHintShown) return
  if (!A.turnMeta || !A.turnMeta.demo) return
  if (A.turnMeta.chinese) return
  const fb = feedback && typeof feedback === 'object' ? feedback : {}
  if (fb.chineseHelp) return
  const count = (arr) => (Array.isArray(arr) ? arr.length : 0)
  const hasFeedback =
    count(fb.corrections) > 0 ||
    count(fb.better) > 0 ||
    count(fb.newWords) > 0 ||
    String(fb.encouragement_zh || '').trim().length > 0
  if (hasFeedback) return
  A.demoHintShown = true
  ui.toast('演示模式只能按脚本接话，填入 API Key 后 Ava 才能真的回答你', 'info', 6000)
}

/* ==========================================================================
   v1.5 双语字幕（API 翻译，失败静默降级只显示英文）
   ========================================================================== */

/** 新的一轮对话开始：清空上一轮中文翻译，避免串行错位。 */
function resetBilingual() {
  A.translateSeq += 1
  A.userZhText = ''
  A.replyZhText = ''
  renderBilingual()
}

/** 同步中文第二行到字幕区（interim/占位态不显示）。 */
function renderBilingual() {
  if (!D.captionUserZh || !D.captionReplyZh) return
  const showUser = !!A.userZhText && !!A.captionUser && A.captionMode !== 'placeholder'
  D.captionUserZh.hidden = !showUser
  D.captionUserZh.textContent = showUser ? A.userZhText : ''
  const showReply = !!A.replyZhText && A.captionMode === 'reply'
  D.captionReplyZh.hidden = !showReply
  D.captionReplyZh.textContent = showReply ? A.replyZhText : ''
  if (showReply && D.caption) {
    requestAnimationFrame(() => {
      try {
        D.caption.scrollTop = D.caption.scrollHeight
      } catch {
        /* 忽略 */
      }
    })
  }
}

/**
 * 调翻译接口（api.translate 未落地时用 postJSON 兜底）；失败返回 null（静默）。
 * @param {string[]} texts
 * @returns {Promise<Array<string|null>|null>}
 */
async function translateTexts(texts) {
  const list = Array.isArray(texts) ? texts.filter((t) => typeof t === 'string' && t.trim()) : []
  if (!list.length) return null
  try {
    let res
    if (api && typeof api.translate === 'function') res = await api.translate(list, 'zh')
    else res = await postJSON('/api/translate', { texts: list, target: 'zh' }, { timeoutMs: 30000 })
    if (!res || res.ok === false) return null
    const arr = Array.isArray(res) ? res : Array.isArray(res.texts) ? res.texts : null
    if (!arr) return null
    return arr.map((v) => (typeof v === 'string' && v.trim() ? v.trim() : null))
  } catch {
    // 翻译失败静默：只显示英文，不弹 toast、不影响对话
    return null
  }
}

/** 用户侧中文翻译（用户说中文时中文即原文，不再重复显示）。 */
async function translateUserText(text) {
  const value = String(text || '').trim()
  if (!value || isChineseText(value)) return
  const token = A.translateSeq
  const result = await translateTexts([value])
  if (!result || !result[0]) return
  if (token !== A.translateSeq) return
  if (String(A.captionUser || '').trim() !== value) return
  A.userZhText = result[0]
  renderBilingual()
}

/** Ava 回复侧中文翻译（在回复结束后调用，不阻塞字幕/语音）。 */
async function translateReplyText(text) {
  const value = String(text || '').trim()
  if (!value) return
  const token = A.translateSeq
  const result = await translateTexts([value])
  if (!result || !result[0]) return
  if (token !== A.translateSeq) return
  if (String(A.replyText || '').trim() !== value) return
  A.replyZhText = result[0]
  renderBilingual()
}

/**
 * 豆包语音模式（free/roleplay、未回退）关闭逐轮说教：
 * 不调用 /api/coach、不渲染纠错/生词/鼓励卡，仅保留中文求助例外。
 * @returns {boolean}
 */
function isQuietCoachMode() {
  if (A.volcFallback) return false
  if (A.voiceEngine !== 'volc') return false
  return ['free', 'roleplay'].includes(modes.getMode())
}

/** 切换到「专注对话」占位（豆包语音模式下右栏教练面板）。 */
function renderCoachPlaceholderIfQuiet() {
  if (!isQuietCoachMode() || !D.feedbackPanel) return false
  if (A.lastFeedback && A.lastFeedback.chineseHelp) return false
  D.feedbackPanel.innerHTML = ui.renderFeedbackQuiet()
  return true
}

/* ==========================================================================
   v1.4 语音引擎（浏览器内置 / 豆包实时语音 3.0）
   ========================================================================== */

const VOLC_DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue'
const VOLC_DEFAULT_SPEAKER = 'en_female_dacey_uranus_bigtts'
const VOLC_DEFAULT_RESOURCE = 'volc.speech.dialog'
const VOLC_APPLICABLE_MODES = ['free', 'roleplay']

/** 当前生效的语音引擎（出错回退后本会话视为 browser）。 */
function effectiveVoiceEngine() {
  return A.voiceEngine === 'volc' && !A.volcFallback ? 'volc' : 'browser'
}

/** 豆包实时语音是否只在该模式下接管。 */
function isVolcApplicable() {
  return VOLC_APPLICABLE_MODES.includes(modes.getMode())
}

/** 是否已配置豆包凭据（服务端只回 hasKey/keyHint）。 */
function volcConfigured() {
  return !!(A.volc && A.volc.appId && A.volc.hasKey)
}

/** 当前点麦克风是否应走豆包实时语音。 */
function shouldUseVolc() {
  return effectiveVoiceEngine() === 'volc' && isVolcApplicable() && !A.volcFallback
}

/** 顶栏「豆包语音」小徽标。 */
function updateEnginePill() {
  if (!D.enginePill) return
  const show = effectiveVoiceEngine() === 'volc' && isVolcApplicable()
  D.enginePill.hidden = !show
  D.enginePill.title = A.volcFallback
    ? '豆包语音连接异常，本会话已回退浏览器语音（点击打开设置）'
    : '当前语音引擎：豆包实时语音 3.0（点击打开设置）'
}

/** 应用 settings 里的语音引擎字段（GET / PUT 返回）。 */
function applyVoiceSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {}
  A.voiceEngine = s.voiceEngine === 'volc' ? 'volc' : 'browser'
  const v = s.volc && typeof s.volc === 'object' ? s.volc : {}
  A.volc = {
    appId: String(v.appId || ''),
    hasKey: !!v.hasKey,
    keyHint: String(v.keyHint || ''),
    model: String(v.model || '3.0'),
    speaker: String(v.speaker || VOLC_DEFAULT_SPEAKER),
    endpoint: String(v.endpoint || VOLC_DEFAULT_ENDPOINT),
    resourceId: String(v.resourceId || VOLC_DEFAULT_RESOURCE),
  }
  A.volcFallback = false
  updateEnginePill()
}

/** 设置页：豆包配置区随引擎选择显示/隐藏。 */
function updateVoiceEngineUI() {
  const volcSelected = !!(D.engineVolc && D.engineVolc.checked)
  if (D.volcConfig) D.volcConfig.hidden = !volcSelected
}

/** 设置页：填充语音引擎相关字段。 */
function populateVoiceEngineSettings() {
  if (!D.engineBrowser || !D.engineVolc) return
  A.voiceEngine = A.voiceEngine === 'volc' ? 'volc' : 'browser'
  D.engineBrowser.checked = A.voiceEngine !== 'volc'
  D.engineVolc.checked = A.voiceEngine === 'volc'
  const v = A.volc || {}
  if (D.volcAppId) D.volcAppId.value = v.appId || ''
  if (D.volcModel) D.volcModel.value = v.model || '3.0'
  if (D.volcSpeaker) D.volcSpeaker.value = v.speaker || VOLC_DEFAULT_SPEAKER
  if (D.volcEndpoint) D.volcEndpoint.value = v.endpoint || VOLC_DEFAULT_ENDPOINT
  if (D.volcResource) D.volcResource.value = v.resourceId || VOLC_DEFAULT_RESOURCE
  if (D.volcApiKey) {
    D.volcApiKey.value = ''
    D.volcApiKey.placeholder = v.hasKey ? `已保存 ${v.keyHint || '凭据'}，留空则不修改` : '填写 API Key（与 Access Token 二选一）'
  }
  if (D.volcToken) {
    D.volcToken.value = ''
    D.volcToken.placeholder = v.hasKey ? '已保存凭据，留空则不修改' : '填写 Access Token（没有 API Key 时使用）'
  }
  if (D.volcKeyHint) {
    D.volcKeyHint.innerHTML = v.hasKey
      ? `已保存凭据：<code>${esc(v.keyHint || '已配置')}</code>，界面永不回显原文。`
      : '凭据只保存在本机 <code>data/settings.json</code>，界面永不回显原文。'
  }
  if (D.volcTestResult) {
    D.volcTestResult.textContent = ''
    D.volcTestResult.className = 'test-result'
  }
  updateVoiceEngineUI()
}

/** 收集豆包配置（含只写不回显的密钥）。 */
function collectVolcPatch() {
  const volc = {
    appId: D.volcAppId ? D.volcAppId.value.trim() : '',
    model: (D.volcModel ? D.volcModel.value.trim() : '') || '3.0',
    speaker: (D.volcSpeaker ? D.volcSpeaker.value.trim() : '') || VOLC_DEFAULT_SPEAKER,
    endpoint: (D.volcEndpoint ? D.volcEndpoint.value.trim() : '') || VOLC_DEFAULT_ENDPOINT,
    resourceId: (D.volcResource ? D.volcResource.value.trim() : '') || VOLC_DEFAULT_RESOURCE,
  }
  const apiKey = D.volcApiKey ? D.volcApiKey.value.trim() : ''
  const token = D.volcToken ? D.volcToken.value.trim() : ''
  if (apiKey) volc.apiKey = apiKey
  if (token) volc.accessToken = token
  return volc
}

/** 「测试连接」：调 /api/volc/test（未落地前用 postJSON 兜底）。 */
async function testVolcConnection() {
  if (!D.btnTestVolc) return
  const config = collectVolcPatch()
  D.btnTestVolc.disabled = true
  if (D.volcTestResult) {
    D.volcTestResult.textContent = '正在连接火山引擎…'
    D.volcTestResult.className = 'test-result pending'
  }
  try {
    let result
    if (api && typeof api.testVolc === 'function') result = await api.testVolc(config)
    else result = await postJSON('/api/volc/test', config, { timeoutMs: 65000 })
    if (result && result.ok) {
      const latency = Number(result.latencyMs) || 0
      if (D.volcTestResult) {
        D.volcTestResult.textContent = `连接成功 · ${result.model || config.model || '3.0'} · ${latency}ms`
        D.volcTestResult.className = 'test-result ok'
      }
    } else if (D.volcTestResult) {
      D.volcTestResult.textContent = `连接失败：${(result && result.error) || '未知错误'}`
      D.volcTestResult.className = 'test-result bad'
    }
  } catch (err) {
    if (D.volcTestResult) {
      D.volcTestResult.textContent = `连接失败：${err && err.message ? err.message : '请检查网络或凭据'}`
      D.volcTestResult.className = 'test-result bad'
    }
  } finally {
    D.btnTestVolc.disabled = false
  }
}

/** 清除已保存的豆包凭据。 */
async function clearVolcCredentials() {
  try {
    const saved = await api.saveSettings({ volc: { clearKey: true } })
    if (saved && typeof saved === 'object') {
      A.settings = { ...getSettings(), ...saved }
      if (state) state.settings = A.settings
      applyVoiceSettings(A.settings)
    }
    A.volc.hasKey = false
    A.volc.keyHint = ''
    if (D.volcKeyHint) D.volcKeyHint.innerHTML = '凭据只保存在本机 <code>data/settings.json</code>，界面永不回显原文。'
    if (D.volcApiKey) D.volcApiKey.placeholder = '填写 API Key（与 Access Token 二选一）'
    if (D.volcToken) D.volcToken.placeholder = '填写 Access Token（没有 API Key 时使用）'
    ui.toast('已清除豆包语音凭据', 'info')
    updateEnginePill()
  } catch (err) {
    ui.toast(err && err.message ? err.message : '清除凭据失败', 'bad')
  }
}

/* ------------------------- 豆包实时语音：加载/生命周期 -------------------- */

/** 动态加载 voice-dev 的 doubao-voice.js（兼容多种工厂命名）。 */
async function loadDoubaoModule() {
  if (A.doubaoFactory) return A.doubaoFactory
  try {
    const mod = await import('./doubao-voice.js')
    const factory =
      mod.createDoubaoVoice ||
      mod.createDoubaoRealtime ||
      mod.createDoubao ||
      mod.default ||
      mod.DoubaoVoice
    if (typeof factory !== 'function') throw new Error('doubao-voice.js 缺少工厂函数')
    A.doubaoFactory = factory
    return factory
  } catch (err) {
    console.warn('[app] 豆包语音模块加载失败：', err)
    return null
  }
}

/** 豆包语音回调绑定（实例只创建一次，start/stop 复用）。 */
function doubaoCallbacks() {
  return {
    onReady(info) {
      A.volcSession = true
      A.volcConnected = true
      A.volcAudio = false
      A.volcChatStarted = false
      setPhase('listening')
      if (D.statusText) D.statusText.textContent = '豆包语音 · 聆听中'
      if (D.micHint) D.micHint.textContent = '豆包语音 · 说完停顿即可（再点麦克风结束）'
      A.captionMode = 'placeholder'
      A.placeholder = '豆包语音聆听中，请说英语…'
      A.captionUser = ''
      renderCaption()
      safeAvatar('setState', 'listening')
      safeAvatar('setEmotion', 'curious')
      ui.toast(`豆包实时语音已连接${info && info.model ? ' · ' + info.model : ''}`, 'ok', 2400)
    },
    onASR(payload) {
      const data = payload && typeof payload === 'object' ? payload : { text: String(payload || ''), final: true }
      const text = String(data.text || '').trim()
      if (!text) return
      if (!data.final) {
        A.interimText = text
        renderCaption()
        return
      }
      A.interimText = ''
      renderCaption()
      A.volcAudio = false
      A.volcChatStarted = false
      A.lastInputVoice = true
      beginReplySession(text)
      void translateUserText(text)
      pushHistory({ role: 'user', content: text })
      A.session.turns += 1
      void requestCoachFeedback(text)
    },
    onChat(payload) {
      const data = payload && typeof payload === 'object' ? payload : { text: String(payload || ''), final: false }
      const text = String(data.text || '')
      if (text) {
        if (!A.volcChatStarted) {
          A.volcChatStarted = true
          A.replyText = ''
          A.revealed = 0
          A.revealTarget = 0
          A.highlight = -1
          A.streamDone = false
          A.captionMode = 'reply'
          A.captionUser = A.thinkingChinese ? '' : A.captionUser
        }
        A.replyText += text
        A.revealTarget = A.replyText.length
        beginReveal()
      }
      if (data.final) {
        A.streamDone = true
        if (A.replyText.trim()) pushHistory({ role: 'assistant', content: A.replyText.trim() })
        A.revealTarget = Math.max(A.revealTarget, A.replyText.length)
        beginReveal()
        void translateReplyText(A.replyText)
        maybeVolcFinish()
      }
    },
    onAudioStart() {
      A.volcAudio = true
      setPhase('speaking')
      safeAvatar('setState', 'speaking')
      safeAvatar('setSpeechLevel', 0)
    },
    onAudioEnd(payload) {
      A.volcAudio = false
      A.volcChatStarted = false
      safeAvatar('setSpeechLevel', 0)
      safeAvatar('endSpeech')
      const reason = payload && typeof payload === 'object' ? payload.reason : ''
      if (reason === 'interrupt' && A.volcSession) {
        setPhase('listening')
        if (D.statusText) D.statusText.textContent = '豆包语音 · 聆听中'
        if (D.micHint) D.micHint.textContent = '豆包语音 · 说完停顿即可（再点麦克风结束）'
        return
      }
      maybeVolcFinish()
    },
    onMicLevel(value) {
      const level01 = Math.max(0, Math.min(1, Number(value) || 0))
      safeAvatar('setMicLevel', level01)
    },
    onLevel(value) {
      let level01 = 0
      if (typeof value === 'number') level01 = value
      else if (value && typeof value === 'object') level01 = Number(value.level || value.value || value.amplitude || 0)
      level01 = Math.max(0, Math.min(1, Number(level01) || 0))
      if (A.avatar && typeof A.avatar.setSpeechLevel === 'function') {
        safeAvatar('setSpeechLevel', level01)
      }
    },
    onError(err) {
      handleVolcError(err)
    },
    onEnded(info) {
      A.volcSession = false
      A.volcConnected = false
      A.volcAudio = false
      if (A.phase !== 'idle') {
        setPhase('idle')
        safeAvatar('endSpeech')
        safeAvatar('setState', 'idle')
      }
      if (info && info.reason === 'error' && !A.volcFallback) handleVolcError(info)
      updateEnginePill()
    },
  }
}

/** 创建/复用豆包语音实例。 */
function ensureDoubaoInstance(factory) {
  if (A.doubao) return A.doubao
  if (typeof factory !== 'function') return null
  try {
    A.doubao = factory(doubaoCallbacks())
    return A.doubao
  } catch (err) {
    console.warn('[app] 创建豆包语音实例失败：', err)
    return null
  }
}

/** 豆包会话结束后的收尾（音频结束 + 文本 final → idle）。 */
function maybeVolcFinish() {
  if (!A.volcSession) return
  if (A.volcAudio) return
  if (!A.streamDone) return
  if (A.revealed < A.revealTarget) return
  A.turnFinished = true
  setPhase('idle')
  safeAvatar('endSpeech')
  safeAvatar('setState', 'idle')
  safeAvatar('setEmotion', 'neutral')
  renderCaption()
  if (D.micHint) D.micHint.textContent = A.micHintIdle || '点击麦克风开始说英语'
}

/** 开始一次豆包实时语音通话（点麦克风触发）。 */
async function beginVolcCall() {
  if (!isVolcApplicable()) return false
  if (A.volcSession) return true
  if (!volcConfigured()) {
    ui.toast('请先在设置页填写豆包实时语音凭据（App ID + API Key / Access Token）', 'info', 4200)
    openSettings()
    return false
  }
  if (A.phase === 'thinking' || A.phase === 'speaking') interrupt()
  if (A.stt && A.stt.isActive) {
    try {
      A.stt.abort()
    } catch {
      /* 忽略 */
    }
  }
  clearSpeech()
  A.volcFallback = false
  updateEnginePill()
  const factory = await loadDoubaoModule()
  if (!factory) {
    ui.toast('豆包语音模块未就绪，已使用浏览器语音', 'bad', 4200)
    fallbackToBrowserVoice()
    return false
  }
  const instance = ensureDoubaoInstance(factory)
  if (!instance) {
    ui.toast('豆包语音初始化失败，已使用浏览器语音', 'bad', 4200)
    fallbackToBrowserVoice()
    return false
  }
  if (instance.isSupported === false) {
    ui.toast('当前浏览器不支持豆包实时语音（需要麦克风与 AudioWorklet），已使用浏览器语音', 'bad', 4800)
    fallbackToBrowserVoice()
    return false
  }
  A.volcSession = true
  A.volcConnected = false
  A.volcAudio = false
  A.volcChatStarted = false
  A.turnFinished = false
  setPhase('thinking')
  if (D.statusText) D.statusText.textContent = '正在连接豆包语音…'
  if (D.micHint) D.micHint.textContent = '正在连接豆包语音…'
  A.captionMode = 'placeholder'
  A.placeholder = '正在连接豆包实时语音…'
  renderCaption()
  safeAvatar('setState', 'thinking')
  try {
    const started = instance.start({
      mode: modes.getMode(),
      level: level(),
      teacherName: teacherName(),
    })
    const okStart = started && typeof started.then === 'function' ? await started : started !== false
    if (!okStart && !A.volcFallback) {
      handleVolcError({ message: '豆包语音启动失败' })
      return false
    }
    return true
  } catch (err) {
    handleVolcError(err)
    return false
  }
}

/** 停止豆包会话（结束/切换模式/卸载）。 */
function stopVolcCall() {
  A.volcSession = false
  A.volcConnected = false
  A.volcAudio = false
  try {
    if (A.doubao && typeof A.doubao.stop === 'function') A.doubao.stop()
  } catch {
    /* 忽略 */
  }
  safeAvatar('endSpeech')
  if (A.phase !== 'idle') {
    setPhase('idle')
    safeAvatar('setState', 'idle')
  }
  updateEnginePill()
}

/** 打断豆包播报（保留会话，继续聆听）。 */
function interruptVolc() {
  A.volcAudio = false
  A.volcChatStarted = false
  try {
    if (A.doubao && typeof A.doubao.interrupt === 'function') A.doubao.interrupt()
  } catch {
    /* 忽略 */
  }
  safeAvatar('setSpeechLevel', 0)
  safeAvatar('endSpeech')
  if (A.volcSession) {
    setPhase('listening')
    if (D.statusText) D.statusText.textContent = '豆包语音 · 聆听中'
    if (D.micHint) D.micHint.textContent = '豆包语音 · 说完停顿即可（再点麦克风结束）'
  } else {
    setPhase('idle')
    safeAvatar('setState', 'idle')
  }
}

/** 豆包语音出错：中文 toast + 本会话回退浏览器语音。 */
function handleVolcError(err) {
  const message =
    err && typeof err === 'object'
      ? String(err.message || err.error || '豆包语音连接失败')
      : String(err || '豆包语音连接失败')
  A.volcFallback = true
  A.volcSession = false
  A.volcConnected = false
  A.volcAudio = false
  try {
    if (A.doubao && typeof A.doubao.stop === 'function') A.doubao.stop()
  } catch {
    /* 忽略 */
  }
  safeAvatar('endSpeech')
  setPhase('idle')
  safeAvatar('setState', 'idle')
  updateEnginePill()
  renderFeedbackPanel(A.lastFeedback)
  ui.toast(`${message}；本会话已回退浏览器语音`, 'bad', 5600)
  // 回退后自动用浏览器语音继续这次交互
  setTimeout(() => {
    if (A.phase === 'idle' && shouldUseBrowserFallbackVoice()) startListening()
  }, 400)
}

function shouldUseBrowserFallbackVoice() {
  return A.volcFallback && VOLC_APPLICABLE_MODES.includes(modes.getMode())
}

/** 豆包模式下用户语音 final 后调用 /api/coach 生成教学反馈。 */
async function requestCoachFeedback(userText) {
  // v1.5：豆包语音 free/roleplay 关闭逐轮反馈；仅中文求助例外
  if (isQuietCoachMode() && !isChineseText(userText)) {
    renderFeedbackPanel(null)
    bumpProgress({ turns: 1, minutes: 1 })
    return
  }
  const context = modes.getChatContext()
  const body = {
    message: userText,
    level: level(),
    mode: context.mode || 'free',
    history: A.history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
    chinese: isChineseText(userText),
  }
  try {
    let res
    if (api && typeof api.coach === 'function') res = await api.coach(body)
    else res = await postJSON('/api/coach', body, { timeoutMs: 65000 })
    const feedback = res && typeof res === 'object' ? res.feedback || res : null
    if (feedback && typeof feedback === 'object') handleFeedback(feedback)
  } catch (err) {
    ui.toast(err && err.message ? err.message : '教练反馈生成失败，本轮先继续对话', 'bad', 4200)
  }
}

/** 设置保存后同步引擎状态（服务端可能未返回新字段时做本地兜底）。 */
function syncVoiceSettingsAfterSave(saved, patch) {
  const merged = { ...getSettings(), ...(saved && typeof saved === 'object' ? saved : {}) }
  if (!merged.volc && patch && patch.volc) {
    merged.volc = {
      ...A.volc,
      ...patch.volc,
      hasKey: A.volc.hasKey || !!patch.volc.apiKey || !!patch.volc.accessToken,
      keyHint: A.volc.keyHint,
    }
  }
  if (!merged.voiceEngine && patch) merged.voiceEngine = patch.voiceEngine
  A.settings = merged
  if (state) state.settings = merged
  applyVoiceSettings(merged)
  if (effectiveVoiceEngine() !== 'volc' && A.volcSession) stopVolcCall()
}

/* ==========================================================================
   v1.1 结束对话并总结 / 今日单词表
   ========================================================================== */

/** 当前这一轮对话（用于总结；剔除空消息、截断超长内容）。 */
function currentRoundMessages() {
  return A.history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .slice(-40)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1500) }))
}

/** 本轮用户说了几句（总结至少要求 2 句）。 */
function countRoundUserMessages() {
  let n = 0
  for (const m of A.history) {
    if (m && m.role === 'user' && String(m.content || '').trim()) n += 1
  }
  return n
}

/** 打开总结弹窗（loading 态）。 */
function openSummaryModal() {
  if (!D.modalSummary || !D.summaryBody) return
  if (D.summaryFoot) D.summaryFoot.hidden = true
  D.summaryBody.innerHTML = ui.renderSummaryLoading()
  ui.openModal('modal-summary')
  try {
    D.summaryBody.scrollTop = 0
  } catch {
    /* 忽略 */
  }
}

/** 总结成功：渲染结果并刷新单词表徽标。 */
function showSummaryResult(summary) {
  if (!D.summaryBody) return
  A.lastSummary = summary
  D.summaryBody.innerHTML = ui.renderSummary(summary, {
    explainChinese: explainChinese(),
    teacherName: teacherName(),
  })
  if (D.summaryFoot) D.summaryFoot.hidden = false
  try {
    D.summaryBody.scrollTop = 0
  } catch {
    /* 忽略 */
  }
  setTimeout(() => D.btnSummaryContinue?.focus(), 80)
  const added = Number(summary && summary.addedCount) || 0
  if (added > 0) {
    ui.toast(`总结完成：${added} 个重点单词已加入今日单词表`, 'ok', 4600)
  } else {
    ui.toast('总结完成', 'ok', 2400)
  }
  void refreshWordbookBadge()
  void refreshProgressQuiet()
}

/** 总结失败：错误态 + 重试入口。 */
function showSummaryError(err) {
  if (!D.summaryBody) return
  if (D.summaryFoot) D.summaryFoot.hidden = true
  D.summaryBody.innerHTML = ui.renderSummaryError(err && err.message)
}

/** 请求总结（loading → 结果/错误）。 */
async function requestSummary(messages) {
  if (A.summaryLoading) return
  A.summaryLoading = true
  A.lastSummaryMessages = Array.isArray(messages) ? messages : []
  showSummaryLoading()
  try {
    const summary = await api.summarizeConversation({
      messages: A.lastSummaryMessages,
      level: level(),
      teacherName: teacherName(),
      mode: 'free',
    })
    showSummaryResult(summary)
  } catch (err) {
    showSummaryError(err)
    ui.toast(err && err.message ? err.message : '总结生成失败，请重试', 'bad', 4800)
  } finally {
    A.summaryLoading = false
  }
}

function showSummaryLoading() {
  if (!D.summaryBody) return
  if (D.summaryFoot) D.summaryFoot.hidden = true
  D.summaryBody.innerHTML = ui.renderSummaryLoading()
}

/** 「结束对话并总结」入口（校验轮次 → loading → 弹窗）。 */
async function endConversation() {
  if (modes.getMode() !== 'free') return
  if (A.summaryLoading) {
    ui.toast('Ava 正在整理上一次的总结，请稍等', 'info', 2000)
    return
  }
  if (A.volcSession || A.volcAudio) stopVolcCall()
  if (A.phase === 'listening') stopListening()
  if (A.phase === 'thinking' || A.phase === 'speaking') interrupt()
  const messages = currentRoundMessages()
  const userCount = countRoundUserMessages()
  if (userCount < 2) {
    ui.toast('先和 Ava 聊上两三句，再来总结吧', 'info', 3200)
    D.textInput?.focus()
    return
  }
  openSummaryModal()
  await requestSummary(messages)
}

/** 总结失败后重试（沿用同一批消息）。 */
function retrySummary() {
  if (A.summaryLoading) return
  const messages =
    Array.isArray(A.lastSummaryMessages) && A.lastSummaryMessages.length
      ? A.lastSummaryMessages
      : currentRoundMessages()
  if (!messages.length) {
    ui.toast('没有可总结的对话内容', 'info')
    return
  }
  openSummaryModal()
  void requestSummary(messages)
}

/** 「继续聊」：清空本轮，Ava 用新开场白开始新一轮（历史不跨轮）。 */
function startNewRound() {
  ui.closeModal('modal-summary')
  clearSpeech()
  if (A.stt && A.stt.isActive) {
    try {
      A.stt.abort()
    } catch {
      /* 忽略 */
    }
  }
  A.history = []
  if (state && Array.isArray(state.messages)) state.messages = []
  A.session = { turns: 0, newWords: 0, corrections: 0 }
  A.replyText = ''
  A.revealed = 0
  A.revealTarget = 0
  A.highlight = -1
  A.streamDone = true
  A.captionUser = ''
  A.interimText = ''
  A.targetCaption = null
  A.targetWords = null
  A.turnFinished = true
  A.lastFeedback = null
  renderFeedbackPanel(null)
  setPhase('idle')
  safeAvatar('endSpeech')
  safeAvatar('setState', 'idle')
  if (modes.getMode() !== 'free') modes.switchMode('free', { silent: false })
  else modes.startNewFreeRound()
}

/** 打开今日单词表弹窗并拉取数据。 */
async function openWordbook() {
  ui.openModal('modal-wordbook')
  if (D.wordbookBody) D.wordbookBody.innerHTML = ui.renderWordbookLoading()
  await loadWordbook(true)
}

/**
 * 加载单词表。
 * @param {boolean} showError 失败时是否在弹窗里展示错误态
 * @returns {Promise<any|null>}
 */
async function loadWordbook(showError) {
  try {
    const book = await api.getWordbook(7)
    A.wordbook = book
    if (D.wordbookBody) {
      D.wordbookBody.innerHTML = ui.renderWordbook(book, { explainChinese: explainChinese() })
    }
    updateWordbookBadge(book)
    return book
  } catch (err) {
    if (showError && D.wordbookBody) {
      D.wordbookBody.innerHTML = ui.renderWordbookError(err && err.message)
    }
    return null
  }
}

/** 后台刷新单词表徽标（失败静默，不影响主流程）。 */
async function refreshWordbookBadge() {
  return loadWordbook(false)
}

/** 顶栏单词本徽标 = 今天的单词数。 */
function updateWordbookBadge(book) {
  if (!D.wordbookBadge) return
  const today = (book && book.today) || ui.dateKey()
  const days = book && Array.isArray(book.days) ? book.days : []
  const day = days.find((d) => d && d.date === today) || (days.length ? days[0] : null)
  const count = Number(day && day.count) || 0
  D.wordbookBadge.hidden = count <= 0
  D.wordbookBadge.textContent = String(count)
  if (D.btnWordbook) {
    D.btnWordbook.title = count > 0 ? `今日单词表 · 今天新增 ${count} 个` : '今日单词表'
  }
}

/** 朗读单个单词/短句（不改动字幕，用于总结弹窗与单词表里的 🔊）。 */
function speakPreview(text) {
  const value = String(text || '').trim()
  if (!value) return
  clearSpeech()
  A.previewSpeech = true
  setPhase('speaking')
  safeAvatar('setState', 'speaking')
  enqueueSpeech(value, 0, { silent: true })
}

/** 静默刷新进度（总结会写入 SRS，进度数字需要更新）。 */
async function refreshProgressQuiet() {
  try {
    const fresh = await api.getProgress()
    if (fresh) {
      A.progress = enrichProgress(fresh)
      if (state) state.progress = A.progress
      updateStreakBadge()
    }
  } catch {
    /* 忽略 */
  }
}

/* ========================================================================== */
/* 布局：右栏折叠 / 移动端抽屉                                                  */
/* ========================================================================== */

const isMobile = () => window.matchMedia('(max-width: 899px)').matches

function setPanelCollapsed(collapsed) {
  if (isMobile()) {
    D.main.classList.toggle('drawer-open', !collapsed)
    if (D.drawerBackdrop) D.drawerBackdrop.hidden = collapsed
    D.btnUnfold.hidden = true
    return
  }
  D.main.classList.toggle('panel-collapsed', collapsed)
  D.btnUnfold.hidden = !collapsed
}

function openDrawer(options = {}) {
  clearDrawerBadge()
  ui.dismissClickableToasts()
  D.main.classList.add('drawer-open')
  if (D.drawerBackdrop) D.drawerBackdrop.hidden = false
  D.btnUnfold.hidden = true
  if (options.focusFeedback) {
    setTimeout(() => {
      try {
        D.panelScroll.scrollTo({ top: Math.max(0, D.feedbackPanel.offsetTop - 56), behavior: 'smooth' })
      } catch {
        /* 忽略 */
      }
    }, 260)
  }
}

function clearDrawerBadge() {
  if (D.drawerBadge) {
    D.drawerBadge.hidden = true
    D.drawerBadge.textContent = '0'
  }
}

function closeDrawer() {
  D.main.classList.remove('drawer-open')
  if (D.drawerBackdrop) D.drawerBackdrop.hidden = true
  D.btnUnfold.hidden = true
}

/* ========================================================================== */
/* 模式上下文（注入 modes.js）                                                  */
/* ========================================================================== */

const MODE_CTX = {
  getState: () => state,
  getContent: () => A.content,
  getSettings: () => getSettings(),
  getProgress: () => A.progress || {},
  getWordMeta: () => A.wordMeta,
  speak: (text) => {
    if (!text) return
    clearSpeech()
    setPhase('speaking')
    safeAvatar('setState', 'speaking')
    A.replyText = String(text)
    A.revealed = A.replyText.length
    A.revealTarget = A.replyText.length
    A.streamDone = true
    A.highlight = -1
    A.turnFinished = false
    A.captionMode = 'reply'
    A.captionUser = ''
    renderCaption()
    enqueueSpeech(text, 0)
  },
  stopSpeaking: () => {
    A.speechSeq += 1
    A.speechQueue = []
    try {
      tts.cancel()
    } catch {
      /* 忽略 */
    }
    safeAvatar('endSpeech')
    if (A.phase === 'speaking') setPhase('idle')
  },
  startListening: () => startListening(),
  fillInput: (text) => {
    if (!D.textInput) return
    D.textInput.value = String(text || '')
    try {
      D.textInput.focus()
      const len = D.textInput.value.length
      D.textInput.setSelectionRange(len, len)
    } catch {
      /* 忽略 */
    }
  },
  endConversation: () => void endConversation(),
  startReadingLecture: (doc) => {
    if (!doc || !doc.id) {
      ui.toast('先上传或选择一份英文材料', 'info', 2800)
      return
    }
    A.readingDoc = { id: String(doc.id), name: doc.name || '', kind: doc.kind || '' }
    void sendToChat('', { context: { mode: 'reading', docId: String(doc.id) }, start: true })
  },
  askNextQuestion: () => {
    const docId = modes.getReadingDocId ? modes.getReadingDocId() : null
    if (!docId) {
      ui.toast('先上传或选择一份英文材料', 'info', 2800)
      return
    }
    void sendToChat("Let's move on to the next question, please.", {
      context: { mode: 'reading', docId: String(docId) },
    })
  },
  setMicHint: (text) => {
    if (!text) return
    A.micHintIdle = text
    if (D.micHint && A.phase === 'idle') D.micHint.textContent = text
  },
  setCaptionPlaceholder: (text) => {
    A.captionMode = 'placeholder'
    A.placeholder = text || '点麦克风开始'
    A.captionUser = ''
    A.targetCaption = null
    A.targetWords = null
    renderCaption()
  },
  setCaptionTarget: (payload) => {
    A.captionMode = 'target'
    A.targetCaption = payload || null
    A.targetWords = null
    A.captionUser = ''
    renderCaption()
  },
  clearCaptionTarget: () => {
    A.targetCaption = null
    A.targetWords = null
    if (A.captionMode === 'target') {
      A.captionMode = 'placeholder'
      renderCaption()
    }
  },
  setCaptionScore: (words) => {
    A.targetWords = Array.isArray(words) ? words : null
    if (A.captionMode === 'target') renderCaption()
  },
  setStageChip: (emoji, text) => {
    if (!D.stageChip) return
    D.stageChip.hidden = false
    D.stageChipEmoji.textContent = emoji || '💬'
    D.stageChipText.textContent = text || ''
  },
  clearStageChip: () => {
    if (D.stageChip) D.stageChip.hidden = true
  },
  getAvatar: () => A.avatar,
  toast: (message, type = 'info') => ui.toast(message, type),
  celebrate: (text) => {
    ui.confetti(D.confetti, 32)
    if (text) showEncourageBubble(text)
    safeAvatar('setEmotion', 'proud')
    safeAvatar('setState', 'celebrate')
    setTimeout(() => {
      if (A.phase === 'idle') safeAvatar('setState', 'idle')
    }, 1200)
  },
  react: (kind) => {
    if (kind === 'correct') {
      safeAvatar('setEmotion', 'proud')
      safeAvatar('nod')
      safeAvatar('setState', 'celebrate')
      setTimeout(() => {
        if (A.phase === 'idle') safeAvatar('setState', 'idle')
      }, 900)
    } else if (kind === 'wrong') {
      safeAvatar('setEmotion', 'encouraging')
    } else if (kind === 'thinking') {
      safeAvatar('setEmotion', 'thinking')
    } else {
      safeAvatar('setEmotion', 'neutral')
    }
  },
  showTeacherText: (text, opts = {}) => {
    if (!text) return
    if (A.phase === 'thinking' && A.chatHandle) interrupt()
    clearSpeech()
    A.captionMode = 'reply'
    A.captionUser = ''
    A.replyText = String(text)
    A.revealed = A.replyText.length
    A.revealTarget = A.replyText.length
    A.highlight = -1
    A.streamDone = true
    A.targetCaption = null
    A.targetWords = null
    A.turnFinished = false
    renderCaption()
    pushHistory({ role: 'assistant', content: String(text) })
    void translateReplyText(String(text))
    if (opts.speak) {
      setPhase('speaking')
      safeAvatar('setState', 'speaking')
      enqueueSpeech(String(text), 0)
    } else {
      setPhase('idle')
    }
  },
  bumpProgress: (patch) => bumpProgress(patch),
  addWordBank: (words) => addWordBank(words),
  sessionStats: () => ({ ...A.session }),
  endSession: () => interrupt(),
  getTeacherName: () => teacherName(),
  getPhase: () => A.phase,
  getLevel: () => level(),
}

/* ========================================================================== */
/* 事件绑定                                                                    */
/* ========================================================================== */

let listenersBound = false

function bindEvents() {
  if (listenersBound) return
  listenersBound = true
  ui.bindModalChrome()

  D.micBtn.addEventListener('click', toggleMic)
  D.btnChinese?.addEventListener('click', toggleChineseHelp)
  D.enginePill?.addEventListener('click', () => openSettings())
  D.engineBrowser?.addEventListener('change', updateVoiceEngineUI)
  D.engineVolc?.addEventListener('change', updateVoiceEngineUI)
  D.btnTestVolc?.addEventListener('click', () => void testVolcConnection())
  D.btnClearVolc?.addEventListener('click', () => void clearVolcCredentials())
  D.volcConfig?.addEventListener('submit', (event) => event.preventDefault())
  window.addEventListener('pagehide', () => {
    try {
      if (A.doubao && typeof A.doubao.dispose === 'function') A.doubao.dispose()
    } catch {
      /* 忽略 */
    }
  })
  D.demoPill?.addEventListener('click', () => openSettings())
  D.feedbackPanel?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-speak], [data-follow]') : null
    if (!target) return
    const speak = target.getAttribute('data-speak')
    if (speak) {
      speakPreview(speak)
      return
    }
    const follow = target.getAttribute('data-follow')
    if (follow) startFollowReading(follow)
  })
  D.textForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const value = D.textInput.value.trim()
    if (!value) return
    D.textInput.value = ''
    if (A.phase === 'listening') stopListening()
    handleUserInput(value, { fromVoice: false })
  })

  D.levelSelect.addEventListener('change', async () => {
    const target = D.levelSelect.value
    try {
      const saved = await api.saveSettings({ level: target })
      if (saved && typeof saved === 'object') A.settings = { ...getSettings(), ...saved }
      else A.settings = { ...getSettings(), level: target }
      if (state) {
        state.settings = A.settings
        state.level = target
      }
      safeAvatar('setLevel', target)
      ui.toast(`已切换到 ${target} 难度，Ava 会调整用词和语速`, 'ok')
    } catch (err) {
      D.levelSelect.value = level()
      ui.toast(err && err.message ? err.message : '切换难度失败', 'bad')
    }
  })

  $$('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.getAttribute('data-mode') || 'free'
      if (mode === modes.getMode()) return
      if (A.phase !== 'idle' || A.volcSession) interrupt()
      if (state) state.mode = mode
      modes.switchMode(mode)
      updateEnginePill()
      renderFeedbackPanel(A.lastFeedback)
    })
  })

  D.btnWordbook?.addEventListener('click', () => void openWordbook())
  D.btnSummaryContinue?.addEventListener('click', () => startNewRound())
  D.btnSummaryWordbook?.addEventListener('click', () => {
    ui.closeModal('modal-summary')
    void openWordbook()
  })
  D.btnWordbookRefresh?.addEventListener('click', () => {
    if (D.wordbookBody) D.wordbookBody.innerHTML = ui.renderWordbookLoading()
    void loadWordbook(true)
  })
  D.summaryBody?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act], [data-speak]') : null
    if (!target) return
    const speak = target.getAttribute('data-speak')
    if (speak) {
      speakPreview(speak)
      return
    }
    if (target.getAttribute('data-act') === 'summary-retry') retrySummary()
  })
  D.wordbookBody?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act], [data-speak]') : null
    if (!target) return
    const speak = target.getAttribute('data-speak')
    if (speak) {
      speakPreview(speak)
      return
    }
    if (target.getAttribute('data-act') === 'wordbook-retry') void openWordbook()
  })

  D.btnSettings.addEventListener('click', openSettings)
  D.btnProgress.addEventListener('click', openProgressModal)
  D.streakBadge.addEventListener('click', openProgressModal)

  D.btnFold?.addEventListener('click', () => {
    if (isMobile()) closeDrawer()
    else setPanelCollapsed(true)
  })
  D.btnUnfold?.addEventListener('click', () => {
    if (isMobile()) openDrawer()
    else setPanelCollapsed(false)
  })
  D.drawerBackdrop?.addEventListener('click', closeDrawer)
  D.btnDrawer?.addEventListener('click', () => {
    if (D.main.classList.contains('drawer-open')) {
      closeDrawer()
    } else {
      const hasUnread = D.drawerBadge ? !D.drawerBadge.hidden : false
      openDrawer({ focusFeedback: hasUnread })
    }
  })

  $('#apikey-form')?.addEventListener('submit', (event) => event.preventDefault())
  D.btnSaveSettings?.addEventListener('click', saveSettingsFromModal)
  D.btnTest?.addEventListener('click', testConnection)
  D.btnClearKey?.addEventListener('click', clearSavedKey)
  D.btnVoicePreview?.addEventListener('click', previewVoice)
  D.btnGuide?.addEventListener('click', () => {
    ui.closeModal('modal-settings')
    showOnboarding()
  })
  D.settingsPresets?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-preset]') : null
    if (!target) return
    try {
      const preset = JSON.parse(target.getAttribute('data-preset') || '{}')
      if (D.setBaseUrl && preset.baseUrl) D.setBaseUrl.value = preset.baseUrl
      if (D.setModel && preset.model) D.setModel.value = preset.model
      ui.toast('已填入预设，点「测试连接」验证后保存', 'info', 2600)
    } catch {
      /* 忽略 */
    }
  })

  D.btnReviewWords?.addEventListener('click', () => {
    ui.closeModal('modal-progress')
    setTimeout(() => modes.openSrsReview(), 180)
  })

  D.btnObStart?.addEventListener('click', () => {
    dismissOnboarding()
    if (A.sttSupported) startListening()
    else {
      ui.toast('当前浏览器不支持语音识别，请用输入框打字练习', 'info', 4200)
      D.textInput?.focus()
    }
  })
  D.btnObType?.addEventListener('click', () => {
    dismissOnboarding()
    D.textInput?.focus()
  })

  // 空格快捷键：不在输入框/弹窗内时切换麦克风
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space') return
    const target = event.target
    if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
    if (target instanceof HTMLElement && target.isContentEditable) return
    const modalOpen = $$('.modal-layer').some((el) => !el.hidden) || !D.onboarding.hidden
    if (modalOpen) return
    event.preventDefault()
    toggleMic()
  })

  // 页面隐藏时停止聆听，避免后台占用麦克风
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return
    if (A.volcSession) stopVolcCall()
    else if (A.phase === 'listening') stopListening()
  })

  // Dock 高度 → CSS 变量：移动端 toast/浮层据此避让底部控制区
  if (D.dock && typeof ResizeObserver === 'function') {
    try {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const h = Math.round(entry.contentRect.height)
          if (h > 0) document.documentElement.style.setProperty('--dock-h', h + 'px')
        }
      })
      ro.observe(D.dock)
    } catch {
      /* 忽略 */
    }
  }

  window.addEventListener('resize', () => {
    // 从移动端切到桌面端时清理抽屉状态
    if (!isMobile()) {
      if (D.drawerBackdrop) D.drawerBackdrop.hidden = true
      D.main.classList.remove('drawer-open')
      D.btnUnfold.hidden = !D.main.classList.contains('panel-collapsed')
    }
  })
}

/* ========================================================================== */
/* 引导层                                                                      */
/* ========================================================================== */

function shouldShowOnboarding() {
  try {
    const params = new URLSearchParams(location.search)
    if (params.get('onboard') === '1') return true
    if (params.get('onboard') === '0') return false
  } catch {
    /* 忽略 */
  }
  try {
    return !localStorage.getItem('ava.onboarded.v1')
  } catch {
    return true
  }
}

function showOnboarding() {
  if (!D.onboarding) return
  D.onboarding.hidden = false
  if (D.obWarning) D.obWarning.hidden = A.sttSupported
  setTimeout(() => D.btnObStart?.focus(), 120)
}

function dismissOnboarding() {
  if (!D.onboarding) return
  D.onboarding.hidden = true
  try {
    localStorage.setItem('ava.onboarded.v1', '1')
  } catch {
    /* 忽略 */
  }
}

/* ========================================================================== */
/* 头像挂载                                                                    */
/* ========================================================================== */

async function mountAvatarModule() {
  try {
    const mod = await import('../avatar/avatar.js')
    if (mod && typeof mod.mountAvatar === 'function') {
      A.avatar = mod.mountAvatar(D.avatarStage, {
        teacherName: teacherName(),
        level: level(),
        theme: 'teal-violet',
      })
      if (A.avatar) {
        safeAvatar('setTeacherName', teacherName())
        safeAvatar('setLevel', level())
      }
    }
  } catch (err) {
    console.warn('[app] 数字人模块加载失败，使用占位舞台：', err)
  }
  if (!A.avatar) {
    if (D.stageFallback) {
      D.stageFallback.hidden = false
      const p = D.stageFallback.querySelector('p')
      if (p) p.textContent = '数字人暂时无法加载，语音与教学模式仍可正常使用'
    }
  }
}

/* ========================================================================== */
/* 初始化                                                                      */
/* ========================================================================== */

function cacheDom() {
  D.stage = $('#stage')
  D.avatarStage = $('#avatar-stage')
  D.stageFallback = $('#stage-fallback')
  D.stageChip = $('#stage-chip')
  D.stageChipEmoji = $('#stage-chip-emoji')
  D.stageChipText = $('#stage-chip-text')
  D.encourageBubble = $('#encourage-bubble')
  D.confetti = $('#stage-confetti')
  D.main = $('#main')
  D.sidepanel = $('#sidepanel')
  D.panelScroll = $('#panel-scroll')
  D.feedbackPanel = $('#feedback-panel')
  D.modePanel = $('#mode-panel')
  D.dockLeft = $('#dock-left')
  D.caption = $('#caption')
  D.captionUser = $('#caption-user')
  D.captionReply = $('#caption-reply')
  D.captionInterim = $('#caption-interim')
  D.captionUserZh = $('#caption-user-zh')
  D.captionReplyZh = $('#caption-reply-zh')
  D.statusLabel = $('#status-label')
  D.statusText = $('#status-text')
  D.micBtn = $('#btn-mic')
  D.micWrap = D.micBtn ? D.micBtn.closest('.mic-wrap') : null
  D.micHint = $('#mic-hint')
  D.textForm = $('#text-form')
  D.textInput = $('#text-input')
  D.btnSend = $('#btn-send')
  D.levelSelect = $('#level-select')
  D.demoPill = $('#demo-pill')
  D.btnProgress = $('#btn-progress')
  D.btnSettings = $('#btn-settings')
  D.streakBadge = $('#streak-badge')
  D.btnFold = $('#btn-fold')
  D.btnUnfold = $('#btn-unfold')
  D.drawerBackdrop = $('#drawer-backdrop')
  D.btnDrawer = $('#btn-drawer')
  D.drawerBadge = $('#drawer-badge')
  D.btnChinese = $('#btn-chinese')
  D.enginePill = $('#engine-pill')
  D.engineBrowser = $('#engine-browser')
  D.engineVolc = $('#engine-volc')
  D.volcConfig = $('#volc-config')
  D.volcAppId = $('#volc-appid')
  D.volcApiKey = $('#volc-apikey')
  D.volcToken = $('#volc-token')
  D.volcModel = $('#volc-model')
  D.volcSpeaker = $('#volc-speaker')
  D.volcEndpoint = $('#volc-endpoint')
  D.volcResource = $('#volc-resource')
  D.volcKeyHint = $('#volc-key-hint')
  D.volcTestResult = $('#volc-test-result')
  D.btnTestVolc = $('#btn-test-volc')
  D.btnClearVolc = $('#btn-clear-volc')
  D.btnWordbook = $('#btn-wordbook')
  D.wordbookBadge = $('#wordbook-badge')
  D.modalSummary = $('#modal-summary')
  D.summaryBody = $('#summary-body')
  D.summaryFoot = $('#summary-foot')
  D.btnSummaryContinue = $('#btn-summary-continue')
  D.btnSummaryWordbook = $('#btn-summary-wordbook')
  D.modalWordbook = $('#modal-wordbook')
  D.wordbookBody = $('#wordbook-body')
  D.btnWordbookRefresh = $('#btn-wordbook-refresh')
  D.dock = $('#dock')

  D.modalSettings = $('#modal-settings')
  D.setBaseUrl = $('#set-baseurl')
  D.setModel = $('#set-model')
  D.setApiKey = $('#set-apikey')
  D.setKeyHint = $('#set-key-hint')
  D.setVoice = $('#set-voice')
  D.voiceHint = $('#voice-hint')
  D.setTeacher = $('#set-teacher')
  D.setExplain = $('#set-explain')
  D.setAutoListen = $('#set-autolisten')
  D.testResult = $('#test-result')
  D.btnTest = $('#btn-test')
  D.btnSaveSettings = $('#btn-save-settings')
  D.btnClearKey = $('#btn-clear-key')
  D.btnVoicePreview = $('#btn-voice-preview')
  D.btnGuide = $('#btn-guide')
  D.settingsPresets = $('#settings-presets')
  D.settingsDemoCallout = $('#settings-demo-callout')

  D.modalProgress = $('#modal-progress')
  D.statGrid = $('#stat-grid')
  D.progressChart = $('#progress-chart')
  D.wordbankList = $('#wordbank-list')
  D.btnReviewWords = $('#btn-review-words')

  D.onboarding = $('#onboarding')
  D.obWarning = $('#ob-warning')
  D.btnObStart = $('#btn-ob-start')
  D.btnObType = $('#btn-ob-type')
}

async function loadData() {
  try {
    await loadAll()
  } catch (err) {
    console.warn('[app] loadAll 失败，使用独立接口兜底：', err)
  }
  A.settings = state.settings || null
  A.content = state.content && Array.isArray(state.content.topics) && state.content.topics.length ? state.content : null
  A.progress = state.progress || null

  if (!A.settings) {
    try {
      A.settings = await api.getSettings()
    } catch (err) {
      console.warn('[app] 读取设置失败：', err)
    }
  }
  if (!A.content) {
    try {
      A.content = await api.getContent()
    } catch (err) {
      console.warn('[app] 读取内容失败：', err)
    }
  }
  if (!A.progress) {
    try {
      A.progress = await api.getProgress()
    } catch (err) {
      console.warn('[app] 读取进度失败：', err)
    }
  }
  if (A.content && (!Array.isArray(A.content.topics) || !A.content.topics.length)) {
    try {
      const fresh = await api.getContent()
      if (fresh && Array.isArray(fresh.topics) && fresh.topics.length) A.content = fresh
    } catch (err) {
      console.warn('[app] 内容库为空且重新拉取失败：', err)
    }
  }

  const fallbackSettings = {
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
  A.settings = { ...fallbackSettings, ...(A.settings || {}) }
  A.voiceName = A.settings.voice || ''
  if (state) {
    state.settings = A.settings
    state.mode = modes.getMode ? modes.getMode() : 'free'
    state.level = A.settings.level || 'A2'
  }

  try {
    A.health = await api.health()
  } catch {
    A.health = null
  }
  const hasKey = A.settings.hasKey || (A.health && A.health.hasKey)
  A.progress = enrichProgress(A.progress)
  if (state) state.progress = A.progress
  applyVoiceSettings(A.settings)
  showDemo(!hasKey)
  updateStreakBadge()
  refreshWordMeta()
  void refreshWordbookBadge()
}

async function boot() {
  cacheDom()
  bindEvents()
  initSTT()

  await loadData()

  fillLevelSelect()
  renderFeedbackPanel(null)
  await mountAvatarModule()

  modes.initModes(MODE_CTX)
  modes.switchMode('free', { silent: true })
  updateEnginePill()

  if (isMobile()) {
    D.btnUnfold.hidden = true
    if (D.drawerBackdrop) D.drawerBackdrop.hidden = true
  } else if (!D.main.classList.contains('panel-collapsed')) {
    D.btnUnfold.hidden = true
  }

  if (shouldShowOnboarding()) {
    showOnboarding()
  } else if (!A.sttSupported) {
    D.micHint && (D.micHint.textContent = '当前浏览器不支持语音识别，请用输入框')
  }

  // 预热音色列表（不阻塞）
  try {
    void tts.getVoices()
  } catch {
    /* 忽略 */
  }

  console.info('[Ava] 应用已就绪 ·', A.demo ? '演示模式' : 'AI 模式', '·', level())
}

boot().catch((err) => {
  console.error('[Ava] 初始化失败：', err)
  ui.toast('Ava 初始化失败，请刷新页面重试', 'bad', 6000)
})

// 供 QA / 控制台调试使用（只读接口）
if (typeof window !== 'undefined') {
  window.__ava = {
    get phase() {
      return A.phase
    },
    get mode() {
      return modes.getMode()
    },
    get demo() {
      return A.demo
    },
    get settings() {
      return getSettings()
    },
    get content() {
      return A.content
    },
    get progress() {
      return A.progress
    },
    get reply() {
      return A.replyText
    },
    send: (text) => handleUserInput(String(text || ''), { fromVoice: false }),
    interrupt,
    openSettings,
    openProgress: openProgressModal,
    endConversation: () => void endConversation(),
    openWordbook: () => void openWordbook(),
    get zhRequested() {
      return A.zhRequested
    },
    get sttLang() {
      return A.sttLang
    },
    get sttActualLang() {
      try {
        return A.stt && typeof A.stt.lang === 'string' ? A.stt.lang : null
      } catch {
        return null
      }
    },
    get lastFeedback() {
      return A.lastFeedback
    },
    startNewRound,
    get reading() {
      return modes.getReadingState ? modes.getReadingState() : null
    },
    get readingDocId() {
      return modes.getReadingDocId ? modes.getReadingDocId() : null
    },
    get voiceEngine() {
      return effectiveVoiceEngine()
    },
    get configuredEngine() {
      return A.voiceEngine
    },
    get volcConfigured() {
      return volcConfigured()
    },
    get volcSession() {
      return A.volcSession
    },
    get volcFallback() {
      return A.volcFallback
    },
    get doubaoReady() {
      return !!A.doubao
    },
    modes,
  }
}
