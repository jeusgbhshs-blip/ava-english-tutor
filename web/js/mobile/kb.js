/**
 * Ava 手机版 · 知识库面板（v1.8）
 * 上传文件 / 网页导入 / 材料列表 / 多选讨论材料 / 删除 / 预览。
 * 依赖 core.js 的 kbList/kbUpload/kbImportUrl/kbGet/kbDelete 包装（api.js 未就绪时直连 /api/kb/*）。
 * @module mobile/kb
 */
import {
  $, esc, icon, toast, ui, M, characterById, sleep,
  kbList, kbUpload, kbImportUrl, kbGet, kbDelete, postJSON,
} from './core.js'
import { libraryBlockHtml, refreshLibraryCard, openLibrarySheet, startTodayLesson, completeToday } from './library.js'

const MAX_FILE_SIZE = 20 * 1024 * 1024
const ACCEPT = '.txt,.md,.markdown,.csv,.doc,.docx,.rtf,.pptx,.ppt,.pdf,.png,.jpg,.jpeg,.webp'
const POLL_MS = 3000
const POLL_MAX = 40

const KB = {
  open: false,
  docs: [],
  selected: new Set(),
  loading: false,
  busy: false,
  error: '',
  previews: new Map(),
  previewLoading: new Set(),
  pollTimer: null,
  pollCount: 0,
  lastLoadedAt: 0,
}

const docTitle = (doc) => String((doc && (doc.title || doc.name)) || '未命名材料')
const docStatus = (doc) => {
  const raw = String((doc && (doc.status || doc.enrichStatus || doc.state)) || '').toLowerCase()
  if (raw === 'enriching' || raw === 'processing' || raw === 'pending' || (doc && doc.enriching === true)) return 'enriching'
  if (raw === 'error' || raw === 'failed') return 'error'
  return 'done'
}
const docSource = (doc) => {
  const raw = String((doc && (doc.source || doc.origin || doc.kind)) || '').toLowerCase()
  if (raw === 'url' || raw === 'web' || raw === '网页' || (doc && doc.url)) return '网页'
  if (raw === 'paste') return '粘贴'
  if (raw === 'library') return '书库'
  return '文件'
}
const docKind = (doc) => {
  const raw = String((doc && (doc.kind || doc.type || doc.ext || doc.fileType)) || 'txt').replace(/^\./, '')
  if (raw === 'jpeg') return 'jpg'
  if (raw === 'markdown') return 'md'
  if (raw === 'text') return 'txt'
  return raw.slice(0, 8)
}
const docChars = (doc) => Number((doc && (doc.chars || doc.wordCount || doc.textLength || doc.charCount)) || 0) || 0
const docChunks = (doc) =>
  Number((doc && (doc.chunks || doc.chunkCount || (Array.isArray(doc.chunkIds) ? doc.chunkIds.length : 0))) || 0) || 0
const docLang = (doc) => {
  const raw = String((doc && (doc.lang || doc.language)) || '').toLowerCase()
  if (raw.includes('mixed') || raw === 'zh-en' || raw === 'en-zh' || raw === '中英') return '中英'
  if (raw.startsWith('zh') || raw === 'cn' || raw === 'chinese') return '中文'
  if (raw.startsWith('en')) return '英文'
  const text = String((doc && (doc.preview || doc.text || doc.summary_zh)) || '')
  const hasCjk = /[\u4e00-\u9fff]/.test(text)
  const hasEn = /[A-Za-z]{3,}/.test(text)
  return hasCjk && hasEn ? '中英' : hasCjk ? '中文' : hasEn ? '英文' : '—'
}

const statusText = (status) => (status === 'enriching' ? '摘要生成中' : status === 'error' ? '处理失败' : '已处理')

export function isKbOpen() {
  return KB.open
}

/* ------------------------------ 面板骨架 ------------------------------ */
function panelHtml() {
  const selected = KB.selected.size
  return `
  <div class="kb-panel">
    <header class="kb-head">
      <div class="kb-head-main">
        <span class="kb-head-orb">${icon('book')}</span>
        <div class="kb-head-copy">
          <div class="kb-eyebrow">KNOWLEDGE BASE</div>
          <h1 class="kb-title">我的知识库</h1>
          <p class="kb-sub">链接 / PDF / Word 直接提取正文；图片会先校对再入库。</p>
        </div>
      </div>
      <div class="kb-head-actions">
        <button type="button" class="kb-ghost" id="kb-refresh">${icon('refresh')}刷新</button>
        <button type="button" class="kb-ghost kb-back" id="kb-close">${icon('back')}返回助手</button>
      </div>
    </header>

    <div class="kb-body">
      <aside class="kb-side">
        ${libraryBlockHtml()}

        <section class="kb-block kb-add">
          <div class="kb-block-head"><span>添加材料</span><em>txt · md · pdf · docx · pptx · png · jpg</em></div>
          <div class="kb-drop" id="kb-drop">
            <input type="file" id="kb-file" accept="${ACCEPT}" multiple hidden>
            <span class="kb-drop-orb">${icon('book')}</span>
            <div class="kb-drop-copy">
              <strong>拖拽文件到这里</strong>
              <p>或点击选择文件，单文件 ≤ 20MB</p>
            </div>
            <button type="button" class="kb-btn kb-btn-primary" id="kb-file-btn">${icon('spark')}选择文件</button>
            <div class="kb-upload-status" id="kb-upload-status" hidden></div>
          </div>
        </section>

        <section class="kb-block">
          <div class="kb-block-head"><span>导入网页链接</span></div>
          <form class="kb-url-form" id="kb-url-form" autocomplete="off">
            <input type="url" id="kb-url-input" class="kb-input" placeholder="https://example.com/article" maxlength="500" aria-label="网页链接">
            <button type="submit" class="kb-btn kb-btn-primary" id="kb-url-btn">导入</button>
          </form>
          <p class="kb-hint">抓取网页正文并存入本机知识库，不上传第三方。</p>
        </section>

        <section class="kb-block">
          <div class="kb-block-head"><span>粘贴文本</span><em>文章 / 段落 / 句子</em></div>
          <button type="button" class="kb-paste-open" id="kb-paste-open">${icon('spark')}粘贴一段文字</button>
          <p class="kb-hint">直接粘贴英文或中文材料，保存后可勾选学习、让 Ava 围绕它讲解。</p>
        </section>

        <section class="kb-tips">
          <div class="kb-tips-title">使用提示</div>
          <ul class="kb-tips-list">
            <li>材料只保存在本机，不上传第三方。</li>
            <li>图片资料需要校对确认，避免 OCR 错字进入讲解。</li>
            <li>勾选 1–N 篇材料后，围绕它们和 Ava 讨论。</li>
            <li>发散讨论可以不带材料；自由聊则直接开始。</li>
          </ul>
        </section>
      </aside>

      <main class="kb-main">
        <div class="kb-list-head">
          <div class="kb-list-title-wrap">
            <span class="kb-list-title">材料</span>
            <span class="kb-list-count" id="kb-list-count">—</span>
          </div>
          <span class="kb-list-hint">勾选 1–N 篇作为讨论依据</span>
        </div>
        <div class="kb-list" id="kb-list">
          <div class="kb-empty"><span class="spinner"></span><span>正在读取知识库…</span></div>
        </div>
      </main>

      <div class="kb-discuss">
        <div class="kb-selected">已选 <b id="kb-selected-count">${selected}</b> 篇材料</div>
        <div class="kb-discuss-actions">
          <button type="button" class="kb-btn kb-btn-primary kb-btn-block" id="kb-grounded">${icon('phone')}围绕知识库讨论</button>
          <button type="button" class="kb-btn kb-btn-block" id="kb-divergent">${icon('spark')}发散讨论</button>
          <button type="button" class="kb-btn kb-btn-block kb-btn-quiet" id="kb-free">${icon('chat')}自由聊</button>
        </div>
        <p class="kb-hint">勾选材料后开始讨论；发散讨论也可以不选材料。</p>
      </div>
    </div>
  </div>`
}

/* ------------------------------ 渲染 ------------------------------ */
export function renderKbPanel() {
  const host = $('#kb-screen')
  if (!host) return
  if (!host.dataset.ready) {
    host.innerHTML = panelHtml()
    bindPanel(host)
    host.dataset.ready = '1'
    void reloadDocs()
  }
  renderList()
  renderSelection()
  refreshLibraryCard()
  if (KB.busy) setBusy(true)
  else setBusy(false)
}

function renderList() {
  const list = $('#kb-list')
  const countEl = $('#kb-list-count')
  if (!list) return
  if (countEl) countEl.textContent = KB.docs.length ? `${KB.docs.length} 篇` : '—'
  if (KB.loading && !KB.docs.length) {
    list.innerHTML = '<div class="kb-empty"><span class="spinner"></span><span>正在读取知识库…</span></div>'
    return
  }
  if (KB.error) {
    list.innerHTML = `
      <div class="kb-empty kb-error">
        <span>${icon('close')}</span>
        <strong>知识库读取失败</strong>
        <p>${esc(KB.error)}</p>
        <button type="button" class="btn btn-ghost btn-sm" data-act="refresh">${icon('refresh')}重试</button>
      </div>`
    return
  }
  if (!KB.docs.length) {
    list.innerHTML = `
      <div class="kb-empty">
        <span class="kb-empty-orb">${icon('book')}</span>
        <strong>知识库还是空的</strong>
        <p>上传一篇文章或导入网页链接，就能围绕它和 Ava 讨论。</p>
      </div>`
    return
  }
  list.innerHTML = KB.docs
    .map((doc) => {
      const id = String(doc.id || doc.docId || '')
      const status = docStatus(doc)
      const preview = KB.previews.get(id) || ''
      const expanded = !!preview || KB.previewLoading.has(id)
      const checked = KB.selected.has(id)
      const lang = docLang(doc)
      return `<div class="kb-item${checked ? ' is-selected' : ''}" data-id="${esc(id)}">
        <label class="kb-check" title="选为讨论材料">
          <input type="checkbox" data-id="${esc(id)}" ${checked ? 'checked' : ''} aria-label="选择 ${esc(docTitle(doc))}">
        </label>
        <div class="kb-item-main" data-act="toggle-preview" data-id="${esc(id)}">
          <div class="kb-item-top">
            <div class="kb-item-title">${esc(docTitle(doc))}</div>
            <span class="kb-status is-${status}">${statusText(status)}</span>
          </div>
          <div class="kb-meta">
            <span>${esc(docSource(doc))}</span><i>·</i>
            <span>${esc(docKind(doc))}</span><i>·</i>
            <span>${docChars(doc) ? esc(docChars(doc).toLocaleString('zh-CN')) + ' 字' : '字数未知'}</span><i>·</i>
            <span>${docChunks(doc)} 块</span><i>·</i>
            <span>${esc(lang)}</span>
          </div>
          <div class="kb-preview" data-preview="${esc(id)}" ${expanded ? '' : 'hidden'}>
            ${KB.previewLoading.has(id) ? '<span class="kb-preview-loading"><span class="spinner"></span>读取预览…</span>' : `<p>${esc(preview)}</p><div class="kb-preview-foot">前 800 字预览 · 共 ${docChunks(doc)} 块</div>`}
          </div>
        </div>
        <button type="button" class="kb-del" data-act="delete" data-id="${esc(id)}" title="删除材料" aria-label="删除 ${esc(docTitle(doc))}">${icon('close')}</button>
      </div>`
    })
    .join('') +
    '<div class="kb-list-foot">拖拽文件到页面任意处也可上传 · 勾选材料后在左下方开始讨论</div>'
}

function renderSelection() {
  const countEl = $('#kb-selected-count')
  if (countEl) countEl.textContent = String(KB.selected.size)
  const grounded = $('#kb-grounded')
  if (grounded) grounded.classList.toggle('is-disabled', !KB.selected.size)
  const list = $('#kb-list')
  if (list) {
    list.querySelectorAll('.kb-item').forEach((item) => {
      const id = item.getAttribute('data-id')
      item.classList.toggle('is-selected', KB.selected.has(id))
      const box = item.querySelector('input[type=checkbox]')
      if (box) box.checked = KB.selected.has(id)
    })
  }
}

function setBusy(busy) {
  KB.busy = busy
  ;['kb-file-btn', 'kb-url-btn', 'kb-grounded', 'kb-divergent', 'kb-free', 'kb-refresh'].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.disabled = busy
  })
}

function setUploadStatus(text, type = 'info') {
  const el = $('#kb-upload-status')
  if (!el) return
  if (!text) {
    el.hidden = true
    el.textContent = ''
    return
  }
  el.hidden = false
  el.className = 'kb-upload-status is-' + type
  el.innerHTML = type === 'busy' ? '<span class="spinner"></span>' + esc(text) : esc(text)
}

/* ------------------------------ 数据 ------------------------------ */
function normalizeListResponse(res) {
  if (!res || typeof res !== 'object') return null
  if (res.ok === false) {
    KB.error = String(res.error || '知识库读取失败')
    return null
  }
  const raw = Array.isArray(res.docs) ? res.docs : Array.isArray(res.items) ? res.items : Array.isArray(res.list) ? res.list : Array.isArray(res) ? res : []
  return raw.filter((doc) => doc && typeof doc === 'object')
}

export async function reloadDocs({ silent = false } = {}) {
  if (KB.loading) return
  KB.loading = true
  if (!silent) KB.error = ''
  renderList()
  try {
    const res = await kbList()
    const docs = normalizeListResponse(res)
    if (docs === null) {
      KB.error = KB.error || '知识库接口暂不可用，请稍后重试'
    } else {
      KB.docs = docs
      KB.error = ''
      const ids = new Set(docs.map((doc) => String(doc.id || doc.docId || '')))
      KB.selected.forEach((id) => {
        if (!ids.has(id)) KB.selected.delete(id)
      })
      KB.lastLoadedAt = Date.now()
    }
  } catch (err) {
    // 请求失败时保留上次成功加载的材料和选择，不能把失败当成空库。
    KB.error = (err && err.message) || '知识库接口暂不可用，请稍后重试'
  } finally {
    KB.loading = false
    renderList()
    renderSelection()
    schedulePoll()
  }
}

function schedulePoll() {
  if (KB.pollTimer) {
    clearTimeout(KB.pollTimer)
    KB.pollTimer = null
  }
  const hasEnriching = KB.docs.some((doc) => docStatus(doc) === 'enriching')
  if (!KB.open || !hasEnriching || KB.pollCount >= POLL_MAX) return
  KB.pollCount += 1
  KB.pollTimer = setTimeout(() => {
    if (!KB.open) return
    void reloadDocs({ silent: true })
  }, POLL_MS)
}

function stopPoll() {
  if (KB.pollTimer) clearTimeout(KB.pollTimer)
  KB.pollTimer = null
}

/* ------------------------------ 上传 / 导入 ------------------------------ */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const raw = String(reader.result || '')
      const comma = raw.indexOf(',')
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function isImageFileName(name) {
  return /\.(png|jpe?g|webp|gif|bmp|heic|heif|tif|tiff)$/i.test(String(name || ''))
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** 图片：先 OCR 预览，用户校对确认后才写入知识库。 */
async function reviewImageFile(file) {
  setBusy(true)
  setUploadStatus(`正在识别「${file.name}」…`, 'busy')
  try {
    const [dataBase64, dataUrl] = await Promise.all([readFileBase64(file), readFileDataUrl(file)])
    const res = await postJSON(
      '/api/kb/preview-file',
      { name: file.name, dataBase64, mime: file.type || 'application/octet-stream' },
      { timeoutMs: 120000 },
    )
    if (!res || res.ok === false) throw new Error((res && res.error) || '图片文字识别失败')
    setUploadStatus(`「${file.name}」识别完成，请校对后入库`, 'ok')
    openProofreadSheet(file, dataUrl, res)
  } catch (err) {
    const message = (err && err.message) || '图片文字识别失败，请换一张更清晰的截图'
    toast(message, 'bad', 3800)
    setUploadStatus(message, 'error')
  } finally {
    setBusy(false)
    setTimeout(() => setUploadStatus(''), 4200)
  }
}

function openProofreadSheet(file, dataUrl, result) {
  const warnings = Array.isArray(result.warnings) ? result.warnings : []
  const text = String(result.text || '')
  const body = `
    <div class="ocr-review">
      <div class="ocr-original">
        <div class="ocr-col-title">原始图片</div>
        <img src="${dataUrl}" alt="${esc(file.name)}">
      </div>
      <div class="ocr-textside">
        <div class="ocr-col-title">提取文本 <span>图片 OCR · 校对后入库</span></div>
        <textarea class="ocr-textarea" id="ocr-review-text" spellcheck="false" aria-label="校对提取文本">${esc(text)}</textarea>
        <p class="ocr-hint">${warnings.length ? esc(warnings.join(' ')) : 'OCR 结果可能有少量错字，确认后再加入知识库。'}</p>
        <div class="ocr-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="ocr-cancel">取消</button>
          <button type="button" class="btn btn-primary btn-sm" id="ocr-confirm">确认入库</button>
        </div>
      </div>
    </div>`
  ui.openSheet('图片资料校对', body)
  const textarea = document.getElementById('ocr-review-text')
  const confirm = document.getElementById('ocr-confirm')
  const cancel = document.getElementById('ocr-cancel')
  if (cancel) cancel.onclick = () => ui.closeSheet()
  if (confirm) {
    confirm.onclick = async () => {
      const edited = String((textarea && textarea.value) || '').trim()
      if (edited.length < 20) {
        toast('校对后的内容太短，至少保留 20 个字符', 'bad', 3000)
        return
      }
      confirm.disabled = true
      confirm.textContent = '正在入库…'
      try {
        const res = await postJSON(
          '/api/kb/save-text',
          { name: file.name, text: edited, kind: result.kind || 'image' },
          { timeoutMs: 60000 },
        )
        if (!res || res.ok === false) throw new Error((res && res.error) || '入库失败')
        ui.closeSheet()
        toast('校对内容已加入知识库', 'ok', 2600)
        void reloadDocs()
      } catch (err) {
        confirm.disabled = false
        confirm.textContent = '确认入库'
        toast((err && err.message) || '入库失败，请重试', 'bad', 3600)
      }
    }
  }
}

async function uploadFiles(files) {
  const list = Array.from(files || [])
  if (!list.length) return
  for (const file of list) {
    if (!file || !file.name) continue
    if (file.size > MAX_FILE_SIZE) {
      toast(`「${file.name}」超过 20MB，无法上传`, 'bad', 3200)
      continue
    }
    if (isImageFileName(file.name)) {
      await reviewImageFile(file)
      continue
    }
    setBusy(true)
    setUploadStatus(`正在上传「${file.name}」…`, 'busy')
    try {
      const dataBase64 = await fileToBase64(file)
      const res = await kbUpload({ name: file.name, dataBase64, mime: file.type || 'application/octet-stream' })
      if (!res || res.ok === false) throw new Error((res && res.error) || '上传失败')
      toast(`「${file.name}」已加入知识库`, 'ok', 2600)
      setUploadStatus(`「${file.name}」导入成功，摘要生成中…`, 'ok')
    } catch (err) {
      const message = (err && err.message) || '上传失败，请稍后重试'
      toast(message, 'bad', 3600)
      setUploadStatus(message, 'error')
    } finally {
      setBusy(false)
    }
  }
  void reloadDocs()
  setTimeout(() => setUploadStatus(''), 4000)
}

async function importUrl(url) {
  const value = String(url || '').trim()
  if (!/^https?:\/\//i.test(value)) {
    toast('请输入以 http(s):// 开头的网页链接', 'bad', 2800)
    return
  }
  setBusy(true)
  setUploadStatus('正在抓取网页正文…', 'busy')
  try {
    const res = await kbImportUrl(value)
    if (!res || res.ok === false) throw new Error((res && res.error) || '网页导入失败')
    toast('网页已导入知识库', 'ok', 2600)
    setUploadStatus('网页导入成功，摘要生成中…', 'ok')
    const input = $('#kb-url-input')
    if (input) input.value = ''
  } catch (err) {
    const message = (err && err.message) || '网页导入失败，请检查链接或稍后重试'
    toast(message, 'bad', 3600)
    setUploadStatus(message, 'error')
  } finally {
    setBusy(false)
    void reloadDocs()
    setTimeout(() => setUploadStatus(''), 4000)
  }
}

/** 粘贴文本 → 直接入库（不走 OCR） */
function openPasteSheet() {
  const body = `
    <div class="kb-paste-sheet">
      <div class="kb-paste-head">
        <div>
          <strong>粘贴一段材料</strong>
          <p>英文或中文都可以；保存后可在知识库里勾选，让 Ava 围绕它讲解。</p>
        </div>
        <span class="kb-paste-badge">原文直读 · 不 OCR</span>
      </div>
      <label class="kb-paste-label" for="kb-paste-title">标题（可选）</label>
      <input class="kb-input" id="kb-paste-title" maxlength="120" placeholder="例如：The Future of Work">
      <label class="kb-paste-label" for="kb-paste-text">正文</label>
      <textarea class="kb-paste-textarea" id="kb-paste-text" spellcheck="false" placeholder="把文章、新闻、台词或一段英文材料粘贴到这里…"></textarea>
      <div class="kb-paste-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="kb-paste-clip">从剪贴板粘贴</button>
        <span class="kb-paste-count" id="kb-paste-count">0 字</span>
        <button type="button" class="btn btn-primary btn-sm" id="kb-paste-save">保存到知识库</button>
      </div>
    </div>`
  ui.openSheet('粘贴文本', body)
  const title = document.getElementById('kb-paste-title')
  const text = document.getElementById('kb-paste-text')
  const count = document.getElementById('kb-paste-count')
  const clip = document.getElementById('kb-paste-clip')
  const save = document.getElementById('kb-paste-save')
  const refreshCount = () => { if (count) count.textContent = `${String(text.value || '').length} 字` }
  if (text) {
    text.addEventListener('input', refreshCount)
    setTimeout(() => text.focus(), 80)
  }
  refreshCount()
  if (clip) {
    clip.onclick = async () => {
      try {
        const value = await navigator.clipboard.readText()
        if (!value) throw new Error('clipboard-empty')
        if (!text.value.trim()) text.value = value
        else text.value += `\n${value}`
        refreshCount()
        toast('已粘贴剪贴板内容', 'ok', 1600)
      } catch {
        toast('无法读取剪贴板，请在文本框里手动粘贴（⌘V / Ctrl+V）', 'info', 3200)
      }
    }
  }
  if (save) {
    save.onclick = async () => {
      const content = String(text.value || '').trim()
      if (content.length < 20) { toast('正文太短，至少粘贴 20 个字符', 'info', 2600); return }
      save.disabled = true
      save.textContent = '保存中…'
      try {
        const res = await postJSON('/api/kb/save-text', {
          name: fileSafeName(title.value.trim() || '粘贴材料'),
          title: title.value.trim() || '',
          text: content,
          kind: 'txt',
          source: 'paste',
        }, { timeoutMs: 60000 })
        if (!res || res.ok === false) throw new Error((res && res.error) || '保存失败')
        const id = res.doc && res.doc.id
        ui.closeSheet()
        toast('已加入知识库，可直接勾选学习', 'ok', 3000)
        if (id) KB.selected.add(id)
        void reloadDocs()
      } catch (err) {
        save.disabled = false
        save.textContent = '保存到知识库'
        toast((err && err.message) || '保存失败，请重试', 'bad', 3400)
      }
    }
  }
}

function fileSafeName(value) {
  return String(value || '粘贴材料').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || '粘贴材料'
}

/* ------------------------------ 预览 / 删除 ------------------------------ */
async function togglePreview(id) {
  if (!id) return
  const container = document.querySelector(`[data-preview="${id}"]`)
  const current = KB.previews.get(id)
  if (current && container && !container.hidden) {
    container.hidden = true
    return
  }
  if (current) {
    if (container) {
      container.hidden = false
      container.innerHTML = `<p>${esc(current)}</p><div class="kb-preview-foot">前 800 字预览 · 共 ${docChunks(KB.docs.find((d) => String(d.id || d.docId) === id))} 块</div>`
    }
    return
  }
  KB.previewLoading.add(id)
  renderList()
  try {
    const res = await kbGet(id)
    const doc = res && (res.doc || res)
    const text = String((doc && (doc.preview || doc.text || doc.content || doc.summary_zh)) || '').replace(/\s+/g, ' ').slice(0, 800)
    if (!text) throw new Error('这篇材料还没有可预览的文本')
    KB.previews.set(id, text)
  } catch (err) {
    toast((err && err.message) || '预览读取失败', 'bad', 3000)
  } finally {
    KB.previewLoading.delete(id)
    renderList()
  }
}

function confirmDelete(doc) {
  const id = String((doc && (doc.id || doc.docId)) || '')
  if (!id) return
  const title = docTitle(doc)
  ui.openSheet(
    '删除材料',
    `<div class="kb-confirm">
      <p>确定删除「${esc(title)}」吗？删除后知识库讨论将不再引用它。</p>
      <div class="summary-actions">
        <button type="button" class="btn btn-ghost" data-act="kb-cancel">取消</button>
        <button type="button" class="btn btn-primary" data-act="kb-delete-confirm" data-id="${esc(id)}">删除</button>
      </div>
    </div>`,
  )
  const body = $('#sheet-body')
  if (!body) return
  body.onclick = async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')
    if (act === 'kb-cancel') ui.closeSheet()
    else if (act === 'kb-delete-confirm') {
      target.disabled = true
      try {
        const res = await kbDelete(id)
        if (!res || res.ok === false) throw new Error((res && res.error) || '删除失败')
        KB.selected.delete(id)
        KB.previews.delete(id)
        KB.docs = KB.docs.filter((item) => String(item.id || item.docId) !== id)
        ui.closeSheet()
        toast('材料已删除', 'ok', 2200)
        renderList()
        renderSelection()
        void reloadDocs({ silent: true })
      } catch (err) {
        target.disabled = false
        toast((err && err.message) || '删除失败，请重试', 'bad', 3200)
      }
    }
  }
}

/* ------------------------------ 讨论入口 ------------------------------ */
function selectedDocs() {
  return KB.docs.filter((doc) => KB.selected.has(String(doc.id || doc.docId)))
}

function startDiscussion(kbMode) {
  const docs = selectedDocs()
  if (kbMode === 'grounded' && !docs.length) {
    toast('请先勾选至少一篇材料，再开始知识库讨论', 'bad', 3000)
    return
  }
  const character = characterById(M.activeCharId)
  const opts = { kbMode }
  if (docs.length) {
    opts.kbDocIds = docs.map((doc) => String(doc.id || doc.docId))
    opts.kbDocs = docs.map((doc) => docTitle(doc))
  }
  if (typeof ui.closeKbPanel === 'function') ui.closeKbPanel()
  if (typeof ui.openCall === 'function') ui.openCall(character, 0, opts)
}

/* ------------------------------ 打开 / 关闭 ------------------------------ */
export function openKbPanel() {
  const host = $('#kb-screen')
  if (!host) return
  KB.open = true
  document.body.classList.add('kb-open')
  host.hidden = false
  host.classList.add('is-active')
  renderKbPanel()
  if (Date.now() - KB.lastLoadedAt > 1500) void reloadDocs()
}

export function closeKbPanel() {
  const host = $('#kb-screen')
  KB.open = false
  document.body.classList.remove('kb-open')
  stopPoll()
  if (host) {
    host.hidden = true
    host.classList.remove('is-active')
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */
function bindPanel(host) {
  host.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act], [data-id]') : null
    if (!target || !host.contains(target)) return
    const act = target.getAttribute('data-act')
    if (act === 'refresh') {
      void reloadDocs()
      return
    }
    if (act === 'toggle-preview') {
      void togglePreview(target.getAttribute('data-id'))
      return
    }
    if (act === 'delete') {
      const id = target.getAttribute('data-id')
      const doc = KB.docs.find((item) => String(item.id || item.docId) === id)
      if (doc) confirmDelete(doc)
      return
    }
    if (act === 'library-open') {
      openLibrarySheet()
      return
    }
    if (act === 'library-start' || act === 'library-review') {
      void startTodayLesson()
      return
    }
    if (act === 'library-complete') {
      completeToday()
      return
    }
  })

  // 复选框多选
  host.addEventListener('change', (event) => {
    const box = event.target
    if (!box || box.type !== 'checkbox' || !box.getAttribute('data-id')) return
    const id = box.getAttribute('data-id')
    if (box.checked) KB.selected.add(id)
    else KB.selected.delete(id)
    renderSelection()
  })

  const closeBtn = $('#kb-close', host)
  if (closeBtn) closeBtn.addEventListener('click', () => ui.closeKbPanel && ui.closeKbPanel())

  const pasteOpen = $('#kb-paste-open', host)
  if (pasteOpen) pasteOpen.addEventListener('click', () => openPasteSheet())

  const refreshBtn = $('#kb-refresh', host)
  if (refreshBtn) refreshBtn.addEventListener('click', () => void reloadDocs())

  const fileInput = $('#kb-file', host)
  const fileBtn = $('#kb-file-btn', host)
  if (fileBtn && fileInput) fileBtn.addEventListener('click', () => fileInput.click())
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length) void uploadFiles(fileInput.files)
      fileInput.value = ''
    })
  }

  const drop = $('#kb-drop', host)
  if (drop) {
    ;['dragenter', 'dragover'].forEach((type) =>
      drop.addEventListener(type, (event) => {
        event.preventDefault()
        event.stopPropagation()
        drop.classList.add('is-drag')
      }),
    )
    ;['dragleave', 'drop'].forEach((type) =>
      drop.addEventListener(type, (event) => {
        event.preventDefault()
        event.stopPropagation()
        drop.classList.remove('is-drag')
      }),
    )
    drop.addEventListener('drop', (event) => {
      const files = event.dataTransfer && event.dataTransfer.files
      if (files && files.length) void uploadFiles(files)
    })
  }

  const urlForm = $('#kb-url-form', host)
  if (urlForm) {
    urlForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const input = $('#kb-url-input')
      void importUrl(input ? input.value : '')
    })
  }

  const grounded = $('#kb-grounded', host)
  if (grounded) grounded.addEventListener('click', () => startDiscussion('grounded'))
  const divergent = $('#kb-divergent', host)
  if (divergent) divergent.addEventListener('click', () => startDiscussion('divergent'))
  const free = $('#kb-free', host)
  if (free) free.addEventListener('click', () => startDiscussion('free'))

  // 允许把文件拖到面板空白处
  host.addEventListener('dragover', (event) => event.preventDefault())
  host.addEventListener('drop', (event) => {
    if (event.target instanceof Element && event.target.closest('#kb-drop')) return
    event.preventDefault()
    const files = event.dataTransfer && event.dataTransfer.files
    if (files && files.length) void uploadFiles(files)
  })
}

export { KB as kbState }
