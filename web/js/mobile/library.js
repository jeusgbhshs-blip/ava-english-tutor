/**
 * 英语书库：6 本公版经典，每本 5 个 10 分钟节选。
 * - 每天自动生成一节；同一自然日重复打开保持同一节。
 * - localStorage 记录用户进度、连续天数、完成情况。
 * - 一键入库并直接进入资料课；重点词同步到复习词库。
 */
import { $, esc, icon, toast, ui, M, postJSON } from './core.js'
import { characterById } from './core.js'
import { BOOK_LIBRARY } from './book-library.js'

const STORE_KEY = 'ava.book.library.v1'
const DAYS_PER_BOOK = 5
const DAILY_MINUTES = 10

function todayKey() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function yesterdayKey() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function freshState() {
  const books = {}
  for (const book of BOOK_LIBRARY) books[book.id] = { cursor: 0, completedDays: [] }
  return {
    version: 1,
    currentBookIndex: 0,
    books,
    today: null,
    lastStudyDate: '',
    streak: 0,
    totalMinutes: 0,
    totalCompleted: 0,
    createdAt: Date.now(),
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return freshState()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return freshState()
    const base = freshState()
    const books = { ...base.books }
    if (parsed.books && typeof parsed.books === 'object') {
      for (const book of BOOK_LIBRARY) {
        const entry = parsed.books[book.id]
        if (!entry) continue
        books[book.id] = {
          cursor: Math.max(0, Math.min(DAYS_PER_BOOK, Number(entry.cursor) || 0)),
          completedDays: Array.isArray(entry.completedDays)
            ? [...new Set(entry.completedDays.map((x) => Number(x)).filter((x) => x >= 0 && x < DAYS_PER_BOOK))]
            : [],
        }
      }
    }
    return {
      ...base,
      ...parsed,
      books,
      currentBookIndex: Math.max(0, Math.min(BOOK_LIBRARY.length - 1, Number(parsed.currentBookIndex) || 0)),
      streak: Math.max(0, Number(parsed.streak) || 0),
      totalMinutes: Math.max(0, Number(parsed.totalMinutes) || 0),
      totalCompleted: Math.max(0, Number(parsed.totalCompleted) || 0),
    }
  } catch {
    return freshState()
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state))
  } catch {
    /* 忽略 */
  }
}

function bookById(id) {
  return BOOK_LIBRARY.find((book) => book.id === id) || null
}

function currentBook(state) {
  return BOOK_LIBRARY[Math.max(0, Math.min(BOOK_LIBRARY.length - 1, state.currentBookIndex || 0))]
}

function nextBookWithRoom(state) {
  const start = Number(state.currentBookIndex) || 0
  for (let step = 1; step <= BOOK_LIBRARY.length; step += 1) {
    const index = (start + step) % BOOK_LIBRARY.length
    const book = BOOK_LIBRARY[index]
    const entry = state.books[book.id]
    if (entry && entry.cursor < DAYS_PER_BOOK) {
      state.currentBookIndex = index
      return book
    }
  }
  return null
}

function makeToday(state, book) {
  const entry = state.books[book.id] || { cursor: 0, completedDays: [] }
  const dayIndex = Math.min(DAYS_PER_BOOK - 1, Math.max(0, Number(entry.cursor) || 0))
  const day = book.days[dayIndex]
  state.today = {
    date: todayKey(),
    bookId: book.id,
    dayIndex,
    started: false,
    completed: false,
    docId: '',
    createdAt: Date.now(),
  }
  // 每进入一个新的自然日，cursor 前移，保证每天都有“新节选”
  entry.cursor = Math.min(DAYS_PER_BOOK, dayIndex + 1)
  state.books[book.id] = entry
  saveState(state)
  return { book, day, dayIndex }
}

/** 保证有今天的节选；同一天重复调用不改变。 */
function ensureToday() {
  const state = loadState()
  const date = todayKey()
  if (state.today && state.today.date === date) {
    const book = bookById(state.today.bookId)
    const day = book && book.days[state.today.dayIndex]
    if (book && day) return { state, book, day, dayIndex: state.today.dayIndex }
  }
  let book = currentBook(state)
  let entry = state.books[book.id]
  if (!entry || (entry.cursor >= DAYS_PER_BOOK && !state.today)) {
    const next = nextBookWithRoom(state)
    if (next) book = next
    else {
      // 6 本全部读过一轮：从第一本开始复习，重置 cursor，但保留 completedDays
      for (const item of BOOK_LIBRARY) state.books[item.id].cursor = 0
      state.currentBookIndex = 0
      book = BOOK_LIBRARY[0]
    }
  }
  return { state, ...makeToday(state, book) }
}

function touchStudy(state) {
  const today = todayKey()
  if (state.lastStudyDate === today) return
  state.streak = state.lastStudyDate === yesterdayKey() ? Math.max(1, state.streak + 1) : 1
  state.lastStudyDate = today
}

function markComplete(bookId, dayIndex) {
  const state = loadState()
  const book = bookById(bookId)
  const day = book && book.days[dayIndex]
  if (!book || !day) return false
  const entry = state.books[book.id] || { cursor: 0, completedDays: [] }
  const done = new Set(entry.completedDays || [])
  const firstTime = !done.has(dayIndex)
  done.add(dayIndex)
  entry.completedDays = [...done].sort((a, b) => a - b)
  state.books[book.id] = entry
  touchStudy(state)
  if (state.today && state.today.bookId === bookId && Number(state.today.dayIndex) === Number(dayIndex)) {
    state.today.completed = true
    state.today.started = true
  }
  if (firstTime) {
    state.totalCompleted = Math.max(0, Number(state.totalCompleted) || 0) + 1
    state.totalMinutes = Math.max(0, Number(state.totalMinutes) || 0) + DAILY_MINUTES
  }
  saveState(state)
  return firstTime
}

function dayTitle(book, dayIndex) {
  const day = book.days[dayIndex]
  return day ? `${book.titleZh} · Day ${dayIndex + 1} ${day.title}` : book.titleZh
}

function lessonText(book, dayIndex) {
  const day = book.days[dayIndex]
  if (!day) return ''
  const words = (book.focusWords || []).map((w) => `${w.word}${w.meaning ? ` (${w.meaning})` : ''}`).join(' · ')
  const patterns = (book.focusPatterns || []).map((p) => `- ${p}`).join('\n')
  return `${day.text}\n\n---\n今日重点词 Today's words\n${words}\n\n今日句型 Today's patterns\n${patterns}\n\nSource: Project Gutenberg public-domain text · 公版学习节选`
}

async function syncWords(book, dayIndex) {
  const words = (book.focusWords || []).map((w) => ({
    word: w.word,
    meaning: w.meaning || '',
    example: w.example || '',
    source: 'book',
    sourceTitle: `${book.titleZh} · Day ${dayIndex + 1}`,
  }))
  if (!words.length) return
  try {
    await postJSON('/api/review/add', { words, defaults: { source: 'book' } }, { timeoutMs: 12000 })
  } catch {
    /* 复习词库同步失败不影响上课 */
  }
}

function bookProgress(state, book) {
  const entry = state.books[book.id] || { cursor: 0, completedDays: [] }
  const opened = Math.min(DAYS_PER_BOOK, Number(entry.cursor) || 0)
  const completed = (entry.completedDays || []).length
  return { opened, completed, entry }
}

function dots(count, total = DAYS_PER_BOOK, active = 0) {
  return Array.from({ length: total }, (_, i) => `<i class="${i < count ? 'is-done' : i === active ? 'is-active' : ''}"></i>`).join('')
}

function renderDailyCard() {
  const { state, book, dayIndex } = ensureToday()
  const day = book.days[dayIndex]
  const completed = Boolean(state.today && state.today.completed)
  const started = Boolean(state.today && state.today.started)
  return `<div class="lib-daily ${completed ? 'is-done' : ''}">
    <div class="lib-daily-top">
      <span class="lib-kicker">${completed ? '今日已完成' : '今日 · 10 分钟'}</span>
      <span class="lib-streak">${state.streak > 0 ? `连续 ${state.streak} 天` : '从今天开始'}</span>
    </div>
    <div class="lib-daily-main">
      <div class="lib-daily-emoji">${book.id === 'odyssey' ? '🏛️' : book.id === 'gatsby' ? '🥂' : book.id === 'alice' ? '🐇' : book.id === 'carol' ? '🎄' : book.id === 'happyprince' ? '🕊️' : '🎁'}</div>
      <div class="lib-daily-copy">
        <strong>${esc(book.titleZh)} · Day ${dayIndex + 1}</strong>
        <span>${esc(book.title)} · ${esc(book.level)} · ${esc(day.title)}</span>
      </div>
      <div class="lib-daily-dots">${dots(dayIndex + (completed ? 1 : 0), DAYS_PER_BOOK, completed ? -1 : dayIndex)}</div>
    </div>
    <p class="lib-daily-focus">${esc((book.focusWords || []).slice(0, 3).map((w) => w.word).join(' · '))}</p>
    <div class="lib-daily-actions">
      ${completed
        ? `<button type="button" class="btn btn-ghost btn-sm" data-act="library-review">再看一遍</button>`
        : `<button type="button" class="btn btn-primary btn-sm" data-act="library-start">${started ? '继续今日带读' : '开始今日带读'}</button>`}
      <button type="button" class="btn btn-ghost btn-sm" data-act="library-open">书库</button>
      ${!completed && started ? '<button type="button" class="btn btn-ghost btn-sm" data-act="library-complete">标记完成</button>' : ''}
    </div>
  </div>`
}

/** 知识库侧栏里的书库卡片。 */
export function libraryBlockHtml() {
  return `<section class="kb-block kb-library" id="kb-library-block">
    <div class="kb-block-head"><span>英语书库</span><em>6 本 · 每天 10 分钟</em></div>
    <div id="kb-library-daily">${renderDailyCard()}</div>
  </section>`
}

function renderLibrarySheet() {
  const { state, book: todayBook, dayIndex: todayIndex } = ensureToday()
  const todayDone = Boolean(state.today && state.today.completed)
  const books = BOOK_LIBRARY.map((book) => {
    const { opened, completed, entry } = bookProgress(state, book)
    const isCurrent = todayBook.id === book.id
    const currentDay = Math.min(DAYS_PER_BOOK - 1, Number(entry.cursor) || 0)
    const finished = completed >= DAYS_PER_BOOK
    return `<article class="lib-book${isCurrent ? ' is-current' : ''}">
      <div class="lib-book-top">
        <span class="lib-book-level">${esc(book.level)}</span>
        <span class="lib-book-progress">${completed}/${DAYS_PER_BOOK} 天完成</span>
      </div>
      <h3>${esc(book.title)}</h3>
      <p class="lib-book-zh">${esc(book.titleZh)} · ${esc(book.author)}</p>
      <p class="lib-book-intro">${esc(book.introZh)}</p>
      <div class="lib-dots">${dots(opened, DAYS_PER_BOOK, finished ? -1 : currentDay)}</div>
      <div class="lib-book-actions">
        <button type="button" class="btn ${isCurrent ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="library-pick" data-book="${esc(book.id)}" ${isCurrent ? 'disabled' : ''}>
          ${isCurrent ? (todayDone ? '今日已完成' : `今日 Day ${todayIndex + 1}`) : '选这本'}
        </button>
        <span class="lib-book-note">${finished ? '已完成' : opened ? `已读 ${opened} 天` : '未开始'}</span>
      </div>
    </article>`
  }).join('')
  const completed = state.totalCompleted || 0
  const minutes = state.totalMinutes || 0
  return `<div class="library-sheet">
    <div class="lib-summary">
      <div><strong>${state.streak || 0}</strong><span>连续天数</span></div>
      <div><strong>${completed}</strong><span>完成节选</span></div>
      <div><strong>${minutes}</strong><span>累计分钟</span></div>
    </div>
    <div class="lib-flow">
      <span>① 老师带读</span><span>② 跟读纠音</span><span>③ 重点词句型</span><span>④ 标记完成</span>
    </div>
    ${renderDailyCard()}
    <div class="lib-shelf-title"><strong>六本经典</strong><span>公版原文节选 · 每本 5 天</span></div>
    <div class="lib-books">${books}</div>
    <p class="lib-foot">每读完一节，标记完成；第二天会自动出现下一节。重点词会进入「复习」词库。</p>
  </div>`
}

export function refreshLibraryCard() {
  const host = document.getElementById('kb-library-daily')
  if (host) host.innerHTML = renderDailyCard()
}

function refreshLibraryUi() {
  refreshLibraryCard()
  const host = document.getElementById('kb-library-daily')
  if (host) host.innerHTML = renderDailyCard()
  const body = document.querySelector('.sheet-body')
  if (body && body.querySelector('.library-sheet')) {
    body.innerHTML = renderLibrarySheet()
    bindSheet(body)
  }
}

function bindSheet(body) {
  if (!body || body.dataset.libBound === '1') return
  body.dataset.libBound = '1'
  body.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target || !body.contains(target)) return
    const act = target.getAttribute('data-act')
    if (act === 'library-start' || act === 'library-review') await startTodayLesson()
    else if (act === 'library-complete') completeToday()
    else if (act === 'library-pick') pickBook(target.getAttribute('data-book'))
    else if (act === 'library-open') openLibrarySheet()
  })
}

export function openLibrarySheet() {
  ui.openSheet('英语书库', renderLibrarySheet())
  bindSheet(document.querySelector('.sheet-body'))
}

function pickBook(bookId) {
  const state = loadState()
  const index = BOOK_LIBRARY.findIndex((book) => book.id === bookId)
  if (index < 0) return
  state.currentBookIndex = index
  const book = BOOK_LIBRARY[index]
  const hasToday = state.today && state.today.date === todayKey() && !state.today.started
  if (hasToday && state.today.bookId === book.id) {
    refreshLibraryUi()
    return
  }
  if (hasToday) {
    // 尚未开始今日课：允许换书；把原书被今日预先移动的 cursor 退回去
    const oldId = state.today.bookId
    const oldEntry = state.books[oldId]
    if (oldEntry) oldEntry.cursor = Math.max(0, (Number(oldEntry.cursor) || 1) - 1)
    state.today = null
  }
  saveState(state)
  ensureToday()
  refreshLibraryUi()
  toast(`已选择《${book.titleZh}》，明天从这本书继续`, 'ok', 2200)
}

/** 开始今日带读：入库 → 直接进入资料课。 */
export async function startTodayLesson() {
  const { state, book, dayIndex } = ensureToday()
  const title = dayTitle(book, dayIndex)
  let docId = state.today && state.today.docId ? String(state.today.docId) : ''
  if (!docId) {
    try {
      const res = await postJSON(
        '/api/kb/save-text',
        { name: title, title, text: lessonText(book, dayIndex), kind: 'txt', source: 'library' },
        { timeoutMs: 60000 },
      )
      if (!res || res.ok === false || !res.doc) throw new Error((res && res.error) || '节选入库失败')
      docId = String(res.doc.id)
      const latest = loadState()
      if (latest.today && latest.today.date === todayKey()) {
        latest.today.docId = docId
        latest.today.started = true
        touchStudy(latest)
        saveState(latest)
      }
    } catch (err) {
      toast((err && err.message) || '节选入库失败，请重试', 'bad', 3400)
      return false
    }
  } else {
    const latest = loadState()
    if (latest.today && latest.today.date === todayKey()) {
      latest.today.started = true
      touchStudy(latest)
      saveState(latest)
    }
  }
  void syncWords(book, dayIndex)
  if (typeof ui.closeSheet === 'function') ui.closeSheet()
  if (typeof ui.closeKbPanel === 'function') ui.closeKbPanel()
  const character = characterById(M.activeCharId)
  if (typeof ui.openCall === 'function') {
    ui.openCall(character, 0, { kbMode: 'grounded', kbDocIds: [docId], kbDocs: [title] })
  }
  return true
}

/** 标记今日完成：进入统计与连续天数。 */
export function completeToday() {
  const { state, book, dayIndex } = ensureToday()
  if (!state.today || state.today.date !== todayKey()) return false
  const first = markComplete(book.id, dayIndex)
  refreshLibraryUi()
  toast(first ? `完成 ${book.titleZh} Day ${dayIndex + 1}，累计 ${loadState().totalCompleted} 节` : '今天已经完成过啦', first ? 'ok' : 'info', 2600)
  return first
}

export function libraryStats() {
  const state = loadState()
  const { book, dayIndex } = ensureToday()
  return { state, book, dayIndex, today: state.today }
}
