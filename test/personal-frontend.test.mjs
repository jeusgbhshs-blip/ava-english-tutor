/** Personal-app interaction regressions. Real module logic, offline DOM/audio/API substitutes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { SUPPORTED_EXTENSIONS } from '../lib/docExtract.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function isolatedModule(file, bindings, exposed) {
  const code = readFileSync(new URL(`../web/js/mobile/${file}`, import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+(['"])[^'"]+\1\s*;?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
    .replace(/^export\s+/gm, '')
  const timers = new Map()
  let timerId = 0
  const clock = {
    setTimeout(fn) { timers.set(++timerId, fn); return timerId },
    clearTimeout(id) { timers.delete(id) },
    setInterval() { return 1 }, clearInterval() {},
  }
  const context = vm.createContext({ console, ...clock, ...bindings })
  context.window = { ...clock, ...(bindings.window || {}) }
  vm.runInContext(`${code}\nthis.subject = { ${exposed} };`, context, { filename: file })
  return { ...context.subject, context, timers }
}

class FakeElement {
  constructor(attrs = {}) {
    this.attrs = attrs
    this.tagName = attrs.tagName || 'BUTTON'
    this.value = attrs.value || ''
    this.textContent = ''
    this.innerHTML = ''
    this.hidden = false
    this.disabled = false
    this.dataset = {}
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false } }
  }
  getAttribute(name) { return this.attrs[name] || null }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  closest() { return this }
  querySelector() { return null }
  querySelectorAll() { return [] }
  addEventListener(name, fn) { this[`on${name}`] = fn }
  focus() { this.focused = true }
}

function sheetHarness() {
  const nodes = new Map([['sheet-body', new FakeElement()]])
  let current = null
  let sequence = 0
  let sheetIds = []
  const render = (html) => {
    for (const id of sheetIds) nodes.delete(id)
    sheetIds = []
    nodes.get('sheet-body').innerHTML = html
    for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
      const node = new FakeElement(attrs)
      if (match[1] === 'textarea') {
        node.value = html.slice(match.index + match[0].length).split('</textarea>')[0]
      }
      nodes.set(match[3], node)
      sheetIds.push(match[3])
    }
  }
  const ui = {
    openSheet(title, html, options = {}) {
      if (current) {
        const old = current
        current = null
        old.onClose?.('replaced')
      }
      current = { token: ++sequence, title, onClose: options.onClose }
      render(html)
      return current.token
    },
    isSheetCurrent(token) { return !!current && current.token === token },
    updateSheet(token, title, html) {
      if (!ui.isSheetCurrent(token)) return false
      current.title = title
      render(html)
      return true
    },
    closeSheet(token) {
      if (!current || (token != null && token !== current.token)) return false
      const old = current
      current = null
      old.onClose?.('dismissed')
      return true
    },
  }
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    querySelector: (selector) => selector.startsWith('#') ? nodes.get(selector.slice(1)) || null : null,
    body: { classList: { add() {}, remove() {} } },
  }
  return { nodes, ui, document, current: () => current }
}

function kbHarness(overrides = {}) {
  const sheets = sheetHarness()
  const notices = []
  const requests = []
  const binaryRequests = []
  const revokedUrls = []
  const defaultPost = async (path, body) => {
    requests.push({ path, body })
    return { ok: true, text: 'A sufficiently long English text for proofreading.', kind: 'image' }
  }
  const post = overrides.postJSON || defaultPost
  const apiFetch = async (path, init = {}) => {
    const endpoint = new URL(path, 'http://ava.test').pathname
    if (endpoint === '/api/kb/upload-limits') return { ok: true, json: async () => ({ ok: true, maxFileBytes: 100 * 1024 * 1024, maxTextChars: 60000 }) }
    binaryRequests.push({ path, ...init })
    const payload = endpoint === '/api/kb/upload'
      ? await (overrides.kbUpload || (async () => ({ ok: true })))(init.body)
      : await post(endpoint, { name: init.body.name })
    return { ok: true, status: 200, json: async () => payload }
  }
  const h = isolatedModule('kb.js', {
    ...sheets, Element: FakeElement, AbortController, apiFetch,
    URL: { createObjectURL: (file) => `blob:ava-${file.name}`, revokeObjectURL: (url) => revokedUrls.push(url) }, M: {},
    $: (selector) => sheets.document.querySelector(selector),
    esc: String, icon: () => '', sleep: () => Promise.resolve(),
    toast: (message, type) => notices.push({ message, type }),
    kbList: async () => ({ ok: true, docs: [] }),
    kbDelete: async () => ({ ok: true }),
    kbUpload: async () => ({ ok: true }),
    kbImportUrl: async () => ({ ok: true }),
    postJSON: post,
    ...overrides,
  }, 'KB, uploadFiles, reviewImageFile, openPasteSheet, confirmDelete, closeKbPanel, docStatus, statusText, ACCEPT')
  h.KB.open = true
  return { ...h, ...sheets, notices, requests, binaryRequests, revokedUrls }
}

const imageFile = (name) => ({ name, size: 120, type: 'image/png' })

test('KB image batch waits for each proofreading decision before processing the next image', async () => {
  const h = kbHarness()
  const batch = h.uploadFiles([imageFile('first.png'), imageFile('second.png')])
  await tick()
  assert.equal(h.requests.length, 1, 'the second image must not replace unsaved first-image text')
  const skip = h.nodes.get('ocr-skip')
  assert.ok(skip, 'the queue exposes a deliberate skip action')
  skip.onclick()
  await tick()
  assert.equal(h.requests.length, 2)
  h.ui.closeSheet()
  await batch
  assert.equal(h.KB.busy, false)
  assert.equal(h.binaryRequests[0].headers['Content-Type'], 'application/octet-stream')
  assert.equal(h.binaryRequests[0].body.name, 'first.png')
  assert.deepEqual(h.revokedUrls, ['blob:ava-first.png', 'blob:ava-second.png'])
})

test('KB closing an OCR preview cancels the batch and a late response cannot replace a new sheet', async () => {
  const waiting = deferred()
  let requests = 0
  const h = kbHarness({ postJSON: () => { requests++; return waiting.promise } })
  const batch = h.uploadFiles([imageFile('first.png'), imageFile('second.png')])
  await tick()
  h.ui.closeSheet()
  const newer = h.ui.openSheet('New task', '<p>A different task</p>')
  waiting.resolve({ ok: true, text: 'Long enough text to proofread after cancellation.', kind: 'image' })
  await tick()
  assert.equal(h.ui.isSheetCurrent(newer), true)
  assert.equal(requests, 1, 'dismissal cancels the rest of the image queue')
  await batch
})

test('KB proofreading waits for a successful save and keeps edited text available after a save failure', async () => {
  let previews = 0
  let savedText = ''
  let saveResult = { ok: false, error: 'Temporary save error' }
  const h = kbHarness({ postJSON: async (path, body) => {
    if (path.endsWith('preview-file')) {
      previews++
      return { ok: true, text: 'Original English text long enough for this image.' }
    }
    savedText = body.text
    return saveResult
  } })
  const batch = h.uploadFiles([imageFile('first.png'), imageFile('second.png')])
  await tick()
  const edited = 'The corrected English paragraph the user wants to keep.'
  h.nodes.get('ocr-review-text').value = edited
  await h.nodes.get('ocr-confirm').onclick()
  assert.equal(previews, 1)
  assert.equal(h.nodes.get('ocr-review-text').value, edited)
  assert.equal(h.nodes.get('ocr-confirm').disabled, false)
  saveResult = { ok: true, message: '原文已入库；未生成摘要' }
  await h.nodes.get('ocr-confirm').onclick()
  await tick()
  assert.equal(savedText, edited)
  assert.equal(previews, 2)
  h.ui.closeSheet()
  await batch
})

test('KB late paste-save completion never closes a different sheet', async () => {
  const waiting = deferred()
  const h = kbHarness({ postJSON: () => waiting.promise })
  h.openPasteSheet()
  h.nodes.get('kb-paste-text').value = 'A sufficiently long pasted English paragraph.'
  const saving = h.nodes.get('kb-paste-save').onclick()
  h.ui.closeSheet()
  const newer = h.ui.openSheet('New task', '<p>Keep this open</p>')
  waiting.resolve({ ok: true, doc: { id: 'new-doc' } })
  await saving
  assert.equal(h.ui.isSheetCurrent(newer), true)
})

test('KB late deletion completion never closes a different sheet', async () => {
  const waiting = deferred()
  const h = kbHarness({ kbDelete: () => waiting.promise })
  h.confirmDelete({ id: 'doc-1', title: 'A document' })
  const deleting = h.nodes.get('sheet-body').onclick({ target: new FakeElement({ 'data-act': 'kb-delete-confirm' }) })
  h.ui.closeSheet()
  const newer = h.ui.openSheet('New task', '<p>Keep this open</p>')
  waiting.resolve({ ok: true })
  await deleting
  assert.equal(h.ui.isSheetCurrent(newer), true)
})

test('KB paste-save failure keeps the current draft open and retryable', async () => {
  const h = kbHarness({ postJSON: async () => ({ ok: false, error: 'Save failed' }) })
  h.openPasteSheet()
  const token = h.current().token
  const text = 'The unsaved draft remains available after a failed request.'
  h.nodes.get('kb-paste-text').value = text
  await h.nodes.get('kb-paste-save').onclick()
  assert.equal(h.ui.isSheetCurrent(token), true)
  assert.equal(h.nodes.get('kb-paste-text').value, text)
  assert.equal(h.nodes.get('kb-paste-save').disabled, false)
})

test('KB upload uses the server enhancement message without promising a running summary', async () => {
  const h = kbHarness({ kbUpload: async () => ({ ok: true, message: '已入库，可按原文学习；未生成摘要' }) })
  const status = new FakeElement()
  h.nodes.set('kb-upload-status', status)
  await h.uploadFiles([{ name: 'notes.txt', size: 20, type: 'text/plain' }])
  assert.match(status.innerHTML, /未生成摘要/)
  assert.doesNotMatch(status.innerHTML, /摘要生成中/)
})

test('KB closing the panel invalidates an in-flight OCR preview', async () => {
  const waiting = deferred()
  const h = kbHarness({ postJSON: () => waiting.promise })
  const batch = h.uploadFiles([imageFile('first.png')])
  await tick()
  h.closeKbPanel()
  waiting.resolve({ ok: true, text: 'Late OCR text must stay out of the closed workspace.' })
  await batch
  assert.equal(h.current(), null)
  assert.equal(h.KB.busy, false)
  assert.equal(h.binaryRequests[0].signal.aborted, true, 'closing cancels the network request as well as UI state')
})

test('KB distinguishes stored, partial and failed enhancement from completed summaries', () => {
  const h = kbHarness()
  for (const status of ['stored', 'pending', 'done', 'partial', 'failed']) {
    assert.equal(h.docStatus({ enrichStatus: status }), status)
  }
  assert.equal(h.docStatus({ enrichStatus: 'skipped' }), 'stored')
  assert.match(h.statusText('stored'), /原文|未生成/)
  assert.match(h.statusText('partial'), /部分/)
  assert.match(h.statusText('failed'), /失败.*原文|原文.*可用/)
})

function reviewHarness(api = {}, bindings = {}) {
  const storage = new Map()
  let stopped = 0
  const h = isolatedModule('review.js', {
    api: { getReviewSummary: async () => ({ ok: true, total: 0 }), ...api },
    M: { tab: 'review' }, ui: {}, $: () => null, Element: FakeElement,
    esc: String, icon: () => '', mmss: String,
    toast() {}, tts: { cancel() {} },
    stopCharacterText() { stopped++ }, playCharacterText: async () => true,
    document: { getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    window: { dispatchEvent() {} }, CustomEvent: class {},
    ...bindings,
  }, 'R, startSession, gradeCurrent, reviewHandleBack, onReviewTabLeave, cleanupGame, loadAnySessionDraft, bindManage, loadManageWords, renderWordList')
  return { ...h, storage, stopped: () => stopped }
}

const words = [{ word: 'first', meaning: '第一' }, { word: 'second', meaning: '第二' }]

test('review late failure from a cancelled load cannot clear a newer session', async () => {
  const waiting = deferred()
  const h = reviewHarness({ getReviewDue: () => waiting.promise })
  const old = h.startSession()
  h.reviewHandleBack()
  await h.startSession('due', words)
  const current = h.R.session
  waiting.resolve({ ok: false, error: 'old request failed' })
  await old
  assert.equal(h.R.session, current)
  assert.equal(h.R.view, 'session')
})

test('review late successful load also leaves a newer session intact', async () => {
  const waiting = deferred()
  const h = reviewHarness({ getReviewDue: () => waiting.promise })
  const old = h.startSession()
  h.reviewHandleBack()
  await h.startSession('due', words)
  const current = h.R.session
  waiting.resolve({ ok: true, words: [{ word: 'stale', meaning: '过期' }] })
  await old
  assert.equal(h.R.session, current)
  assert.equal(h.R.session.words[0].word, 'first')
})

test('review exit during successful-grade feedback resumes the next ungraded word', async () => {
  const h = reviewHarness({ gradeReviewWord: async () => ({ ok: true, word: { status: 'learning' } }) })
  await h.startSession('due', words)
  h.R.session.flipped = true
  await h.gradeCurrent('good')
  h.reviewHandleBack()
  await h.startSession('due')
  assert.equal(h.R.session.words[h.R.session.index].word, 'second')
  assert.equal(h.R.session.answers.length, 1)
})

test('review last successful grade removes the resumable draft before its visual delay', async () => {
  const h = reviewHarness({ gradeReviewWord: async () => ({ ok: true, word: { status: 'known' } }) })
  await h.startSession('due', [words[0]])
  h.R.session.flipped = true
  await h.gradeCurrent('easy')
  h.reviewHandleBack()
  assert.equal(h.loadAnySessionDraft(), null)
})

test('review failed grade keeps the current word retryable', async () => {
  const h = reviewHarness({ gradeReviewWord: async () => ({ ok: false, error: 'Not saved' }) })
  await h.startSession('due', words)
  h.R.session.flipped = true
  await h.gradeCurrent('good')
  assert.equal(h.R.session.index, 0)
  assert.equal(h.R.session.answers.length, 0)
  assert.equal(h.R.session.grading, false)
})

test('review successful feedback advances once and enables the next ungraded card', async () => {
  let grades = 0
  const h = reviewHarness({ gradeReviewWord: async () => { grades++; return { ok: true, word: {} } } })
  await h.startSession('due', words)
  h.R.session.flipped = true
  await h.gradeCurrent('good')
  await h.gradeCurrent('good')
  assert.equal(grades, 1)
  for (const fn of h.timers.values()) fn()
  assert.equal(h.R.session.index, 1)
  assert.equal(h.R.session.grading, false)
  assert.equal(h.R.session.flipped, false)
})

test('review keyboard activation respects editing, handled events, modifiers and key repeats', async () => {
  const grades = []
  const h = reviewHarness({ gradeReviewWord: async (word, grade) => { grades.push(grade); return { ok: true, word: {} } } })
  await h.startSession('due', words)
  const card = new FakeElement({ 'data-act': 'card', tagName: 'DIV' })
  const press = (key, extra = {}) => {
    let prevented = false
    h.context.onSessionKeydown({ key, target: card, preventDefault() { prevented = true }, ...extra })
    return prevented
  }
  for (const extra of [
    { defaultPrevented: true }, { repeat: true }, { metaKey: true }, { ctrlKey: true },
    { altKey: true }, { shiftKey: true }, { isComposing: true }, { target: { tagName: 'INPUT' } },
  ]) assert.equal(press('Enter', extra), false)
  assert.equal(h.R.session.flipped, false)
  assert.equal(press('Enter'), true)
  assert.equal(h.R.session.flipped, true)
  assert.equal(press('3'), true)
  await tick()
  assert.deepEqual(grades, ['good'])
})

test('review leaving a tab, game or session stops the actual character audio helper', async () => {
  const h = reviewHarness()
  h.onReviewTabLeave()
  assert.ok(h.stopped() > 0)
  let before = h.stopped()
  h.cleanupGame()
  assert.ok(h.stopped() > before)
  await h.startSession('due', words)
  before = h.stopped()
  h.reviewHandleBack()
  assert.ok(h.stopped() > before)
})

test('profile background refresh updates statistics without replacing an in-progress interest form', async () => {
  const waiting = deferred()
  const input = new FakeElement()
  input.value = '尚未提交的兴趣'
  input.selectionStart = 4
  input.selectionEnd = 4
  const stats = new Map(['streak', 'turns', 'today', 'mastered'].map((key) => [key, new FakeElement()]))
  const tags = new FakeElement()
  let writes = 0
  const host = new FakeElement()
  Object.defineProperty(host, 'innerHTML', {
    get: () => '<div class="profile-page">existing profile</div>',
    set() { writes++; input.value = ''; input.focused = false },
  })
  host.querySelector = (selector) => selector === '.profile-page' ? host : null
  const M = { tab: 'profile', settings: { level: 'A2' }, progress: {}, profile: {}, nickname: 'Learner' }
  const h = isolatedModule('screens.js', {
    M, api: {}, ui: {}, esc: String, icon: () => '', $$: () => [], toast() {},
    $: (selector) => {
      if (selector === '#screen-profile') return host
      if (selector === '#interest-input') return input
      if (selector === '#interest-tags') return tags
      const match = selector.match(/\[data-profile-stat="(.*?)"\]/)
      return match ? stats.get(match[1]) || null : null
    },
    document: { activeElement: input },
    loadWordbook: () => waiting.promise.then(() => { M.wordbook = { days: [{ label: '今天', count: 3 }] } }),
    loadProgress: () => waiting.promise.then(() => { M.progress = { streak: 4, totalTurns: 12, masteredWords: 2 } }),
    loadProfile: () => waiting.promise.then(() => { M.profile = { interests: ['阅读'] } }),
  }, 'refreshProfileStats')
  const refresh = h.refreshProfileStats()
  waiting.resolve()
  await refresh
  assert.equal(writes, 0)
  assert.equal(input.value, '尚未提交的兴趣')
  assert.equal(stats.get('streak').textContent, '4')
  assert.equal(stats.get('today').textContent, '3')
})

test('profile level save applies the returned plan and accurately reports unfinished lesson regeneration', async () => {
  const plan = { version: 3, id: 'active', hasError: true, lessons: {} }
  const level = { value: 'B1', disabled: false }
  const notices = []
  const M = { settings: { level: 'A2' }, plan: null }
  const h = isolatedModule('screens.js', {
    M, api: {}, ui: {}, esc: String, icon: () => '', $$: () => [],
    $: (selector) => selector === '#profile-level' ? level : null,
    toast: (message, type) => notices.push({ message, type }),
    saveSettings: async () => ({ level: 'B1', planUpdated: true, plan, message: '难度已保存，但课件更新未完成，请重试' }),
    saveLocalPlan: (value) => { M.plan = value },
  }, 'bindProfile')
  h.bindProfile(new FakeElement())
  await level.onchange()
  assert.equal(M.plan, plan)
  assert.match(notices[0].message, /课件更新未完成/)
  assert.notEqual(notices[0].type, 'ok')
  assert.equal(level.disabled, false)
})

function assistantHarness(assistantChat, bindings = {}) {
  const nodes = new Map()
  const controls = []
  const actions = []
  const M = { tab: 'assistant', assistantThread: [], settings: { level: 'A2' }, plan: null }
  const document = { activeElement: null, getElementById: (id) => nodes.get(id) || null }
  const host = new FakeElement({ tagName: 'SECTION' })
  let html = ''
  Object.defineProperty(host, 'innerHTML', {
    get: () => html,
    set: (value) => {
      html = value
      nodes.clear()
      controls.length = 0
      host.firstElementChild = {}
      for (const match of html.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
        const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
        if (!attrs.id && match[1] !== 'button') continue
        const node = new FakeElement({ ...attrs, tagName: match[1].toUpperCase() })
        node.disabled = /\bdisabled(?:\s|=|$)/.test(match[2])
        node.focus = () => { document.activeElement = node }
        node.setSelectionRange = (start, end) => { node.selectionStart = start; node.selectionEnd = end }
        node.insertAdjacentHTML = () => {}
        node.remove = () => nodes.delete(attrs.id)
        if (attrs.id) nodes.set(attrs.id, node)
        if (match[1] === 'button') controls.push(node)
      }
    },
  })
  host.querySelector = (selector) => selector.startsWith('#') ? nodes.get(selector.slice(1)) || null : null
  host.querySelectorAll = (selector) => selector === '.a-chip' ? controls.filter((c) => c.attrs.class === 'a-chip') : []
  const h = isolatedModule('screens.js', {
    M, document, Element: FakeElement, api: {}, esc: String, icon: () => '', $$: () => [], toast() {},
    $: (selector) => selector === '#screen-assistant' ? host : nodes.get(selector.slice(1)) || null,
    ui: {
      openCall: (value) => actions.push(['call', value]),
      switchTab: (value) => { actions.push(['tab', value]); M.tab = value },
    },
    libraryStats: () => null,
    characterById: (id) => ({ id, name: id }),
    saveLocalPlan: (plan) => { M.plan = plan },
    loadPlan: async () => M.plan,
    showWordbookSheet: () => { actions.push(['wordbook']) },
    assistantChat,
    ...bindings,
  }, 'renderAssistant, sendAssistant')
  h.renderAssistant()
  return { ...h, M, document, nodes, controls, actions, host }
}

test('assistant sends one request at a time and disables both send and shortcut controls while waiting', async () => {
  const waiting = deferred()
  let calls = 0
  const h = assistantHarness(() => { calls++; return waiting.promise })
  const first = h.sendAssistant('First request')
  const duplicate = h.sendAssistant('Duplicate request')
  try {
    assert.equal(calls, 1)
    const send = h.controls.find((control) => control.attrs.type === 'submit')
    const chips = h.controls.filter((control) => control.attrs['data-act'] === 'chip')
    assert.equal(send.disabled, true)
    assert.ok(chips.length && chips.every((control) => control.disabled))
    assert.equal(h.M.assistantThread.filter((message) => message.role === 'user').length, 1)
  } finally {
    waiting.resolve({ ok: true, reply: 'Finished', actions: [] })
    await Promise.all([first, duplicate])
  }
  assert.equal(h.controls.find((control) => control.attrs.type === 'submit').disabled, false)
  assert.ok(h.controls.filter((control) => control.attrs['data-act'] === 'chip').every((control) => !control.disabled))
})

test('assistant keeps focus in the empty composer after sending and preserves the next draft and selection', async () => {
  const waiting = deferred()
  const h = assistantHarness(() => waiting.promise)
  const input = h.nodes.get('assistant-input')
  input.value = 'Send this'
  input.focus()
  h.nodes.get('assistant-form').onsubmit({ preventDefault() {} })
  try {
    const nextInput = h.nodes.get('assistant-input')
    assert.equal(h.document.activeElement, nextInput)
    nextInput.value = 'Next unsent draft'
    nextInput.setSelectionRange(3, 8)
  } finally {
    waiting.resolve({ ok: true, reply: 'Reply', actions: [] })
    await tick()
  }
  assert.equal(h.nodes.get('assistant-input').value, 'Next unsent draft')
  assert.equal(h.nodes.get('assistant-input').selectionStart, 3)
  assert.equal(h.nodes.get('assistant-input').selectionEnd, 8)
  assert.equal(h.document.activeElement, h.nodes.get('assistant-input'))
})

test('assistant ignores submit while pending without clearing the next draft', async () => {
  const waiting = deferred()
  let calls = 0
  const h = assistantHarness(() => { calls++; return waiting.promise })
  const sending = h.sendAssistant('First request')
  const input = h.nodes.get('assistant-input')
  input.value = 'A draft to send later'
  h.nodes.get('assistant-form').onsubmit({ preventDefault() {} })
  try {
    assert.equal(input.value, 'A draft to send later')
    assert.equal(calls, 1)
  } finally {
    waiting.resolve({ ok: true, reply: 'Reply', actions: [] })
    await sending
    await tick()
  }
  assert.equal(h.nodes.get('assistant-input').value, 'A draft to send later')
})

test('assistant late reply updates its thread and plan without navigating after the user leaves', async () => {
  const waiting = deferred()
  const h = assistantHarness(() => waiting.promise)
  const sending = h.sendAssistant('Help me learn')
  h.M.tab = 'profile'
  const plan = { id: 'saved-plan', stages: [] }
  waiting.resolve({ ok: true, reply: 'Your response', plan, actions: [
    { type: 'open_scene', payload: { characterId: 'maya' } },
    { type: 'review_words' },
    { type: 'open_tab', payload: { tab: 'review' } },
  ] })
  await sending
  await tick()
  assert.equal(h.M.assistantThread.at(-1).content, 'Your response')
  assert.equal(h.M.plan, plan)
  assert.deepEqual(h.actions, [])
  assert.equal(h.M.tab, 'profile')
})

test('assistant navigation remains available for the current completed request', async () => {
  const h = assistantHarness(async () => ({ ok: true, reply: 'Go to review', actions: [
    { type: 'open_tab', payload: { tab: 'review' } },
  ] }))
  await h.sendAssistant('Review')
  assert.deepEqual(h.actions, [['tab', 'review']])
})

test('assistant late actions leave a newly opened knowledge panel, sheet or call intact', async () => {
  for (const opened of ['kb-open', 'sheet-open', 'call-open']) {
    const waiting = deferred()
    const h = assistantHarness(() => waiting.promise)
    const sending = h.sendAssistant('Review my words')
    h.document.body = { classList: { contains: (name) => name === opened } }
    waiting.resolve({ ok: true, reply: 'Ready', actions: [{ type: 'review_words' }] })
    await sending
    assert.deepEqual(h.actions, [], `${opened} must keep control of the current task`)
    assert.equal(h.M.assistantThread.at(-1).content, 'Ready')
  }
})

test('assistant older actions cannot navigate after a later request supersedes them during plan refresh', async () => {
  const refreshing = deferred()
  let calls = 0
  const plan = { id: 'plan', stages: [] }
  const h = assistantHarness(async () => ++calls === 1
    ? { ok: true, reply: 'Created', plan, actions: [
      { type: 'create_plan', payload: plan },
      { type: 'open_scene', payload: { characterId: 'elena' } },
    ] }
    : { ok: true, reply: 'Newer reply', actions: [] }, { loadPlan: () => refreshing.promise })
  const first = h.sendAssistant('Create a plan')
  await tick()
  const second = h.sendAssistant('A new question')
  await second
  refreshing.resolve(plan)
  await first
  await tick()
  assert.equal(calls, 2)
  assert.equal(h.M.assistantThread.at(-1).content, 'Newer reply')
  assert.deepEqual(h.actions, [])
})

test('assistant unexpected request failure releases its busy state and leaves a usable reply', async () => {
  const h = assistantHarness(async () => { throw new Error('Connection lost') })
  await assert.doesNotReject(h.sendAssistant('Hello'))
  assert.equal(h.M.assistantThread.at(-1).role, 'assistant')
  assert.equal(h.controls.find((control) => control.attrs.type === 'submit').disabled, false)
})

test('KB blocks files above the server 100 MB limit and permits the boundary size', async () => {
  let uploads = 0
  const h = kbHarness({ kbUpload: async () => { uploads++; return { ok: true } } })
  await h.uploadFiles([{ name: 'too-large.txt', size: 100 * 1024 * 1024 + 1, type: 'text/plain' }])
  assert.equal(uploads, 0)
  assert.ok(h.notices.some((notice) => /100\s?MB/.test(notice.message)))
  await h.uploadFiles([{ name: 'boundary.txt', size: 100 * 1024 * 1024, type: 'text/plain' }])
  assert.equal(uploads, 1)
})

test('KB file picker extensions match the backend and do not advertise legacy PPT', () => {
  const h = kbHarness()
  assert.deepEqual(h.ACCEPT.split(',').sort(), [...SUPPORTED_EXTENSIONS].sort())
  assert.equal(h.ACCEPT.split(',').includes('.ppt'), false)
  assert.equal(h.ACCEPT.split(',').includes('.pptx'), true)
})

test('KB drag-and-drop rejects legacy PPT before uploading and still accepts PPTX', async () => {
  const uploads = []
  const h = kbHarness({ kbUpload: async (payload) => { uploads.push(payload.name); return { ok: true } } })
  await h.uploadFiles([{ name: 'legacy.ppt', size: 100 }, { name: 'slides.PPTX', size: 100 }])
  assert.deepEqual(uploads, ['slides.PPTX'])
  assert.ok(h.notices.some((notice) => /暂不支持.*legacy\.ppt/.test(notice.message)))
})

function manageHarness(listReview) {
  const host = new FakeElement()
  const list = new FakeElement()
  const more = new FakeElement()
  const reload = new FakeElement({ 'data-act': 'reload' })
  reload.closest = (selector) => selector === '[data-act]' ? reload : null
  host.querySelectorAll = (selector) => selector.includes('reload') ? [reload] : []
  const nodes = new Map([['screen-review', host], ['rv-wordlist', list], ['rv-list-more', more]])
  const notices = []
  const h = reviewHarness({ listReview }, {
    document: { getElementById: (id) => nodes.get(id) || null, querySelector: () => null },
    toast: (message, type) => notices.push({ message, type }),
  })
  h.R.view = 'manage'
  h.R.manage.words = [{ word: 'retained', meaning: '已有单词', status: 'learning' }]
  h.bindManage(host)
  h.renderWordList()
  return { ...h, host, list, notices, reload }
}

test('review management refresh reports success only after its request succeeds', async () => {
  const waiting = deferred()
  let calls = 0
  const h = manageHarness(() => { calls++; return waiting.promise })
  const refresh = h.host.onclick({ target: h.reload })
  await h.host.onclick({ target: h.reload })
  try {
    assert.equal(calls, 1)
    assert.equal(h.notices.some((notice) => notice.type === 'ok'), false)
    assert.equal(h.reload.disabled, true)
    assert.match(h.list.innerHTML, /retained/)
  } finally {
    waiting.resolve({ ok: true, words: [{ word: 'fresh', meaning: '新内容' }] })
    await refresh
    await tick()
  }
  assert.equal(h.notices.filter((notice) => notice.type === 'ok').length, 1)
  assert.match(h.list.innerHTML, /fresh/)
  assert.equal(h.reload.disabled, false)
})

test('review management failed refresh keeps the loaded words visible alongside its error', async () => {
  const h = manageHarness(async () => ({ ok: false, error: 'Network unavailable' }))
  await h.host.onclick({ target: h.reload })
  await tick()
  assert.equal(h.notices.some((notice) => notice.type === 'ok'), false)
  assert.equal(h.R.manage.words[0].word, 'retained')
  assert.match(h.list.innerHTML, /retained/)
  assert.match(h.list.innerHTML, /Network unavailable/)
  assert.equal(h.reload.disabled, false)
})

function reviewCardHarness(api = {}) {
  const listeners = new Map()
  const document = { activeElement: null }
  const emit = (type, target) => {
    for (const fn of [...(listeners.get(type) || [])]) fn({ type, target })
  }
  const makeElement = (attrs = {}) => {
    const node = new FakeElement({ tagName: 'DIV', ...attrs })
    node.children = []
    node.parentElement = null
    const classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean))
    node.classList = {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name) },
    }
    node.matches = (selector) => selector.startsWith('.')
      ? selector.slice(1).split('.').every((name) => classes.has(name))
      : selector.startsWith('#') ? attrs.id === selector.slice(1)
        : selector === '[data-grade]' ? !!attrs['data-grade'] : false
    node.contains = (target) => target === node || node.children.some((child) => child.contains(target))
    node.closest = (selector) => node.matches(selector) ? node : node.parentElement?.closest(selector) || null
    node.querySelectorAll = (selector) => node.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ])
    node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null
    node.focus = () => {
      for (let parent = node; parent; parent = parent.parentElement) if (parent.inert) return
      document.activeElement = node
      emit('focusin', node)
    }
    Object.defineProperty(node, 'inert', {
      get: () => Object.hasOwn(node.attrs, 'inert'),
      set: (value) => { if (value) node.attrs.inert = ''; else delete node.attrs.inert },
    })
    let disabled = false
    Object.defineProperty(node, 'disabled', {
      get: () => disabled,
      set: (value) => {
        disabled = !!value
        if (disabled && document.activeElement === node) document.activeElement = document.body
      },
    })
    return node
  }
  const attach = (parent, children) => {
    parent.children = children
    children.forEach((child) => { child.parentElement = parent })
  }
  const attrsOf = (tag) => {
    const attrs = Object.fromEntries([...String(tag || '').matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]))
    if (/\binert(?:\s|>)/.test(tag || '')) attrs.inert = ''
    return attrs
  }
  const body = makeElement({ tagName: 'BODY' })
  const host = makeElement({ id: 'screen-review' })
  document.body = body
  document.activeElement = body
  let html = ''
  Object.defineProperty(host, 'innerHTML', {
    get: () => html,
    set: (value) => {
      if (host.contains(document.activeElement)) document.activeElement = body
      html = value
      const cardTag = value.match(/<div\b[^>]*data-act="card"[^>]*>/)?.[0]
      if (!cardTag) { host.children = []; return }
      const card = makeElement(attrsOf(cardTag))
      const front = makeElement(attrsOf(value.match(/<div class="rv-face front"[^>]*>/)?.[0]))
      const back = makeElement(attrsOf(value.match(/<div class="rv-face back"[^>]*>/)?.[0]))
      const flip = makeElement({ ...attrsOf(value.match(/<button\b[^>]*data-act="flip"[^>]*>/)?.[0]), tagName: 'BUTTON' })
      const grades = makeElement({ class: 'rv-grades' })
      const gradeButtons = [...value.matchAll(/<button\b[^>]*data-grade="[^"]+"[^>]*>/g)]
        .map((match) => makeElement({ ...attrsOf(match[0]), tagName: 'BUTTON' }))
      attach(front, [flip])
      attach(card, [front, back])
      attach(grades, gradeButtons)
      attach(host, [card, grades, makeElement({ id: 'rv-session-hint' })])
    },
  })
  document.getElementById = (id) => id === 'screen-review' ? host : host.querySelector(`#${id}`)
  document.querySelector = (selector) => host.querySelector(selector)
  document.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
  }
  document.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn)
  const h = reviewHarness({ gradeReviewWord: async () => ({ ok: true, word: {} }), ...api }, { document })
  return {
    ...h, document, host, makeElement, emit,
    get card() { return host.querySelector('.rv-card') },
    get front() { return host.querySelector('.rv-face.front') },
    get back() { return host.querySelector('.rv-face.back') },
    runFeedback() {
      const pending = [...h.timers.values()]
      h.timers.clear()
      pending.forEach((fn) => fn())
    },
  }
}

test('review exposes only the visible card face to accessibility and focus, including after repaint', async () => {
  const h = reviewCardHarness()
  await h.startSession('due', words)
  assert.equal(h.front.getAttribute('aria-hidden'), 'false')
  assert.equal(h.front.inert, false)
  assert.equal(h.back.getAttribute('aria-hidden'), 'true')
  assert.equal(h.back.inert, true)
  h.context.flipCard()
  assert.equal(h.front.getAttribute('aria-hidden'), 'true')
  assert.equal(h.front.inert, true)
  assert.equal(h.back.getAttribute('aria-hidden'), 'false')
  assert.equal(h.back.inert, false)
  h.context.paintSession()
  assert.equal(h.front.inert, true)
  assert.equal(h.back.inert, false)
})

test('review flipping from a face control moves focus out of the face before hiding it', async () => {
  const h = reviewCardHarness()
  await h.startSession('due', words)
  h.front.children[0].focus()
  h.context.flipCard()
  assert.equal(h.document.activeElement, h.card)
  assert.equal(h.front.inert, true)
})

test('review Space then grade shortcut keeps focus on the next card and resets the visible face', async () => {
  const h = reviewCardHarness()
  await h.startSession('due', words)
  const first = h.card
  first.focus()
  h.context.onSessionKeydown({ key: ' ', target: first, preventDefault() {} })
  h.context.onSessionKeydown({ key: '3', target: first, preventDefault() {} })
  await tick()
  h.runFeedback()
  assert.equal(h.R.session.index, 1)
  assert.notEqual(h.card, first)
  assert.equal(h.document.activeElement, h.card)
  assert.equal(h.front.inert, false)
  assert.equal(h.back.inert, true)
})

test('review grading a focused rating control keeps the next card reachable after disabling the old button', async () => {
  const h = reviewCardHarness()
  await h.startSession('due', words)
  h.context.flipCard()
  h.host.querySelector('.rv-grade').focus()
  await h.gradeCurrent('good')
  h.runFeedback()
  assert.equal(h.R.session.index, 1)
  assert.equal(h.document.activeElement, h.card)
})

test('review never restores card focus after the user moves focus, clicks elsewhere or leaves and returns', async () => {
  for (const movement of ['focus-outside', 'pointer-outside', 'leave-and-return']) {
    const waiting = deferred()
    const h = reviewCardHarness({ gradeReviewWord: () => waiting.promise })
    await h.startSession('due', words)
    h.context.flipCard()
    h.card.focus()
    const grading = h.gradeCurrent('good')
    const outside = h.makeElement({ tagName: 'BUTTON' })
    if (movement === 'focus-outside') outside.focus()
    if (movement === 'pointer-outside') h.emit('pointerdown', outside)
    if (movement === 'leave-and-return') {
      h.context.M.tab = 'profile'
      h.onReviewTabLeave()
      h.context.M.tab = 'review'
    }
    waiting.resolve({ ok: true, word: {} })
    await grading
    h.runFeedback()
    assert.equal(h.R.session.index, 1)
    assert.notEqual(h.document.activeElement, h.card, movement)
    if (movement === 'focus-outside') assert.equal(h.document.activeElement, outside)
  }
})

test('review does not invent a focus restore intent when grading started outside its controls', async () => {
  const h = reviewCardHarness()
  await h.startSession('due', words)
  h.context.flipCard()
  assert.equal(h.document.activeElement, h.document.body)
  await h.gradeCurrent('good')
  h.card.focus()
  h.runFeedback()
  assert.notEqual(h.document.activeElement, h.card)
})
