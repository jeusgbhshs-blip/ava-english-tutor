/** Personal call interaction regressions. No network, provider, microphone or browser process. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const noop = () => {}
const tick = () => new Promise((resolve) => setImmediate(resolve))
const source = (name) => readFileSync(new URL(`../web/js/${name}`, import.meta.url), 'utf8')

function moduleHarness(name, bindings, exposed, overrides = {}) {
  let code = source(name)
    .replace(/^import\s+[\s\S]*?\s+from\s+(['"])[^'"]+\1\s*;?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/^boot\(\)\.catch\(\(err\) => \{[\s\S]*?^\}\)\s*$/m, '')
    .replace("await import('../doubao-voice.js')", 'await __loadVoiceModule()')
  const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, ...bindings })
  vm.runInContext(`${code}\nthis.subject = { ${exposed} };`, context, { filename: name })
  const override = (next) => {
    context.__overrides = next
    for (const key of Object.keys(next)) vm.runInContext(`${key} = __overrides[${JSON.stringify(key)}]`, context)
  }
  override(overrides)
  return { ...context.subject, context, override }
}

function fakeDom() {
  const elements = new Map()
  const listeners = new Map()
  let document
  const make = (id = '', tag = 'BUTTON') => {
    const classes = new Set()
    const attrs = new Map()
    const events = new Map()
    const element = {
      id, tagName: tag, hidden: false, inert: false, disabled: false, isConnected: true, tabIndex: 0,
      value: '', textContent: '', innerHTML: '', dataset: {}, style: { setProperty: noop },
      classList: { add: (...names) => names.forEach((n) => classes.add(n)), remove: (...names) => names.forEach((n) => classes.delete(n)), contains: (n) => classes.has(n), toggle(n, on) { if (on ?? !classes.has(n)) classes.add(n); else classes.delete(n) } },
      setAttribute: (key, value) => attrs.set(key, String(value)), getAttribute: (key) => attrs.get(key) ?? null,
      removeAttribute: (key) => attrs.delete(key), hasAttribute: (key) => attrs.has(key),
      addEventListener: (type, handler) => events.set(type, handler), removeEventListener: noop,
      focus() { document.activeElement = element },
      closest: () => element.hidden || element.inert ? element : null,
      contains: (node) => node === element || element.children?.includes(node),
      querySelector: () => null, querySelectorAll: () => element.children || [],
      getClientRects: () => element.hidden ? [] : [{}],
      scrollIntoView: noop, appendChild: noop, events,
    }
    if (id) elements.set(id, element)
    return element
  }
  document = {
    body: make('body', 'BODY'), activeElement: null,
    addEventListener: (type, handler) => { const list = listeners.get(type) || []; list.push(handler); listeners.set(type, list) },
    querySelector: (selector) => elements.get(selector.replace(/^#/, '')) || null,
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [], createElement: () => make(),
  }
  document.activeElement = document.body
  return { document, make, elements, listeners, $: (selector) => document.querySelector(selector) }
}

function desktopHarness({ deferModule = false, failed = false } = {}) {
  const timers = []
  const seen = { browserStarts: 0, errors: [], starts: 0 }
  let settleStart
  let releaseModule
  const voice = {
    isSupported: true,
    start() { seen.starts++; return failed ? Promise.resolve(false) : new Promise((resolve) => { settleStart = resolve }) },
    stop() { settleStart?.(false) },
  }
  const h = moduleHarness('main.js', {
    ui: { $: () => null, $$: () => [], toast: (message) => seen.errors.push(message) },
    modes: { getMode: () => 'free' },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimeout: noop,
  }, 'A, D, beginVolcCall, stopVolcCall, doubaoCallbacks', {
    isVolcApplicable: () => true, volcConfigured: () => true,
    clearSpeech: noop, updateEnginePill: noop, renderCaption: noop, renderFeedbackPanel: noop,
    safeAvatar: noop, level: () => 'A2', teacherName: () => 'Ava',
    loadDoubaoModule: () => deferModule ? new Promise((resolve) => { releaseModule = resolve }) : Promise.resolve({}),
    ensureDoubaoInstance: () => voice,
    startListening: () => { seen.browserStarts++ },
  })
  h.override({ setPhase: (value) => { h.A.phase = value } })
  h.A.doubao = voice
  return { ...h, seen, timers, releaseModule: () => releaseModule({}) }
}

test('desktop: cancelling a pending voice start stays stopped and does not start browser fallback', async () => {
  const h = desktopHarness()
  const pending = h.beginVolcCall()
  await tick()
  h.stopVolcCall()
  assert.equal(await pending, false)
  for (const timer of h.timers) timer.fn()
  assert.equal(h.A.volcSession, false)
  assert.equal(h.A.volcFallback, false)
  assert.equal(h.seen.browserStarts, 0)
  assert.equal(h.seen.errors.length, 0)
})

test('desktop: cancellation while the module loads cannot start a late voice session', async () => {
  const h = desktopHarness({ deferModule: true })
  const pending = h.beginVolcCall()
  h.stopVolcCall()
  h.releaseModule()
  await tick()
  assert.equal(h.seen.starts, 0)
  assert.equal(await pending, false)
})

test('desktop: a real startup failure still reports the problem and preserves the existing fallback', async () => {
  const h = desktopHarness({ failed: true })
  assert.equal(await h.beginVolcCall(), false)
  assert.equal(h.A.volcFallback, true)
  assert.equal(h.seen.errors.length, 1)
  for (const timer of h.timers) timer.fn()
  assert.equal(h.seen.browserStarts, 1)
})

for (const kind of ['module', 'factory', 'unsupported']) {
  test(`desktop: ${kind} unavailable reports a recoverable error and clears connecting state`, async () => {
    const h = desktopHarness()
    if (kind === 'module') h.override({ loadDoubaoModule: async () => null })
    else h.override({ ensureDoubaoInstance: () => kind === 'factory' ? null : { isSupported: false } })
    assert.equal(await h.beginVolcCall(), false)
    assert.equal(h.A.volcSession, false)
    assert.equal(h.A.phase, 'idle')
    assert.equal(h.A.volcFallback, true)
    assert.equal(h.seen.errors.length, 1)
  })
}

test('desktop: space shortcut ignores repeat, modifiers and focused controls but accepts an ordinary page press', () => {
  let handler
  let toggles = 0
  class HTMLElement {
    constructor(tagName) { this.tagName = tagName }
    closest() { return /^(BUTTON|A)$/.test(this.tagName) ? this : null }
  }
  const code = source('main.js')
  const start = code.indexOf("document.addEventListener('keydown', (event) => {")
  const end = code.indexOf('\n  })', start)
  vm.runInNewContext(code.slice(start, end + 5), {
    HTMLElement, document: { addEventListener: (type, fn) => { handler = fn } },
    D: { onboarding: { hidden: true } }, $$: () => [], toggleMic: () => toggles++,
  })
  for (const attributes of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { target: new HTMLElement('BUTTON') }, { target: new HTMLElement('A') }]) {
    let prevented = false
    handler({ code: 'Space', target: new HTMLElement('BODY'), preventDefault: () => { prevented = true }, ...attributes })
    assert.equal(prevented, false)
  }
  assert.equal(toggles, 0)
  let prevented = false
  handler({ code: 'Space', target: new HTMLElement('BODY'), preventDefault: () => { prevented = true } })
  assert.equal(toggles, 1)
  assert.equal(prevented, true)
})

function mobileHarness({ media, audioContext, voiceFactory } = {}) {
  const dom = fakeDom()
  const appState = { settings: {} }
  const seen = { toasts: [], audioStops: 0, browserCancels: 0, chatAborts: 0, loops: 0, plays: 0, timerStarts: 0 }
  const ui = { openSheet: noop, closeSheet: noop, switchTab: noop, isSheetCurrent: () => true, updateSheet: () => true }
  const h = moduleHarness('mobile/call.js', {
    ...dom, M: appState, ui, Element: Object,
    saveLocalPlan: (plan) => { appState.plan = plan },
    window: { AudioContext: audioContext, addEventListener: noop },
    navigator: { mediaDevices: media },
    tts: { cancel: () => { seen.browserCancels++ } },
    toast: (message) => seen.toasts.push(message), esc: String, icon: () => '',
    __loadVoiceModule: async () => ({ createDoubaoVoice: voiceFactory || (() => null) }),
  }, 'C, D, ui, openCall, endCall, hangup, bindCall, bindSummaryActions, openSummaryLocal, onSheetClosed, finalizeLesson, cancelPtt, startPtt, ensurePttStt, ensureMicMonitor, stopMicMonitor, ensureVolc, warmVolcSession, speakGroundedReply, sendTextToChat, showTextForm', {
    cacheDom: noop, bindDocsControls: noop, bindLessonControls: noop,
    setMicDock: noop, startMicLoop: () => { seen.loops++ }, stopMicLoop: noop,
    stopPttWatchdog: noop, startPttWatchdog: noop, clearPttTimers: noop, stopTimer: noop,
    clearVolcWarmup: noop, dropInterim: noop, resetPttForNewTurn: noop,
    stopCharacterVoice: async () => { seen.audioStops++ },
    playCharacterVoice: async () => { seen.plays++; return true },
    scheduleVolcWarmup: noop, startTimer: () => { seen.timerStarts++ },
    renderDialogueUser: noop, renderKbBar: noop, clearCitations: noop,
    resetDocsForCall: noop, clearLessonState: noop, destroyHead: noop,
    toggleHistory: noop, hideDialogue: noop, closeDocsPanel: noop,
    renderCitations: noop, extractKbHits: () => null, translateBubble: async () => {},
    showDialogue: noop, scrollBubblesToBottom: noop, persistLessonProgress: noop,
    spawnCallParticles: noop, mountTalkingHead: async () => {},
    detectEngine: async () => 'browser', initMicForCall: async () => false, initDocsForCall: async () => {},
    openSummaryLocal: noop, renderFeedbackPanel: noop, withTimeout: (promise) => promise,
  })
  h.override({
    setState: (value) => { h.C.state = value },
    setPttState: (value) => { h.C.ptt = value },
    addBubble: () => ({ id: 'test-bubble', querySelector: () => ({ textContent: '' }) }),
  })
  for (const name of ['call', 'bubbles', 'hint', 'textForm', 'textInput', 'textBtn', 'mute', 'translate', 'talk', 'hangup', 'back', 'hintBtn']) h.D[name] = dom.make('call-' + name)
  h.D.textForm.hidden = true
  h.D.call.id = 'call'
  dom.elements.set('call', h.D.call)
  h.C.open = true
  h.C.bound = true
  return { ...h, dom, seen }
}

test('mobile: Escape cancellation also cancels the connecting state', () => {
  const h = mobileHarness()
  let stops = 0
  h.C.ptt = 'connecting'
  h.C.volc = { isActive: true, stop() { stops++ } }
  const oldToken = h.C.pttToken
  assert.equal(h.cancelPtt(), true)
  assert.equal(h.C.ptt, 'idle')
  assert.ok(h.C.pttToken > oldToken)
  assert.equal(stops, 1)
})

for (const throws of [false, true]) {
  test(`mobile: ${throws ? 'failed' : 'unavailable'} speech recognition never enters fake recording`, async () => {
    const h = mobileHarness()
    h.C.engine = 'browser'
    h.override({ ensureMicMonitor: async () => false, ensurePttStt: () => throws ? { start() { throw new Error('unavailable') } } : null })
    assert.equal(await h.startPtt(), false)
    assert.notEqual(h.C.ptt, 'recording')
    assert.notEqual(h.C.state, 'listening')
    assert.equal(h.D.textForm.hidden, false, 'offer the working text path')
    assert.equal(h.seen.toasts.length, 1)
  })
}

test('mobile: a fatal recognition error exits recording and offers text instead of silently restarting', async () => {
  const h = mobileHarness()
  let callbacks
  let aborts = 0
  h.context.window.SpeechRecognition = function () {}
  h.context.createSTT = (handlers) => {
    callbacks = handlers
    return { isActive: true, start: () => true, stop: noop, abort: () => { aborts++ } }
  }
  h.override({ ensureMicMonitor: async () => false })
  h.C.engine = 'browser'
  assert.equal(await h.startPtt(), true)
  callbacks.onError({ code: 'denied', message: 'microphone permission denied' })
  assert.equal(h.C.ptt, 'idle')
  assert.equal(h.C.state, 'idle')
  assert.equal(h.D.textForm.hidden, false)
  assert.equal(aborts, 1)
})

function microphoneHarness() {
  const requests = []
  const tracks = []
  class AudioContext {
    createMediaStreamSource() { return { connect: noop } }
    createAnalyser() { return {} }
    close() {}
  }
  const h = mobileHarness({
    audioContext: AudioContext,
    media: { getUserMedia: () => new Promise((resolve) => {
      const track = { stops: 0, stop() { this.stops++ } }
      tracks.push(track)
      requests.push(() => resolve({ getTracks: () => [track] }))
    }) },
  })
  return { ...h, requests, tracks }
}

test('mobile: permission granted after leaving the call releases the late microphone', async () => {
  const h = microphoneHarness()
  const pending = h.ensureMicMonitor()
  h.C.open = false
  h.stopMicMonitor()
  h.requests[0]()
  assert.equal(await pending, false)
  assert.equal(h.tracks[0].stops, 1)
  assert.equal(h.C.mic.active, false)
  assert.equal(h.seen.loops, 0)
})

test('mobile: an old microphone request cannot clear or replace a new call request', async () => {
  const h = microphoneHarness()
  const old = h.ensureMicMonitor()
  h.stopMicMonitor()
  const current = h.ensureMicMonitor()
  assert.equal(h.requests.length, 2)
  h.requests[0]()
  assert.equal(await old, false)
  assert.notEqual(h.C.mic.pending, null)
  h.requests[1]()
  assert.equal(await current, true)
  assert.equal(h.tracks[0].stops, 1)
  assert.equal(h.tracks[1].stops, 0)
  h.stopMicMonitor()
})

test('mobile: a microphone stream is released when the audio graph cannot be created', async () => {
  const h = microphoneHarness()
  h.context.window.AudioContext = undefined
  const pending = h.ensureMicMonitor()
  h.requests[0]()
  assert.equal(await pending, false)
  assert.equal(h.tracks[0].stops, 1)
  assert.equal(h.C.mic.active, false)
  assert.equal(h.C.mic.pending, null)
})

test('mobile: callbacks from a superseded realtime instance cannot end the current call', async () => {
  const voices = []
  const h = mobileHarness({ voiceFactory(handlers) {
    const voice = { handlers, isActive: true, setOutputMuted: noop }
    voices.push(voice)
    return voice
  } })
  h.C.engine = 'volc'
  h.C.volcToken = h.C.pttToken = 1
  await h.ensureVolc()
  h.C.volc = null
  h.C.volcToken = h.C.pttToken = 2
  await h.ensureVolc()
  h.C.ptt = 'recording'
  const current = h.C.volc
  voices[0].handlers.onEnded()
  assert.strictEqual(h.C.volc, current)
  assert.equal(h.C.ptt, 'recording')
  assert.equal(h.C.pttToken, 2)
  voices[0].handlers.onMicLevel(0.9)
  assert.equal(h.C.pttMicLevel, 0)
})

test('mobile: an old module load cannot clear the new call loading promise', async () => {
  const h = mobileHarness()
  const releases = []
  h.context.__loadVoiceModule = () => new Promise((resolve) => releases.push(resolve))
  const old = h.ensureVolc()
  h.C.callGeneration += 1
  h.C.volcLoading = null
  const current = h.ensureVolc()
  releases[0]({ createDoubaoVoice: () => ({ setOutputMuted: noop }) })
  assert.equal(await old, null)
  assert.notEqual(h.C.volcLoading, null)
  const currentVoice = { setOutputMuted: noop }
  releases[1]({ createDoubaoVoice: () => currentVoice })
  assert.equal(await current, currentVoice)
  assert.equal(h.C.volc, currentVoice)
})

test('mobile: a new call and resume from summary clear the closing state', async () => {
  const h = mobileHarness()
  h.C.open = false
  h.C.closingCall = true
  assert.equal(await h.openCall({ id: 'elena', scenes: [], greetingZh: '你好' }), true)
  assert.equal(h.C.closingCall, false)
  h.C.closingCall = true
  h.C.endAfterSheet = true
  h.C.summarySheetToken = 1
  const sheet = h.dom.make('sheet-body')
  h.bindSummaryActions()
  sheet.onclick({ target: { closest: () => ({ getAttribute: () => 'summary-resume' }) } })
  assert.equal(h.C.closingCall, false)
  assert.equal(h.C.endAfterSheet, false)
})

test('mobile: hangup stops character speech and aborts a pending text response before showing summary', async () => {
  const h = mobileHarness()
  h.C.chatHandle = { abort: () => { h.seen.chatAborts++ } }
  await h.hangup()
  assert.ok(h.seen.audioStops > 0)
  assert.equal(h.seen.chatAborts, 1)
  assert.equal(h.C.chatHandle, null)
})

test('mobile: a delayed warmup cannot reopen the microphone while the hangup summary is open', async () => {
  const h = mobileHarness()
  let starts = 0
  h.C.engine = 'volc'
  h.C.closingCall = true
  h.C.volc = { isActive: false, start: async () => { starts++; return true }, pauseMic: noop }
  await h.warmVolcSession()
  assert.equal(starts, 0)
})

test('mobile: queued text callbacks after hangup cannot change the summary call state or speak', async () => {
  const h = mobileHarness()
  let callbacks
  h.context.chatStream = (payload, handlers) => {
    callbacks = handlers
    return { abort: () => { h.seen.chatAborts++ } }
  }
  await h.sendTextToChat('Hello')
  await h.hangup()
  callbacks.onDelta('A late answer')
  callbacks.onDone({ fullReply: 'A late answer after hangup.' })
  callbacks.onError(new Error('late transport error'))
  assert.equal(h.C.state, 'idle')
  assert.equal(h.C.messages.length, 0)
  assert.equal(h.seen.plays, 0)
  assert.equal(h.seen.toasts.length, 0)
})

test('mobile: muted material replies stay silent and realtime output follows the mute control', async () => {
  const output = []
  const h = mobileHarness({ voiceFactory: () => ({ isActive: false, setOutputMuted: (value) => output.push(value) }) })
  h.C.muted = true
  h.speakGroundedReply('The teacher should remain muted.')
  await tick()
  assert.equal(h.seen.plays, 0)
  await h.ensureVolc()
  assert.equal(output.at(-1), true)
  h.C.muted = false
  h.bindCall()
  h.D.mute.events.get('click')()
  assert.equal(h.C.muted, true)
  assert.equal(output.at(-1), true)
  h.D.mute.events.get('click')()
  assert.equal(output.at(-1), false)
})

test('mobile: the full-screen call isolates the background and restores the opening control on close', async () => {
  const h = mobileHarness()
  h.C.open = false
  const screens = h.dom.make('screens')
  const tabbar = h.dom.make('tabbar')
  const kb = h.dom.make('kb-screen')
  kb.inert = true
  const launcher = h.dom.make('open-call')
  launcher.focus()
  await h.openCall({ id: 'elena', scenes: [], greetingZh: '你好' })
  assert.equal(screens.inert, true)
  assert.equal(tabbar.inert, true)
  assert.equal(h.dom.document.activeElement, h.D.back)
  await h.endCall({ silent: true })
  assert.equal(screens.inert, false)
  assert.equal(tabbar.inert, false)
  assert.equal(kb.inert, true, 'preserve existing inert ownership')
  assert.equal(h.dom.document.activeElement, launcher)
})

test('mobile: Tab stays in the full-screen call and yields to an open sheet or handled event', () => {
  const h = mobileHarness()
  h.D.call.children = [h.D.back, h.D.talk]
  h.bindCall()
  const onKey = h.dom.listeners.get('keydown')[0]
  let prevented = false
  h.D.talk.focus()
  onKey({ key: 'Tab', preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(h.dom.document.activeElement, h.D.back)
  onKey({ key: 'Tab', shiftKey: true, preventDefault: noop })
  assert.equal(h.dom.document.activeElement, h.D.talk)
  h.dom.document.body.classList.add('sheet-open')
  prevented = false
  onKey({ key: 'Tab', preventDefault: () => { prevented = true } })
  assert.equal(prevented, false)
  h.dom.document.body.classList.remove('sheet-open')
  onKey({ key: 'Tab', defaultPrevented: true, preventDefault: () => { prevented = true } })
  assert.equal(prevented, false)
})

test('mobile: opening the text form focuses its visible input immediately without deferring focus', () => {
  const h = mobileHarness()
  const pending = []
  h.context.setTimeout = (fn) => { pending.push(fn) }
  h.D.textInput.value = 'My unfinished sentence'
  h.D.textBtn.focus()
  h.showTextForm(true)
  assert.equal(h.D.textForm.hidden, false)
  assert.equal(h.dom.document.activeElement, h.D.textInput)
  assert.equal(h.D.textInput.value, 'My unfinished sentence')
  assert.equal(pending.length, 0)
})

test('mobile: hiding the text form returns an input focus to its toggle and leaves other focus alone', () => {
  const h = mobileHarness()
  h.D.textForm.children = [h.D.textInput]
  h.D.textForm.hidden = false
  h.D.textInput.focus()
  h.showTextForm(false)
  assert.equal(h.D.textForm.hidden, true)
  assert.equal(h.dom.document.activeElement, h.D.textBtn)
  h.D.back.focus()
  h.showTextForm(false)
  assert.equal(h.dom.document.activeElement, h.D.back)
})

for (const blocked of ['sheet', 'closed-call']) {
  test(`mobile: text form focus cannot escape a ${blocked} boundary`, () => {
    const h = mobileHarness()
    const pending = []
    h.context.setTimeout = (fn) => { pending.push(fn) }
    const owner = h.dom.make('current-focus')
    owner.focus()
    if (blocked === 'sheet') h.dom.document.body.classList.add('sheet-open')
    else h.C.open = false
    h.showTextForm(true)
    for (const fn of pending) fn()
    assert.equal(h.dom.document.activeElement, owner)
    h.D.textForm.children = [h.D.textInput]
    h.D.textInput.focus()
    h.showTextForm(false)
    assert.equal(h.dom.document.activeElement, h.D.textInput, 'an inactive call must not claim focus for its toggle')
    assert.equal(pending.length, 0)
  })
}

function ownedSheets(h) {
  const body = h.dom.make('sheet-body')
  const title = h.dom.make('sheet-title')
  let sequence = 0
  let current = null
  const paint = (heading, html) => { title.textContent = heading; body.innerHTML = html }
  Object.assign(h.ui, {
    openSheet(heading, html, options = {}) {
      const previous = current
      current = { token: ++sequence, onClose: options.onClose }
      paint(heading, html)
      h.dom.document.body.classList.add('sheet-open')
      previous?.onClose?.('replaced')
      return current.token
    },
    isSheetCurrent(token) { return current?.token === token },
    updateSheet(token, heading, html) {
      if (!h.ui.isSheetCurrent(token)) return false
      paint(heading, html)
      return true
    },
    closeSheet(token) {
      if (!current || (token !== undefined && !h.ui.isSheetCurrent(token))) return false
      const previous = current
      current = null
      h.dom.document.body.classList.remove('sheet-open')
      previous.onClose?.('dismissed')
      queueMicrotask(() => { if (!current) h.onSheetClosed() })
      return true
    },
  })
  h.override({ openSummaryLocal: h.openSummaryLocal })
  return { body, title, token: () => current?.token ?? null }
}

for (const success of [true, false]) {
  test(`mobile: a late ${success ? 'AI summary' : 'summary fallback'} cannot replace a newer sheet`, async () => {
    const h = mobileHarness()
    const sheets = ownedSheets(h)
    h.C.messages = [{ role: 'user', content: 'Hello' }]
    let finishSummary
    h.context.postJSON = async () => success ? { ok: true, summary_zh: '快速总结' } : { ok: false }
    h.context.fetchSummary = () => new Promise((resolve) => { finishSummary = resolve })
    const pending = h.hangup()
    await tick()
    const summaryHandler = sheets.body.onclick
    const newerToken = h.ui.openSheet('今日单词表', '<p>apple</p>')
    finishSummary(success ? { summary_zh: '迟到的 AI 总结' } : { error: 'offline' })
    await pending
    assert.equal(sheets.token(), newerToken)
    assert.equal(sheets.title.textContent, '今日单词表')
    assert.equal(sheets.body.innerHTML, '<p>apple</p>')
    assert.equal(h.C.open, true, 'replacing a sheet is not ending the call')
    if (summaryHandler) {
      summaryHandler({ target: { closest: () => ({ getAttribute: () => 'summary-resume' }) } })
      assert.equal(sheets.token(), newerToken, 'a stale summary action must not close the newer sheet')
    }
  })
}

test('mobile: a summary replaced during the quick request does not start or display the late AI summary', async () => {
  const h = mobileHarness()
  const sheets = ownedSheets(h)
  h.C.messages = [{ role: 'user', content: 'Hello' }]
  let finishQuick
  let aiRequests = 0
  h.context.postJSON = () => new Promise((resolve) => { finishQuick = resolve })
  h.context.fetchSummary = async () => { aiRequests++; return { summary_zh: 'AI 总结' } }
  const pending = h.hangup()
  h.ui.openSheet('帮助', '<p>继续阅读帮助</p>')
  finishQuick({ ok: true, summary_zh: '快速总结' })
  await pending
  assert.equal(aiRequests, 0)
  assert.equal(sheets.title.textContent, '帮助')
  assert.equal(h.C.open, true)
})

test('mobile: resume from the owned summary keeps the call open and ignores a later summary result', async () => {
  const h = mobileHarness()
  const sheets = ownedSheets(h)
  h.C.messages = [{ role: 'user', content: 'Hello' }]
  let finishSummary
  h.context.postJSON = async () => ({ ok: true, summary_zh: '快速总结' })
  h.context.fetchSummary = () => new Promise((resolve) => { finishSummary = resolve })
  const pending = h.hangup()
  await tick()
  sheets.body.onclick({ target: { closest: () => ({ getAttribute: () => 'summary-resume' }) } })
  await tick()
  assert.equal(h.C.open, true)
  assert.equal(h.C.closingCall, false)
  assert.equal(h.C.endAfterSheet, false)
  assert.equal(sheets.token(), null)
  finishSummary({ summary_zh: '迟到的 AI 总结' })
  await pending
  assert.equal(sheets.token(), null)
  assert.equal(h.seen.timerStarts, 1)
})

test('mobile: lesson completion cannot replace a sheet opened while saving progress', async () => {
  const h = mobileHarness()
  const sheets = ownedSheets(h)
  h.C.character = { id: 'elena' }
  h.C.lesson = { id: 'lesson-a', title: '课程 A', phrases: [] }
  let finish
  h.context.postJSON = () => new Promise((resolve) => { finish = resolve })
  const pending = h.finalizeLesson()
  const newerToken = h.ui.openSheet('今日单词表', '<p>apple</p>')
  finish({ ok: true, completed: true, plan: {} })
  await pending
  assert.equal(sheets.token(), newerToken)
  assert.equal(sheets.title.textContent, '今日单词表')
  assert.equal(h.C.lessonSubmitting, false)
})

test('mobile: an old lesson completion cannot change a new call lesson or its pending state', async () => {
  const h = mobileHarness()
  const sheets = ownedSheets(h)
  h.C.character = { id: 'elena' }
  h.C.lesson = { id: 'lesson-a', title: '课程 A', phrases: [] }
  let finish
  h.context.postJSON = () => new Promise((resolve) => { finish = resolve })
  const pending = h.finalizeLesson()
  h.C.callGeneration += 1
  h.C.lesson = { id: 'lesson-b', title: '课程 B', phrases: [] }
  h.C.lessonSubmitting = true
  h.ui.openSheet('新课程', '<p>课程 B</p>')
  finish({ ok: true, completed: true, plan: {} })
  await pending
  assert.equal(sheets.title.textContent, '新课程')
  assert.equal(h.C.lessonSubmitting, true)
  assert.equal(h.C.lesson.id, 'lesson-b')
})

test('mobile: lesson completion updates its own loading sheet and stale result actions cannot close another sheet', async () => {
  const h = mobileHarness()
  const sheets = ownedSheets(h)
  h.C.character = { id: 'elena' }
  h.C.lesson = { id: 'lesson-a', title: '课程 A', phrases: [{ en: 'Hello', zh: '你好' }] }
  let finish
  let refreshes = 0
  h.ui.refreshCourses = () => { refreshes++ }
  h.context.postJSON = () => new Promise((resolve) => { finish = resolve })
  const pending = h.finalizeLesson()
  const owner = sheets.token()
  assert.equal(sheets.title.textContent, '正在保存本课进度')
  finish({ ok: true, completed: true, plan: { progress: 42 } })
  await pending
  assert.equal(sheets.token(), owner, 'the result updates instead of opening another overlay')
  assert.equal(sheets.title.textContent, '🎉 本课完成 · 课程 A')
  assert.match(sheets.body.innerHTML, /42%/)
  assert.match(sheets.body.innerHTML, /Hello/)
  assert.equal(h.C.lessonSubmitting, false)
  assert.equal(refreshes, 1)
  const oldHandler = sheets.body.onclick
  const newer = h.ui.openSheet('帮助', '<p>当前帮助</p>')
  oldHandler({ target: { closest: () => ({ getAttribute: () => 'lesson-return' }) } })
  assert.equal(sheets.token(), newer)
  assert.equal(h.C.open, true)
})

test('mobile: a failed lesson save can retry in a new owned sheet', async () => {
  const h = mobileHarness()
  const sheets = ownedSheets(h)
  h.C.character = { id: 'elena' }
  h.C.lesson = { id: 'lesson-a', title: '课程 A', phrases: [] }
  let requests = 0
  h.context.postJSON = async () => ++requests === 1
    ? { ok: false, reason: 'steps-incomplete' }
    : { ok: true, completed: true, plan: { progress: 100 } }
  await h.finalizeLesson()
  const failedToken = sheets.token()
  assert.equal(sheets.title.textContent, '本课完成上报失败')
  assert.match(sheets.body.innerHTML, /教学步骤还没完成/)
  sheets.body.onclick({ target: { closest: () => ({ getAttribute: () => 'lesson-retry' }) } })
  await tick()
  assert.notEqual(sheets.token(), failedToken)
  assert.equal(sheets.title.textContent, '🎉 本课完成 · 课程 A')
  assert.equal(h.C.lessonSubmitting, false)
  assert.equal(h.C.open, true)
  assert.equal(requests, 2)
})

test('mobile: dismissing the final summary preserves the originating page instead of navigating to chat', () => {
  const h = mobileHarness()
  h.context.M.tab = 'assistant'
  const navigation = []
  h.ui.switchTab = (tab) => { navigation.push(tab); h.context.M.tab = tab }
  h.C.endAfterSheet = true
  h.onSheetClosed()
  assert.equal(h.C.open, false)
  assert.equal(h.context.M.tab, 'assistant')
  assert.deepEqual(navigation, [])
})

test('mobile: returning before the learner speaks closes without generating or storing a fabricated summary', async () => {
  const h = mobileHarness()
  h.C.messages = [{ role: 'assistant', content: 'Welcome! What would you like to talk about?' }]
  let requests = 0
  h.context.postJSON = async () => { requests++; return { ok: true, summary_zh: 'unused' } }
  h.context.fetchSummary = async () => { requests++; return { summary_zh: 'unused' } }
  await h.hangup()
  assert.equal(requests, 0)
  assert.equal(h.C.open, false)
  assert.equal(h.C.endAfterSheet, false)
})
