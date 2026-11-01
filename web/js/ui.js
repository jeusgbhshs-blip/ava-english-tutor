/**
 * Ava · 通用 UI 层
 * 职责：DOM/转义辅助、内联图标、Toast、弹窗管理、教练反馈渲染、进度面板渲染、彩带。
 * 所有动态文本一律经 esc() 转义；本模块不直接 import 业务 api/speech。
 *
 * @module ui
 */

/* -------------------------------- DOM 辅助 -------------------------------- */

/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement|null} */
export const $ = (sel, root = document) => root.querySelector(sel)
/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement[]} */
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

/**
 * HTML 转义，所有用户/模型内容必须经过它。
 * @param {unknown} value
 * @returns {string}
 */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 内联 SVG 图标（symbol 定义在 index.html 的 svg.sprite 中）。
 * @param {string} name
 * @param {string} [cls]
 * @returns {string}
 */
export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${esc(name)}"></use></svg>`
}

/** @param {number} ms @returns {Promise<void>} */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 简易防抖。
 * @template {(...args:any[])=>any} F
 * @param {F} fn @param {number} [wait=300] @returns {(...args: Parameters<F>)=>void}
 */
export function debounce(fn, wait = 300) {
  let timer = null
  return (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}

/** 数字限制在 [min,max]。 */
export function clamp(n, min, max) {
  const v = Number(n)
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, v))
}

/** 将分钟数格式化为「1.5 小时 / 32 分钟」。 */
export function formatMinutes(minutes) {
  const m = Math.max(0, Number(minutes) || 0)
  if (m < 60) return String(Math.round(m))
  const h = m / 60
  return h >= 10 ? String(Math.round(h)) : h.toFixed(1)
}

/** 分钟展示单位：不足 60 分钟为「分钟」，否则为「小时」。 */
export function minutesUnit(minutes) {
  return (Number(minutes) || 0) < 60 ? '分钟' : '小时'
}

/** 本地 YYYY-MM-DD。 */
export function dateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/* -------------------------------- Toast ---------------------------------- */

let toastSeq = 0

/**
 * 右下角轻提示。
 * @param {string} message
 * @param {'info'|'ok'|'bad'} [type='info']
 * @param {number} [ms=3200]
 * @param {(()=>void)|null} [onClick] 可选点击回调（例如打开教练抽屉）
 * @returns {void}
 */
export function toast(message, type = 'info', ms = 3200, onClick = null) {
  const box = document.getElementById('toasts')
  if (!box) return
  const id = `toast-${++toastSeq}`
  const iconName = type === 'ok' ? 'check-circle' : type === 'bad' ? 'alert' : 'sparkles'
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.id = id
  el.setAttribute('role', 'status')
  el.innerHTML = `${icon(iconName)}<span>${esc(message)}</span>`
  if (typeof onClick === 'function') {
    el.classList.add('is-clickable')
    el.setAttribute('role', 'button')
    el.addEventListener('click', () => {
      try {
        onClick()
      } finally {
        el.classList.add('is-out')
        setTimeout(() => el.remove(), 260)
      }
    })
  }
  box.appendChild(el)
  // 最多保留 3 条
  while (box.children.length > 3) box.firstElementChild.remove()
  setTimeout(() => {
    el.classList.add('is-out')
    setTimeout(() => el.remove(), 280)
  }, Math.max(1200, ms))
}

/**
 * 收起所有「可点击」Toast（例如移动端点开教练抽屉后，反馈提醒不再遮挡内容）。
 * @returns {void}
 */
export function dismissClickableToasts() {
  const box = document.getElementById('toasts')
  if (!box) return
  box.querySelectorAll('.toast.is-clickable').forEach((el) => {
    el.classList.add('is-out')
    setTimeout(() => el.remove(), 260)
  })
}

/* -------------------------------- 弹窗 ----------------------------------- */

let lastFocused = null

/**
 * 打开弹窗（display 由 [hidden] 控制）。
 * @param {string} id
 */
export function openModal(id) {
  const layer = document.getElementById(id)
  if (!layer) return
  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  layer.hidden = false
  const focusable = layer.querySelector(
    'input:not([type="hidden"]), select, textarea, button.btn-primary, [data-autofocus]',
  )
  if (focusable instanceof HTMLElement) setTimeout(() => focusable.focus(), 60)
}

/**
 * 关闭弹窗。
 * @param {string} id
 */
export function closeModal(id) {
  const layer = document.getElementById(id)
  if (!layer || layer.hidden) return
  layer.hidden = true
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus()
  lastFocused = null
}

/** 关闭所有 modal-layer。 */
export function closeAllModals() {
  $$('.modal-layer').forEach((el) => {
    el.hidden = true
  })
}

/** 全局弹窗基础交互：遮罩/关闭按钮/Escape。应用启动时调用一次。 */
export function bindModalChrome() {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-close]') : null
    if (target) {
      const id = target.getAttribute('data-close')
      if (id) closeModal(id)
    }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    const open = $$('.modal-layer').filter((el) => !el.hidden)
    if (open.length) {
      const top = open[open.length - 1]
      if (top.id) closeModal(top.id)
      event.preventDefault()
    }
  })
}

/* ------------------------------ 教练反馈卡片 ------------------------------ */

/**
 * 渲染右侧「教练反馈」区域。
 * @param {any} feedback chatStream 的 feedback 载荷
 * @param {{explainChinese?:boolean, teacherName?:string, newWordCount?:number}} [opts]
 * @returns {string} HTML
 */
export function renderFeedback(feedback, opts = {}) {
  const fb = feedback && typeof feedback === 'object' ? feedback : null
  if (!fb) return renderFeedbackEmpty()
  const explain = opts.explainChinese !== false
  const chineseHelp = fb.chineseHelp && typeof fb.chineseHelp === 'object' ? fb.chineseHelp : null
  const followResult = opts.followResult && typeof opts.followResult === 'object' ? opts.followResult : null
  const corrections = Array.isArray(fb.corrections) ? fb.corrections.filter((c) => c && (c.original || c.corrected)) : []
  const better = Array.isArray(fb.better) ? fb.better.filter((b) => b && (b.original || b.better)) : []
  const newWords = Array.isArray(fb.newWords) ? fb.newWords.filter((w) => w && w.word) : []
  const encouragement = typeof fb.encouragement_zh === 'string' ? fb.encouragement_zh.trim() : ''
  const followUp = typeof fb.followUp === 'string' ? fb.followUp.trim() : ''
  if (!corrections.length && !better.length && !newWords.length && !encouragement && !chineseHelp) {
    return renderFeedbackEmpty('这一轮没有需要纠正的地方，继续保持！')
  }

  const cards = []
  // 中文求助卡固定放在最顶部（v1.2 §B3）
  if (chineseHelp) {
    cards.push(renderChineseHelpCard(chineseHelp, { explainChinese: explain, followResult }))
  }
  for (const c of corrections) {
    const zh = explain && c.explanation_zh ? `<p class="fb-zh">${esc(c.explanation_zh)}</p>` : ''
    cards.push(`
      <article class="fb-card fb-correction">
        <span class="fb-label">${icon('alert')}纠正</span>
        <p class="fb-line"><span class="fb-orig">${esc(c.original || '—')}</span><span class="fb-arrow">→</span><span class="fb-corrected">${esc(c.corrected || '—')}</span></p>
        ${zh}
      </article>`)
  }
  for (const b of better) {
    const zh = explain && b.why_zh ? `<p class="fb-zh">${esc(b.why_zh)}</p>` : ''
    cards.push(`
      <article class="fb-card fb-better">
        <span class="fb-label">${icon('sparkles')}更好的说法</span>
        <p class="fb-line"><span class="fb-arrow">${esc(b.original || '')}${b.original ? ' →' : ''}</span><span class="fb-better-text">${esc(b.better || '')}</span></p>
        ${zh}
      </article>`)
  }
  if (newWords.length) {
    const rows = newWords
      .map((w) => {
        const phon = w.phonetic ? `<span class="fb-word-phon">${esc(w.phonetic)}</span>` : ''
        const meaning = w.meaning ? `<span class="fb-word-meaning">${esc(w.meaning)}</span>` : ''
        const example = w.example ? `<p class="fb-word-example">${esc(w.example)}</p>` : ''
        return `<div class="fb-word">
          <div class="fb-word-top"><span class="fb-word-name">${esc(w.word)}</span>${phon}${meaning}</div>
          ${example}
        </div>`
      })
      .join('')
    cards.push(`
      <article class="fb-card fb-newwords">
        <span class="fb-label">${icon('book')}生词 · 已加入词库</span>
        ${rows}
        <p class="fb-foot-note">${icon('refresh')}已加入间隔复习，可在「学习进度」里查看到期复习</p>
      </article>`)
  }
  if (encouragement) {
    cards.push(`
      <article class="fb-card fb-encourage">
        <span class="fb-label">${icon('flame')}${esc(opts.teacherName || 'Ava')} 的鼓励</span>
        <p class="fb-zh" style="font-size:12px;color:var(--text)">${esc(encouragement)}</p>
        ${followUp ? `<p class="fb-line" style="color:var(--accent);font-size:11.5px">${esc(followUp)}</p>` : ''}
      </article>`)
  }
  return `
    <div class="fb-head">
      <span class="fb-title">${icon('sparkles')}教练反馈</span>
      <span class="fb-count">${cards.length} 条</span>
    </div>
    <div class="fb-list">${cards.join('')}</div>`
}

/**
 * 中文求助卡（SPEC v1.2 §B2 / §B3）。
 * @param {{original_zh?:string, english?:string, chunks?:Array<{en?:string,zh?:string}>, tips_zh?:string}} help
 * @param {{explainChinese?:boolean, followResult?:any}} [opts]
 * @returns {string}
 */
function renderChineseHelpCard(help, opts = {}) {
  const original = String(help.original_zh || '').trim()
  const english = String(help.english || '').trim()
  const chunks = Array.isArray(help.chunks) ? help.chunks.filter((c) => c && (c.en || c.zh)) : []
  const tips = String(help.tips_zh || '').trim()
  const follow = opts.followResult && typeof opts.followResult === 'object' ? opts.followResult : null
  const followHtml = follow
    ? `<div class="zh-follow-result">
        <div class="zh-follow-top">${icon('headphones')}<span>跟读得分</span><span class="zh-follow-score">${esc(Number(follow.score) || 0)}</span><span>分</span><span class="score-stars">${renderStars(follow.stars)}</span></div>
        ${
          Array.isArray(follow.words) && follow.words.length
            ? `<div class="word-status">${follow.words
                .map(
                  (w) =>
                    `<span class="w-chip ${w.status === 'ok' ? 'ok' : w.status === 'close' ? 'close' : 'miss'}">${esc(w.text)}</span>`,
                )
                .join('')}</div>`
            : ''
        }
        ${
          Array.isArray(follow.tips_zh) && follow.tips_zh.length
            ? `<ul class="tips-list">${follow.tips_zh
                .slice(0, 2)
                .map((t) => `<li>${esc(t)}</li>`)
                .join('')}</ul>`
            : ''
        }
      </div>`
    : ''
  const chunkHtml = chunks.length
    ? `<div class="section-label" style="margin-top:2px">${icon('book')}意群拆解</div>
       <div class="zh-chunks">${chunks
         .map(
           (c) =>
             `<div class="zh-chunk"><span class="en">${esc(c.en || '')}</span><span class="zh">${esc(c.zh || '')}</span></div>`,
         )
         .join('')}</div>`
    : ''
  return `<article class="fb-card fb-chinese">
    <span class="fb-label">${icon('chat')}中文求助 · 英文这样说</span>
    ${original ? `<div class="zh-you"><span class="zh-tag">你想说</span><span>${esc(original)}</span></div>` : ''}
    ${
      english
        ? `<div class="zh-eng">
            <div class="zh-eng-text">${esc(english)}</div>
            <div class="zh-eng-actions">
              <button type="button" class="icon-action" data-speak="${esc(english)}" title="朗读这句英文" aria-label="朗读这句英文">${icon('volume')}</button>
              <button type="button" class="btn btn-mini accent" data-follow="${esc(english)}">${icon('mic')}跟我读</button>
            </div>
          </div>`
        : ''
    }
    ${chunkHtml}
    ${tips && opts.explainChinese !== false ? `<p class="zh-tips">${esc(tips)}</p>` : ''}
    ${followHtml}
  </article>`
}

/**
 * 豆包语音模式下的「专注对话」占位（v1.5 §B5）：不展示逐轮纠错。
 * @returns {string}
 */
export function renderFeedbackQuiet() {
  return `
    <div class="fb-head">
      <span class="fb-title">${icon('chat')}专注对话</span>
    </div>
    <div class="fb-empty fb-quiet">
      ${icon('sparkles')}
      <span>专注对话模式 · 结束对话后可看总结。先和 Ava 自然聊天，纠错和重点单词都会整理进总结与今日单词表。</span>
    </div>`
}

/**
 * 反馈区空状态。
 * @param {string} [hint]
 * @returns {string}
 */
export function renderFeedbackEmpty(hint) {
  return `
    <div class="fb-head">
      <span class="fb-title">${icon('sparkles')}教练反馈</span>
    </div>
    <div class="fb-empty">
      ${icon('bulb')}
      <span>${esc(hint || '和 Ava 说一句英文，这里会显示纠正、更好的说法和生词。')}</span>
    </div>`
}

/* ------------------------------ 进度面板渲染 ------------------------------ */

/**
 * 从 content 构建「单词 → 释义/音标」映射，供词库展示。
 * @param {any} content
 * @returns {Record<string, {phonetic?:string, meaning?:string, example?:string, exampleZh?:string}>}
 */
export function wordMetaFromContent(content) {
  /** @type {Record<string, any>} */
  const map = {}
  const topics = content && Array.isArray(content.vocabTopics) ? content.vocabTopics : []
  for (const topic of topics) {
    const words = topic && Array.isArray(topic.words) ? topic.words : []
    for (const w of words) {
      if (!w || !w.word) continue
      map[String(w.word).toLowerCase()] = {
        phonetic: w.phonetic || '',
        meaning: w.meaning || '',
        example: w.example || '',
        exampleZh: w.exampleZh || '',
      }
    }
  }
  return map
}

/**
 * 进度弹窗：四张统计卡。
 * @param {any} p progress
 * @returns {string}
 */
export function renderProgressStats(p) {
  const progress = p && typeof p === 'object' ? p : {}
  const items = [
    { label: '连续天数', value: Number(progress.streak) || 0, unit: '天', icon: 'fire', cls: 'warm' },
    { label: '累计句子', value: Number(progress.totalTurns) || 0, unit: '句', icon: 'chat', cls: '' },
    { label: '掌握单词', value: Number(progress.masteredWords) || 0, unit: '个', icon: 'trophy', cls: 'ok' },
    {
      label: '学习时长',
      value: formatMinutes(progress.totalMinutes),
      unit: minutesUnit(progress.totalMinutes),
      icon: 'clock',
      cls: 'violet',
    },
  ]
  return items
    .map(
      (it) => `<div class="stat-card">
        <span class="stat-icon ${it.cls}">${icon(it.icon)}</span>
        <span class="stat-value">${esc(it.value)}<small>${esc(it.unit)}</small></span>
        <span class="stat-label">${esc(it.label)}</span>
      </div>`,
    )
    .join('')
}

/**
 * 最近 7 天柱状图。
 * @param {any} p progress
 * @returns {string}
 */
export function renderProgressChart(p) {
  const progress = p && typeof p === 'object' ? p : {}
  const days = Array.isArray(progress.days) ? progress.days : []
  const byDate = {}
  for (const d of days) {
    if (d && d.date) byDate[String(d.date)] = d
  }
  const now = new Date()
  const cols = []
  const week = ['日', '一', '二', '三', '四', '五', '六']
  let max = 1
  /** @type {{key:string, turns:number, isToday:boolean, label:string, weekday:string}[]} */
  const cells = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = dateKey(d)
    const turns = Math.max(0, Number(byDate[key] && byDate[key].turns) || 0)
    if (turns > max) max = turns
    cells.push({
      key,
      turns,
      isToday: i === 0,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      weekday: week[d.getDay()],
    })
  }
  for (const c of cells) {
    const pct = c.turns <= 0 ? 0 : Math.max(4, Math.round((c.turns / max) * 100))
    const classes = ['chart-bar']
    if (!pct) classes.push('is-zero')
    if (c.isToday && pct) classes.push('is-today')
    cols.push(`
      <div class="chart-col" title="${esc(c.label)} 周${esc(c.weekday)}：${c.turns} 句">
        ${c.turns > 0 ? `<span class="chart-val">${c.turns}</span>` : ''}
        <div class="chart-bar-wrap"><div class="${classes.join(' ')}" style="height:${pct}%"></div></div>
        <span class="chart-label ${c.isToday ? 'is-today' : ''}">${c.isToday ? '今天' : esc(c.label)}</span>
      </div>`)
  }
  return cols.join('')
}

/**
 * 词库列表（到期优先）。
 * @param {any} p progress
 * @param {Record<string, any>} meta wordMetaFromContent 结果
 * @param {number} [limit=30]
 * @returns {string}
 */
export function renderWordbank(p, meta = {}, limit = 30) {
  const progress = p && typeof p === 'object' ? p : {}
  const words = progress.words && typeof progress.words === 'object' ? progress.words : {}
  const entries = Object.entries(words)
  if (!entries.length) {
    return `<div class="empty-state">${icon('book')}<strong>词库还是空的</strong><span>和 Ava 对话时出现的新单词会自动收进这里。</span></div>`
  }
  const nowTs = Date.now()
  entries.sort((a, b) => {
    const aDue = (Number(a[1] && a[1].due) || 0) <= nowTs ? 0 : 1
    const bDue = (Number(b[1] && b[1].due) || 0) <= nowTs ? 0 : 1
    if (aDue !== bDue) return aDue - bDue
    return (Number(a[1] && a[1].due) || 0) - (Number(b[1] && b[1].due) || 0)
  })
  return entries
    .slice(0, limit)
    .map(([word, rec]) => {
      const info = meta[String(word).toLowerCase()] || {}
      const due = (Number(rec && rec.due) || 0) <= nowTs
      const box = Number(rec && rec.box) || 0
      return `<div class="wordbank-row">
        <span class="wordbank-word">${esc(word)}</span>
        <span class="wordbank-meaning">${esc(info.meaning || '')}</span>
        <span class="box-pill ${due ? 'due' : ''}">${due ? '到期' : `Box ${box}`}</span>
      </div>`
    })
    .join('')
}

/** 渲染 1–5 星。 */
export function renderStars(n, total = 5) {
  const count = clamp(Math.round(Number(n) || 0), 0, total)
  let html = ''
  for (let i = 1; i <= total; i++) html += icon('star', i <= count ? 'on' : '')
  return html
}

/* --------------------------- v1.1 总结 / 单词表 --------------------------- */

/**
 * 结束对话总结弹窗正文（SPEC v1.1 §B1）。
 * @param {any} summary POST /api/summary 的返回
 * @param {{explainChinese?:boolean, teacherName?:string}} [opts]
 * @returns {string} HTML
 */
export function renderSummary(summary, opts = {}) {
  const s = summary && typeof summary === 'object' ? summary : {}
  const explain = opts.explainChinese !== false
  const topics = Array.isArray(s.topics_zh) ? s.topics_zh.filter(Boolean).map(String) : []
  const strengths = Array.isArray(s.strengths_zh) ? s.strengths_zh.filter(Boolean).map(String) : []
  const improvements = Array.isArray(s.improvements_zh) ? s.improvements_zh.filter(Boolean).map(String) : []
  const corrections = Array.isArray(s.corrections)
    ? s.corrections.filter((c) => c && (c.original || c.corrected))
    : []
  const keyWords = Array.isArray(s.keyWords) ? s.keyWords.filter((w) => w && w.word) : []
  const added = Number(s.addedCount) || 0
  const demoTag = s.demo ? '<span class="sum-demo">演示总结</span>' : ''

  const hero = `
    <div class="sum-hero">
      ${icon('sparkles')}
      <p>${esc(s.summary_zh || '这次对话的总结已经整理好了。')}</p>
    </div>`

  const meta = topics.length
    ? `<div class="sum-meta"><div class="sum-topics">${topics.map((t) => `<span class="sum-topic">${esc(t)}</span>`).join('')}</div>${demoTag}</div>`
    : `<div class="sum-meta">${demoTag}</div>`

  const cols =
    strengths.length || improvements.length
      ? `<div class="sum-cols">
        ${strengths.length ? `<div class="sum-list ok"><h4>${icon('check-circle')}做得好的地方</h4><ul>${strengths.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
        ${improvements.length ? `<div class="sum-list warn"><h4>${icon('bulb')}可以更自然的地方</h4><ul>${improvements.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
      </div>`
      : ''

  const corrHtml = corrections.length
    ? `<div class="sum-section">
        <div class="sum-section-title">${icon('alert')}这次的纠错<span class="spacer">${corrections.length} 条</span></div>
        <div class="sum-corr-list">${corrections
          .map(
            (c) => `<article class="fb-card fb-correction">
              <p class="fb-line"><span class="fb-orig">${esc(c.original || '—')}</span><span class="fb-arrow">→</span><span class="fb-corrected">${esc(c.corrected || '—')}</span></p>
              ${explain && c.explanation_zh ? `<p class="fb-zh">${esc(c.explanation_zh)}</p>` : ''}
            </article>`,
          )
          .join('')}</div>
      </div>`
    : ''

  const kwHtml = keyWords.length
    ? `<div class="sum-section">
        <div class="sum-section-title">${icon('book')}重点单词<span class="spacer">${keyWords.length} 个 · 点 🔊 朗读</span></div>
        <div class="kw-grid">${keyWords
          .map(
            (w) => `<div class="kw-card">
              <div class="kw-top">
                <span class="kw-word">${esc(w.word)}</span>
                ${w.phonetic ? `<span class="kw-phon">${esc(w.phonetic)}</span>` : ''}
                <button type="button" class="icon-action kw-speak" data-speak="${esc(w.word)}" title="朗读 ${esc(w.word)}" aria-label="朗读 ${esc(w.word)}">${icon('volume')}</button>
              </div>
              ${w.meaning ? `<div class="kw-meaning">${esc(w.meaning)}</div>` : ''}
              ${w.example ? `<p class="kw-example">${esc(w.example)}</p>` : ''}
              ${explain && w.why_zh ? `<p class="kw-why">${esc(w.why_zh)}</p>` : ''}
            </div>`,
          )
          .join('')}</div>
      </div>
      <div class="kw-added">${icon('book')}<span><b>${esc(added || keyWords.length)} 个重点单词</b>已自动加入今日单词表，并进入间隔复习。</span></div>`
    : ''

  const encourage = s.encouragement_zh
    ? `<div class="sum-encourage">${icon('flame')}<span>${esc(s.encouragement_zh)}</span></div>`
    : ''

  return `${hero}${meta}${cols}${corrHtml}${kwHtml}${encourage}`
}

/** 总结弹窗 loading。 */
export function renderSummaryLoading() {
  return `<div class="sum-loading">
    <span class="sum-spinner" aria-hidden="true"></span>
    <p>Ava 正在整理这次对话…</p>
    <span>正在梳理你们聊过的话题、亮点、可以改进的地方和重点单词。</span>
  </div>`
}

/**
 * 总结弹窗错误态（可重试）。
 * @param {string} message
 * @returns {string}
 */
export function renderSummaryError(message) {
  return `<div class="empty-state" style="padding:38px 18px">
    ${icon('alert')}
    <strong>总结没有成功生成</strong>
    <span>${esc(message || '网络或服务暂时不可用，请稍后重试。')}</span>
  </div>
  <div class="chips" style="justify-content:center">
    <button type="button" class="btn btn-primary" data-act="summary-retry">${icon('refresh')}重试</button>
  </div>`
}

/**
 * 今日单词表弹窗正文（SPEC v1.1 §B3）。
 * @param {{today?:string, totalWords?:number, days?:Array<{date:string,label:string,count:number,words:Array<any>}>}} book
 * @param {{explainChinese?:boolean}} [opts]
 * @returns {string}
 */
export function renderWordbook(book, opts = {}) {
  const data = book && typeof book === 'object' ? book : {}
  const days = Array.isArray(data.days) ? data.days : []
  const total = Number(data.totalWords) || days.reduce((sum, d) => sum + (Number(d && d.count) || 0), 0)
  const totalWordsCount = days.reduce((sum, d) => sum + (Array.isArray(d && d.words) ? d.words.length : 0), 0)
  if (!days.length || (total <= 0 && totalWordsCount <= 0)) {
    return `<div class="wb-empty">
      ${icon('book')}
      <strong>单词表还是空的</strong>
      <span>和 Ava 聊 3–5 轮，点「结束对话并总结」，重点单词就会自动收进今天的单词表。</span>
    </div>`
  }
  const explain = opts.explainChinese !== false
  const groups = days
    .filter((day) => day && Array.isArray(day.words) && day.words.length)
    .map((day) => {
      const words = day.words
      const isToday = String(day.label || '') === '今天'
      return `<section class="wb-day">
        <div class="wb-day-head">
          <span class="wb-day-label"><span class="dot ${isToday ? '' : 'old'}"></span>${esc(day.label || day.date || '')}</span>
          <span class="wb-day-count">${esc(Number(day.count) || words.length)} 个</span>
        </div>
        <div class="wb-words">${words
          .map(
            (w) => `<div class="wb-word">
              <div class="wb-word-main">
                <div class="wb-word-top">
                  <span class="wb-word-name">${esc(w.word)}</span>
                  ${w.phonetic ? `<span class="wb-word-phon">${esc(w.phonetic)}</span>` : ''}
                  ${Number(w.timesSeen) > 1 ? `<span class="wb-word-seen">出现 ${esc(Number(w.timesSeen))} 次</span>` : ''}
                </div>
                ${w.meaning ? `<div class="wb-word-meaning">${esc(w.meaning)}</div>` : ''}
                ${w.example ? `<p class="wb-word-example">${esc(w.example)}</p>` : ''}
                ${explain && w.why_zh ? `<p class="wb-word-why">${esc(w.why_zh)}</p>` : ''}
              </div>
              <button type="button" class="icon-action wb-speak" data-speak="${esc(w.word)}" title="朗读 ${esc(w.word)}" aria-label="朗读 ${esc(w.word)}">${icon('volume')}</button>
            </div>`,
          )
          .join('')}</div>
      </section>`
    })
    .join('')
  return `<div class="wb-total">${icon('book')}共 ${esc(Number(total) || totalWordsCount)} 个单词 · 来自 ${days.length} 天</div>${groups}`
}

/** 单词表 loading。 */
export function renderWordbookLoading() {
  return `<div class="sum-loading"><span class="sum-spinner" aria-hidden="true"></span><p>正在读取今日单词表…</p></div>`
}

/**
 * 单词表错误态。
 * @param {string} message
 * @returns {string}
 */
export function renderWordbookError(message) {
  return `<div class="empty-state" style="padding:38px 18px">
    ${icon('alert')}
    <strong>单词表加载失败</strong>
    <span>${esc(message || '请稍后重试。')}</span>
  </div>
  <div class="chips" style="justify-content:center">
    <button type="button" class="btn btn-primary" data-act="wordbook-retry">${icon('refresh')}重试</button>
  </div>`
}

/* -------------------------------- 彩带 ----------------------------------- */

const CONFETTI_COLORS = ['#5eead4', '#a78bfa', '#ffb86b', '#4ade80', '#f0abfc', '#7dd3fc']

/**
 * 舞台撒彩带（celebrate）。
 * @param {HTMLElement|null} container
 * @param {number} [count=28]
 */
export function confetti(container, count = 28) {
  if (!container) return
  const n = Math.min(60, Math.max(8, count))
  for (let i = 0; i < n; i++) {
    const piece = document.createElement('span')
    piece.className = 'confetti-piece'
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
    const left = 4 + Math.random() * 92
    const dx = Math.round((Math.random() - 0.5) * 160)
    const rot = Math.round(220 + Math.random() * 720)
    const dur = (1.3 + Math.random() * 1.3).toFixed(2)
    const delay = (Math.random() * 0.35).toFixed(2)
    piece.style.cssText = `left:${left}%;background:${color};width:${4 + Math.round(Math.random() * 5)}px;height:${7 + Math.round(Math.random() * 8)}px;animation-duration:${dur}s;animation-delay:${delay}s;--dx:${dx}px;--rot:${rot}deg;opacity:.95`
    container.appendChild(piece)
    setTimeout(() => piece.remove(), 3200)
  }
}
