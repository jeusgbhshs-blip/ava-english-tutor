/**
 * Ava 手机版 · 全屏通话页
 * 语音引擎：豆包实时语音（/ws/voice + doubao-voice.js，start 带 characterId）
 *          失败/未配置时回退浏览器语音；文本输入走 /api/chat（带 characterId）。
 * 双语字幕：/api/translate，失败静默只显示英文。
 * @module mobile/call
 */
import {
  $, $$, esc, icon, toast, ui, M, chatStream, api, getJSON, postJSON,
  translateTexts, fetchSummary, showWordbookSheet, mmss, characterById,
} from './core.js'
import { createSTT, tts } from '../speech.js'

const C = {
  open: false,
  character: null,
  sceneIdx: 0,
  scene: null,
  startedAt: 0,
  timer: null,
  bubbles: [],
  messages: [],
  state: 'idle',
  translateOn: true,
  muted: false,
  engine: 'browser',
  volc: null,
  volcLoading: null,
  stt: null,
  chatHandle: null,
  bubbleSeq: 0,
  userTurns: 0,
  endAfterSheet: false,
  interimEl: null,
  hintTimer: null,
  bound: false,
  head: null,
  headChar: null,
  motion: null,
  speechTimer: null,
  speechPhase: 0,
  headToken: 0,
  dialogueText: '',
  dialogueZh: null,
  dialogueBubbleId: null,
  lastUserLine: '',
  materialStarted: false,
  kbMode: 'free',
  kbDocIds: [],
  kbDocTitles: [],
  kbHits: [],
  lesson: null,
  lessonStageId: '',
  lessonStep: 0,
  lessonPhraseIdx: 0,
  lessonAttempts: 0,
  lessonPassed: [],
  lessonPracticeTurns: 0,
  lessonChallengeTurns: 0,
  lessonDone: false,
  lessonSubmitting: false,
  lessonPanelOpen: true,
  lessonUsedPhrase: false,
  lessonControlsBound: false,
  lessonPersistTimer: null,
  lessonPersistPending: null,
  lessonPersistChain: null,
  lessonPersistBound: false,
  docs: { open: false, loading: false, error: '', docs: [], activeId: '', activeChunk: '', activeSentence: '', follow: true, fontSize: 14, token: 0, followToken: 0, hasFetched: false, loadedIds: '', autoScroll: false, bound: false, readToken: 0 },
  lastAsrText: '',
  lastAsrAt: 0,
  ptt: 'idle',
  pttStartedAt: 0,
  pttTimer: null,
  pttInterim: '',
  pttFragments: [],
  pttResolver: null,
  pttRestartTimer: null,
  pttSubmitTimer: null,
  pttErrorShown: false,
  pttVolcAttempt: false,
  pttMicLevel: 0,
  pttPeak: 0,
  pttHadSound: false,
  pttLastSoundAt: 0,
  pttSoundHintShown: false,
  pttLevelSeen: false,
  pttAsrSeen: false,
  pttReplySeen: false,
  pttAsrTimer: null,
  pttReplyTimer: null,
  audioStallTimer: null,
  teacherTurnTimer: null,
  turnAudioBytes: 0,
  lastTeacherAudioAt: 0,
  pttLastAsrAt: 0,
  volcResets: 0,
  volcRecovering: false,
  volcRecoverAt: 0,
  closingCall: false,
  ttsFallbackAt: 0,
  ttsFallbackNotified: false,
  groundedTtsToken: 0,
  volcWarmTimer: null,
  volcWarmPromise: null,
  volcWarming: false,
  pttToken: 0,
  volcToken: -1,
  pttAudioTimer: null,
  pttWatch: null,
  pttCommitted: false,
  autoReplyNotified: false,
  summaryToken: 0,
  lastAutoReplyInterruptAt: 0,
  mic: { state: 'idle', stream: null, ctx: null, analyser: null, data: null, loop: null, pending: null, level: 0, active: false, silentSince: 0, silentNotified: false, env: null },
}

/* ------------------------------ DOM 快捷方式 ------------------------------ */
const D = {}
function cacheDom() {
  D.call = $('#call')
  D.bg = $('#call-bg')
  D.glow = $('#call-glow')
  D.cover = $('#call-cover-img')
  D.coverFallback = $('#call-cover-fallback')
  D.head = $('#talking-host')
  D.particles = $('#call-particles')
  D.dialogue = $('#call-dialogue')
  D.dlgName = $('#cd-name')
  D.dlgEn = $('#cd-en')
  D.dlgZh = $('#cd-zh')
  D.dlgUser = $('#cd-user')
  D.historyBtn = $('#call-history-btn')
  D.historyLabel = $('#call-history-label')
  D.dlgState = $('#cd-status')
  D.kbBar = $('#call-mode-row')
  D.citations = $('#call-citations')
  D.lesson = $('#call-lesson')
  D.lessonEmoji = $('#cl-emoji')
  D.lessonTitle = $('#cl-title')
  D.lessonSub = $('#cl-sub')
  D.lessonToggle = $('#cl-toggle')
  D.lessonSteps = $('#cl-steps')
  D.lessonGoals = $('#cl-goals')
  D.lessonTask = $('#cl-task')
  D.lessonStatus = $('#cl-status')
  D.lessonPhrases = $('#cl-phrases')
  D.docs = $('#call-docs')
  D.docsHandle = $('#call-docs-handle')
  D.docsHead = $('#call-docs-head')
  D.docsTabs = $('#call-docs-tabs')
  D.docsBody = $('#call-docs-body')
  D.docsStatus = $('#call-docs-status')
  D.docsFollow = $('#docs-follow')
  D.docsFontDec = $('#docs-font-dec')
  D.docsFontInc = $('#docs-font-inc')
  D.docsCollapse = $('#docs-collapse')
  D.docsClose = $('#docs-close')
  D.ptt = $('#call-ptt')
  D.pttTimer = $('#ptt-timer')
  D.pttWave = $('#ptt-wave')
  D.pttCancel = $('#ptt-cancel')
  D.pttWave = $('#ptt-wave')
  D.pttHint = $('#ptt-hint')
  D.micDock = $('#mic-dock')
  D.micDot = $('#mic-dot')
  D.micLabel = $('#mic-label')
  D.micVolume = $('#mic-volume')
  D.micExtra = $('#mic-extra')
  D.micMessage = $('#mic-message')
  D.micRetry = $('#mic-retry')
  D.micTextBtn = $('#mic-text-btn')
  D.micDiagBtn = $('#mic-diag-btn')
  D.envBanner = $('#call-env-banner')
  D.name = $('#call-name')
  D.sub = $('#call-sub')
  D.timer = $('#call-timer')
  D.signal = $('#call-signal-label')
  D.bubbles = $('#call-bubbles')
  D.hint = $('#call-hint')
  D.mute = $('#call-toggle-mute')
  D.translate = $('#call-toggle-translate')
  D.hintBtn = $('#call-hint-btn')
  D.talk = $('#call-talk')
  D.talkLabel = $('#call-talk-label')
  D.textBtn = $('#call-text-btn')
  D.textForm = $('#call-textform')
  D.textInput = $('#call-text-input')
  D.hangup = $('#call-hangup')
  D.back = $('#call-back')
  D.call.classList.add('call')
}

/* ------------------------------ 状态渲染 ------------------------------ */
const LABELS = {
  idle: () => '点一下麦克风开始说话',
  listening: () => (C.ptt === 'recording' ? '正在录音… 再点一次麦克风结束' : '正在聆听…'),
  thinking: () => 'Ava 正在回应…',
  speaking: () => 'Ava 正在说话…',
}

function setState(state) {
  C.state = state
  D.call.classList.toggle('is-listening', state === 'listening')
  D.call.classList.toggle('is-thinking', state === 'thinking')
  D.call.classList.toggle('is-speaking', state === 'speaking')
  if (D.talkLabel && C.ptt !== 'connecting') D.talkLabel.textContent = LABELS[state] ? LABELS[state]() : ''
  syncHeadMode(state)
  updateDialogueStatus(state)
  if (state === 'speaking' && C.engine !== 'volc') startSpeechPulse()
  else stopSpeechPulse()
  if (D.signal) {
    D.signal.textContent =
      C.engine === 'volc'
        ? state === 'speaking'
          ? '实时语音 · Ava 说话中'
          : state === 'listening'
            ? '实时语音 · 聆听中'
            : '实时语音 · 就绪'
        : state === 'speaking'
          ? '浏览器语音 · 说话中'
          : state === 'listening'
            ? '浏览器语音 · 聆听中'
            : '浏览器语音 · 就绪'
  }
  // PTT 状态跟随回复阶段（录音/提交中由 PTT 自身控制）
  if (C.ptt !== 'recording' && C.ptt !== 'connecting') {
    if (state === 'speaking' && C.ptt !== 'speaking') setPttState('speaking')
    else if (state === 'idle' && C.ptt !== 'idle') setPttState('idle')
  }
}

function updateEngineLabel() {
  if (D.signal && C.state === 'idle') {
    D.signal.textContent = C.engine === 'volc' ? '实时语音 · 已就绪' : '浏览器语音 · 就绪'
  }
  if (D.talkLabel && C.state === 'idle') D.talkLabel.textContent = LABELS.idle()
}

/* ------------------------------ 知识库/发散模式 + 引用卡片（v1.8） ------------------------------ */
const KB_MODES = {
  free: { emoji: '💬', label: '自由聊' },
  grounded: { emoji: '📚', label: '知识库讨论' },
  divergent: { emoji: '🌱', label: '发散讨论' },
}

function renderKbBar() {
  if (!D.kbBar) return
  // v4.0 方案 C：自由聊且没有知识库材料时，收起右上角模式切换，保持页面干净
  const docsReady = docsAvailable()
  if (C.kbMode === 'free' && !docsReady && !C.kbDocIds.length) {
    D.kbBar.hidden = true
    D.kbBar.innerHTML = ''
    return
  }
  D.kbBar.hidden = false
  const meta = KB_MODES[C.kbMode] || KB_MODES.free
  const titles = C.kbDocTitles.length ? C.kbDocTitles : C.kbDocIds.map((id) => id)
  const materials = titles.length ? `材料：${titles.slice(0, 3).join('、')}${titles.length > 3 ? ' 等 ' + titles.length + ' 篇' : ''}` : ''
  D.kbBar.innerHTML = `
    <button type="button" class="kb-mode-chip" id="call-mode-chip" title="切换对话模式">
      <span class="kb-mode-emoji">${meta.emoji}</span>
      <span class="kb-mode-label">${meta.label}</span>
      <span class="kb-mode-switch">切换</span>
    </button>
    ${materials ? `<div class="call-materials-line">${esc(materials)}</div>` : C.kbMode === 'grounded' ? '<div class="call-materials-line is-warn">未选材料 · 去助手页「知识库」勾选</div>' : ''}
    ${docsAvailable() ? `<button type="button" class="kb-docs-btn" id="call-docs-btn" aria-expanded="${C.docs.open ? 'true' : 'false'}" aria-controls="call-docs">${icon('book')}<span class="kb-docs-label">${C.docs.open ? '收起资料' : '资料'}</span></button>` : ''}`
}

function cycleKbMode() {
  const order = ['free', 'grounded', 'divergent']
  const index = order.indexOf(C.kbMode)
  const prevKbMode = C.kbMode
  C.kbMode = order[(index + 1) % order.length]
  if (prevKbMode !== C.kbMode) {
    if (C.kbMode !== 'grounded') void stopCharacterVoice()
    try {
      if (C.volc && typeof C.volc.setOutputMuted === 'function') C.volc.setOutputMuted(materialTtsMode())
    } catch {
      /* 忽略 */
    }
  }
  renderKbBar()
  if (docsAvailable()) {
    if (C.kbMode === 'free') closeDocsPanel()
    else if (!C.docs.hasFetched && !C.docs.loading) void initDocsForCall()
    else {
      openDocsPanel()
      if (C.kbMode === 'grounded') setTimeout(() => void autoStartMaterialLesson(), 120)
    }
  }
  if (C.kbMode === 'grounded' && !C.kbDocIds.length) {
    toast('知识库讨论需要先在助手页「知识库」勾选材料', 'info', 3400)
  } else {
    toast(`已切换到「${KB_MODES[C.kbMode].label}」`, 'info', 1800)
  }
}

/** 从 SSE meta / voice ready 里容错提取知识库命中片段。 */
function extractKbHits(payload) {
  if (!payload || typeof payload !== 'object') return null
  const kb = payload.kb && typeof payload.kb === 'object' ? payload.kb : null
  const candidates = [
    kb && kb.hits,
    kb && kb.citations,
    kb && kb.chunks,
    payload.kbHits,
    payload.citations,
    payload.hits,
  ]
  for (const list of candidates) {
    if (Array.isArray(list)) return list
  }
  return null
}

function renderCitations(hits) {
  if (!D.citations) return
  const list = (Array.isArray(hits) ? hits : [])
    .filter((hit) => hit && typeof hit === 'object' && (hit.title || hit.docTitle || hit.text || hit.snippet || hit.chunkText))
    .slice(0, 3)
  if (!list.length) {
    clearCitations()
    return
  }
  C.kbHits = list
  if (D.call) D.call.classList.add('has-citations')
  D.citations.innerHTML =
    `<div class="citations-head">${icon('book')}引用材料 · ${list.length} 条</div>` +
    list
      .map((hit, index) => {
        const title = String(hit.title || hit.docTitle || '知识库片段').slice(0, 48)
        const snippet = String(hit.text || hit.snippet || hit.chunkText || '').replace(/\s+/g, ' ').slice(0, 320)
        const score = Number(hit.score)
        return `<details class="citation-card" data-docid="${esc(String(hit.docId || hit.docID || hit.doc_id || hit.kbDocId || hit.documentId || ''))}" data-chunkid="${esc(String(hit.chunkId || hit.chunkID || hit.chunk_id || ''))}">
          <summary>
            <span class="citation-idx">${index + 1}</span>
            <span class="citation-title">${esc(title)}</span>
            ${Number.isFinite(score) ? `<span class="citation-score">${Math.round(Math.max(0, Math.min(1, score)) * 100)}%</span>` : ''}
          </summary>
          <div class="citation-text">${esc(snippet || '（暂无片段）')}</div>
        </details>`
      })
      .join('')
  D.citations.hidden = false
  applyDocsHits(list)
}

/* ------------------------------ 数字人老师上课模式（v3.0） ------------------------------ */
const LESSON_STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'are', 'am', 'be', 'to', 'of', 'in', 'on', 'at', 'it', 'this', 'that', 'i', 'me', 'my', 'you', 'your', 'we', 'us', 'and', 'or', 'but', 'so', 'with', 'for', 'how', 'what', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'please', 'really', 'just', 'not', 'no', 'yes'])

function normalizeLessonText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function lessonContentWords(value) {
  return normalizeLessonText(value)
    .split(' ')
    .filter((word) => word.length > 1 && !LESSON_STOP_WORDS.has(word))
}

function lessonPhraseMatch(text, phraseEn) {
  const said = normalizeLessonText(text)
  const target = normalizeLessonText(phraseEn)
  if (!said || !target) return false
  if (said.includes(target) || (target.includes(said) && said.split(' ').length >= 3)) return true
  const targetWords = lessonContentWords(target)
  const saidSet = new Set(lessonContentWords(said))
  if (!targetWords.length) return false
  const hits = targetWords.filter((word) => saidSet.has(word)).length
  return hits >= 3 || hits / targetWords.length >= 0.55
}

function lessonMatchAnyPhrase(text) {
  const phrases = (C.lesson && C.lesson.phrases) || []
  return phrases.some((phrase) => phrase && lessonPhraseMatch(text, phrase.en))
}

function lessonSceneIndex(character, sceneId) {
  if (!character || !Array.isArray(character.scenes)) return -1
  return character.scenes.findIndex((scene) => scene && (scene.id === sceneId || scene.sceneId === sceneId))
}

function clearLessonState() {
  C.lesson = null
  C.lessonStageId = ''
  C.lessonStep = 0
  C.lessonPhraseIdx = 0
  C.lessonAttempts = 0
  C.lessonPassed = []
  C.lessonPracticeTurns = 0
  C.lessonChallengeTurns = 0
  C.lessonDone = false
  C.lessonSubmitting = false
  C.lessonPanelOpen = true
  C.lessonUsedPhrase = false
  if (D.lesson) {
    D.lesson.hidden = true
    D.lesson.classList.remove('is-collapsed')
  }
  if (D.call) D.call.classList.remove('lesson-mode')
}

function applyLesson(lesson, { stageId = '', sceneId = '' } = {}) {
  if (!lesson || !lesson.id) return false
  const phrases = (Array.isArray(lesson.phrases) ? lesson.phrases : [])
    .filter((phrase) => phrase && phrase.en)
    .map((phrase) => ({ en: String(phrase.en), zh: String(phrase.zh || '') }))
  if (!phrases.length) return false
  C.lesson = {
    id: String(lesson.id),
    sceneId: String(lesson.sceneId || sceneId || ''),
    title: String(lesson.title || '本课'),
    emoji: String(lesson.emoji || '📘'),
    level: String(lesson.level || 'A2'),
    objectives: (Array.isArray(lesson.objectives) ? lesson.objectives : []).map(String).slice(0, 4),
    phrases,
    steps: (Array.isArray(lesson.steps) && lesson.steps.length ? lesson.steps : [
      { id: 'repeat', title: '跟读常用句' },
      { id: 'practice', title: '场景练习' },
      { id: 'challenge', title: '完成挑战' },
    ]).map((step, index) => ({ id: String(step.id || 'step' + index), title: String(step.title || '第 ' + (index + 1) + ' 步'), desc: String(step.desc || '') })),
    teacherIntro: String(lesson.teacherIntro || ''),
    taskPrompt: String(lesson.taskPrompt || ''),
  }
  C.lessonStageId = String(stageId || '')
  C.lessonStep = 1
  C.lessonPhraseIdx = 0
  C.lessonAttempts = 0
  C.lessonPassed = C.lesson.phrases.map(() => false)
  C.lessonPracticeTurns = 0
  C.lessonChallengeTurns = 0
  C.lessonDone = false
  C.lessonSubmitting = false
  C.lessonPanelOpen = true
  C.lessonUsedPhrase = false
  // v3.2 断点恢复：lesson.resume 存在且未完成时恢复上次进度
  const resume = !lesson.done && lesson.resume && typeof lesson.resume === 'object' ? lesson.resume : null
  if (resume) {
    const resumeStep = Math.max(1, Math.min(3, Number(resume.step) || 1))
    const resumePhraseIdx = Math.max(0, Math.min(C.lesson.phrases.length, Number(resume.phraseIdx) || 0))
    C.lessonStep = resumeStep
    C.lessonPhraseIdx = resumePhraseIdx
    C.lessonPassed = C.lesson.phrases.map((_, index) => resumeStep > 1 || index < resumePhraseIdx)
    C.lessonPracticeTurns = Math.max(0, Number(resume.practiceTurns) || 0)
    C.lessonChallengeTurns = Math.max(0, Number(resume.challengeTurns) || 0)
    C.lessonAttempts = 0
  }
  if (D.call) D.call.classList.add('lesson-mode')
  renderLessonPanel()
  if (resume) {
    toast('已恢复上次进度：第 ' + C.lessonStep + ' 步 · 跟读 ' + Math.min(C.lessonPhraseIdx, C.lesson.phrases.length) + '/' + C.lesson.phrases.length, 'info', 3000)
  }
  return true
}

function renderLessonPanel() {
  if (!D.lesson) return
  if (!C.lesson) {
    D.lesson.hidden = true
    if (D.call) D.call.classList.remove('lesson-mode')
    return
  }
  const lesson = C.lesson
  D.lesson.hidden = false
  if (D.call) D.call.classList.add('lesson-mode')
  D.lesson.classList.toggle('is-collapsed', !C.lessonPanelOpen)
  if (D.lessonEmoji) D.lessonEmoji.textContent = lesson.emoji || '📘'
  if (D.lessonTitle) D.lessonTitle.textContent = '本课 · ' + lesson.title
  if (D.lessonSub) D.lessonSub.textContent = `${lesson.level} · ${lesson.steps.length} 步 · ${lesson.phrases.length} 句`
  if (D.lessonToggle) {
    D.lessonToggle.textContent = C.lessonPanelOpen ? '收起' : '展开'
    D.lessonToggle.setAttribute('aria-expanded', C.lessonPanelOpen ? 'true' : 'false')
  }
  if (D.lessonSteps) {
    D.lessonSteps.innerHTML = lesson.steps
      .map((step, index) => {
        const num = index + 1
        const state = C.lessonDone || num < C.lessonStep ? 'done' : num === C.lessonStep ? 'current' : 'pending'
        const mark = state === 'done' ? '✓' : String(num)
        return `<span class="cl-step is-${state}"><b>${mark}</b><span>${esc(step.title)}</span></span>`
      })
      .join('')
  }
  if (D.lessonGoals) {
    const goals = lesson.objectives.length
      ? lesson.objectives.map((goal) => `<span class="cl-goal">${esc(goal)}</span>`).join('')
      : ''
    D.lessonGoals.innerHTML = goals
  }
  if (D.lessonTask) {
    D.lessonTask.textContent = lesson.taskPrompt ? '本课任务：' + lesson.taskPrompt : ''
  }
  if (D.lessonStatus) {
    const current = lesson.steps[Math.max(0, Math.min(C.lessonStep - 1, lesson.steps.length - 1))]
    D.lessonStatus.textContent = C.lessonDone
      ? '本课已完成 ✓'
      : C.lessonStep === 1
        ? `跟读第 ${Math.min(C.lessonPhraseIdx + 1, lesson.phrases.length)}/${lesson.phrases.length} 句 · ${current ? current.title : ''}`
        : current
          ? `${current.title} · 再聊 2 轮即可推进`
          : ''
  }
  if (D.lessonPhrases) {
    const currentIdx = C.lessonStep === 1 ? C.lessonPhraseIdx : -1
    D.lessonPhrases.innerHTML = lesson.phrases
      .map((phrase, index) => {
        const passed = C.lessonPassed[index] || (C.lessonDone && true)
        const current = index === currentIdx && !C.lessonDone
        return `<button type="button" class="cl-phrase${passed ? ' is-passed' : ''}${current ? ' is-current' : ''}" data-idx="${index}">
          <span class="cl-phrase-idx">${passed ? '✓' : index + 1}</span>
          <span class="cl-phrase-main"><span class="cl-en">${esc(phrase.en)}</span><span class="cl-zh">${esc(phrase.zh)}</span></span>
          <span class="cl-speak" data-speak="${index}" aria-label="朗读第 ${index + 1} 句">🔊</span>
        </button>`
      })
      .join('')
    setTimeout(() => {
      if (!C.lessonPanelOpen || !D.lessonPhrases) return
      const currentEl = D.lessonPhrases.querySelector('.cl-phrase.is-current')
      if (currentEl && typeof currentEl.scrollIntoView === 'function') {
        try {
          currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        } catch {
          /* 忽略 */
        }
      }
    }, 60)
  }
}

/* ------------------------------ 角色原声（voice-audio helper，v3.1） ------------------------------ */
let voiceAudioModulePromise = null
function loadVoiceAudioModule() {
  if (!voiceAudioModulePromise) {
    voiceAudioModulePromise = import('./voice-audio.js')
      .then((mod) => mod || null)
      .catch(() => null)
  }
  return voiceAudioModulePromise
}

/** 用当前老师音色播放一句话；helper 未就绪/失败返回 false（调用方回退 tts）。 */
async function playCharacterVoice(text, { characterId = '', onStart, onEnd, volume, rate } = {}) {
  const value = String(text || '').trim()
  if (!value) return false
  try {
    const mod = await loadVoiceAudioModule()
    const fn = mod && (mod.playCharacterText || mod.default)
    if (typeof fn !== 'function') return false
    const result = await fn(value, {
      characterId: characterId || (C.character && C.character.id) || 'elena',
      ...(typeof volume === 'number' ? { volume } : {}),
      ...(typeof rate === 'number' ? { rate } : {}),
      ...(typeof onStart === 'function' ? { onStart } : {}),
      ...(typeof onEnd === 'function' ? { onEnd } : {}),
    })
    return result !== false
  } catch (err) {
    console.warn('[mobile] 角色原声播放失败，回退浏览器 TTS：', err)
    return false
  }
}

async function stopCharacterVoice() {
  try {
    const mod = await loadVoiceAudioModule()
    if (mod && typeof mod.stopCharacterText === 'function') mod.stopCharacterText()
  } catch {
    /* 忽略 */
  }
}

function speakLessonPhrase(index) {
  const phrase = C.lesson && C.lesson.phrases[index]
  if (!phrase) return
  void (async () => {
    const played = await playCharacterVoice(phrase.en)
    if (!played) {
      // v3.8：浏览器内置语音已关闭；点读只使用角色原声，失败则静默
      console.debug('[mobile] 课程句子角色原声不可用')
    }
  })()
}

function lessonOnUserText(text) {
  const said = String(text || '').trim()
  if (!C.lesson || C.lessonDone || !said) return
  const phrases = C.lesson.phrases
  const lesson = C.lesson
  if (C.lessonStep === 1) {
    const index = C.lessonPhraseIdx
    const target = phrases[index]
    if (!target) return
    if (lessonPhraseMatch(said, target.en)) {
      C.lessonPassed[index] = true
      C.lessonAttempts = 0
      C.lessonPhraseIdx = index + 1
      toast('✓ 第 ' + (index + 1) + ' 句不错', 'ok', 1600)
      if (C.lessonPhraseIdx >= phrases.length) {
        C.lessonStep = 2
        C.lessonPracticeTurns = 0
        toast('跟读完成，进入场景练习', 'ok', 2600)
      }
      renderLessonPanel()
      persistLessonProgress()
      return
    }
    C.lessonAttempts += 1
    if (C.lessonAttempts >= 2) {
      C.lessonPassed[index] = true
      C.lessonAttempts = 0
      C.lessonPhraseIdx = index + 1
      toast('这句先过，之后可以再练', 'info', 2400)
      if (C.lessonPhraseIdx >= phrases.length) {
        C.lessonStep = 2
        C.lessonPracticeTurns = 0
        toast('跟读完成，进入场景练习', 'ok', 2600)
      }
      renderLessonPanel()
      persistLessonProgress()
    } else {
      toast('再试一次：' + target.en, 'info', 2800)
    }
    return
  }
  const used = lessonMatchAnyPhrase(said)
  if (C.lessonStep === 2) {
    C.lessonPracticeTurns += 1
    if (used) C.lessonUsedPhrase = true
    if (C.lessonPracticeTurns >= 2) {
      C.lessonStep = 3
      C.lessonChallengeTurns = 0
      toast('进入最后挑战', 'ok', 2400)
      renderLessonPanel()
    }
    persistLessonProgress()
    return
  }
  if (C.lessonStep === 3) {
    C.lessonChallengeTurns += 1
    if (used) C.lessonUsedPhrase = true
    if (!C.lessonDone && (C.lessonUsedPhrase || C.lessonChallengeTurns >= 2)) {
      void completeLesson()
      return
    }
    persistLessonProgress()
    return
  }
  void lesson
}

function lessonProgressPayload() {
  if (!C.lesson || C.lessonDone) return null
  return {
    lessonId: C.lesson.id,
    step: C.lessonStep,
    phraseIdx: C.lessonPhraseIdx,
    practiceTurns: C.lessonPracticeTurns,
    challengeTurns: C.lessonChallengeTurns,
  }
}

function sendLessonProgress(payload, { keepalive = false } = {}) {
  if (!payload) return
  if (keepalive) {
    try {
      void fetch('/api/plan/lesson-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {})
    } catch {
      /* 页面隐藏时失败静默 */
    }
    return
  }
  const prev = C.lessonPersistChain || Promise.resolve()
  C.lessonPersistChain = prev
    .catch(() => {})
    .then(() => postJSON('/api/plan/lesson-progress', payload))
    .catch(() => {})
}

/** 保存课程断点：debounce 500ms；immediate 立即发送（返回/挂断/隐藏页面用）。失败静默。 */
function persistLessonProgress({ immediate = false, keepalive = false } = {}) {
  const payload = lessonProgressPayload()
  if (!payload) return false
  if (C.lessonPersistTimer) {
    clearTimeout(C.lessonPersistTimer)
    C.lessonPersistTimer = null
  }
  C.lessonPersistPending = payload
  if (immediate) {
    const pending = C.lessonPersistPending
    C.lessonPersistPending = null
    sendLessonProgress(pending, { keepalive })
    return true
  }
  C.lessonPersistTimer = setTimeout(() => {
    C.lessonPersistTimer = null
    const current = C.lessonPersistPending
    C.lessonPersistPending = null
    if (current) sendLessonProgress(current)
  }, 500)
  return true
}

function lessonChatContext() {
  if (!C.lesson) return {}
  return {
    ...(C.lesson.sceneId ? { sceneId: C.lesson.sceneId } : {}),
    lessonId: C.lesson.id,
    stageId: C.lessonStageId || undefined,
    lessonStep: C.lessonStep,
  }
}

async function completeLesson() {
  if (!C.lesson || C.lessonDone || C.lessonSubmitting) return
  C.lessonDone = true
  renderLessonPanel()
  await finalizeLesson()
}

async function finalizeLesson() {
  if (!C.lesson || !C.character || C.lessonSubmitting) return
  C.lessonSubmitting = true
  const lesson = C.lesson
  try {
    const res = await postJSON('/api/plan/scene-done', {
      lessonId: lesson.id,
      stageId: C.lessonStageId || '',
      stepsCompleted: 3,
    })
    C.lessonSubmitting = false
    if (!res || res.ok === false || res.completed === false) {
      const reasonMap = {
        'not-found': '本课没有在计划中找到，可能计划已被调整',
        'not-ready': '这节课的课件还在生成中，稍后再试',
        locked: '这节课还没有解锁，先完成上一课',
        'steps-incomplete': '教学步骤还没完成（需要 3 步）',
        'no-plan': '还没有学习计划，先去助手定制计划',
      }
      const reason = res && res.reason ? reasonMap[res.reason] || res.reason : ''
      showLessonResultSheet({ error: (res && res.error) || reason || '课程完成上报失败' })
      return
    }
    if (res.plan) {
      M.plan = res.plan
      try {
        ui.refreshCourses()
      } catch {
        /* 忽略 */
      }
    }
    showLessonResultSheet(res)
  } catch (err) {
    C.lessonSubmitting = false
    showLessonResultSheet({ error: (err && err.message) || '网络异常，课程完成上报失败' })
  }
}

function showLessonResultSheet(res) {
  if (!C.lesson) return
  const lesson = C.lesson
  const failed = !!(res && res.error)
  const plan = (res && res.plan) || M.plan || {}
  const progress = Math.max(0, Math.min(100, Math.round(Number(plan.progress) || 0)))
  const next = res && res.next ? res.next : plan.next
  const nextLesson =
    !failed && next && next.lessonId
      ? (Array.isArray(plan.stages) ? plan.stages : [])
          .map((stage) => stage && stage.lesson)
          .find((item) => item && item.id === next.lessonId) ||
        (plan.lessons && typeof plan.lessons === 'object' ? plan.lessons[next.lessonId] : null) ||
        null
      : null
  const nextTeacherId = (next && next.teacherId) || plan.teacherId || (C.character && C.character.id) || ''
  const phrases = lesson.phrases.map((phrase) => `<li><span>${esc(phrase.en)}</span><em>${esc(phrase.zh)}</em></li>`).join('')
  const title = failed ? '本课完成上报失败' : '🎉 本课完成 · ' + lesson.title
  const html = failed
    ? `<div class="lesson-result">
        <p class="lr-error">${esc(String(res.error || '网络异常'))}</p>
        <p class="lr-note">本课已练完，但进度同步失败。可以重试上报，或先返回课程页。</p>
        <div class="lr-actions">
          <button type="button" class="btn btn-ghost" data-act="lesson-return">返回课程</button>
          <button type="button" class="btn btn-primary" data-act="lesson-retry">重试上报</button>
        </div>
      </div>`
    : `<div class="lesson-result">
        <div class="lr-progress"><span>整体进度</span><strong>${progress}%</strong></div>
        <div class="lr-bar"><i style="width:${progress}%"></i></div>
        <p class="lr-note">本课 ${lesson.phrases.length} 句常用句都练过了，继续下一次场景练习吧。</p>
        <ul class="lr-phrases">${phrases}</ul>
        <div class="lr-actions">
          <button type="button" class="btn btn-ghost" data-act="lesson-return">返回课程</button>
          ${nextLesson ? '<button type="button" class="btn btn-primary" data-act="lesson-next">下一课 · ' + esc(nextLesson.title) + '</button>' : ''}
        </div>
      </div>`
  ui.openSheet(title, html)
  const body = $('#sheet-body')
  if (!body) return
  body.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'lesson-return') {
      ui.closeSheet()
      void (async () => {
        await endCall({ silent: true })
        ui.switchTab('courses')
        ui.refreshCourses()
      })()
    } else if (act === 'lesson-next') {
      ui.closeSheet()
      void (async () => {
        const teacherChar = characterById(nextTeacherId) || C.character
        const sceneIdx = nextLesson && nextLesson.sceneId ? lessonSceneIndex(teacherChar, nextLesson.sceneId) : -1
        await endCall({ silent: true })
        await openCall(teacherChar, sceneIdx < 0 ? 0 : sceneIdx, {
          lesson: nextLesson,
          lessonId: nextLesson.id,
          stageId: (next && next.stageId) || '',
          teacherId: nextTeacherId,
        })
      })()
    } else if (act === 'lesson-retry') {
      ui.closeSheet()
      C.lessonDone = true
      C.lessonSubmitting = false
      void finalizeLesson()
    }
  }
}

function exitLessonFreeChat() {
  if (!C.lesson) return
  persistLessonProgress({ immediate: true })
  C.lesson = null
  C.lessonDone = false
  C.lessonStep = 0
  renderLessonPanel()
  if (D.call) D.call.classList.remove('lesson-mode')
  toast('已切换到自由聊，本节不再判定进度', 'info', 2600)
}

function bindLessonControls() {
  if (!D.lesson || C.lessonControlsBound) return
  C.lessonControlsBound = true
  D.lesson.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const speak = target.closest('[data-speak]')
    if (speak) {
      speakLessonPhrase(Number(speak.getAttribute('data-speak')))
      return
    }
    const phrase = target.closest('.cl-phrase')
    if (phrase) {
      speakLessonPhrase(Number(phrase.getAttribute('data-idx')))
      return
    }
    if (target.closest('#cl-toggle')) {
      C.lessonPanelOpen = !C.lessonPanelOpen
      renderLessonPanel()
      return
    }
    if (target.closest('#cl-free')) exitLessonFreeChat()
  })
}

/* ------------------------------ 讲解资料对照窗（v2.7 方案 A） ------------------------------ */
const DOCS_FONT_MIN = 12
const DOCS_FONT_MAX = 20

function docsAvailable() {
  return !!(C.kbDocIds && C.kbDocIds.length)
}

function resetDocsForCall() {
  C.docs.token += 1
  C.docs.docs = []
  C.docs.loadedIds = ''
  C.docs.activeId = ''
  C.docs.activeChunk = ''
  C.docs.activeSentence = ''
  C.docs.loading = false
  C.docs.error = ''
  C.docs.hasFetched = false
  C.docs.open = false
  C.docs.follow = true
  closeDocsPanel()
  if (D.docs) D.docs.hidden = true
  if (D.docsTabs) D.docsTabs.innerHTML = ''
  if (D.docsBody) {
    D.docsBody.innerHTML = ''
    D.docsBody.style.fontSize = ''
  }
  if (D.docsStatus) D.docsStatus.hidden = true
}

async function initDocsForCall() {
  const token = ++C.docs.token
  C.docs.docs = []
  C.docs.activeId = ''
  C.docs.activeChunk = ''
  C.docs.activeSentence = ''
  C.docs.error = ''
  C.docs.loading = false
  C.docs.hasFetched = false
  C.docs.loadedIds = C.kbDocIds.join(',')
  renderKbBar()
  if (!docsAvailable()) {
    closeDocsPanel()
    if (D.docs) D.docs.hidden = true
    return
  }
  if (D.docs) D.docs.hidden = false
  C.docs.loading = true
  renderDocsStatus('loading', '正在加载讲解资料…')
  if (C.kbMode !== 'free') openDocsPanel()
  const ids = C.kbDocIds.slice(0, 12)
  const docs = []
  for (const id of ids) {
    try {
      const res = await api.kbGet(id)
      if (token !== C.docs.token) return
      if (res && res.ok && res.doc) docs.push(normalizeKbDoc(res.doc))
    } catch {
      /* 单篇失败不阻塞其它篇 */
    }
  }
  if (token !== C.docs.token) return
  C.docs.loading = false
  C.docs.hasFetched = true
  C.docs.docs = docs
  if (!docs.length) {
    C.docs.error = '讲解资料加载失败或内容为空，可继续用语音聊天。'
    renderDocsTabs()
    renderDocsBody()
    renderDocsStatus('error', C.docs.error)
    return
  }
  C.docs.activeId = docs[0].id
  if (!C.kbDocTitles.length) C.kbDocTitles = docs.map((doc) => doc.title)
  renderKbBar()
  renderDocsTabs()
  renderDocsBody()
  renderDocsStatus('', '')
  if (C.kbMode !== 'free' || C.docs.open) openDocsPanel()
  autoStartMaterialLesson()
}

function repairDocText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/([a-z])([A-Z][a-z])/g, '$1 $2')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitDocSentences(value) {
  const clean = repairDocText(value)
  if (!clean) return []
  const pieces = clean.match(/[^.!?。！？]+[.!?。！？]?/g) || [clean]
  return pieces.map((part) => part.trim()).filter(Boolean)
}

function normalizeKbDoc(doc) {
  const chunks = (Array.isArray(doc.chunks) ? doc.chunks : [])
    .map((chunk, index) => ({
      id: String((chunk && chunk.id) || 'c' + (index + 1)),
      text: String((chunk && chunk.text) || '').trim(),
      summary: String((chunk && chunk.summary) || '').trim(),
      keywords: Array.isArray(chunk && chunk.keywords) ? chunk.keywords.map(String) : [],
    }))
    .filter((chunk) => chunk.text)
  // 兼容旧库：去掉相邻 chunk 的重叠尾巴，避免同一句被重复显示/朗读
  for (let i = 1; i < chunks.length; i += 1) {
    const prev = chunks[i - 1].text
    let cur = chunks[i].text
    const max = Math.min(prev.length, cur.length, 200)
    for (let k = max; k >= 24; k -= 1) {
      if (prev.endsWith(cur.slice(0, k))) {
        chunks[i] = { ...chunks[i], text: cur.slice(k).trimStart() }
        break
      }
    }
  }
  const sentences = []
  for (const chunk of chunks) {
    splitDocSentences(chunk.text).forEach((text, index) => {
      sentences.push({ id: `${chunk.id}_s${index + 1}`, chunkId: chunk.id, text })
    })
  }
  return {
    id: String(doc.id || ''),
    title: String(doc.title || '未命名资料').slice(0, 80),
    source: String(doc.source || 'file'),
    kind: String(doc.kind || ''),
    summary: String(doc.summary || doc.preview || '').trim(),
    chunks,
    sentences,
  }
}

function activeDocsDoc() {
  const docs = C.docs.docs || []
  return docs.find((doc) => doc.id === C.docs.activeId) || docs[0] || null
}

function docsTabTitle(title) {
  const value = String(title || '').replace(/\s+/g, ' ').trim()
  return value.length > 16 ? value.slice(0, 15) + '…' : value || '资料'
}

function renderDocsTabs() {
  if (!D.docsTabs) return
  const docs = C.docs.docs || []
  if (!docs.length) {
    D.docsTabs.innerHTML = ''
    return
  }
  D.docsTabs.innerHTML =
    docs
      .map(
        (doc) =>
          `<button type="button" class="docs-tab${doc.id === C.docs.activeId ? ' is-active' : ''}" data-doc="${esc(doc.id)}" role="tab" aria-selected="${doc.id === C.docs.activeId}">${esc(docsTabTitle(doc.title))}</button>`,
      )
      .join('') + `<span class="docs-tab-count">${docs.length} 篇</span>`
}

function splitDocsParagraphs(text) {
  const raw = String(text || '').replace(/\r/g, '').trim()
  if (!raw) return []
  let parts = raw
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 1 && raw.length > 620) {
    parts = []
    let rest = raw
    while (rest.length > 620) {
      let cut = -1
      for (const mark of ['。', '！', '？', '. ', '! ', '? ']) {
        const index = rest.lastIndexOf(mark, 620)
        if (index > cut) cut = index + mark.length
      }
      if (cut < 240) cut = 620
      parts.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) parts.push(rest)
  } else if (parts.length === 1) {
    parts = raw.split(/\n/).map((part) => part.trim()).filter(Boolean)
    if (parts.length === 1) parts = [raw]
  }
  return parts.filter(Boolean)
}

function renderDocsBody() {
  if (!D.docsBody) return
  const doc = activeDocsDoc()
  if (!doc) {
    D.docsBody.innerHTML = ''
    return
  }
  D.docsBody.style.fontSize = `${C.docs.fontSize}px`
  const totalSentences = doc.sentences.length || doc.chunks.length
  const sourceLabel = doc.source === 'web' ? '网页原文 · 未 OCR' : doc.source === 'paste' ? '粘贴原文 · 未 OCR' : doc.source === 'library' ? '书库节选 · 公版' : doc.kind === 'image' ? '图片 OCR · 已校对' : '文件原文'
  const head = `<div class="docs-doc-meta"><span class="docs-doc-name">${esc(doc.title)}</span><span class="docs-doc-count">${sourceLabel} · ${totalSentences} 句 · 共 ${Math.round(doc.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) / 100) / 10} 千字</span><span class="docs-read-hint">点击任意句子，定位并朗读</span></div>`
  const body = doc.chunks
    .map((chunk) => {
      const list = doc.sentences.filter((sentence) => sentence.chunkId === chunk.id)
      const pieces = list.length
        ? list
            .map(
              (sentence) =>
                `<span class="docs-sentence${sentence.id === C.docs.activeSentence ? ' is-hit' : ''}" data-sentence-id="${esc(sentence.id)}" data-chunk-id="${esc(chunk.id)}" title="点击定位并朗读这一句">${esc(sentence.text)} </span>`,
            )
            .join('')
        : esc(chunk.text)
      return `<div class="docs-para" data-chunkid="${esc(chunk.id)}" id="docs-chunk-${esc(doc.id)}-${esc(chunk.id)}">${pieces}</div>`
    })
    .join('')
  D.docsBody.innerHTML = head + body
  requestAnimationFrame(() => scrollDocsToChunk())
}

function renderDocsStatus(kind, text) {
  if (!D.docsStatus) return
  if (!text) {
    D.docsStatus.hidden = true
    D.docsStatus.textContent = ''
    return
  }
  D.docsStatus.hidden = false
  D.docsStatus.className = 'call-docs-status is-' + (kind || 'info')
  D.docsStatus.textContent = text
}

function updateDocsButton() {
  const btn = document.getElementById('call-docs-btn')
  if (!btn) return
  btn.classList.toggle('is-open', C.docs.open)
  btn.setAttribute('aria-expanded', C.docs.open ? 'true' : 'false')
  const label = btn.querySelector('.kb-docs-label')
  if (label) label.textContent = C.docs.open ? '收起资料' : '资料'
}

function openDocsPanel() {
  if (!docsAvailable() || !D.docs) return false
  D.docs.hidden = false
  C.docs.open = true
  if (D.call) D.call.classList.add('docs-open')
  updateDocsButton()
  return true
}

function closeDocsPanel() {
  C.docs.open = false
  if (D.call) D.call.classList.remove('docs-open')
  updateDocsButton()
}

function toggleDocsPanel() {
  if (!docsAvailable()) return
  if (D.docs) D.docs.hidden = false
  if (C.docs.open) closeDocsPanel()
  else {
    openDocsPanel()
    if (!C.docs.hasFetched && !C.docs.loading) void initDocsForCall()
  }
}

function scrollDocsToChunk() {
  const body = D.docsBody
  if (!body || !C.docs.activeChunk) return
  const target =
    body.querySelector('.docs-sentence.is-hit') ||
    body.querySelector('.docs-chunk.is-hit') ||
    body.querySelector(`.docs-para[data-chunkid="${C.docs.activeChunk}"]`)
  if (!target) return
  const top = target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 14
  C.docs.autoScroll = true
  try {
    body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  } catch {
    body.scrollTop = Math.max(0, top)
  }
  setTimeout(() => {
    C.docs.autoScroll = false
  }, 700)
}

function activateDocsDoc(docId, { scroll = false } = {}) {
  if (!docId || docId === C.docs.activeId) return
  const doc = (C.docs.docs || []).find((item) => item.id === docId)
  if (!doc) return
  C.docs.activeId = docId
  if (C.docs.activeChunk && !doc.chunks.some((chunk) => chunk.id === C.docs.activeChunk)) C.docs.activeChunk = ''
  renderDocsTabs()
  renderDocsBody()
  if (scroll) scrollDocsToChunk()
}

function bestDocSentence(sentences, text) {
  if (!Array.isArray(sentences) || !sentences.length) return null
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
  if (!words.length) return sentences[0]
  let best = null
  let bestScore = 0
  for (const sentence of sentences) {
    const hay = sentence.text.toLowerCase()
    let score = 0
    for (const word of new Set(words)) if (hay.includes(word)) score += 1
    if (score > bestScore) {
      bestScore = score
      best = sentence
    }
  }
  return bestScore >= Math.max(2, Math.ceil(words.length * 0.16)) ? best : sentences[0]
}

function focusDocsChunk(docId, chunkId, { force = false, text = '' } = {}) {
  const docs = C.docs.docs || []
  if (!docs.length) return false
  let doc = docs.find((item) => item.id === docId)
  const wantedChunk = chunkId ? String(chunkId) : ''
  if (!doc && wantedChunk) doc = docs.find((item) => item.chunks.some((chunk) => chunk.id === wantedChunk))
  if (!doc) return false
  const hasChunk = wantedChunk ? doc.chunks.some((chunk) => chunk.id === wantedChunk) : false
  C.docs.activeId = doc.id
  C.docs.activeChunk = hasChunk ? wantedChunk : ''
  C.docs.activeSentence = ''
  if (hasChunk) {
    const list = doc.sentences.filter((sentence) => sentence.chunkId === wantedChunk)
    const chosen = bestDocSentence(list, text)
    if (chosen) C.docs.activeSentence = chosen.id
  }
  if (force || C.docs.follow) openDocsPanel()
  renderDocsTabs()
  renderDocsBody()
  if ((force || C.docs.follow) && hasChunk && C.docs.open) scrollDocsToChunk()
  return true
}

function applyDocsHits(hits) {
  if (!Array.isArray(hits) || !hits.length || !docsAvailable()) return
  if (!C.docs.docs.length) return
  for (const hit of hits.slice(0, 5)) {
    if (!hit || typeof hit !== 'object') continue
    const chunkId = String(hit.chunkId || hit.chunkID || hit.chunk_id || '').trim()
    const docId = String(hit.docId || hit.docID || hit.doc_id || hit.kbDocId || hit.documentId || '').trim()
    const title = String(hit.docTitle || hit.title || '').trim()
    if (!chunkId && !docId) continue
    let doc = docId ? (C.docs.docs || []).find((item) => item.id === docId) : null
    if (!doc && title) {
      const key = title.slice(0, 10)
      doc = (C.docs.docs || []).find((item) => item.title && (item.title.includes(key) || key.includes(item.title.slice(0, 10))))
    }
    if (!doc && chunkId) doc = (C.docs.docs || []).find((item) => item.chunks.some((chunk) => chunk.id === chunkId))
    if (!doc) continue
    if (chunkId && !doc.chunks.some((chunk) => chunk.id === chunkId)) continue
    focusDocsChunk(doc.id, chunkId, { force: false, text: String(hit.text || hit.snippet || hit.chunkText || '') })
    break
  }
}

/** 点击句子：定位 + 用当前老师音色朗读。 */
function readDocsSentence(text, sentenceId) {
  const value = String(text || '').trim()
  if (!value) return
  const token = ++C.docs.readToken
  const mark = (on) => {
    if (!D.docsBody) return
    const node = D.docsBody.querySelector(`.docs-sentence[data-sentence-id="${sentenceId}"]`)
    if (!node) return
    node.classList.toggle('is-reading', on)
  }
  mark(false)
  void stopCharacterVoice()
  mark(true)
  void playCharacterVoice(value, {
    onStart: () => mark(true),
    onEnd: () => {
      if (token === C.docs.readToken) mark(false)
    },
  }).then((played) => {
    if (token !== C.docs.readToken) return
    if (!played) {
      mark(false)
      toast('这一句暂时无法朗读，请稍后再试', 'info', 2200)
    }
  })
}

/** 不依赖后端检索：用老师原话在本地方案里找最匹配的一句。 */
function focusDocsByText(text) {
  const docs = C.docs.docs || []
  if (!docs.length) return false
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
  const unique = [...new Set(words)]
  if (unique.length < 2) return false
  let best = null
  let bestScore = 0
  for (const doc of docs) {
    for (const sentence of doc.sentences || []) {
      const hay = sentence.text.toLowerCase()
      let score = 0
      for (const word of unique) if (hay.includes(word)) score += 1
      if (score > bestScore) {
        bestScore = score
        best = { doc, sentence }
      }
    }
  }
  if (!best || bestScore < Math.max(2, Math.ceil(unique.length * 0.18))) return false
  return focusDocsChunk(best.doc.id, best.sentence.chunkId, {
    force: false,
    text: best.sentence.text,
  })
}

/** 资料模式：进入后自动从第一句开始带读，不依赖用户话术。 */
function autoStartMaterialLesson() {
  if (!C.open || C.kbMode !== 'grounded' || C.materialStarted || !C.docs.docs.length) return false
  if (C.userTurns > 0) return false
  const doc = activeDocsDoc()
  const sentence = doc && Array.isArray(doc.sentences) ? doc.sentences[0] : null
  if (!doc || !sentence) return false
  C.materialStarted = true
  C.docs.activeId = doc.id
  C.docs.activeChunk = sentence.chunkId
  C.docs.activeSentence = sentence.id
  renderDocsTabs()
  renderDocsBody()
  openDocsPanel()
  const script = `We're starting this material lesson. First sentence: “${sentence.text}” Please read it after me.`
  const node = addBubble('ava', script)
  C.messages.push({ role: 'assistant', content: script })
  C.dialogueBubbleId = node.id
  showDialogue(script)
  scrollBubblesToBottom(true)
  void translateBubble(node.id, script)
  setState('speaking')
  void playCharacterVoice(sentence.text, {
    onEnd: () => {
      if (C.state === 'speaking') setState('idle')
      scheduleVolcWarmup(600)
    },
  }).then((played) => {
    if (!played && C.state === 'speaking') setState('idle')
  })
  return true
}

function refreshDocsFollow(assistantText) {
  if (!docsAvailable() || !C.kbDocIds.length || !C.docs.docs.length || !C.docs.follow) return
  // 先用老师刚说的话本地对齐一句，服务端检索回来再细化；两个都失败就保持当前句
  const localMatched = focusDocsByText(assistantText)
  const query = `${C.lastAsrText || ''} ${assistantText || ''}`.trim().slice(0, 600)
  if (!query) return
  const token = ++C.docs.followToken
  void postJSON('/api/kb/search', { query, docIds: C.kbDocIds.slice(0, 12), limit: 3 }, { timeoutMs: 15000 })
    .then((res) => {
      if (token !== C.docs.followToken || !C.docs.follow) return
      if (res && res.ok !== false && Array.isArray(res.hits) && res.hits.length) renderCitations(res.hits)
      else if (!localMatched) focusDocsByText(assistantText)
    })
    .catch(() => {
      if (!localMatched) focusDocsByText(assistantText)
    })
}

function pauseDocsFollow() {
  if (!C.docs.open || !C.docs.follow) return
  C.docs.follow = false
  if (D.docsFollow) D.docsFollow.checked = false
  toast('已暂停「跟随讲解」，点开关可恢复', 'info', 2200)
}

function setDocsFollow(on) {
  C.docs.follow = !!on
  if (D.docsFollow) D.docsFollow.checked = C.docs.follow
  if (C.docs.follow && C.docs.activeChunk && C.docs.open) scrollDocsToChunk()
  if (C.docs.follow) toast('已开启「跟随讲解」', 'info', 1600)
}

function adjustDocsFont(delta) {
  C.docs.fontSize = Math.max(DOCS_FONT_MIN, Math.min(DOCS_FONT_MAX, C.docs.fontSize + delta))
  if (D.docsBody) D.docsBody.style.fontSize = `${C.docs.fontSize}px`
}

function bindDocsControls() {
  if (!D.docs || C.docs.bound) return
  C.docs.bound = true
  if (D.docsFollow) {
    D.docsFollow.addEventListener('change', () => setDocsFollow(D.docsFollow.checked))
  }
  if (D.docsFontDec) D.docsFontDec.addEventListener('click', () => adjustDocsFont(-1))
  if (D.docsFontInc) D.docsFontInc.addEventListener('click', () => adjustDocsFont(1))
  if (D.docsClose) D.docsClose.addEventListener('click', () => closeDocsPanel())
  if (D.docsCollapse) D.docsCollapse.addEventListener('click', () => closeDocsPanel())
  if (D.docsTabs) {
    D.docsTabs.addEventListener('click', (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[data-doc]') : null
      if (tab) activateDocsDoc(tab.getAttribute('data-doc'))
    })
  }
  if (D.docsBody) {
    D.docsBody.addEventListener('click', (event) => {
      const node = event.target instanceof Element ? event.target.closest('.docs-sentence') : null
      if (!node) return
      const text = String(node.textContent || '').trim()
      const sentenceId = node.getAttribute('data-sentence-id') || ''
      C.docs.activeChunk = node.getAttribute('data-chunk-id') || ''
      C.docs.activeSentence = sentenceId
      renderDocsBody()
      scrollDocsToChunk()
      readDocsSentence(text, sentenceId)
    })
  }
  // 用户手动滚动 → 暂停跟随（程序化滚动由 autoScroll 标记忽略）
  if (D.docsBody) {
    D.docsBody.addEventListener(
      'wheel',
      () => {
        if (!C.docs.autoScroll) pauseDocsFollow()
      },
      { passive: true },
    )
    D.docsBody.addEventListener(
      'touchmove',
      () => {
        if (!C.docs.autoScroll) pauseDocsFollow()
      },
      { passive: true },
    )
  }
  // 移动端抽屉：在把手/标题上滑关闭、下滑（收起后）展开
  let startY = null
  const onTouchStart = (event) => {
    if (!event.touches || !event.touches.length) return
    startY = event.touches[0].clientY
  }
  const onTouchEnd = (event) => {
    if (startY == null) return
    const touch = (event.changedTouches && event.changedTouches[0]) || null
    const endY = touch ? touch.clientY : startY
    const delta = endY - startY
    startY = null
    if (Math.abs(delta) < 36) return
    if (delta > 0) closeDocsPanel()
    else openDocsPanel()
  }
  for (const node of [D.docsHandle, D.docsHead]) {
    if (!node) continue
    node.addEventListener('touchstart', onTouchStart, { passive: true })
    node.addEventListener('touchend', onTouchEnd, { passive: true })
  }
}

function clearCitations() {
  C.kbHits = []
  if (D.call) D.call.classList.remove('has-citations')
  if (D.citations) {
    D.citations.hidden = true
    D.citations.innerHTML = ''
  }
}


/* ------------------------------ 方案 C：唯一台词框 ------------------------------ */
/** 台词框里「你刚说的」一行（只显示最新一条，避免和消息记录重复堆叠）。 */
function setDialogueUser(text, zh = null) {
  const value = String(text == null ? '' : text).trim()
  C.lastUserLine = value
  void zh
  renderDialogueUser()
}

function renderDialogueUser() {
  if (!D.dlgUser) return
  if (!C.lastUserLine) {
    D.dlgUser.hidden = true
    D.dlgUser.innerHTML = ''
    return
  }
  D.dlgUser.hidden = false
  D.dlgUser.innerHTML = `<b>你</b><span>${esc(C.lastUserLine)}</span>`
}

function toggleHistory(force) {
  if (!D.call) return
  const next = typeof force === 'boolean' ? force : !D.call.classList.contains('history-open')
  D.call.classList.toggle('history-open', next)
  document.body.classList.toggle('call-history-open', next)
  if (D.historyLabel) D.historyLabel.textContent = next ? '收起' : '记录'
  if (D.historyBtn) {
    D.historyBtn.classList.toggle('is-on', next)
    D.historyBtn.setAttribute('aria-pressed', next ? 'true' : 'false')
  }
  if (next) {
    try {
      if (C.volc && C.volc.isActive) C.volc.pauseMic()
    } catch {
      /* 忽略 */
    }
  }
  if (next) {
    scrollBubblesToBottom(true)
  }
}

function showDialogue(text, zh = null, { final = false } = {}) {
  const value = String(text == null ? '' : text).trim()
  if (!D.dialogue) return
  if (!value) {
    hideDialogue()
    return
  }
  D.dialogue.hidden = false
  if (D.dlgName) D.dlgName.textContent = C.character ? C.character.name : 'Ava'
  if (D.dlgEn) D.dlgEn.textContent = value
  if (D.dlgZh) {
    const zhText = String(zh == null ? '' : zh).trim()
    D.dlgZh.textContent = zhText
    D.dlgZh.hidden = !zhText
  }
  D.dialogue.classList.toggle('is-final', !!final)
  renderDialogueUser()
  C.dialogueText = value
  C.dialogueZh = zh ? String(zh).trim() : null
  C.dialogueBubbleId = C.dialogueBubbleId || null
}

function setDialogueZh(zh) {
  const value = String(zh == null ? '' : zh).trim()
  if (!value || !D.dlgZh) return
  D.dlgZh.textContent = value
  D.dlgZh.hidden = false
  C.dialogueZh = value
}

function hideDialogue() {
  if (D.dialogue) D.dialogue.hidden = true
  C.dialogueText = ''
  C.dialogueZh = null
  C.dialogueBubbleId = null
}

function updateDialogueStatus(state) {
  if (!D.dlgState) return
  D.dlgState.textContent =
    state === 'speaking' ? '正在说话' : state === 'thinking' ? '思考中' : state === 'listening' ? '聆听中' : '在线'
}

/* ------------------------------ 气泡自动滚到最新（v1.8） ------------------------------ */
function isBubblesNearBottom(threshold = 110) {
  const el = D.bubbles
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

function scrollBubblesToBottom(force = false) {
  const el = D.bubbles
  if (!el) return
  if (!force && !isBubblesNearBottom()) return
  requestAnimationFrame(() => {
    try {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } catch {
      el.scrollTop = el.scrollHeight
    }
  })
}

/* ------------------------------ 气泡 ------------------------------ */
function addBubble(role, text, zh = null, { interim = false } = {}) {
  const id = 'bubble-' + ++C.bubbleSeq
  const node = document.createElement('div')
  node.className = `bubble ${role === 'user' ? 'me' : 'ava'}${interim ? ' interim' : ''}`
  node.id = id
  node.innerHTML = `
    <span class="bubble-name">${esc(role === 'user' ? '你' : C.character ? C.character.name : 'Ava')}</span>
    <div class="bubble-body">
      <div class="bubble-en">${esc(text)}</div>
      <div class="bubble-zh" ${zh ? '' : 'hidden'}>${esc(zh || '')}</div>
    </div>`
  const stick = isBubblesNearBottom(140)
  D.bubbles.appendChild(node)
  // 只保留最近 8 条，避免滚动区太长
  while (D.bubbles.children.length > 8) D.bubbles.firstElementChild.remove()
  if (stick) scrollBubblesToBottom(true)
  if (!interim) C.bubbles.push({ role, text, zh, id })
  return node
}

function setBubbleZh(id, zh) {
  const node = document.getElementById(id)
  if (!node) return
  const el = node.querySelector('.bubble-zh')
  if (!el) return
  if (zh) {
    el.textContent = zh
    el.hidden = !C.translateOn
  } else {
    el.hidden = true
  }
}

async function translateBubble(id, text) {
  if (!C.translateOn) return
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // 服务端翻译是串行队列且单次 8s 超时；快速多轮时后几句可能排队超时，这里最多重试 3 次
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!C.open) return
    if (attempt > 0) await delay(600 + attempt * 900)
    const result = await translateTexts([text])
    const zh = result && result[0]
    if (!zh) continue
    C.bubbles.forEach((b) => {
      if (b.id === id) b.zh = zh
    })
    setBubbleZh(id, zh)
    if (C.dialogueBubbleId === id) setDialogueZh(zh)
    scrollBubblesToBottom()
    return
  }
}

function translateAllBubbles() {
  C.bubbles.forEach((b) => {
    if (b.zh) setBubbleZh(b.id, C.translateOn ? b.zh : null)
  })
}

function showInterim(text) {
  if (!text) {
    if (C.interimEl) {
      C.interimEl.remove()
      C.interimEl = null
    }
    return
  }
  if (!C.interimEl) {
    C.interimEl = addBubble('user', text, null, { interim: true })
  } else {
    const en = C.interimEl.querySelector('.bubble-en')
    if (en) en.textContent = text
  }
  scrollBubblesToBottom()
}

function dropInterim() {
  if (C.interimEl) {
    C.interimEl.remove()
    C.interimEl = null
  }
}

/* ------------------------------ 音效 / 通话计时 ------------------------------ */
function startTimer() {
  stopTimer()
  C.startedAt = Date.now()
  D.timer.textContent = '00:00'
  C.timer = setInterval(() => {
    D.timer.textContent = mmss((Date.now() - C.startedAt) / 1000)
  }, 1000)
}
function stopTimer() {
  if (C.timer) clearInterval(C.timer)
  C.timer = null
}

/* ------------------------------ 口播动画（talking-head WebGL 引擎） ------------------------------ */
let headModule = null
let headModuleTried = false

async function loadTalkingHeadModule() {
  if (headModule || headModuleTried) return headModule
  headModuleTried = true
  try {
    headModule = await import('../talking-head.js')
  } catch (err) {
    console.warn('[mobile] talking-head 引擎未就绪，先用静态人物图兜底：', (err && err.message) || err)
    headModule = null
  }
  return headModule
}

async function loadMotion() {
  if (C.motion) return C.motion
  try {
    const res = await fetch('/assets/characters/motion.json', { cache: 'no-store' })
    if (res && res.ok) C.motion = await res.json()
  } catch {
    /* 没有 motion.json 时引擎可用默认参数 */
  }
  return C.motion
}

function destroyHead() {
  // 使在途的口播引擎挂载失效（避免通话已关闭后 canvas 才挂上）
  C.headToken = (C.headToken || 0) + 1
  stopSpeechPulse()
  if (C.head) {
    try {
      if (typeof C.head.destroy === 'function') C.head.destroy()
    } catch {
      /* 忽略 */
    }
  }
  C.head = null
  C.headChar = null
  if (D.head) {
    D.head.hidden = true
    D.head.innerHTML = ''
  }
  if (D.cover) D.cover.style.opacity = ''
}

/** 挂载口播引擎；引擎/素材未就绪时返回 null，页面继续用静态 <img>。 */
async function mountTalkingHead(character) {
  destroyHead()
  if (!D.head || !character) return null
  const token = C.headToken
  const mod = await loadTalkingHeadModule()
  if (token !== C.headToken || !C.open || C.character !== character) return null
  const factory = mod && (mod.createTalkingHead || mod.default)
  if (typeof factory !== 'function') return null
  const motionMap = await loadMotion()
  if (token !== C.headToken || !C.open || C.character !== character) return null
  // motion.json 是 { elena: {...}, maya: {...}, hikari: {...} }，取当前角色标定
  const motion = (motionMap && motionMap[character.id]) || motionMap || undefined
  try {
    // host 挂载前是 hidden（display:none），先显示以获得真实尺寸
    D.head.hidden = false
    const head = factory(D.head, {
      image: character.cover || `/assets/characters/${character.id}.jpg`,
      motion,
      width: D.head.clientWidth,
      height: D.head.clientHeight,
    })
    if (!head || head.ok === false) {
      if (D.head) D.head.hidden = true
      console.warn('[mobile] talking-head 不可用（可能缺少 WebGL），使用静态人物图兜底')
      try {
        if (head && typeof head.destroy === 'function') head.destroy()
      } catch {
        /* 忽略 */
      }
      return null
    }
    if (token !== C.headToken || !C.open || C.character !== character) {
      try { if (typeof head.destroy === 'function') head.destroy() } catch { /* 忽略 */ }
      return null
    }
    C.head = head
    C.headChar = character.id
    D.head.hidden = false
    if (D.cover) D.cover.style.opacity = '0'
    if (D.coverFallback) D.coverFallback.style.display = 'none'
    syncHeadMode(C.state)
    return head
  } catch (err) {
    console.warn('[mobile] talking-head 初始化失败，静态图兜底：', err)
    return null
  }
}

/** 通话状态 → 口播模式（idle / listening / thinking / speaking） */
function syncHeadMode(state) {
  if (!C.head || typeof C.head.setMode !== 'function') return
  try {
    C.head.setMode(state === 'speaking' ? 'speaking' : state === 'listening' ? 'listening' : state === 'thinking' ? 'thinking' : 'idle')
  } catch {
    /* 忽略引擎内部错误 */
  }
}

function setHeadLevel(level) {
  if (!C.head || typeof C.head.setSpeechLevel !== 'function') return
  // talking-head v2 建议区间 0–0.7（过大幅度会让脸变形）
  const value = Math.max(0, Math.min(0.7, Number(level) || 0))
  try {
    C.head.setSpeechLevel(value)
  } catch {
    /* 忽略 */
  }
}

/** 浏览器语音/TTS 没有真实音量时，用节奏估算驱动口型。 */
function startSpeechPulse() {
  if (C.speechTimer) return
  C.speechPhase = 0
  C.speechTimer = setInterval(() => {
    if (!C.head) return
    C.speechPhase += 0.42
    const level = C.state === 'speaking' ? 0.22 + Math.abs(Math.sin(C.speechPhase)) * 0.34 + Math.random() * 0.08 : 0
    setHeadLevel(level)
  }, 90)
}

function stopSpeechPulse() {
  if (C.speechTimer) clearInterval(C.speechTimer)
  C.speechTimer = null
  setHeadLevel(0)
}

/** 通话页氛围粒子（颜色跟随角色 themeColor，不改人物素材）。 */
function spawnCallParticles(themeColor) {
  if (!D.particles) return
  const theme = themeColor || '#6ff2dd'
  D.particles.innerHTML = ''
  for (let i = 0; i < 18; i++) {
    const bit = document.createElement('i')
    bit.style.left = (Math.random() * 100).toFixed(2) + '%'
    bit.style.animationDuration = (8 + Math.random() * 12).toFixed(2) + 's'
    bit.style.animationDelay = (-Math.random() * 16).toFixed(2) + 's'
    const size = 2 + Math.random() * 3
    bit.style.width = size.toFixed(1) + 'px'
    bit.style.height = size.toFixed(1) + 'px'
    bit.style.background = theme
    bit.style.boxShadow = '0 0 10px ' + theme
    D.particles.appendChild(bit)
  }
}


/* ------------------------------ 打开 / 关闭通话 ------------------------------ */
export async function openCall(characterOrId, sceneIdx = 0, opts = {}) {
  cacheDom()
  if (!C.bound) bindCall()
  const requestedTeacherId = opts && opts.teacherId ? String(opts.teacherId) : ''
  const teacherCharacter = requestedTeacherId ? characterById(requestedTeacherId) : null
  const character = teacherCharacter || (typeof characterOrId === 'string' ? characterById(characterOrId) : characterOrId || characterById('elena'))
  if (!character) {
    toast('角色加载失败，稍后再试', 'bad')
    return
  }
  if (C.open) endCall({ silent: true })
  const lessonOpt = opts && opts.lesson && typeof opts.lesson === 'object' ? opts.lesson : null
  const lessonHintScene = lessonOpt && lessonOpt.sceneId ? lessonOpt.sceneId : ''
  if (lessonHintScene) {
    const hintIdx = lessonSceneIndex(character, lessonHintScene)
    if (hintIdx >= 0) sceneIdx = hintIdx
  }
  C.character = character
  C.sceneIdx = Math.max(0, Math.min((character.scenes || []).length - 1, Number(sceneIdx) || 0))
  C.scene = (character.scenes || [])[C.sceneIdx] || { id: 'free', label: '自由聊聊天', emoji: '💬' }
  C.messages = []
  C.bubbles = []
  C.userTurns = 0
  C.lastUserLine = ''
  C.materialStarted = false
  if (D.dialogue) {
    D.dialogue.hidden = true
    D.dialogue.classList.remove('is-final')
  }
  renderDialogueUser()
  if (D.call) D.call.classList.remove('history-open')
  document.body.classList.remove('call-history-open')
  if (D.historyLabel) D.historyLabel.textContent = '记录'
  if (D.historyBtn) {
    D.historyBtn.classList.remove('is-on')
    D.historyBtn.setAttribute('aria-pressed', 'false')
  }
  C.bubbleSeq = 0
  C.translateOn = true
  C.muted = false
  C.endAfterSheet = false
  abortPtt({ silent: true })
  clearPttTimers()
  C.volcToken = -1
  bumpPttToken()
  resetPttForNewTurn()
  setPttState('idle')
  stopMicMonitor()
  setMicDock('checking')
  C.kbMode = ['free', 'grounded', 'divergent'].includes(opts && opts.kbMode) ? opts.kbMode : 'free'
  C.kbDocIds = Array.isArray(opts && opts.kbDocIds) ? opts.kbDocIds.map(String).filter(Boolean) : []
  C.kbDocTitles = Array.isArray(opts && opts.kbDocs) ? opts.kbDocs.map(String) : []
  C.kbHits = []
  renderKbBar()
  clearCitations()
  resetDocsForCall()
  clearLessonState()
  if (lessonOpt) {
    applyLesson(lessonOpt, { stageId: (opts && opts.stageId) || '', sceneId: lessonHintScene })
    if (C.lesson && C.lesson.sceneId) {
      const idx = lessonSceneIndex(character, C.lesson.sceneId)
      if (idx >= 0) {
        C.sceneIdx = idx
        C.scene = character.scenes[idx]
      }
    }
  } else if (opts && opts.lessonId) {
    const wantedId = String(opts.lessonId)
    const wantedStage = String(opts.stageId || '')
    void (async () => {
      try {
        const data = await getJSON('/api/lessons/' + encodeURIComponent(wantedId))
        if (data && data.lesson && C.open && C.character === character) {
          applyLesson(data.lesson, { stageId: wantedStage, sceneId: data.lesson.sceneId })
          const idx = lessonSceneIndex(character, data.lesson.sceneId)
          if (idx >= 0) {
            C.sceneIdx = idx
            C.scene = character.scenes[idx]
          }
        }
      } catch {
        toast('课程内容加载失败，可继续自由聊', 'bad', 3000)
      }
    })()
  }
  if (C.kbMode === 'grounded' && !C.kbDocIds.length) {
    toast('知识库讨论需要先在助手页「知识库」勾选材料', 'info', 3400)
  }
  D.call.hidden = false
  C.open = true
  D.call.dataset.char = character.id
  const theme = character.themeColor || '#6b4a2e'
  D.call.style.setProperty('--char-grad', `radial-gradient(130% 100% at 50% 0%, ${hexToRgba(theme, 0.6)}, #10131f 62%, #07080d 100%)`)
  if (D.bg) D.bg.style.background = `radial-gradient(130% 100% at 50% 0%, ${hexToRgba(theme, 0.55)}, #10131f 60%, #07080d 100%)`
  if (D.coverFallback) {
    // 先显示主题色兜底，图片加载成功后再隐藏（v1.6 修复：不再遮住角色图）
    D.coverFallback.style.display = ''
    D.coverFallback.style.background = `radial-gradient(130% 100% at 50% 0%, ${hexToRgba(theme, 0.55)}, #10131f 62%, #07080d 100%)`
  }
  if (D.cover) {
    D.cover.style.display = ''
    D.cover.onload = () => {
      D.cover.style.display = ''
      if (D.coverFallback) D.coverFallback.style.display = 'none'
    }
    D.cover.onerror = () => {
      D.cover.style.display = 'none'
      if (D.coverFallback) D.coverFallback.style.display = ''
    }
    D.cover.src = character.cover || `./assets/characters/${character.id}.svg`
    // 已缓存/已加载完成时 onload 可能不再触发
    if (D.cover.complete && D.cover.naturalWidth > 0) {
      if (D.coverFallback) D.coverFallback.style.display = 'none'
    }
  }
  spawnCallParticles(theme)
  void mountTalkingHead(character)
  if (D.name) D.name.textContent = character.name || 'Ava'
  if (D.sub) {
    const subParts = [character.city, character.occupation || character.role || ''].filter(Boolean)
    D.sub.textContent = subParts.join(' · ')
  }
  D.bubbles.innerHTML = ''
  D.hint.hidden = true
  D.textForm.hidden = true
  D.textBtn.classList.remove('is-on')
  D.mute.classList.remove('is-on')
  D.mute.classList.add('is-on')
  D.translate.classList.add('is-on')
  D.translate.setAttribute('aria-pressed', 'true')
  C.engine = await detectEngine()
  updateEngineLabel()
  setState('idle')
  startTimer()
  // 开场白：进入资料模式时不要角色自由聊天开场，等资料加载后直接从第一句开始带读
  const materialMode = C.kbMode === 'grounded' && C.kbDocIds.length > 0
  if (!materialMode) {
    const greeting = C.lesson && C.lesson.teacherIntro
      ? C.lesson.teacherIntro
      : character.greeting || "Hi! I'm really glad you called. How's your day going?"
    const greetingZh = C.lesson ? null : character.greetingZh || null
    const node = addBubble('ava', greeting, greetingZh)
    C.messages.push({ role: 'assistant', content: greeting })
    C.dialogueBubbleId = node.id
    showDialogue(greeting, greetingZh)
    scrollBubblesToBottom(true)
    if (!greetingZh) void translateBubble(node.id, greeting)
  }
  document.body.classList.add('call-open')
  void initMicForCall()
  void initDocsForCall()
  setTimeout(() => scheduleVolcWarmup(200), 250)
  return true
}

async function detectEngine() {
  const settings = M.settings || {}
  if (settings.voiceEngine === 'volc' && settings.volc && settings.volc.configured) {
    const voice = await ensureVolc()
    if (voice) return 'volc'
  }
  return 'browser'
}

/* ------------------------------ 豆包实时语音 ------------------------------ */

/** 录音中但本轮尚未 commit：服务端 VAD 自触发的回复一律不处理（防自说自话） */
function isUnsolicitedWhileRecording() {
  return C.ptt === 'recording' && !C.pttCommitted
}

function interruptAutoReplyOnce(reason) {
  const now = Date.now()
  if (now - C.lastAutoReplyInterruptAt < 1500) return
  C.lastAutoReplyInterruptAt = now
  try {
    tts.cancel()
  } catch {
    /* 忽略 */
  }
  try {
    if (C.volc) {
      if (typeof C.volc.cancelTurn === 'function') C.volc.cancelTurn()
      else if (C.volc.isActive) C.volc.interrupt()
    }
  } catch {
    /* 忽略 */
  }
  if (!C.autoReplyNotified) {
    C.autoReplyNotified = true
    toast('检测到自动回复，已打断；请说完后点麦克风结束', 'info', 3200)
  }
  void reason
}


async function ensureVolc() {
  if (C.volc) return C.volc
  if (C.volcLoading) return C.volcLoading
  C.volcLoading = (async () => {
    try {
      const mod = await import('../doubao-voice.js')
      const factory = mod.createDoubaoVoice || mod.createDoubao || mod.default
      if (typeof factory !== 'function') return null
      const voice = factory({
        characterId: C.character && C.character.id,
        outputMuted: materialTtsMode(),
        onReady(info) {
          if (!volcCallbacksValid()) return
          C.engine = 'volc'
          if (C.ptt === 'connecting') {
            setPttState('recording')
            setState('listening')
          }
          if (info && info.character && info.character.name && D.name) D.name.textContent = info.character.name
          if (info) {
            const hits = extractKbHits(info)
            if (hits) renderCitations(hits)
            if (info.kb && Array.isArray(info.kb.docIds) && !C.kbDocIds.length) {
              C.kbDocIds = info.kb.docIds.map(String)
              renderKbBar()
              void initDocsForCall()
            }
          }
          if (D.signal) D.signal.textContent = '实时语音 · 已连接'
        },
        onASR(payload) {
          if (!volcCallbacksValid()) return
          if (isUnsolicitedWhileRecording()) {
            // 只显示 interim；final 不落气泡（服务端 VAD 自触发）
            if (payload && !payload.final) showInterim(String(payload.text || ''))
            return
          }
          const text = String((payload && payload.text) || '')
          if (!payload || !payload.final) {
            showInterim(text)
            return
          }
          dropInterim()
          const finalText = String(text || '').trim()
          if (!finalText) return
          // 某些桥实现会对同一句 ASR 连发两次 final，2.5s 内相同文本去重，避免用户气泡重复
          const now = Date.now()
          if (C.lastAsrText === finalText && now - C.lastAsrAt < 2500) {
            C.lastAsrAt = now
            setState('thinking')
            return
          }
          C.lastAsrText = finalText
          C.lastAsrAt = now
          C.pttLastAsrAt = now
          C.pttAsrSeen = true
          if (C.pttAsrTimer) {
            clearTimeout(C.pttAsrTimer)
            C.pttAsrTimer = null
          }
          if (C.lesson) lessonOnUserText(finalText)
          const node = addBubble('user', finalText)
          setDialogueUser(finalText)
          C.messages.push({ role: 'user', content: finalText })
          C.userTurns += 1
          void translateBubble(node.id, finalText)
          setState('thinking')
        },
        onChat(payload) {
          if (!volcCallbacksValid()) return
          C.pttReplySeen = true
          clearPttTimers()
          const text = String((payload && payload.text) || '')
          const final = !!(payload && payload.final)
          if (!text && !final) return
          if (text) {
            if (!C.streamBubbleId) {
              const node = addBubble('ava', text)
              C.streamBubbleId = node.id
              C.dialogueBubbleId = node.id
              C.streamText = text
              setState('speaking')
            } else {
              C.streamText += text
              const node = document.getElementById(C.streamBubbleId)
              const en = node && node.querySelector('.bubble-en')
              if (en) en.textContent = C.streamText
              scrollBubblesToBottom()
              setState('speaking')
            }
            showDialogue(C.streamText)
          }
          if (!final) return
          // v1.8 P1 修复：bridge 的 final 事件 text 可能为空，用累积的 streamText 落定
          const finalText = String(C.streamText || '').trim()
          if (C.streamBubbleId && finalText) {
            const node = document.getElementById(C.streamBubbleId)
            if (node) {
              const en = node.querySelector('.bubble-en')
              if (en) en.textContent = finalText
            }
            C.messages.push({ role: 'assistant', content: finalText })
            C.dialogueBubbleId = C.streamBubbleId
            void translateBubble(C.streamBubbleId, finalText)
            showDialogue(finalText, C.dialogueZh, { final: true })
          }
          refreshDocsFollow(finalText)
          C.streamBubbleId = null
          C.streamText = ''
          if (materialTtsMode()) {
            clearPttTimers()
            setPttState('idle')
            speakGroundedReply(finalText)
          } else if (C.state !== 'speaking') {
            clearPttTimers()
            setPttState('idle')
            setState('idle')
          }
          scrollBubblesToBottom(true)
        },
        onAudioStart() {
          if (!volcCallbacksValid()) return
          if (materialTtsMode()) return
          C.pttReplySeen = true
          clearPttTimers()
          C.turnAudioBytes = 0
          startTeacherAudioGuard()
          // 硬上限：台词最多约 25 词，正常语音不会超过 13 秒；超时说明上游卡住
          if (C.teacherTurnTimer) clearTimeout(C.teacherTurnTimer)
          C.teacherTurnTimer = setTimeout(() => {
            C.teacherTurnTimer = null
            if (!C.open || C.closingCall) return
            if (C.state !== 'speaking' && C.ptt !== 'speaking' && C.ptt !== 'submitting') return
            console.warn('[call] realtime teacher turn exceeded 13s, continue with TTS')
            teacherStalled('turn-timeout')
          }, 13000)
          if (C.ptt === 'submitting') setPttState('speaking')
          setState('speaking')
        },
        onAudioProgress(payload) {
          if (!volcCallbacksValid()) return
          if (materialTtsMode()) return
          C.pttReplySeen = true
          C.lastTeacherAudioAt = Date.now()
          if (payload && Number.isFinite(Number(payload.bytes))) C.turnAudioBytes += Number(payload.bytes)
          if (!C.audioStallTimer) startTeacherAudioGuard()
        },
        onAudioEnd(payload) {
          if (!volcCallbacksValid()) return
          if (materialTtsMode()) return
          if (isUnsolicitedWhileRecording()) return
          const reason = payload && payload.reason
          const text = String(C.dialogueText || C.streamText || '').trim()
          const expectedSec = Math.max(0, text.length / 14)
          const actualSec = C.turnAudioBytes / 48000
          const clearlyCut = expectedSec > 6 && actualSec > 0.4 && actualSec < expectedSec * 0.55
          clearPttTimers()
          if (C.ptt === 'submitting' || C.ptt === 'speaking') setPttState('idle')
          // PTT：audio-end 后一律回 idle，不自动进入 listening 等下一轮
          setState('idle')
          if (clearlyCut && C.open && !C.closingCall) {
            console.warn('[call] realtime audio ended early: %ss of expected %ss', actualSec.toFixed(1), expectedSec.toFixed(1))
            void fallbackContinueWithTts('audio-cut')
            return
          }
          scheduleVolcWarmup(600)
          if (reason === 'interrupt') {
            /* 已中断，无额外动作 */
          }
        },
        onLevel(level) {
          if (!volcCallbacksValid()) return
          const value = Math.max(0, Math.min(1, Number(level) || 0))
          if (D.glow) D.glow.style.filter = `brightness(${1 + value * 0.35})`
          setHeadLevel(Math.min(0.7, value))
        },
        onMicLevel(level) {
          const value = Math.max(0, Math.min(1, Number(level) || 0))
          C.pttMicLevel = value
          C.pttLevelSeen = true
          if (C.ptt === 'recording') {
            C.pttPeak = Math.max(C.pttPeak || 0, value)
            if (value > 0.04) {
              C.pttHadSound = true
              C.pttLastSoundAt = Date.now()
              if (C.pttSoundHintShown) {
                C.pttSoundHintShown = false
                if (D.pttHint) D.pttHint.textContent = '正在录音… 再点一次麦克风结束'
              }
            }
          }
        },
        onError(err) {
          if (!volcCallbacksValid()) return
          if (C.volcWarming) {
            resetVolcSession()
            return
          }
          const message = (err && err.message) || '实时语音连接失败'
          const code = err && err.code
          // 客户端 WS 自己正在重连：交给 doubao-voice 完成，不当作致命错误
          if (code === 'closed' && /重新连接|重连中/.test(message)) {
            if (D.signal) D.signal.textContent = '语音重连中…'
            return
          }
          if (recoverVolcConnection(message)) return
          if (fallbackContinueWithTts(message)) return
          resetVolcSession()
          setPttState('idle')
          setState('idle')
          updateEngineLabel()
          toast('语音波动，已切换到文字模式；可先打字继续', 'info', 3600)
        },
        onEnded() {
          if (!volcCallbacksValid()) return
          stopPttWatchdog()
          clearPttTimers()
          const wasWarming = C.volcWarming
          const wasRecording = C.ptt === 'recording'
          if (C.ptt === 'recording' || C.ptt === 'submitting' || C.ptt === 'speaking') setPttState('idle')
          if (C.state !== 'idle') setState('idle')
          C.volc = null
          C.volcLoading = null
          C.volcToken = -1
          bumpPttToken()
          if (typeof window !== 'undefined') window.__avaDebugVoice = null
          if (C.open && !C.closingCall && !wasWarming && recoverVolcConnection('ended')) return
          if (C.open && !C.closingCall && !wasWarming) {
            if (!fallbackContinueWithTts('ended')) {
              toast('语音波动，正在恢复；可先打字继续', 'info', 3200)
            }
          } else if (wasRecording && !wasWarming) {
            toast('语音连接已断开，请再点麦克风重试', 'bad', 3200)
          }
        },
      })
      if (voice && voice.isSupported === false) return null
      if (typeof voice.setOutputMuted === 'function') voice.setOutputMuted(materialTtsMode())
      C.volc = voice
      if (typeof window !== 'undefined') window.__avaDebugVoice = voice
      return voice
    } catch (err) {
      console.warn('[mobile] 豆包语音加载失败：', err)
      return null
    } finally {
      C.volcLoading = null
    }
  })()
  return C.volcLoading
}

/** 资料模式：实时对话只取文字，老师声音改用完整角色 TTS，避免上游 TTS 中途断流。 */
function materialTtsMode() {
  return C.kbMode === 'grounded' && C.kbDocIds.length > 0
}

function speakGroundedReply(text) {
  const value = String(text || '').trim()
  if (!value) return
  const token = ++C.groundedTtsToken
  void stopCharacterVoice()
  setState('speaking')
  void playCharacterVoice(value, {
    onEnd: () => {
      if (token === C.groundedTtsToken && C.state === 'speaking') setState('idle')
      scheduleVolcWarmup(600)
    },
  }).then((played) => {
    if (token !== C.groundedTtsToken) return
    if (!played && C.state === 'speaking') setState('idle')
  })
}

function isVolcSessionActive() {
  return !!(C.volc && C.volc.isActive)
}

async function toggleVolc() {
  const voice = await ensureVolc()
  if (!voice) {
    toast('语音正在重连，请稍等再试', 'info', 2800)
    return
  }
  C.engine = 'volc'
  updateEngineLabel()
  if (isVolcSessionActive()) {
    if (C.state === 'speaking') {
      try {
        voice.interrupt()
      } catch {
        /* 忽略 */
      }
      setState('listening')
      return
    }
    try {
      voice.stop()
    } catch {
      /* 忽略 */
    }
    setState('idle')
    return
  }
  try {
    setState('thinking')
    const started = voice.start({
      mode: 'free',
      level: (M.settings && M.settings.level) || 'A2',
      teacherName: C.character ? C.character.name : 'Ava',
      characterId: C.character ? C.character.id : undefined,
      // v1.8：知识库/发散讨论模式随语音会话透传（doubao-voice 写入 start 帧）
      kbMode: C.kbMode,
      ...(C.kbDocIds.length ? { kbDocIds: C.kbDocIds } : {}),
      history: voiceHistoryPayload(),
    })
    const ok = started && typeof started.then === 'function' ? await started : started !== false
    if (!ok) {
      resetVolcSession()
      setState('idle')
      toast('语音正在重连，请稍等再试', 'info', 2800)
      return
    }
    setState('listening')
  } catch (err) {
    resetVolcSession()
    toast((err && err.message) || '语音暂时连接不上，请稍后再试', 'bad', 3400)
    setState('idle')
  }
}

/* ------------------------------ 麦克风自检 / 诊断（v2.3） ------------------------------ */
const MIC_MESSAGES = {
  denied: '麦克风权限被拒绝。请点击「重新授权麦克风」再次允许，或改用文字输入。',
  unavailable: '没有找到可用的麦克风设备，请检查系统输入设备后重试，或改用文字输入。',
  busy: '麦克风被其他程序占用（或系统不支持），请关闭占用程序后重试，或改用文字输入。',
  unsupported: '当前环境无法访问麦克风（需要 HTTPS/localhost 且浏览器支持）。可以直接打字聊天。',
  error: '麦克风启动失败，请检查系统输入设备或改用文字输入。',
  silent: '没有检测到声音，请检查系统输入设备 / 静音键 / 浏览器权限。',
  network: '语音识别服务当前不可达（网络问题）。可以换网络重试，或改用文字输入；我方本地听写上线后会更好用。',
  'no-speech': '没有检测到声音，请靠近麦克风再说一次，或改用文字输入。',
  interrupted: '语音识别被系统打断，请再点一次麦克风重试。',
  'no-mic': '没有可用的麦克风输入，请检查设备后重试，或改用文字输入。',
  'stt-fail': '语音识别暂不可用，请再试一次或改用文字输入。',
}

function setMicDock(state, { message = '', showRetry = false, showText = false, showDiag = false, label = '', retryLabel = '' } = {}) {
  C.mic.state = state
  if (D.micDot) D.micDot.className = 'mic-dot is-' + state
  if (D.micLabel) {
    D.micLabel.textContent =
      label ||
      (state === 'checking'
        ? '正在请求麦克风…'
        : state === 'ready'
          ? '麦克风正常'
          : state === 'silent'
            ? '没有检测到声音'
            : state === 'denied'
              ? '麦克风权限被拒绝'
              : state === 'unavailable'
                ? '未找到可用麦克风'
                : state === 'unsupported'
                  ? '无法访问麦克风'
                  : state === 'recording'
                    ? '正在收音…'
                    : '麦克风不可用')
  }
  if (D.micExtra) {
    const text = message || MIC_MESSAGES[state] || ''
    const show = !!(text && state !== 'ready' && state !== 'checking' && state !== 'recording')
    D.micExtra.hidden = !show
    if (D.micMessage) D.micMessage.textContent = show ? text : ''
    if (D.micRetry) {
      D.micRetry.hidden = !(show && showRetry)
      D.micRetry.textContent = retryLabel || '重新授权麦克风'
    }
    if (D.micTextBtn) D.micTextBtn.hidden = !(show && showText)
    if (D.micDiagBtn) D.micDiagBtn.hidden = !(show && showDiag)
  }
}

function renderMicVolume(level) {
  const value = Math.max(0, Math.min(1, Number(level) || 0))
  if (D.micVolume) {
    const bars = D.micVolume.children
    for (let i = 0; i < bars.length; i++) {
      const threshold = (i + 1) / (bars.length + 1)
      bars[i].classList.toggle('is-on', value > threshold * 0.8)
    }
  }
  // PTT 录音时把真实音量映射到波形
  if (C.ptt === 'recording' && D.pttWave) {
    const bars = D.pttWave.children
    for (let i = 0; i < bars.length; i++) {
      const shape = 0.35 + 0.65 * Math.abs(Math.sin((i + 1) * 0.9))
      const h = Math.max(0.12, Math.min(1, value * 1.6 * shape + 0.1))
      bars[i].style.transform = `scaleY(${h.toFixed(3)})`
    }
  }
}

function micLoopTick() {
  const analyser = C.mic.analyser
  if (!analyser || !C.mic.data) return
  analyser.getByteTimeDomainData(C.mic.data)
  let sum = 0
  for (let i = 0; i < C.mic.data.length; i++) {
    const d = (C.mic.data[i] - 128) / 128
    sum += d * d
  }
  const rms = Math.sqrt(sum / C.mic.data.length)
  const level = Math.min(1, rms * 3.6)
  C.mic.level = level
  renderMicVolume(level)
  if (C.mic.state === 'ready' || C.mic.state === 'silent' || C.ptt === 'recording') {
    const now = Date.now()
    if (level < 0.025) {
      if (!C.mic.silentSince) C.mic.silentSince = now
      if (now - C.mic.silentSince > 2000 && !C.mic.silentNotified) {
        C.mic.silentNotified = true
        setMicDock('silent', { message: MIC_MESSAGES.silent, showText: true })
        if (D.pttHint) D.pttHint.textContent = '没有检测到声音… 请检查麦克风'
      }
    } else {
      C.mic.silentSince = now
      if (C.mic.silentNotified) {
        C.mic.silentNotified = false
        setMicDock('ready')
        if (D.pttHint) D.pttHint.textContent = '正在录音… 再点一次麦克风结束'
      }
    }
  }
  void C.mic
}

function startMicLoop() {
  stopMicLoop()
  C.mic.loop = setInterval(micLoopTick, 100)
}

function stopMicLoop() {
  if (C.mic.loop) clearInterval(C.mic.loop)
  C.mic.loop = null
}

function classifyMicError(err) {
  const name = String((err && (err.name || err.code)) || '')
  if (/NotAllowed|Security|Permission/i.test(name)) return 'denied'
  if (/NotFound|DevicesNotFound/i.test(name)) return 'unavailable'
  if (/NotReadable|TrackStart|Busy/i.test(name)) return 'busy'
  if (/NotSupported|Overconstrained/i.test(name)) return 'unsupported'
  return 'error'
}

/* ------------------------------ 麦克风环境 / 权限诊断（v2.5） ------------------------------ */
function micDiagnosticsImpl() {
  const env = C.mic.env || {}
  const settings = M.settings || {}
  const data = {
    url: location.href,
    protocol: location.protocol,
    isSecureContext: !!window.isSecureContext,
    hasMediaDevices: !!env.hasMedia,
    permission: env.permission || 'unknown',
    audioInputs: typeof env.audioInputs === 'number' ? env.audioInputs : -1,
    ua: navigator.userAgent,
    voiceEngine: settings.voiceEngine || 'unknown',
    volc: {
      configured: !!(settings.volc && settings.volc.configured),
      hasKey: !!(settings.volc && settings.volc.hasKey),
      model: (settings.volc && settings.volc.model) || '',
    },
    ptt: C.ptt,
    micState: C.mic.state,
    voice: readVoiceDiag(),
    checkedAt: new Date().toISOString(),
  }
  window.__lastMicDiag = data
  return data
}

async function copyMicDiagnostics() {
  const json = JSON.stringify(micDiagnostics(), null, 2)
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(json)
      toast('已复制诊断信息，可发给开发者', 'ok', 2600)
      return
    }
  } catch {
    /* 回退 execCommand */
  }
  try {
    const area = document.createElement('textarea')
    area.value = json
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    toast(ok ? '已复制诊断信息，可发给开发者' : '复制失败，请手动截图诊断信息', ok ? 'ok' : 'bad', 2600)
  } catch {
    toast('复制失败，请手动截图诊断信息', 'bad', 2600)
  }
}

/** 检测安全上下文 / mediaDevices / 麦克风权限 / 输入设备，并渲染环境提示。 */
async function detectMicEnvironment() {
  const secure = typeof window !== 'undefined' ? window.isSecureContext !== false : false
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : null
  const hasMedia = !!(media && typeof media.getUserMedia === 'function')
  let permission = 'unknown'
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      const status = await navigator.permissions.query({ name: 'microphone' })
      permission = status && status.state ? status.state : 'unknown'
    }
  } catch {
    permission = 'unknown'
  }
  let audioInputs = -1
  try {
    if (hasMedia && typeof media.enumerateDevices === 'function') {
      const list = await media.enumerateDevices()
      audioInputs = list.filter((device) => device && device.kind === 'audioinput').length
    }
  } catch {
    audioInputs = -1
  }
  const env = {
    secure,
    hasMedia,
    permission,
    audioInputs,
    ua: navigator.userAgent,
    url: location.href,
    protocol: location.protocol,
    checkedAt: Date.now(),
  }
  C.mic.env = env
  renderMicEnvironment(env)
  return env
}

function renderMicEnvironment(env) {
  const blocked = !env.secure || !env.hasMedia
  if (D.envBanner) {
    if (!env.secure) {
      D.envBanner.hidden = false
      D.envBanner.textContent = '当前地址不是安全环境：请用 http://127.0.0.1:5180 或 HTTPS 打开，不能用局域网 IP 的 http。'
      D.envBanner.classList.add('is-blocked')
    } else if (!env.hasMedia) {
      D.envBanner.hidden = false
      D.envBanner.textContent = '当前浏览器没有可用的麦克风 API（mediaDevices 缺失），请换 Chrome 或 HTTPS 打开，或改用文字输入。'
      D.envBanner.classList.add('is-blocked')
    } else if (env.permission === 'denied') {
      D.envBanner.hidden = false
      D.envBanner.textContent = 'Chrome 已阻止本站麦克风：点下方「如何开启麦克风」按步骤允许，或改用文字输入。'
      D.envBanner.classList.add('is-blocked')
    } else if (env.audioInputs === 0) {
      D.envBanner.hidden = false
      D.envBanner.textContent = '没有检测到麦克风输入设备：请检查 macOS 系统设置 → 隐私与安全性 → 麦克风 → Google Chrome。'
      D.envBanner.classList.add('is-blocked')
    } else {
      D.envBanner.hidden = true
      D.envBanner.classList.remove('is-blocked')
      D.envBanner.textContent = ''
    }
  }
  if (D.talk) {
    D.talk.disabled = blocked
    D.talk.classList.toggle('is-disabled', blocked)
    D.talk.setAttribute('aria-label', blocked ? '语音在此环境不可用，请改用文字输入' : '点击开始说话')
  }
  if (blocked) {
    setMicDock('unsupported', {
      label: env.secure ? '无法访问麦克风' : '当前环境不支持麦克风',
      message: env.secure
        ? '当前浏览器无法访问麦克风，请换 Chrome 或 HTTPS 打开，或改用文字输入。'
        : '当前地址不是安全环境：请用 http://127.0.0.1:5180 或 HTTPS 打开；局域网 http 地址无法使用麦克风。',
      showRetry: false,
      showDiag: true,
      showText: true,
    })
    return
  }
  if (env.permission === 'denied') {
    setMicDock('denied', {
      label: 'Chrome 已阻止本站麦克风',
      message: '浏览器已阻止本站麦克风，需手动开启：点「如何开启麦克风」按步骤把本站麦克风改为「允许」，然后刷新页面。',
      showRetry: true,
      retryLabel: '如何开启麦克风',
      showDiag: true,
      showText: true,
    })
    return
  }
  if (env.audioInputs === 0) {
    setMicDock('unavailable', {
      label: '未检测到麦克风设备',
      message: '请检查 macOS「系统设置 → 隐私与安全性 → 麦克风 → Google Chrome」是否勾选，检查外接/内置麦克风后点「重新检测」。',
      showRetry: true,
      retryLabel: '重新检测',
      showDiag: true,
      showText: true,
    })
  }
}

/** 进入通话页：先做环境检测，正常才请求麦克风。 */
async function initMicForCall() {
  const env = await detectMicEnvironment()
  if (!env.secure || !env.hasMedia) return false
  if (env.permission === 'denied') return false
  if (env.audioInputs === 0) return false
  return ensureMicMonitor()
}

/** 「重新授权 / 重新检测 / 如何开启」按钮：始终有即时反馈，不静默。 */
async function handleMicRetry() {
  setMicDock('checking', { label: '正在请求麦克风权限…', message: '正在请求麦克风权限…', showText: true, showDiag: true })
  const env = await detectMicEnvironment()
  if (!env.secure || !env.hasMedia) {
    setMicDock('unsupported', {
      label: env.secure ? '无法访问麦克风' : '当前环境不支持麦克风',
      message: '请用 http://127.0.0.1:5180 或 HTTPS 打开；当前地址/浏览器无法使用麦克风，可改用文字输入。',
      showDiag: true,
      showText: true,
    })
    return
  }
  if (env.permission === 'denied') {
    showMicHelpSheet('denied')
    return
  }
  if (env.audioInputs === 0) {
    const ok = await ensureMicMonitor({ force: true })
    const env2 = await detectMicEnvironment()
    if (!ok && env2.audioInputs === 0) {
      setMicDock('unavailable', {
        label: '未检测到麦克风设备',
        message: '仍然没有检测到麦克风。请检查 macOS「系统设置 → 隐私与安全性 → 麦克风 → Google Chrome」是否勾选，或改用文字输入。',
        showRetry: true,
        retryLabel: '重新检测',
        showDiag: true,
        showText: true,
      })
    }
    return
  }
  const ok = await ensureMicMonitor({ force: true })
  if (ok) {
    toast('麦克风已就绪', 'ok', 2000)
    return
  }
  const env2 = await detectMicEnvironment()
  if (env2.permission === 'denied') {
    setMicDock('denied', {
      label: '被浏览器阻止，需手动开启',
      message: '仍然被浏览器阻止（需手动开启）：点「如何开启麦克风」按步骤把本站麦克风设为「允许」，然后刷新页面；也可以直接用文字输入。',
      showRetry: true,
      retryLabel: '如何开启麦克风',
      showDiag: true,
      showText: true,
    })
    toast('浏览器已阻止麦克风，需按步骤手动开启', 'bad', 3600)
  } else if (env2.audioInputs === 0) {
    setMicDock('unavailable', {
      label: '未检测到麦克风设备',
      message: '请检查 macOS 系统设置 → 隐私与安全性 → 麦克风 → Google Chrome，或改用文字输入。',
      showRetry: true,
      retryLabel: '重新检测',
      showDiag: true,
      showText: true,
    })
  } else {
    setMicDock('error', {
      label: '麦克风仍不可用',
      message: '重新授权后麦克风仍不可用：请检查系统输入设备/其他程序占用，或改用文字输入。',
      showRetry: true,
      showDiag: true,
      showText: true,
    })
  }
}

function showMicHelpSheet(kind = 'denied') {
  const env = C.mic.env || {}
  const intro =
    kind === 'env' || !env.secure
      ? '当前地址不是安全环境，麦克风无法使用。请先换用 http://127.0.0.1:5180 或 HTTPS 地址打开。'
      : '如果 Chrome 已阻止本站麦克风，按下面步骤把它改为「允许」：'
  ui.openSheet(
    '开启麦克风权限',
    `<div class="mic-help">
      <p>${esc(intro)}</p>
      <ol class="mic-help-steps">
        <li>点浏览器地址栏左侧的图标（锁 / 滑杆 / 网站信息）。</li>
        <li>选择「网站设置」（Site settings）。</li>
        <li>找到「麦克风（Microphone）」，改为「允许（Allow）」。</li>
        <li>回到本页，点「重新加载页面」或按 ⌘R 刷新。</li>
      </ol>
      <p class="mic-help-note">如果网站设置里没有麦克风选项：打开 macOS「系统设置 → 隐私与安全性 → 麦克风」，确认已勾选 Google Chrome。</p>
      <div class="mic-help-actions">
        <button type="button" class="btn btn-ghost" data-act="mic-reload">重新加载页面</button>
        <button type="button" class="btn btn-primary" data-act="mic-copy">复制诊断信息</button>
      </div>
    </div>`,
  )
  const body = $('#sheet-body')
  if (body) {
    body.onclick = (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
      if (!target) return
      const act = target.getAttribute('data-act')
      if (act === 'mic-reload') location.reload()
      else if (act === 'mic-copy') void copyMicDiagnostics()
    }
  }
}

/** 请求麦克风 + 实时音量条 + 权限诊断（不保存/上传任何音频）。 */
async function ensureMicMonitor({ force = false } = {}) {
  if (C.mic.pending) return C.mic.pending
  if (C.mic.active && !force) return true
  if (force) stopMicMonitor()
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : null
  if (!media || typeof media.getUserMedia !== 'function') {
    setMicDock('unsupported', { message: MIC_MESSAGES.unsupported, showText: true })
    return false
  }
  setMicDock('checking')
  C.mic.pending = (async () => {
    try {
      const stream = await media.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) throw Object.assign(new Error('AudioContext 不可用'), { name: 'NotSupportedError' })
      const ctx = new AC()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      C.mic.stream = stream
      C.mic.ctx = ctx
      C.mic.analyser = analyser
      C.mic.data = new Uint8Array(analyser.fftSize)
      C.mic.active = true
      C.mic.silentSince = Date.now()
      C.mic.silentNotified = false
      if (D.call) D.call.classList.add('mic-live')
      setMicDock('ready')
      startMicLoop()
      return true
    } catch (err) {
      const kind = classifyMicError(err)
      const messages = { denied: MIC_MESSAGES.denied, unavailable: MIC_MESSAGES.unavailable, busy: MIC_MESSAGES.busy, unsupported: MIC_MESSAGES.unsupported, error: MIC_MESSAGES.error }
      setMicDock(kind, { message: messages[kind], showRetry: kind === 'denied' || kind === 'unavailable' || kind === 'busy' || kind === 'error', showDiag: true, showText: true })
      return false
    } finally {
      C.mic.pending = null
    }
  })()
  return C.mic.pending
}

function stopMicMonitor() {
  stopMicLoop()
  if (C.mic.stream) {
    try {
      C.mic.stream.getTracks().forEach((track) => track.stop())
    } catch {
      /* 忽略 */
    }
  }
  if (C.mic.ctx) {
    try {
      C.mic.ctx.close()
    } catch {
      /* 忽略 */
    }
  }
  C.mic.stream = null
  C.mic.ctx = null
  C.mic.analyser = null
  C.mic.data = null
  C.mic.active = false
  C.mic.level = 0
  C.mic.silentSince = 0
  C.mic.silentNotified = false
  if (D.call) D.call.classList.remove('mic-live')
}

/** 识别失败分类：权限 / 无声音 / 网络不可达 / 被中断（单条内联提示，不堆叠 toast）。 */
function classifyRecognitionError(err) {
  const code = String((err && (err.code || err.name)) || '').toLowerCase()
  const message = String((err && err.message) || '').toLowerCase()
  if (/not-allowed|service-not-allowed|denied|permission/.test(code + message)) return 'denied'
  if (/audio-capture|no-mic|devicesnotfound|notfound/.test(code + message)) return 'no-mic'
  if (/network|unreachable|offline/.test(code + message)) return 'network'
  if (/no-speech|nospeech|silence/.test(code + message)) return 'no-speech'
  if (/aborted|interrupted|interrupt/.test(code + message)) return 'interrupted'
  return 'stt-fail'
}

function showRecognitionFailure(kind) {
  const messages = {
    denied: MIC_MESSAGES.denied,
    'no-speech': MIC_MESSAGES['no-speech'],
    network: MIC_MESSAGES.network,
    interrupted: MIC_MESSAGES.interrupted,
    'no-mic': MIC_MESSAGES['no-mic'],
    'stt-fail': MIC_MESSAGES['stt-fail'],
  }
  const labels = {
    denied: '麦克风权限被拒绝',
    'no-speech': '没有识别到声音',
    network: '语音识别网络不可达',
    interrupted: '语音识别被中断',
    'no-mic': '没有可用的麦克风',
    'stt-fail': '语音识别失败',
  }
  const retry = kind === 'denied' || kind === 'no-mic'
  setMicDock('error', { message: messages[kind] || MIC_MESSAGES['stt-fail'], showRetry: retry, showText: true })
  if (D.micLabel) D.micLabel.textContent = labels[kind] || labels['stt-fail']
  if (D.pttHint) D.pttHint.textContent = '识别失败 · 可改用文字输入'
}

/* ------------------------------ 点击式 PTT（v2.2 方案 A：点开始 / 再点结束） ------------------------------ */
const PTT_STATES = ['idle', 'connecting', 'recording', 'submitting', 'speaking']

function bumpPttToken() {
  C.pttToken = (C.pttToken || 0) + 1
  return C.pttToken
}

function volcCallbacksValid() {
  return !!(C.open && C.engine === 'volc' && C.volc && C.volcToken > 0 && C.volcToken === C.pttToken)
}

function clearPttTimers() {
  if (C.pttSubmitTimer) {
    clearTimeout(C.pttSubmitTimer)
    C.pttSubmitTimer = null
  }
  if (C.pttAudioTimer) {
    clearTimeout(C.pttAudioTimer)
    C.pttAudioTimer = null
  }
  if (C.pttAsrTimer) {
    clearTimeout(C.pttAsrTimer)
    C.pttAsrTimer = null
  }
  if (C.pttReplyTimer) {
    clearTimeout(C.pttReplyTimer)
    C.pttReplyTimer = null
  }
  if (C.audioStallTimer) {
    clearInterval(C.audioStallTimer)
    C.audioStallTimer = null
  }
  if (C.teacherTurnTimer) {
    clearTimeout(C.teacherTurnTimer)
    C.teacherTurnTimer = null
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms)),
  ])
}

/** 读取 voice.getter（voice-dev 可能尚未全部提供，缺失时返回 null/false）。 */
function readVoiceFrames(voice) {
  const value = voice && voice.framesSent
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readVoiceDiag() {
  const voice = C.volc
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const wsState =
    voice && typeof voice.wsState === 'number'
      ? voice.wsState
      : voice && (voice.socketState || voice.connectionState)
        ? voice.socketState || voice.connectionState
        : voice
          ? voice.isActive
            ? 'active'
            : 'inactive'
          : null
  return {
    active: !!(voice && voice.isActive),
    ready: !!(voice && (voice.ready === true || voice.isReady === true || voice.isActive === true)),
    micPaused: !!(voice && voice.isMicPaused === true),
    framesSent: num(voice && voice.framesSent),
    lastFrameAt: num(voice && voice.lastFrameAt),
    wsState: wsState || null,
    micLevel: Math.round((C.pttMicLevel || 0) * 100) / 100,
    peak: Math.round((C.pttPeak || 0) * 100) / 100,
    hadSound: !!C.pttHadSound,
    asrSeen: !!C.pttAsrSeen,
    volcResets: C.volcResets || 0,
    lastAsrAt: C.pttLastAsrAt || 0,
  }
}

/** 传给实时语音会话的最近对话（会话重建/预热后也能接上前文） */
function voiceHistoryPayload() {
  return (Array.isArray(C.messages) ? C.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-24)
    .map((m) => ({ role: m.role, content: String(m.content).trim().slice(0, 300) }))
}

function volcStartOptions() {
  return {
    mode: 'free',
    level: (M.settings && M.settings.level) || 'A2',
    teacherName: C.character ? C.character.name : 'Ava',
    characterId: C.character ? C.character.id : undefined,
    kbMode: C.kbMode,
    ...(C.kbDocIds.length ? { kbDocIds: C.kbDocIds } : {}),
    ...lessonChatContext(),
    history: voiceHistoryPayload(),
    ptt: true,
  }
}

function stopPttWatchdog() {
  if (C.pttWatch && C.pttWatch.timer) clearInterval(C.pttWatch.timer)
  C.pttWatch = null
}

/** 上行帧看门狗：录音中每 1s 检查 framesSent，2.5s 不增长→重连一次，仍失败→idle+文字提示。 */
function startPttWatchdog() {
  stopPttWatchdog()
  if (C.engine !== 'volc') return
  const initial = readVoiceFrames(C.volc)
  C.pttWatch = { timer: null, lastFrames: initial, lastChangeAt: Date.now(), reconnected: false }
  C.pttWatch.timer = setInterval(() => {
    const watch = C.pttWatch
    if (!watch) return
    if (!C.open || C.ptt !== 'recording') {
      stopPttWatchdog()
      return
    }
    const now = Date.now()
    if (C.pttLevelSeen) {
      const silent = now - (C.pttLastSoundAt || 0) > 2500 && (C.pttPeak || 0) < 0.02
      if (silent && !C.pttSoundHintShown) {
        C.pttSoundHintShown = true
        if (D.pttHint) D.pttHint.textContent = '没有听到声音…请检查麦克风/系统输入'
        toast('没有听到声音…请检查麦克风或系统输入设备', 'info', 3200)
      } else if (!silent && C.pttSoundHintShown) {
        C.pttSoundHintShown = false
        if (D.pttHint) D.pttHint.textContent = '正在录音… 再点一次麦克风结束'
      }
    }
    const voice = C.volc
    if (!voice || C.engine !== 'volc' || !volcCallbacksValid()) {
      stopPttWatchdog()
      return
    }
    const frames = readVoiceFrames(voice)
    if (frames === null) return
    if (frames !== watch.lastFrames) {
      watch.lastFrames = frames
      watch.lastChangeAt = now
      return
    }
    if (now - watch.lastChangeAt < 2500) return
    const micInfo = typeof voice.getMicInfo === 'function' ? voice.getMicInfo() : null
    // 麦克风其实有声音，但被 PTT 静音门限拦住：自动放宽，不报错
    if (micInfo && (C.pttMicLevel > 0.015 || (C.pttPeak || 0) > 0.02) && micInfo.gateMode) {
      try {
        voice.setPttGateMode(false)
      } catch {
        /* 忽略 */
      }
      watch.lastChangeAt = now
      if (!C.pttGateRelaxed) {
        C.pttGateRelaxed = true
        toast('检测到你的声音，已调整麦克风灵敏度，请继续说话', 'info', 2600)
      }
      return
    }
    if (micInfo && micInfo.micPaused) {
      try {
        voice.resumeMic()
      } catch {
        /* 忽略 */
      }
      watch.lastChangeAt = now
      return
    }
    if (!watch.reconnected) {
      watch.reconnected = true
      toast('麦克风输入有点慢，正在重连语音…', 'info', 3000)
      void reconnectPttVoice()
      return
    }
    stopPttWatchdog()
    abortPtt({ silent: true })
    setPttState('idle')
    setState('idle')
    showTextForm(true)
    const info = typeof voice.getMicInfo === 'function' ? voice.getMicInfo() : null
    let reason = '没有检测到有效的麦克风输入：请检查系统输入设备是否选对、是否静音，或改用文字输入'
    if (info && !info.trackLive) reason = '麦克风设备没有启动：请检查系统输入设备/权限后重试，或改用文字输入'
    else if (info && info.trackMuted) reason = '系统麦克风处于静音状态：请取消静音后重试，或改用文字输入'
    else if (info && info.gateMode) reason = '声音太小，没有达到识别门限：请靠近麦克风再说一次，或改用文字输入'
    toast(reason, 'bad', 4600)
  }, 1000)
}

/** 录音中重连一次豆包会话（保留计时与 PTT recording 状态）。 */
async function reconnectPttVoice() {
  const generation = C.pttToken
  const voice = C.volc
  if (!voice || !C.open || C.ptt !== 'recording') return false
  try {
    try {
      if (voice.isActive) voice.stop()
    } catch {
      /* 忽略 */
    }
    const outcome = await withTimeout(voice.start({ ...volcStartOptions(), startPaused: true }), 15000)
    if (C.pttToken !== generation || !C.open || C.ptt !== 'recording') return false
    if (outcome === '__timeout__' || outcome === false) return false
    if (C.engine !== 'volc' || !voice.isActive) return false
    const resumed = typeof voice.resumeMic === 'function' ? voice.resumeMic() : true
    if (!resumed || voice.isMicPaused === true) return false
    if (C.pttWatch) {
      C.pttWatch.lastFrames = readVoiceFrames(voice)
      C.pttWatch.lastChangeAt = Date.now()
      C.pttWatch.reconnected = true
    }
    toast('语音已重连，继续说话吧', 'ok', 2200)
    return true
  } catch (err) {
    console.warn('[mobile] PTT 上行重连失败：', err)
    return false
  }
}

function pttSupportedVolc() {
  return !!(C.engine === 'volc' && C.volc && typeof C.volc.commit === 'function')
}

function updatePttTimer() {
  if (!D.pttTimer) return
  D.pttTimer.textContent = mmss((Date.now() - C.pttStartedAt) / 1000)
}

function startPttTimer() {
  stopPttTimer()
  C.pttStartedAt = Date.now()
  updatePttTimer()
  C.pttTimer = setInterval(updatePttTimer, 200)
}

function stopPttTimer() {
  if (C.pttTimer) clearInterval(C.pttTimer)
  C.pttTimer = null
}

/** 切换 PTT 状态与录音 UI（录音红脉冲 / 计时 / 波形 / 取消·完成）。 */
function setPttState(next) {
  if (PTT_STATES.indexOf(next) < 0) next = 'idle'
  const wasRecording = C.ptt === 'recording'
  const wasConnecting = C.ptt === 'connecting'
  C.ptt = next
  const recording = next === 'recording'
  const connecting = next === 'connecting'
  if (D.call) {
    D.call.classList.toggle('is-recording', recording)
    D.call.classList.toggle('is-connecting', connecting)
  }
  if (D.ptt) D.ptt.hidden = !recording
  if (D.talk) {
    D.talk.classList.toggle('is-recording', recording)
    D.talk.classList.toggle('is-connecting', connecting)
    D.talk.setAttribute('aria-pressed', recording ? 'true' : 'false')
    D.talk.setAttribute('aria-label', connecting ? '取消连接豆包语音' : recording ? '结束录音并提交' : '点击开始说话')
  }
  if (recording) {
    // 录音时强制只显示录音面板 + 控制坞，任何台词/记录/提示都不允许残留
    toggleHistory(false)
    if (D.dialogue) D.dialogue.hidden = true
    if (!wasRecording) startPttTimer()
  } else {
    stopPttTimer()
    if (wasRecording && next === 'idle' && C.dialogueText) {
      showDialogue(C.dialogueText, C.dialogueZh, { final: true })
    }
  }
  if (recording) {
    C.mic.silentSince = Date.now()
    C.mic.silentNotified = false
    if (D.pttHint) D.pttHint.textContent = '正在录音… 再点一次麦克风结束'
    setMicDock('recording')
  }
  if (connecting) {
    if (D.talkLabel) D.talkLabel.textContent = '正在连接豆包语音…约1–5秒，再点麦克风取消'
    if (D.signal) D.signal.textContent = '实时语音 · 正在连接…'
  } else if (recording && D.talkLabel) {
    D.talkLabel.textContent = '正在录音… 再点一次麦克风结束（空格也可）'
  } else if (next === 'submitting' && D.talkLabel) {
    D.talkLabel.textContent = '正在识别这一句…'
  } else if (D.talkLabel) {
    D.talkLabel.textContent = LABELS[C.state] ? LABELS[C.state]() : ''
  }
  if ((wasRecording || wasConnecting) && next !== 'recording') {
    dropInterim()
    if (C.mic && (C.mic.state === 'recording' || C.mic.state === 'ready')) {
      if (C.mic.active) setMicDock(C.mic.silentNotified ? 'silent' : 'ready')
      else setMicDock('idle')
    }
  }
}

function resetPttForNewTurn() {
  C.pttCommitted = false
  C.autoReplyNotified = false
  C.pttErrorShown = false
  C.pttMicLevel = 0
  C.pttPeak = 0
  C.pttHadSound = false
  C.pttLastSoundAt = Date.now()
  C.pttSoundHintShown = false
  C.pttGateRelaxed = false
  C.pttLevelSeen = false
  C.pttAsrSeen = false
  C.pttReplySeen = false
  C.pttLastAsrAt = 0
  C.pttFragments = []
  C.pttInterim = ''
  C.pttResolver = null
  if (D.pttTimer) D.pttTimer.textContent = '00:00'
}

/** 创建/复用手动 PTT 用的 STT（不自动提交，只有用户点结束时才提交）。 */
function ensurePttStt() {
  if (C.stt) return C.stt
  const supported = typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  if (!supported) return null
  C.stt = createSTT({
    lang: 'en-US',
    silenceMs: 1200,
    onStart() {
      if (C.ptt === 'recording') setState('listening')
    },
    onInterim(interim, detail) {
      const text = String(interim || (detail && detail.text) || '').trim()
      if (!text) return
      C.pttInterim = text
      if (C.ptt === 'recording') showInterim(text)
    },
    onFinal(text, detail) {
      const value = String(text || (detail && detail.text) || '').trim()
      if (C.ptt === 'recording') {
        if (value) {
          C.pttFragments = C.pttFragments || []
          C.pttFragments.push(value)
          C.pttInterim = value
        }
        if (D.bubbles) dropInterim()
        return
      }
      if (C.ptt === 'submitting') {
        if (value && D.bubbles) dropInterim()
        const resolve = C.pttResolver
        C.pttResolver = null
        if (typeof resolve === 'function') resolve(value)
      }
    },
    onError(err) {
      const kind = classifyRecognitionError(err)
      if (C.ptt === 'recording') {
        // 单条内联诊断提示（不堆叠 red toast），保留录音 UI 直到用户再点麦克风取消
        if (!C.pttErrorShown) {
          C.pttErrorShown = true
          showRecognitionFailure(kind)
        }
        return
      }
      if (C.ptt === 'submitting') {
        showRecognitionFailure(kind)
        const resolve = C.pttResolver
        C.pttResolver = null
        if (typeof resolve === 'function') resolve('')
      }
    },
    onEnd() {
      // 录音期间 STT 自动结束时重启，保持录音直到用户点「完成」
      if (C.ptt === 'recording' && C.open) {
        C.pttRestartTimer = setTimeout(() => {
          if (C.ptt !== 'recording' || !C.open) return
          try {
            C.stt.start()
          } catch {
            /* 忽略；仍显示录音态，用户可点完成 */
          }
        }, 200)
      }
    },
  })
  return C.stt
}

/** 点击麦克风：idle → recording；recording → 提交；其他状态下先打断再录音。 */
export function togglePtt() {
  if (!C.open) return false
  if (C.ptt === 'connecting') {
    cancelConnectingPtt()
    return true
  }
  if (C.ptt === 'recording') {
    void finishPtt()
    return true
  }
  if (C.ptt === 'submitting' || C.ptt === 'speaking') {
    // 抢断：先停她的语音/未完成回合，再开新一轮录音
    interruptReplyForPtt()
  }
  void startPtt()
  return true
}

function cancelConnectingPtt() {
  stopPttWatchdog()
  clearPttTimers()
  C.volcToken = -1
  bumpPttToken()
  try {
    if (C.volc && C.volc.isActive) C.volc.stop()
  } catch {
    /* 忽略 */
  }
  setPttState('idle')
  setState('idle')
  toast('已取消连接', 'info', 1800)
}

function interruptReplyForPtt() {
  try {
    tts.cancel()
  } catch {
    /* 忽略 */
  }
  if (C.chatHandle) {
    try {
      C.chatHandle.abort()
    } catch {
      /* 忽略 */
    }
    C.chatHandle = null
  }
  clearPttTimers()
  if (C.volc) {
    try {
      if (typeof C.volc.cancelTurn === 'function') C.volc.cancelTurn()
      else if (C.volc.isActive) C.volc.interrupt()
    } catch {
      /* 忽略 */
    }
  }
  C.volcToken = -1
  bumpPttToken()
  setState('idle')
  setPttState('idle')
}

/** 老师回复/音频卡住的兜底：立刻用角色原声继续，而不是让用户干等或重置。 */
function teacherStalled(reason = '') {
  clearPttTimers()
  if (!C.open || C.closingCall) return false
  try {
    if (C.volc && C.volc.isActive) C.volc.interrupt()
  } catch {
    /* 忽略 */
  }
  if (fallbackContinueWithTts(reason)) return true
  return recoverVolcConnection(reason)
}

function startTeacherAudioGuard() {
  if (C.audioStallTimer) clearInterval(C.audioStallTimer)
  C.lastTeacherAudioAt = Date.now()
  C.audioStallTimer = setInterval(() => {
    if (!C.open || C.closingCall) {
      clearPttTimers()
      return
    }
    if (C.ptt !== 'submitting' && C.ptt !== 'speaking' && C.state !== 'speaking') {
      clearPttTimers()
      return
    }
    if (Date.now() - C.lastTeacherAudioAt > 3500) {
      teacherStalled('audio-stall')
    }
  }, 1200)
}

function startTeacherReplyGuard(generation) {
  if (C.pttReplyTimer) clearTimeout(C.pttReplyTimer)
  C.lastTeacherAudioAt = Date.now()
  C.pttReplyTimer = setTimeout(() => {
    C.pttReplyTimer = null
    if (!C.open || C.closingCall || C.pttToken !== generation) return
    if (C.pttReplySeen) return
    teacherStalled('no-reply')
  }, 7000)
}

/** 实时语音自动恢复：重试连接；仍失败则用角色原声继续，不弹“已重置”。 */
function recoverVolcConnection(reason = '') {
  if (!C.open || C.closingCall || C.volcRecovering) return false
  if (Date.now() - C.volcRecoverAt < 6000) return false
  C.volcRecoverAt = Date.now()
  C.volcRecovering = true
  resetVolcSession()
  setPttState('idle')
  setState('idle')
  updateEngineLabel()
  if (D.signal) D.signal.textContent = '语音恢复中…'

  const tryStart = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!C.open || C.closingCall) return false
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 900))
      try {
        const voice = await ensureVolc()
        if (!voice || !C.open) continue
        const outcome = await withTimeout(voice.start({ ...volcStartOptions(), startPaused: true }), 15000)
        if (outcome === false || outcome === '__timeout__') continue
        try {
          if (typeof voice.pauseMic === 'function') voice.pauseMic()
        } catch {
          /* 忽略 */
        }
        C.pttVolcAttempt = false
        return true
      } catch {
        /* 尝试下一次 */
      }
    }
    return false
  }

  setTimeout(async () => {
    const ok = await tryStart()
    C.volcRecovering = false
    try {
      if (ok) {
        updateEngineLabel()
        if (D.signal) D.signal.textContent = '实时语音 · 已连接'
        toast('语音连接已自动恢复，可以继续说话', 'ok', 2400)
        return
      }
      if (D.signal) D.signal.textContent = '语音波动 · 角色原声继续'
      if (!fallbackContinueWithTts(reason)) {
        toast('网络波动，语音暂时不稳；可以先打字继续', 'info', 3600)
      }
    } catch {
      /* 忽略 */
    }
  }, 350)
  return true
}

/**
 * 实时语音暂时连不上时，用独立的角色 TTS 继续当前资料句/下一步，
 * 避免“语音说不完就整段重置”的体验。
 */
function fallbackContinueWithTts(reason = '') {
  if (!C.open || C.closingCall) return false
  if (Date.now() - C.ttsFallbackAt < 15000) return false
  C.ttsFallbackAt = Date.now()
  try {
    if (C.volc && C.volc.isActive) C.volc.interrupt()
  } catch {
    /* 忽略 */
  }
  let text = ''
  let sentence = null
  if (C.kbMode === 'grounded' && C.docs.docs.length) {
    const doc = activeDocsDoc()
    const list = (doc && doc.sentences) || []
    sentence = list.find((item) => item.id === C.docs.activeSentence) || list[0] || null
    if (sentence) {
      C.docs.activeChunk = sentence.chunkId
      C.docs.activeSentence = sentence.id
      renderDocsBody()
      text = `Let's keep going. ${sentence.text}`
    }
  }
  if (!text) {
    if (C.kbMode === 'grounded') return false
    text = 'The connection hiccuped for a second. Let’s keep going — tell me what you were saying.'
  }
  const node = addBubble('ava', text)
  C.messages.push({ role: 'assistant', content: text })
  C.dialogueBubbleId = node.id
  showDialogue(text)
  scrollBubblesToBottom(true)
  void translateBubble(node.id, text)
  setState('speaking')
  void stopCharacterVoice()
  void playCharacterVoice(sentence ? sentence.text : text, {
    onEnd: () => {
      if (C.state === 'speaking') setState('idle')
    },
  }).then((played) => {
    if (!played && C.state === 'speaking') setState('idle')
  })
  if (!C.ttsFallbackNotified) {
    C.ttsFallbackNotified = true
    toast('语音波动，已用角色原声继续', 'info', 2600)
  }
  void reason
  return true
}

/** 重置豆包会话：stop + 清 C.volc + token 失效；engine 保持 volc，不切浏览器。 */
function resetVolcSession() {
  clearPttTimers()
  stopPttWatchdog()
  if (C.volcWarmTimer) {
    clearTimeout(C.volcWarmTimer)
    C.volcWarmTimer = null
  }
  const voice = C.volc
  C.volc = null
  C.volcLoading = null
  C.volcToken = -1
  C.pttVolcAttempt = false
  bumpPttToken()
  C.volcResets = (C.volcResets || 0) + 1
  if (typeof window !== 'undefined') window.__avaDebugVoice = null
  if (voice) {
    try {
      if (voice.isActive) voice.stop()
    } catch {
      /* 忽略 */
    }
  }
  if (C.engine === 'volc') updateEngineLabel()
}

function clearVolcWarmup() {
  if (C.volcWarmTimer) {
    clearTimeout(C.volcWarmTimer)
    C.volcWarmTimer = null
  }
}

function scheduleVolcWarmup(delay = 500) {
  // 预热时 startPaused=true：采集已启动但不上行，不会造成 VAD 自答；点麦克风只需 resumeMic。
  clearVolcWarmup()
  C.volcWarmTimer = setTimeout(() => {
    C.volcWarmTimer = null
    if (!C.open || C.engine !== 'volc' || C.ptt !== 'idle') return
    void warmVolcSession()
  }, delay)
}

/** 预热：提前 start 并暂停 mic，减少下一轮连接吞音；失败静默。 */
async function warmVolcSession() {
  if (!C.open || C.engine !== 'volc' || C.ptt !== 'idle' || C.volcWarming) return
  C.volcWarming = true
  C.volcWarmPromise = (async () => {
    try {
      const voice = await ensureVolc()
      if (!voice || !C.open || C.engine !== 'volc') return
      if (!isVolcSessionActive()) {
        const outcome = await withTimeout(voice.start({ ...volcStartOptions(), startPaused: true }), 15000)
        if (outcome === false || outcome === '__timeout__') {
          resetVolcSession()
          return
        }
      }
      if (!C.open || C.engine !== 'volc') {
        try {
          if (voice.isActive) voice.stop()
        } catch {
          /* 忽略 */
        }
        return
      }
      C.volc = voice
      C.volcToken = bumpPttToken()
      if (C.ptt === 'idle') {
        try {
          if (typeof voice.pauseMic === 'function') voice.pauseMic()
        } catch {
          /* 忽略 */
        }
      }
      updateEngineLabel()
    } catch {
      /* 预热失败静默 */
    } finally {
      C.volcWarming = false
      C.volcWarmPromise = null
    }
  })()
  await C.volcWarmPromise
}

/** 豆包连接：最多自动重试一次；失败只重置会话，engine 保持 volc。 */
async function tryStartVolcSession() {
  let generation = bumpPttToken()
  C.volcToken = generation
  let result = await startVolcPtt(generation)
  if (C.pttToken !== generation || !C.open || C.ptt !== 'connecting') return 'canceled'
  if (result.ok) return 'ok'
  resetVolcSession()
  generation = bumpPttToken()
  C.volcToken = generation
  result = await startVolcPtt(generation)
  if (C.pttToken !== generation || !C.open || C.ptt !== 'connecting') return 'canceled'
  if (result.ok) return 'ok'
  resetVolcSession()
  return false
}

async function startPtt() {
  if (!C.open) return false
  if (C.volcRecovering) return false
  // 开始说话前停掉资料自动朗读，避免和用户说话叠音
  void stopCharacterVoice()
  try {
    tts.cancel()
  } catch {
    /* 忽略 */
  }
  clearVolcWarmup()
  if (C.volcWarming && C.volcWarmPromise) await withTimeout(C.volcWarmPromise, 2500)
  void ensureMicMonitor()
  resetPttForNewTurn()
  clearPttTimers()
  if (!D.textForm.hidden) showTextForm(false)
  if (C.engine === 'volc') {
    setPttState('connecting')
    setState('idle')
    const result = await tryStartVolcSession()
    if (!C.open) return false
    if (result === 'canceled') return false
    if (result === 'ok') {
      if (C.ptt !== 'recording') {
        setPttState('recording')
        setState('listening')
      }
      C.pttLastSoundAt = Date.now()
      startPttWatchdog()
      return true
    }
    setPttState('idle')
    setState('idle')
    updateEngineLabel()
    if (recoverVolcConnection('ptt-start')) return false
    toast('语音正在重连，请稍等再试', 'info', 2800)
    return false
  }
  const browserOk = startBrowserPtt()
  if (browserOk && C.open) {
    setPttState('recording')
    setState('listening')
  }
  return browserOk
}

function startBrowserPtt() {
  const stt = ensurePttStt()
  if (!stt) {
    if (!C.pttErrorShown) {
      C.pttErrorShown = true
      toast('当前浏览器不支持语音识别，可直接打字；也可以点「完成」结束这次录音', 'info', 3600)
    }
    return true
  }
  try {
    if (stt.isActive) stt.stop()
  } catch {
    /* 忽略 */
  }
  try {
    stt.start()
    return true
  } catch {
    if (!C.pttErrorShown) {
      C.pttErrorShown = true
      toast('麦克风启动失败，可以直接打字聊天，或点「完成」结束', 'bad', 3200)
    }
    return true
  }
}

async function startVolcPtt(generation) {
  C.pttVolcAttempt = true
  const voice = await ensureVolc()
  if (!voice || typeof voice.commit !== 'function') {
    C.pttVolcAttempt = false
    return { ok: false, reason: 'unavailable' }
  }
  const startFreshSession = async () => {
    try {
      if (voice.isActive) voice.stop()
    } catch {
      /* 忽略 */
    }
    const outcome = await withTimeout(voice.start({ ...volcStartOptions(), startPaused: true }), 15000)
    if (C.pttToken !== generation || !C.open) return { ok: false, reason: 'canceled' }
    if (outcome === '__timeout__') return { ok: false, reason: 'timeout' }
    if (outcome === false) return { ok: false, reason: 'start-failed' }
    if (C.engine !== 'volc' || !voice.isActive) return { ok: false, reason: 'start-failed' }
    const resumed = typeof voice.resumeMic === 'function' ? voice.resumeMic() : true
    if (!resumed || voice.isMicPaused === true) return { ok: false, reason: 'mic-paused' }
    C.volcToken = generation
    return { ok: true }
  }
  try {
    if (!isVolcSessionActive()) return await startFreshSession()
    // 已有会话：恢复上行成功才允许进入 recording（修复第二轮假录音）
    const resumed = typeof voice.resumeMic === 'function' ? voice.resumeMic() : true
    if (!resumed || voice.isMicPaused === true) {
      console.warn('[mobile] PTT 第二轮 resumeMic 失败，重建豆包会话')
      return await startFreshSession()
    }
    if (C.pttToken !== generation || !C.open || C.engine !== 'volc') return { ok: false, reason: 'canceled' }
    C.volcToken = generation
    return { ok: true }
  } catch (err) {
    console.warn('[mobile] 豆包 PTT 启动失败：', err)
    return { ok: false, reason: 'error', error: err }
  } finally {
    C.pttVolcAttempt = false
  }
}

/** 结束本轮录音：浏览器等 final（最多 3s）；豆包 commit 触发出句。 */
async function finishPtt() {
  if (C.ptt !== 'recording') return
  stopPttWatchdog()
  if (D.pttHint) D.pttHint.textContent = '正在识别这一句…'
  C.pttCommitted = true
  setPttState('submitting')
  setState('thinking')
  if (pttSupportedVolc()) {
    finishVolcPtt()
    return
  }
  finishBrowserPtt()
}

function finishVolcPtt() {
  C.pttCommitted = true
  clearPttTimers()
  if (C.pttLevelSeen && !C.pttHadSound && (C.pttPeak || 0) < 0.02) {
    try {
      if (C.volc && typeof C.volc.pauseMic === 'function') C.volc.pauseMic()
    } catch {
      /* 忽略 */
    }
    setPttState('idle')
    setState('idle')
    toast('没有听到你的声音（麦克风可能没拾音），请检查系统输入设备再说一次', 'bad', 4200)
    return
  }
  try {
    if (typeof C.volc.pauseMic === 'function') C.volc.pauseMic()
    const accepted = typeof C.volc.commit === 'function' ? C.volc.commit() : false
    if (accepted === false) {
      toast('语音提交失败，请再点麦克风重试或改用文字输入', 'bad', 3000)
      setPttState('idle')
      setState('idle')
      return
    }
  } catch (err) {
    console.warn('[mobile] 豆包 commit 失败：', err)
    toast('提交失败，请再试一次或改用文字输入', 'bad', 2800)
    setPttState('idle')
    setState('idle')
    return
  }
  const generation = C.pttToken
  C.pttAsrSeen = false
  C.pttReplySeen = false
  C.pttLastAsrAt = 0
  C.pttAsrTimer = setTimeout(() => {
    C.pttAsrTimer = null
    if (!C.open || C.pttToken !== generation) return
    if (C.ptt !== 'submitting' || C.pttAsrSeen) return
    clearPttTimers()
    resetVolcSession()
    setPttState('idle')
    setState('idle')
    toast('刚才没听清，再点麦克风说一次试试', 'info', 3600)
    scheduleVolcWarmup(900)
  }, 6000)
  startTeacherReplyGuard(generation)
}

async function finishBrowserPtt() {
  const stt = C.stt
  let done = false
  const finalValue = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        resolve('')
      }
    }, 3000)
    C.pttResolver = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      C.pttResolver = null
      resolve(String(value || ''))
    }
    try {
      if (stt && stt.isActive) stt.stop()
      else if (C.pttResolver) C.pttResolver('')
    } catch {
      if (C.pttResolver) C.pttResolver('')
    }
  })
  C.pttResolver = null
  dropInterim()
  const fragments = (C.pttFragments || []).slice()
  if (finalValue.trim() && fragments[fragments.length - 1] !== finalValue.trim()) fragments.push(finalValue.trim())
  const text = (fragments.join(' ').trim() || String(C.pttInterim || '').trim()).trim()
  C.pttFragments = []
  C.pttInterim = ''
  if (!text) {
    toast('没听清，再说一次', 'info', 2600)
    setPttState('idle')
    setState('idle')
    return
  }
  submitUserTranscript(text)
}

/** 把一次识别/模拟文本作为用户发言提交（气泡 + 双语字幕 + chatStream + TTS）。 */
export function submitUserTranscript(text) {
  const value = String(text == null ? '' : text).trim()
  if (C.lesson) lessonOnUserText(value)
  if (!C.open || !value) return false
  dropInterim()
  const node = addBubble('user', value)
  setDialogueUser(value)
  C.messages.push({ role: 'user', content: value })
  C.userTurns += 1
  void translateBubble(node.id, value)
  setPttState('submitting')
  void sendTextToChat(value)
  return true
}

/** QA 调试：无麦克风时模拟一句识别结果并走完整提交链路。 */
export function simulateTranscript(text) {
  const value = String(text == null ? '' : text).trim()
  if (!C.open || !value) return false
  if (C.ptt === 'recording') setPttState('idle')
  return submitUserTranscript(value)
}

/** 取消本轮录音（丢弃），Esc / ✕ 调用。 */
export function cancelPtt() {
  if (C.ptt !== 'recording' && C.ptt !== 'submitting') return false
  abortPtt({ silent: false })
  setState('idle')
  return true
}

function abortPtt({ silent = false } = {}) {
  stopPttWatchdog()
  if (C.pttRestartTimer) {
    clearTimeout(C.pttRestartTimer)
    C.pttRestartTimer = null
  }
  if (C.pttSubmitTimer) {
    clearTimeout(C.pttSubmitTimer)
    C.pttSubmitTimer = null
  }
  const wasRecording = C.ptt === 'recording' || C.ptt === 'submitting'
  clearPttTimers()
  if (C.stt && C.stt.isActive) {
    try {
      C.stt.abort()
    } catch {
      /* 忽略 */
    }
  }
  C.volcToken = -1
  bumpPttToken()
  if (C.volc) {
    try {
      if (typeof C.volc.pauseMic === 'function') C.volc.pauseMic()
      if (typeof C.volc.cancelTurn === 'function') C.volc.cancelTurn()
      else if (C.volc.isActive) C.volc.interrupt()
    } catch {
      /* 忽略 */
    }
  }
  if (C.pttResolver) {
    const resolve = C.pttResolver
    C.pttResolver = null
    try {
      resolve('')
    } catch {
      /* 忽略 */
    }
  }
  dropInterim()
  resetPttForNewTurn()
  setPttState('idle')
  if (!silent && wasRecording) toast('已取消这次录音', 'info', 1800)
}


/* ------------------------------ 浏览器语音 ------------------------------ */
/* ------------------------------ 文本 / 聊天回复 ------------------------------ */
function showTextForm(show) {
  D.textForm.hidden = !show
  if (D.call) D.call.classList.toggle('text-open', !!show)
  if (show && D.call) toggleHistory(false)
  D.textBtn.classList.toggle('is-on', show)
  if (show) {
    if (D.talkLabel) D.talkLabel.textContent = '文字模式 · 回车发送'
    setTimeout(() => D.textInput && D.textInput.focus(), 60)
  } else {
    setState(C.state === 'idle' ? 'idle' : C.state)
  }
}

async function sendTextToChat(value) {
  setState('thinking')
  dropInterim()
  clearCitations()
  const history = C.messages.slice(-40).map((m) => ({ role: m.role, content: m.content }))
  const node = addBubble('ava', '')
  C.streamBubbleId = node.id
  C.dialogueBubbleId = node.id
  C.streamText = ''
  let finished = false
  try {
    C.chatHandle = chatStream(
      {
        mode: 'free',
        characterId: C.character ? C.character.id : undefined,
        message: value,
        history,
        level: (M.settings && M.settings.level) || 'A2',
        teacherName: C.character ? C.character.name : 'Ava',
        // v1.8：知识库/发散讨论参数
        kbMode: C.kbMode,
        ...(C.kbDocIds.length ? { kbDocIds: C.kbDocIds } : {}),
        ...lessonChatContext(),
      },
      {
        onMeta(payload) {
          const hits = extractKbHits(payload)
          if (hits) renderCitations(hits)
        },
        onDelta(text) {
          C.streamText += text
          const el = node.querySelector('.bubble-en')
          if (el) el.textContent = C.streamText
          showDialogue(C.streamText)
          scrollBubblesToBottom()
          setState('speaking')
        },
        onDone(payload) {
          finished = true
          const finalText = (payload && payload.fullReply) || C.streamText
          C.messages.push({ role: 'assistant', content: finalText })
          if (!C.streamText) {
            const el = node.querySelector('.bubble-en')
            if (el) el.textContent = finalText
          }
          C.streamBubbleId = null
          C.streamText = ''
          C.dialogueBubbleId = node.id
          showDialogue(finalText, null, { final: true })
          scrollBubblesToBottom(true)
          void translateBubble(node.id, finalText)
          refreshDocsFollow(finalText)
          if (materialTtsMode()) speakGroundedReply(finalText)
          else if (!C.muted && C.engine !== 'volc') speakReply(finalText)
          else setState('idle')
        },
        onError(err) {
          finished = true
          C.streamBubbleId = null
          const message = (err && err.message) || '回复失败，请再试一次'
          const el = node.querySelector('.bubble-en')
          if (el) el.textContent = message
          toast(message, 'bad', 3200)
          setState('idle')
        },
        onFeedback() {},
      },
    )
  } catch (err) {
    finished = true
    toast('发送失败，请重试', 'bad')
    setState('idle')
  }
  void finished
}

/** 浏览器 TTS 朗读（非豆包模式/文本路径）。 */
function speakReply(text) {
  const value = String(text || '').trim()
  if (!value || C.muted) {
    setState('idle')
    return
  }
  setState('speaking')
  void (async () => {
    let ended = false
    const finish = () => {
      if (ended) return
      ended = true
      if (D.glow) D.glow.style.filter = ''
      if (C.state === 'speaking') setState('idle')
    }
    const played = await playCharacterVoice(value, {
      onStart() {
        if (!ended) setState('speaking')
      },
      onEnd: finish,
    })
    if (played) {
      // 保险：极端情况下 helper 未回调 onEnd 时再兜底回 idle
      setTimeout(finish, Math.min(25000, Math.max(2500, value.length * 85)))
      return
    }
    // v3.8：浏览器内置语音已关闭，不再降级为系统 TTS
    setState('idle')
  })()
}

/* ------------------------------ 提示 ------------------------------ */
const LOCAL_HINTS = {
  free: [
    { en: "I'm not sure how to say this, but here's what I mean…", zh: '我不太确定怎么说，但我的意思是……' },
    { en: 'Could you ask me a simpler question?', zh: '可以问我一个简单点的问题吗？' },
    { en: 'Let me try to explain it another way.', zh: '让我换个方式解释一下。' },
  ],
}

async function askHint() {
  const lastUser = [...C.messages].reverse().find((m) => m.role === 'user')
  D.hintBtn.disabled = true
  try {
    let hint = null
    if (lastUser) {
      try {
        let res = null
        if (api && typeof api.coach === 'function') {
          res = await api.coach({ message: lastUser.content, level: (M.settings && M.settings.level) || 'A2', mode: 'free' })
        } else {
          res = await postJSON('/api/coach', { message: lastUser.content, mode: 'free' }, { timeoutMs: 30000 })
        }
        const fb = res && (res.feedback || res)
        if (fb) {
          if (fb.chineseHelp && fb.chineseHelp.english) hint = { en: fb.chineseHelp.english, zh: fb.chineseHelp.tips_zh || '可以这样表达' }
          else if (Array.isArray(fb.corrections) && fb.corrections[0]) hint = { en: fb.corrections[0].corrected, zh: fb.corrections[0].explanation_zh || '' }
          else if (Array.isArray(fb.better) && fb.better[0]) hint = { en: fb.better[0].better, zh: fb.better[0].why_zh || '' }
        }
      } catch {
        /* 静默降级 */
      }
    }
    if (!hint) {
      const sceneKey = (C.scene && C.scene.id) || 'free'
      const pool = LOCAL_HINTS[sceneKey] || LOCAL_HINTS.free
      hint = pool[Math.floor(Math.random() * pool.length)]
    }
    showHint(hint)
  } finally {
    D.hintBtn.disabled = false
  }
}

function showHint(hint) {
  if (!D.hint) return
  D.hint.hidden = false
  D.hint.innerHTML = `${icon('bulb')}<div><div class="hint-en">${esc(hint.en || '')}</div>${hint.zh ? `<div class="hint-zh">${esc(hint.zh)}</div>` : ''}</div>`
  if (C.hintTimer) clearTimeout(C.hintTimer)
  C.hintTimer = setTimeout(() => {
    if (D.hint) D.hint.hidden = true
  }, 9000)
}

/* ------------------------------ 结束通话 / 总结 ------------------------------ */
async function endCall({ silent = false } = {}) {
  if (!C.open) return
  C.closingCall = true
  persistLessonProgress({ immediate: true })
  clearVolcWarmup()
  stopTimer()
  dropInterim()
  void stopCharacterVoice()
  abortPtt({ silent: true })
  if (C.chatHandle) {
    try {
      C.chatHandle.abort()
    } catch {
      /* 忽略 */
    }
    C.chatHandle = null
  }
  try {
    tts.cancel()
  } catch {
    /* 忽略 */
  }
  if (C.volc) {
    try {
      if (C.volc.isActive) C.volc.stop()
    } catch {
      /* 忽略 */
    }
  }
  setState('idle')
  C.docs.token += 1
  closeDocsPanel()
  clearLessonState()
  clearPttTimers()
  C.volcToken = -1
  bumpPttToken()
  stopMicMonitor()
  destroyHead()
  hideDialogue()
  clearCitations()
  C.open = false
  C.endAfterSheet = false
  document.body.classList.remove('call-open')
  toggleHistory(false)
  D.call.hidden = true
  if (!silent && C.userTurns > 0) {
    void reportSceneDone()
  }
}

async function reportSceneDone() {
  try {
    const body = { characterId: C.character && C.character.id, sceneId: C.scene && C.scene.id }
    await postJSON('/api/plan/scene-done', body)
    ui.refreshCourses && ui.refreshCourses()
  } catch {
    /* 静默 */
  }
}

async function hangup() {
  if (!C.open) return
  C.closingCall = true
  persistLessonProgress({ immediate: true })
  clearVolcWarmup()
  const messages = C.messages.slice(-40)
  const userTurns = C.userTurns
  stopTimer()
  dropInterim()
  clearPttTimers()
  C.volcToken = -1
  bumpPttToken()
  stopMicMonitor()
  abortPtt({ silent: true })
  if (C.volc && C.volc.isActive) {
    try {
      C.volc.stop()
    } catch {
      /* 忽略 */
    }
  }
  setState('idle')
  C.endAfterSheet = true
  const token = ++C.summaryToken
  if (!messages.length) {
    openSummaryLocal()
    return
  }
  openSummaryLoading()
  // 第一步：即时规则总结（毫秒级），保证挂断后马上有「重点句型 + 重点单词」可看
  let quick = null
  try {
    quick = await postJSON(
      '/api/summary/quick',
      {
        messages,
        mode: 'free',
        level: (M.settings && M.settings.level) || 'A2',
        teacherName: C.character ? C.character.name : (M.settings && M.settings.teacherName) || 'Ava',
      },
      { timeoutMs: 8000 },
    )
  } catch {
    quick = null
  }
  if (C.summaryToken !== token || !C.endAfterSheet) return
  if (quick && quick.ok !== false && !quick.error) {
    paintSummary(openSummaryHtml({ ...quick, quick: true }))
  }
  // 第二步：AI 总结，成功则替换即时版；失败就保留即时版
  const summary = await fetchSummary(messages)
  if (C.summaryToken !== token || !C.endAfterSheet) return
  if (summary && !summary.error && (summary.summary_zh || (Array.isArray(summary.keyWords) && summary.keyWords.length))) {
    paintSummary(openSummaryHtml(summary))
  } else if (!quick || quick.ok === false) {
    openSummaryLocal()
  }
}

/** 更新已打开的通话总结弹层（不重复 push overlay）。 */
function paintSummary(html) {
  const body = $('#sheet-body')
  const title = $('#sheet-title')
  if (document.body.classList.contains('sheet-open') && body) {
    if (title) title.textContent = '通话总结'
    body.innerHTML = html
    bindSummaryActions()
    return
  }
  ui.openSheet('通话总结', html)
  bindSummaryActions()
}

function openSummaryLoading() {
  ui.openSheet(
    '通话总结',
    `<div class="summary-loading"><span class="spinner"></span><div>Ava 正在整理这次通话…</div></div>`,
  )
}

function openSummaryLocal() {
  ui.openSheet(
    '通话总结',
    `<div class="empty-card" style="align-items:flex-start;text-align:left">
      <span class="empty-orb">${icon('spark')}</span>
      <strong>这次还没开口呢</strong>
      <p>下次试着说一两句英文，Ava 就能帮你复盘纠错、整理重点单词。也可以点「再聊一会」继续。</p>
    </div>
    <div class="summary-actions">
      <button type="button" class="btn btn-ghost" data-act="summary-wordbook">${icon('book')}查看今日单词表</button>
      <button type="button" class="btn btn-primary" data-act="summary-resume">${icon('phone')}再聊一会</button>
    </div>`,
  )
  bindSummaryActions()
}

function openSummary(summary) {
  paintSummary(openSummaryHtml(summary))
}

function openSummaryHtml(summary) {
  const topics = Array.isArray(summary.topics_zh) ? summary.topics_zh.filter(Boolean) : []
  const corrections = Array.isArray(summary.corrections) ? summary.corrections.slice(0, 3) : []
  const keyPatterns = Array.isArray(summary.keyPatterns) ? summary.keyPatterns.slice(0, 4) : []
  const keyWords = Array.isArray(summary.keyWords) ? summary.keyWords.slice(0, 5) : []
  const hero = `<div class="summary-hero">
    <p>${esc(summary.summary_zh || '这次通话完成了，继续保持开口说的习惯。')}</p>
    ${topics.length ? `<div class="summary-topics">${topics.map((t) => `<span class="summary-topic">${esc(t)}</span>`).join('')}</div>` : ''}
    ${summary.quick ? '<span class="summary-demo">快速总结</span>' : summary.demo ? '<span class="summary-demo">演示总结</span>' : ''}
  </div>`
  const patternsHtml = keyPatterns.length
    ? `<div class="summary-block"><div class="summary-block-title">${icon('spark')}重点句型</div>${keyPatterns
        .map(
          (p) => `<div class="summary-item summary-pattern">
            <div class="en">${esc(p.pattern || '')}</div>
            ${p.meaning ? `<div class="zh">${esc(p.meaning)}</div>` : ''}
            ${p.example ? `<div class="summary-pattern-example">${esc(p.example)}</div>` : ''}
            ${p.usage_zh ? `<div class="summary-pattern-usage">${esc(p.usage_zh)}</div>` : ''}
          </div>`,
        )
        .join('')}</div>`
    : ''
  const correctionsHtml = corrections.length
    ? `<div class="summary-block"><div class="summary-block-title">${icon('book')}纠错回顾</div>${corrections
        .map(
          (c) => `<div class="summary-item summary-corr"><div class="en"><span class="orig">${esc(c.original || '')}</span> → ${esc(c.corrected || '')}</div>${c.explanation_zh ? `<div class="zh">${esc(c.explanation_zh)}</div>` : ''}</div>`,
        )
        .join('')}</div>`
    : ''
  const wordsHtml = keyWords.length
    ? `<div class="summary-block"><div class="summary-block-title">${icon('spark')}重点单词</div><div class="summary-kw">${keyWords
        .map(
          (w) => `<div class="summary-kw-item"><b>${esc(w.word)}</b><span>${esc(w.meaning || '')}</span>${w.example ? `<em>${esc(w.example)}</em>` : ''}</div>`,
        )
        .join('')}</div></div>`
    : ''
  const encourage = summary.encouragement_zh
    ? `<div class="summary-encourage">${icon('flame')}<span>${esc(summary.encouragement_zh)}</span></div>`
    : ''
  return `${hero}${patternsHtml}${correctionsHtml}${wordsHtml}${encourage}
    <div class="summary-actions">
      <button type="button" class="btn btn-ghost" data-act="summary-wordbook">${icon('book')}查看今日单词表</button>
      <button type="button" class="btn btn-primary" data-act="summary-resume">${icon('phone')}再聊一会</button>
    </div>`
}

function bindSummaryActions() {
  const body = $('#sheet-body')
  if (!body) return
  body.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'summary-wordbook') void showWordbookSheet()
    else if (act === 'summary-resume') {
      ui.closeSheet()
      C.endAfterSheet = false
      startTimer()
      toast('继续聊吧，Ava 在听', 'info', 1800)
    }
  }
}

/** 总结弹层关闭后结束通话（由 app 的 sheet 关闭逻辑调用）。 */
export function onSheetClosed() {
  if (C.endAfterSheet) {
    C.endAfterSheet = false
    endCall({ silent: true })
    ui.switchTab('chat')
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */
function bindCall() {
  C.bound = true
  D.talk.addEventListener('click', () => {
    void togglePtt()
  })
  // PTT 录音中：只保留「取消」；结束时直接再点大麦克风
  if (D.pttCancel) D.pttCancel.addEventListener('click', (event) => {
    event.stopPropagation()
    cancelPtt()
  })
  // 麦克风诊断按钮
  if (D.historyBtn) D.historyBtn.addEventListener('click', () => toggleHistory())
  if (D.micRetry) D.micRetry.addEventListener('click', () => void handleMicRetry())
  if (D.micDiagBtn) D.micDiagBtn.addEventListener('click', () => void copyMicDiagnostics())
  if (D.micTextBtn) D.micTextBtn.addEventListener('click', () => {
    if (C.ptt === 'recording' || C.ptt === 'submitting') cancelPtt()
    if (D.micExtra) D.micExtra.hidden = true
    showTextForm(true)
  })
  // 长按视觉反馈（点击已统一处理）
  D.talk.addEventListener('pointerdown', () => D.talk.classList.add('is-holding'))
  D.talk.addEventListener('pointerup', () => D.talk.classList.remove('is-holding'))
  D.talk.addEventListener('pointercancel', () => D.talk.classList.remove('is-holding'))

  D.textBtn.addEventListener('click', () => {
    const show = D.textForm.hidden
    showTextForm(show)
    if (show && C.ptt === 'recording') void cancelPtt()
  })
  D.textForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const value = D.textInput.value.trim()
    if (!value) return
    D.textInput.value = ''
    if (C.lesson) lessonOnUserText(value)
    const node = addBubble('user', value)
    setDialogueUser(value)
    C.messages.push({ role: 'user', content: value })
    C.userTurns += 1
    void translateBubble(node.id, value)
    void sendTextToChat(value)
    showTextForm(false)
  })
  if (D.kbBar) {
    D.kbBar.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('#call-docs-btn')) {
        toggleDocsPanel()
        return
      }
      cycleKbMode()
    })
  }
  bindDocsControls()
  bindLessonControls()
  if (!C.lessonPersistBound) {
    C.lessonPersistBound = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistLessonProgress({ immediate: true, keepalive: true })
    })
    window.addEventListener('pagehide', () => persistLessonProgress({ immediate: true, keepalive: true }))
  }
  if (D.citations) {
    D.citations.addEventListener('click', (event) => {
      const card = event.target instanceof Element ? event.target.closest('.citation-card') : null
      if (!card) return
      const docId = card.getAttribute('data-docid') || ''
      const chunkId = card.getAttribute('data-chunkid') || ''
      if (docId || chunkId) focusDocsChunk(docId, chunkId, { force: true })
    })
  }
  D.hintBtn.addEventListener('click', () => void askHint())
  D.mute.addEventListener('click', () => {
    C.muted = !C.muted
    D.mute.classList.toggle('is-off', C.muted)
    D.mute.classList.toggle('is-on', !C.muted)
    D.mute.setAttribute('aria-pressed', C.muted ? 'true' : 'false')
    if (C.muted) {
      void stopCharacterVoice()
      try {
        tts.cancel()
      } catch {
        /* 忽略 */
      }
      if (C.volc && C.volc.isActive) {
        try {
          C.volc.interrupt()
        } catch {
          /* 忽略 */
        }
      }
      toast('已静音 Ava 的语音', 'info', 1800)
    } else {
      toast('已取消静音', 'info', 1600)
    }
  })
  D.translate.addEventListener('click', () => {
    C.translateOn = !C.translateOn
    D.translate.classList.toggle('is-off', !C.translateOn)
    D.translate.classList.toggle('is-on', C.translateOn)
    D.translate.setAttribute('aria-pressed', C.translateOn ? 'true' : 'false')
    translateAllBubbles()
    toast(C.translateOn ? '已开启中文字幕' : '已关闭中文字幕', 'info', 1700)
  })
  D.hangup.addEventListener('click', () => void hangup())
  D.back.addEventListener('click', () => void hangup())
  // 退出时清理
  window.addEventListener('pagehide', () => {
    try {
      if (C.volc && typeof C.volc.dispose === 'function') C.volc.dispose()
    } catch {
      /* 忽略 */
    }
  })
}

/* ------------------------------ 小工具 ------------------------------ */
function hexToRgba(hex, alpha = 1) {
  const value = String(hex || '').replace('#', '')
  if (value.length !== 6) return `rgba(120, 140, 220, ${alpha})`
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** QA/演示：无麦克风环境预览「说话中」口播状态（ms 后自动回到 idle）。 */
export function previewSpeaking(ms = 2400) {
  if (!C.open) return false
  setState('speaking')
  startSpeechPulse()
  setTimeout(() => {
    if (C.open && C.state === 'speaking') setState('idle')
  }, Math.max(500, Number(ms) || 2400))
  return true
}

/** 供 QA/调试读取通话状态。 */
export function micDiagnostics() {
  return micDiagnosticsImpl()
}

export function getCallState() {
  return {
    open: C.open,
    character: C.character && C.character.id,
    teacherId: C.character ? C.character.id : null,
    scene: C.scene && C.scene.id,
    engine: C.engine,
    state: C.state,
    userTurns: C.userTurns,
    messages: C.messages.slice(),
    bubbles: C.bubbles.length,
    translateOn: C.translateOn,
    head: !!C.head,
    kbMode: C.kbMode,
    kbDocIds: C.kbDocIds.slice(),
    kbHits: C.kbHits.length,
    lesson: C.lesson
      ? {
          id: C.lesson.id,
          title: C.lesson.title,
          sceneId: C.lesson.sceneId,
          stageId: C.lessonStageId,
          step: C.lessonStep,
          phraseIdx: C.lessonPhraseIdx,
          attempts: C.lessonAttempts,
          passed: C.lessonPassed.slice(),
          practiceTurns: C.lessonPracticeTurns,
          challengeTurns: C.lessonChallengeTurns,
          done: C.lessonDone,
          submitting: C.lessonSubmitting,
          panelOpen: C.lessonPanelOpen,
          usedPhrase: C.lessonUsedPhrase,
        }
      : null,
    docs: {
      available: docsAvailable(),
      open: C.docs.open,
      loading: C.docs.loading,
      follow: C.docs.follow,
      fontSize: C.docs.fontSize,
      error: C.docs.error,
      activeId: C.docs.activeId,
      activeChunk: C.docs.activeChunk,
      docs: (C.docs.docs || []).map((doc) => ({ id: doc.id, title: doc.title, chunks: doc.chunks.length })),
    },
    ptt: C.ptt,
    mic: C.mic.state,
    micActive: !!C.mic.active,
    voice: readVoiceDiag(),
    micEnv: C.mic.env
      ? { secure: C.mic.env.secure, hasMedia: C.mic.env.hasMedia, permission: C.mic.env.permission, audioInputs: C.mic.env.audioInputs }
      : null,
    micLevel: Math.round(C.mic.level * 100) / 100,
  }
}

export { C as callState }
