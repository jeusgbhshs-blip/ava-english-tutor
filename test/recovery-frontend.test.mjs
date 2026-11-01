/**
 * Recovery regressions for browser modules, using isolated DOM/storage substitutes.
 * Runs the shipped source functions, with no browser process or external requests.
 * Run: node --test --test-isolation=none test/recovery-frontend.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { BOOK_LIBRARY } from '../web/js/mobile/book-library.js'

const source = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8')
const plain = (value) => JSON.parse(JSON.stringify(value))

// Only imported browser dependencies are replaced; the logic under test is unchanged.
function isolatedModule(name, bindings, exposed, { stripBoot = false } = {}) {
  let code = source(name)
    .replace(/^import\s+[\s\S]*?\s+from\s+(['"])[^'"]+\1\s*;?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
    .replace(/^export\s+/gm, '')
  if (stripBoot) code = code.replace(/^boot\(\)\.catch\(\(err\) => \{[\s\S]*?^\}\)\s*$/m, '')
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...bindings })
  vm.runInContext(`${code}\nthis.subject = { ${exposed} };`, context, { filename: name })
  return context
}

function libraryHarness() {
  let clock = new Date(2026, 10, 1, 12).getTime()
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return clock }
  }
  const storage = new Map()
  const context = isolatedModule('js/mobile/library.js', {
    BOOK_LIBRARY, Date: Clock,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    document: { getElementById: () => null, querySelector: () => null },
    $: () => null, esc: String, icon: () => '', toast: () => {}, M: {}, ui: {},
    characterById: () => null,
    postJSON: () => { throw new Error('network must not be called') },
  }, 'ensureToday, markComplete, pickBook, loadState')
  return {
    ...context.subject,
    advanceDay() {
      const date = new Date(clock)
      date.setDate(date.getDate() + 1)
      clock = date.getTime()
    },
  }
}

test('daily library keeps the same lesson on repeated visits and after completion that day', () => {
  const h = libraryHarness()
  const first = h.ensureToday()
  h.markComplete(first.book.id, first.dayIndex)
  const again = h.ensureToday()
  assert.equal(again.book.id, first.book.id)
  assert.equal(again.dayIndex, first.dayIndex)
  assert.equal(again.state.today.completed, true)
  assert.equal(again.state.books[first.book.id].cursor, 1)
  assert.equal(h.ensureToday().state.totalCompleted, 1)
})

test('day six advances to the next book, even though yesterday has a saved today record', () => {
  const h = libraryHarness()
  for (let index = 0; index < 5; index += 1) {
    const today = h.ensureToday()
    assert.equal(today.book.id, BOOK_LIBRARY[0].id)
    assert.equal(today.dayIndex, index)
    h.markComplete(today.book.id, today.dayIndex)
    h.advanceDay()
  }
  const sixth = h.ensureToday()
  assert.equal(sixth.book.id, BOOK_LIBRARY[1].id)
  assert.equal(sixth.dayIndex, 0)
  assert.equal(h.ensureToday().dayIndex, 0)
})

test('daily scheduling keeps its existing calendar progression when a day is not marked complete', () => {
  const h = libraryHarness()
  for (let index = 0; index < 5; index += 1) {
    assert.equal(h.ensureToday().dayIndex, index)
    h.advanceDay()
  }
  const next = h.ensureToday()
  assert.equal(next.book.id, BOOK_LIBRARY[1].id)
  assert.equal(next.dayIndex, 0)
  assert.equal(next.state.totalCompleted, 0)
})

test('finishing all books starts a review cycle while preserving completed statistics', () => {
  const h = libraryHarness()
  for (const book of BOOK_LIBRARY) {
    for (let day = 0; day < 5; day += 1) {
      const today = h.ensureToday()
      assert.equal(today.book.id, book.id)
      assert.equal(today.dayIndex, day)
      h.markComplete(book.id, day)
      h.advanceDay()
    }
  }
  const review = h.ensureToday()
  assert.equal(review.book.id, BOOK_LIBRARY[0].id)
  assert.equal(review.dayIndex, 0)
  assert.equal(review.state.totalCompleted, BOOK_LIBRARY.length * 5)
  assert.equal(review.state.books[BOOK_LIBRARY[0].id].completedDays.length, 5)
})

function kbHarness(response) {
  const context = isolatedModule('js/mobile/kb.js', {
    M: {}, ui: {}, $: () => null, esc: String, icon: () => '', toast: () => {},
    kbList: response,
  }, 'KB, reloadDocs')
  const { KB } = context.subject
  KB.docs = [{ id: 'kept', title: 'Saved material' }, { id: 'removed', title: 'Older material' }]
  KB.selected.add('kept')
  KB.selected.add('removed')
  KB.lastLoadedAt = 123
  return context.subject
}

test('knowledge list API error preserves loaded materials and selections with a visible error', async () => {
  const h = kbHarness(async () => ({ ok: false, status: 503, error: '服务暂不可用' }))
  await h.reloadDocs()
  assert.equal(h.KB.error, '服务暂不可用')
  assert.deepEqual(plain(h.KB.docs).map((doc) => doc.id), ['kept', 'removed'])
  assert.deepEqual([...h.KB.selected], ['kept', 'removed'])
  assert.equal(h.KB.lastLoadedAt, 123)
  assert.equal(h.KB.loading, false)
})

test('knowledge list network rejection does not erase the previously loaded list', async () => {
  const h = kbHarness(async () => { throw new Error('连接中断') })
  await h.reloadDocs()
  assert.equal(h.KB.error, '连接中断')
  assert.equal(h.KB.docs.length, 2)
  assert.equal(h.KB.selected.size, 2)
  assert.equal(h.KB.loading, false)
})

test('successful knowledge refresh replaces the list and removes only stale selections', async () => {
  const h = kbHarness(async () => ({ ok: true, docs: [{ id: 'kept', title: 'Updated material' }] }))
  h.KB.error = '上次请求失败'
  await h.reloadDocs()
  assert.equal(h.KB.error, '')
  assert.deepEqual(plain(h.KB.docs), [{ id: 'kept', title: 'Updated material' }])
  assert.deepEqual([...h.KB.selected], ['kept'])
  assert.ok(h.KB.lastLoadedAt > 123)
})

test('an explicitly successful empty knowledge list clears obsolete data', async () => {
  const h = kbHarness(async () => ({ ok: true, docs: [] }))
  await h.reloadDocs()
  assert.equal(h.KB.error, '')
  assert.equal(h.KB.docs.length, 0)
  assert.equal(h.KB.selected.size, 0)
})

function profileHarness(saveSettings, settings = { level: 'A2', voiceEngine: 'browser' }) {
  const level = { value: settings.level, disabled: false }
  const host = { innerHTML: '' }
  const notices = []
  const M = { settings: { ...settings }, progress: {}, profile: {}, nickname: 'Learner' }
  const context = isolatedModule('js/mobile/screens.js', {
    M, api: {}, ui: {}, tts: {}, saveSettings,
    $: (selector) => selector === '#profile-level' ? level : selector === '#screen-profile' ? host : null,
    $$: () => [], esc: String, icon: () => '', sleep: () => Promise.resolve(),
    toast: (message, type) => notices.push({ message, type }),
  }, 'bindProfile, renderProfile')
  context.subject.bindProfile(host)
  return { ...context.subject, level, host, M, notices }
}

for (const [name, save] of [
  ['empty failure response', async () => null],
  ['structured failure', async () => ({ ok: false, error: '保存未成功' })],
  ['network exception', async () => { throw new Error('网络中断') }],
]) {
  test(`difficulty ${name} restores the previous value and never reports success`, async () => {
    const h = profileHarness(save)
    h.level.value = 'B1'
    await h.level.onchange()
    assert.equal(h.level.value, 'A2')
    assert.equal(h.M.settings.level, 'A2')
    assert.equal(h.level.disabled, false)
    assert.equal(h.notices.length, 1)
    assert.equal(h.notices[0].type, 'bad')
  })
}

test('difficulty stays disabled while saving and uses the confirmed server value', async () => {
  let complete
  const h = profileHarness(() => new Promise((resolve) => { complete = resolve }))
  h.level.value = 'B1'
  const pending = h.level.onchange()
  assert.equal(h.level.disabled, true)
  assert.equal(h.M.settings.level, 'A2')
  complete({ level: 'B2' })
  await pending
  assert.equal(h.level.value, 'B2')
  assert.equal(h.M.settings.level, 'B2')
  assert.equal(h.level.disabled, false)
  assert.equal(h.notices[0].type, 'ok')
})

test('profile exposes model and voice configuration and does not promise unconfigured speech output', () => {
  const h = profileHarness(async () => null)
  h.renderProfile()
  assert.match(h.host.innerHTML, /href="\/\?settings=1"[^>]*aria-label="打开模型与语音设置"/)
  assert.match(h.host.innerHTML, /浏览器语音识别/)
  assert.match(h.host.innerHTML, /系统内置朗读已关闭/)
  assert.doesNotMatch(h.host.innerHTML, /未配置凭据，将使用浏览器语音|已就绪/)
})

test('configured voice profile describes credentials without claiming a verified connection', () => {
  const h = profileHarness(async () => null, { level: 'B1', voiceEngine: 'volc', volc: { configured: true } })
  h.renderProfile()
  assert.match(h.host.innerHTML, /豆包实时语音/)
  assert.match(h.host.innerHTML, /连接情况以通话中的麦克风检测为准/)
  assert.match(h.host.innerHTML, /语音凭据已填写/)
  assert.match(h.host.innerHTML, /API Key 和独立 TTS 权限，点读时验证/)
  assert.doesNotMatch(h.host.innerHTML, /实际可用性以连接测试为准/)
  assert.doesNotMatch(h.host.innerHTML, /已就绪/)
})

function linkedSettingsHarness(search) {
  const links = [{ hidden: true, href: '/mobile' }, { hidden: true, href: '/mobile' }]
  const opened = []
  const context = isolatedModule('js/main.js', {
    URLSearchParams, location: { search }, api: {}, state: {}, modes: {}, tts: {},
    ui: {
      $: () => null, $$: () => links, esc: String, icon: () => '',
      openModal: (name) => opened.push(name),
    },
  }, 'openLinkedSettings, D', { stripBoot: true })
  context.subject.D.modalSettings = {}
  return { ...context.subject, links, opened }
}

test('settings deep link opens the existing complete form and reveals fixed mobile return links', () => {
  const h = linkedSettingsHarness('?settings=1&return=https://example.invalid')
  assert.equal(h.openLinkedSettings(), true)
  assert.deepEqual(h.opened, ['modal-settings'])
  assert.ok(h.links.every((link) => !link.hidden && link.href === '/mobile'))
  const html = source('index.html')
  const returns = html.match(/<a[^>]*href="\/mobile"[^>]*data-return-mobile[^>]*>/g) || []
  assert.equal(returns.length, 2, 'return links remain available inside and after closing the modal')
})

test('ordinary legacy entry does not unexpectedly open settings', () => {
  const h = linkedSettingsHarness('')
  assert.equal(h.openLinkedSettings(), false)
  assert.deepEqual(h.opened, [])
  assert.ok(h.links.every((link) => link.hidden))
})
