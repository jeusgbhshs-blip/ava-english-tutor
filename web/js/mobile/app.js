/**
 * Ava 手机版 · 入口
 * 启动流程：并行加载数据 → 注册 ui 回调 → 绑定外壳交互（Tab / sheet / 返回键 / 通话）
 *            → 首次渲染课程页 → 暴露 window.__avaMobile 供 QA / CDP 调试。
 * @module mobile/app
 */
import {
  $, M, ui, toast, icon, characterById, loadCharacters, loadPlan, loadSettings, loadContent,
  loadProgress, loadWordbook, showWordbookSheet,
} from './core.js'
import { renderTab, refreshCourses, refreshProfileStats } from './screens.js'
import { setBrowserTTSEnabled } from '../speech.js'
import { openKbPanel, closeKbPanel, isKbOpen, kbState } from './kb.js'
import { openCall, onSheetClosed, getCallState, previewSpeaking, togglePtt, cancelPtt, simulateTranscript, micDiagnostics } from './call.js'
import {
  initReview, onReviewTabEnter, onReviewTabLeave, reviewHandleBack, reviewDebug, getReviewState, updateBadge as updateReviewBadge,
} from './review.js'

const TABS = ['courses', 'chat', 'assistant', 'review', 'profile']

// v3.8：手机版关闭浏览器内置语音，只用豆包角色原声（用户要求）
setBrowserTTSEnabled(false)
const VERSION = 'v3.3'

/* ------------------------------ 运行期状态 ------------------------------ */
let booted = false
let sheetOpen = false
const errors = []

/* ------------------------------ 错误收集（供 QA 探测） ------------------------------ */
window.__avaErrors = errors
function recordError(message) {
  errors.push(String(message == null ? '' : message).slice(0, 400))
  if (errors.length > 24) errors.shift()
}
window.addEventListener('error', (event) => {
  recordError((event && event.message) || (event && event.error && event.error.message) || 'unknown error')
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason
  recordError('unhandledrejection: ' + ((reason && (reason.message || reason)) || ''))
})

/* ------------------------------ 全屏人物世界（v1.7） ------------------------------ */
const world = { a: null, b: null, active: 0, src: '' }

function initWorld() {
  world.a = $('#world-img-a')
  world.b = $('#world-img-b')
  document.documentElement.style.setProperty('--theme', '#6ff2dd')
  spawnParticles($('#world-particles'), 26)
  spawnParticles($('#call-particles'), 18)
}

function spawnParticles(host, count) {
  if (!host) return
  if (host.childElementCount) return
  const colors = null
  for (let i = 0; i < count; i++) {
    const bit = document.createElement('i')
    bit.style.left = (Math.random() * 100).toFixed(2) + '%'
    bit.style.animationDuration = (9 + Math.random() * 14).toFixed(2) + 's'
    bit.style.animationDelay = (-Math.random() * 18).toFixed(2) + 's'
    const size = 2 + Math.random() * 3
    bit.style.width = size.toFixed(1) + 'px'
    bit.style.height = size.toFixed(1) + 'px'
    bit.style.opacity = '0'
    host.appendChild(bit)
  }
  void colors
}

/** 切换整屏人物背景（双图层淡入淡出 + 主题色） */
function setWorld(character, opts = {}) {
  if (!character || !world.a || !world.b) return
  const src = character.cover || '/assets/characters/' + character.id + '.jpg'
  const theme = character.themeColor || '#6ff2dd'
  document.documentElement.style.setProperty('--theme', theme)
  document.body.dataset.char = character.id
  if (world.src !== src) {
    const current = world.active === 0 ? world.a : world.b
    const next = world.active === 0 ? world.b : world.a
    world.src = src
    const reveal = () => {
      next.classList.add('is-on')
      current.classList.remove('is-on')
      world.active = world.active === 0 ? 1 : 0
    }
    next.onload = reveal
    next.onerror = () => {
      next.onerror = null
      const svg = '/assets/characters/' + character.id + '.svg'
      if (next.getAttribute('src') !== svg) next.src = svg
      else reveal()
    }
    next.src = src
    if (opts.instant) reveal()
  }
  const tint = $('#world-tint')
  if (tint) tint.style.setProperty('--theme', theme)
}

/* ------------------------------ 历史记录（手机返回键） ------------------------------ */
function pushOverlay(kind) {
  try {
    if (history.state && history.state.ava === kind) return
    history.pushState({ ava: kind }, '')
  } catch {
    /* 无痕模式等忽略 */
  }
}

function clearOverlayHistory() {
  try {
    if (history.state && history.state.ava) history.replaceState(null, '')
  } catch {
    /* 忽略 */
  }
}

function onBackKey() {
  if (sheetOpen) {
    hideSheet()
    notifySheetClosed()
    return true
  }
  if (isKbOpen()) {
    hideKbPanel()
    return true
  }
  const call = getCallState()
  if (call.open) {
    const back = $('#call-back')
    if (back) {
      back.click()
      setTimeout(() => {
        if (!getCallState().open) clearOverlayHistory()
      }, 60)
    }
    return true
  }
  // v2.7：复习子视图（复习会话/词库管理/小游戏）→ 先回复习首页
  if (reviewHandleBack()) return true
  return false
}

window.addEventListener('popstate', () => {
  // 浏览器返回：优先关弹层，其次退出通话页；都不在时不拦截（正常离开页面）
  const handled = onBackKey()
  if (handled) {
    // 弹层/通话关闭后清掉我们压入的历史标记，避免下次多按一次返回
    setTimeout(() => {
      if (!sheetOpen && !getCallState().open) clearOverlayHistory()
    }, 90)
  }
})

/* ------------------------------ Tab 切换 ------------------------------ */
/** v3.3：各 Tab 的滚动位置记忆（离开时保存、回来时恢复，避免每次跳回顶部）。 */
const screenScrollPositions = new Map()

/** 恢复某 Tab 滚动位置（限制在有效范围内，避免异步重渲染后越界）。 */
function restoreScreenScroll(name, value) {
  const screen = document.getElementById('screen-' + name)
  if (!screen) return
  const max = Math.max(0, screen.scrollHeight - screen.clientHeight)
  screen.scrollTop = Math.max(0, Math.min(Number(value) || 0, max))
}

export function switchTab(tab, opts = {}) {
  const prev = M.tab
  const next = TABS.includes(tab) ? tab : 'courses'
  const sameTab = prev === next
  if (isKbOpen()) hideKbPanel()
  if (prev === 'review' && next !== 'review') onReviewTabLeave()
  // v3.3：离开前记住当前 Tab 的滚动位置
  if (!sameTab) {
    const prevScreen = document.getElementById('screen-' + prev)
    if (prevScreen) screenScrollPositions.set(prev, prevScreen.scrollTop)
  }
  M.tab = next
  const tabbar = $('#tabbar')
  if (tabbar) {
    Array.from(tabbar.querySelectorAll('[data-tab]')).forEach((btn) => {
      const on = btn.getAttribute('data-tab') === next
      btn.classList.toggle('is-active', on)
      btn.setAttribute('aria-selected', on ? 'true' : 'false')
      btn.tabIndex = on ? 0 : -1
    })
  }
  let restoreScroll = 0
  TABS.forEach((name) => {
    const screen = document.getElementById('screen-' + name)
    if (!screen) return
    const on = name === next
    screen.hidden = !on
    screen.classList.toggle('is-active', on)
    if (!on) return
    // v3.4：所有页面切换都不播放入场动画。
    // 原因：transform/opacity 动画会改变子元素 backdrop-filter 的背面采样，
    // 导致毛玻璃在切换 Tab 时忽明忽暗/效果不一致。
    screen.style.animation = 'none'
    screen.dataset.seen = '1'
    if (!opts.keepScroll) {
      restoreScroll = sameTab ? screen.scrollTop : screenScrollPositions.get(name) || 0
    }
  })
  const activeCharacter = characterById(M.activeCharId)
  if (activeCharacter) setWorld(activeCharacter)
  if (typeof renderTab === 'function') {
    try {
      renderTab(next)
    } catch (err) {
      console.error('[mobile] 页面渲染失败：', err)
      toast('页面渲染失败，请刷新重试', 'bad', 3200)
    }
  }
  // v3.3：渲染后恢复滚动位置（助手页复用 DOM，不会跳；其它 Tab 即使重渲染也不回顶部）
  if (!opts.keepScroll) restoreScreenScroll(next, restoreScroll)
  if (next === 'profile') {
    void refreshProfileStats().catch(() => {})
  }
  // v3.0：切回「课程」Tab 时拉取最新计划（课堂完成 / 助手改计划后进度、解锁状态同步）
  if (next === 'courses') {
    void refreshCourses().catch((err) => {
      console.warn('[mobile] 课程页刷新失败：', err)
    })
  }
  // v2.7：进入「复习」Tab 时刷新概览并触发每日提醒（徽标同步）
  if (next === 'review') {
    void onReviewTabEnter()
  }
  return next
}

/* ------------------------------ 弹层 ------------------------------ */
export function openSheet(title, html) {
  const sheet = $('#sheet')
  const backdrop = $('#sheet-backdrop')
  const body = $('#sheet-body')
  const titleEl = $('#sheet-title')
  if (!sheet || !backdrop) return
  if (titleEl) titleEl.textContent = title || '提示'
  if (body) body.innerHTML = html == null ? '' : String(html)
  sheet.hidden = false
  backdrop.hidden = false
  sheetOpen = true
  document.body.classList.add('sheet-open')
  pushOverlay('sheet')
}

function hideSheet() {
  const sheet = $('#sheet')
  const backdrop = $('#sheet-backdrop')
  if (sheet) sheet.hidden = true
  if (backdrop) backdrop.hidden = true
  sheetOpen = false
  document.body.classList.remove('sheet-open')
}

/** 关闭弹层并通知 call.js（通话总结关闭后结束通话）。 */
export function closeSheet() {
  if (!sheetOpen) {
    hideSheet()
    return
  }
  hideSheet()
  clearOverlayHistory()
  notifySheetClosed()
}

function notifySheetClosed() {
  // 放到当前调用栈之后：call.js 的「再聊一会」会先同步把 endAfterSheet 置 false
  setTimeout(() => {
    try {
      onSheetClosed()
    } catch (err) {
      console.error('[mobile] sheet 关闭回调失败：', err)
    }
    if (!getCallState().open) clearOverlayHistory()
  }, 40)
}

/* ------------------------------ 知识库面板（v1.8） ------------------------------ */
function showKbPanel() {
  if (getCallState().open) {
    toast('通话中无法打开知识库，请先结束通话', 'info', 2400)
    return
  }
  if (sheetOpen) closeSheet()
  pushOverlay('kb')
  openKbPanel()
}

function hideKbPanel() {
  if (!isKbOpen()) return
  closeKbPanel()
  if (history.state && history.state.ava === 'kb') clearOverlayHistory()
}

/* ------------------------------ 通话入口 ------------------------------ */
async function startCall(characterOrId, sceneIdx = 0, opts = {}) {
  if (sheetOpen) closeSheet()
  if (isKbOpen()) hideKbPanel()
  const wasOpen = getCallState().open
  if (!wasOpen) pushOverlay('call')
  try {
    const ok = await openCall(characterOrId, sceneIdx, opts)
    if (ok === false) {
      if (!getCallState().open) clearOverlayHistory()
      return false
    }
    return true
  } catch (err) {
    console.error('[mobile] 打开通话页失败：', err)
    toast('打开通话失败，请稍后再试', 'bad', 3200)
    if (!getCallState().open) clearOverlayHistory()
    return false
  }
}

/* ------------------------------ 外壳事件绑定 ------------------------------ */
function bindChrome() {
  const tabbar = $('#tabbar')
  if (tabbar) {
    tabbar.addEventListener('click', (event) => {
      const btn = event.target instanceof Element ? event.target.closest('[data-tab]') : null
      if (!btn) return
      switchTab(btn.getAttribute('data-tab') || 'courses')
    })
    tabbar.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const idx = TABS.indexOf(M.tab)
      const delta = event.key === 'ArrowRight' ? 1 : -1
      const next = TABS[(idx + delta + TABS.length) % TABS.length]
      switchTab(next)
      const btn = tabbar.querySelector(`[data-tab="${next}"]`)
      if (btn) btn.focus()
    })
  }

  const sheetClose = $('#sheet-close')
  if (sheetClose) sheetClose.addEventListener('click', () => closeSheet())
  const backdrop = $('#sheet-backdrop')
  if (backdrop) backdrop.addEventListener('click', () => closeSheet())

  // 通话页返回 / 挂断：清理历史记录（通话真正的关闭由 call.js 负责）
  const callBack = $('#call-back')
  if (callBack) {
    callBack.addEventListener('click', () => {
      setTimeout(() => {
        if (!getCallState().open) clearOverlayHistory()
      }, 60)
    })
  }
  const callHangup = $('#call-hangup')
  if (callHangup) {
    callHangup.addEventListener('click', () => {
      // 挂断会打开总结弹层，弹层仍属于通话流程，标记保留
      setTimeout(() => {
        if (!getCallState().open && !sheetOpen) clearOverlayHistory()
      }, 80)
    })
  }

  document.addEventListener('keydown', (event) => {
    const tag = event.target && event.target.tagName
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (event.target && event.target.isContentEditable)
    // v2.2：通话页 PTT——空格开始/结束，Esc 取消录音（输入框聚焦时不拦截）
    if (!typing && getCallState().open && !sheetOpen) {
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault()
        togglePtt()
        return
      }
      if (event.key === 'Escape' && (getCallState().ptt === 'recording' || getCallState().ptt === 'submitting' || getCallState().ptt === 'connecting')) {
        event.preventDefault()
        cancelPtt()
        return
      }
    }
    // v2.8：键盘 1-5 切换游戏 HUD 页面（4 = 复习，小游戏统一收敛到复习页）
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && /^[1-5]$/.test(event.key)) {
      if (sheetOpen || getCallState().open) return
      event.preventDefault()
      switchTab(TABS[Number(event.key) - 1])
      return
    }
    if (event.key !== 'Escape') return
    if (sheetOpen) {
      event.preventDefault()
      closeSheet()
    } else if (getCallState().open || isKbOpen()) {
      event.preventDefault()
      onBackKey()
    } else if (reviewHandleBack()) {
      // v2.7：复习会话/词库管理/小游戏按 Esc 回复习首页
      event.preventDefault()
    }
  })
}

/* ------------------------------ 角色切换（首页全屏人物） ------------------------------ */
function setCharacter(id) {
  const character = characterById(id)
  if (!character) return null
  M.activeCharId = character.id
  setWorld(character)
  if (M.tab === 'chat') {
    try {
      renderTab('chat')
    } catch (err) {
      console.error('[mobile] 切换角色失败：', err)
    }
  }
  return character
}

/* ------------------------------ ui 注册表 ------------------------------ */
function registerUi() {
  Object.assign(ui, {
    switchTab,
    openCall: (characterOrId, sceneIdx, opts) => startCall(characterOrId, sceneIdx, opts),
    openKbPanel: showKbPanel,
    closeKbPanel: hideKbPanel,
    openSheet,
    closeSheet,
    openWordbookSheet: () => showWordbookSheet(),
    setCharacter,
    setWorld: (character) => setWorld(character),
    refreshCourses: async () => {
      try {
        await refreshCourses()
      } catch (err) {
        console.warn('[mobile] 课程页刷新失败：', err)
      }
    },
    toast,
  })
}

/* ------------------------------ 首屏骨架 ------------------------------ */
function paintBootSkeleton() {
  const host = $('#screen-courses')
  if (!host) return
  host.hidden = false
  host.classList.add('is-active')
  host.innerHTML = `
    <div class="brand-row">
      <div class="brand">
        <span class="brand-orb">${icon('spark')}</span>
        <div><div class="brand-name">Ava 英语会话</div><div class="brand-tag">正在准备你的学习空间…</div></div>
      </div>
    </div>
    <div class="summary-loading" style="padding:56px 12px">
      <span class="spinner"></span>
      <div>正在连接本地 Ava 服务…</div>
    </div>`
}

/* ------------------------------ 数据加载 ------------------------------ */
async function loadInitialData() {
  const results = await Promise.allSettled([loadCharacters(), loadPlan(), loadSettings(), loadContent()])
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length) {
    console.warn('[mobile] 部分数据加载失败：', failed.map((r) => r.reason))
    toast('部分数据加载失败，已使用本地兜底内容', 'bad', 3600)
  }
  if (!M.settings) toast('读取学习设置失败，先使用默认设置', 'bad', 3200)
  if (!M.content) toast('词库加载失败，小游戏将使用内置词库', 'info', 3000)
  M.loaded = true
  // 我的页统计不阻塞首屏
  void Promise.allSettled([loadProgress(), loadWordbook()]).then(() => {
    if (M.tab === 'profile') {
      try {
        renderTab('profile')
      } catch {
        /* 忽略 */
      }
    }
  })
}

/* ------------------------------ 启动 ------------------------------ */
async function boot() {
  if (booted) return
  booted = true
  paintBootSkeleton()
  bindChrome()
  registerUi()
  try {
    await loadInitialData()
  } catch (err) {
    console.error('[mobile] 初始化失败：', err)
    toast('初始化遇到问题，已进入离线模式', 'bad', 3600)
  }
  initWorld()
  setWorld(characterById(M.activeCharId), { instant: true })
  switchTab('courses')
  const app = $('#app')
  if (app) app.setAttribute('data-ready', '1')
  exposeDebugApi()
  // v2.7：复习 Tab 数据（今日到期徽标 + 每日提醒，进入 /mobile 即检测一次）
  initReview()
}

/* ------------------------------ QA / CDP 调试接口 ------------------------------ */
function sendToActiveView(text) {
  const value = String(text == null ? '' : text).trim()
  if (!value) return false
  const call = getCallState()
  if (call.open) {
    const input = $('#call-text-input')
    const form = $('#call-textform')
    if (input && form) {
      input.value = value
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
      return true
    }
  }
  if (M.tab !== 'assistant') switchTab('assistant')
  const input = $('#assistant-input')
  const form = $('#assistant-form')
  if (input && form) {
    input.value = value
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    return true
  }
  return false
}

function exposeDebugApi() {
  window.__avaMobile = {
    version: VERSION,
    openCall: (characterOrId, sceneIdx, opts) => startCall(characterOrId, sceneIdx, opts),
    openKb: showKbPanel,
    closeKb: hideKbPanel,
    kb: kbState,
    switchTab,
    setCharacter,
    setWorld: (characterOrId) => {
      const ch = typeof characterOrId === 'string' ? characterById(characterOrId) : characterOrId
      if (ch) setWorld(ch)
      return ch
    },
    state: M,
    ui,
    getCallState,
    previewSpeaking,
    togglePtt,
    cancelPtt,
    simulateTranscript,
    micDiagnostics,
    openSheet,
    closeSheet,
    showWordbook: () => showWordbookSheet(),
    send: sendToActiveView,
    // v2.7 复习 Tab 调试接口（QA / CDP）：
    //   __avaMobile.review.startSession('due'|'extra'|'again') / openManage() / openGame(kind)
    //   __avaMobile.review.state() / flip() / grade('good'|'easy'|'hard'|'again') / back()
    review: reviewDebug(),
    getReviewState,
    refreshReviewBadge: updateReviewBadge,
    refresh: async () => {
      await Promise.allSettled([loadCharacters(), loadPlan(), loadSettings(), loadContent()])
      await refreshCourses()
      switchTab(M.tab, { keepScroll: true })
    },
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true })
} else {
  void boot()
}

export { startCall, boot }
