import { apiFetch } from '../backend.js'
/**
 * Ava 手机版 · 五个 Tab 屏幕渲染（课程 / 对话 / 助手 / 复习 / 我的）
 * v3.1：课程页改为「用户自定义计划 + 自选老师 + AI 课件生成态」；对话页去角色场景。
 * v3.2：课程卡/hero 显示中途断点（lesson.resume）→「继续上课」/「继续学习」+ 重新开始。
 * @module mobile/screens
 */
import {
  $, $$, esc, icon, toast, ui, M,
  api,
  characterById, saveSettings, assistantChat,
  saveLocalPlan, loadPlan, loadWordbook, loadProgress,
  showWordbookSheet, sleep, loadProfile, saveProfile,
} from './core.js'
import { renderReview } from './review.js'
import { openLibrarySheet, libraryStats } from './library.js'
import { tts } from '../speech.js'

/* ==========================================================================
   课程页（v3.1：用户自定义计划 + 自选老师 + AI 课件生成状态）
   - 状态机：无计划空态 / generating 骨架+2s 轮询 / hasError 重试 / ready 完整课程页
   - 老师选择器：Elena / Maya / Hikari → PATCH /api/plan/teacher
   - 常用句 🔊：优先 voice-audio.playCharacterText（角色原声），未就绪回退浏览器 tts
   ========================================================================== */

const TEACHER_ORDER = ['elena', 'maya', 'hikari']
const TEACHER_FALLBACK = [
  { id: 'elena', name: 'Elena', nameZh: '艾莲娜' },
  { id: 'maya', name: 'Maya', nameZh: '玛雅' },
  { id: 'hikari', name: 'Hikari', nameZh: '光' },
]

/** 计划接口直连（api.js 的 setPlanTeacher/regeneratePlan 未就绪时兜底；永不 throw）。 */
async function planFetch(path, { method = 'GET', body = null, timeoutMs = 15000 } = {}) {
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
      return { ok: false, error: (data && (data.error || data.message)) || `请求失败（HTTP ${res.status}）`, status: res.status }
    }
    return data && typeof data === 'object' ? data : { ok: true }
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
    return { ok: false, error: aborted ? '请求超时，请稍后重试' : '网络异常，无法连接本地服务' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 优先用 api.js 的封装方法（voice-dev 会加 setPlanTeacher/regeneratePlan），否则直连后端。 */
async function callPlanApi(apiName, apiArgs, path, options) {
  const fn = api && typeof api[apiName] === 'function' ? api[apiName].bind(api) : null
  let data = null
  if (fn) {
    try {
      data = await fn(...(apiArgs || []))
    } catch (err) {
      data = { ok: false, error: (err && err.message) || '计划服务暂不可用' }
    }
  } else {
    data = await planFetch(path, options)
  }
  if (!data || typeof data !== 'object') return { ok: false, error: '计划服务暂不可用，请稍后重试' }
  if (data.ok === false) return { ok: false, error: data.error || '操作失败，请稍后重试' }
  return data
}

/** 计划里的老师角色（从 M.characters 找；找不到用兜底）。 */
function planTeacher(plan) {
  const id = (plan && plan.teacherId) || M.activeCharId || 'elena'
  const found = (M.characters || []).find((c) => c.id === id) || characterById(id)
  if (found) return found
  const fallback = TEACHER_FALLBACK.find((c) => c.id === id) || TEACHER_FALLBACK[0]
  return { ...fallback, cover: `/assets/characters/${fallback.id}.jpg`, scenes: [] }
}

function teacherCandidates() {
  return TEACHER_ORDER.map((id) => {
    const found = (M.characters || []).find((c) => c.id === id)
    const fallback = TEACHER_FALLBACK.find((c) => c.id === id) || { id, name: id, nameZh: '' }
    const base = found || fallback
    return {
      id,
      name: base.name || id,
      nameZh: base.nameZh || '',
      cover: BASE_CHARACTER_COVER(id, base),
      themeColor: base.themeColor || '#6ff2dd',
    }
  })
}

function BASE_CHARACTER_COVER(id, character) {
  const cover = character && character.cover ? String(character.cover) : ''
  if (cover && cover !== 'undefined') return cover
  return `/assets/characters/${id}.jpg`
}

/** 课程页状态：course 视图专用运行期状态。 */
const coursesState = {
  pollTimer: 0,
  pollBusy: false,
  teacherBusy: false,
  retryBusy: false,
  restartBusy: false,
  voiceAudio: null,
  voiceAudioLoading: null,
}

/* ------------------------------ 课件生成轮询 ------------------------------ */
function stopPlanPoll() {
  if (coursesState.pollTimer) {
    clearInterval(coursesState.pollTimer)
    coursesState.pollTimer = 0
  }
}

async function pollPlanOnce() {
  if (coursesState.pollBusy) return
  coursesState.pollBusy = true
  try {
    const plan = await loadPlan()
    const generating = !!(plan && plan.version === 3 && plan.generating)
    if (!generating) {
      stopPlanPoll()
      if (M.tab === 'courses') renderCourses()
      return
    }
    if (M.tab !== 'courses') return
    // 只更新生成进度文案，不整体重渲染（避免轮询闪烁）
    const lessons = (plan.stages || []).map((stage) => (stage.lesson ? stage.lesson.status : 'generating'))
    const readyCount = lessons.filter((status) => status === 'ready').length
    const countEl = document.getElementById('plan-gen-count')
    const barEl = document.getElementById('plan-gen-bar')
    if (countEl) countEl.textContent = `${readyCount}/${lessons.length} 已就绪`
    if (barEl) barEl.style.width = `${Math.max(6, Math.round((readyCount / Math.max(1, lessons.length)) * 100))}%`
  } catch {
    /* 轮询失败静默，等下一轮 */
  } finally {
    coursesState.pollBusy = false
  }
}

function ensurePlanPoll() {
  if (coursesState.pollTimer) return
  coursesState.pollTimer = setInterval(() => void pollPlanOnce(), 2000)
}

/* ------------------------------ 语音（角色原声 / TTS 兜底） ------------------------------ */
function ensureVoiceAudio() {
  if (coursesState.voiceAudio) return Promise.resolve(coursesState.voiceAudio)
  if (coursesState.voiceAudioLoading) return coursesState.voiceAudioLoading
  coursesState.voiceAudioLoading = import('./voice-audio.js')
    .then((mod) => {
      coursesState.voiceAudio = mod && typeof mod.playCharacterText === 'function' ? mod : null
      return coursesState.voiceAudio
    })
    .catch(() => {
      coursesState.voiceAudio = null
      return null
    })
    .finally(() => {
      coursesState.voiceAudioLoading = null
    })
  return coursesState.voiceAudioLoading
}

let coursesTtsWarned = false
/** v3.8：浏览器内置语音已关闭，只用角色原声；未就绪时等 helper 加载，失败轻提示一次。 */
function speakPhraseFallback(text) {
  const value = String(text == null ? '' : text).trim()
  if (!value) return
  if (!coursesTtsWarned) {
    coursesTtsWarned = true
    toast('发音暂不可用，请稍后再试', 'info', 2400)
  }
}

/** 常用句发音：优先角色原声（voice-audio），失败回退浏览器 TTS。 */
function speakLessonPhrase(text, characterId) {
  const value = String(text == null ? '' : text).trim()
  if (!value) return
  const mod = coursesState.voiceAudio
  if (mod) {
    try {
      if (typeof mod.stopCharacterText === 'function') {
        try {
          mod.stopCharacterText()
        } catch {
          /* 忽略 */
        }
      }
      const result = mod.playCharacterText(value, { characterId: characterId || planTeacher(M.plan).id })
      if (result && typeof result.then === 'function') {
        result.then((ok) => {
          if (ok === false) speakPhraseFallback(value)
        }).catch(() => speakPhraseFallback(value))
      }
      return
    } catch {
      speakPhraseFallback(value)
      return
    }
  }
  // helper 尚未加载：加载后自动播一次（不要用浏览器 TTS）
  void ensureVoiceAudio().then((loaded) => {
    if (loaded) speakLessonPhrase(value, characterId)
    else speakPhraseFallback(value)
  })
}

/* ------------------------------ 计划动作 ------------------------------ */
/** 打开某节课（lesson 模式）：teacherChar 从 plan.teacherId 找，lesson 来自计划。 */
function openPlanLesson(plan, stage) {
  if (!plan || !stage) return
  const lesson = stage.lesson || null
  if (!lesson) {
    toast('这节课的课件还在准备中，稍后再试', 'info', 2400)
    return
  }
  if (lesson.status && lesson.status !== 'ready') {
    toast(lesson.status === 'error' ? '这节课的课件生成失败，先重试生成' : '这节课的课件还在生成，稍等一下', 'info', 2600)
    return
  }
  const teacher = planTeacher(plan)
  ui.openCall(teacher, 0, {
    lesson,
    lessonId: lesson.id,
    stageId: stage.id,
    teacherId: plan.teacherId,
  })
}

async function pickPlanTeacher(teacherId) {
  if (!teacherId) return
  const current = M.plan && M.plan.teacherId
  if (teacherId === current) return
  if (coursesState.teacherBusy) return
  coursesState.teacherBusy = true
  try {
    const res = await callPlanApi('setPlanTeacher', [teacherId], '/api/plan/teacher', {
      method: 'PATCH',
      body: { teacherId },
    })
    if (!res.ok) {
      toast(res.error || '切换老师失败，请稍后重试', 'bad', 3000)
      return
    }
    if (res.plan && typeof res.plan === 'object') saveLocalPlan(res.plan)
    else if (M.plan) saveLocalPlan({ ...M.plan, teacherId, teacherName: planTeacher({ teacherId }).name })
    renderCourses()
    toast(`老师已切换为 ${planTeacher(M.plan).name}`, 'ok', 2400)
  } finally {
    coursesState.teacherBusy = false
  }
}

/** v3.2：清除某节课断点（从头开始）。 */
async function restartPlanLesson(lessonId) {
  const id = String(lessonId || '').trim()
  if (!id || coursesState.restartBusy) return
  coursesState.restartBusy = true
  try {
    const res = await callPlanApi('restartLesson', [id], '/api/plan/lesson-restart', {
      method: 'POST',
      body: { lessonId: id },
    })
    if (!res.ok) {
      toast(res.error || '清除断点失败，请稍后重试', 'bad', 2800)
      return
    }
    if (res.plan && typeof res.plan === 'object') {
      saveLocalPlan(res.plan)
      renderCourses()
    } else {
      await refreshCourses()
    }
    toast('已清除断点，下次从第 1 步开始', 'ok', 2400)
  } finally {
    coursesState.restartBusy = false
  }
}

async function retryPlanGeneration() {
  if (coursesState.retryBusy) return
  coursesState.retryBusy = true
  try {
    const res = await callPlanApi('regeneratePlan', [], '/api/plan/generate', { method: 'POST' })
    if (!res.ok) {
      toast(res.error || '重试失败，请稍后重试', 'bad', 3000)
      return
    }
    if (res.plan && typeof res.plan === 'object') saveLocalPlan(res.plan)
    renderCourses()
    toast('正在重新生成课件…', 'info', 2600)
  } finally {
    coursesState.retryBusy = false
  }
}

/* ------------------------------ 渲染：通用片段 ------------------------------ */
function renderCoursesHead(plan) {
  const level = (M.settings && M.settings.level) || (plan && plan.level) || 'A2'
  let sub = '按你的目标练习，每次几分钟，慢慢就敢说了。'
  if (plan) {
    if (plan.generating) sub = 'AI 正在写你的专属课件，稍等几秒就能开始上课。'
    else if (plan.hasError) sub = '课件生成遇到问题，可以重试或换一种说法告诉 Ava。'
    else sub = `${esc(plan.goalText || plan.summary || '')} · 老师 ${esc(plan.teacherName || '')} · ${esc(level)}`
  }
  return `
    <div class="brand-row">
      <div class="brand">
        <span class="brand-orb">${icon('spark')}</span>
        <div><div class="brand-name">Ava 英语会话</div><div class="brand-tag">今天也开口说两句</div></div>
      </div>
      <div class="brand-actions">
        <span class="m-chip accent">${icon('flame')}${esc(level)}</span>
      </div>
    </div>
    <div class="m-head">
      <div>
        <div class="m-eyebrow">Your plan</div>
        <h1 class="m-title">我的学习计划</h1>
        <p class="m-sub">${sub}</p>
      </div>
    </div>`
}

function renderEmptyPlan() {
  return `<div class="screen-layout">
    <div class="screen-side">
      <div class="hero-card">
        <div class="hero-top">
          <div>
            <div class="hero-title">期待与您的第一个计划～</div>
            <div class="hero-sub">去「助手」告诉 Ava 你想学什么，比如「咖啡店点单、机场值机、酒店入住，A2」——她会生成 3 节课的专属课件，还能自选老师。</div>
          </div>
          <span class="hero-level">AI 定制</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:7px;padding:11px 13px;border-radius:13px;border:1px solid rgba(111,242,221,.2);background:rgba(111,242,221,.05);font-size:11.5px;line-height:1.6;color:var(--m-muted)">
          <div>① 告诉 Ava 想学的主题和等级</div>
          <div>② AI 生成 3 节课（每课 5 句常用句 + 3 步练习）</div>
          <div>③ 选老师 → 点「开始上课」，数字人老师逐句教你</div>
        </div>
        <div class="hero-actions">
          <button type="button" class="btn btn-primary btn-sm" data-act="go-assistant">${icon('spark')}去助手定制计划</button>
        </div>
      </div>
    </div>
    <div class="screen-main">
      <div class="section-row"><span class="section-title">${icon('book')}学习阶段</span><span class="section-more">等待你的第一个计划</span></div>
      <div class="empty-card" style="display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:24px 26px">
        <span class="empty-orb">${icon('spark')}</span>
        <strong style="font-size:16px">还没有学习计划</strong>
        <p style="margin:0;font-size:12.5px;line-height:1.7;color:var(--m-muted);max-width:52ch">在「助手」里用一句话描述你想学的场景，Ava 会为你生成 3 节专属课程；生成完成后，这里会出现课程卡和「开始上课」按钮。</p>
        <button type="button" class="btn btn-primary btn-sm" data-act="go-assistant">${icon('spark')}去助手定制计划</button>
      </div>
      ${renderQuickChat(true)}
    </div>
  </div>`
}

/** 骨架块（生成中占位）。 */
function genSkeletonLine(width) {
  return `<div style="height:10px;width:${width};border-radius:6px;background:linear-gradient(100deg,rgba(255,255,255,.04),rgba(255,255,255,.1),rgba(255,255,255,.04));background-size:220% 100%;animation:rv-skel 1.3s ease-in-out infinite"></div>`
}

function renderGeneratingPlan(plan) {
  const teacher = planTeacher(plan)
  const stages = plan.stages || []
  const readyCount = stages.filter((stage) => stage.lesson && stage.lesson.status === 'ready').length
  const pct = Math.max(6, Math.round((readyCount / Math.max(1, stages.length)) * 100))
  const hero = `<div class="hero-card">
    <div class="hero-top">
      <div>
        <div class="hero-title">${esc(plan.title || '你的专属英语计划')}</div>
        <div class="hero-sub">${esc(plan.goalText || plan.summary || '')}<br>老师：${esc(teacher.name)} · ${esc(plan.level || 'A2')} · 3 节课</div>
      </div>
      <span class="hero-level">AI 生成中</span>
    </div>
    <div class="hero-progress">
      <div class="hero-progress-row"><span>正在生成课件…</span><span id="plan-gen-count">${readyCount}/${stages.length} 已就绪</span></div>
      <div class="progress-track"><div class="progress-fill" id="plan-gen-bar" style="width:${pct}%"></div></div>
    </div>
    <div style="display:flex;align-items:center;gap:9px;padding:10px 12px;border-radius:12px;border:1px solid rgba(111,242,221,.22);background:rgba(111,242,221,.06);font-size:11.5px;line-height:1.5;color:var(--m-muted)">
      <span class="spinner" style="width:16px;height:16px;flex:none"></span>
      <span>AI 正在写每节课的目标、5 句常用句和 3 步课堂，约 5–10 秒…</span>
    </div>
    <div class="hero-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-act="go-assistant">${icon('chat')}去助手修改需求</button>
    </div>
  </div>`
  const skeleton = stages
    .map(
      (stage) => `<div class="stage-card">
        <div class="stage-head">
          <span class="stage-emoji">${esc(stage.emoji || '📘')}</span>
          <div style="flex:1;min-width:0">
            <div class="stage-title">${esc(stage.title || '第 ' + (stages.indexOf(stage) + 1) + ' 课')}</div>
            <div class="stage-meta">${esc(stage.focus || 'AI 正在准备课件')}</div>
          </div>
          <span class="m-chip">生成中</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;padding:4px 0">
          ${genSkeletonLine('72%')}${genSkeletonLine('88%')}${genSkeletonLine('60%')}
        </div>
      </div>`,
    )
    .join('')
  return `<div class="screen-layout">
    <div class="screen-side">${hero}</div>
    <div class="screen-main">
      <div class="section-row"><span class="section-title">${icon('book')}课程结构</span><span class="section-more">${stages.length} 节课 · 生成后可上课</span></div>
      <div class="plan-stages">${skeleton}</div>
      ${renderQuickChat(true)}
    </div>
  </div>`
}

function renderErrorPlan(plan) {
  const teacher = planTeacher(plan)
  const hero = `<div class="hero-card" style="border-color:rgba(255,113,136,.32)">
    <div class="hero-top">
      <div>
        <div class="hero-title">${esc(plan.title || '你的专属英语计划')}</div>
        <div class="hero-sub">${esc(plan.goalText || '')}<br>老师：${esc(teacher.name)} · ${esc(plan.level || 'A2')}</div>
      </div>
      <span class="hero-level" style="color:#ffb4c0;background:rgba(255,113,136,.12);border-color:rgba(255,113,136,.32)">生成失败</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;padding:12px 13px;border-radius:13px;border:1px solid rgba(255,113,136,.3);background:rgba(255,113,136,.08)">
      <div style="font-size:12px;font-weight:680;color:#ffd4da">课件生成失败</div>
      <div style="font-size:11px;line-height:1.6;color:var(--m-muted)">${esc(plan.errorMessage || 'AI 服务暂时不可用，请稍后重试。')}</div>
    </div>
    <div class="hero-actions">
      <button type="button" class="btn btn-primary btn-sm" data-act="retry-generate">${icon('refresh')}重试生成</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="go-assistant">${icon('chat')}去助手修改需求</button>
    </div>
  </div>`
  const cards = (plan.stages || []).map((stage) => renderPlanStage(plan, stage, { phase: 'error' })).join('')
  return `<div class="screen-layout">
    <div class="screen-side">${hero}</div>
    <div class="screen-main">
      <div class="section-row"><span class="section-title">${icon('book')}课程结构</span><span class="section-more">可重试生成</span></div>
      <div class="plan-stages">${cards}</div>
      ${renderQuickChat(true)}
    </div>
  </div>`
}

/* ------------------------------ 渲染：ready 课程页 ------------------------------ */
function teacherSelector(plan) {
  const activeId = plan.teacherId || 'elena'
  return `<div style="display:flex;flex-direction:column;gap:7px">
    <div style="font-size:10.5px;letter-spacing:.08em;color:var(--m-faint);font-weight:700">选择老师</div>
    <div style="display:flex;gap:7px;flex-wrap:wrap">
      ${teacherCandidates()
        .map((teacher) => {
          const on = teacher.id === activeId
          return `<button type="button" data-act="pick-teacher" data-char="${esc(teacher.id)}" aria-pressed="${on ? 'true' : 'false'}" style="display:flex;align-items:center;gap:7px;padding:4px 11px 4px 4px;border-radius:999px;border:1px solid ${on ? 'rgba(111,242,221,.55)' : 'rgba(255,255,255,.14)'};background:${on ? 'rgba(111,242,221,.12)' : 'rgba(148,163,196,.06)'};color:${on ? 'var(--m-teal)' : 'var(--m-muted)'};font-size:11.5px;font-weight:650;transition:.2s">
            <img src="${esc(teacher.cover)}" alt="${esc(teacher.name)}" loading="lazy" draggable="false" style="width:24px;height:24px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,.2)">
            <span>${esc(teacher.name)}</span>
            ${on ? '<span style="font-size:9.5px;opacity:.8">当前</span>' : ''}
          </button>`
        })
        .join('')}
    </div>
  </div>`
}

/** v4.1：统一的课程条目（第 1/2/3 课同一种模组，不再套阶段卡）。 */
function renderCourseRow(plan, stage, index) {
  const lesson = stage.lesson || {}
  const locked = !stage.unlocked
  const done = !!stage.done
  const resume = lessonResumeInfo(lesson)
  const isNext = !!(plan.next && plan.next.lessonId === stage.lessonId)
  const statusChip = done
    ? '<span class="m-chip accent">✓ 已完成</span>'
    : locked
      ? `<span class="m-chip">${lockIcon()}未解锁</span>`
      : resume
        ? `<span class="m-chip accent">${esc(resume.chipLabel)}</span>`
        : isNext
          ? '<span class="m-chip accent">下一课</span>'
          : '<span class="m-chip">未开始</span>'
  const phrases = Array.isArray(lesson.phrases) && lesson.phrases.length
    ? `<div>
        <button type="button" class="scene-btn" data-act="toggle-phrases" data-lesson-id="${esc(lesson.id)}" aria-expanded="false">▸ 5 句常用句</button>
        <div class="lesson-phrases" data-phrases-for="${esc(lesson.id)}" hidden>
          ${lesson.phrases.slice(0, 5).map((phrase) => `<div class="clr-phrase">
            <button type="button" class="icon-btn" data-act="speak-phrase" data-phrase="${esc(phrase.en)}" aria-label="朗读 ${esc(phrase.en)}">${icon('volume')}</button>
            <div><div class="clr-phrase-en">${esc(phrase.en)}</div><div class="clr-phrase-zh">${esc(phrase.zh || '')}</div></div>
          </div>`).join('')}
        </div>
      </div>`
    : ''
  const actionLabel = done ? '再练一次' : resume ? '继续上课' : '开始上课'
  const actionClass = done ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm'
  return `<div class="lesson-card course-lesson-row${locked ? ' is-locked' : ''}" data-lesson-id="${esc(lesson.id)}" data-resume-step="${resume ? esc(resume.step) : ''}" data-resume-detail="${resume ? esc(resume.detail) : ''}">
    <div class="clr-index"><strong>${String(index + 1).padStart(2, '0')}</strong><span>第 ${index + 1} 课</span></div>
    <div class="clr-main">
      <div class="clr-top"><span class="clr-emoji">${esc(lesson.emoji || stage.emoji || '📘')}</span><span class="clr-title">${esc(lesson.title || stage.title || '课程')}</span>${statusChip}</div>
      <div class="clr-meta">${esc(plan.level || 'A2')} · 老师 ${esc(plan.teacherName || '')} · 5 句常用句 · 3 步完成</div>
      ${resume ? `<div class="lesson-resume">⏸ 上次学到：${esc(resume.stepLabel)} · ${esc(resume.detail)}</div>` : ''}
      ${locked
        ? `<div class="clr-lock">${lockIcon()}<span>完成上一课后解锁这节「${esc(lesson.title || stage.title || '课程')}」</span></div>`
        : phrases}
    </div>
    ${locked ? '' : `<div class="clr-action">
      <button type="button" class="${actionClass}" data-act="start-lesson" data-stage="${esc(stage.id || '')}" data-lesson-id="${esc(lesson.id)}">${icon('phone')}${esc(actionLabel)}</button>
      ${resume && !done ? `<button type="button" class="scene-btn" data-act="restart-lesson" data-lesson-id="${esc(lesson.id)}">从头开始</button>` : ''}
    </div>`}
  </div>`
}

function renderReadyPlan(plan) {
  const teacher = planTeacher(plan)
  const next = plan.next
  const nextStage = next
    ? (plan.stages || []).find(
        (stage) => stage.id === next.stageId || (stage.lesson && stage.lesson.id === next.lessonId),
      ) || null
    : null
  const nextResume = lessonResumeInfo(nextStage && nextStage.lesson)
  const nextBlock = next
    ? `<div data-next-resume-step="${nextResume ? nextResume.step : ''}" style="display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-radius:12px;border:1px solid rgba(111,242,221,.22);background:rgba(111,242,221,.06)">
        <div style="font-size:12px;font-weight:680;line-height:1.4">▶ ${nextResume ? '继续上次' : '下一课'}：${esc(next.emoji || '')} ${esc(next.label || '')}</div>
        <div style="font-size:10.5px;color:var(--m-faint)">${nextResume ? `上次学到：${esc(nextResume.stepLabel)}（${esc(nextResume.detail)}） · ` : ''}${esc(next.stageTitle || '')} · 老师 ${esc(teacher.name)} · 约 5 分钟</div>
      </div>`
    : `<div style="display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,197,122,.3);background:rgba(255,197,122,.08)">
        <div style="font-size:12px;font-weight:680;line-height:1.4">🎉 全部课程已完成</div>
        <div style="font-size:10.5px;color:var(--m-faint)">已完成 ${esc(plan.doneLessons)}/${esc(plan.totalLessons)} 节课，可以随时再练一次或调整计划。</div>
      </div>`
  const hero = `<div class="hero-card">
    <div class="hero-top">
      <div>
        <div class="hero-title">${esc(plan.title || `${teacher.name} 的专属英语计划`)}</div>
        <div class="hero-sub">${esc(plan.goalText || plan.summary || '')}<br>老师：${esc(teacher.name)} · ${esc(plan.level || 'A2')} · 已完成 ${esc(plan.doneLessons)}/${esc(plan.totalLessons)} 节课</div>
      </div>
      <span class="hero-level">${esc(plan.level || 'A2')}</span>
    </div>
    <div class="hero-progress">
      <div class="hero-progress-row"><span>整体进度</span><span>${esc(plan.progress || 0)}%</span></div>
      <div class="progress-track" aria-label="整体进度 ${esc(plan.progress || 0)}%"><div class="progress-fill" style="width:${esc(plan.progress || 0)}%"></div></div>
    </div>
    ${nextBlock}
    ${teacherSelector(plan)}
    <div class="hero-actions">
      ${next ? `<button type="button" class="btn btn-primary btn-sm" data-act="resume">${icon('phone')}继续学习</button>` : ''}
      <button type="button" class="btn btn-ghost btn-sm" data-act="adjust-plan">${icon('refresh')}调整计划</button>
    </div>
  </div>`
  const rows = (plan.stages || []).map((stage, index) => renderCourseRow(plan, stage, index)).join('')
  return `<div class="course-plan-page">
    ${hero}
    <div class="section-row"><span class="section-title">${icon('book')}我的课程</span><span class="section-more">${esc(plan.totalLessons || 3)} 节课 · 已完成 ${esc(plan.doneLessons)} 节</span></div>
    <div class="course-lesson-list">${rows}</div>
    ${renderQuickChat(true)}
  </div>`
}

/** 课程断点信息（v3.2）：lesson.resume → {step, stepLabel, stepName, detail, chipLabel}。 */
function lessonResumeInfo(lesson) {
  if (!lesson || lesson.done) return null
  const raw = lesson.resume
  if (!raw || typeof raw !== 'object') return null
  const step = Math.max(1, Math.min(3, Math.floor(Number(raw.step) || 1)))
  const phraseTotal = Array.isArray(lesson.phrases) && lesson.phrases.length ? lesson.phrases.length : 5
  const phraseIdx = Math.max(0, Math.min(phraseTotal, Math.floor(Number(raw.phraseIdx) || 0)))
  const practiceTurns = Math.max(0, Math.floor(Number(raw.practiceTurns) || 0))
  const challengeTurns = Math.max(0, Math.floor(Number(raw.challengeTurns) || 0))
  const stepName = step === 1 ? '跟读常用句' : step === 2 ? '场景练习' : '完成挑战'
  const detail =
    step === 1
      ? `跟读 ${phraseIdx}/${phraseTotal} 句`
      : step === 2
        ? `场景练习中${practiceTurns > 0 ? ` · 已练 ${practiceTurns} 轮` : ''}`
        : `挑战中${challengeTurns > 0 ? ` · 已进行 ${challengeTurns} 轮` : ''}`
  return {
    step,
    phraseIdx,
    phraseTotal,
    practiceTurns,
    challengeTurns,
    stepName,
    stepLabel: `第${step}步`,
    detail,
    chipLabel: `继续 · 第${step}步`,
  }
}

/** 内联锁图标（不依赖 emoji 字体）。 */
function lockIcon() {
  return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:12px;height:12px"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/></svg>'
}

/** 课程阶段卡（ready/error 共用）。 */
function renderPlanStage(plan, stage, opts = {}) {
  const phase = opts.phase || 'ready'
  const lesson = stage.lesson || null
  const done = !!stage.done
  const unlocked = !!stage.unlocked
  const isNext = !!(plan.next && plan.next.lessonId === stage.lessonId)
  const locked = !unlocked
  const resume = lessonResumeInfo(lesson)
  const statusChip = done
    ? '<span class="m-chip accent" style="flex:none">✓ 已完成</span>'
    : locked
      ? `<span class="m-chip" style="flex:none">${lockIcon()}未解锁</span>`
      : resume
        ? `<span class="m-chip accent" style="flex:none">${esc(resume.chipLabel)}</span>`
        : isNext
          ? '<span class="m-chip accent" style="flex:none">下一课</span>'
          : lesson && lesson.status === 'generating'
            ? '<span class="m-chip" style="flex:none">生成中</span>'
            : lesson && lesson.status === 'error'
              ? '<span class="m-chip" style="flex:none;color:#ffb4c0">生成失败</span>'
              : '<span class="m-chip" style="flex:none">未开始</span>'
  const body = locked
    ? `<div style="display:flex;align-items:center;gap:9px;padding:11px 12px;border-radius:12px;border:1px dashed rgba(148,163,196,.28);background:rgba(148,163,196,.04);font-size:11.5px;line-height:1.5;color:var(--m-faint)">
        <span style="display:grid;place-items:center;width:18px;height:18px;flex:none;color:var(--m-faint)">${lockIcon()}</span>
        <span>完成上一课后解锁这节「${esc((lesson && lesson.title) || stage.title || '课程')}」</span>
      </div>`
    : renderPlanLessonCard(plan, stage, phase)
  return `<div class="stage-card" style="display:flex;flex-direction:column;gap:10px;${unlocked ? '' : 'opacity:.82'}">
    <div class="stage-head">
      <span class="stage-emoji">${esc(stage.emoji || '📘')}</span>
      <div style="flex:1;min-width:0">
        <div class="stage-title">${esc(stage.title || '第 ' + ((plan.stages || []).indexOf(stage) + 1) + ' 课')}${done ? ' ✓' : ''}</div>
        <div class="stage-meta">${esc(stage.focus || '')}${lesson ? ' · 5 句常用句 · 3 步完成' : ''}</div>
      </div>
      ${statusChip}
    </div>
    <div class="stage-progress" aria-label="阶段进度 ${esc(stage.progress || 0)}%"><div class="progress-track"><div class="progress-fill" style="width:${esc(stage.progress || 0)}%"></div></div><span>${esc(stage.progress || 0)}%</span></div>
    ${body}
  </div>`
}

/** 课程卡内容（ready / generating / error / done）。 */
function renderPlanLessonCard(plan, stage, phase) {
  const lesson = stage.lesson
  if (!lesson) {
    return `<div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--m-faint)">${genSkeletonLine('70%')}</div>`
  }
  if (phase === 'error' && lesson.status !== 'ready') {
    return `<div style="display:flex;flex-direction:column;gap:7px">
      <div style="padding:10px 12px;border-radius:12px;border:1px solid rgba(255,113,136,.28);background:rgba(255,113,136,.07);font-size:11px;line-height:1.55;color:#ffd4da">${esc(lesson.error || plan.errorMessage || '课件生成失败')}</div>
      <div><button type="button" class="btn btn-primary btn-sm" data-act="retry-generate">${icon('refresh')}重试生成</button></div>
    </div>`
  }
  if (lesson.status === 'generating') {
    return `<div style="display:flex;flex-direction:column;gap:8px;padding:2px 0">
      <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--m-muted)"><span class="spinner" style="width:14px;height:14px"></span>AI 正在写这节课的常用句…</div>
      ${genSkeletonLine('78%')}${genSkeletonLine('62%')}
    </div>`
  }
  const done = !!stage.done
  const objectives =
    Array.isArray(lesson.objectives) && lesson.objectives.length
      ? `<ul style="margin:0;padding-left:16px;display:flex;flex-direction:column;gap:3px;font-size:11.5px;line-height:1.55;color:var(--m-muted)">
          ${lesson.objectives
            .slice(0, 3)
            .map((item) => `<li>${esc(item)}</li>`)
            .join('')}
        </ul>`
      : ''
  const phrases =
    Array.isArray(lesson.phrases) && lesson.phrases.length
      ? `<div>
          <button type="button" class="scene-btn" data-act="toggle-phrases" data-lesson-id="${esc(lesson.id)}" aria-expanded="false">▸ 5 句常用句</button>
          <div class="lesson-phrases" data-phrases-for="${esc(lesson.id)}" hidden style="margin-top:8px;display:flex;flex-direction:column;gap:5px">
            ${lesson.phrases
              .slice(0, 5)
              .map(
                (phrase) => `<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:9px;background:rgba(111,242,221,.05);border:1px solid rgba(111,242,221,.12)">
                  <button type="button" class="icon-btn" style="width:26px;height:26px;border-radius:8px;flex:none" data-act="speak-phrase" data-phrase="${esc(phrase.en)}" aria-label="朗读 ${esc(phrase.en)}">${icon('volume')}</button>
                  <div style="min-width:0">
                    <div style="font-family:var(--font-en);font-size:12px;line-height:1.45">${esc(phrase.en)}</div>
                    <div style="font-size:10.5px;line-height:1.4;color:var(--m-faint);margin-top:1px">${esc(phrase.zh || '')}</div>
                  </div>
                </div>`,
              )
              .join('')}
          </div>
        </div>`
      : ''
  const resume = lessonResumeInfo(lesson)
  const actionLabel = done ? '再练一次' : resume ? '继续上课' : '开始上课'
  const actionClass = done ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm'
  const nextFlag = !!(plan.next && plan.next.lessonId === stage.lessonId)
  const highlight = nextFlag || !!resume
  return `<div class="lesson-card" data-lesson-id="${esc(lesson.id)}" data-resume-step="${resume ? esc(resume.step) : ''}" data-resume-detail="${resume ? esc(resume.detail) : ''}" style="display:flex;flex-direction:column;gap:9px;padding:12px;border-radius:14px;border:1px solid ${highlight ? 'rgba(111,242,221,.32)' : 'var(--m-stroke)'};background:${highlight ? 'linear-gradient(158deg, rgba(111,242,221,.08), rgba(10,15,26,.55))' : 'rgba(148,163,196,.05)'}">
    <div style="display:flex;align-items:center;gap:9px">
      <span style="width:30px;height:30px;border-radius:10px;display:grid;place-items:center;font-size:15px;flex:none;background:rgba(111,242,221,.1);border:1px solid rgba(111,242,221,.18)">${esc(lesson.emoji || stage.emoji || '📘')}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:680;line-height:1.35">${esc(lesson.title || stage.title || '课程')}</div>
        <div style="font-size:10.5px;color:var(--m-faint);margin-top:1px">${esc(plan.level || 'A2')} · 老师 ${esc(plan.teacherName || '')} · 5 句常用句 · 3 步完成</div>
        ${resume ? `<div class="lesson-resume" style="font-size:10.5px;color:var(--m-teal);margin-top:2px">⏸ 上次学到：${esc(resume.stepLabel)} · ${esc(resume.detail)}</div>` : ''}
      </div>
      ${done ? '<span class="m-chip accent" style="flex:none">✓ 已完成</span>' : resume ? `<span class="m-chip accent" style="flex:none">${esc(resume.chipLabel)}</span>` : nextFlag ? '<span class="m-chip accent" style="flex:none">下一课</span>' : '<span class="m-chip" style="flex:none">未开始</span>'}
    </div>
    ${objectives ? `<div style="display:flex;flex-direction:column;gap:3px"><div style="font-size:10.5px;font-weight:700;letter-spacing:.04em;color:var(--m-teal)">本课目标</div>${objectives}</div>` : ''}
    ${phrases}
    <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">
      <button type="button" class="${actionClass}" data-act="start-lesson" data-stage="${esc(stage.id || '')}" data-lesson-id="${esc(lesson.id)}">${icon('phone')}${esc(actionLabel)}</button>
      ${resume && !done ? `<button type="button" class="scene-btn" data-act="restart-lesson" data-lesson-id="${esc(lesson.id)}" title="清除断点，从第 1 步重新开始">从头开始</button>` : ''}
    </div>
  </div>`
}

/** 「随时开聊」：自由聊天（无场景）。 */
function renderQuickChat(compact) {
  return `<div class="section-row"><span class="section-title">${icon('chat')}随时开聊</span><button type="button" class="section-more" data-act="go-chat">全部角色 ›</button></div>
    <div class="quick-grid">
      <button type="button" class="quick-card" data-act="quick-call" data-char="elena">
        <span class="quick-icon teal">${icon('mic')}</span>
        <span class="quick-title">和 Elena 自由聊天</span>
        <span class="quick-sub">温柔伦敦腔 · ${compact ? '随时开口' : 'A2'}</span>
      </button>
      <button type="button" class="quick-card" data-act="quick-call" data-char="maya">
        <span class="quick-icon coral">${icon('bulb')}</span>
        <span class="quick-title">找 Maya 吐槽工作</span>
        <span class="quick-sub">直爽纽约客 · B1</span>
      </button>
    </div>`
}

/* ------------------------------ 渲染入口 / 事件 ------------------------------ */
export function renderCourses() {
  const host = $('#screen-courses')
  if (!host) return
  const plan = M.plan && M.plan.version === 3 && Array.isArray(M.plan.stages) ? M.plan : null
  const head = renderCoursesHead(plan)
  let body
  if (!plan) {
    stopPlanPoll()
    body = renderEmptyPlan()
  } else if (plan.generating) {
    ensurePlanPoll()
    body = renderGeneratingPlan(plan)
  } else if (plan.hasError) {
    stopPlanPoll()
    body = renderErrorPlan(plan)
  } else {
    stopPlanPoll()
    body = renderReadyPlan(plan)
  }
  host.innerHTML =
    head +
    body +
    `<div class="foot-note">AI 根据你的需求生成课程 · 完成 3 步课堂练习后自动解锁下一课 · 进度保存在本机</div>`
  bindCourses(host, plan)
  if (plan) void ensureVoiceAudio()
  if (plan && !plan.generating) stopPlanPoll()
}

/** 展开/收起「5 句常用句」。 */
function toggleCoursePhrases(button) {
  const lessonId = button.getAttribute('data-lesson-id') || ''
  const card = button.closest('.lesson-card')
  const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(lessonId) : String(lessonId).replace(/["\\]/g, '\\$&')
  const panel = card ? card.querySelector(`.lesson-phrases[data-phrases-for="${safeId}"]`) : null
  if (!panel) return
  const show = panel.hidden
  panel.hidden = !show
  button.setAttribute('aria-expanded', show ? 'true' : 'false')
  button.textContent = show ? '▾ 收起常用句' : '▸ 5 句常用句'
}

function bindCourses(host, plan) {
  host.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'go-assistant') {
      ui.switchTab('assistant')
      setTimeout(() => $('#assistant-input') && $('#assistant-input').focus(), 260)
    } else if (act === 'go-chat') ui.switchTab('chat')
    else if (act === 'quick-call') ui.openCall(characterById(target.getAttribute('data-char') || 'elena'))
    else if (act === 'resume') {
      if (!plan || !plan.next) {
        toast('暂时没有待上的课程', 'info', 2200)
        return
      }
      const stage = (plan.stages || []).find((item) => item.id === plan.next.stageId) || (plan.stages || [])[0]
      openPlanLesson(plan, stage)
    } else if (act === 'start-lesson') {
      const lessonId = target.getAttribute('data-lesson-id') || ''
      const stage = (plan && plan.stages || []).find(
        (item) => (item.lesson && item.lesson.id === lessonId) || item.lessonId === lessonId,
      )
      if (stage) openPlanLesson(plan, stage)
      else toast('没有找到这节课，刷新后再试', 'bad', 2400)
    } else if (act === 'speak-phrase') {
      const characterId = (plan && plan.teacherId) || (M.plan && M.plan.teacherId)
      speakLessonPhrase(target.getAttribute('data-phrase'), characterId)
    } else if (act === 'toggle-phrases') {
      toggleCoursePhrases(target)
    } else if (act === 'pick-teacher') {
      void pickPlanTeacher(target.getAttribute('data-char') || '')
    } else if (act === 'retry-generate') {
      void retryPlanGeneration()
    } else if (act === 'restart-lesson') {
      void restartPlanLesson(target.getAttribute('data-lesson-id') || '')
    } else if (act === 'adjust-plan') {
      ui.switchTab('assistant')
      setTimeout(() => $('#assistant-input') && $('#assistant-input').focus(), 260)
    }
  }
}

/** 课程页数据刷新（boot / 切回课程 Tab / 助手创建计划 / 课堂完成后调用）。 */
export async function refreshCourses() {
  const plan = await loadPlan()
  renderCourses()
  if (plan && plan.version === 3 && plan.generating) ensurePlanPoll()
  else stopPlanPoll()
}

/** 角色主题色 → 渐变兜底（角色图缺失时不裂图，用后端 themeColor 渐变）。 */
function charGrad(c) {
  const raw = String((c && c.themeColor) || '').replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return ''
  const r = parseInt(raw.slice(0, 2), 16)
  const g = parseInt(raw.slice(2, 4), 16)
  const b = parseInt(raw.slice(4, 6), 16)
  return `radial-gradient(120% 100% at 50% 0%, rgba(${r}, ${g}, ${b}, .82), rgba(${r}, ${g}, ${b}, .3) 46%, #0f1220 100%)`
}

/* ==========================================================================
   对话页 · 角色画廊
   ========================================================================== */
const activeCharacter = () => M.characters.find((c) => c.id === M.activeCharId) || M.characters[0] || null

/** 对话首页：全屏人物 + HUD 信息卡 + 角色切换器（v1.7） */
export function renderChat() {
  const host = $('#screen-chat')
  if (!host) return
  const chars = M.characters.length ? M.characters : []
  if (!chars.length) {
    host.innerHTML = '<div class="hero-scene"><div class="hero-copy"><div class="hero-eyebrow">Talk with a local</div><h1 class="hero-name">加载中…</h1><p class="hero-role">正在读取角色资料，请稍候</p></div></div>'
    return
  }
  const active = chars.find((c) => c.id === M.activeCharId) || chars[0]
  M.activeCharId = active.id
  if (ui.setWorld) ui.setWorld(active)
  const level = (M.settings && M.settings.level) || active.level || 'A2'
  const tags = (active.tags || []).map((t) => `<span class="hero-tag">${esc(t)}</span>`).join('')
  const switcher = chars
    .map((c) => {
      const on = c.id === active.id
      return '<button type="button" class="switch-card' + (on ? ' is-active' : '') + '" data-act="switch-char" data-char="' + esc(c.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<img src="' + esc(c.cover || '') + '" alt="' + esc(c.name) + '" loading="lazy" draggable="false" onerror="this.onerror=null;this.src=\'./assets/characters/' + esc(c.id) + '.svg\'">' +
        '<div class="switch-info"><div class="switch-name">' + esc(c.name) + '<em>' + esc(c.nameZh || '') + '</em></div>' +
        '<div class="switch-sub">' + esc(c.city || '') + ' · ' + esc(c.occupation || c.role || '') + '</div></div>' +
        '<i class="switch-dot" aria-hidden="true"></i></button>'
    })
    .join('')
  host.innerHTML = `
    <div class="hero-scene">
      <div class="hero-topbar">
        <div class="hero-brand">
          <span class="brand-orb">${icon('spark')}</span>
          <div><div class="hero-brand-name">Ava 英语会话</div><div class="hero-brand-tag">IMMERSIVE ENGLISH · 和 AI 角色开口聊</div></div>
        </div>
        <div class="hero-top-actions">
          <span class="hero-chip accent">${icon('flame')}${esc(level)} 等级</span>
          <span class="hero-chip">${icon('user')}${esc(M.nickname || '英语学习者')}</span>
        </div>
      </div>
      <div class="hero-copy">
        <div class="hero-eyebrow">${esc(active.cityEn || active.city || '')} · ${esc(active.accent || 'English')} · ${esc(active.voiceLabel || '角色音色')}</div>
        <h1 class="hero-name">${esc(active.name)}<small>${esc(active.nameZh || '')}</small></h1>
        <div class="hero-role"><span class="dot"></span>${esc(active.occupation || active.role || '')} · ${esc(active.city || '')}${active.age ? ' · ' + esc(active.age) + ' 岁' : ''}</div>
        <div class="hero-tags">${tags}</div>
        <div class="hero-actions">
          <button type="button" class="hero-cta" data-act="talk">${icon('phone')}去聊聊</button>
          <span class="hero-voice">${icon('volume')}${esc(active.voiceLabel || '角色音色')}</span>
        </div>
      </div>
      <div class="hero-hint">键盘 1-5 切换页面 · 点击右侧卡片切换主角 · 自由聊天，随时开口</div>
      <div class="hero-switcher">
        <div class="hero-switcher-title">选择对话角色</div>
        ${switcher}
      </div>
    </div>`
  bindChat(host, active)
}

function bindChat(host, active) {
  host.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'talk') {
      // v3.1：不再选场景，直接自由聊天
      ui.openCall(active)
    } else if (act === 'switch-char') {
      const id = target.getAttribute('data-char')
      if (!id || id === M.activeCharId) return
      if (ui.setCharacter) ui.setCharacter(id)
      else {
        M.activeCharId = id
        renderChat()
      }
    }
  }
}

/* ==========================================================================
   Ava 助手页
   ========================================================================== */
/** v3.3：助手页渲染缓存 key（thread 长度 + 最后一条内容，切回 Tab 时复用 DOM 不重建）。 */
let assistantRenderKey = ''
let assistantPending = false
let assistantRequestId = 0

/** 计算当前助手 thread 的渲染 key。 */
function assistantThreadKey() {
  const thread = Array.isArray(M.assistantThread) ? M.assistantThread : []
  const last = thread.length ? thread[thread.length - 1] : null
  const lastText = last ? String(last.role || '') + ':' + String(last.content || '').slice(0, 120) : ''
  return String(thread.length) + '|' + lastText + '|' + assistantPending
}

const ASSISTANT_CHIPS = [
  { label: '创建计划', message: '帮我制定一个适合我的英语口语学习计划' },
  { label: '更新我的计划', message: '帮我调整一下当前计划的目标和等级' },
  { label: '快速复习', message: '帮我复习一下今天的单词' },
  { label: '自由聊天', message: '陪我随便聊聊英语，练练口语' },
  { label: '学习偏好', message: '我想调整一下学习偏好' },
  { label: '我要反馈', message: '我想给 Ava 提一点反馈' },
]

export function renderAssistant(options = {}) {
  const host = $('#screen-assistant')
  if (!host) return false
  const renderKey = assistantThreadKey()
  // v3.3：thread 未变化且 DOM 已渲染过 → 直接复用，不重写 innerHTML（切 Tab 不再闪动/跳顶）
  if (!options.force && assistantRenderKey === renderKey && host.firstElementChild && host.querySelector('#assistant-thread')) {
    return false
  }
  // 重建前保留用户正在输入的内容与光标（异步回复到达时也不丢）
  const prevInput = document.getElementById('assistant-input')
  const prevValue = prevInput ? String(prevInput.value || '') : ''
  const prevSelection =
    prevInput && typeof prevInput.selectionStart === 'number' ? prevInput.selectionStart : null
  const prevSelectionEnd =
    prevInput && typeof prevInput.selectionEnd === 'number' ? prevInput.selectionEnd : prevSelection
  const prevFocused = !!prevInput && document.activeElement === prevInput
  const thread = M.assistantThread
  const threadHtml = thread
    .map((m) => {
      if (m.role === 'user') {
        return `<div class="msg user"><div class="msg-bubble">${esc(m.content)}</div></div>`
      }
      return `<div class="msg ava"><span class="msg-avatar">${icon('spark')}</span><div class="msg-bubble">${m.content
        .split('\n')
        .map((line) => `<p>${esc(line)}</p>`)
        .join('')}</div></div>`
    })
    .join('')
  let librarySub = '6 本经典 · 每天 10 分钟带读'
  try {
    const lib = libraryStats()
    if (lib && lib.state && lib.state.streak) {
      librarySub = `连续 ${lib.state.streak} 天 · ${lib.book.titleZh} Day ${lib.dayIndex + 1}`
    }
  } catch {
    /* 忽略 */
  }
  host.innerHTML = `
    <div class="assistant-hero">
      <span class="ava-orb">${icon('spark')}</span>
      <h1 class="assistant-title">Hi, 我是 Ava</h1>
      <p class="assistant-sub">我能帮你定学习计划、陪你自由聊天、复习单词。想做什么？</p>
    </div>
    <div class="screen-layout">
      <div class="screen-side">
        <button type="button" class="kb-entry" data-act="open-kb">
          <span class="kb-entry-orb">${icon('book')}</span>
          <span class="kb-entry-copy"><strong>我的知识库</strong><small>上传文章/杂志或网页，围绕它讨论</small></span>
          <span class="kb-entry-go">${icon('chevron')}</span>
        </button>
        <button type="button" class="kb-entry kb-entry-library" data-act="open-library">
          <span class="kb-entry-orb kb-entry-orb-book">📚</span>
          <span class="kb-entry-copy"><strong>英语书库</strong><small>${esc(librarySub)}</small></span>
          <span class="kb-entry-go">${icon('chevron')}</span>
        </button>
        <div class="assistant-chips">
      ${ASSISTANT_CHIPS.map((c) => `<button type="button" class="a-chip" data-act="chip" data-msg="${esc(c.message)}"${assistantPending ? ' disabled' : ''}>${esc(c.label)}</button>`).join('')}
    </div></div>
      <div class="screen-main">
        <div class="chat-thread" id="assistant-thread">
      ${threadHtml || `<div class="msg ava"><span class="msg-avatar">${icon('spark')}</span><div class="msg-bubble"><p>你可以直接问我，比如「帮我安排一个每天 10 分钟的 A2 计划」。也可以点上面的快捷选项。</p></div></div>`}
      ${assistantPending ? `<div class="msg ava" id="assistant-typing" role="status" aria-label="正在等待 Ava 回复"><span class="msg-avatar">${icon('spark')}</span><div class="msg-bubble"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></div></div>` : ''}
    </div>
    <form class="assistant-inputbar" id="assistant-form" autocomplete="off">
      <input type="text" id="assistant-input" class="input" placeholder="告诉 Ava 你想做什么…" maxlength="500" aria-label="给 Ava 发消息">
      <button type="submit" class="send-btn" aria-label="${assistantPending ? '正在等待 Ava 回复' : '发送'}"${assistantPending ? ' disabled' : ''}>${icon('send')}</button>
    </form>
      </div>
    </div>`
  host.dataset.renderKey = renderKey
  assistantRenderKey = renderKey
  bindAssistant(host)
  // 空输入也恢复焦点，等待回复时可继续写下一条；保留选区两端。
  if (prevInput) {
    const nextInput = document.getElementById('assistant-input')
    if (nextInput) {
      nextInput.value = prevValue
      if (prevSelection != null) {
        try {
          nextInput.setSelectionRange(prevSelection, prevSelectionEnd)
        } catch {
          /* 忽略 */
        }
      }
      if (prevFocused && M.tab === 'assistant') {
        try {
          nextInput.focus({ preventScroll: true })
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  // 只在消息区内部滚到底（不再 scrollIntoView 整页/输入条）
  scrollAssistantBottom()
  return true
}

/**
 * 助手消息滚动：优先只滚 #assistant-thread 内部；
 * 该元素自身不可滚动（如 430 宽高度自适应）时才滚助手屏内部，避免带动 tabbar / 输入条跳动。
 */
function scrollAssistantBottom() {
  const thread = $('#assistant-thread')
  if (!thread) return
  if (thread.scrollHeight - thread.clientHeight > 2) {
    thread.scrollTop = thread.scrollHeight
    return
  }
  const screen = $('#screen-assistant')
  if (screen && screen.scrollHeight - screen.clientHeight > 2) {
    screen.scrollTop = screen.scrollHeight
  }
}

function bindAssistant(host) {
  const form = $('#assistant-form', host)
  const input = $('#assistant-input', host)
  if (form && input) {
    form.onsubmit = (event) => {
      event.preventDefault()
      if (assistantPending) return
      const value = input.value.trim()
      if (!value) return
      input.value = ''
      void sendAssistant(value)
    }
  }
  host.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'open-kb') {
      if (typeof ui.openKbPanel === 'function') ui.openKbPanel()
      return
    }
    if (act === 'open-library') {
      openLibrarySheet()
      return
    }
    if (act === 'chip') {
      if (assistantPending) return
      const message = target.getAttribute('data-msg') || target.textContent || ''
      void sendAssistant(message)
    }
  }
}

function pushThread(role, content) {
  M.assistantThread.push({ role, content })
  if (M.assistantThread.length > 40) M.assistantThread.splice(0, M.assistantThread.length - 40)
}

async function sendAssistant(message) {
  if (assistantPending) return false
  message = String(message || '').trim()
  if (!message) return false
  const requestId = ++assistantRequestId
  assistantPending = true
  pushThread('user', message)
  renderAssistant()
  let res = null
  try {
    try {
      res = await assistantChat(message)
    } catch {
      // 与 core 的网络失败结果保持一致，允许本地说明兜底。
    }
    if (requestId !== assistantRequestId) return false
    if (!res || res.ok === false) res = localAssistant(message)
    const reply = (res && res.reply) || '我在的。刚才没有听懂你的需求，可以换个说法再告诉我吗？'
    pushThread('assistant', String(reply))
    if (res && res.plan) saveLocalPlan(res.plan)
  } finally {
    if (requestId === assistantRequestId) {
      assistantPending = false
      renderAssistant()
    }
  }
  const actions = res && Array.isArray(res.actions) ? res.actions : []
  await applyAssistantActions(actions, res, requestId)
  return true
}

function canApplyAssistantNavigation(requestId) {
  if (requestId !== assistantRequestId || M.tab !== 'assistant') return false
  const classes = document.body && document.body.classList
  return !classes || !['kb-open', 'sheet-open', 'call-open'].some((name) => classes.contains(name))
}

async function applyAssistantActions(actions, res, requestId) {
  for (const action of actions) {
    if (requestId !== assistantRequestId) return
    const type = action && action.type
    const payload = (action && action.payload) || {}
    if (type === 'create_plan' || type === 'update_plan') {
      const plan = payload && payload.stages ? payload : res && res.plan
      if (plan && plan.stages) {
        saveLocalPlan(plan)
        // 保持当前「助手」页，不自动跳走；用户想查看时自己切到「课程」
        await refreshCourses()
        if (requestId !== assistantRequestId) return
        const generating = !!(res && res.plan && res.plan.generating) || !!plan.generating
        toast(
          generating
            ? '计划已生成，正在后台生成课件；留在助手页即可，完成后可切到「课程」查看'
            : '计划已生成；可切到底部「课程」查看并开始第一课',
          'ok',
          4200,
        )
      }
    } else if (!canApplyAssistantNavigation(requestId)) {
      // 回复仍留在线程里；用户已经开始其他任务时，不替他们切页或打开弹窗。
      continue
    } else if (type === 'open_scene') {
      // v3.1：全局去场景——自由聊天直接打开通话页（忽略 sceneId）
      ui.openCall(characterById(payload.characterId || 'elena'))
    } else if (type === 'open_tab') {
      // v2.8：Tab 收敛为 课程/对话/助手/复习/我的；旧数据里的 play 兼容跳转到复习（小游戏已并入）
      const rawTab = payload.tab === 'play' ? 'review' : payload.tab
      const tab = ['courses', 'chat', 'assistant', 'review', 'profile'].includes(rawTab) ? rawTab : 'courses'
      ui.switchTab(tab)
    } else if (type === 'review_words') {
      void showWordbookSheet()
    }
  }
}

/** 规则版助手（后端未就绪 / 失败时兜底）。 */
function localAssistant(message) {
  const text = String(message || '')
  const level = (M.settings && M.settings.level) || 'A2'
  const makePlan = /计划|plan|安排|目标/i.test(text)
  const updatePlan = /更新|调整|改.*计划/i.test(text)
  const review = /复习|单词|vocab|word/i.test(text)
  const scene = /场景|练习|练几句|scene/i.test(text)
  const pref = /偏好|等级|难度|level/i.test(text)
  const feedback = /反馈|建议|feedback/i.test(text)
  const actions = []
  const lines = []
  if ((makePlan || updatePlan) && !review) {
    // v3.1：课件必须由后端 AI 生成；本地兜底不伪造计划，避免课程页出现"假计划"
    lines.push('我现在连不上计划生成服务，稍后再试一次。')
    lines.push('也可以先去「对话」找 Elena 或 Maya 自由聊天，等功能恢复我再帮你排 3 节课。')
    void level
  } else if (review) {
    actions.push({ type: 'review_words' })
    lines.push('好，帮你打开今天的单词表，挑几个词复习一下。')
  } else if (scene) {
    const char = characterById('maya')
    actions.push({ type: 'open_scene', payload: { characterId: 'maya' } })
    lines.push(`走，和 ${char.name} 自由聊几句，通话页已经帮你打开了，想到什么说什么。`)
  } else if (pref) {
    actions.push({ type: 'open_tab', payload: { tab: 'profile' } })
    lines.push('学习偏好可以在「我的」里调整等级和语音引擎，我帮你跳过去了。')
  } else if (feedback) {
    lines.push('谢谢你！可以把具体的问题告诉本地开发者；如果你想要更自然的对话，也可以在设置里填入豆包凭据。')
  } else {
    lines.push('我在。你可以让我：帮你定制学习计划、陪你自由聊天、复习今天的单词，或者告诉我想练什么主题。')
    lines.push('比如直接说：「帮我安排一个 A2 口语计划」。')
  }
  return { ok: true, demo: true, reply: lines.join('\n'), actions, plan: M.plan }
}

/* ==========================================================================
   我的页
   ========================================================================== */
export function renderProfile() {
  const host = $('#screen-profile')
  if (!host) return
  const settings = M.settings || {}
  const progress = M.progress || {}
  const book = M.wordbook
  const todayWords = (() => {
    const days = book && Array.isArray(book.days) ? book.days : []
    const day = days.find((d) => String(d.label || '') === '今天') || days[0]
    return Number(day && day.count) || 0
  })()
  const mastered = Number(progress.masteredWords) || 0
  const streak = Number(progress.streak) || 0
  const turns = Number(progress.totalTurns) || 0
  const voiceConfigured = !!(settings.volc && settings.volc.configured)
  const realtimeConfigured = settings.voiceEngine === 'volc' && voiceConfigured
  const engine = realtimeConfigured ? '豆包实时语音' : '浏览器语音识别'
  const levels = ['A1', 'A2', 'B1', 'B2', 'C1']
  host.innerHTML = `
    <div class="profile-page">
      <div class="profile-head">
        <div>
          <div class="m-eyebrow">Me</div>
          <h1 class="m-title">我的</h1>
          <p class="profile-lead">个人资料、学习偏好与本地数据</p>
        </div>
        <span class="profile-local"><i></i>学习记录保存在本机</span>
      </div>

      <section class="profile-hero-card">
        <div class="ph-id">
          <span class="profile-avatar" id="profile-avatar">${esc(String(M.nickname || '学').slice(0, 1))}</span>
          <div class="ph-meta">
            <div class="ph-name">${esc(M.nickname || '英语学习者')}
              <button type="button" class="icon-btn ph-edit" data-act="edit-nick" aria-label="编辑昵称">${icon('spark')}</button>
            </div>
            <div class="ph-sub">正在学习 · ${esc(settings.level || 'A2')} · 英语会话</div>
            <div class="ph-tags">
              <span>老师 ${esc(settings.teacherName || 'Ava')}</span>
              <span>${esc(engine)}</span>
            </div>
          </div>
        </div>
        <div class="ph-stats">
          <div class="ph-stat"><strong data-profile-stat="streak">${esc(streak)}</strong><span>连续天数</span></div>
          <div class="ph-stat"><strong data-profile-stat="turns">${esc(turns)}</strong><span>累计开口</span></div>
          <div class="ph-stat"><strong data-profile-stat="today">${esc(todayWords)}</strong><span>今日生词</span></div>
        </div>
      </section>

      <div class="profile-columns">
        <section class="p-block">
          <div class="p-block-head">
            <span class="p-block-icon">${icon('user')}</span>
            <div><h2>学习设置</h2><p>影响对话用词、语速与朗读音色</p></div>
          </div>
          <div class="list-card">
            <div class="list-row">
              <span class="list-icon">${icon('spark')}</span>
              <div class="list-main"><div class="list-title">英语等级</div><div class="list-sub">影响 Ava 的用词与语速</div></div>
              <select class="level-select" id="profile-level" aria-label="英语等级">
                ${levels.map((lv) => `<option value="${lv}" ${lv === (settings.level || 'A2') ? 'selected' : ''}>${lv}</option>`).join('')}
              </select>
            </div>
            <div class="list-row">
              <span class="list-icon">${icon('volume')}</span>
              <div class="list-main"><div class="list-title">语音输入</div><div class="list-sub">${realtimeConfigured ? '已配置，连接情况以通话中的麦克风检测为准' : '识别可用性取决于浏览器，也可以用文字输入'}</div></div>
              <span class="list-value">${esc(engine)}</span>
            </div>
            <div class="list-row">
              <span class="list-icon">${icon('volume')}</span>
              <div class="list-main"><div class="list-title">角色朗读</div><div class="list-sub">${voiceConfigured ? '角色朗读还需 API Key 和独立 TTS 权限，点读时验证' : '请先配置豆包 API Key 和 TTS 权限；系统内置朗读已关闭'}</div></div>
              <span class="list-value">${voiceConfigured ? '语音凭据已填写' : '未配置'}</span>
            </div>
            <a class="list-row" href="/?settings=1" aria-label="打开模型与语音设置">
              <span class="list-icon">${icon('spark')}</span>
              <div class="list-main"><div class="list-title">模型与语音设置</div><div class="list-sub">配置 AI 模型和豆包凭据，保存后返回主界面</div></div>
              <span class="list-value">${icon('chevron')}</span>
            </a>
            ${globalThis.Capacitor?.isNativePlatform?.() ? `<button type="button" class="list-row" data-ava-connection>
              <span class="list-icon">${icon('spark')}</span>
              <div class="list-main"><div class="list-title">服务连接</div><div class="list-sub">检查或更新学习空间的连接</div></div>
              <span class="list-value">${icon('chevron')}</span>
            </button>` : ''}
            <button type="button" class="list-row" data-act="wordbook">
              <span class="list-icon">${icon('book')}</span>
              <div class="list-main"><div class="list-title">今日单词表</div><div class="list-sub">重点单词自动收录，随时复习</div></div>
              <span class="list-value"><span data-profile-wordbook-count>${esc(todayWords)}</span> 个${icon('chevron')}</span>
            </button>
            <button type="button" class="list-row" data-act="mastered">
              <span class="list-icon">${icon('star')}</span>
              <div class="list-main"><div class="list-title">已掌握单词</div><div class="list-sub">间隔复习达到更高记忆盒</div></div>
              <span class="list-value"><span data-profile-stat="mastered">${esc(mastered)}</span> 个${icon('chevron')}</span>
            </button>
          </div>
        </section>

        <div class="p-side">
          <section class="p-block">
            <div class="p-block-head">
              <span class="p-block-icon accent">${icon('spark')}</span>
              <div><h2>兴趣标签</h2><p>让话题更贴近你的兴趣</p></div>
            </div>
            <div class="interest-card" id="interest-card">
              <div class="interest-tags" id="interest-tags">${profileInterestTags()}</div>
              <form class="interest-form" id="interest-form" autocomplete="off">
                <input type="text" class="input" id="interest-input" maxlength="20" placeholder="添加兴趣，如：科幻小说 / 咖啡 / 城市建筑" aria-label="添加兴趣">
                <button type="submit" class="btn btn-primary btn-sm">${icon('spark')}添加</button>
              </form>
              <p class="interest-hint">Ava 会参考这些兴趣选择话题；启用云模型时，相关兴趣可能随对话发送。</p>
            </div>
          </section>

          <section class="p-block p-plus">
            <div class="p-block-head">
              <span class="p-block-icon warm">${icon('star')}</span>
              <div><h2>个人学习空间</h2><p>了解本机记录、模型配置与演示模式</p></div>
              <span class="m-chip" style="margin-left:auto">${M.settings ? (settings.hasKey ? '已填写模型凭据' : '演示模式') : '配置待确认'}</span>
            </div>
            <p class="p-plus-desc">学习记录保存在本机。启用云 AI 时，相关文本、资料或音频会发送到你配置的服务商。</p>
            <button type="button" class="btn btn-ghost btn-sm" data-act="usage-help">查看使用说明</button>
          </section>
        </div>
      </div>

      <div class="profile-note">Ava · 个人英语学习空间 · 学习记录保存在本机</div>
    </div>`

  bindProfile(host)
}

function bindProfile(host) {
  host.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'edit-nick') editNickname()
    else if (act === 'wordbook') void showWordbookSheet()
    else if (act === 'usage-help') showUsageHelp()
    else if (act === 'mastered') toast(`已掌握 ${Number((M.progress || {}).masteredWords) || 0} 个单词`, 'ok')
    else if (act === 'del-interest') {
      const tag = target.getAttribute('data-tag') || ''
      const next = currentInterests().filter((item) => item !== tag)
      void saveInterests(next)
    }
  }
  const interestForm = $('#interest-form', host)
  if (interestForm) {
    interestForm.onsubmit = (event) => {
      event.preventDefault()
      const input = $('#interest-input', host)
      const value = input && input.value.trim()
      if (!value) return
      const next = [...currentInterests(), value]
      if (input) input.value = ''
      void saveInterests(next)
    }
  }
  const level = $('#profile-level', host)
  if (level) {
    level.onchange = async () => {
      const value = level.value
      const previousValue = (M.settings && M.settings.level) || 'A2'
      level.disabled = true
      try {
        const saved = await saveSettings({ level: value })
        if (!saved || saved.ok === false) throw new Error((saved && saved.error) || '难度保存失败，请稍后重试')
        const savedValue = saved.level || value
        M.settings = { ...(M.settings || {}), level: savedValue }
        if (saved.plan && typeof saved.plan === 'object') saveLocalPlan(saved.plan)
        level.value = savedValue
        const lessonError = !!(saved.plan && saved.plan.hasError)
        toast(saved.message || (lessonError ? '难度已保存，但课件更新未完成，请重试' : `已切换到 ${savedValue} 难度`), lessonError ? 'info' : 'ok', lessonError ? 4200 : 2600)
        renderCourses()
      } catch (err) {
        if (M.settings) M.settings.level = previousValue
        level.value = previousValue
        toast((err && err.message) || '难度保存失败，请稍后重试', 'bad', 3200)
      } finally {
        level.disabled = false
      }
    }
  }
}

/** 当前兴趣标签列表。 */
function currentInterests() {
  const profile = M.profile
  const list = profile && Array.isArray(profile.interests) ? profile.interests : []
  return list.map((tag) => String(tag || '').trim()).filter(Boolean)
}

function profileInterestTags() {
  return currentInterests().map((tag) => `<span class="interest-tag">${esc(tag)}<button type="button" data-act="del-interest" data-tag="${esc(tag)}" aria-label="删除兴趣 ${esc(tag)}">×</button></span>`).join('') || '<span class="interest-empty">还没有兴趣标签，添加几个让 Ava 更懂你。</span>'
}

function showUsageHelp() {
  const mode = !M.settings
    ? '模型配置尚未读取，请打开“模型与语音设置”确认。'
    : M.settings.hasKey
      ? '已填写文字模型凭据，实际可用性以请求结果为准。'
      : '当前为文字演示模式：未配置文字模型时，部分对话和总结使用规则示例，不能作为真实模型效果。'
  ui.openSheet('使用说明', `<div class="kb-confirm">
    <p><strong>当前模式</strong><br>${esc(mode)}</p>
    <p><strong>学习记录</strong><br>记录保存在运行 Ava 的这台电脑；昵称与书库进度保存在当前浏览器。更换浏览器不会自动同步。</p>
    <p><strong>配置自己的 AI 服务</strong><br>在“我的 → 模型与语音设置”填写自己的凭据。文字模型、实时语音与角色朗读需要相应服务权限，调用费用由你配置的服务商计收。</p>
    <p><strong>云服务请求</strong><br>启用云 AI 后，相关聊天文字、资料片段、兴趣或音频会发送到所配置的服务商。</p>
  </div>`)
}

/** 后台结果只更新数据区域，保留正在编辑的输入、光标和保存按钮状态。 */
function updateProfileSummary() {
  const host = $('#screen-profile')
  if (!host) return
  if (!host.querySelector('.profile-page')) {
    renderProfile()
    return
  }
  const progress = M.progress || {}
  const days = M.wordbook && Array.isArray(M.wordbook.days) ? M.wordbook.days : []
  const day = days.find((item) => String(item.label || '') === '今天') || days[0]
  const values = {
    streak: Number(progress.streak) || 0,
    turns: Number(progress.totalTurns) || 0,
    today: Number(day && day.count) || 0,
    mastered: Number(progress.masteredWords) || 0,
  }
  Object.entries(values).forEach(([key, value]) => {
    const el = $(`[data-profile-stat="${key}"]`, host)
    if (el) el.textContent = String(value)
  })
  const wordbookCount = $('[data-profile-wordbook-count]', host)
  if (wordbookCount) wordbookCount.textContent = String(values.today)
  const tags = $('#interest-tags', host)
  const tagsHtml = profileInterestTags()
  if (tags && tags.innerHTML !== tagsHtml) tags.innerHTML = tagsHtml
}

/** 保存兴趣标签（PUT /api/profile），中文反馈。 */
async function saveInterests(next) {
  const dedup = [...new Set(next.map((tag) => String(tag || '').trim()).filter(Boolean))].slice(0, 20)
  const res = await saveProfile({ interests: dedup })
  if (!res || res.ok === false) {
    toast((res && res.error) || '兴趣保存失败，请稍后重试', 'bad', 3200)
    return
  }
  const saved = res.profile && Array.isArray(res.profile.interests) ? res.profile.interests.map(String) : dedup
  M.profile = { ...(M.profile || {}), interests: saved }
  toast('兴趣已保存', 'ok', 2200)
  if (M.tab === 'profile') updateProfileSummary()
}

async function editNickname() {
  ui.openSheet(
    '编辑昵称',
    `<div style="display:flex;flex-direction:column;gap:10px">
      <input type="text" class="level-select" id="nick-input" style="width:100%;padding:11px 12px;font-size:14px;border-radius:12px" maxlength="16" value="${esc(M.nickname || '')}">
      <button type="button" class="btn btn-primary btn-block" id="nick-save">保存</button>
    </div>`,
  )
  const input = $('#nick-input')
  const save = $('#nick-save')
  if (input) {
    input.focus()
    input.select()
  }
  if (save) {
    save.onclick = () => {
      const value = (input && input.value.trim()) || '英语学习者'
      M.nickname = value
      try {
        localStorage.setItem('ava.mobile.nickname', value)
      } catch {
        /* 忽略 */
      }
      ui.closeSheet()
      renderProfile()
      toast('昵称已更新', 'ok')
    }
  }
}

/** 我的页异步刷新统计（进入页面时调用）。 */
export async function refreshProfileStats() {
  await Promise.all([loadWordbook(), loadProgress(), loadProfile()])
  if (M.tab === 'profile') updateProfileSummary()
}

/* ==========================================================================
   屏幕刷新入口
   ========================================================================== */
export function renderTab(tab) {
  if (tab === 'courses') renderCourses()
  else if (tab === 'chat') renderChat()
  else if (tab === 'assistant') renderAssistant()
  else if (tab === 'review') renderReview()
  else if (tab === 'profile') renderProfile()
}

export { sleep, $$, toast }
