/**
 * Ava 手机版 · 趣玩「词义配对」小游戏
 * 词库来自 /api/content 的 vocabTopics（英文单词 + 中文释义），每轮 6 对；
 * 点一个英文再点一个中文，配对成功消除并计分；全对给完成反馈，可再来一局。
 * 无外部资源，纯 DOM + CSS 动画，手机端点按可玩。
 * @module mobile/games
 */
import { esc, icon, M } from './core.js'

const PAIRS_PER_ROUND = 6
const SCORE_KEY = 'ava.mobile.play.score'
const MATCH_SCORE = 10
const ROUND_BONUS = 20

/** 后端词库不可用时的内置词库（避免小游戏空白）。 */
const FALLBACK_WORDS = [
  { word: 'delicious', meaning: '美味的' },
  { word: 'journey', meaning: '旅程；旅行' },
  { word: 'curious', meaning: '好奇的' },
  { word: 'exhibition', meaning: '展览' },
  { word: 'confident', meaning: '自信的' },
  { word: 'schedule', meaning: '日程；安排' },
  { word: 'creative', meaning: '有创意的' },
  { word: 'recommend', meaning: '推荐' },
  { word: 'convenient', meaning: '方便的' },
  { word: 'adventure', meaning: '冒险；奇遇' },
  { word: 'practice', meaning: '练习' },
  { word: 'encourage', meaning: '鼓励' },
  { word: 'neighborhood', meaning: '街区；社区' },
  { word: 'appreciate', meaning: '感激；欣赏' },
  { word: 'opportunity', meaning: '机会' },
  { word: 'conversation', meaning: '对话；交谈' },
  { word: 'challenge', meaning: '挑战' },
  { word: 'progress', meaning: '进步' },
]

function shuffle(list) {
  const arr = list.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

function readScore() {
  try {
    const value = Number(localStorage.getItem(SCORE_KEY))
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  } catch {
    return 0
  }
}

function writeScore(value) {
  try {
    localStorage.setItem(SCORE_KEY, String(Math.max(0, Math.floor(value))))
  } catch {
    /* 忽略 */
  }
}

/** 从 /api/content 的 vocabTopics 汇总单词（去重、过滤残缺数据）。 */
export function buildWordBank(content) {
  const source = content && Array.isArray(content.vocabTopics) ? content.vocabTopics : []
  const seenWord = new Set()
  const seenMeaning = new Set()
  const words = []
  for (const topic of source) {
    const list = topic && Array.isArray(topic.words) ? topic.words : []
    for (const item of list) {
      if (!item || typeof item.word !== 'string' || typeof item.meaning !== 'string') continue
      const word = item.word.trim()
      const meaning = item.meaning.trim()
      if (!word || !meaning) continue
      const key = word.toLowerCase()
      if (seenWord.has(key) || seenMeaning.has(meaning)) continue
      seenWord.add(key)
      seenMeaning.add(meaning)
      words.push({ word, meaning, phonetic: typeof item.phonetic === 'string' ? item.phonetic : '' })
    }
  }
  return words.length >= PAIRS_PER_ROUND ? words : FALLBACK_WORDS.slice()
}

/**
 * 挂载词义配对游戏。
 * @param {Element|null} host 容器（renderPlay 的 #word-match-card）
 */
export function mountPlay(host) {
  if (!host || host.nodeType !== 1) return
  if (typeof host.__matchCleanup === 'function') {
    try {
      host.__matchCleanup()
    } catch {
      /* 忽略 */
    }
  }

  const pool = buildWordBank(M.content)
  const state = {
    score: readScore(),
    round: 0,
    matched: 0,
    selected: null,
    lock: false,
    finished: false,
    timers: [],
    pairs: [],
    roundToken: 0,
  }

  host.innerHTML = `
    <div class="game-head">
      <div>
        <div class="section-title" style="font-size:14px">${icon('game')}词义配对</div>
        <div class="game-sub">先点英文，再点它的中文释义，配成一对</div>
      </div>
      <span class="game-score">${icon('star')}<span id="match-score">${state.score}</span> 分</span>
    </div>
    <div class="match-grid" id="match-grid" role="group" aria-label="词义配对棋盘"></div>
    <div class="game-actions">
      <button type="button" class="btn btn-ghost btn-sm" id="match-new">${icon('refresh')}再来一局</button>
      <span class="game-msg" id="match-msg" role="status" aria-live="polite">准备好就开始吧</span>
    </div>`

  const grid = host.querySelector('#match-grid')
  const msgEl = host.querySelector('#match-msg')
  const scoreEl = host.querySelector('#match-score')
  const newBtn = host.querySelector('#match-new')
  if (!grid || !msgEl || !scoreEl || !newBtn) return

  const addTimer = (fn, ms) => {
    const id = setTimeout(() => {
      state.timers = state.timers.filter((t) => t !== id)
      fn()
    }, ms)
    state.timers.push(id)
    return id
  }

  const clearTimers = () => {
    state.timers.forEach((id) => clearTimeout(id))
    state.timers = []
  }

  const updateScore = () => {
    scoreEl.textContent = String(state.score)
  }

  const setMessage = (text, ok = false) => {
    msgEl.textContent = text
    msgEl.classList.toggle('ok', !!ok)
  }

  const progressText = () => `本轮 ${state.matched} / ${PAIRS_PER_ROUND}`

  const updateProgress = () => {
    if (state.finished) return
    setMessage(progressText())
  }

  const clearSelection = () => {
    if (state.selected) state.selected.classList.remove('is-selected')
    state.selected = null
  }

  const selectTile = (tile) => {
    clearSelection()
    state.selected = tile
    tile.classList.add('is-selected')
  }

  const finishRound = () => {
    state.finished = true
    state.score += ROUND_BONUS
    writeScore(state.score)
    updateScore()
    setMessage(`太棒了！这一局全部配对成功 🎉 +${ROUND_BONUS} 分，再来一局？`, true)
    newBtn.innerHTML = `${icon('refresh')}再来一局`
    spawnConfetti()
  }

  const spawnConfetti = () => {
    const old = host.querySelector('.match-confetti')
    if (old) old.remove()
    const layer = document.createElement('div')
    layer.className = 'match-confetti'
    layer.setAttribute('aria-hidden', 'true')
    const colors = ['#6ff2dd', '#b49cff', '#ffc57a', '#5eea9d', '#ff8fa3']
    for (let i = 0; i < 16; i++) {
      const bit = document.createElement('i')
      bit.style.left = Math.round(Math.random() * 94) + '%'
      bit.style.background = colors[i % colors.length]
      bit.style.setProperty('--dx', Math.round((Math.random() - 0.5) * 90) + 'px')
      bit.style.setProperty('--rot', Math.round(180 + Math.random() * 540) + 'deg')
      bit.style.animationDelay = (Math.random() * 0.22).toFixed(2) + 's'
      layer.appendChild(bit)
    }
    host.appendChild(layer)
    addTimer(() => layer.remove(), 1600)
  }

  const startRound = () => {
    clearTimers()
    state.roundToken += 1
    state.round += 1
    state.matched = 0
    state.lock = false
    state.finished = false
    clearSelection()
    const picks = shuffle(pool).slice(0, PAIRS_PER_ROUND)
    state.pairs = picks
    const tiles = []
    picks.forEach((pair, index) => {
      tiles.push({ pair: index, lang: 'en', text: pair.word })
      tiles.push({ pair: index, lang: 'zh', text: pair.meaning })
    })
    grid.innerHTML = shuffle(tiles)
      .map(
        (tile) => `<button type="button" class="match-tile ${tile.lang}" data-pair="${tile.pair}" data-lang="${tile.lang}"
          aria-label="${tile.lang === 'en' ? '英文单词' : '中文释义'}：${esc(tile.text)}">${esc(tile.text)}</button>`,
      )
      .join('')
    newBtn.innerHTML = `${icon('refresh')}换一局`
    setMessage(progressText())
    updateScore()
  }

  grid.addEventListener('click', (event) => {
    const tile = event.target instanceof Element ? event.target.closest('.match-tile') : null
    if (!tile || !grid.contains(tile) || state.lock || state.finished) return
    if (tile.classList.contains('is-done')) return
    if (!state.selected) {
      selectTile(tile)
      return
    }
    if (tile === state.selected) {
      clearSelection()
      return
    }
    // 同语言：改选，不算错
    if (tile.dataset.lang === state.selected.dataset.lang) {
      selectTile(tile)
      return
    }
    const first = state.selected
    const second = tile
    if (first.dataset.pair === second.dataset.pair) {
      first.classList.remove('is-selected')
      first.classList.add('is-done')
      second.classList.add('is-done')
      state.selected = null
      state.matched += 1
      state.score += MATCH_SCORE
      writeScore(state.score)
      updateScore()
      if (state.matched >= PAIRS_PER_ROUND) {
        finishRound()
      } else {
        setMessage(`配对成功 +${MATCH_SCORE} 分 · ${progressText()}`)
        addTimer(updateProgress, 900)
      }
      return
    }
    // 配错：双方抖动后恢复
    state.lock = true
    first.classList.remove('is-selected')
    first.classList.add('is-wrong')
    second.classList.add('is-wrong')
    setMessage('这两个不是一对，再想想～')
    const token = state.roundToken
    addTimer(() => {
      first.classList.remove('is-wrong')
      second.classList.remove('is-wrong')
      state.lock = false
      if (token === state.roundToken) updateProgress()
    }, 480)
  })

  newBtn.addEventListener('click', () => startRound())

  host.__game = {
    getState: () => ({
      score: state.score,
      round: state.round,
      matched: state.matched,
      total: PAIRS_PER_ROUND,
      finished: state.finished,
      words: state.pairs.map((p) => p.word),
    }),
    newRound: startRound,
  }

  host.__matchCleanup = () => {
    clearTimers()
    grid.onclick = null
    host.__game = null
    host.__matchCleanup = null
  }

  startRound()
}
