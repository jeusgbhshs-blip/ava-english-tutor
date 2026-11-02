import { apiFetch } from './backend.js'
/**
 * Ava 前端底层 · HTTP + SSE 流式对话客户端
 *
 * 浏览器原生 ESM：无构建、无 importmap、无外部依赖。
 * 所有接口默认走**同源相对路径**（如 `/api/health`），由 server.js 提供；
 * 在 Node 中做联调/单测时可调用 {@link setApiBase} 指定绝对基地址。
 *
 * 中文错误：所有网络/非 2xx/解析失败都会抛出 {@link ApiError}（message 为中文可读文案），
 * 并带有 `code` 字段（`network` | `timeout` | `http` | `parse` | `aborted` | `stream` | `chat`）。
 *
 * @module api
 */

/* -------------------------------------------------------------------------- */
/* 配置                                                                        */
/* -------------------------------------------------------------------------- */

/** 普通 JSON 请求默认超时（毫秒）；流式对话不设此超时。 */
const DEFAULT_TIMEOUT_MS = 20_000

/** SSE 对话接口路径。 */
export const CHAT_PATH = '/api/chat'

/** 可选 API 基地址（默认同源相对路径）。 */
let apiBase = ''

/**
 * 设置 API 基地址（可选，浏览器同源部署不需要调用）。
 * @param {string} [base] 例如 `'http://127.0.0.1:5180'`；传空串恢复同源相对路径。
 * @returns {void}
 */
export function setApiBase(base = '') {
  apiBase = typeof base === 'string' ? base.replace(/\/+$/, '') : ''
}

/**
 * 读取当前 API 基地址。
 * @returns {string}
 */
export function getApiBase() {
  return apiBase
}

/* -------------------------------------------------------------------------- */
/* 错误对象                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ava 前端统一接口错误。
 *
 * @property {string} code `network`|`timeout`|`http`|`parse`|`aborted`|`stream`|`chat`
 * @property {number} status HTTP 状态码（非 HTTP 错误为 0）
 * @property {string} path 请求路径
 * @property {string} detail 服务端/底层返回的细节（可能为空）
 */
export class ApiError extends Error {
  /**
   * @param {string} message 中文可读错误信息
   * @param {{code?: string, status?: number, path?: string, detail?: string, cause?: unknown}} [meta]
   */
  constructor(message, meta = {}) {
    super(String(message || '请求失败'))
    this.name = 'ApiError'
    this.code = meta.code || 'api'
    this.status = Number.isFinite(meta.status) ? meta.status : 0
    this.path = meta.path || ''
    this.detail = String(meta.detail || '')
    if (meta.cause !== undefined) this.cause = meta.cause
  }
}

/* -------------------------------------------------------------------------- */
/* 内部工具                                                                    */
/* -------------------------------------------------------------------------- */

const HTTP_HINTS = {
  400: '请求参数有误',
  401: '认证失败',
  403: '没有访问权限',
  404: '接口不存在',
  405: '请求方法不被支持',
  408: '请求超时',
  409: '请求冲突',
  413: '请求内容过大',
  415: '请求内容格式不支持',
  429: '请求过于频繁',
  500: '服务器内部错误',
  502: '上游服务异常',
  503: '服务暂不可用',
  504: '上游服务超时',
}

/**
 * 拼接最终请求 URL（绝对地址原样使用，相对地址拼 apiBase）。
 * @param {string} path
 * @returns {string}
 */
function urlOf(path) {
  const p = String(path || '')
  if (/^https?:\/\//i.test(p)) return p
  const normalized = p.startsWith('/') ? p : `/${p}`
  return apiBase + normalized
}

/**
 * 安全执行回调：任何回调抛错都不会打断流式解析，仅打印到 console。
 * @param {Function|undefined|null} fn
 * @param {...unknown} args
 * @returns {unknown}
 */
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return undefined
  try {
    return fn(...args)
  } catch (err) {
    console.error('[api] 回调执行出错：', err)
    return undefined
  }
}

/**
 * 截断过长文本，避免错误信息撑爆 UI。
 * @param {string} text
 * @param {number} [max=300]
 * @returns {string}
 */
function truncate(text, max = 300) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 宽松 JSON 解析：失败返回 `undefined`（用于兼容 HTML/空响应）。
 * @param {string} text
 * @returns {unknown|undefined}
 */
function parseJSONLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 从响应体里提取可读错误细节。
 * @param {unknown} data 已解析的响应体
 * @returns {string}
 */
function pickDetail(data) {
  if (data == null) return ''
  if (typeof data === 'string') return truncate(data)
  if (typeof data === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (data)
    for (const key of ['error', 'message', 'detail', 'reason']) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) return truncate(value)
    }
    try {
      return truncate(JSON.stringify(data))
    } catch {
      return ''
    }
  }
  return truncate(String(data))
}

/**
 * 构造中文 HTTP 错误信息。
 * @param {number} status
 * @param {string} detail
 * @param {string} path
 * @returns {string}
 */
function httpErrorMessage(status, detail, path) {
  const hint = HTTP_HINTS[status] || (status >= 500 ? '服务器错误' : '请求失败')
  const base = `${hint}（HTTP ${status}）`
  return detail ? `${base}：${detail}` : `${base}：${path}`
}

/**
 * 把 fetch 抛出的底层异常翻译成中文 ApiError。
 * @param {unknown} err
 * @param {string} path
 * @param {{timedOut: boolean, callerSignal: AbortSignal|null, timeoutMs?: number}} ctx
 * @returns {ApiError}
 */
function toNetworkError(err, path, { timedOut, callerSignal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const raw = /** @type {any} */ (err)
  const name = raw && raw.name
  if (callerSignal && callerSignal.aborted) {
    return new ApiError('请求已取消', { code: 'aborted', path, cause: err })
  }
  if (timedOut) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
    const duration = ms >= 1000 ? `${Math.round(ms / 100) / 10} 秒` : `${Math.round(ms)} 毫秒`
    return new ApiError(`请求超时（${duration}）：${path}`, {
      code: 'timeout',
      path,
      detail: String(raw && raw.message ? raw.message : raw || ''),
      cause: err,
    })
  }
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new ApiError('请求已取消', { code: 'aborted', path, cause: err })
  }
  return new ApiError(
    `网络连接失败，无法访问 Ava 服务（${path}）。请检查网络、服务地址和服务运行状态。`,
    { code: 'network', path, detail: String(raw && raw.message ? raw.message : raw || ''), cause: err },
  )
}

/**
 * 将外部 AbortSignal 链接到内部 AbortController。
 * @param {AbortSignal|null|undefined} signal
 * @param {AbortController} controller
 * @returns {{cleanup: () => void}}
 */
function linkAbort(signal, controller) {
  if (!signal) return { cleanup() {} }
  const abort = () => {
    try {
      controller.abort(signal.reason)
    } catch {
      try {
        controller.abort()
      } catch {
        /* 忽略 */
      }
    }
  }
  if (signal.aborted) {
    abort()
    return { cleanup() {} }
  }
  try {
    signal.addEventListener('abort', abort, { once: true })
  } catch {
    /* 某些环境 AbortSignal 不支持 addEventListener，忽略 */
  }
  return {
    cleanup() {
      try {
        signal.removeEventListener('abort', abort)
      } catch {
        /* 忽略 */
      }
    },
  }
}

/**
 * 判断 body 是否应按 JSON 序列化（FormData/Blob/URLSearchParams/二进制原样发送）。
 * @param {unknown} body
 * @returns {boolean}
 */
function isJSONBody(body) {
  if (body === undefined || body === null) return false
  if (typeof body !== 'object') return false
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false
  if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) return false
  return true
}

/**
 * 序列化请求体。
 * @param {unknown} body
 * @returns {BodyInit|undefined}
 */
function serializeBody(body) {
  if (body === undefined) return undefined
  if (typeof body === 'string') return body
  if (isJSONBody(body)) return JSON.stringify(body)
  return /** @type {BodyInit} */ (body)
}

/**
 * 统一请求：fetch → 解析 JSON → 非 2xx 转中文 ApiError。
 * @param {string} path
 * @param {{method?: string, body?: unknown, headers?: Record<string,string>, signal?: AbortSignal|null, timeoutMs?: number, cache?: RequestCache}} [options]
 * @returns {Promise<any>}
 */
async function requestJSON(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    signal = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cache = 'no-store',
  } = options

  const controller = new AbortController()
  const link = linkAbort(signal, controller)
  let timedOut = false
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      try {
        controller.abort()
      } catch {
        /* 忽略 */
      }
    }, timeoutMs)
  }

  /** @type {Record<string, string>} */
  const finalHeaders = { Accept: 'application/json', ...headers }
  if (body !== undefined && typeof body === 'string') finalHeaders['Content-Type'] = 'application/json; charset=utf-8'
  else if (isJSONBody(body)) finalHeaders['Content-Type'] = 'application/json; charset=utf-8'

  try {
    /** @type {Response} */
    let res
    try {
      res = await apiFetch(urlOf(path), {
        method,
        headers: finalHeaders,
        body: serializeBody(body),
        signal: controller.signal,
        cache,
      })
    } catch (err) {
      throw toNetworkError(err, path, { timedOut, callerSignal: signal, timeoutMs })
    }

    let text = ''
    try {
      text = await res.text()
    } catch (err) {
      throw toNetworkError(err, path, { timedOut, callerSignal: signal, timeoutMs })
    }

    if (!res.ok) {
      const data = parseJSONLoose(text)
      const detail = pickDetail(data) || truncate(text)
      throw new ApiError(httpErrorMessage(res.status, detail, path), {
        code: 'http',
        status: res.status,
        path,
        detail,
      })
    }

    const trimmed = text.trim()
    if (!trimmed) return null
    const data = parseJSONLoose(trimmed)
    if (data === undefined) {
      throw new ApiError(`服务器返回了无法解析的 JSON（${path}）`, {
        code: 'parse',
        status: res.status,
        path,
        detail: truncate(text),
      })
    }
    return data
  } finally {
    if (timer) clearTimeout(timer)
    link.cleanup()
  }
}

/* -------------------------------------------------------------------------- */
/* JSON 接口                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * GET 一个 JSON 接口。
 * @param {string} path 例如 `/api/health`
 * @param {{signal?: AbortSignal|null, timeoutMs?: number, headers?: Record<string,string>, cache?: RequestCache}} [opts]
 * @returns {Promise<any>} 解析后的 JSON；空响应返回 `null`
 */
export async function getJSON(path, opts = {}) {
  return requestJSON(path, { ...opts, method: 'GET' })
}

/**
 * PUT 一个 JSON 接口。
 * @param {string} path
 * @param {unknown} body 会被 JSON 序列化（字符串原样发送）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number, headers?: Record<string,string>}} [opts]
 * @returns {Promise<any>}
 */
export async function putJSON(path, body, opts = {}) {
  return requestJSON(path, { ...opts, method: 'PUT', body: body === undefined ? {} : body })
}

/**
 * POST 一个 JSON 接口。
 * @param {string} path
 * @param {unknown} body 会被 JSON 序列化（字符串原样发送）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number, headers?: Record<string,string>}} [opts]
 * @returns {Promise<any>}
 */
export async function postJSON(path, body, opts = {}) {
  return requestJSON(path, { ...opts, method: 'POST', body: body === undefined ? {} : body })
}

/**
 * PATCH 一个 JSON 接口（用于局部更新资源，如复习词 edit/改状态）。
 * @param {string} path
 * @param {unknown} body 会被 JSON 序列化（字符串原样发送）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number, headers?: Record<string,string>}} [opts]
 * @returns {Promise<any>}
 */
export async function patchJSON(path, body, opts = {}) {
  return requestJSON(path, { ...opts, method: 'PATCH', body: body === undefined ? {} : body })
}

/**
 * DELETE 一个 JSON 接口（用于删除本地文档等资源）。
 * @param {string} path
 * @param {{signal?: AbortSignal|null, timeoutMs?: number, headers?: Record<string,string>, cache?: RequestCache}} [opts]
 * @returns {Promise<any>} 解析后的 JSON；空响应返回 `null`
 */
export async function deleteJSON(path, opts = {}) {
  return requestJSON(path, { ...opts, method: 'DELETE' })
}

/* -------------------------------------------------------------------------- */
/* v1.1 结束总结 / 今日单词表（SPEC v1.1 §B）                                    */
/* -------------------------------------------------------------------------- */

/** 结束对话总结接口。 */
export const SUMMARY_PATH = '/api/summary'

/** 今日单词表接口。 */
export const WORDBOOK_PATH = '/api/wordbook'

/**
 * 总结接口超时（毫秒）。有 Key 时服务端要做一次**非流式**大模型总结（上游上限 60s），
 * 因此客户端给到 65s；demo 总结器会秒回。
 */
const SUMMARY_TIMEOUT_MS = 65_000

/**
 * 结束对话并生成总结（SPEC v1.1 §B1）。
 *
 * 服务端副作用：把 `keyWords` 写入**当天单词表**（按 word 去重、重复则 timesSeen+1），
 * 并同步写入 SRS 新词。无 Key / 上游失败时自动降级 demo 总结器，接口仍返回可用结果
 * （`demo:true`），因此正常不会抛错；只有网络/HTTP 错误才会抛中文 {@link ApiError}。
 *
 * @example
 * const summary = await summarizeConversation({
 *   messages: state.messages.map(({ role, content }) => ({ role, content })),
 *   level: 'A2',
 *   teacherName: 'Ava',
 *   mode: 'free',
 * })
 * // summary.summary_zh / summary.keyWords / summary.dailyWords / summary.addedCount
 *
 * @param {{
 *   messages: Array<{role: 'user'|'assistant'|string, content: string}>,
 *   level?: string,
 *   teacherName?: string,
 *   mode?: string,
 * }} body `messages` 建议 1–40 条（服务端限制，每条 ≤1500 字符）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   demo: boolean,
 *   summary_zh: string,
 *   topics_zh: string[],
 *   strengths_zh: string[],
 *   improvements_zh: string[],
 *   corrections: Array<{original: string, corrected: string, explanation_zh: string}>,
 *   keyWords: Array<{word: string, phonetic?: string, meaning: string, example: string, why_zh?: string}>,
 *   encouragement_zh: string,
 *   dailyWords: {date: string, words: Array<object>},
 *   addedCount: number,
 * }>}
 */
export async function summarizeConversation(body, opts = {}) {
  const source = body && typeof body === 'object' ? body : {}
  const payload = {
    ...source,
    messages: Array.isArray(source.messages) ? source.messages : [],
  }
  return postJSON(SUMMARY_PATH, payload, { timeoutMs: SUMMARY_TIMEOUT_MS, ...(opts || {}) })
}

/**
 * 读取今日单词表（SPEC v1.1 §B2）。
 *
 * 返回按日期倒序的分组（今天置顶，最多 60 天）：
 * `{ today, totalWords, days:[{date, label, words:[{word,phonetic,meaning,example,why_zh?,addedAt,source,timesSeen}], count}] }`
 *
 * @param {number} [days=7] 最近多少天（自动 clamp 到 1–60 的整数）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{today: string, totalWords: number, days: Array<{date: string, label: string, count: number, words: Array<object>}>}>}
 */
export async function getWordbook(days = 7, opts = {}) {
  const n = Number(days)
  const safeDays = Number.isFinite(n) ? Math.min(60, Math.max(1, Math.round(n))) : 7
  return getJSON(`${WORDBOOK_PATH}?days=${safeDays}`, opts)
}

/**
 * 向**当天单词表**追加/合并单词（SPEC v1.1 §B2）。
 *
 * 同 word 去重：已存在则更新释义/例句并 `timesSeen+1`。返回与 {@link getWordbook}
 * 相同的完整单词表结构（便于直接刷新 UI）。
 *
 * @example
 * await addWordbook({
 *   words: [{ word: 'commute', phonetic: '/kəˈmjuːt/', meaning: '通勤', example: 'I commute by subway.' }],
 *   source: 'free-talk',
 * })
 *
 * @param {{words: Array<{word: string, phonetic?: string, meaning?: string, example?: string, why_zh?: string}>, source?: string}} body
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{today: string, totalWords: number, days: Array<{date: string, label: string, count: number, words: Array<object>}>}>}
 */
export async function addWordbook(body, opts = {}) {
  const source = body && typeof body === 'object' ? body : {}
  const payload = {
    ...source,
    words: Array.isArray(source.words) ? source.words : [],
  }
  return postJSON(WORDBOOK_PATH, payload, opts)
}

/* -------------------------------------------------------------------------- */
/* v1.3 阅读讲解：文档上传 / 列表 / 详情 / 分析 / 删除（SPEC v1.3 §E）             */
/* -------------------------------------------------------------------------- */

/** 文档（阅读讲解）接口根路径。 */
export const DOC_PATH = '/api/doc'

/** 上传接口超时（毫秒）：base64 大文件传输较慢。 */
const DOC_UPLOAD_TIMEOUT_MS = 60_000

/** 分析接口超时（毫秒）：有 Key 时大模型非流式分析较慢。 */
const DOC_ANALYZE_TIMEOUT_MS = 90_000

/** 上传 JSON body 上限（20MB，SPEC v1.3 §C1）。 */
export const DOC_BODY_MAX_BYTES = 20 * 1024 * 1024

/** 单文件上限（12MB，SPEC v1.3 §B）。 */
export const DOC_FILE_MAX_BYTES = 12 * 1024 * 1024

/** 扩展名 → MIME（uploadDoc 未显式传 mime 时兜底）。 */
const MIME_BY_EXT = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  log: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  html: 'text/html',
  htm: 'text/html',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

/**
 * 按文件名猜测 MIME（仅用于上传 body 的 `mime` 字段；服务端主要按扩展名判断类型）。
 * @param {string} name
 * @returns {string}
 */
function guessMime(name) {
  const match = String(name || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/)
  return (match && MIME_BY_EXT[match[1]]) || 'application/octet-stream'
}

/**
 * 估算 base64 字符串解码后的原始字节数（用于前端预校验 12MB 限制）。
 * @param {string} base64
 * @returns {number}
 */
export function base64Bytes(base64) {
  const text = String(base64 == null ? '' : base64)
  if (!text) return 0
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding)
}

/**
 * 构造文档详情/删除路径（id 自动 URL 编码，空 id 抛中文错误）。
 * @param {string} id
 * @param {string} [actionPath] 额外动作路径（如 `/analyze` 用不到此函数）
 * @returns {string}
 */
function docItemPath(id) {
  const value = String(id == null ? '' : id).trim()
  if (!value) {
    throw new ApiError('缺少文档 ID，请先选择要操作的文档。', {
      code: 'argument',
      status: 400,
      path: DOC_PATH,
    })
  }
  return `${DOC_PATH}/${encodeURIComponent(value)}`
}

/**
 * 把 `File` / `Blob` 读成**纯 base64 字符串**（已去掉 `data:*;base64,` 前缀），
 * 可直接作为 `uploadDoc({ dataBase64 })` 使用。
 *
 * @example
 * const dataBase64 = await fileToBase64(input.files[0])
 * const { doc } = await uploadDoc({ name: input.files[0].name, dataBase64, mime: input.files[0].type })
 *
 * @param {File|Blob} file 浏览器 File/Blob 对象
 * @returns {Promise<string>} 纯 base64（无前缀）
 * @throws {ApiError} 文件为空/读取失败/当前环境不支持时抛中文错误
 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file || typeof file !== 'object') {
      reject(new ApiError('请选择要上传的文件。', { code: 'argument', status: 400 }))
      return
    }
    // 浏览器：FileReader.readAsDataURL 后去掉前缀
    if (typeof FileReader !== 'undefined') {
      const reader = new FileReader()
      reader.onerror = () => {
        reject(new ApiError('读取文件失败，请重试。', { code: 'file', detail: 'FileReader error', cause: reader.error }))
      }
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : ''
        const comma = result.indexOf(',')
        resolve(comma >= 0 ? result.slice(comma + 1) : result)
      }
      try {
        reader.readAsDataURL(file)
      } catch (err) {
        reject(new ApiError('读取文件失败，请重试。', { code: 'file', cause: err }))
      }
      return
    }
    // Node（QA 单测）：用 Blob.arrayBuffer + Buffer 转 base64
    if (typeof file.arrayBuffer === 'function' && typeof Buffer !== 'undefined') {
      file
        .arrayBuffer()
        .then((buffer) => resolve(Buffer.from(buffer).toString('base64')))
        .catch((err) => reject(new ApiError('读取文件失败，请重试。', { code: 'file', cause: err })))
      return
    }
    reject(new ApiError('当前环境不支持读取本地文件，请使用桌面版 Chrome。', { code: 'unsupported' }))
  })
}

/**
 * 上传英文文档或图片，交给服务端本地提取文字（SPEC v1.3 §C1）。
 *
 * 原始文件不会上传到第三方、也不会落盘（服务端只保存提取后的文字）。
 * 客户端预校验：空文件 / 超过 12MB / 编码后超过 20MB body 上限时直接抛中文 {@link ApiError}；
 * 格式不支持、扫描版 PDF、无文字图片等由服务端返回中文错误（HTTP 4xx）。
 *
 * @example
 * const { doc } = await uploadDoc({ name: 'article.pdf', dataBase64, mime: 'application/pdf' })
 * // doc: { id, name, kind, chars, truncated, warnings, createdAt, preview }
 *
 * @param {{name: string, dataBase64: string, mime?: string}} file
 *        也可直接传 `{ name: file.name, dataBase64: await fileToBase64(file), mime: file.type }`
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, doc: {id: string, name: string, kind: string, chars: number, truncated: boolean, warnings: string[], createdAt: number, preview: string}}>}
 */
export async function uploadDoc(file, opts = {}) {
  const source = file && typeof file === 'object' ? file : {}
  const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : ''
  const dataBase64 = typeof source.dataBase64 === 'string' ? source.dataBase64.trim() : ''
  if (!dataBase64) {
    throw new ApiError('文件内容为空，请选择要上传的英文文档或图片。', {
      code: 'argument',
      status: 400,
      path: `${DOC_PATH}/upload`,
    })
  }
  const bytes = base64Bytes(dataBase64)
  if (bytes > DOC_FILE_MAX_BYTES) {
    const mb = (bytes / 1024 / 1024).toFixed(1)
    throw new ApiError(`文件过大：单个文件最大 12MB（当前约 ${mb}MB），请压缩或截取后重试。`, {
      code: 'payload',
      status: 413,
      path: `${DOC_PATH}/upload`,
    })
  }
  if (dataBase64.length > DOC_BODY_MAX_BYTES) {
    throw new ApiError('文件过大：上传请求超出 20MB 限制。', {
      code: 'payload',
      status: 413,
      path: `${DOC_PATH}/upload`,
    })
  }
  const payload = {
    name: name || '未命名文档',
    dataBase64,
    mime: typeof source.mime === 'string' && source.mime.trim() ? source.mime.trim() : guessMime(name),
  }
  return postJSON(`${DOC_PATH}/upload`, payload, { timeoutMs: DOC_UPLOAD_TIMEOUT_MS, ...(opts || {}) })
}

/**
 * 列出最近上传的文档（SPEC v1.3 §C2，按 createdAt 倒序，最多 30 条）。
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, docs: Array<{id: string, name: string, kind: string, chars: number, createdAt: number, analyzed: boolean}>}>}
 */
export async function listDocs(opts = {}) {
  return getJSON(`${DOC_PATH}/list`, opts)
}

/**
 * 读取单个文档详情（含提取文字 `text` 与缓存的分析 `analysis`，SPEC v1.3 §C2）。
 * @param {string} id 文档 id（自动 URL 编码）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, doc: {id: string, name: string, kind: string, chars: number, truncated: boolean, warnings: string[], text: string, createdAt: number, analysis?: object}}>}
 */
export async function getDoc(id, opts = {}) {
  return getJSON(docItemPath(id), opts)
}

/**
 * 让 Ava 分析文档（摘要/要点/重点词汇/理解题，SPEC v1.3 §C3）。
 *
 * 无 Key 或上游失败时服务端降级 demo 分析，**接口永不失败**；结果会缓存到 doc.analysis。
 * 有 Key 时大模型分析较慢，因此超时给到 90s。
 *
 * @example
 * const { analysis } = await analyzeDoc('d_ab12cd34', 'A2')
 * // analysis: { summary_zh, keyPoints[{en,zh}], keyWords[], questions[{en,zh}], readAloud, wordCount }
 *
 * @param {string} id 文档 id
 * @param {string} [level] CEFR 等级（如 `'A2'`，可选）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, demo: boolean, docId: string, analysis: {summary_zh: string, keyPoints: Array<{en: string, zh: string}>, keyWords: Array<{word: string, phonetic?: string, meaning: string, example: string, why_zh?: string}>, questions: Array<{en: string, zh: string}>, readAloud: string, wordCount: number}}>}
 */
export async function analyzeDoc(id, level, opts = {}) {
  const docId = String(id == null ? '' : id).trim()
  if (!docId) {
    throw new ApiError('缺少文档 ID，请先选择要分析的文档。', {
      code: 'argument',
      status: 400,
      path: `${DOC_PATH}/analyze`,
    })
  }
  const payload = { id: docId }
  const levelValue = typeof level === 'string' ? level.trim() : ''
  if (levelValue) payload.level = levelValue
  return postJSON(`${DOC_PATH}/analyze`, payload, { timeoutMs: DOC_ANALYZE_TIMEOUT_MS, ...(opts || {}) })
}

/**
 * 删除一个文档（同时删除服务端缓存的提取文字与分析结果，SPEC v1.3 §C2）。
 * @param {string} id 文档 id
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean}>}
 */
export async function deleteDoc(id, opts = {}) {
  return deleteJSON(docItemPath(id), opts)
}

/* -------------------------------------------------------------------------- */
/* v1.4 豆包实时语音（SPEC v1.4 §C4）                                           */
/* -------------------------------------------------------------------------- */

/** 火山/豆包连接测试接口（服务端代理，浏览器不接触密钥）。 */
export const VOLC_TEST_PATH = '/api/volc/test'

/** 豆包语音模式下的教练分析接口（只产出教学反馈，不产生对话回复）。 */
export const COACH_PATH = '/api/coach'

/** 火山测试 / 教练分析超时（毫秒）：服务端要建立上游连接或调文本模型。 */
const VOLC_TIMEOUT_MS = 30_000

/**
 * 测试豆包实时语音连接（SPEC v1.4 §B2）。
 *
 * 服务端用保存的配置（或本次传入的覆盖值）建立火山 WebSocket 并完成
 * StartConnection → StartSession → 等待 SessionStarted → Finish，返回耗时。
 * 成功/失败都返回 200：`{ok:true, latencyMs, model, speaker}` 或 `{ok:false, error:"中文原因"}`，
 * 因此**业务失败不会抛错**；只有网络/HTTP 错误才抛中文 {@link ApiError}。
 *
 * @example
 * const result = await api.testVolc()              // 用设置页已保存凭据
 * const result2 = await api.testVolc({ appId: '…', apiKey: '…', model: '1.2.1.1' }) // 覆盖待保存字段
 * if (!result.ok) showError(result.error)
 *
 * @param {{appId?: string, apiKey?: string, accessToken?: string, model?: string, speaker?: string, endpoint?: string, resourceId?: string}} [config]
 *        可选覆盖字段；缺省用服务端已保存配置
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, latencyMs?: number, model?: string, speaker?: string, error?: string}>}
 */
export async function testVolc(config, opts = {}) {
  const payload = config && typeof config === 'object' ? config : {}
  return postJSON(VOLC_TEST_PATH, payload, { timeoutMs: VOLC_TIMEOUT_MS, ...(opts || {}) })
}

/**
 * 豆包实时语音模式下的「教练分析」（SPEC v1.4 §B3）。
 *
 * 与 `/api/chat` 的区别：**只分析不回复**——对用户这一句英文产出
 * 纠错/更地道表达/生词/中文鼓励/中文求助卡，供 UI 渲染反馈卡；Ava 的对话回复
 * 由豆包实时语音负责，不再调用本接口生成。
 *
 * 无文本模型 Key 或上游失败时服务端降级规则版，接口仍返回可用结果（`demo:true`）。
 *
 * @example
 * const { feedback } = await api.coach({ message: userText, level: 'A2', mode: 'free' })
 * // feedback: { corrections:[], better:[], newWords:[], encouragement_zh, chineseHelp? }
 *
 * @param {{message: string, level?: string, mode?: string, history?: Array<{role:string, content:string}>, docId?: string, chinese?: boolean}} body
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, demo: boolean, feedback: {corrections: Array<object>, better: Array<object>, newWords: Array<object>, encouragement_zh: string, chineseHelp?: object}}>}
 */
export async function coach(body, opts = {}) {
  const payload = body && typeof body === 'object' ? body : {}
  return postJSON(COACH_PATH, payload, { timeoutMs: VOLC_TIMEOUT_MS, ...(opts || {}) })
}

/* -------------------------------------------------------------------------- */
/* v1.5 双语字幕翻译（SPEC v1.5 §A）                                            */
/* -------------------------------------------------------------------------- */

/** 翻译接口路径。 */
export const TRANSLATE_PATH = '/api/translate'

/** 翻译接口超时（毫秒）：服务端可能复用豆包文本会话或文本模型。 */
const TRANSLATE_TIMEOUT_MS = 20_000

/** 单次最多翻译条数（SPEC v1.5 §A3：1–8 条）。 */
export const TRANSLATE_MAX_TEXTS = 8

/** 单条最多字符数（SPEC v1.5 §A3：每条 ≤500 字）。 */
export const TRANSLATE_MAX_CHARS = 500

/**
 * **纯函数**：规范化翻译入参（供 UI 直接传字幕文本，也供 QA 单测）。
 *
 * - `texts` 可为单字符串或字符串数组；
 * - 过滤 `null`/`undefined`/空串/非字符串；
 * - 最多保留 8 条，每条截断到 500 字（先 trim 再截断）；
 * - 顺序保持不变，返回新数组。
 *
 * @example
 * normalizeTranslateTexts('Hello')            // ['Hello']
 * normalizeTranslateTexts(['Hi', '', null])   // ['Hi']
 * normalizeTranslateTexts(Array(10).fill('x')).length // 8
 *
 * @param {string|Array<string|null|undefined>|null|undefined} texts
 * @returns {string[]}
 */
export function normalizeTranslateTexts(texts) {
  const list = Array.isArray(texts) ? texts : [texts]
  /** @type {string[]} */
  const out = []
  for (const item of list) {
    if (out.length >= TRANSLATE_MAX_TEXTS) break
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    out.push(trimmed.length > TRANSLATE_MAX_CHARS ? trimmed.slice(0, TRANSLATE_MAX_CHARS) : trimmed)
  }
  return out
}

/**
 * 构造「静默降级」翻译结果（texts 全 null）。
 * @param {number} count
 * @param {Record<string, unknown>} [extra]
 * @returns {{ok: false, texts: Array<null>, provider: null, error?: string, code?: string}}
 */
function emptyTranslateResult(count, extra = {}) {
  return { ok: false, texts: new Array(Math.max(0, count)).fill(null), provider: null, ...extra }
}

/**
 * 双语字幕翻译：把一组英文文本翻译成中文（SPEC v1.5 §A）。
 *
 * **永不 throw**，供字幕静默降级使用：
 * - 成功：`{ok:true, texts:[string|null], provider?:'volc'|'llm'}`（单条失败该位置为 null）；
 * - 服务端 `{ok:false,error}`、HTTP 4xx/5xx、网络错误、超时：返回
 *   `{ok:false, texts:[null×N], error:中文原因}`（可能带 `code`/`provider`），调用方可直接忽略。
 *
 * 参数兜底见 {@link normalizeTranslateTexts}：空输入直接返回 `{ok:true,texts:[]}` 且不发请求。
 *
 * @example
 * const { texts } = await api.translate([avaReply, userText], 'zh')
 * subtitleZhA = texts[0]  // 失败时为 null → 只显示英文字幕
 *
 * @param {string|Array<string|null|undefined>} texts 单条或最多 8 条文本
 * @param {string} [target='zh'] 目标语言（默认中文）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, texts: Array<string|null>, provider?: string|null, error?: string, code?: string}>}
 */
export async function translate(texts, target = 'zh', opts = {}) {
  const normalized = normalizeTranslateTexts(texts)
  if (!normalized.length) return { ok: true, texts: [], provider: null }

  const targetLang = typeof target === 'string' && target.trim() ? target.trim() : 'zh'
  try {
    const data = await postJSON(
      TRANSLATE_PATH,
      { texts: normalized, target: targetLang },
      { timeoutMs: TRANSLATE_TIMEOUT_MS, ...(opts || {}) },
    )
    if (!data || typeof data !== 'object') {
      return emptyTranslateResult(normalized.length, { error: '翻译服务返回内容无法解析' })
    }
    const provider = typeof data.provider === 'string' ? data.provider : null
    if (data.ok === false) {
      const error =
        typeof data.error === 'string' && data.error.trim() ? data.error : '翻译服务暂不可用，已仅显示英文'
      return emptyTranslateResult(normalized.length, { error, provider })
    }
    const list = Array.isArray(data.texts) ? data.texts : []
    const out = normalized.map((_, index) => {
      const value = list[index]
      return typeof value === 'string' && value.trim() ? value : null
    })
    return { ok: true, texts: out, provider }
  } catch (err) {
    // 英文/语音主流程不能被翻译拖垮：任何错误都降级为 texts 全 null
    const raw = /** @type {any} */ (err)
    const message =
      raw && typeof raw.message === 'string' && raw.message.trim()
        ? raw.message
        : '翻译服务暂不可用，已仅显示英文'
    return emptyTranslateResult(normalized.length, {
      error: message,
      code: raw && typeof raw.code === 'string' ? raw.code : 'translate',
    })
  }
}

/* -------------------------------------------------------------------------- */
/* v1.6 手机版：角色 / 学习计划 / Ava 助手（SPEC v1.6 §B）                       */
/* -------------------------------------------------------------------------- */

/** 角色列表接口路径。 */
export const CHARACTERS_PATH = '/api/characters'

/** 学习计划接口路径。 */
export const PLAN_PATH = '/api/plan'

/** Ava 助手接口路径。 */
export const ASSISTANT_PATH = '/api/assistant'

/** 助手接口超时（毫秒）：有豆包文本会话时首包较慢。 */
const ASSISTANT_TIMEOUT_MS = 30_000

/**
 * 读取全部角色卡（SPEC v1.6 §B1）。
 *
 * 返回的角色不含人设 prompt 全文，只有展示字段：
 * `{id,name,city,style,tags,voiceLabel,cover,greeting,scenes:[{id,label,emoji}],level}`。
 *
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, characters: Array<{id: string, name: string, city: string, style: string, tags: string[], voiceLabel: string, cover: string, greeting: string, scenes: Array<{id: string, label: string, emoji: string}>, level: string}>}>}
 */
export async function getCharacters(opts = {}) {
  return getJSON(CHARACTERS_PATH, opts)
}

/**
 * 读取单个角色卡（SPEC v1.6 §B2）。
 * @param {string} id 角色 id（如 `'elena'` / `'maya'` / `'hikari'`）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, character: {id: string, name: string, city: string, style: string, tags: string[], voiceLabel: string, cover: string, greeting: string, scenes: Array<object>, level: string}}>}
 */
export async function getCharacter(id, opts = {}) {
  const value = String(id == null ? '' : id).trim()
  if (!value) {
    throw new ApiError('缺少角色 ID，请先选择角色。', {
      code: 'argument',
      status: 400,
      path: CHARACTERS_PATH,
    })
  }
  return getJSON(`${CHARACTERS_PATH}/${encodeURIComponent(value)}`, opts)
}

/**
 * 读取当前学习计划（SPEC v1.6 §B3）。未创建时服务端返回 `{ok:true, plan:null}`。
 *
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, plan: {id: string, characterId: string, goal: string, level: string, createdAt: number, stages: Array<{id: string, title: string, emoji: string, progress: number, scenes: Array<{characterId: string, sceneId: string, label: string}>}>, updatedAt: number}|null}>}
 */
export async function getPlan(opts = {}) {
  return getJSON(PLAN_PATH, opts)
}

/**
 * 构造助手「静默失败」结果（永不 throw）。
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 * @returns {{ok: false, error: string, reply: '', actions: Array<never>}}
 */
function assistantFailure(error, extra = {}) {
  return { ok: false, error: String(error || '助手暂不可用，请稍后再试。'), reply: '', actions: [], ...extra }
}

/**
 * 与 Ava 助手对话（SPEC v1.6 §B4，手机版「助手」Tab）。
 *
 * **永不 throw**（UI 直接显示 `reply`/错误提示即可）：
 * - 成功：`{ok:true, demo:boolean, reply:string, actions:Array<{type,payload}>, plan?}`
 *   —— `actions` 类型：`create_plan` / `update_plan` / `open_scene` / `open_tab` / `review_words`；
 * - 业务失败/HTTP/网络/超时：`{ok:false, error:中文, reply:'', actions:[]}`。
 *
 * @example
 * const res = await api.assistantChat({ message: '帮我制定一个 A2 学习计划' })
 * if (res.ok) {
 *   renderReply(res.reply)
 *   for (const action of res.actions) applyAction(action) // create_plan → 刷新课程页
 * }
 *
 * @param {{message: string, characterId?: string, history?: Array<{role: string, content: string}>}} body
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, demo?: boolean, reply: string, actions: Array<{type: string, payload?: unknown}>, plan?: object|null, error?: string, code?: string}>}
 */
export async function assistantChat(body, opts = {}) {
  const source = body && typeof body === 'object' ? body : {}
  const message = typeof source.message === 'string' ? source.message : String(source.message == null ? '' : source.message)
  /** @type {Record<string, unknown>} */
  const payload = { message }
  const characterId = typeof source.characterId === 'string' ? source.characterId.trim() : ''
  if (characterId) payload.characterId = characterId
  if (Array.isArray(source.history)) payload.history = source.history
  try {
    const data = await postJSON(ASSISTANT_PATH, payload, { timeoutMs: ASSISTANT_TIMEOUT_MS, ...(opts || {}) })
    if (!data || typeof data !== 'object') {
      return assistantFailure('助手返回内容无法解析，请稍后再试。')
    }
    if (data.ok === false) {
      const error =
        typeof data.error === 'string' && data.error.trim() ? data.error : '助手暂不可用，请稍后再试。'
      return assistantFailure(error)
    }
    /** @type {{ok: boolean, demo?: boolean, reply: string, actions: Array<{type: string, payload?: unknown}>, plan?: object|null}} */
    const result = {
      ok: true,
      demo: !!data.demo,
      reply: typeof data.reply === 'string' ? data.reply : '',
      actions: Array.isArray(data.actions) ? data.actions.filter((action) => action && typeof action === 'object') : [],
    }
    if (data.plan !== undefined) result.plan = data.plan
    return result
  } catch (err) {
    const raw = /** @type {any} */ (err)
    const messageText =
      raw && typeof raw.message === 'string' && raw.message.trim() ? raw.message : '助手暂不可用，请稍后再试。'
    return assistantFailure(messageText, {
      code: raw && typeof raw.code === 'string' ? raw.code : 'assistant',
    })
  }
}

/* -------------------------------------------------------------------------- */
/* v1.8 个人知识库 / 兴趣档案（SPEC v1.8 §B）                                    */
/* -------------------------------------------------------------------------- */

/** 个人知识库接口根路径。 */
export const KB_PATH = '/api/kb'

/** 个人兴趣档案接口路径。 */
export const PROFILE_PATH = '/api/profile'

/** 知识库上传超时（毫秒）：服务端要本地提取 + 异步建块。 */
const KB_UPLOAD_TIMEOUT_MS = 90_000

/** 网页链接导入超时（毫秒）：服务端抓取 HTML + 正文提取。 */
const KB_URL_TIMEOUT_MS = 60_000

/** 检索超时（毫秒）：查询扩展 + BM25 + LLM 重排。 */
const KB_SEARCH_TIMEOUT_MS = 60_000

/** 知识库 enrich 超时（毫秒）：逐块生成摘要/关键词可能较慢。 */
const KB_ENRICH_TIMEOUT_MS = 120_000

/**
 * 构造知识库「静默失败」结果（永不 throw）。
 * @param {unknown} error
 * @param {Record<string, unknown>} [extra]
 * @returns {{ok: false, error: string} & Record<string, unknown>}
 */
function kbFailure(error, extra = {}) {
  const raw = /** @type {any} */ (error)
  const message =
    raw && typeof raw === 'object' && typeof raw.message === 'string'
      ? raw.message
      : String(error == null ? '' : error)
  return {
    ok: false,
    error: message && message.trim() ? message : '知识库服务暂不可用，请稍后再试。',
    ...extra,
  }
}

/**
 * 把请求异常翻译成知识库静默失败结果。
 * @param {unknown} err
 * @param {Record<string, unknown>} [extra]
 * @returns {{ok: false, error: string} & Record<string, unknown>}
 */
function kbCatch(err, extra = {}) {
  const raw = /** @type {any} */ (err)
  const message = raw && typeof raw.message === 'string' ? raw.message : ''
  return kbFailure(message || '知识库服务暂不可用，请稍后再试。', {
    code: raw && typeof raw.code === 'string' ? raw.code : 'kb',
    ...extra,
  })
}

/**
 * 生成知识库单文档路径（id 自动编码；空 id 返回 null）。
 * @param {string} id
 * @returns {string|null}
 */
function kbDocPath(id) {
  const value = String(id == null ? '' : id).trim()
  return value ? `${KB_PATH}/${encodeURIComponent(value)}` : null
}

/**
 * 上传本地文件到个人知识库（SPEC v1.8 §B1/§B2）。
 *
 * 服务端本地提取文字（复用文档解析），切块并异步生成摘要/关键词；原始文件不落盘。
 * **永不 throw**：空文件/超限/HTTP/网络/失败均返回 `{ok:false, error}`（中文），成功 `{ok:true, doc}`。
 *
 * @example
 * const dataBase64 = await fileToBase64(file)
 * const res = await api.kbUpload({ name: file.name, dataBase64, mime: file.type })
 * if (res.ok) renderKbDoc(res.doc)
 *
 * @param {{name: string, dataBase64: string, mime?: string}} file
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, doc?: object|null, error?: string, code?: string}>}
 */
export async function kbUpload(file, opts = {}) {
  const source = file && typeof file === 'object' ? file : {}
  const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : ''
  const dataBase64 = typeof source.dataBase64 === 'string' ? source.dataBase64.trim() : ''
  if (!dataBase64) {
    return kbFailure('文件内容为空，请选择要导入知识库的文档或图片。', { code: 'argument', doc: null })
  }
  const bytes = base64Bytes(dataBase64)
  if (bytes > DOC_FILE_MAX_BYTES) {
    const mb = (bytes / 1024 / 1024).toFixed(1)
    return kbFailure(`文件过大：单个文件最大 12MB（当前约 ${mb}MB），请压缩后重试。`, { code: 'payload', doc: null })
  }
  if (dataBase64.length > DOC_BODY_MAX_BYTES) {
    return kbFailure('文件过大：上传请求超出 20MB 限制。', { code: 'payload', doc: null })
  }
  const payload = {
    name: name || '未命名文档',
    dataBase64,
    mime: typeof source.mime === 'string' && source.mime.trim() ? source.mime.trim() : guessMime(name),
  }
  try {
    const data = await postJSON(`${KB_PATH}/upload`, payload, { timeoutMs: KB_UPLOAD_TIMEOUT_MS, ...(opts || {}) })
    if (!data || typeof data !== 'object') return kbFailure('知识库返回内容无法解析。', { doc: null })
    if (data.ok === false) return kbFailure(data.error || '导入知识库失败，请重试。', { doc: null })
    return { ...data, ok: true, doc: data.doc && typeof data.doc === 'object' ? data.doc : null }
  } catch (err) {
    return kbCatch(err, { doc: null })
  }
}

/**
 * 通过网页链接导入知识库（SPEC v1.8 §B1）。
 * @param {string} url 以 http(s):// 开头的网页链接
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, doc?: object|null, error?: string, code?: string}>}
 */
export async function kbImportUrl(url, opts = {}) {
  const value = typeof url === 'string' ? url.trim() : ''
  if (!value) return kbFailure('请输入要导入的网页链接。', { code: 'argument', doc: null })
  if (!/^https?:\/\//i.test(value)) {
    return kbFailure('链接格式不正确，请以 http:// 或 https:// 开头。', { code: 'argument', doc: null })
  }
  try {
    const data = await postJSON(`${KB_PATH}/url`, { url: value }, { timeoutMs: KB_URL_TIMEOUT_MS, ...(opts || {}) })
    if (!data || typeof data !== 'object') return kbFailure('知识库返回内容无法解析。', { doc: null })
    if (data.ok === false) return kbFailure(data.error || '网页导入失败，请检查链接后重试。', { doc: null })
    return { ...data, ok: true, doc: data.doc && typeof data.doc === 'object' ? data.doc : null }
  } catch (err) {
    return kbCatch(err, { doc: null })
  }
}

/**
 * 列出个人知识库文档（SPEC v1.8 §B5）。
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, docs: Array<object>, error?: string, code?: string}>}
 */
export async function kbList(opts = {}) {
  try {
    const data = await getJSON(`${KB_PATH}/list`, opts)
    if (!data || typeof data !== 'object') return kbFailure('知识库返回内容无法解析。', { docs: [] })
    if (data.ok === false) return kbFailure(data.error || '读取知识库列表失败。', { docs: [] })
    return { ...data, ok: true, docs: Array.isArray(data.docs) ? data.docs : [] }
  } catch (err) {
    return kbCatch(err, { docs: [] })
  }
}

/**
 * 读取单个知识库文档详情（含原文/分块/摘要状态）。
 * @param {string} id
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, doc: object|null, error?: string}>}
 */
export async function kbGet(id, opts = {}) {
  const path = kbDocPath(id)
  if (!path) return kbFailure('缺少知识库文档 ID。', { code: 'argument', doc: null })
  try {
    const data = await getJSON(path, opts)
    if (!data || typeof data !== 'object') return kbFailure('知识库返回内容无法解析。', { doc: null })
    if (data.ok === false) return kbFailure(data.error || '读取文档失败。', { doc: null })
    return { ...data, ok: true, doc: data.doc && typeof data.doc === 'object' ? data.doc : null }
  } catch (err) {
    return kbCatch(err, { doc: null })
  }
}

/**
 * 删除知识库文档（只删本地 data/kb，不影响原始文件）。
 * @param {string} id
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function kbDelete(id, opts = {}) {
  const path = kbDocPath(id)
  if (!path) return kbFailure('缺少知识库文档 ID。', { code: 'argument' })
  try {
    const data = await deleteJSON(path, opts)
    if (data && typeof data === 'object' && data.ok === false) {
      return kbFailure(data.error || '删除知识库文档失败。')
    }
    return { ...(data && typeof data === 'object' ? data : {}), ok: true }
  } catch (err) {
    return kbCatch(err)
  }
}

/**
 * 检索个人知识库（混合检索：查询扩展 + BM25 + LLM 重排，SPEC v1.8 §B3）。
 *
 * **永不 throw**：失败返回 `{ok:false, error, results:[]}`。
 * 成功原样透传服务端字段（含 `results:[{docId,chunkId,title,text,score,...}]`）。
 *
 * @example
 * const { results } = await api.kbSearch('文艺复兴对现代艺术的影响', { limit: 5 })
 * // 通话/对话里可作为引用卡片展示 results[i].title / results[i].text
 *
 * @param {string} query
 * @param {{docIds?: string[], limit?: number, signal?: AbortSignal|null, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, query: string, results: Array<object>, hits?: Array<object>, error?: string, code?: string}>}
 */
export async function kbSearch(query, options = {}) {
  const value = typeof query === 'string' ? query.trim() : ''
  if (!value) return kbFailure('请输入要检索的内容。', { code: 'argument', query: '', results: [] })
  const source = options && typeof options === 'object' ? options : {}
  const { docIds, limit, ...requestOpts } = source
  /** @type {Record<string, unknown>} */
  const payload = { query: value }
  if (Array.isArray(docIds)) {
    const ids = docIds
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim())
      .slice(0, 50)
    if (ids.length) payload.docIds = ids
  }
  const limitNumber = Number(limit)
  if (Number.isFinite(limitNumber) && limitNumber > 0) {
    payload.limit = Math.min(50, Math.max(1, Math.round(limitNumber)))
  }
  try {
    const data = await postJSON(`${KB_PATH}/search`, payload, {
      timeoutMs: KB_SEARCH_TIMEOUT_MS,
      ...(requestOpts || {}),
    })
    if (!data || typeof data !== 'object') {
      return kbFailure('知识库返回内容无法解析。', { query: value, results: [] })
    }
    if (data.ok === false) {
      return kbFailure(data.error || '知识库检索失败。', { query: value, results: [] })
    }
    // 服务端成功响应字段为 `hits`（SPEC 未限定字段名）；这里兼容 `results`/`hits` 两种命名，
    // 统一在 `results` 暴露给 UI，同时保留原始 `hits` 字段。
    const hits = Array.isArray(data.hits) ? data.hits : Array.isArray(data.results) ? data.results : []
    return {
      ...data,
      ok: true,
      query: typeof data.query === 'string' ? data.query : value,
      results: Array.isArray(data.results) ? data.results : hits,
      hits,
    }
  } catch (err) {
    return kbCatch(err, { query: value, results: [] })
  }
}

/**
 * 对知识库文档补全/重建摘要与关键词（SPEC v1.8 §B2，可能较慢）。
 * @param {string} id
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, doc: object|null, error?: string}>}
 */
export async function kbEnrich(id, opts = {}) {
  const path = kbDocPath(id)
  if (!path) return kbFailure('缺少知识库文档 ID。', { code: 'argument', doc: null })
  try {
    const data = await postJSON(`${path}/enrich`, {}, { timeoutMs: KB_ENRICH_TIMEOUT_MS, ...(opts || {}) })
    if (!data || typeof data !== 'object') return kbFailure('知识库返回内容无法解析。', { doc: null })
    if (data.ok === false) return kbFailure(data.error || '知识库 enrich 失败，请重试。', { doc: null })
    return { ...data, ok: true, doc: data.doc && typeof data.doc === 'object' ? data.doc : null }
  } catch (err) {
    return kbCatch(err, { doc: null })
  }
}

/**
 * 读取个人兴趣档案（SPEC v1.8 §B6，`data/memory.json` 的 interests 等）。
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, profile: object|null, interests: string[], error?: string}>}
 */
export async function getProfile(opts = {}) {
  try {
    const data = await getJSON(PROFILE_PATH, opts)
    if (!data || typeof data !== 'object') return kbFailure('兴趣档案返回内容无法解析。', { profile: null, interests: [] })
    if (data.ok === false) return kbFailure(data.error || '读取兴趣档案失败。', { profile: null, interests: [] })
    const profile = data.profile && typeof data.profile === 'object' ? data.profile : null
    const interests = Array.isArray(data.interests)
      ? data.interests
      : profile && Array.isArray(profile.interests)
        ? profile.interests
        : []
    return {
      ...data,
      ok: true,
      profile,
      interests: interests.filter((item) => typeof item === 'string'),
    }
  } catch (err) {
    return kbCatch(err, { profile: null, interests: [] })
  }
}

/**
 * 保存个人兴趣标签（会参与角色对话的「视角/兴趣」记忆，SPEC v1.8 §B6）。
 *
 * 入参自动规范化：trim、去空、去重、每条 ≤40 字、最多 30 个。**永不 throw**。
 *
 * @example
 * await api.saveProfile({ interests: ['艺术史', '单板滑雪', '独立游戏'] })
 *
 * @param {{interests: string[]}} [body]
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, profile: object|null, interests?: string[], error?: string}>}
 */
export async function saveProfile(body, opts = {}) {
  const source = body && typeof body === 'object' ? body : {}
  /** @type {string[]} */
  const interests = []
  for (const item of Array.isArray(source.interests) ? source.interests : []) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim().slice(0, 40)
    if (!trimmed || interests.includes(trimmed)) continue
    interests.push(trimmed)
    if (interests.length >= 30) break
  }
  try {
    const data = await putJSON(PROFILE_PATH, { interests }, { ...(opts || {}) })
    if (!data || typeof data !== 'object') {
      return kbFailure('兴趣档案返回内容无法解析。', { profile: null, code: 'profile' })
    }
    if (data.ok === false) {
      return kbFailure(data.error || '保存兴趣档案失败，请重试。', { profile: null, code: 'profile' })
    }
    return {
      ...data,
      ok: true,
      profile: data.profile && typeof data.profile === 'object' ? data.profile : { interests },
      interests,
    }
  } catch (err) {
    return kbCatch(err, { profile: null })
  }
}

/* -------------------------------------------------------------------------- */
/* v2.7 单词复习系统（SPEC v2.7 §B）                                            */
/* -------------------------------------------------------------------------- */

/** 单词复习接口根路径。 */
export const REVIEW_PATH = '/api/review'

/** 复习状态白名单（列表筛选/更新状态）。 */
export const REVIEW_STATUSES = ['all', 'new', 'learning', 'known']

/** SRS 四档评分白名单（SPEC v2.7 §B3）。 */
export const REVIEW_GRADES = ['again', 'hard', 'good', 'easy']

/** due/list 默认与边界。 */
const REVIEW_DUE_LIMIT = 20
const REVIEW_LIST_LIMIT = 200
const REVIEW_MAX_LIMIT = 500
const REVIEW_MAX_BATCH = 200

/**
 * 构造复习接口「静默失败」结果（永不 throw）。
 * @param {unknown} error
 * @param {Record<string, unknown>} [extra]
 * @returns {{ok: false, error: string} & Record<string, unknown>}
 */
function reviewFailure(error, extra = {}) {
  const raw = /** @type {any} */ (error)
  const message =
    raw && typeof raw === 'object' && typeof raw.message === 'string'
      ? raw.message
      : String(error == null ? '' : error)
  return {
    ok: false,
    error: message && message.trim() ? message : '复习服务暂不可用，请稍后再试。',
    ...extra,
  }
}

/**
 * 把请求异常翻译成复习静默失败结果。
 * @param {unknown} err
 * @param {Record<string, unknown>} [extra]
 */
function reviewCatch(err, extra = {}) {
  const raw = /** @type {any} */ (err)
  const message = raw && typeof raw.message === 'string' ? raw.message : ''
  return reviewFailure(message || '复习服务暂不可用，请稍后再试。', {
    code: raw && typeof raw.code === 'string' ? raw.code : 'review',
    ...extra,
  })
}

/**
 * clamp 数字参数到 [min, max]，非法回退 fallback。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function reviewLimit(value, fallback, min = 1, max = REVIEW_MAX_LIMIT) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 规范化单个复习词条（供 addReviewWords 与 QA 单测）。
 * @param {unknown} item
 * @returns {{word: string, meaning?: string, phonetic?: string, example?: string, source?: string, sourceTitle?: string, status?: string}|null}
 */
function normalizeReviewWordItem(item) {
  if (!item || typeof item !== 'object') return null
  const raw = /** @type {Record<string, unknown>} */ (item)
  const word = typeof raw.word === 'string' ? raw.word.trim() : ''
  if (!word) return null
  /** @type {{word: string, meaning?: string, phonetic?: string, example?: string, source?: string, sourceTitle?: string, status?: string}} */
  const entry = { word }
  for (const key of ['meaning', 'phonetic', 'example', 'source', 'sourceTitle']) {
    if (typeof raw[key] === 'string' && /** @type {string} */ (raw[key]).trim()) {
      entry[/** @type {'meaning'|'phonetic'|'example'|'source'|'sourceTitle'} */ (key)] = /** @type {string} */ (raw[key]).trim()
    }
  }
  if (typeof raw.status === 'string' && ['new', 'learning', 'known'].includes(raw.status)) {
    entry.status = raw.status
  }
  return entry
}

/**
 * **纯函数**：规范化批量复习词（trim、过滤空/非法、按小写去重、上限 200）。
 * @param {unknown} words
 * @returns {Array<{word: string, meaning?: string, phonetic?: string, example?: string, source?: string, sourceTitle?: string, status?: string}>}
 */
export function normalizeReviewWords(words) {
  const list = Array.isArray(words) ? words : [words]
  /** @type {ReturnType<typeof normalizeReviewWordItem>[]} */
  const out = []
  const seen = new Set()
  for (const item of list) {
    const entry = normalizeReviewWordItem(item)
    if (!entry) continue
    const key = entry.word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
    if (out.length >= REVIEW_MAX_BATCH) break
  }
  return /** @type {Array<{word: string}>} */ (out)
}

/**
 * 读取复习概览（SPEC v2.7 §B2）：今日到期/总数/新词/学习中/已掌握。
 *
 * **永不 throw**：失败返回 `{ok:false,error}` 且计数全 0。
 *
 * @example
 * const { dueCount, total, newCount, learningCount, knownCount } = await api.getReviewSummary()
 *
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, dueCount: number, total: number, newCount: number, learningCount: number, knownCount: number, error?: string, code?: string}>}
 */
export async function getReviewSummary(opts = {}) {
  const empty = { dueCount: 0, total: 0, newCount: 0, learningCount: 0, knownCount: 0 }
  try {
    const data = await getJSON(`${REVIEW_PATH}/summary`, opts)
    if (!data || typeof data !== 'object') return reviewFailure('复习概览返回内容无法解析。', empty)
    if (data.ok === false) return reviewFailure(data.error || '读取复习概览失败。', empty)
    const num = (value) => {
      const n = Number(value)
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
    }
    return {
      ...data,
      ok: true,
      dueCount: num(data.dueCount),
      total: num(data.total),
      newCount: num(data.newCount),
      learningCount: num(data.learningCount),
      knownCount: num(data.knownCount),
    }
  } catch (err) {
    return reviewCatch(err, empty)
  }
}

/**
 * 读取今日到期复习词（SPEC v2.7 §B2，按 due 升序）。
 * @param {number} [limit=20] 最多返回多少条（clamp 1–500，默认 20）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, words: Array<object>, error?: string, code?: string}>}
 */
export async function getReviewDue(limit = REVIEW_DUE_LIMIT, opts = {}) {
  const safeLimit = reviewLimit(limit, REVIEW_DUE_LIMIT)
  try {
    const data = await getJSON(`${REVIEW_PATH}/due?limit=${safeLimit}`, opts)
    if (!data || typeof data !== 'object') return reviewFailure('到期词列表返回内容无法解析。', { words: [] })
    if (data.ok === false) return reviewFailure(data.error || '读取今日到期词失败。', { words: [] })
    const words = Array.isArray(data.words) ? data.words : Array.isArray(data.list) ? data.list : []
    return { ...data, ok: true, words }
  } catch (err) {
    return reviewCatch(err, { words: [] })
  }
}

/**
 * 查询复习词库（SPEC v2.7 §B2）。
 *
 * @example
 * const { words, counts } = await api.listReview({ status: 'learning', q: 'coffee', limit: 200 })
 *
 * @param {{status?: 'all'|'new'|'learning'|'known', q?: string, limit?: number, signal?: AbortSignal|null, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, words: Array<object>, counts: {new?: number, learning?: number, known?: number, total?: number}, total: number, error?: string, code?: string}>}
 */
export async function listReview(options = {}) {
  const source = options && typeof options === 'object' ? options : {}
  const rawStatus = typeof source.status === 'string' ? source.status.trim().toLowerCase() : 'all'
  const status = REVIEW_STATUSES.includes(rawStatus) ? rawStatus : 'all'
  const q = typeof source.q === 'string' ? source.q.trim().slice(0, 100) : ''
  const limit = reviewLimit(source.limit, REVIEW_LIST_LIMIT)
  const { signal, timeoutMs } = source
  const params = new URLSearchParams()
  params.set('status', status)
  if (q) params.set('q', q)
  params.set('limit', String(limit))
  try {
    const data = await getJSON(`${REVIEW_PATH}/list?${params.toString()}`, { signal, timeoutMs })
    if (!data || typeof data !== 'object') {
      return reviewFailure('复习词库返回内容无法解析。', { words: [], counts: {}, total: 0 })
    }
    if (data.ok === false) return reviewFailure(data.error || '读取复习词库失败。', { words: [], counts: {}, total: 0 })
    const words = Array.isArray(data.words) ? data.words : Array.isArray(data.list) ? data.list : []
    const counts = data.counts && typeof data.counts === 'object' ? data.counts : {}
    const total = Number.isFinite(Number(data.total)) ? Math.max(0, Math.round(Number(data.total))) : words.length
    return { ...data, ok: true, words, counts, total, status }
  } catch (err) {
    return reviewCatch(err, { words: [], counts: {}, total: 0 })
  }
}

/**
 * 批量加入/更新复习词（SPEC v2.7 §B2，服务端 upsert）。
 *
 * 入参自动规范化（见 {@link normalizeReviewWords}），空输入直接返回 `{ok:true, added:0, words:[]}` 且不发请求。
 * **永不 throw**。
 *
 * @example
 * await api.addReviewWords([{ word: 'serendipity', meaning: '意外发现的美好', example: 'Meeting you was serendipity.' }])
 *
 * @param {Array<{word: string, meaning?: string, phonetic?: string, example?: string, source?: string, sourceTitle?: string, status?: 'new'|'learning'|'known'}>} words
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, added: number, words: Array<object>, error?: string, code?: string}>}
 */
export async function addReviewWords(words, opts = {}) {
  const normalized = normalizeReviewWords(words)
  if (!normalized.length) return { ok: true, added: 0, words: [] }
  try {
    const data = await postJSON(`${REVIEW_PATH}/add`, { words: normalized }, { ...(opts || {}) })
    if (!data || typeof data !== 'object') return reviewFailure('加入复习失败：返回内容无法解析。', { added: 0, words: [] })
    if (data.ok === false) return reviewFailure(data.error || '加入复习失败，请重试。', { added: 0, words: [] })
    const added = Number.isFinite(Number(data.added)) ? Math.max(0, Math.round(Number(data.added))) : normalized.length
    const list = Array.isArray(data.words) ? data.words : []
    return { ...data, ok: true, added, words: list }
  } catch (err) {
    return reviewCatch(err, { added: 0, words: [] })
  }
}

/**
 * 更新复习词（改释义/音标/例句/状态/来源，SPEC v2.7 §B2）。
 *
 * patch 为空（无有效字段）或 word 为空时**不发请求**，直接返回中文失败。
 * **永不 throw**。
 *
 * @param {string} word 单词（trim 后不能为空）
 * @param {{meaning?: string, phonetic?: string, example?: string, status?: 'new'|'learning'|'known', source?: string, sourceTitle?: string}} patch
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, word?: object|null, error?: string, code?: string}>}
 */
export async function updateReviewWord(word, patch, opts = {}) {
  const value = typeof word === 'string' ? word.trim() : ''
  if (!value) return reviewFailure('缺少要更新的单词。', { code: 'argument', word: null })
  const sourcePatch = patch && typeof patch === 'object' ? patch : {}
  /** @type {Record<string, unknown>} */
  const normalizedPatch = {}
  for (const key of ['meaning', 'phonetic', 'example', 'source', 'sourceTitle']) {
    const item = sourcePatch[key]
    if (typeof item === 'string') normalizedPatch[key] = item.trim()
  }
  if (typeof sourcePatch.status === 'string' && ['new', 'learning', 'known'].includes(sourcePatch.status)) {
    normalizedPatch.status = sourcePatch.status
  }
  if (!Object.keys(normalizedPatch).length) {
    return reviewFailure('没有要修改的内容。', { code: 'argument', word: null })
  }
  try {
    const data = await patchJSON(`${REVIEW_PATH}/word`, { word: value, patch: normalizedPatch }, { ...(opts || {}) })
    if (!data || typeof data !== 'object') return reviewFailure('更新复习词失败：返回内容无法解析。', { word: null })
    if (data.ok === false) return reviewFailure(data.error || '更新复习词失败，请重试。', { word: null })
    return { ...data, ok: true, word: data.word && typeof data.word === 'object' ? data.word : null }
  } catch (err) {
    return reviewCatch(err, { word: null })
  }
}

/**
 * 删除复习词（SPEC v2.7 §B2）。
 * @param {string} word
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, code?: string}>}
 */
export async function deleteReviewWord(word, opts = {}) {
  const value = typeof word === 'string' ? word.trim() : ''
  if (!value) return reviewFailure('缺少要删除的单词。', { code: 'argument' })
  try {
    const data = await deleteJSON(`${REVIEW_PATH}/word?word=${encodeURIComponent(value)}`, opts)
    if (data && typeof data === 'object' && data.ok === false) {
      return reviewFailure(data.error || '删除复习词失败。')
    }
    return { ...(data && typeof data === 'object' ? data : {}), ok: true }
  } catch (err) {
    return reviewCatch(err)
  }
}

/**
 * 提交 SRS 评分（SPEC v2.7 §B2/§B3：again/hard/good/easy）。
 *
 * grade 不在白名单时**不发请求**并返回中文失败；成功返回更新后的词与最新 summary（若服务端返回）。
 * **永不 throw**。
 *
 * @example
 * const { word, summary } = await api.gradeReviewWord('serendipity', 'good')
 *
 * @param {string} word
 * @param {'again'|'hard'|'good'|'easy'} grade
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, word?: object|null, summary?: object|null, error?: string, code?: string}>}
 */
export async function gradeReviewWord(word, grade, opts = {}) {
  const value = typeof word === 'string' ? word.trim() : ''
  const valueGrade = typeof grade === 'string' ? grade.trim().toLowerCase() : ''
  if (!value) return reviewFailure('缺少要评分的单词。', { code: 'argument', word: null })
  if (!REVIEW_GRADES.includes(valueGrade)) {
    return reviewFailure('评分参数无效：只支持 again / hard / good / easy。', {
      code: 'argument',
      word: null,
    })
  }
  try {
    const data = await postJSON(
      `${REVIEW_PATH}/grade`,
      { word: value, grade: valueGrade },
      { ...(opts || {}) },
    )
    if (!data || typeof data !== 'object') return reviewFailure('评分失败：返回内容无法解析。', { word: null })
    if (data.ok === false) return reviewFailure(data.error || '评分失败，请重试。', { word: null })
    const summary =
      data.summary && typeof data.summary === 'object'
        ? data.summary
        : data.counts && typeof data.counts === 'object'
          ? data.counts
          : null
    return {
      ...data,
      ok: true,
      word: data.word && typeof data.word === 'object' ? data.word : null,
      summary,
    }
  } catch (err) {
    return reviewCatch(err, { word: null })
  }
}

/* -------------------------------------------------------------------------- */
/* v3.0 课程 / 场景教学（SPEC v3.0）                                            */
/* -------------------------------------------------------------------------- */

/** 课程接口根路径。 */
export const LESSONS_PATH = '/api/lessons'

/**
 * 构造课程接口「静默失败」结果（永不 throw）。
 * @param {unknown} error
 * @param {Record<string, unknown>} [extra]
 * @returns {{ok: false, error: string} & Record<string, unknown>}
 */
function lessonsFailure(error, extra = {}) {
  const raw = /** @type {any} */ (error)
  const message =
    raw && typeof raw === 'object' && typeof raw.message === 'string'
      ? raw.message
      : String(error == null ? '' : error)
  return {
    ok: false,
    error: message && message.trim() ? message : '课程服务暂不可用，请稍后再试。',
    ...extra,
  }
}

/**
 * 把请求异常翻译成课程接口静默失败结果。
 * @param {unknown} err
 * @param {Record<string, unknown>} [extra]
 */
function lessonsCatch(err, extra = {}) {
  const raw = /** @type {any} */ (err)
  const message = raw && typeof raw.message === 'string' ? raw.message : ''
  return lessonsFailure(message || '课程服务暂不可用，请稍后再试。', {
    code: raw && typeof raw.code === 'string' ? raw.code : 'lessons',
    ...extra,
  })
}

/**
 * 课程列表（SPEC v3.0，可传角色过滤）。
 *
 * **永不 throw**：失败返回 `{ok:false,error}` 且 `lessons:[]`。
 *
 * @example
 * const { lessons } = await api.getLessons('elena')
 *
 * @param {string} [characterId=''] 角色 id（如 `'elena'`；空串表示全部）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, lessons: Array<object>, error?: string, code?: string}>}
 */
export async function getLessons(characterId = '', opts = {}) {
  const value = typeof characterId === 'string' ? characterId.trim() : ''
  const path = value ? `${LESSONS_PATH}?characterId=${encodeURIComponent(value)}` : LESSONS_PATH
  try {
    const data = await getJSON(path, opts)
    if (!data || typeof data !== 'object') {
      return lessonsFailure('课程列表返回内容无法解析。', { lessons: [] })
    }
    if (data.ok === false) return lessonsFailure(data.error || '读取课程列表失败。', { lessons: [] })
    const lessons = Array.isArray(data.lessons) ? data.lessons : Array.isArray(data.list) ? data.list : []
    return { ...data, ok: true, lessons }
  } catch (err) {
    return lessonsCatch(err, { lessons: [] })
  }
}

/**
 * 单节课程详情（SPEC v3.0，含 objectives / 常用句 / 3 步）。
 *
 * **永不 throw**：失败返回 `{ok:false,error}` 且 `lesson:null`；空 id 不发请求。
 *
 * @example
 * const { lesson } = await api.getLesson('elena_gallery_1')
 *
 * @param {string} id 课程 id
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, lesson: object|null, error?: string, code?: string}>}
 */
export async function getLesson(id, opts = {}) {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!value) return lessonsFailure('缺少课程 ID。', { code: 'argument', lesson: null })
  try {
    const data = await getJSON(`${LESSONS_PATH}/${encodeURIComponent(value)}`, opts)
    if (!data || typeof data !== 'object') {
      return lessonsFailure('课程详情返回内容无法解析。', { lesson: null })
    }
    if (data.ok === false) return lessonsFailure(data.error || '读取课程失败。', { lesson: null })
    return { ...data, ok: true, lesson: data.lesson && typeof data.lesson === 'object' ? data.lesson : null }
  } catch (err) {
    return lessonsCatch(err, { lesson: null })
  }
}

/* -------------------------------------------------------------------------- */
/* v3.1 学习计划：整份计划换老师 / 重新生成课程（SPEC v3.1）                       */
/* -------------------------------------------------------------------------- */

/**
 * 构造计划操作「静默失败」结果（永不 throw）。
 * @param {unknown} error
 * @param {Record<string, unknown>} [extra]
 */
function planActionFailure(error, extra = {}) {
  const raw = /** @type {any} */ (error)
  const message =
    raw && typeof raw === 'object' && typeof raw.message === 'string'
      ? raw.message
      : String(error == null ? '' : error)
  return {
    ok: false,
    error: message && message.trim() ? message : '计划服务暂不可用，请稍后再试。',
    ...extra,
  }
}

/**
 * @param {unknown} err
 * @param {Record<string, unknown>} [extra]
 */
function planActionCatch(err, extra = {}) {
  const raw = /** @type {any} */ (err)
  const message = raw && typeof raw.message === 'string' ? raw.message : ''
  return planActionFailure(message || '计划服务暂不可用，请稍后再试。', {
    code: raw && typeof raw.code === 'string' ? raw.code : 'plan',
    ...extra,
  })
}

/**
 * 整份学习计划统一更换老师（SPEC v3.1：Elena/Maya/Hikari，可随时换）。
 *
 * **永不 throw**：没有计划/老师不存在等业务失败返回 `{ok:false,error}` 且 `plan:null`；
 * 空 teacherId 直接中文失败且不发请求。
 *
 * @example
 * const res = await api.setPlanTeacher('maya')
 * if (res.ok) renderPlan(res.plan)
 *
 * @param {string} teacherId 角色 id（`'elena'` | `'maya'` | `'hikari'`）
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, plan: object|null, teacherId?: string, error?: string, code?: string}>}
 */
export async function setPlanTeacher(teacherId, opts = {}) {
  const value = typeof teacherId === 'string' ? teacherId.trim() : ''
  if (!value) return planActionFailure('缺少老师 ID，请先选择老师。', { code: 'argument', plan: null })
  try {
    const data = await patchJSON(`${PLAN_PATH}/teacher`, { teacherId: value }, { ...(opts || {}) })
    if (!data || typeof data !== 'object') {
      return planActionFailure('计划接口返回内容无法解析。', { plan: null })
    }
    if (data.ok === false) return planActionFailure(data.error || '更换老师失败。', { plan: null })
    return { ...data, ok: true, plan: data.plan && typeof data.plan === 'object' ? data.plan : null }
  } catch (err) {
    return planActionCatch(err, { plan: null })
  }
}

/**
 * 重新生成当前学习计划（SPEC v3.1：清空旧课程，后台重新生成 3 节课）。
 *
 * 服务端会立即返回清空后的 plan（`generating:true`），课程页需轮询 `getPlan()` 等待生成完成。
 * **永不 throw**：没有计划等业务失败返回 `{ok:false,error}` 且 `plan:null`。
 *
 * @example
 * const res = await api.regeneratePlan()
 * if (res.ok) startPlanPolling()
 *
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, plan: object|null, error?: string, code?: string}>}
 */
export async function regeneratePlan(opts = {}) {
  try {
    const data = await postJSON(`${PLAN_PATH}/generate`, {}, { timeoutMs: 30_000, ...(opts || {}) })
    if (!data || typeof data !== 'object') {
      return planActionFailure('计划接口返回内容无法解析。', { plan: null })
    }
    if (data.ok === false) return planActionFailure(data.error || '重新生成计划失败。', { plan: null })
    return { ...data, ok: true, plan: data.plan && typeof data.plan === 'object' ? data.plan : null }
  } catch (err) {
    return planActionCatch(err, { plan: null })
  }
}

/* -------------------------------------------------------------------------- */
/* SSE 解析（纯函数，供 QA 单测）                                               */
/* -------------------------------------------------------------------------- */

/**
 * 解析单个 SSE 帧文本（不含末尾空行）。
 *
 * 规则遵循 SSE 规范（简化版）：
 * - `event: xxx` 事件类型，默认 `message`；
 * - `data: xxx` 可多行，最终用 `\n` 拼接（值前的一个空格会被去掉）；
 * - 以 `:` 开头的行是注释，忽略；
 * - `id:` / `retry:` 解析后返回，但 Ava 目前不使用。
 *
 * @param {string} frame
 * @returns {{event: string, data: string, id: string, retry: number|null}}
 */
export function parseSSEFrame(frame) {
  const lines = String(frame == null ? '' : frame).split('\n')
  let event = 'message'
  let id = ''
  /** @type {number|null} */
  let retry = null
  /** @type {string[]} */
  const dataLines = []

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value || 'message'
    else if (field === 'data') dataLines.push(value)
    else if (field === 'id') id = value
    else if (field === 'retry') {
      const n = Number(value)
      retry = Number.isFinite(n) ? n : null
    }
  }

  return { event, data: dataLines.join('\n'), id, retry }
}

/**
 * **纯函数**：从 SSE 文本缓冲区中切出完整事件帧，返回 `{events, rest}`。
 *
 * - 空行（`\n\n`，兼容 `\r\n`）分帧；
 * - `data:` 多行会拼接为 `data` 字符串（chatStream 再按需 JSON.parse）；
 * - 末尾不完整的帧留在 `rest`，下次与新的 chunk 拼接后继续解析；
 * - 跨 chunk 的 `\r\n` 被切开的边界情况也已处理。
 *
 * @example
 * const { events, rest } = parseSSEChunk('event: delta\ndata: {"text":"Hi"}\n\npart')
 * // events === [{ event:'delta', data:'{"text":"Hi"}', id:'', retry:null }]
 * // rest === 'part'
 *
 * @param {string} buffer 累积的 SSE 文本
 * @returns {{events: Array<{event: string, data: string, id: string, retry: number|null}>, rest: string}}
 */
export function parseSSEChunk(buffer) {
  const input = typeof buffer === 'string' ? buffer : ''
  if (!input) return { events: [], rest: '' }

  // 若上一块以孤立 \r 结尾，它可能是下一块 \n 的前半，暂不归一化，留在 rest 里。
  const carryCR = input.endsWith('\r')
  const text = (carryCR ? input.slice(0, -1) : input).replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const frames = text.split('\n\n')
  let rest = frames.pop()
  if (rest === undefined) rest = ''
  if (carryCR) rest += '\r'

  /** @type {Array<{event: string, data: string, id: string, retry: number|null}>} */
  const events = []
  for (const frame of frames) {
    if (!frame.trim()) continue
    const parsed = parseSSEFrame(frame)
    // SSE 规范：data 为空且没有显式 event 的帧（如 `: connected` 注释/心跳）不产生事件
    if (!parsed.data && parsed.event === 'message') continue
    events.push(parsed)
  }
  return { events, rest }
}

/* -------------------------------------------------------------------------- */
/* 流式对话 chatStream                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 流式对话：POST `/api/chat`，自行解析 SSE 事件序列
 * `meta` → `delta`* → `feedback` → `done`（出错时 `error` 后 `done`）。
 *
 * handlers：
 * - `onMeta(payload)`：`{demo, fallback?, reason?, model}`
 * - `onDelta(text, payload)`：增量英文正文（已累积在内部，`payload` 为原始对象）
 * - `onFeedback(payload)`：`{corrections, better, newWords, encouragement_zh, followUp?}`
 * - `onDone(payload)`：`{fullReply, ...}`；流结束时至少调用一次（异常提前结束时带 `incomplete:true`）
 * - `onError(ApiError)`：网络/HTTP/流内 `error` 事件；中文 `message` + `code`
 * - `onEvent(evt)`（可选）：兜底接收所有原始事件，调试用
 *
 * 主动 `abort()` 时**不会**触发 onError/onDone，Promise 以 `{ok:false, aborted:true}` 结束。
 *
 * @param {Record<string, unknown>} body
 *        `{mode, topicId, scenarioId, level, message, history, focusWords, teacherName}`
 * @param {{onMeta?: Function, onDelta?: Function, onFeedback?: Function, onDone?: Function, onError?: Function, onEvent?: Function}} [handlers]
 * @returns {{abort: () => void, promise: Promise<{ok: boolean, aborted?: boolean, incomplete?: boolean}>, readonly aborted: boolean, readonly finished: boolean}}
 */
export function chatStream(body, handlers = {}) {
  const h = handlers && typeof handlers === 'object' ? handlers : {}
  const controller = new AbortController()

  let aborted = false
  let finished = false
  let errorSent = false
  let sawEvent = false
  let accumulated = ''
  /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
  let reader = null

  /**
   * 派发错误（只触发一次）。
   * @param {string|ApiError} message
   * @param {{code?: string, status?: number, detail?: string, cause?: unknown}} [meta]
   */
  const emitError = (message, meta = {}) => {
    if (errorSent || aborted) return
    errorSent = true
    const err =
      message instanceof ApiError
        ? message
        : new ApiError(message, { code: 'chat', path: CHAT_PATH, ...meta })
    safeCall(h.onError, err)
  }

  /** 取消底层 reader（吞掉 cancel 返回的 rejected Promise，避免 unhandledrejection）。 */
  const cancelReader = () => {
    if (!reader) return
    try {
      const result = reader.cancel()
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 处理一个 SSE 事件。
   * @param {{event: string, data: string}} evt
   */
  const handleEvent = (evt) => {
    if (aborted || finished) return
    sawEvent = true
    const type = evt.event || 'message'
    const raw = evt.data

    /** @type {any} */
    let payload = raw
    if (raw !== '') {
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = raw
      }
    }

    switch (type) {
      case 'meta':
        safeCall(h.onMeta, payload || {})
        break

      case 'delta': {
        let text = ''
        if (typeof payload === 'string') text = payload
        else if (payload && typeof payload === 'object') {
          if (typeof payload.text === 'string') text = payload.text
          else if (typeof payload.delta === 'string') text = payload.delta
        }
        if (text) {
          accumulated += text
          safeCall(h.onDelta, text, payload)
        }
        break
      }

      case 'feedback':
        safeCall(h.onFeedback, payload || {})
        break

      case 'error': {
        let message = 'AI 回复过程中出现错误，请重试。'
        if (payload && typeof payload === 'object') {
          const candidate = payload.message || payload.error
          if (typeof candidate === 'string' && candidate.trim()) message = candidate
        } else if (typeof payload === 'string' && payload.trim()) {
          message = payload
        }
        emitError(message, { code: 'stream', detail: truncate(raw) })
        break
      }

      case 'done': {
        finished = true
        const donePayload =
          payload && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {}
        const fullReply =
          typeof donePayload.fullReply === 'string' && donePayload.fullReply
            ? donePayload.fullReply
            : accumulated
        safeCall(h.onDone, { ...donePayload, fullReply })
        cancelReader()
        break
      }

      default:
        // ping / heartbeat / 未知事件：不打断正常流程，交给可选 onEvent
        safeCall(h.onEvent, evt)
        break
    }
  }

  /**
   * 消费缓冲区里的完整帧。
   * @param {string} buffer
   * @param {boolean} [flushTail=false] 流结束时为末尾补一个空行，强制解析最后一帧
   * @returns {string} 剩余缓冲区
   */
  const drain = (buffer, flushTail = false) => {
    const input = flushTail ? `${buffer}\n\n` : buffer
    const { events, rest } = parseSSEChunk(input)
    for (const evt of events) {
      handleEvent(evt)
      if (finished || aborted) break
    }
    return flushTail ? '' : rest
  }

  /** 主动中断：不再触发任何 handler。 */
  const abort = () => {
    if (aborted || finished) return
    aborted = true
    try {
      controller.abort()
    } catch {
      /* 忽略 */
    }
    cancelReader()
  }

  const promise = (async () => {
    try {
      /** @type {Response} */
      let res
      try {
        res = await apiFetch(urlOf(CHAT_PATH), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(body && typeof body === 'object' ? body : {}),
          signal: controller.signal,
          cache: 'no-store',
        })
      } catch (err) {
        if (aborted) return { ok: false, aborted: true }
        const raw = /** @type {any} */ (err)
        emitError(
          '无法连接对话服务：网络请求失败。请确认 Ava 服务器已启动（http://127.0.0.1:5180）。',
          { code: 'network', detail: String(raw && raw.message ? raw.message : raw || ''), cause: err },
        )
        return { ok: false, error: 'network' }
      }

      if (aborted) {
        try {
          await res.body?.cancel?.()
        } catch {
          /* 忽略 */
        }
        return { ok: false, aborted: true }
      }

      if (!res.ok) {
        let text = ''
        try {
          text = await res.text()
        } catch {
          /* 忽略，使用状态码兜底 */
        }
        const detail = pickDetail(parseJSONLoose(text)) || truncate(text)
        emitError(httpErrorMessage(res.status, detail, CHAT_PATH), {
          code: 'http',
          status: res.status,
          detail,
        })
        return { ok: false, error: 'http' }
      }

      // 极老浏览器 / 特殊环境没有 ReadableStream：整段读完再解析（仍能拿到完整事件）
      if (!res.body || typeof res.body.getReader !== 'function') {
        const text = await res.text()
        drain(text, true)
        if (!finished) {
          if (sawEvent || accumulated) {
            finished = true
            safeCall(h.onDone, { fullReply: accumulated, incomplete: true })
          } else {
            emitError('对话服务未返回任何内容，请稍后重试。', { code: 'stream' })
          }
        }
        return { ok: !errorSent && !aborted, incomplete: true }
      }

      reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (!finished) {
        let chunk
        try {
          chunk = await reader.read()
        } catch (err) {
          if (aborted) return { ok: false, aborted: true }
          const raw = /** @type {any} */ (err)
          emitError('AI 回复连接中断，请重试。', {
            code: 'stream',
            detail: String(raw && raw.message ? raw.message : raw || ''),
            cause: err,
          })
          return { ok: false, error: 'stream' }
        }
        if (chunk.done) break
        if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true })
        buffer = drain(buffer)
      }

      if (!finished) {
        buffer += decoder.decode()
        drain(buffer, true)
        if (!finished) {
          if (sawEvent || accumulated) {
            finished = true
            safeCall(h.onDone, { fullReply: accumulated, incomplete: true })
          } else {
            emitError('对话服务未返回任何内容，请稍后重试。', { code: 'stream' })
          }
        }
      }

      return { ok: !errorSent && !aborted, incomplete: !finished }
    } catch (err) {
      if (aborted) return { ok: false, aborted: true }
      const raw = /** @type {any} */ (err)
      emitError('对话请求失败，请重试。', {
        code: 'chat',
        detail: String(raw && raw.message ? raw.message : raw || ''),
        cause: err,
      })
      return { ok: false, error: 'chat' }
    } finally {
      if (reader) {
        try {
          reader.releaseLock()
        } catch {
          /* 忽略 */
        }
      }
    }
  })()

  return {
    abort,
    promise,
    get aborted() {
      return aborted
    },
    get finished() {
      return finished
    },
  }
}

/* -------------------------------------------------------------------------- */
/* 业务接口集合（SPEC 3.1 契约）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 后端接口集合。所有方法返回 Promise，失败抛中文 {@link ApiError}。
 * （`testSettings` 上游失败时服务端返回 `{ok:false,error}`，属于**业务失败不抛错**。）
 */
export const api = {
  /** @returns {Promise<{ok:boolean, version:string, mode:'live'|'demo', hasKey:boolean, model:string, baseUrl:string}>} */
  health: (opts) => getJSON('/api/health', opts),

  /**
   * 读取设置（v1.4 起含 `voiceEngine` 与 `volc` 配置，**密钥只返回 keyHint，绝不返回明文**）。
   * @returns {Promise<{baseUrl:string, model:string, hasKey:boolean, keyHint:string, level:string, teacherName:string, voice:string, explainChinese:boolean, autoListen:boolean, voiceEngine?:'browser'|'volc', volc?:{appId?:string, model?:string, speaker?:string, endpoint?:string, resourceId?:string, hasKey?:boolean, keyHint?:string}}>}
   */
  getSettings: (opts) => getJSON('/api/settings', opts),

  /**
   * 保存设置（v1.4 起支持透传 `voiceEngine` 与嵌套 `volc`；密钥只在用户实际填写时提交，
   * `volc.apiKey` / `volc.accessToken` 非空才覆盖，`volc.clearKey:true` 清空）。
   * @param {object} patch 任意子集 `{baseUrl, model, apiKey, level, teacherName, voice, explainChinese, autoListen, clearKey, voiceEngine, volc}`
   */
  saveSettings: (patch, opts) => putJSON('/api/settings', patch, opts),

  /** 上游连通性测试（最长 65s）。 @returns {Promise<{ok:boolean, model?:string, latencyMs?:number, error?:string}>} */
  testSettings: (opts) => postJSON('/api/settings/test', {}, { timeoutMs: 65_000, ...(opts || {}) }),

  /** @returns {Promise<{topics:Array, scenarios:Array, sentenceBanks:Array, vocabTopics:Array, levels:Array, presets:Array}>} */
  getContent: (opts) => getJSON('/api/content', opts),

  /** 跟读评分。 @param {{target:string, transcript:string, confidence?:number}} payload */
  score: (payload, opts) => postJSON('/api/score', payload, opts),

  /** @returns {Promise<{streak:number, totalTurns:number, totalMinutes:number, words:object, days:Array, updatedAt:string}>} */
  getProgress: (opts) => getJSON('/api/progress', opts),

  /** @param {{turns?:number, minutes?:number, reviewWords?:Array<{word:string, correct:boolean}>}} payload */
  saveProgress: (payload, opts) => postJSON('/api/progress', payload, opts),

  /**
   * 结束对话并生成总结（SPEC v1.1 §B1，无 Key 时 demo 总结，最长 65s）。
   * 服务端会把 keyWords 自动写入当天单词表 + SRS。
   * @param {{messages:Array<{role:string, content:string}>, level?:string, teacherName?:string, mode?:string}} body
   */
  summarizeConversation: (body, opts) => summarizeConversation(body, opts),

  /**
   * 读取今日单词表（SPEC v1.1 §B2）。
   * @param {number} [days=7] 最近多少天（1–60）
   */
  getWordbook: (days = 7, opts) => getWordbook(days, opts),

  /**
   * 向当天单词表追加/合并单词（SPEC v1.1 §B2）。
   * @param {{words:Array<object>, source?:string}} body
   */
  addWordbook: (body, opts) => addWordbook(body, opts),

  /**
   * 上传英文文档/图片（SPEC v1.3 §C1，单文件 ≤12MB，超时 60s）。
   * @param {{name:string, dataBase64:string, mime?:string}} file
   */
  uploadDoc: (file, opts) => uploadDoc(file, opts),

  /** 文档列表（SPEC v1.3 §C2）。 @returns {Promise<{ok:boolean, docs:Array<object>}>} */
  listDocs: (opts) => listDocs(opts),

  /** 文档详情（含 text/analysis）。 @param {string} id */
  getDoc: (id, opts) => getDoc(id, opts),

  /** 分析文档（SPEC v1.3 §C3，超时 90s）。 @param {string} id @param {string} [level] */
  analyzeDoc: (id, level, opts) => analyzeDoc(id, level, opts),

  /** 删除文档。 @param {string} id */
  deleteDoc: (id, opts) => deleteDoc(id, opts),

  /**
   * 测试豆包实时语音连接（SPEC v1.4 §B2，超时 30s）。
   * 业务失败返回 `{ok:false,error}`（不抛错）。
   * @param {{appId?:string, apiKey?:string, accessToken?:string, model?:string, speaker?:string, endpoint?:string, resourceId?:string}} [config]
   */
  testVolc: (config, opts) => testVolc(config, opts),

  /**
   * 豆包语音模式下的教练分析（SPEC v1.4 §B3，超时 30s，只分析不回复）。
   * @param {{message:string, level?:string, mode?:string, history?:Array<object>, docId?:string, chinese?:boolean}} body
   */
  coach: (body, opts) => coach(body, opts),

  /**
   * 双语字幕翻译（SPEC v1.5 §A，超时 20s，**永不抛错**，失败静默降级）。
   * @param {string|Array<string|null|undefined>} texts 单条或最多 8 条（每条 ≤500 字）
   * @param {string} [target='zh']
   * @returns {Promise<{ok:boolean, texts:Array<string|null>, provider?:string|null, error?:string}>}
   */
  translate: (texts, target = 'zh', opts) => translate(texts, target, opts),

  /** 角色卡列表（SPEC v1.6 §B1）。 @returns {Promise<{ok:boolean, characters:Array<object>}>} */
  getCharacters: (opts) => getCharacters(opts),

  /** 单个角色卡（SPEC v1.6 §B2）。 @param {string} id */
  getCharacter: (id, opts) => getCharacter(id, opts),

  /** 学习计划（SPEC v1.6 §B3，未创建时 plan=null）。 @returns {Promise<{ok:boolean, plan:object|null}>} */
  getPlan: (opts) => getPlan(opts),

  /**
   * Ava 助手对话（SPEC v1.6 §B4，超时 30s，**永不 throw**）。
   * @param {{message:string, characterId?:string, history?:Array<object>}} body
   */
  assistantChat: (body, opts) => assistantChat(body, opts),

  /**
   * 上传文件到个人知识库（SPEC v1.8 §B，超时 90s，**永不 throw**）。
   * @param {{name:string, dataBase64:string, mime?:string}} file
   */
  kbUpload: (file, opts) => kbUpload(file, opts),

  /** 网页链接导入知识库（超时 60s，永不 throw）。 @param {string} url */
  kbImportUrl: (url, opts) => kbImportUrl(url, opts),

  /** 知识库文档列表（永不 throw，失败 docs=[]）。 @returns {Promise<{ok:boolean, docs:Array<object>}>} */
  kbList: (opts) => kbList(opts),

  /** 知识库文档详情。 @param {string} id */
  kbGet: (id, opts) => kbGet(id, opts),

  /** 删除知识库文档。 @param {string} id */
  kbDelete: (id, opts) => kbDelete(id, opts),

  /**
   * 知识库混合检索（永不 throw，失败 results=[]）。
   * @param {string} query
   * @param {{docIds?:string[], limit?:number}} [options]
   */
  kbSearch: (query, options) => kbSearch(query, options),

  /** 补全/重建知识库文档摘要（超时 120s，永不 throw）。 @param {string} id */
  kbEnrich: (id, opts) => kbEnrich(id, opts),

  /** 个人兴趣档案。 @returns {Promise<{ok:boolean, profile:object|null, interests:string[]}>} */
  getProfile: (opts) => getProfile(opts),

  /** 保存个人兴趣标签。 @param {{interests:string[]}} body */
  saveProfile: (body, opts) => saveProfile(body, opts),

  /** 复习概览（SPEC v2.7 §B2，永不 throw，失败计数全 0）。 */
  getReviewSummary: (opts) => getReviewSummary(opts),

  /** 今日到期复习词（默认 20 条，永不 throw，失败 words=[]）。 @param {number} [limit=20] */
  getReviewDue: (limit = REVIEW_DUE_LIMIT, opts) => getReviewDue(limit, opts),

  /**
   * 复习词库列表（status 白名单 all/new/learning/known，q 搜索，limit 默认 200）。
   * @param {{status?:string, q?:string, limit?:number}} [options]
   */
  listReview: (options) => listReview(options),

  /** 批量加入/更新复习词（永不 throw，空输入不发请求）。 @param {Array<object>} words */
  addReviewWords: (words, opts) => addReviewWords(words, opts),

  /** 更新复习词释义/音标/例句/状态。 @param {string} word @param {object} patch */
  updateReviewWord: (word, patch, opts) => updateReviewWord(word, patch, opts),

  /** 删除复习词。 @param {string} word */
  deleteReviewWord: (word, opts) => deleteReviewWord(word, opts),

  /** SRS 评分（again/hard/good/easy）。 @param {string} word @param {string} grade */
  gradeReviewWord: (word, grade, opts) => gradeReviewWord(word, grade, opts),

  /** 课程列表（SPEC v3.0，永不 throw，失败 lessons=[]）。 @param {string} [characterId=''] */
  getLessons: (characterId = '', opts) => getLessons(characterId, opts),

  /** 单节课程详情（永不 throw，失败 lesson=null）。 @param {string} id */
  getLesson: (id, opts) => getLesson(id, opts),

  /** 整份学习计划更换老师（SPEC v3.1，永不 throw）。 @param {string} teacherId */
  setPlanTeacher: (teacherId, opts) => setPlanTeacher(teacherId, opts),

  /** 重新生成学习计划（后台生成 3 节课，永不 throw）。 */
  regeneratePlan: (opts) => regeneratePlan(opts),

  /** SSE 流式对话（见 {@link chatStream}），方便从 api 对象统一调用。 */
  chatStream,
}

export default api
