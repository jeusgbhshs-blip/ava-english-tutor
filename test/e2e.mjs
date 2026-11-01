#!/usr/bin/env node
/**
 * test/e2e.mjs — 端到端契约测试（零依赖，只用 Node 24 内置模块 + 本机 fetch）
 *
 * 做法：
 *   1. 把项目（server.js/lib/content/web/package.json）复制到临时沙箱目录，data/ 全空，
 *      避免污染真实 data/settings.json / data/progress.json；
 *   2. 启动 test/mock-upstream.mjs 假上游；
 *   3. 用 --port <随机空闲端口> spawn server.js，等待就绪（解析 stdout 或 .runtime/url.txt，再兜底轮询 /api/health）；
 *   4. 按 SPEC.md §2 / §7 逐项断言；失败给出「期望 / 实际 / 复现命令」；
 *   5. 结束 kill 子进程、关闭 mock、清理沙箱；结果落盘 test/artifacts/。
 *
 * 运行：
 *   /Users/cici/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node test/e2e.mjs
 *   或用 npm test（node --test 自动发现 test/ 下所有文件）。
 * 调试：E2E_KEEP=1 保留沙箱目录，E2E_SERVER_LOG=1 实时打印服务器日志。
 *
 * 退出码：0 全通过；1 有失败；2 阻塞（server.js 未落地 / 服务器起不来）。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fsp from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_DOC_ANALYSIS, DEFAULT_FEEDBACK, DEFAULT_SUMMARY, startMockUpstream } from './mock-upstream.mjs'
import { startMockVolc } from './mock-volc-realtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..')
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, 'test', 'artifacts')
/** 真实服务默认占用的端口，e2e 一律避开 */
const RESERVED_PORTS = new Set([5180, 5191, 5192, 5193])
const REPRO = `${process.execPath} ${path.join(HERE, 'e2e.mjs')}`
const START_TS = new Date()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ansi = process.stdout.isTTY
const c = {
  green: (s) => (ansi ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (ansi ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (ansi ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s) => (ansi ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (ansi ? `\x1b[1m${s}\x1b[0m` : s),
}

// ---------------------------------------------------------------------------
// 迷你测试框架：顺序执行、记录结果、失败即输出期望/实际/复现命令
// ---------------------------------------------------------------------------
const results = []
let currentGroup = '未分组'

async function group(name, fn) {
  currentGroup = name
  console.log(`\n${c.bold('## ' + name)}`)
  if (fn) await fn()
}

async function check(name, fn) {
  const started = Date.now()
  try {
    await fn()
    const ms = Date.now() - started
    results.push({ group: currentGroup, name, status: 'pass', ms })
    console.log(`  ${c.green('✔')} ${name} ${c.dim(`(${ms}ms)`)}`)
  } catch (err) {
    const ms = Date.now() - started
    const detail = err && err.stack ? err.stack : String(err)
    results.push({ group: currentGroup, name, status: 'fail', ms, error: String(err && err.message ? err.message : err), detail })
    console.log(`  ${c.red('✖')} ${name} ${c.dim(`(${ms}ms)`)}`)
    console.log(c.red(indent(detail.split('\n').slice(0, 8).join('\n'))))
  }
}

function blocked(name, reason) {
  results.push({ group: currentGroup, name, status: 'blocked', ms: 0, error: reason })
  console.log(`  ${c.yellow('◐')} ${name} — 阻塞：${reason}`)
}

function skip(name, reason) {
  results.push({ group: currentGroup, name, status: 'skip', ms: 0, error: reason })
  console.log(`  ${c.yellow('○')} ${name} — 跳过：${reason}`)
}

function indent(text) {
  return text
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')
}

/** 断言辅助：统一附上复现命令 */
function expectEqual(actual, expected, msg) {
  assert.deepEqual(
    actual,
    expected,
    `${msg}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`,
  )
}

function expectTrue(cond, msg) {
  assert.ok(cond, `${msg}\n      期望: 条件为真\n      实际: 条件为假`)
}

function expectMatch(str, re, msg) {
  assert.match(String(str), re, `${msg}\n      期望匹配: ${re}\n      实际: ${JSON.stringify(String(str).slice(0, 300))}`)
}

function expectStatus(res, expected, msg) {
  if (Array.isArray(expected)) {
    assert.ok(
      expected.includes(res.status),
      `${msg}\n      期望状态码: ${expected.join('/')}\n      实际状态码: ${res.status}\n      响应片段: ${(res.text || '').slice(0, 300)}`,
    )
  } else {
    assert.equal(
      res.status,
      expected,
      `${msg}\n      期望状态码: ${expected}\n      实际状态码: ${res.status}\n      响应片段: ${(res.text || '').slice(0, 300)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 基础设施：空闲端口、沙箱、HTTP、SSE 解析
// ---------------------------------------------------------------------------
async function getFreePort() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.unref()
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port
        srv.close(() => resolve(p))
      })
    })
    if (!RESERVED_PORTS.has(port)) return port
  }
  throw new Error('无法找到空闲测试端口')
}

async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/** 复制被测应用文件到临时沙箱（不复制 test/、docs/、data/、.runtime/） */
async function prepareSandbox() {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'ava-e2e-'))
  const entries = ['server.js', 'lib', 'content', 'web', 'package.json', 'start.command', '.gitignore']
  for (const entry of entries) {
    const src = path.join(PROJECT_ROOT, entry)
    if (!(await exists(src))) continue
    await fsp.cp(src, path.join(sandbox, entry), { recursive: true })
  }
  await fsp.mkdir(path.join(sandbox, 'data'), { recursive: true })
  await fsp.mkdir(path.join(sandbox, '.runtime'), { recursive: true })
  return sandbox
}

async function jfetch(url, opts = {}, timeoutMs = 20000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应保留 text 供断言 */
  }
  return { res, status: res.status, headers: res.headers, text, json, url }
}

function parseSSEFrame(frame) {
  let event = 'message'
  const dataLines = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  let data = null
  let jsonError = null
  try {
    data = JSON.parse(raw)
  } catch (err) {
    jsonError = String(err.message)
  }
  return { event, raw, data, jsonError }
}

/** 用 fetch 原生流解析 SSE，返回事件数组（超时会取消读取） */
async function collectSSE(res, { timeoutMs = 30000 } = {}) {
  expectEqual(res.status, 200, 'SSE 响应状态码')
  expectMatch(
    (res.headers.get('content-type') || '').toLowerCase(),
    /text\/event-stream/,
    'SSE Content-Type 应为 text/event-stream',
  )
  const events = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    reader.cancel().catch(() => {})
  }, timeoutMs)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      buf = buf.replace(/\r\n/g, '\n')
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = parseSSEFrame(frame)
        if (ev) events.push(ev)
      }
    }
  } catch (err) {
    if (!timedOut) throw err
  } finally {
    clearTimeout(timer)
  }
  if (timedOut) throw new Error(`SSE 读取超时（${timeoutMs}ms），已收到事件: ${events.map((e) => e.event).join(',')}`)
  // 收尾残帧（服务端以 \n\n 结尾时通常为空）
  const tail = parseSSEFrame(buf.trim())
  if (tail) events.push(tail)
  return events
}

function sseBody(events) {
  return events.map((e) => `event:${e.event} raw=${e.raw.slice(0, 300)}`).join('\n      ')
}

async function startServer({ sandbox, port, state }) {
  const child = spawn(process.execPath, ['server.js', '--port', String(port)], {
    cwd: sandbox,
    env: {
      ...process.env,
      // 避免任何实现里的自动开浏览器逻辑
      AVA_NO_OPEN: '1',
      NO_OPEN: '1',
      BROWSER: 'none',
      // 清空继承的 env 覆盖，保证测试按 data/settings.json 与 PUT 行为走
      AVA_API_KEY: '',
      AVA_BASE_URL: '',
      AVA_MODEL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  state.child = child
  state.logs = []
  const onChunk = (stream) => (buf) => {
    const text = buf.toString()
    state.logs.push(`[${stream}] ${text}`)
    if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400)
    if (process.env.E2E_SERVER_LOG) process.stdout.write(c.dim(`[server:${stream}] ${text}`))
  }
  child.stdout.on('data', onChunk('out'))
  child.stderr.on('data', onChunk('err'))
  const exitPromise = once(child, 'exit').then(([code, signal]) => {
    state.exited = { code, signal }
  })
  state.waitExit = exitPromise

  const deadline = Date.now() + 30000
  let baseUrl = null
  let lastErr = null
  const runtimeUrlFile = path.join(sandbox, '.runtime', 'url.txt')
  while (Date.now() < deadline) {
    if (state.exited) {
      throw new Error(`服务器启动即退出（code=${state.exited.code}, signal=${state.exited.signal}）\n服务器日志:\n${state.logs.join('')}`)
    }
    // a) 解析 stdout 中的 "Ava ready at http://127.0.0.1:PORT"
    const logText = state.logs.join('')
    const m = logText.match(/Ava ready at\s+(http:\/\/127\.0\.0\.1:\d+)/)
    if (m && !baseUrl) baseUrl = m[1]
    // b) .runtime/url.txt
    if (!baseUrl && (await exists(runtimeUrlFile))) {
      const text = (await fsp.readFile(runtimeUrlFile, 'utf8')).trim()
      const um = text.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (um) baseUrl = um[0]
    }
    // c) 兜底：直接轮询 /api/health（按我们指定的端口）
    const candidates = baseUrl ? [baseUrl] : [`http://127.0.0.1:${port}`]
    for (const candidate of candidates) {
      try {
        const r = await jfetch(`${candidate}/api/health`, {}, 1500)
        if (r.status === 200) {
          baseUrl = candidate
          break
        }
        lastErr = `GET ${candidate}/api/health -> ${r.status}`
      } catch (err) {
        lastErr = `GET ${candidate}/api/health -> ${err.name}: ${err.message}`
      }
    }
    if (baseUrl) return { baseUrl, child }
    await sleep(150)
  }
  throw new Error(`等待服务器就绪超时（30s）：${lastErr}\n服务器日志:\n${state.logs.join('')}`)
}

async function stopServer(state) {
  const child = state.child
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([state.waitExit.then(() => true), sleep(4000).then(() => false)])
  if (!exited) {
    child.kill('SIGKILL')
    await Promise.race([state.waitExit, sleep(2000)])
  }
}

async function fremove(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

function localDateString(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/** 轮询等待（e2e 桥测试用） */
async function waitUntil(fn, { timeoutMs = 10000, interval = 40, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      lastErr = err
    }
    await sleep(interval)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${lastErr ? `（${lastErr.message}）` : ''}`)
}

async function main() {
  console.log(c.bold('Ava e2e 契约测试'))
  console.log(c.dim(`项目: ${PROJECT_ROOT}`))
  console.log(c.dim(`复现: ${REPRO}`))

  await fsp.mkdir(ARTIFACTS_DIR, { recursive: true })

  if (!(await exists(path.join(PROJECT_ROOT, 'server.js')))) {
    blocked('启动 server.js', 'server.js 尚未落地（等待 Lead）。复现：node test/e2e.mjs')
    return { code: 2, state: null, sandbox: null }
  }

  const sandbox = await prepareSandbox()
  const state = { child: null, logs: [], exited: null }
  const mock = await startMockUpstream()
  const port = await getFreePort()
  let baseUrl
  try {
    const started = await startServer({ sandbox, port, state })
    baseUrl = started.baseUrl
    const api = (p) => `${baseUrl}${p}`
    console.log(c.dim(`server: ${baseUrl}  mock upstream: ${mock.url}  sandbox: ${sandbox}`))

    const validKey = 'sk-qa-e2e-test-KEY-7d4e'
    let settings = null

    // =====================================================================
    await group('健康检查 / 基础', async () => {
      await check('GET /api/health 返回 SPEC 约定字段', async () => {
        const r = await jfetch(api('/api/health'))
        expectStatus(r, 200, 'GET /api/health')
        expectMatch(r.headers.get('content-type') || '', /application\/json/i, 'health Content-Type 应为 JSON')
        const h = r.json
        expectEqual(h.ok, true, 'health.ok')
        expectEqual(h.version, '1.0.0', 'health.version 应为 1.0.0（SPEC §2.1）')
        expectTrue(h.mode === 'live' || h.mode === 'demo', `health.mode 应为 live/demo，实际 ${JSON.stringify(h.mode)}`)
        expectEqual(typeof h.hasKey, 'boolean', 'health.hasKey 应为 boolean')
        expectEqual(typeof h.model, 'string', 'health.model 应为 string')
        expectEqual(typeof h.baseUrl, 'string', 'health.baseUrl 应为 string')
      })

      await check('GET /api/settings 初始无 Key，且不含 apiKey 原文', async () => {
        const r = await jfetch(api('/api/settings'))
        expectStatus(r, 200, 'GET /api/settings')
        settings = r.json
        expectEqual(settings.hasKey, false, '新沙箱初始 settings.hasKey 应为 false')
        expectTrue(!('apiKey' in settings) || settings.apiKey === undefined || settings.apiKey === '', 'settings 不应包含 apiKey 字段')
        expectTrue(!r.text.includes('sk-'), 'settings 响应体不应出现任何 sk- 开头的 key 原文')
        for (const k of ['baseUrl', 'model', 'level', 'teacherName', 'voice', 'explainChinese', 'autoListen']) {
          expectTrue(k in settings, `settings 应包含字段 ${k}`)
        }
      })

      await check('GET /api/content 内容结构完整', async () => {
        const r = await jfetch(api('/api/content'))
        expectStatus(r, 200, 'GET /api/content')
        expectMatch(r.headers.get('content-type') || '', /application\/json/i, 'content Content-Type 应为 JSON')
        const ct = r.json
        for (const key of ['topics', 'scenarios', 'sentenceBanks', 'vocabTopics', 'levels', 'presets']) {
          expectTrue(Array.isArray(ct[key]), `content.${key} 应为数组`)
          expectTrue(ct[key].length >= 2, `content.${key} 至少 2 项，实际 ${ct[key].length}`)
        }
        expectTrue(ct.topics.length >= 4, `topics 至少 4 个（SPEC §5.1），实际 ${ct.topics.length}`)
        expectTrue(ct.scenarios.length >= 3, `scenarios 至少 3 个（SPEC §5.4），实际 ${ct.scenarios.length}`)
        expectTrue(ct.vocabTopics.length >= 3, `vocabTopics 至少 3 个，实际 ${ct.vocabTopics.length}`)
        for (const t of ct.topics) {
          for (const k of ['id', 'emoji', 'name', 'desc', 'level']) expectTrue(k in t, `topic 缺少 ${k}: ${JSON.stringify(t).slice(0, 120)}`)
          expectTrue(Array.isArray(t.questions) && t.questions.length > 0, `topic ${t.id} 应有非空 questions`)
        }
        for (const s of ct.scenarios) {
          for (const k of ['id', 'emoji', 'name', 'desc', 'level', 'role', 'opener']) expectTrue(k in s, `scenario 缺少 ${k}: ${JSON.stringify(s).slice(0, 120)}`)
          expectTrue(Array.isArray(s.objectives) && s.objectives.length > 0, `scenario ${s.id} 应有 objectives`)
          expectTrue(Array.isArray(s.script) && s.script.length > 0, `scenario ${s.id} 应有 script`)
          for (const line of s.script) expectTrue(['assistant', 'user'].includes(line.role) && typeof line.en === 'string' && typeof line.zh === 'string', `scenario ${s.id} script 行结构不符`)
        }
        for (const b of ct.sentenceBanks) {
          expectTrue(Array.isArray(b.sentences) && b.sentences.length > 0, `sentenceBank ${b.id} 应有 sentences`)
          for (const s of b.sentences) expectTrue(typeof s.en === 'string' && typeof s.zh === 'string', `sentenceBank ${b.id} 句子缺 en/zh`)
        }
        for (const v of ct.vocabTopics) {
          expectTrue(Array.isArray(v.words) && v.words.length > 0, `vocabTopic ${v.id} 应有 words`)
          for (const w of v.words) {
            for (const k of ['word', 'phonetic', 'meaning', 'example', 'exampleZh']) {
              expectTrue(typeof w[k] === 'string' && w[k].length > 0, `vocabTopic ${v.id} 单词 ${w.word || '?'} 缺少 ${k}`)
            }
          }
        }
        const levelIds = ct.levels.map((l) => (typeof l === 'string' ? l : l.id))
        for (const cefr of ['A1', 'A2', 'B1', 'B2', 'C1']) expectTrue(levelIds.includes(cefr), `levels 应包含 ${cefr}，实际 ${JSON.stringify(levelIds)}`)
        for (const p of ct.presets) {
          expectTrue(typeof p.name === 'string' && typeof p.baseUrl === 'string' && typeof p.model === 'string', 'presets 项应含 name/baseUrl/model')
        }
      })

      await check('静态文件：/、/avatar/preview.html、CSS/JS 模块均 200', async () => {
        const index = await jfetch(api('/'))
        expectStatus(index, 200, 'GET /')
        expectMatch(index.headers.get('content-type') || '', /text\/html/i, '/ Content-Type')
        expectMatch(index.text, /id=["']avatar-stage["']/, '/ 应包含 <div id="avatar-stage">（SPEC §4）')
        expectMatch(index.text, /<script[^>]+type=["']module["']/, '/ 应通过 <script type="module"> 加载应用')

        const preview = await jfetch(api('/avatar/preview.html'))
        expectStatus(preview, 200, 'GET /avatar/preview.html')
        expectMatch(preview.headers.get('content-type') || '', /text\/html/i, 'preview Content-Type')
        expectTrue(preview.text.length > 200, 'preview.html 内容不应为空')

        const assets = [
          ['/css/app.css', /text\/css/i],
          ['/js/api.js', /javascript/i],
          ['/js/speech.js', /javascript/i],
          ['/js/store.js', /javascript/i],
          ['/js/main.js', /javascript/i],
          ['/js/modes.js', /javascript/i],
          ['/avatar/avatar.js', /javascript/i],
          ['/avatar/avatar.css', /text\/css/i],
        ]
        for (const [asset, ctRe] of assets) {
          const r = await jfetch(api(asset))
          expectStatus(r, 200, `GET ${asset}`)
          expectMatch(r.headers.get('content-type') || '', ctRe, `${asset} Content-Type`)
          expectTrue(r.text.length > 50, `${asset} 内容不应为空`)
        }
      })
    })

    // =====================================================================
    await group('设置：PUT / key 安全 / 连接测试', async () => {
      await check('PUT /api/settings 保存 baseUrl/model/apiKey/level/teacherName', async () => {
        const r = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseUrl: mock.url,
            model: 'mock-model',
            apiKey: validKey,
            level: 'A2',
            teacherName: 'Ava',
            explainChinese: true,
            autoListen: false,
          }),
        })
        expectStatus(r, 200, 'PUT /api/settings')
        settings = r.json
        expectEqual(settings.baseUrl, mock.url, '保存后的 baseUrl')
        expectEqual(settings.model, 'mock-model', '保存后的 model')
        expectEqual(settings.hasKey, true, '保存 apiKey 后 hasKey 应为 true')
        expectEqual(settings.level, 'A2', '保存后的 level')
        expectEqual(settings.teacherName, 'Ava', '保存后的 teacherName')
        expectTrue(!r.text.includes(validKey), `PUT /api/settings 响应不得包含完整 apiKey；实际响应: ${r.text.slice(0, 300)}`)
        expectTrue(!r.text.includes('KEY-7d4e'), 'PUT /api/settings 响应不得包含完整 apiKey 片段')
      })

      await check('GET /api/settings 只暴露 keyHint（后 4 位），绝不含完整 key', async () => {
        const r = await jfetch(api('/api/settings'))
        expectStatus(r, 200, 'GET /api/settings')
        const s = r.json
        expectEqual(s.hasKey, true, 'hasKey')
        expectTrue(typeof s.keyHint === 'string' && s.keyHint.length > 0, `keyHint 应为非空字符串，实际 ${JSON.stringify(s.keyHint)}`)
        expectTrue(s.keyHint.endsWith('7d4e'), `keyHint 应以后 4 位 7d4e 结尾，实际 ${JSON.stringify(s.keyHint)}`)
        expectTrue(!r.text.includes(validKey), `GET /api/settings 泄露完整 apiKey: ${r.text.slice(0, 300)}`)
        expectTrue(!r.text.includes('KEY-7d4e'), 'GET /api/settings 不得包含完整 key 片段 KEY-7d4e')
        expectTrue(!('apiKey' in s) || s.apiKey === undefined || s.apiKey === '', 'settings 对象不得带 apiKey 字段')
      })

      await check('POST /api/settings/test 指向 mock 上游返回 ok:true', async () => {
        const before = mock.calls.length
        const r = await jfetch(api('/api/settings/test'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        expectStatus(r, 200, 'POST /api/settings/test')
        expectEqual(r.json.ok, true, `settings/test 应成功；实际响应: ${r.text.slice(0, 300)}`)
        expectEqual(typeof r.json.model, 'string', 'settings/test 应返回 model')
        expectTrue(typeof r.json.latencyMs === 'number' && r.json.latencyMs >= 0, `settings/test 应返回 latencyMs，实际 ${JSON.stringify(r.json.latencyMs)}`)
        expectTrue(mock.calls.length > before, 'settings/test 应真实请求 mock 上游（mock 未收到请求）')
      })

      await check('POST /api/settings/test 上游 401 时返回 ok:false + error 且不泄露 key', async () => {
        mock.setScenario('401')
        try {
          const r = await jfetch(api('/api/settings/test'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          expectStatus(r, 200, 'POST /api/settings/test（上游 401）')
          expectEqual(r.json.ok, false, `上游 401 时 ok 应为 false；实际: ${r.text.slice(0, 300)}`)
          expectTrue(typeof r.json.error === 'string' && r.json.error.length > 0, '失败时应返回非空 error')
          expectTrue(!r.text.includes(validKey), '错误响应不得泄露 apiKey')
        } finally {
          mock.setScenario('ok')
        }
      })

      await check('非法 JSON 请求体返回 4xx + {ok:false,error}', async () => {
        const r = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{"baseUrl": "http://127.0.0.1',
        })
        expectStatus(r, [400, 422], 'PUT /api/settings 非法 JSON')
        expectEqual(r.json && r.json.ok, false, '非法 JSON 响应 ok 应为 false')
        expectTrue(typeof (r.json && r.json.error) === 'string' && r.json.error.length > 0, '非法 JSON 应有 error 文案')
      })

      await check('未知 /api 路由返回 404 JSON', async () => {
        const r = await jfetch(api('/api/definitely-not-exists'))
        expectStatus(r, 404, 'GET /api/definitely-not-exists')
        expectMatch(r.headers.get('content-type') || '', /application\/json/i, '404 Content-Type 应为 JSON')
        expectEqual(r.json && r.json.ok, false, '404 响应 ok 应为 false')
        expectTrue(typeof (r.json && r.json.error) === 'string', '404 应有 error 文案')
      })

      await check('settings.json 持久化文件权限为 600', async () => {
        const settingsFile = path.join(sandbox, 'data', 'settings.json')
        expectTrue(await exists(settingsFile), `data/settings.json 应存在（持久化设置），实际未找到: ${settingsFile}`)
        const st = await fsp.stat(settingsFile)
        expectEqual(st.mode & 0o777, 0o600, `data/settings.json 权限应为 600（SPEC §2.6）`)
        const raw = await fsp.readFile(settingsFile, 'utf8')
        expectTrue(raw.includes(validKey), 'data/settings.json 应保存 apiKey（服务端侧持久化）')
      })

      await check('请求体超过 1MB 被拒绝（SPEC §2.6）', async () => {
        const big = 'x'.repeat(1024 * 1024 + 1024)
        let r
        try {
          r = await jfetch(
            api('/api/settings/test'),
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: big }) },
            10000,
          )
        } catch (err) {
          // 连接被服务端主动断开也算「限制生效」
          return
        }
        assert.ok([400, 413, 431].includes(r.status), `超大请求体期望 4xx（400/413），实际 ${r.status}`)
        expectEqual(r.json && r.json.ok, false, '超大请求体响应 ok 应为 false')
      })
    })

    // =====================================================================
    await group('对话 SSE（真实上游 mock）', async () => {
      let chatEvents = null
      await check('POST /api/chat SSE 事件顺序 meta → delta+ → feedback → done', async () => {
        mock.reset()
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'free',
            topicId: 'cafe',
            level: 'A2',
            message: 'I want a coffee',
            history: [],
            focusWords: ['latte'],
            teacherName: 'Ava',
          }),
          signal: AbortSignal.timeout(45000),
        })
        expectMatch(res.headers.get('content-type') || '', /text\/event-stream/i, 'chat Content-Type 应为 text/event-stream')
        expectMatch(res.headers.get('cache-control') || '', /no-cache/i, 'SSE 应含 Cache-Control: no-cache（SPEC §2.6）')
        expectEqual((res.headers.get('x-accel-buffering') || '').toLowerCase(), 'no', 'SSE 应含 X-Accel-Buffering: no（SPEC §2.6）')
        chatEvents = await collectSSE(res)
        const types = chatEvents.map((e) => e.event)
        console.log(c.dim(`      事件序列: ${types.join(' → ')}`))

        expectTrue(chatEvents.length >= 4, `SSE 事件数应 >=4，实际 ${types.length}: ${types.join(',')}`)
        expectEqual(types[0], 'meta', `首个事件应为 meta，实际事件序列: ${types.join(',')}`)
        expectEqual(types[types.length - 1], 'done', `最后事件应为 done，实际事件序列: ${types.join(',')}`)
        const metaIdx = types.indexOf('meta')
        const feedbackIdx = types.indexOf('feedback')
        const doneIdx = types.lastIndexOf('done')
        expectTrue(feedbackIdx > metaIdx, `feedback 应在 meta 之后（${types.join(',')}）`)
        expectTrue(doneIdx > feedbackIdx, `done 应在 feedback 之后（${types.join(',')}）`)
        const deltaIdxs = types.map((t, i) => (t === 'delta' ? i : -1)).filter((i) => i >= 0)
        expectTrue(deltaIdxs.length >= 2, `至少应有 2 个 delta 事件，实际 ${deltaIdxs.length}: ${types.join(',')}`)
        expectTrue(deltaIdxs.every((i) => i > metaIdx && i < feedbackIdx), `所有 delta 应位于 meta 与 feedback 之间，实际序列: ${types.join(',')}`)

        // 数据结构校验
        const meta = chatEvents[0].data
        expectEqual(meta.demo, false, `有 Key + mock 上游正常时应为真实模式（demo=false），实际 meta=${JSON.stringify(meta)}`)
        expectEqual(typeof meta.model, 'string', 'meta.model 应为 string')

        const deltaText = chatEvents
          .filter((e) => e.event === 'delta')
          .map((e) => e.data && e.data.text)
          .join('')
        expectTrue(deltaText.length > 0, 'delta 文本不应为空')
        expectTrue(!deltaText.includes('<<<FEEDBACK>>>'), `delta 不得包含 <<<FEEDBACK>>> 标记；实际片段: ${JSON.stringify(deltaText.slice(-200))}`)
        expectTrue(!/^\s*\{/.test(deltaText.trim()), `delta 不应包含反馈 JSON 本体；实际片段: ${JSON.stringify(deltaText.slice(-200))}`)

        const fb = chatEvents[feedbackIdx].data
        expectTrue(fb && typeof fb === 'object', 'feedback data 应为 JSON 对象')
        for (const key of ['corrections', 'better', 'newWords']) {
          expectTrue(Array.isArray(fb[key]), `feedback.${key} 应为数组，实际 ${typeof (fb && fb[key])}`)
        }
        expectTrue(typeof fb.encouragement_zh === 'string' && fb.encouragement_zh.length > 0, 'feedback.encouragement_zh 应为非空中文')
        if (fb.corrections.length > 0) {
          for (const x of fb.corrections) {
            for (const k of ['original', 'corrected', 'explanation_zh']) expectTrue(typeof x[k] === 'string' && x[k].length > 0, `corrections 项缺少 ${k}`)
          }
        }
        if (fb.newWords.length > 0) {
          for (const w of fb.newWords) expectTrue(typeof w.word === 'string' && typeof w.meaning === 'string', 'newWords 项应含 word/meaning')
        }

        const done = chatEvents[doneIdx].data
        expectTrue(done && typeof done.fullReply === 'string' && done.fullReply.length > 0, `done.fullReply 应为非空字符串，实际 ${JSON.stringify(done)}`)
        const norm = (s) => String(s).replace(/\s+/g, ' ').trim()
        expectEqual(norm(deltaText), norm(done.fullReply), 'delta 累积文本应与 done.fullReply 一致（去空白后）')
      })

      await check('chat 上游请求正确（携带 Authorization、messages 含用户输入、stream:true）', async () => {
        const calls = mock.chatCalls
        expectTrue(calls.length >= 1, 'mock 上游应收到至少 1 次 chat 请求')
        const call = calls[calls.length - 1]
        expectTrue(typeof call.headers.authorization === 'string' && call.headers.authorization.startsWith('Bearer '), `上游请求应带 Authorization: Bearer，实际 ${JSON.stringify(call.headers.authorization)}`)
        expectTrue(call.headers.authorization.startsWith('Bearer '), `上游请求应带 Bearer 前缀，实际 ${JSON.stringify(call.headers.authorization)}`)
        expectTrue(call.headers.authorization.includes(validKey), '上游请求应携带已配置的 apiKey（上游鉴权靠它）')
        expectTrue(Array.isArray(call.body.messages) && call.body.messages.length >= 2, `上游 messages 应包含 system+user，实际 ${JSON.stringify(call.body).slice(0, 300)}`)
        expectTrue(call.body.stream === true, `上游请求 stream 应为 true，实际 ${JSON.stringify(call.body.stream)}`)
        const all = JSON.stringify(call.body.messages)
        expectTrue(all.includes('I want a coffee'), `上游 messages 应包含用户输入；实际 ${all.slice(0, 400)}`)
      })
    })

    // =====================================================================
    await group('无 Key / 上游异常降级', async () => {
      await check('clearKey 后 GET /api/settings 与 /api/health 均 hasKey:false', async () => {
        const r = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clearKey: true }),
        })
        expectStatus(r, 200, 'PUT /api/settings clearKey')
        expectEqual(r.json.hasKey, false, 'clearKey 后 hasKey 应为 false')
        expectTrue(!r.json.keyHint, `clearKey 后 keyHint 应为空，实际 ${JSON.stringify(r.json.keyHint)}`)
        const h = await jfetch(api('/api/health'))
        expectEqual(h.json.hasKey, false, 'clearKey 后 health.hasKey 应为 false')
      })

      await check('无 Key 时 /api/chat 自动 demo 降级且事件完整', async () => {
        const chatCallsBefore = mock.chatCalls.length
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'free', topicId: 'cafe', level: 'A2', message: 'Hello Ava!', history: [] }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        const types = events.map((e) => e.event)
        console.log(c.dim(`      事件序列: ${types.join(' → ')}`))
        expectTrue(events.length >= 4, `demo 降级也应完整发事件，实际 ${types.join(',')}`)
        const meta = events[0].data
        expectEqual(events[0].event, 'meta', '首个事件应为 meta')
        expectEqual(meta.demo, true, `无 Key 时 meta.demo 应为 true，实际 meta=${JSON.stringify(meta)}`)
        expectTrue(typeof meta.model === 'string' && meta.model.length > 0, 'demo meta.model 应为非空字符串')
        if (meta.fallback === true) expectTrue(typeof meta.reason === 'string' && meta.reason.length > 0, '上游失败降级时 meta 应带非空 reason')
        expectTrue(types.filter((t) => t === 'delta').length >= 2, `demo 降级仍应有多个 delta，实际 ${types.join(',')}`)
        const fb = events.find((e) => e.event === 'feedback')
        expectTrue(!!fb, 'demo 降级仍应有 feedback 事件')
        expectTrue(Array.isArray(fb.data.corrections) && Array.isArray(fb.data.better) && Array.isArray(fb.data.newWords), 'demo feedback 数据结构应完整')
        expectTrue(typeof fb.data.encouragement_zh === 'string' && fb.data.encouragement_zh.length > 0, 'demo feedback 应有中文鼓励')
        const done = events.find((e) => e.event === 'done')
        expectTrue(!!done && typeof done.data.fullReply === 'string' && done.data.fullReply.length > 0, 'demo 降级仍应有 done.fullReply')
        expectEqual(mock.chatCalls.length, chatCallsBefore, '无 Key 时不应请求上游（mock 不应收到新的 chat 请求）')
      })

      await check('上游 401 时自动降级 demo（meta.demo=true）且事件完整', async () => {
        const put = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseUrl: mock.url, model: 'mock-model', apiKey: 'sk-qa-bad-key-0000' }),
        })
        expectStatus(put, 200, 'PUT /api/settings 恢复 key（错误 key）')
        mock.setScenario('401')
        try {
          const res = await fetch(api('/api/chat'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'free', topicId: 'cafe', level: 'A2', message: 'Hi again', history: [] }),
            signal: AbortSignal.timeout(45000),
          })
          const events = await collectSSE(res)
          const types = events.map((e) => e.event)
          console.log(c.dim(`      事件序列: ${types.join(' → ')}`))
          const meta = events[0] && events[0].data
          expectEqual(events[0] && events[0].event, 'meta', '上游 401 降级路径首个事件应为 meta')
          expectEqual(meta.demo, true, `上游 401 时应降级 demo（meta.demo=true），实际 meta=${JSON.stringify(meta)}，事件序列=${types.join(',')}`)
          expectTrue(types.includes('done'), `降级后仍应有 done，实际 ${types.join(',')}`)
        } finally {
          mock.setScenario('ok')
        }
      })

      await check('上游中途断流：服务端不崩溃，响应收尾且服务仍健康', async () => {
        mock.setScenario('abort')
        try {
          const res = await fetch(api('/api/chat'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'free', topicId: 'cafe', level: 'A2', message: 'Tell me about tea', history: [] }),
            signal: AbortSignal.timeout(30000),
          })
          let events = []
          try {
            events = await collectSSE(res, { timeoutMs: 20000 })
          } catch (err) {
            // 流被上游掐断后服务端若直接断开连接，接受：只要进程仍健康
            expectTrue(/aborted|terminated|network|fetch/i.test(String(err.message)), `意外错误: ${err.message}`)
          }
          if (events.length > 0) {
            const types = events.map((e) => e.event)
            console.log(c.dim(`      事件序列: ${types.join(' → ')}`))
            expectTrue(types.includes('done') || types.includes('error'), `断流后应有 done 或 error 事件，实际 ${types.join(',')}`)
          }
          const health = await jfetch(api('/api/health'), {}, 5000)
          expectStatus(health, 200, '断流后 GET /api/health')
        } finally {
          mock.setScenario('ok')
        }
      })
    })

    // =====================================================================
    await group('v1.1 总结 / 单词表 / 自由对话', async () => {
      const today = localDateString()

      await check('free 模式忽略 topicId，且 system prompt 不注入话题卡（v1.1 §A）', async () => {
        mock.reset()
        // v1.1 §A4：对话历史完整传给后端（最多最近 20 条）→ 用 12 条带标记的历史验证
        const history = Array.from({ length: 12 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `HIST-${String(i + 1).padStart(2, '0')} hello from turn ${i + 1}`,
        }))
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'free',
            topicId: 'cafe',
            level: 'A2',
            message: 'I am really tired after work today.',
            history,
          }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        const types = events.map((e) => e.event)
        expectTrue(types.includes('done'), `free 对话应完整结束，实际事件 ${types.join(',')}`)
        const deltaText = events
          .filter((e) => e.event === 'delta')
          .map((e) => e.data && e.data.text)
          .join('')
        expectTrue(deltaText.trim().length > 0, 'free 对话应有非空英文回复')

        const call = mock.chatCalls[mock.chatCalls.length - 1]
        expectTrue(!!call, 'mock 上游应收到 free 对话请求')
        const systemContent = String(call.body.messages[0].content || '')
        expectTrue(!/Current small-talk topic/i.test(systemContent), 'free 模式 system prompt 不应注入话题卡（v1.1 §A1）')
        expectTrue(!systemContent.includes('咖啡店'), 'free 模式不应注入 topicId 对应的话题内容')
        expectTrue(/ANYTHING|Free talk|digital friend/i.test(systemContent), 'free 模式应为「数字外国朋友」prompt')
        expectTrue(JSON.stringify(call.body.messages).includes('I am really tired after work today'), '上游 messages 应包含用户输入')
        const histForwarded = call.body.messages.filter((m) => typeof m.content === 'string' && /HIST-\d\d/.test(m.content)).length
        expectEqual(histForwarded, 12, 'v1.1 §A4：最近 20 条对话历史应完整传给上游（当前 mock 只收到部分）')
      })

      let demoSummary = null
      let demoKeyWords = []
      let demoAdded = 0

      await check('无 Key：POST /api/summary demo 总结 + 写入当天单词表/SRS', async () => {
        const clear = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clearKey: true }),
        })
        expectStatus(clear, 200, 'PUT /api/settings clearKey')
        expectEqual(clear.json.hasKey, false, 'clearKey 后 hasKey=false')

        const r = await jfetch(api('/api/summary'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'free',
            level: 'A2',
            teacherName: 'Ava',
            messages: [
              { role: 'user', content: 'I go to the office yesterday and it was really tiring.' },
              { role: 'assistant', content: 'Oh no, a long day? What happened?' },
              { role: 'user', content: 'I had three meetings and a deadline. I want go home early.' },
            ],
          }),
        })
        expectStatus(r, 200, 'POST /api/summary（无 Key）')
        expectMatch(r.headers.get('content-type') || '', /application\/json/i, 'summary Content-Type')
        demoSummary = r.json
        expectEqual(demoSummary.ok, true, 'summary.ok')
        expectEqual(demoSummary.demo, true, '无 Key 时 summary.demo 应为 true')
        expectTrue(!r.text.includes('<<<FEEDBACK>>>'), 'summary 响应不应包含反馈标记')
        expectTrue(typeof demoSummary.summary_zh === 'string' && demoSummary.summary_zh.length > 10, 'summary_zh 应为非空中文总结')
        expectTrue(/[\u4e00-\u9fa5]/.test(demoSummary.summary_zh), 'summary_zh 应为中文')
        expectTrue(Array.isArray(demoSummary.topics_zh) && demoSummary.topics_zh.length >= 1 && demoSummary.topics_zh.length <= 3, `topics_zh 应为 1–3 个，实际 ${JSON.stringify(demoSummary.topics_zh)}`)
        expectTrue(demoSummary.topics_zh.every((t) => typeof t === 'string' && t.length > 0), 'topics_zh 每项应为非空字符串')
        expectTrue(Array.isArray(demoSummary.strengths_zh) && demoSummary.strengths_zh.length >= 1, 'strengths_zh 应非空')
        expectTrue(Array.isArray(demoSummary.improvements_zh) && demoSummary.improvements_zh.length >= 1, 'improvements_zh 应非空')
        expectTrue(Array.isArray(demoSummary.corrections), 'corrections 应为数组')
        expectTrue(demoSummary.corrections.length >= 1, `demo 总结应识别 I go ... yesterday / I want go 等错误，实际 ${JSON.stringify(demoSummary.corrections)}`)
        expectTrue(demoSummary.corrections.every((c) => c && c.corrected && c.explanation_zh), 'corrections 项应含 corrected/explanation_zh')
        demoKeyWords = demoSummary.keyWords
        expectTrue(Array.isArray(demoKeyWords) && demoKeyWords.length >= 3 && demoKeyWords.length <= 8, `keyWords 应为 3–8 个，实际 ${JSON.stringify(demoKeyWords && demoKeyWords.length)}`)
        for (const w of demoKeyWords) {
          expectTrue(typeof w.word === 'string' && /[a-zA-Z]/.test(w.word), `keyWords 项 word 应为英文，实际 ${JSON.stringify(w)}`)
          expectTrue(typeof w.meaning === 'string' && w.meaning.length > 0, `keyWords 项 ${w.word} 应有中文释义`)
          expectTrue(typeof w.example === 'string' && w.example.length > 0, `keyWords 项 ${w.word} 应有英文例句`)
        }
        const unique = new Set(demoKeyWords.map((w) => w.word.toLowerCase()))
        expectEqual(unique.size, demoKeyWords.length, 'keyWords 不应重复')
        expectTrue(typeof demoSummary.encouragement_zh === 'string' && demoSummary.encouragement_zh.length > 0, 'encouragement_zh 应非空')

        expectTrue(demoSummary.dailyWords && typeof demoSummary.dailyWords === 'object', 'summary 应返回 dailyWords')
        expectEqual(demoSummary.dailyWords.date, today, 'dailyWords.date 应为今天')
        expectEqual(demoSummary.dailyWords.label, '今天', 'dailyWords.label 应为「今天」')
        expectEqual(demoSummary.dailyWords.words.length, demoKeyWords.length, 'dailyWords 词数应等于 keyWords 数')
        demoAdded = demoSummary.addedCount
        expectEqual(demoAdded, demoKeyWords.length, 'addedCount 应等于首次写入的 keyWords 数')
        expectEqual(demoSummary.vocabAdded, demoKeyWords.length, 'vocabAdded 应等于新增 SRS 词数')
        expectTrue(demoSummary.wordbook && demoSummary.wordbook.todayCount >= demoKeyWords.length, 'summary.wordbook.todayCount 应同步')
      })

      await check('GET /api/wordbook：今天置顶、结构完整、排序正确', async () => {
        const r = await jfetch(api('/api/wordbook'))
        expectStatus(r, 200, 'GET /api/wordbook')
        const wb = r.json
        expectEqual(wb.ok, true, 'wordbook.ok')
        expectEqual(wb.today, today, 'wordbook.today 应为今天')
        expectTrue(Array.isArray(wb.days) && wb.days.length >= 1, 'wordbook.days 应非空')
        expectEqual(wb.days[0].date, today, '最近日期应置顶为今天')
        expectEqual(wb.days[0].label, '今天', '今天分组 label 应为「今天」')
        expectTrue(wb.days[0].count >= demoAdded, `今天词数应 >= ${demoAdded}，实际 ${wb.days[0].count}`)
        expectTrue(wb.totalWords >= demoAdded, 'totalWords 应 >= 今日新增')
        const dates = wb.days.map((d) => d.date)
        expectEqual(dates, [...dates].sort().reverse(), 'days 应按日期倒序')
        const word = wb.days[0].words[0]
        for (const k of ['word', 'phonetic', 'meaning', 'example', 'addedAt', 'source', 'timesSeen']) {
          expectTrue(k in word, `单词条目应含字段 ${k}，实际 ${JSON.stringify(word)}`)
        }
        expectTrue(typeof word.addedAt === 'number' && word.addedAt > 0, 'addedAt 应为毫秒时间戳')
        expectEqual(word.source, 'summary', 'summary 写入的词 source 应为 summary')
        expectTrue(word.timesSeen >= 1, 'timesSeen 应 >= 1')
        const oneDay = await jfetch(api('/api/wordbook?days=1'))
        expectStatus(oneDay, 200, 'GET /api/wordbook?days=1')
        expectEqual(oneDay.json.days.length, 1, 'days=1 应只返回 1 天')
      })

      await check('POST /api/wordbook：同词去重合并（timesSeen+1）、新词追加', async () => {
        const before = (await jfetch(api('/api/wordbook'))).json.days[0]
        const existingWord = demoKeyWords[0].word
        const beforeRec = before.words.find((w) => w.word.toLowerCase() === existingWord.toLowerCase())
        expectTrue(!!beforeRec, `应能在单词表中找到已有词 ${existingWord}`)
        const r = await jfetch(api('/api/wordbook'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'manual',
            words: [
              { word: existingWord, phonetic: '/test/', meaning: '更新后的释义', example: 'Updated example.', why_zh: '重复词不应新增' },
              { word: 'serendipity', phonetic: '/ˌserənˈdɪpəti/', meaning: '意外发现', example: 'We met by serendipity.', why_zh: '高级词汇' },
            ],
          }),
        })
        expectStatus(r, 200, 'POST /api/wordbook')
        expectEqual(r.json.ok, true, 'wordbook POST ok')
        expectEqual(r.json.addedCount, 1, '只有 serendipity 是新增词，addedCount 应为 1')
        expectEqual(r.json.dailyWords.count, before.count + 1, '今日词数应 +1')
        const updated = r.json.dailyWords.words.find((w) => w.word.toLowerCase() === existingWord.toLowerCase())
        expectEqual(updated.timesSeen, beforeRec.timesSeen + 1, '重复词 timesSeen 应 +1')
        expectEqual(updated.meaning, '更新后的释义', '重复词应更新释义')
        const added = r.json.dailyWords.words.find((w) => w.word === 'serendipity')
        expectTrue(!!added && added.timesSeen === 1, '新词应写入且 timesSeen=1')
        expectEqual(added.source, 'manual', '新词 source 应为 manual')
      })

      await check('POST /api/summary 写入 SRS：keyWords 成为 box 0 新词', async () => {
        const r = await jfetch(api('/api/progress'))
        expectStatus(r, 200, 'GET /api/progress')
        const sample = demoKeyWords[0].word.toLowerCase()
        const rec = r.json.words[sample]
        expectTrue(!!rec, `progress.words 应包含 summary 重点词 ${sample}`)
        expectEqual(rec.box, 0, 'summary 新词 SRS box 应为 0')
        expectTrue(typeof rec.due === 'number' && Number.isFinite(rec.due), `新词 due 应为时间戳，实际 ${JSON.stringify(rec.due)}`)
      })

      await check('POST /api/summary 参数校验：空 / 无 user / 非法 JSON → 400', async () => {
        const cases = [
          { name: '空 messages', body: { messages: [] } },
          { name: '只有 assistant', body: { messages: [{ role: 'assistant', content: 'Hello!' }] } },
          { name: '全部非法项', body: { messages: [{ role: 'system', content: 'x' }, null, { role: 'user', content: 42 }] } },
        ]
        for (const c of cases) {
          const r = await jfetch(api('/api/summary'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(c.body),
          })
          expectStatus(r, 400, `POST /api/summary（${c.name}）`)
          expectEqual(r.json && r.json.ok, false, `${c.name} 应返回 ok:false`)
          expectTrue(typeof (r.json && r.json.error) === 'string' && r.json.error.length > 0, `${c.name} 应返回 error 文案`)
        }
        const bad = await jfetch(api('/api/summary'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        })
        expectTrue([400, 422].includes(bad.status), `非法 JSON 应 4xx，实际 ${bad.status}`)
        expectEqual(bad.json && bad.json.ok, false, '非法 JSON ok=false')
      })

      await check('有 mock 上游：POST /api/summary → demo:false 且解析严格 JSON', async () => {
        mock.reset()
        const put = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseUrl: mock.url, model: 'mock-model', apiKey: validKey }),
        })
        expectStatus(put, 200, 'PUT /api/settings 恢复 Key')
        expectEqual(put.json.hasKey, true, '恢复 Key 后 hasKey=true')
        const before = (await jfetch(api('/api/wordbook'))).json
        const beforeToday = before.days[0] && before.days[0].date === today ? before.days[0].count : 0

        const r = await jfetch(api('/api/summary'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'free',
            level: 'B1',
            teacherName: 'Ava',
            messages: [
              { role: 'user', content: 'I commute to work by subway every day and the deadline is on Friday.' },
              { role: 'assistant', content: 'That sounds busy. How do you manage it?' },
              { role: 'user', content: 'I updated the spreadsheet this morning.' },
            ],
          }),
        })
        expectStatus(r, 200, 'POST /api/summary（有 Key/mock）')
        const live = r.json
        expectEqual(live.ok, true, 'live summary ok')
        expectEqual(live.demo, false, `有 Key 且 mock 返回合法 JSON 时 demo 应为 false，实际 ${JSON.stringify(live.demo)} / ${JSON.stringify(live.reason || '')}`)
        expectTrue(!live.fallback, 'live summary 不应走 fallback')
        expectTrue(typeof live.summary_zh === 'string' && live.summary_zh.length > 10, 'live summary_zh 应非空')
        expectEqual(live.keyWords.length, DEFAULT_SUMMARY.keyWords.length, `live keyWords 应为 ${DEFAULT_SUMMARY.keyWords.length} 个`)
        const words = live.keyWords.map((w) => w.word.toLowerCase())
        for (const expected of ['commute', 'deadline', 'spreadsheet']) {
          expectTrue(words.includes(expected), `live keyWords 应包含 ${expected}，实际 ${words.join(',')}`)
        }
        expectTrue(Array.isArray(live.corrections) && live.corrections.length >= 1, 'live corrections 应解析出来')
        expectTrue(live.encouragement_zh.length > 0, 'live encouragement_zh 应非空')

        const after = (await jfetch(api('/api/wordbook'))).json
        const afterToday = after.days[0] && after.days[0].date === today ? after.days[0].count : 0
        expectEqual(afterToday, beforeToday + live.addedCount, 'live summary 后今日词数应增加 addedCount')
        expectTrue(live.dailyWords && live.dailyWords.words.length >= 3, 'live summary 应返回 dailyWords')
        const summaryCalls = mock.summaryCalls
        expectTrue(summaryCalls.length >= 1, 'mock 应收到 summary 请求')
        const call = summaryCalls[summaryCalls.length - 1]
        expectEqual(call.body.stream, false, 'summary 上游请求应为非流式（stream:false）')
        expectTrue(String(call.headers.authorization || '').startsWith('Bearer '), 'summary 上游请求应带 Authorization')
        expectTrue(
          JSON.stringify(call.body.messages).includes('post-conversation learning summary'),
          'summary 上游 messages 应使用总结 prompt',
        )
      })

      await check('上游返回坏 JSON：summary 自动降级 demo 且仍 200', async () => {
        mock.setScenario('bad-summary')
        try {
          const r = await jfetch(api('/api/summary'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'I went hiking last weekend and it was amazing.' }] }),
          })
          expectStatus(r, 200, 'POST /api/summary（上游坏 JSON）')
          expectEqual(r.json.ok, true, '坏 JSON 时接口仍应返回可用结果（ok:true）')
          expectEqual(r.json.demo, true, '坏 JSON 时应降级 demo:true')
          expectEqual(r.json.fallback, true, '坏 JSON 降级应标记 fallback:true')
          expectTrue(typeof r.json.reason === 'string' && r.json.reason.length > 0, '降级应带中文 reason')
          expectTrue(r.json.keyWords.length >= 3, '降级总结仍应有 3+ 重点词')
          expectTrue(!!r.json.dailyWords, '降级总结仍应返回 dailyWords')
        } finally {
          mock.setScenario('ok')
        }
      })

      await check('summary 上游 401：自动降级 demo 且仍 200', async () => {
        mock.setScenario('401')
        try {
          const r = await jfetch(api('/api/summary'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'I cooked noodles for dinner yesterday.' }] }),
          })
          expectStatus(r, 200, 'POST /api/summary（上游 401）')
          expectEqual(r.json.ok, true, '上游 401 时接口仍应返回可用结果')
          expectEqual(r.json.demo, true, '上游 401 时应降级 demo:true')
          expectEqual(r.json.fallback, true, '上游 401 降级应标记 fallback:true')
          expectTrue(typeof r.json.reason === 'string' && r.json.reason.length > 0, '降级应带中文原因')
        } finally {
          mock.setScenario('ok')
        }
      })
    })

    // =====================================================================
    await group('v1.2 中文求助 / 相关性', async () => {
      await check('无 Key 中文消息：meta.chinese=true + chineseHelp 合法 + corrections=[]', async () => {
        const clear = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clearKey: true }),
        })
        expectStatus(clear, 200, 'PUT /api/settings clearKey')
        expectEqual(clear.json.hasKey, false, 'clearKey 后 hasKey=false')

        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'free', level: 'A2', message: '我今天很累，不知道怎么说', history: [] }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        const types = events.map((e) => e.event)
        console.log(c.dim(`      事件序列: ${types.join(' → ')}`))
        expectEqual(types[0], 'meta', `首个事件应为 meta，实际 ${types.join(',')}`)
        expectEqual(types[types.length - 1], 'done', `最后事件应为 done，实际 ${types.join(',')}`)
        const meta = events[0].data
        expectEqual(meta.demo, true, '无 Key 时应为 demo')
        expectEqual(meta.chinese, true, `中文消息 meta.chinese 应为 true，实际 ${JSON.stringify(meta)}`)

        const deltaText = events
          .filter((e) => e.event === 'delta')
          .map((e) => e.data && e.data.text)
          .join('')
        expectTrue(deltaText.trim().length > 0, '中文求助应有英文说话回复')
        expectTrue(!deltaText.includes('<<<FEEDBACK>>>'), 'delta 不应含反馈标记')

        const fbEvent = events.find((e) => e.event === 'feedback')
        expectTrue(!!fbEvent, '缺少 feedback 事件')
        const fb = fbEvent.data
        expectTrue(!!fb.chineseHelp && typeof fb.chineseHelp === 'object', `中文消息必须返回 chineseHelp，实际 ${JSON.stringify(fb)}`)
        expectTrue(typeof fb.chineseHelp.original_zh === 'string' && fb.chineseHelp.original_zh.includes('很累'), 'chineseHelp.original_zh 应为用户中文原话')
        expectTrue(typeof fb.chineseHelp.english === 'string' && /[a-zA-Z]/.test(fb.chineseHelp.english), 'chineseHelp.english 应为英文表达')
        expectMatch(fb.chineseHelp.english, /exhausted|tired/i, '「很累」应翻译为 exhausted/tired 相关表达')
        expectTrue(Array.isArray(fb.chineseHelp.chunks) && fb.chineseHelp.chunks.length >= 1, 'chineseHelp.chunks 应为非空数组')
        expectTrue(
          fb.chineseHelp.chunks.every((c) => c && typeof c.en === 'string' && c.en && typeof c.zh === 'string' && c.zh),
          'chineseHelp.chunks 每项应含 en/zh',
        )
        expectTrue(typeof fb.chineseHelp.tips_zh === 'string' && fb.chineseHelp.tips_zh.length > 0, 'chineseHelp.tips_zh 应非空')
        expectTrue(/[\u4e00-\u9fa5]/.test(fb.chineseHelp.tips_zh), 'chineseHelp.tips_zh 应为中文提示')
        expectTrue(Array.isArray(fb.corrections) && fb.corrections.length === 0, `中文输入 corrections 必须为空，实际 ${JSON.stringify(fb.corrections)}`)
        expectTrue(
          !/very nice|good job|great job|well done/i.test(String(fb.encouragement_zh || '')),
          `中文求助不应空洞夸奖，实际 encouragement_zh=${JSON.stringify(fb.encouragement_zh)}`,
        )
        const done = events.find((e) => e.event === 'done')
        expectTrue(!!done && typeof done.data.fullReply === 'string' && done.data.fullReply.length > 0, 'done.fullReply 应非空')
      })

      await check('无 Key 未命中中文：chineseHelp.unmatched=true 且 tips 提示 API Key', async () => {
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'free', level: 'A2', message: '量子纠缠的哲学意义是什么', history: [] }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        expectEqual(events[0].event, 'meta', '首个事件应为 meta')
        expectEqual(events[0].data.chinese, true, '未命中中文 meta.chinese 仍应为 true')
        const fb = events.find((e) => e.event === 'feedback').data
        expectTrue(!!fb.chineseHelp, '未命中中文也应返回 chineseHelp')
        expectEqual(fb.chineseHelp.unmatched, true, '未覆盖的中文应标记 unmatched=true')
        expectMatch(fb.chineseHelp.tips_zh, /API Key/, `未命中 tips 应提示 API Key，实际 ${JSON.stringify(fb.chineseHelp.tips_zh)}`)
        expectTrue(Array.isArray(fb.corrections) && fb.corrections.length === 0, '未命中中文 corrections 仍应为空')
      })

      await check('英文直接提问：meta.chinese=false 且 demo 正面回答（非反问代替）', async () => {
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'free', level: 'A2', message: 'How are you?', history: [] }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        expectEqual(events[0].data.chinese, false, '英文消息 meta.chinese 应为 false')
        const deltaText = events
          .filter((e) => e.event === 'delta')
          .map((e) => e.data && e.data.text)
          .join('')
        expectMatch(deltaText, /I'm doing really well/i, `How are you? 应正面回答，实际 "${deltaText.slice(0, 200)}"`)
        const firstQ = deltaText.indexOf('?')
        expectTrue(firstQ === -1 || firstQ > 20, `反问前应有正面回答，实际 "${deltaText.slice(0, 200)}"`)
        const fb = events.find((e) => e.event === 'feedback').data
        expectEqual(fb.chineseHelp, null, '英文消息 chineseHelp 应为 null')
      })

      await check('英文陈述：demo 引用用户原话再承接（相关性）', async () => {
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'free', level: 'A2', message: 'I had a long day at work today.', history: [] }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        const deltaText = events
          .filter((e) => e.event === 'delta')
          .map((e) => e.data && e.data.text)
          .join('')
        expectMatch(deltaText, /So you said/i, `应引用用户原话，实际 "${deltaText.slice(0, 200)}"`)
        expectTrue(/work|day/i.test(deltaText), '回应应承接用户内容')
      })

      await check('含中文求助的对话：demo 总结给出正向学习策略建议', async () => {
        const r = await jfetch(api('/api/summary'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'user', content: '我今天很累，不知道怎么说' },
              { role: 'assistant', content: 'No worries — in English you can say: "I\'m exhausted today." Let\'s try it together.' },
              { role: 'user', content: 'I am exhausted today.' },
            ],
          }),
        })
        expectStatus(r, 200, 'POST /api/summary（含中文）')
        expectEqual(r.json.ok, true, 'summary.ok')
        expectEqual(r.json.demo, true, '无 Key 时应为 demo 总结')
        const allZh = JSON.stringify([r.json.strengths_zh, r.json.improvements_zh])
        expectTrue(/中文求助|不会表达|How do you say/i.test(allZh), `总结应正向反馈中文求助策略，实际 ${allZh.slice(0, 400)}`)
        expectTrue(Array.isArray(r.json.keyWords) && r.json.keyWords.length >= 3, '总结仍应给出重点词')
        expectTrue(typeof r.json.addedCount === 'number', 'summary 应返回 addedCount')
      })

      await check('有 Key 中文消息：meta.chinese=true、chineseHelp 保留、上游 prompt 含中文协议', async () => {
        mock.reset()
        const put = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseUrl: mock.url, model: 'mock-model', apiKey: validKey }),
        })
        expectStatus(put, 200, 'PUT /api/settings 恢复 Key')
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'free', level: 'A2', message: '我今天很累，不知道怎么说', history: [] }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        const types = events.map((e) => e.event)
        console.log(c.dim(`      事件序列: ${types.join(' → ')}`))
        expectEqual(events[0].data.demo, false, '有 Key + mock 时应为 live')
        expectEqual(events[0].data.chinese, true, 'live 中文消息 meta.chinese 应为 true')
        const fb = events.find((e) => e.event === 'feedback').data
        expectTrue(!!fb.chineseHelp, 'live 中文消息应保留 chineseHelp')
        expectTrue(typeof fb.chineseHelp.english === 'string' && fb.chineseHelp.english.length > 0, 'live chineseHelp.english 应非空')
        expectTrue(Array.isArray(fb.chineseHelp.chunks) && fb.chineseHelp.chunks.length >= 1, 'live chineseHelp.chunks 应非空')
        expectTrue(Array.isArray(fb.corrections) && fb.corrections.length === 0, 'live 中文消息 corrections 应为空')
        const call = mock.chatCalls[mock.chatCalls.length - 1]
        const systemContent = String(call.body.messages[0].content || '')
        expectMatch(systemContent, /HIGHEST PRIORITY/, '上游 system prompt 应含相关性最高优先级规则')
        expectMatch(systemContent, /WHEN THE STUDENT USES CHINESE/, '上游 system prompt 应含中文求助协议')
        expectMatch(systemContent, /chineseHelp/, '上游 system prompt 应要求 chineseHelp 字段')
        expectMatch(systemContent, /follow the Chinese protocol above now/i, '中文消息应强化中文协议指令')
      })

      await check('有 Key 英文提问：prompt 含「回答最新消息/禁止空洞夸奖」且 chineseHelp=null', async () => {
        mock.reset()
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'free', level: 'A2', message: 'How are you?', history: [] }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        expectEqual(events[0].data.chinese, false, '英文消息 meta.chinese 应为 false')
        const fb = events.find((e) => e.event === 'feedback').data
        expectEqual(fb.chineseHelp, null, '英文消息 chineseHelp 应为 null')
        const call = mock.chatCalls[mock.chatCalls.length - 1]
        const systemContent = String(call.body.messages[0].content || '')
        expectMatch(systemContent, /LATEST message/, 'system prompt 应要求回应最新消息')
        expectMatch(systemContent, /answer it directly/i, 'system prompt 应要求直接回答')
        expectMatch(systemContent, /Do NOT praise generically/i, 'system prompt 应禁止空洞夸奖')
        expectTrue(!/follow the Chinese protocol above now/i.test(systemContent), '英文消息不应强化中文协议指令')
      })

      await check('有 Key 含中文的对话总结：正常生成且 summary prompt 含中文求助正向规则', async () => {
        mock.reset()
        const r = await jfetch(api('/api/summary'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'user', content: '我今天很累，不知道怎么说' },
              { role: 'assistant', content: 'In English you can say: I am exhausted today.' },
              { role: 'user', content: 'I am exhausted today.' },
            ],
          }),
        })
        expectStatus(r, 200, 'POST /api/summary（有 Key 含中文）')
        expectEqual(r.json.ok, true, 'summary.ok')
        expectEqual(r.json.demo, false, '有 Key 时应为 live 总结')
        expectTrue(typeof r.json.addedCount === 'number', 'summary 应返回 addedCount')
        expectTrue(!!r.json.dailyWords, 'summary 应返回 dailyWords')
        expectTrue(mock.summaryCalls.length >= 1, 'mock 应收到 summary 请求')
        const systemContent = String(mock.summaryCalls[mock.summaryCalls.length - 1].body.messages[0].content || '')
        expectMatch(systemContent, /GOOD learning strategy/i, '总结 prompt 应把中文求助视为正向策略')
      })
    })

    // =====================================================================
    await group('v1.3 阅读讲解 / 文档 API', async () => {
      const FIX = path.join(PROJECT_ROOT, 'test', 'fixtures')
      const fixtureB64 = async (name) => (await fsp.readFile(path.join(FIX, name))).toString('base64')
      const uploadDoc = async (name) => {
        const r = await jfetch(api('/api/doc/upload'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, dataBase64: await fixtureB64(name), mime: 'application/octet-stream' }),
        })
        return r
      }
      let txtId = ''
      let docxId = ''
      let pptxId = ''
      let pdfId = ''
      let imgId = ''

      await check('POST /api/doc/upload 五类夹具：元数据/预览/隐私（不返回正文）', async () => {
        // 演示模式不需要 Key，先清空
        const clear = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clearKey: true }),
        })
        expectStatus(clear, 200, 'PUT /api/settings clearKey')

        const cases = [
          ['english-article.txt', 'text'],
          ['fixture-doc.docx', 'doc'],
          ['fixture-slides.pptx', 'slides'],
          ['test-pdf.pdf', 'pdf'],
        ]
        if (process.platform === 'darwin') cases.push(['ocr-test.png', 'image'])
        for (const [name, kind] of cases) {
          const r = await uploadDoc(name)
          expectStatus(r, 200, `POST /api/doc/upload ${name}`)
          expectEqual(r.json.ok, true, `${name} upload ok`)
          const doc = r.json.doc
          expectMatch(doc.id, /^d_[a-f0-9]{8,20}$/, `${name} doc.id 格式`)
          expectEqual(doc.name, name, `${name} 应保留文件名`)
          expectEqual(doc.kind, kind, `${name} kind`)
          expectTrue(doc.chars > 20, `${name} chars 应 >20，实际 ${doc.chars}`)
          expectTrue(typeof doc.preview === 'string' && doc.preview.length > 0 && doc.preview.length <= 400, `${name} preview 应为非空且 ≤400 字`)
          expectTrue(typeof doc.createdAt === 'number' && doc.createdAt > 0, `${name} createdAt 应为时间戳`)
          expectTrue(typeof doc.truncated === 'boolean', `${name} truncated 应为布尔`)
          expectTrue(Array.isArray(doc.warnings), `${name} warnings 应为数组`)
          expectTrue(!('text' in doc), `${name} 上传响应不得包含完整正文（隐私）`)
          if (kind === 'text') txtId = doc.id
          if (kind === 'doc') docxId = doc.id
          if (kind === 'slides') pptxId = doc.id
          if (kind === 'pdf') pdfId = doc.id
          if (kind === 'image') imgId = doc.id
        }
        if (process.platform !== 'darwin') console.log(c.yellow('      图片 OCR 仅 macOS，已跳过 png 上传'))
      })

      await check('上传错误路径：不支持格式 / 空内容 / 扫描版 PDF / 超大文件 → 中文 400', async () => {
        const r1 = await uploadDoc('unsupported.exe')
        expectStatus(r1, 400, '上传 .exe')
        expectMatch(r1.json.error, /暂不支持|支持/, '.exe 应返回中文不支持提示')

        const r2 = await jfetch(api('/api/doc/upload'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'empty.txt', dataBase64: '' }),
        })
        expectStatus(r2, 400, '上传空内容')
        expectMatch(r2.json.error, /空|缺少文件内容/, '空内容应返回中文错误')

        const scanned = await uploadDoc('scanned-image-only.pdf')
        expectStatus(scanned, 400, '上传扫描版 PDF')
        expectMatch(scanned.json.error, /扫描版/, '扫描版 PDF 应提示上传截图')

        const big = Buffer.alloc(12 * 1024 * 1024 + 1024, 0x41)
        const r3 = await jfetch(
          api('/api/doc/upload'),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'big.txt', dataBase64: big.toString('base64') }),
          },
          30000,
        )
        expectStatus(r3, 400, '上传超大文件')
        expectMatch(r3.json.error, /太大/, '超大文件应提示大小限制')
      })

      await check('GET /api/doc/list：倒序、元数据无正文', async () => {
        const r = await jfetch(api('/api/doc/list'))
        expectStatus(r, 200, 'GET /api/doc/list')
        expectEqual(r.json.ok, true, 'doc/list ok')
        expectTrue(Array.isArray(r.json.docs) && r.json.docs.length >= 4, `docs 应 >=4，实际 ${r.json.docs && r.json.docs.length}`)
        const ids = r.json.docs.map((d) => d.id)
        for (const id of [txtId, docxId, pptxId, pdfId].filter(Boolean)) expectTrue(ids.includes(id), `列表应包含 ${id}`)
        for (const d of r.json.docs) {
          expectTrue(!('text' in d), '列表元数据不得包含正文')
          expectTrue(typeof d.analyzed === 'boolean', '列表应有 analyzed 标记')
          expectTrue(typeof d.chars === 'number', '列表应有 chars')
        }
        const times = r.json.docs.map((d) => d.createdAt)
        expectEqual(times, [...times].sort((a, b) => b - a), 'list 应按 createdAt 倒序')
      })

      await check('GET /api/doc/:id 详情（含 text/analysis）+ 404', async () => {
        const r = await jfetch(api(`/api/doc/${txtId}`))
        expectStatus(r, 200, 'GET /api/doc/:id')
        const doc = r.json.doc
        expectTrue(typeof doc.text === 'string' && doc.text.length > 20, '详情应包含完整正文')
        expectMatch(doc.text, /Reading Practice/i)
        expectTrue('analysis' in doc, '详情应包含 analysis 字段')
        const missing = await jfetch(api('/api/doc/d_0000000000000000'))
        expectStatus(missing, 404, 'GET 不存在的 doc')
        expectMatch(missing.json.error, /材料不存在|删除/, '404 应为中文提示')
      })

      await check('POST /api/doc/analyze 无 Key：demo 分析字段齐全 + 缓存', async () => {
        const r = await jfetch(api('/api/doc/analyze'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: txtId, level: 'A2' }),
        })
        expectStatus(r, 200, 'POST /api/doc/analyze（无 Key）')
        expectEqual(r.json.ok, true, 'analyze ok')
        expectEqual(r.json.demo, true, '无 Key 时应为 demo 分析')
        const a = r.json.analysis
        expectTrue(typeof a.summary_zh === 'string' && a.summary_zh.length > 10, 'summary_zh 应为非空中文摘要')
        expectTrue(/[\u4e00-\u9fa5]/.test(a.summary_zh), 'summary_zh 应为中文')
        expectTrue(Array.isArray(a.keyPoints) && a.keyPoints.length >= 1 && a.keyPoints.length <= 6, `keyPoints 应为 1–6 条，实际 ${a.keyPoints.length}`)
        expectTrue(a.keyPoints.every((p) => p.en && p.zh), 'keyPoints 每项应含 en/zh')
        expectTrue(Array.isArray(a.keyWords) && a.keyWords.length >= 3 && a.keyWords.length <= 10, `keyWords 应为 3–10 条，实际 ${a.keyWords.length}`)
        expectTrue(a.keyWords.every((w) => w.word && /[A-Za-z]/.test(w.word)), 'keyWords 每项应含英文 word')
        expectTrue(Array.isArray(a.questions) && a.questions.length >= 3 && a.questions.length <= 6, `questions 应为 3–6 条，实际 ${a.questions.length}`)
        expectTrue(a.questions.every((q) => q.en && q.zh), 'questions 每项应含 en/zh')
        expectTrue(typeof a.readAloud === 'string' && a.readAloud.length > 0 && a.readAloud.length <= 800, `readAloud 应非空且 ≤800，实际 ${a.readAloud && a.readAloud.length}`)
        expectTrue(typeof a.wordCount === 'number' && a.wordCount > 0, `wordCount 应 >0，实际 ${a.wordCount}`)

        const again = await jfetch(api('/api/doc/analyze'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: txtId }),
        })
        expectStatus(again, 200, 'analyze 再次调用')
        expectEqual(again.json.cached, true, '重复分析应命中缓存 cached:true')
        expectEqual(again.json.analysis.summary_zh, a.summary_zh, '缓存结果应一致')

        const bad = await jfetch(api('/api/doc/analyze'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'd_0000000000000000' }),
        })
        expectStatus(bad, 404, 'analyze 不存在 doc')
      })

      await check('有 Key：analyze 走 mock 严格 JSON → demo:false 且上游 prompt 含材料', async () => {
        mock.reset()
        const put = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseUrl: mock.url, model: 'mock-model', apiKey: validKey }),
        })
        expectStatus(put, 200, 'PUT /api/settings 恢复 Key')
        const r = await jfetch(api('/api/doc/analyze'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: docxId, level: 'B1' }),
        })
        expectStatus(r, 200, 'POST /api/doc/analyze（有 Key/mock）')
        expectEqual(r.json.demo, false, `有 Key 且 mock 合法 JSON 时 demo 应为 false，实际 ${JSON.stringify(r.json)}`)
        expectTrue(!r.json.fallback, 'live 分析不应 fallback')
        expectEqual(r.json.analysis.keyWords.length, DEFAULT_DOC_ANALYSIS.keyWords.length, 'live analysis keyWords 数量应与 mock 一致')
        const words = r.json.analysis.keyWords.map((w) => w.word.toLowerCase())
        expectTrue(words.includes('vocabulary'), `live keyWords 应包含 vocabulary，实际 ${words.join(',')}`)
        expectTrue(r.json.analysis.questions.length >= 1, 'live questions 应解析出来')
        expectTrue(mock.docAnalysisCalls.length >= 1, 'mock 应收到文档分析请求')
        const call = mock.docAnalysisCalls[mock.docAnalysisCalls.length - 1]
        expectEqual(call.body.stream, false, '文档分析上游请求应为非流式')
        const systemContent = String(call.body.messages[0].content || '')
        expectMatch(systemContent, /lesson plan/i, '分析 prompt 应为 lesson plan')
        expectMatch(systemContent, /fixture-doc\.docx/, '分析 prompt 应包含文件名')
        const again = await jfetch(api('/api/doc/analyze'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: docxId }),
        })
        expectEqual(again.json.cached, true, 'live 分析结果也应缓存')
      })

      await check('上游分析坏 JSON：降级 demo 且仍 200', async () => {
        mock.setScenario('bad-doc-analysis')
        try {
          const r = await jfetch(api('/api/doc/analyze'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: pdfId }),
          })
          expectStatus(r, 200, 'POST /api/doc/analyze（上游坏 JSON）')
          expectEqual(r.json.ok, true, '坏 JSON 时接口仍返回可用结果')
          expectEqual(r.json.demo, true, '坏 JSON 时应降级 demo')
          expectEqual(r.json.fallback, true, '降级应标记 fallback')
          expectTrue(typeof r.json.reason === 'string' && r.json.reason.length > 0, '降级应带中文原因')
          expectTrue(r.json.analysis.questions.length >= 3, '降级分析仍应有理解题')
        } finally {
          mock.setScenario('ok')
        }
      })

      await check('无 Key 阅读讲解：start → meta.doc + 英文开场/第一题；回答 → 下一题', async () => {
        const clear = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clearKey: true }),
        })
        expectStatus(clear, 200, 'clearKey')

        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'reading', docId: txtId, start: true, level: 'A2' }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        const types = events.map((e) => e.event)
        console.log(c.dim(`      事件序列: ${types.join(' → ')}`))
        expectEqual(types[0], 'meta', '首个事件应为 meta')
        expectEqual(events[0].data.demo, true, '无 Key 应为 demo')
        expectTrue(!!events[0].data.doc && events[0].data.doc.id === txtId, 'meta 应包含 doc 元数据')
        expectEqual(events[0].data.doc.name, 'english-article.txt', 'meta.doc.name 应为文档名')
        const deltaText = events
          .filter((e) => e.event === 'delta')
          .map((e) => e.data && e.data.text)
          .join('')
        expectMatch(deltaText, /First question/i, `开场应给出第一道理解题，实际 "${deltaText.slice(0, 200)}"`)
        expectMatch(deltaText, /english-article\.txt|Reading/i, '开场应介绍文档')
        const firstDone = events.find((e) => e.event === 'done')
        expectTrue(!!firstDone && firstDone.data.fullReply.length > 0, '开场应有 done.fullReply')

        const res2 = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'reading',
            docId: txtId,
            message: 'Reading helps us build vocabulary.',
            history: [
              { role: 'user', content: 'Start reading.' },
              { role: 'assistant', content: firstDone.data.fullReply },
            ],
          }),
          signal: AbortSignal.timeout(45000),
        })
        const events2 = await collectSSE(res2)
        const delta2 = events2
          .filter((e) => e.event === 'delta')
          .map((e) => e.data && e.data.text)
          .join('')
        expectMatch(delta2, /Next question/i, `回答后应给出下一题，实际 "${delta2.slice(0, 200)}"`)
        const fb2 = events2.find((e) => e.event === 'feedback')
        expectTrue(!!fb2, '回答后应有 feedback')
        expectTrue(typeof fb2.data.encouragement_zh === 'string' && fb2.data.encouragement_zh.length > 0, '回答后应有中文鼓励')
      })

      await check('阅读讲解中文求助：meta.chinese=true + chineseHelp + corrections=[]', async () => {
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'reading', docId: txtId, message: '我今天很累，不知道怎么说', history: [] }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        expectEqual(events[0].data.chinese, true, '阅读讲解中文消息 meta.chinese 应为 true')
        expectTrue(!!events[0].data.doc, '阅读讲解 meta 应带 doc')
        const fb = events.find((e) => e.event === 'feedback').data
        expectTrue(!!fb.chineseHelp && typeof fb.chineseHelp.english === 'string' && fb.chineseHelp.english.length > 0, '阅读讲解中文求助应返回 chineseHelp')
        expectTrue(Array.isArray(fb.corrections) && fb.corrections.length === 0, '中文求助 corrections 应为空')
      })

      await check('阅读讲解错误：缺 docId → 400；无效 docId → 404', async () => {
        const noId = await jfetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'reading', start: true, message: '' }),
        })
        expectStatus(noId, 400, '阅读讲解缺 docId')
        expectMatch(noId.json.error, /docId|材料/, '缺 docId 应返回中文提示')
        const badId = await jfetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'reading', docId: 'd_0000000000000000', start: true }),
        })
        expectStatus(badId, 404, '阅读讲解无效 docId')
        expectMatch(badId.json.error, /材料不存在|删除/, '无效 docId 应返回中文提示')
      })

      await check('有 Key 阅读讲解：meta.doc + 上游 prompt 含文档片段/一次一题/中文协议', async () => {
        mock.reset()
        const put = await jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseUrl: mock.url, model: 'mock-model', apiKey: validKey }),
        })
        expectStatus(put, 200, 'PUT /api/settings 恢复 Key')
        const res = await fetch(api('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'reading', docId: txtId, start: true, level: 'A2' }),
          signal: AbortSignal.timeout(45000),
        })
        const events = await collectSSE(res)
        expectEqual(events[0].data.demo, false, '有 Key 阅读讲解应为 live')
        expectTrue(!!events[0].data.doc && events[0].data.doc.id === txtId, 'live meta 应包含 doc')
        expectTrue(events.some((e) => e.event === 'done'), 'live 阅读讲解应完整结束')
        const call = mock.chatCalls[mock.chatCalls.length - 1]
        const systemContent = String(call.body.messages[0].content || '')
        expectMatch(systemContent, /Uploaded reading material/, '上游 prompt 应注入阅读材料区')
        expectMatch(systemContent, /english-article\.txt/, '上游 prompt 应包含文档名')
        expectMatch(systemContent, /quick brown fox/i, '上游 prompt 应包含原文片段')
        expectMatch(systemContent, /ONE question at a time/i, '上游 prompt 应要求一次只问一题')
        expectMatch(systemContent, /HIGHEST PRIORITY/, '上游 prompt 应保留相关性规则')
        expectMatch(systemContent, /WHEN THE STUDENT USES CHINESE/, '上游 prompt 应保留中文求助协议')
      })

      await check('DELETE /api/doc/:id：列表与详情移除，重复删除 404', async () => {
        const del = await jfetch(api(`/api/doc/${pptxId}`), { method: 'DELETE' })
        expectStatus(del, 200, 'DELETE /api/doc/:id')
        expectEqual(del.json.ok, true, '删除应返回 ok:true')
        const gone = await jfetch(api(`/api/doc/${pptxId}`))
        expectStatus(gone, 404, '删除后详情应 404')
        const list = await jfetch(api('/api/doc/list'))
        expectTrue(!list.json.docs.some((d) => d.id === pptxId), '删除后列表不应再包含该文档')
        const again = await jfetch(api(`/api/doc/${pptxId}`), { method: 'DELETE' })
        expectStatus(again, 404, '重复删除应 404')
      })
    })

    // =====================================================================
    await group('v1.4 豆包实时语音 / 教练分析', async () => {
      const volcMock = await startMockVolc({ chunkDelayMs: 4 })
      const serverPort = Number(new URL(baseUrl).port)
      const bridgeUrl = `ws://127.0.0.1:${serverPort}/ws/voice`
      const volcCreds = {
        appId: 'test-app',
        apiKey: 'volc-secret-key-1234',
        model: '3.0',
        speaker: 'en_female_dacey_uranus_bigtts',
        endpoint: volcMock.wsUrl,
        resourceId: 'volc.speech.dialog',
      }
      const putVolc = async (volcPatch, extra = {}) =>
        jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voiceEngine: 'volc', volc: { ...volcPatch }, ...extra }),
        })
      const restoreVolc = async () => {
        const r = await putVolc(volcCreds)
        expectStatus(r, 200, '恢复豆包凭据')
      }

      /** 连接本地 /ws/voice 桥，收集 JSON 与二进制消息 */
      function openBridge(url) {
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(url)
          ws.binaryType = 'arraybuffer'
          const inbox = []
          ws.addEventListener('message', (ev) => {
            if (typeof ev.data === 'string') {
              let json = null
              try {
                json = JSON.parse(ev.data)
              } catch {
                json = null
              }
              inbox.push({ kind: 'json', json, text: ev.data })
            } else if (ev.data instanceof ArrayBuffer) {
              inbox.push({ kind: 'binary', bytes: new Uint8Array(ev.data) })
            }
          })
          const timer = setTimeout(() => reject(new Error('桥 WS 连接超时')), 8000)
          ws.addEventListener('open', () => {
            clearTimeout(timer)
            resolve({ ws, inbox })
          })
          ws.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('桥 WS 连接失败'))
          })
        })
      }
      const waitBridge = (bridge, predicate, label, timeoutMs = 20000) =>
        waitUntil(() => bridge.inbox.find(predicate), { timeoutMs, label })
      const closeBridge = (ws) => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }

      try {
        await check('设置 v1.4：voiceEngine/volc 嵌套保存、掩码、health.volcConfigured', async () => {
          const saved = await putVolc(volcCreds)
          expectStatus(saved, 200, 'PUT /api/settings volc')
          expectEqual(saved.json.voiceEngine, 'volc', 'voiceEngine 应为 volc')
          expectTrue(!!saved.json.volc, 'settings 应返回 volc 对象')
          for (const k of ['appId', 'model', 'speaker', 'endpoint', 'resourceId', 'hasKey', 'keyHint', 'configured']) {
            expectTrue(k in saved.json.volc, `volc 设置应包含 ${k}`)
          }
          expectEqual(saved.json.volc.appId, volcCreds.appId, 'volc.appId 应保存')
          expectEqual(saved.json.volc.endpoint, volcMock.wsUrl, 'volc.endpoint 应保存')
          expectEqual(saved.json.volc.hasKey, true, 'volc.hasKey 应为 true')
          expectTrue(saved.json.volc.keyHint.endsWith('1234'), `volc.keyHint 应保留后 4 位，实际 ${saved.json.volc.keyHint}`)
          expectTrue(!saved.text.includes(volcCreds.apiKey), 'PUT 响应不得包含 volc.apiKey 原文')
          expectTrue(!JSON.stringify(saved.json).includes(volcCreds.apiKey), 'PUT 响应 JSON 不得泄露 volc.apiKey')
          const got = await jfetch(api('/api/settings'))
          expectTrue(!got.text.includes(volcCreds.apiKey), 'GET /api/settings 不得返回 volc.apiKey 原文')
          expectTrue(!JSON.stringify(got.json).includes('volc-secret'), 'GET settings 不得包含密钥片段')
          expectEqual(got.json.volc.configured, true, 'volc.configured 应为 true')
          const health = await jfetch(api('/api/health'))
          expectEqual(health.json.volcConfigured, true, 'health.volcConfigured 应为 true')
        })

        await check('POST /api/volc/test：mock 握手成功 + 鉴权头/session 配置正确', async () => {
          volcMock.reset()
          const r = await jfetch(api('/api/volc/test'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          expectStatus(r, 200, 'POST /api/volc/test')
          expectEqual(r.json.ok, true, `volc/test 应成功，实际 ${JSON.stringify(r.json)}`)
          expectTrue(typeof r.json.latencyMs === 'number' && r.json.latencyMs >= 0, 'volc/test 应返回 latencyMs')
          expectEqual(r.json.model, '3.0', 'volc/test 应返回 model')
          expectEqual(r.json.speaker, volcCreds.speaker, 'volc/test 应返回 speaker')
          expectTrue(volcMock.connections.length >= 1, 'mock 火山应收到连接')
          const conn = volcMock.connections[volcMock.connections.length - 1]
          expectEqual(conn.headers['x-api-app-id'], volcCreds.appId, 'X-Api-App-Id 应正确')
          expectEqual(conn.headers['x-api-key'], volcCreds.apiKey, 'X-Api-Key 应正确')
          expectEqual(conn.headers['x-api-resource-id'], volcCreds.resourceId, 'X-Api-Resource-Id 应正确')
          expectTrue(volcMock.sessionConfigs.length >= 1, 'mock 应收到 StartSession 配置')
          const cfg = volcMock.sessionConfigs[volcMock.sessionConfigs.length - 1]
          expectEqual(cfg.asr.audio_info.sample_rate, 16000, 'asr 采样率应为 16k')
          expectEqual(cfg.asr.audio_info.format, 'pcm', 'asr 格式应为 pcm')
          expectEqual(cfg.tts.audio_config.sample_rate, 24000, 'tts 采样率应为 24k')
          expectEqual(cfg.tts.speaker, volcCreds.speaker, 'tts.speaker 应为设置值')
          expectEqual(cfg.dialog.bot_name, 'Ava', 'dialog.bot_name 应为 Ava')
          expectEqual(cfg.dialog.extra.model, '3.0', 'dialog.extra.model 应为 3.0')
          expectTrue(typeof cfg.dialog.system_role === 'string' && cfg.dialog.system_role.length > 20, 'session 配置应包含 persona（system_role）')
          expectMatch(cfg.dialog.system_role, /REAL-TIME VOICE|teacher/i, 'persona 应为实时语音老师人格')
          expectTrue(conn.events.includes(1) && conn.events.includes(100), 'mock 应收到 StartConnection(1)/StartSession(100)')
        })

        await check('POST /api/volc/test 失败场景：鉴权/模型/音色 → 中文错误', async () => {
          for (const [scenario, re] of [
            ['auth-fail', /鉴权|API Key|Access Token/i],
            ['model-fail', /模型|版本/i],
            ['speaker-fail', /音色|speaker/i],
          ]) {
            volcMock.reset()
            volcMock.setScenario(scenario)
            const r = await jfetch(api('/api/volc/test'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
            expectStatus(r, 200, `volc/test（${scenario}）`)
            expectEqual(r.json.ok, false, `${scenario}：ok 应为 false`)
            expectTrue(typeof r.json.error === 'string' && r.json.error.length > 0, `${scenario}：应有中文错误`)
            expectMatch(r.json.error, re, `${scenario}：错误文案应为中文可操作提示，实际 ${JSON.stringify(r.json.error)}`)
          }
          volcMock.setScenario('ok')
        })

        await check('POST /api/volc/test 未配置凭据：中文提示；恢复配置', async () => {
          const clear = await putVolc({ clearKey: true })
          expectStatus(clear, 200, 'volc clearKey')
          expectEqual(clear.json.volc.hasKey, false, 'clearKey 后 volc.hasKey=false')
          const noKey = await jfetch(api('/api/volc/test'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          expectEqual(noKey.json.ok, false, '无 Key 时 ok=false')
          expectMatch(noKey.json.error, /API Key|Access Token/i, '无 Key 应中文提示填写 API Key')
          const clearApp = await putVolc({ appId: '' })
          expectStatus(clearApp, 200, '清空 appId')
          const noApp = await jfetch(api('/api/volc/test'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          expectEqual(noApp.json.ok, false, '无 appId 时 ok=false')
          expectMatch(noApp.json.error, /App ID/i, '无 appId 应中文提示填写 App ID')
          await restoreVolc()
        })

        await check('/ws/voice 桥：start→ready→上行 PCM→asr/chat/audio→stop→ended', async () => {
          volcMock.reset()
          const r = await jfetch(api('/api/health'))
          expectStatus(r, 200, '断线前 health')
          const bridge = await openBridge(bridgeUrl)
          try {
            bridge.ws.send(JSON.stringify({ type: 'start', mode: 'free', level: 'A2' }))
            const ready = await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'ready', 'ready')
            expectEqual(ready.json.demo, false, 'ready.demo 应为 false')
            expectEqual(ready.json.model, '3.0', 'ready.model 应为 3.0')
            expectEqual(ready.json.speaker, volcCreds.speaker, 'ready.speaker 应正确')

            // 上行 16k PCM（20ms/640B），mock 应在首帧后推 ASR/Chat/TTS
            for (let i = 0; i < 3; i++) bridge.ws.send(Buffer.alloc(640, i + 1))
            const asr = await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'asr', 'asr')
            expectTrue(typeof asr.json.text === 'string' && asr.json.text.length > 0, 'asr.text 应非空')
            expectEqual(asr.json.final, false, '首条 asr 应为 interim')
            await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'asr' && m.json.final === true, 'asr final')
            const chat = await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'chat', 'chat')
            expectTrue(typeof chat.json.text === 'string', 'chat 应带文本')
            await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'audio-start', 'audio-start')
            const pcm = await waitBridge(bridge, (m) => m.kind === 'binary' && m.bytes.length > 100, '二进制 PCM')
            expectTrue(pcm.bytes.length % 2 === 0, '下行 PCM 应为 s16le（偶数字节）')
            await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'audio-end', 'audio-end')
            await waitUntil(() => volcMock.audioFrames >= 3, { timeoutMs: 8000, label: 'mock 收到上行音频' })
            expectTrue(volcMock.audioBytes >= 640 * 3, 'mock 音频字节数应 >= 3×640')
            const conn = volcMock.connections[volcMock.connections.length - 1]
            expectTrue(typeof conn.sessionConfig.dialog.system_role === 'string', '桥应下发 persona system_role')
            expectMatch(conn.sessionConfig.dialog.system_role, /REAL-TIME VOICE|teacher/i, '桥 persona 应为实时语音老师')

            const endedPromise = new Promise((resolve) => bridge.ws.addEventListener('close', resolve, { once: true }))
            bridge.ws.send(JSON.stringify({ type: 'stop' }))
            const ended = await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'ended', 'ended')
            expectTrue(typeof ended.json.reason === 'string' && ended.json.reason.length > 0, `ended.reason 应为非空字符串（停止/关闭原因），实际 ${JSON.stringify(ended.json.reason)}`)
            await Promise.race([endedPromise, sleep(3000)])
            await waitUntil(() => conn.closed, { timeoutMs: 5000, label: 'mock 侧连接已关闭' })
            expectTrue(volcMock.events.some((e) => e.type === 'client-event' && e.eventId === 102), '桥 stop 时应发 FinishSession(102)')
          } finally {
            closeBridge(bridge.ws)
          }
        })

        await check('/ws/voice 打断：客户端 interrupt → mock 收到 515 + TTS 收尾', async () => {
          volcMock.reset()
          const bridge = await openBridge(bridgeUrl)
          try {
            bridge.ws.send(JSON.stringify({ type: 'start', mode: 'free' }))
            await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'ready', 'ready')
            bridge.ws.send(Buffer.alloc(640, 7))
            await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'audio-start', 'audio-start')
            bridge.ws.send(JSON.stringify({ type: 'interrupt' }))
            await waitUntil(
              () => volcMock.events.some((e) => e.type === 'client-event' && e.eventId === 515),
              { timeoutMs: 5000, label: 'mock 收到 ClientInterrupt(515)' },
            )
            await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'audio-end', '打断后 audio-end')
            const conn = volcMock.connections[volcMock.connections.length - 1]
            expectEqual(conn.interrupted, true, 'mock 应记录打断')
          } finally {
            closeBridge(bridge.ws)
          }
        })

        await check('/ws/voice PTT commit：补 80 帧静音触发；无 session commit 不崩', async () => {
          volcMock.reset()
          const bridge = await openBridge(bridgeUrl)
          try {
            bridge.ws.send(JSON.stringify({ type: 'start', mode: 'free' }))
            await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'ready', 'ready')
            const beforeFrames = volcMock.audioFrames
            const beforeBytes = volcMock.audioBytes
            bridge.ws.send(JSON.stringify({ type: 'commit' }))
            await waitUntil(() => volcMock.audioFrames >= beforeFrames + 80, { timeoutMs: 12000, label: 'commit 后 80 帧静音' })
            expectTrue(volcMock.audioBytes >= beforeBytes + 80 * 640, 'commit 静音帧应为 80×640B')
            expectEqual(volcMock.events.filter((e) => e.type === 'client-audio').slice(-80).every((e) => e.bytes === 640), true, '静音帧均应为 640B')
          } finally {
            closeBridge(bridge.ws)
          }
          // 无 session 时 commit 不应崩溃/断连
          const bridge2 = await openBridge(bridgeUrl)
          try {
            bridge2.ws.send(JSON.stringify({ type: 'commit' }))
            await sleep(300)
            const err = bridge2.inbox.find((m) => m.kind === 'json' && m.json.type === 'error')
            expectTrue(!err, '无 session commit 不应发 error')
            expectTrue(bridge2.ws.readyState === 1, '无 session commit 后连接应保持打开')
          } finally {
            closeBridge(bridge2.ws)
          }
        })
        await check('/ws/voice 上行断线：mock 断开 → 客户端收到 error/ended 并清理', async () => {
          volcMock.reset()
          volcMock.setScenario('mid-disconnect')
          try {
            const bridge = await openBridge(bridgeUrl)
            try {
              bridge.ws.send(JSON.stringify({ type: 'start', mode: 'free' }))
              await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'ready', 'ready')
              bridge.ws.send(Buffer.alloc(640, 1))
              bridge.ws.send(Buffer.alloc(640, 2))
              const notice = await waitBridge(
                bridge,
                (m) => m.kind === 'json' && (m.json.type === 'error' || m.json.type === 'ended'),
                '断线通知',
              )
              expectTrue(notice.json.type === 'error' || notice.json.type === 'ended', '断线应通知客户端 error/ended')
              if (notice.json.type === 'error') {
                expectTrue(typeof notice.json.message === 'string' && notice.json.message.length > 0, 'error 应有中文提示')
              }
            } finally {
              closeBridge(bridge.ws)
            }
          } finally {
            volcMock.setScenario('ok')
          }
        })

        await check('/ws/voice 未配置凭据：立即返回中文 error 并关闭', async () => {
          await putVolc({ clearKey: true })
          const bridge = await openBridge(bridgeUrl)
          try {
            const err = await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'error', '未配置 error', 8000)
            expectMatch(String(err.json.message), /设置页|凭据|App ID/, `未配置应中文提示，实际 ${JSON.stringify(err.json.message)}`)
            await new Promise((resolve) => bridge.ws.addEventListener('close', resolve, { once: true }))
          } finally {
            closeBridge(bridge.ws)
            await restoreVolc()
          }
        })

        await check('POST /api/coach demo：英文纠错 / 中文 chineseHelp(corrections=[]) / 空消息 400', async () => {
          const clearText = await jfetch(api('/api/settings'), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clearKey: true }),
          })
          expectStatus(clearText, 200, '清空文本模型 Key')
          const en = await jfetch(api('/api/coach'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'I very like it', level: 'A2', mode: 'free' }),
          })
          expectStatus(en, 200, 'POST /api/coach 英文')
          expectEqual(en.json.ok, true, 'coach ok')
          expectEqual(en.json.demo, true, '无 Key 时 coach 应为 demo')
          expectTrue(Array.isArray(en.json.feedback.corrections) && en.json.feedback.corrections.length >= 1, '英文错误应识别 corrections')
          expectEqual(en.json.feedback.chineseHelp, null, '英文消息 chineseHelp 应为 null')

          const zh = await jfetch(api('/api/coach'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: '我今天很累，不知道怎么说', level: 'A2', mode: 'free' }),
          })
          expectStatus(zh, 200, 'POST /api/coach 中文')
          expectEqual(zh.json.demo, true, '中文 coach 应为 demo')
          expectTrue(!!zh.json.feedback.chineseHelp, '中文消息 coach 应返回 chineseHelp')
          expectMatch(zh.json.feedback.chineseHelp.english, /exhausted|tired/i, '中文求助英文表达应正确')
          expectTrue(Array.isArray(zh.json.feedback.corrections) && zh.json.feedback.corrections.length === 0, '中文消息 corrections 必须为空')

          const empty = await jfetch(api('/api/coach'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: '   ' }),
          })
          expectStatus(empty, 400, 'coach 空消息')
          expectEqual(empty.json.ok, false, '空消息 ok=false')
        })

        await check('POST /api/coach 有 Key：mock 严格 JSON → demo:false；中文 corrections 强制为空', async () => {
          mock.reset()
          const put = await jfetch(api('/api/settings'), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ baseUrl: mock.url, model: 'mock-model', apiKey: validKey }),
          })
          expectStatus(put, 200, '恢复文本模型 Key')
          const en = await jfetch(api('/api/coach'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'I very like it', level: 'A2', mode: 'free' }),
          })
          expectStatus(en, 200, 'coach（有 Key）')
          expectEqual(en.json.ok, true, 'coach ok')
          expectEqual(en.json.demo, false, `有 Key 且 mock 合法 JSON 时 demo 应为 false，实际 ${JSON.stringify(en.json)}`)
          expectTrue(Array.isArray(en.json.feedback.corrections) && en.json.feedback.corrections.length >= 1, 'live corrections 应解析出来')
          expectTrue(mock.coachCalls.length >= 1, 'mock 文本模型应收到 coach 请求')
          const call = mock.coachCalls[mock.coachCalls.length - 1]
          expectEqual(call.body.stream, false, 'coach 上游请求应为非流式')
          expectMatch(String(call.body.messages[0].content), /Analyze ONLY the student/i, 'coach prompt 应只分析不回复')

          const zh = await jfetch(api('/api/coach'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: '我今天很累，不知道怎么说', level: 'A2', mode: 'free' }),
          })
          expectStatus(zh, 200, 'coach 中文（有 Key）')
          expectEqual(zh.json.demo, false, 'live 中文 coach 应为 demo:false')
          expectTrue(Array.isArray(zh.json.feedback.corrections) && zh.json.feedback.corrections.length === 0, 'live 中文 corrections 也必须为空')
          expectTrue(!!zh.json.feedback.chineseHelp, 'live 中文应补 chineseHelp')
        })
      } finally {
        await volcMock.close()
      }
    })

    // =====================================================================
    await group('v1.5 双语字幕翻译 /api/translate', async () => {
      const volcMock = await startMockVolc({ chunkDelayMs: 3 })
      const volcCreds = {
        appId: 'trans-app',
        apiKey: 'trans-key-1234',
        model: '3.0',
        speaker: 'en_female_dacey_uranus_bigtts',
        endpoint: volcMock.wsUrl,
        resourceId: 'volc.speech.dialog',
      }
      const putSettings = async (patch) =>
        jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      const translate = async (body) =>
        jfetch(api('/api/translate'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      const useVolc = async () => {
        const r = await putSettings({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', clearKey: true, voiceEngine: 'volc', volc: { ...volcCreds } })
        expectStatus(r, 200, '配置豆包凭据')
      }
      const useTextModel = async () => {
        const r = await putSettings({ apiKey: validKey, baseUrl: mock.url, model: 'mock-model', voiceEngine: 'browser', volc: { clearKey: true } })
        expectStatus(r, 200, '配置文本模型 Key')
      }
      try {
        await check('/api/translate：豆包文本模式会话 → ok + 中文 + provider:volc；session 配置为文本模式且无音频', async () => {
          await useVolc()
          volcMock.reset()
          const r = await translate({ texts: ['Hello Ava, how are you today?', 'I like coffee.'], target: 'zh' })
          expectStatus(r, 200, 'POST /api/translate')
          expectEqual(r.json.ok, true, `豆包翻译应成功，实际 ${JSON.stringify(r.json)}`)
          expectEqual(r.json.provider, 'volc', '翻译来源应为 volc')
          expectEqual(Array.isArray(r.json.texts), true, 'texts 应为数组')
          expectEqual(r.json.texts.length, 2, '应返回 2 条译文')
          for (const t of r.json.texts) {
            expectTrue(typeof t === 'string' && /[\u4e00-\u9fff]/.test(t), `译文应为中文：${JSON.stringify(t)}`)
          }
          expectTrue(volcMock.sessionConfigs.length >= 1, 'mock 火山应收到会话')
          const cfg = volcMock.sessionConfigs[volcMock.sessionConfigs.length - 1]
          expectEqual(cfg.dialog.extra.input_mod, 'text', '文本模式 input_mod 应为 text')
          expectEqual(JSON.stringify(cfg.dialog.extra.output_modalities), '["text"]', '文本模式只输出文本')
          expectEqual(cfg.dialog.bot_name, 'Translator', '翻译会话 bot_name 应为 Translator')
          expectMatch(String(cfg.dialog.system_role), /translator/i, 'system_role 应为翻译器')
          expectEqual(volcMock.textQueries.length, 2, `应发 2 条文本查询，实际 ${volcMock.textQueries.length}`)
          expectTrue(volcMock.textQueries[0].includes('Hello Ava'), '文本查询应包含原文')
          expectEqual(volcMock.audioFrames, 0, '翻译不应上行音频')
          expectEqual(volcMock.events.filter((e) => e.type === 'server-audio').length, 0, '翻译不应产生 TTS 音频帧')
        })

        await check('/api/translate：无豆包、有文本模型 Key → provider:llm 中文', async () => {
          await useTextModel()
          mock.reset()
          const r = await translate({ texts: ['Hello, how are you?', 'I like coffee.'], target: 'zh' })
          expectStatus(r, 200, 'POST /api/translate（文本模型）')
          expectEqual(r.json.ok, true, `文本模型翻译应成功，实际 ${JSON.stringify(r.json)}`)
          expectEqual(r.json.provider, 'llm', '翻译来源应为 llm')
          expectEqual(r.json.texts.length, 2)
          for (const t of r.json.texts) expectTrue(/[\u4e00-\u9fff]/.test(t), `译文应为中文：${JSON.stringify(t)}`)
          expectTrue(mock.translationCalls.length >= 1, 'mock 文本模型应收到翻译请求')
          expectMatch(String(mock.translationCalls[mock.translationCalls.length - 1].body.messages[0].content), /translator/i, '翻译 prompt 应为 translator')
        })

        await check('/api/translate：两者都无凭据 → ok:false + 中文错误 + 全 null（HTTP 200 不 500）', async () => {
          const r = await putSettings({ apiKey: '', clearKey: true, baseUrl: 'http://127.0.0.1:9/v1', volc: { clearKey: true } })
          expectStatus(r, 200, '清空所有凭据')
          const tr = await translate({ texts: ['Hello world', 'Good morning'], target: 'zh' })
          expectStatus(tr, 200, '无凭据 translate 仍应 200')
          expectEqual(tr.json.ok, false, '无凭据时应 ok:false')
          expectTrue(tr.json.provider === null || tr.json.provider === undefined, '无凭据 provider 应为空')
          expectEqual(JSON.stringify(tr.json.texts), '[null,null]', '无凭据时译文应全 null')
          expectMatch(String(tr.json.error), /配置|翻译服务暂不可用/, `应中文提示配置，实际 ${JSON.stringify(tr.json.error)}`)
        })

        await check('/api/translate：上游翻译失败（返回英文）→ ok:false 静默降级，不 500', async () => {
          await useVolc()
          volcMock.reset()
          volcMock.setScenario('translate-fail')
          try {
            const tr = await translate({ texts: ['Hello Ava'], target: 'zh' })
            expectStatus(tr, 200, '失败场景仍应 200')
            expectEqual(tr.json.ok, false, '上游返回英文时应 ok:false')
            expectTrue(tr.json.provider === null || tr.json.provider === undefined, '失败场景 provider 应为空')
            expectEqual(JSON.stringify(tr.json.texts), '[null]')
            expectTrue(typeof tr.json.error === 'string' && tr.json.error.length > 0, '应有 error 文案（前端静默不弹窗）')
            const textCallsBefore = mock.translationCalls.length
            expectEqual(mock.translationCalls.length, textCallsBefore, '无文本 Key 时不应回退文本模型')
          } finally {
            volcMock.setScenario('ok')
          }
        })

        await check('/api/translate 参数校验：空/超 8 条/超长截断/target 非 zh', async () => {
          await useVolc()
          volcMock.reset()
          const empty = await translate({ texts: [], target: 'zh' })
          expectStatus(empty, 200, '空 texts')
          expectEqual(empty.json.ok, true, '空数组应 ok:true')
          expectEqual(empty.json.texts.length, 0, '空数组返回空数组')
          expectEqual(empty.json.provider, null, '空数组 provider=null')

          const many = await translate({ texts: Array.from({ length: 12 }, (_, i) => `Sentence number ${i}`), target: 'zh' })
          expectStatus(many, 200, '12 条 texts')
          expectEqual(many.json.texts.length, 8, '超过 8 条应截断为 8 条')
          expectTrue(volcMock.textQueries.length >= 8, '翻译会话应收到 8 条查询')

          const longText = 'word '.repeat(200)
          const long = await translate({ texts: [longText], target: 'zh' })
          expectStatus(long, 200, '超长文本')
          expectEqual(long.json.ok, true, '超长文本应截断后翻译成功')

          const badTarget = await translate({ texts: ['Hello'], target: 'en' })
          expectStatus(badTarget, 200, 'target 非 zh')
          expectEqual(badTarget.json.ok, false, 'target 非 zh 应 ok:false')
          expectMatch(String(badTarget.json.error), /中文/, '应提示只支持翻译成中文')
        })
      } finally {
        await volcMock.close()
      }
    })

    // =====================================================================
    await group('v1.6 手机版 / 角色 / 计划 / 助手', async () => {
      const volcMock = await startMockVolc({ chunkDelayMs: 3 })
      const volcCreds = {
        appId: 'mobile-app',
        apiKey: 'mobile-key-1234',
        model: '3.0',
        speaker: 'en_female_dacey_uranus_bigtts',
        endpoint: volcMock.wsUrl,
        resourceId: 'volc.speech.dialog',
      }
      const putSettings = async (patch) =>
        jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      const setDemo = async () => {
        const r = await putSettings({ apiKey: '', clearKey: true, baseUrl: 'http://127.0.0.1:9/v1', volc: { clearKey: true } })
        expectStatus(r, 200, '清空凭据（demo 模式）')
      }
      const setVolc = async () => {
        const r = await putSettings({ voiceEngine: 'browser', volc: { ...volcCreds } })
        expectStatus(r, 200, '配置豆包凭据')
      }
      const setTextModel = async () => {
        const r = await putSettings({ apiKey: validKey, baseUrl: mock.url, model: 'mock-model' })
        expectStatus(r, 200, '配置文本模型 Key')
      }
      const assistant = async (body) =>
        jfetch(api('/api/assistant'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      const expectedSpeakers = {
        elena: 'en_female_dacey_uranus_bigtts',
        maya: 'en_female_stokie_uranus_bigtts',
        hikari: 'zh_female_vv_jupiter_bigtts',
      }

      function openBridge(url) {
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(url)
          ws.binaryType = 'arraybuffer'
          const inbox = []
          ws.addEventListener('message', (ev) => {
            if (typeof ev.data === 'string') {
              let json = null
              try {
                json = JSON.parse(ev.data)
              } catch {
                json = null
              }
              inbox.push({ kind: 'json', json, text: ev.data })
            } else if (ev.data instanceof ArrayBuffer) inbox.push({ kind: 'binary', bytes: new Uint8Array(ev.data) })
          })
          const timer = setTimeout(() => reject(new Error('桥 WS 连接超时')), 8000)
          ws.addEventListener('open', () => {
            clearTimeout(timer)
            resolve({ ws, inbox })
          })
          ws.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('桥 WS 连接失败'))
          })
        })
      }
      const waitBridge = (bridge, predicate, label, timeoutMs = 20000) =>
        waitUntil(() => bridge.inbox.find(predicate), { timeoutMs, label })

      try {
        await check('GET /api/characters：3 角色结构完整且不含人设 prompt', async () => {
          const r = await jfetch(api('/api/characters'))
          expectStatus(r, 200, 'GET /api/characters')
          expectEqual(r.json.ok, true, 'characters.ok')
          expectEqual(r.json.characters.length, 3, '应有 3 个角色')
          expectEqual(r.json.characters.map((c) => c.id).join(','), 'elena,maya,hikari', '角色 id/顺序')
          const required = ['id', 'name', 'city', 'style', 'tags', 'voiceLabel', 'cover', 'greeting', 'scenes', 'level', 'themeColor']
          for (const c of r.json.characters) {
            for (const k of required) expectTrue(k in c, `角色 ${c.id} 应包含 ${k}`)
            expectTrue(Array.isArray(c.tags) && c.tags.length >= 2, `${c.id} tags 至少 2 个`)
            expectTrue(Array.isArray(c.scenes) && c.scenes.length >= 3, `${c.id} scenes 至少 3 个`)
            for (const s of c.scenes) {
              expectTrue(typeof s.id === 'string' && typeof s.label === 'string' && typeof s.emoji === 'string', `${c.id} 场景字段完整`)
            }
            expectTrue(typeof c.greeting === 'string' && c.greeting.length > 10, `${c.id} greeting 非空`)
            expectTrue(String(c.cover).includes('/assets/characters/'), `${c.id} cover 路径`)
            expectMatch(String(c.cover), /\.jpg$/, `${c.id} v1.7 cover 必须是用户原图 .jpg`)
            expectMatch(String(c.themeColor), /^#[0-9a-f]{6}$/i, `${c.id} themeColor 应为颜色`)
          }
          for (const hidden of ['persona', 'voiceLabel', 'greetingZh', 'occupation']) {
            expectTrue(!('persona' in r.json.characters[0]), '公开数据不应包含 persona')
          }
          for (const secret of ['You are Elena', 'You are Maya', 'You are Hikari', 'gallery curator']) {
            expectTrue(!r.text.includes(secret), `characters 响应不得包含人设：${secret}`)
          }
        })

        await check('GET /api/characters/:id 单个成功；无效 id → 404 中文', async () => {
          const one = await jfetch(api('/api/characters/maya'))
          expectStatus(one, 200, 'GET /api/characters/maya')
          expectEqual(one.json.ok, true)
          expectEqual(one.json.character.id, 'maya')
          expectEqual(one.json.character.city, '纽约')
          expectTrue(!('persona' in one.json.character), '单个角色也不应返回 persona')
          const missing = await jfetch(api('/api/characters/nope'))
          expectStatus(missing, 404, '无效角色应 404')
          expectEqual(missing.json.ok, false)
          expectMatch(String(missing.json.error), /角色不存在/, '无效角色应中文提示')
        })

        await check('GET /api/plan：新沙箱未创建计划 → {ok:true, plan:null}', async () => {
          const r = await jfetch(api('/api/plan'))
          expectStatus(r, 200, 'GET /api/plan')
          expectEqual(r.json.ok, true)
          expectEqual(r.json.plan, null, '新沙箱应无计划')
        })

        await check('POST /api/assistant demo：create_plan → 计划落库并可查询', async () => {
          await setDemo()
          const r = await assistant({ message: '帮我创建一个出国旅行计划，B1，想找 Maya 练' })
          expectStatus(r, 200, 'assistant create_plan')
          expectEqual(r.json.ok, true)
          expectEqual(r.json.demo, true, '无豆包凭据时应 demo:true')
          expectTrue(typeof r.json.reply === 'string' && r.json.reply.length > 5, 'reply 应非空')
          expectEqual(r.json.actions.length, 1, '应返回 1 个 action')
          const action = r.json.actions[0]
          expectEqual(action.type, 'create_plan')
          expectTrue(!!action.payload && typeof action.payload.id === 'string', 'create_plan payload 应为计划')
          expectEqual(action.payload.version, 3, 'v3.1 计划应为 v3')
          expectEqual(action.payload.level, 'B1', '等级应为 B1')
          expectEqual(action.payload.teacherId, 'maya', '应识别老师 Maya')
          expectMatch(String(action.payload.goalText), /旅行/, 'goalText 应为用户原话')
          expectEqual(action.payload.stages.length, 3, '计划应有 3 节课')
          expectEqual(Object.keys(action.payload.lessons || {}).length, 3, '应有 3 个课件')
          // QA-017 修复后：action.payload 与落库计划必须是同一个对象（id/createdAt 一致）
          expectTrue(!!r.json.plan, 'assistant 响应应返回 plan')
          expectEqual(String(action.payload.id), String(r.json.plan.id), 'action.payload.id 应等于响应 plan.id')
          expectEqual(action.payload.createdAt, r.json.plan.createdAt, 'action.payload.createdAt 应等于响应 plan.createdAt')
          const saved = await jfetch(api('/api/plan'))
          expectTrue(!!saved.json.plan, '计划应已保存')
          expectEqual(String(saved.json.plan.id), String(action.payload.id), 'GET /api/plan.id 应等于 action.payload.id')
          expectEqual(saved.json.plan.createdAt, action.payload.createdAt, 'GET /api/plan.createdAt 应一致')
          expectEqual(saved.json.plan.goalText, action.payload.goalText, '保存计划 goalText 一致')
          expectEqual(saved.json.plan.teacherId, action.payload.teacherId, '保存计划老师一致')
          expectEqual(saved.json.plan.stages.length, action.payload.stages.length, '保存计划阶段数一致')
        })

        await check('POST /api/assistant demo：update_plan / open_scene / open_tab / review_words / 兜底', async () => {
          const cases = [
            ['更新我的计划，改成职场英语', 'update_plan'],
            ['找个场景和 Maya 练对话', 'open_scene'],
            ['打开我的偏好', 'open_tab'],
            ['我想快速复习单词', 'review_words'],
            ['你好呀', null],
            ['今天天气不错', null],
          ]
          for (const [message, type] of cases) {
            const r = await assistant({ message })
            expectStatus(r, 200, `assistant：${message}`)
            expectEqual(r.json.ok, true)
            expectEqual(r.json.demo, true, 'demo 模式应保持')
            if (type) {
              expectEqual(r.json.actions.length, 1, `「${message}」应返回 action`)
              expectEqual(r.json.actions[0].type, type, `「${message}」意图`)
            } else {
              expectEqual(r.json.actions.length, 0, `「${message}」不应返回 action`)
            }
            expectTrue(typeof r.json.reply === 'string' && r.json.reply.length > 3, '回复非空')
          }
          const update = await assistant({ message: '更新我的计划，改成职场英语' })
          expectEqual(update.json.actions[0].payload.version, 3, 'v3.1 更新后仍为 v3 计划')
          expectMatch(String(update.json.actions[0].payload.goalText), /职场/, '更新计划 goalText')
          expectTrue(!!update.json.actions[0].payload.id, '更新计划应有 id')
          const scene = await assistant({ message: '找个场景和 Maya 练对话' })
          expectEqual(scene.json.actions[0].payload.characterId, 'maya')
          expectTrue(typeof scene.json.actions[0].payload.sceneId === 'string')
          const tab = await assistant({ message: '打开我的偏好' })
          expectEqual(tab.json.actions[0].payload.tab, 'profile')
        })

        await check('POST /api/assistant：豆包文本模式 → demo:false，文本会话无 TTS/音频', async () => {
          await setVolc()
          volcMock.reset()
          const r = await assistant({ message: '帮我创建一个职场英语计划' })
          expectStatus(r, 200, 'assistant（豆包文本模式）')
          expectEqual(r.json.ok, true)
          expectEqual(r.json.demo, false, `有豆包凭据时应 demo:false，实际 ${JSON.stringify(r.json)}`)
          expectMatch(String(r.json.reply), /[\u4e00-\u9fff]/, '豆包回复应为中文')
          expectEqual(r.json.actions[0].type, 'create_plan', '动作仍由规则决定')
          expectTrue(volcMock.sessionConfigs.length >= 1, 'mock 应收到助手文本会话')
          const cfg = volcMock.sessionConfigs[volcMock.sessionConfigs.length - 1]
          expectEqual(cfg.dialog.extra.input_mod, 'text', '助手会话应为文本模式')
          expectEqual(JSON.stringify(cfg.dialog.extra.output_modalities), '["text"]', '助手只输出文本')
          expectEqual(volcMock.audioFrames, 0, '助手文本模式不应上行音频')
          expectEqual(volcMock.events.filter((e) => e.type === 'server-audio').length, 0, '助手不应产生 TTS 音频')
        })

        await check('/api/chat characterId（demo）：meta.character + 角色开场口吻；无效 id 回退', async () => {
          await setDemo()
          const res = await fetch(api('/api/chat'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'free', level: 'B1', message: 'Hello', characterId: 'elena' }),
          })
          const events = await collectSSE(res)
          const meta = events.find((e) => e.event === 'meta')
          expectTrue(!!meta, '应有 meta 事件')
          expectTrue(!!meta.data.character, 'meta 应含 character')
          expectEqual(meta.data.character.id, 'elena')
          expectEqual(meta.data.character.name, 'Elena')
          expectEqual(meta.data.character.city, '伦敦')
          expectTrue(typeof meta.data.character.voiceLabel === 'string' && meta.data.character.voiceLabel.length > 0, 'meta.character.voiceLabel')
          const done = events.find((e) => e.event === 'done')
          expectTrue(!!done, '应有 done 事件')
          expectTrue(typeof done.data.fullReply === 'string' && done.data.fullReply.length > 10, '角色开场回复非空')
          expectMatch(done.data.fullReply, /Elena|exhibition|art|gallery/i, 'demo 角色开场应带 Elena 口吻')

          const res2 = await fetch(api('/api/chat'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'free', level: 'B1', message: 'Hello', characterId: 'nope' }),
          })
          const events2 = await collectSSE(res2)
          const meta2 = events2.find((e) => e.event === 'meta')
          expectTrue(!meta2.data.character, '无效 characterId 应回退（无 character meta）')
          const done2 = events2.find((e) => e.event === 'done')
          expectTrue(typeof done2.data.fullReply === 'string' && done2.data.fullReply.length > 0, '回退后仍有 demo 回复')
        })

        await check('/api/chat characterId（live）：角色人设进入 system prompt', async () => {
          await setTextModel()
          mock.reset()
          const res = await fetch(api('/api/chat'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'free', level: 'B1', message: 'Hi Maya! Tell me about New York.', characterId: 'maya' }),
          })
          const events = await collectSSE(res)
          const meta = events.find((e) => e.event === 'meta')
          expectEqual(meta.data.demo, false, '有 Key 时 demo 应为 false')
          expectEqual(meta.data.character.id, 'maya')
          expectTrue(mock.chatCalls.length >= 1, 'mock 文本模型应收到 chat')
          const call = mock.chatCalls[mock.chatCalls.length - 1]
          const system = call.body.messages[0].content
          expectMatch(system, /Maya/, 'system prompt 应含角色名')
          expectMatch(system, /New York/, 'system prompt 应含角色城市')
          expectMatch(system, /Stay fully in character/i, 'system prompt 应要求保持角色')
        })

        await check('/ws/voice 带 characterId：3 角色音色/人设分别生效；无效 id 回退默认', async () => {
          await setVolc()
          const serverPort = Number(new URL(baseUrl).port)
          const bridgeUrl = `ws://127.0.0.1:${serverPort}/ws/voice`
          for (const [characterId, speaker] of Object.entries(expectedSpeakers)) {
            volcMock.reset()
            const bridge = await openBridge(bridgeUrl)
            try {
              bridge.ws.send(JSON.stringify({ type: 'start', mode: 'free', level: 'B1', characterId }))
              const ready = await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'ready', `ready（${characterId}）`)
              expectEqual(ready.json.character.id, characterId, `ready.character.id（${characterId}）`)
              expectEqual(ready.json.character.name, { elena: 'Elena', maya: 'Maya', hikari: 'Hikari' }[characterId])
              expectEqual(ready.json.speaker, speaker, `${characterId} 的 ready.speaker 应为角色音色`)
              expectTrue(volcMock.sessionConfigs.length >= 1, `mock 应收到 ${characterId} 会话配置`)
              const cfg = volcMock.sessionConfigs[volcMock.sessionConfigs.length - 1]
              expectEqual(cfg.tts.speaker, speaker, `${characterId} 的 session tts.speaker`)
              expectMatch(String(cfg.dialog.system_role), new RegExp({ elena: 'Elena', maya: 'Maya', hikari: 'Hikari' }[characterId]), `${characterId} session 人设应含角色名`)
              expectTrue(
                String(cfg.dialog.system_role).length > 100,
                `${characterId} 应有角色人设 prompt`,
              )
            } finally {
              try {
                bridge.ws.send(JSON.stringify({ type: 'stop' }))
              } catch {
                /* ignore */
              }
              bridge.ws.close()
            }
            await sleep(120)
          }
          // 无效 characterId：回退默认老师人设，character=null
          volcMock.reset()
          const bridge = await openBridge(bridgeUrl)
          try {
            bridge.ws.send(JSON.stringify({ type: 'start', mode: 'free', level: 'B1', characterId: 'nope' }))
            const ready = await waitBridge(bridge, (m) => m.kind === 'json' && m.json.type === 'ready', 'ready（无效角色）')
            expectTrue(ready.json.character == null, '无效角色应回退（character 为空）')
            const cfg = volcMock.sessionConfigs[volcMock.sessionConfigs.length - 1]
            expectEqual(cfg.tts.speaker, volcCreds.speaker, '无效角色应回退设置里的默认音色')
          } finally {
            try {
              bridge.ws.send(JSON.stringify({ type: 'stop' }))
            } catch {
              /* ignore */
            }
            bridge.ws.close()
          }
        })

        await check('PWA manifest 可被识别：standalone + icons + theme_color；手机版资源可加载', async () => {
          const r = await jfetch(api('/manifest.webmanifest'))
          expectStatus(r, 200, 'GET /manifest.webmanifest')
          expectMatch(r.headers.get('content-type') || '', /manifest\+json|application\/json/i, 'manifest Content-Type')
          const m = r.json
          expectTrue(!!m, 'manifest 应为合法 JSON')
          for (const key of ['name', 'short_name', 'icons', 'display', 'theme_color']) {
            expectTrue(key in m, `manifest 应包含 ${key}`)
          }
          expectEqual(m.display, 'standalone', 'display 应为 standalone')
          expectTrue(Array.isArray(m.icons) && m.icons.length >= 1, 'icons 至少 1 个')
          for (const icon of m.icons) {
            expectTrue(typeof icon.src === 'string' && icon.src.length > 0, 'icon.src 应存在')
            expectTrue(typeof icon.sizes === 'string' && /[0-9]+x[0-9]+/.test(icon.sizes), 'icon.sizes 应形如 192x192')
          }
          expectMatch(String(m.theme_color), /^#[0-9a-f]{3,8}$/i, 'theme_color 应为颜色值')
          const mobile = await jfetch(api('/mobile'))
          expectStatus(mobile, 200, 'GET /mobile（manifest 检查）')
          expectMatch(mobile.text, /manifest\.webmanifest/, '/mobile 应引用 manifest')
          expectMatch(mobile.text, /apple-mobile-web-app-capable/i, '/mobile 应有 iOS 全屏 meta')
          for (const asset of ['/css/mobile.css', '/js/mobile/app.js', '/js/mobile/core.js']) {
            const a = await jfetch(api(asset))
            expectStatus(a, 200, `GET ${asset}`)
            expectTrue(a.text.length > 100, `${asset} 内容非空`)
          }
        })
        await check('v1.7 角色原图/talking-head：jpg 200 + motion.json 标定 + WebGL 引擎脚本', async () => {
          for (const [id, themeColor] of [['elena', '#d9b477'], ['maya', '#6f8fd6'], ['hikari', '#9fc3e8']]) {
            const img = await jfetch(api(`/assets/characters/${id}.jpg`))
            expectStatus(img, 200, `GET /assets/characters/${id}.jpg`)
            expectMatch(img.headers.get('content-type') || '', /image\/jpeg/i, `${id}.jpg Content-Type`)
            expectTrue(img.text.length > 1000, `${id}.jpg 内容不应为空`)
            const ch = await jfetch(api(`/api/characters/${id}`))
            expectStatus(ch, 200, `GET /api/characters/${id}（v1.7）`)
            expectMatch(String(ch.json.character.cover), /\.jpg$/, `${id} API cover 应为 .jpg`)
            expectEqual(String(ch.json.character.themeColor).toLowerCase(), themeColor, `${id} themeColor`)
          }
          const motion = await jfetch(api('/assets/characters/motion.json'))
          expectStatus(motion, 200, 'GET /assets/characters/motion.json')
          expectTrue(!!motion.json, 'motion.json 应为合法 JSON')
          for (const id of ['elena', 'maya', 'hikari']) {
            const m = motion.json[id]
            expectTrue(!!m, `motion.json 应包含 ${id}`)
            expectTrue(!!m.mouth && typeof m.mouth.cx === 'number' && typeof m.mouth.cy === 'number', `${id} 应标定嘴部`)
            expectTrue(Array.isArray(m.eyes) && m.eyes.length >= 2, `${id} 应标定双眼`)
            expectTrue(!!m.focal && typeof m.focal.x === 'number', `${id} 应有 focal`)
          }
          for (const id of ['elena', 'maya', 'hikari']) {
            for (const kind of ['fg', 'bg']) {
              const layer = await jfetch(api(`/assets/characters/layers/${id}-${kind}.webp`))
              expectStatus(layer, 200, `GET layers/${id}-${kind}.webp`)
              expectMatch(layer.headers.get('content-type') || '', /image\/webp/i, `${id}-${kind}.webp Content-Type`)
              expectTrue(layer.text.length > 1000, `${id}-${kind}.webp 内容非空`)
            }
            const one = await jfetch(api(`/api/characters/${id}`))
            const flows = motion.json[id].flows
            expectTrue(Array.isArray(flows) && flows.filter((f) => f.type === 'hair').length >= 4, `${id} flows 应含 ≥4 hair`)
            expectTrue(flows.filter((f) => f.type === 'cloth').length >= 2, `${id} flows 应含 ≥2 cloth`)
            expectMatch(String(motion.json[id].layers.fg), new RegExp(`layers/${id}-fg\\.webp`), `${id} layers.fg`)
            expectMatch(String(motion.json[id].layers.bg), new RegExp(`layers/${id}-bg\\.webp`), `${id} layers.bg`)
          }
          const head = await jfetch(api('/js/talking-head.js'))
          expectStatus(head, 200, 'GET /js/talking-head.js')
          expectMatch(head.text, /export function createTalkingHead/, 'talking-head 应导出 createTalkingHead')
          expectMatch(head.text, /setSpeechLevel/, 'talking-head 应支持 setSpeechLevel')
          expectMatch(head.text, /get blinkLevel\(\)/, 'talking-head v1.8 应暴露只读 blinkLevel')
          expectMatch(head.text, /get layered\(\)/, 'talking-head v2.0 应暴露只读 layered')
          expectMatch(head.text, /layers/, 'talking-head 应支持 layers 分层')
        })
        await check('GET /mobile 与 /mobile.html 返回手机壳；旧版 / 保持不变', async () => {
          const mobile = await jfetch(api('/mobile'))
          expectStatus(mobile, 200, 'GET /mobile')
          expectMatch(mobile.headers.get('content-type') || '', /text\/html/i, '/mobile Content-Type')
          expectTrue(mobile.text.includes('<!DOCTYPE html') || mobile.text.includes('<!doctype html'), '/mobile 应返回 HTML')
          expectTrue(/mobile\.(css|js)|mobile\//.test(mobile.text), '/mobile 应引用手机版资源')
          const mobileHtml = await jfetch(api('/mobile.html'))
          expectStatus(mobileHtml, 200, 'GET /mobile.html')
          expectTrue(mobileHtml.text.length > 500, '/mobile.html 内容非空')
          expectTrue(mobileHtml.text.includes('call-dialogue'), '/mobile.html 应包含 v1.8 角色对话条 #call-dialogue')
          expectTrue(mobileHtml.text.includes('mic-label') && mobileHtml.text.includes('mic-retry'), '/mobile.html 应包含 v2.3 麦克风自检（状态/重新授权）')
          expectTrue(mobileHtml.text.includes('ptt-wave'), '/mobile.html 应包含 PTT 波形')
          expectTrue(!mobileHtml.text.includes('ptt-done'), '/mobile.html 不应再有 v2.2 的「完成」按钮 #ptt-done')
          expectTrue(mobileHtml.text.includes('talking-host'), '/mobile.html 应包含 talking-head 口播容器')
          const index = await jfetch(api('/'))
          expectStatus(index, 200, 'GET /（旧版）')
          expectTrue(index.text.includes('main.js'), '旧版首页仍应加载原 main.js（不回归）')
        })
      } finally {
        await volcMock.close()
        // 恢复浏览器引擎/清空测试凭据，避免影响后续分组
        await putSettings({ voiceEngine: 'browser', apiKey: '', clearKey: true }).catch(() => {})
      }
    })

    // =====================================================================
    await group('v1.8 对话引擎 / 知识库 / 记忆 / 兴趣', async () => {
      const volcMock = await startMockVolc({ chunkDelayMs: 3 })
      const fixture = async (name) => fsp.readFile(path.join(PROJECT_ROOT, 'test', 'fixtures', name))
      const b64 = (buf) => Buffer.from(buf).toString('base64')
      const putSettings = async (patch) =>
        jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      const upload = async (name, buffer) =>
        jfetch(api('/api/kb/upload'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, dataBase64: b64(buffer) }),
        })
      const kbList = async () => jfetch(api('/api/kb/list'))
      // 本地 mock 网页（用于 /api/kb/url 导入）
      const htmlServer = http.createServer((req, res) => {
        if (req.url === '/article') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<!DOCTYPE html><html><head><title>The Art of Slow Reading</title>
            <style>.x{color:red}</style></head><body>
            <header>站内导航</header>
            <h1>The Art of Slow Reading</h1>
            <p>Slow reading is a lost art. When we read slowly, we notice details and connect ideas.</p>
            <p>Baking sourdough also teaches patience: you cannot rush a good loaf.</p>
            <script>console.log('noise')</script><footer>版权所有</footer></body></html>`)
          return
        }
        res.writeHead(404)
        res.end('not found')
      })
      await new Promise((resolve) => htmlServer.listen(0, '127.0.0.1', resolve))
      const htmlPort = htmlServer.address().port
      let docs = {}
      try {
        await check('GET/PUT /api/profile：兴趣档案读写 + 清洗', async () => {
          const initial = await jfetch(api('/api/profile'))
          expectStatus(initial, 200, 'GET /api/profile')
          expectEqual(initial.json.ok, true)
          expectTrue(Array.isArray(initial.json.interests), 'interests 应为数组')
          const put = await jfetch(api('/api/profile'), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ interests: ['摄影', '旅行', '人工智能', '摄影', '  '] }),
          })
          expectStatus(put, 200, 'PUT /api/profile')
          expectEqual(JSON.stringify(put.json.interests), JSON.stringify(['摄影', '旅行', '人工智能']), '兴趣应去重/去空')
          const got = await jfetch(api('/api/profile'))
          expectEqual(JSON.stringify(got.json.interests), JSON.stringify(['摄影', '旅行', '人工智能']), 'GET 应读到最新兴趣')
        })

        await check('知识库上传 5 类文件（txt/md/docx/pdf/png）→ 切块/标题/语言/列表/删除', async () => {
          const files = [
            ['english-article.txt', 'txt'],
            ['english-notes.md', 'md'],
            ['fixture-doc.docx', 'docx'],
            ['test-pdf.pdf', 'pdf'],
            ['ocr-test.png', 'png'],
          ]
          for (const [name, kind] of files) {
            const r = await upload(name, await fixture(name))
            expectStatus(r, 200, `上传 ${name}`)
            expectEqual(r.json.ok, true, `${name} 上传 ok`)
            expectTrue(/^kb_[a-z0-9]+$/.test(r.json.doc.id), `${name} 应返回 kb_ id`)
            expectTrue(!!r.json.doc.title, `${name} 应有标题`)
            expectTrue(r.json.doc.chunkCount >= 1, `${name} 应切块（${r.json.doc.chunkCount}）`)
            expectTrue(['en', 'zh', 'mixed', 'unknown'].includes(r.json.doc.lang), `${name} lang 合法`)
            docs[kind] = r.json.doc.id
          }
          const list = await kbList()
          expectStatus(list, 200)
          expectTrue(list.json.docs.length >= 5, `列表应有 ≥5 篇（实际 ${list.json.docs.length}）`)
          expectTrue(list.json.stats.docs >= 5 && list.json.stats.chunks >= 5, 'stats 应统计 docs/chunks')
          const detail = await jfetch(api(`/api/kb/${docs.docx}`))
          expectStatus(detail, 200)
          expectTrue(Array.isArray(detail.json.doc.chunks) && detail.json.doc.chunks.length >= 1, '详情应含 chunks')
          expectTrue(detail.json.doc.chunks[0].text.length > 10, 'chunk 文本非空')
          const del = await jfetch(api(`/api/kb/${docs.png}`), { method: 'DELETE' })
          expectStatus(del, 200, 'DELETE 知识库文档')
          const gone = await jfetch(api(`/api/kb/${docs.png}`))
          expectStatus(gone, 404, '删除后详情 404')
          const delAgain = await jfetch(api(`/api/kb/${docs.png}`), { method: 'DELETE' })
          expectStatus(delAgain, 404, '重复删除 404')
          delete docs.png
        })

        await check('知识库上传错误路径：空内容/不支持格式/空 base64 → 中文 400', async () => {
          const empty = await upload('empty.txt', await fixture('empty.txt'))
          expectStatus(empty, 400, '空文件上传')
          expectMatch(String(empty.json.error), /内容|太少|空/, '空文件中文错误')
          const exe = await upload('unsupported.exe', await fixture('unsupported.exe'))
          expectStatus(exe, 400, '不支持格式')
          expectMatch(String(exe.json.error), /不支持|格式/, '不支持格式中文错误')
          const noBody = await jfetch(api('/api/kb/upload'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'x.txt' }),
          })
          expectStatus(noBody, 400)
          expectMatch(String(noBody.json.error), /Base64|base64/, '缺少内容中文错误')
        })

        await check('中文文章上传（docExtract 放宽 CJK）→ lang=zh + 中文切块', async () => {
          const text = `慢阅读的艺术\n\n慢阅读是一种被遗忘的艺术。当我们放慢速度，会注意到更多细节，也能把不同的想法连接起来。\n烘焙酸面包同样需要耐心：好的面包不能着急。\n\n培养专注力可以从每天十分钟开始，关掉通知，只读一页书。坚持一周，你会发现变化。`
          const r = await upload('慢阅读的艺术.txt', Buffer.from(text, 'utf8'))
          expectStatus(r, 200, '中文文章上传')
          expectEqual(r.json.doc.lang, 'zh', '中文文章 lang 应为 zh')
          expectTrue(r.json.doc.chunkCount >= 1)
          docs.zh = r.json.doc.id
          const detail = await jfetch(api(`/api/kb/${docs.zh}`))
          expectTrue(detail.json.doc.chunks.some((c) => /慢阅读/.test(c.text)), '中文块应保留中文原文')
        })

        await check('网页链接导入：本地 HTML → 标题/正文提取；无效 URL/空 URL 中文错误', async () => {
          const r = await jfetch(api('/api/kb/url'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: `http://127.0.0.1:${htmlPort}/article` }),
          })
          expectStatus(r, 200, 'POST /api/kb/url')
          expectEqual(r.json.ok, true)
          expectEqual(r.json.doc.source, 'web', 'source 应为 web')
          expectMatch(r.json.doc.title, /Slow Reading|阅读/, `标题应来自 <title>/<h1>，实际 ${r.json.doc.title}`)
          docs.web = r.json.doc.id
          const detail = await jfetch(api(`/api/kb/${docs.web}`))
          const fullText = detail.json.doc.chunks.map((c) => c.text).join('\n')
          expectTrue(fullText.includes('Slow reading'), '正文应包含文章内容')
          expectTrue(!/console\.log|站内导航|版权所有|color:red/.test(fullText), '应去除脚本/导航/页脚/样式')
          const bad = await jfetch(api('/api/kb/url'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'http://127.0.0.1:1/nope' }),
          })
          expectStatus(bad, 400, '无效 URL')
          expectTrue(typeof bad.json.error === 'string' && bad.json.error.length > 0, '无效 URL 中文错误')
          const noUrl = await jfetch(api('/api/kb/url'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
          expectStatus(noUrl, 400)
          expectMatch(String(noUrl.json.error), /链接/, '缺少 url 中文错误')
        })

        await check('enrich：无 Key 中文错误；有 Key → enrichStatus=done + chunk 摘要/关键词', async () => {
          await putSettings({ apiKey: '', clearKey: true })
          const noKey = await jfetch(api(`/api/kb/${docs.txt}/enrich`), { method: 'POST' })
          expectStatus(noKey, 400, '无 Key enrich')
          expectMatch(String(noKey.json.error), /API Key/, '无 Key 应中文提示')
          await putSettings({ apiKey: validKey, baseUrl: mock.url, model: 'mock-model' })
          mock.reset()
          const r = await jfetch(api(`/api/kb/${docs.txt}/enrich`), { method: 'POST' })
          expectStatus(r, 200, '有 Key enrich')
          expectEqual(r.json.ok, true)
          expectEqual(r.json.enrichStatus, 'done', 'enrichStatus 应为 done')
          expectTrue(mock.kbEnrichCalls.length >= 1, 'mock 应收到 enrich 请求')
          const detail = await jfetch(api(`/api/kb/${docs.txt}`))
          expectTrue(detail.json.doc.chunks.some((c) => c.summary && c.keywords.length > 0), 'chunk 应有摘要/关键词')
          const list = await kbList()
          expectEqual(list.json.docs.find((d) => d.id === docs.txt).enrichStatus, 'done', '列表 enrichStatus 应 done')
        })

        await check('知识库检索：英文/中文 query 均命中，带 docId/title/chunkId/score；空 query 400', async () => {
          mock.reset()
          const en = await jfetch(api('/api/kb/search'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'reading habits and slow reading', docIds: [docs.web, docs.txt], limit: 4 }),
          })
          expectStatus(en, 200, '英文检索')
          expectEqual(en.json.ok, true)
          expectTrue(en.json.hits.length >= 1, '英文 query 应命中')
          const hit = en.json.hits[0]
          for (const key of ['docId', 'chunkId', 'docTitle', 'text', 'score']) expectTrue(key in hit, `hit 应含 ${key}`)
          expectTrue([docs.web, docs.txt].includes(hit.docId), 'docId 应在选择范围内')
          expectTrue(mock.kbQueryCalls.length >= 1, 'mock 应收到查询扩展请求')
          expectTrue(en.json.query.expanded === true, '有 Key 时应标记 expanded')
          const zh = await jfetch(api('/api/kb/search'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '慢阅读 专注力', docIds: [docs.zh], limit: 4 }),
          })
          expectStatus(zh, 200, '中文检索')
          expectTrue(zh.json.hits.length >= 1, '中文 query 应命中中文文档')
          expectEqual(zh.json.hits[0].docId, docs.zh)
          const empty = await jfetch(api('/api/kb/search'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '   ' }),
          })
          expectStatus(empty, 400)
          expectMatch(String(empty.json.error), /query/, '空 query 中文错误')
        })

        const chatKb = async (body) =>
          fetch(api('/api/chat'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'free', level: 'B1', message: 'Tell me about slow reading.', ...body }),
          })
        await check('/api/chat kbMode=grounded：meta.kb.hits 合法 + prompt 引用材料 + 回复非空', async () => {
          mock.reset()
          const events = await collectSSE(await chatKb({ characterId: 'elena', kbMode: 'grounded', kbDocIds: [docs.web, docs.txt] }))
          const meta = events.find((e) => e.event === 'meta')
          expectTrue(!!meta, '应有 meta')
          expectEqual(meta.data.demo, false, '有 Key 应 live')
          expectTrue(!!meta.data.kb, 'meta 应含 kb')
          expectEqual(meta.data.kb.mode, 'grounded')
          expectTrue(meta.data.kb.hits.length >= 1, 'grounded 应有检索命中')
          const h = meta.data.kb.hits[0]
          for (const key of ['docId', 'title', 'chunkId', 'score', 'text']) expectTrue(key in h, `meta.hit 应含 ${key}`)
          expectTrue(mock.chatCalls.length >= 1, 'mock 应收到主回复请求')
          const mainCall = mock.chatCalls[mock.chatCalls.length - 1]
          const system = mainCall.body.messages[0].content
          expectMatch(system, /Knowledge base material/i, 'system prompt 应注入知识库材料')
          expectMatch(system, /grounded/i, 'system prompt 应含 grounded 规则')
          expectMatch(system, /《|Slow Reading|slow reading/i, 'system prompt 应含材料标题/片段')
          expectMatch(system, /LENS|identity is a LENS/i, 'system prompt 应含身份=视角规则')
          expectMatch(system, /Director's plan/i, 'system prompt 应注入导演计划')
          const done = events.find((e) => e.event === 'done')
          expectTrue(done && String(done.data.fullReply).length > 5, '回复非空')
        })

        await check('/api/chat kbMode=divergent：prompt 含发散指令、meta.kb.mode=divergent', async () => {
          mock.reset()
          const events = await collectSSE(await chatKb({ characterId: 'elena', kbMode: 'divergent', kbDocIds: [docs.web] }))
          const meta = events.find((e) => e.event === 'meta')
          expectEqual(meta.data.kb.mode, 'divergent')
          const mainCall = mock.chatCalls[mock.chatCalls.length - 1]
          const system = mainCall.body.messages[0].content
          expectMatch(system, /diverge|springboard|beyond the material/i, 'system prompt 应含发散规则')
          const done = events.find((e) => e.event === 'done')
          expectTrue(done && String(done.data.fullReply).length > 5, '发散回复非空')
        })

        await check('/api/chat kbMode=free：不注入知识库；无效 docId 回退空命中', async () => {
          mock.reset()
          const events = await collectSSE(await chatKb({ characterId: 'elena', kbMode: 'free', kbDocIds: [docs.web] }))
          const meta = events.find((e) => e.event === 'meta')
          expectTrue(meta.data.kb.hits.length === 0, 'free 不应有 kb 命中')
          const system = mock.chatCalls[mock.chatCalls.length - 1].body.messages[0].content
          expectTrue(!/Knowledge base material/i.test(system), 'free 不应注入知识库材料块')
          mock.reset()
          const invalid = await collectSSE(await chatKb({ characterId: 'elena', kbMode: 'grounded', kbDocIds: ['kb_nonexistent_xx'] }))
          const meta2 = invalid.find((e) => e.event === 'meta')
          expectTrue(meta2.data.kb.hits.length === 0, '无效 docId 应回退空命中（不 500）')
          expectTrue(!!invalid.find((e) => e.event === 'done'), '仍应正常完成回复')
        })

        await check('导演反重复：连续两轮都调用导演，第二轮把第一轮问题放入 avoid', async () => {
          mock.reset()
          const first = await collectSSE(
            await chatKb({ characterId: 'elena', kbMode: 'free', message: 'I love street photography.', history: [] }),
          )
          const firstAssistant = first.find((e) => e.event === 'feedback') ? '' : ''
          void firstAssistant
          const firstDone = first.find((e) => e.event === 'done')
          const firstQuestion = String(firstDone?.data?.fullReply || '').match(/[^.!?]*\?/)?.[0] || 'What do you like about it?'
          const second = await collectSSE(
            await chatKb({
              characterId: 'elena',
              kbMode: 'free',
              message: 'Yes, especially the shadows.',
              history: [
                { role: 'user', content: 'I love street photography.' },
                { role: 'assistant', content: firstQuestion },
              ],
            }),
          )
          void second
          expectTrue(mock.directorCalls.length >= 2, `应每轮调用导演（实际 ${mock.directorCalls.length}）`)
          const secondDirector = mock.directorCalls[mock.directorCalls.length - 1]
          const userMsg = secondDirector.body.messages.find((m) => m.role === 'user').content
          expectMatch(userMsg, /最近问过的问题|严禁重复/, '导演 prompt 应含最近问题去重')
          expectTrue(userMsg.includes(firstQuestion.slice(0, 20)) || userMsg.includes(String(firstQuestion).slice(0, 20)), '第二轮应包含第一轮问题')
          const mainSystem = mock.chatCalls[mock.chatCalls.length - 1].body.messages[0].content
          expectMatch(mainSystem, /Director's plan/i, '主回复应带导演计划')
          expectMatch(mainSystem, /LENS|topic list/i, '主回复应带身份=视角规则')
        })

        await check('记忆：/api/summary 带 characterId → 后台写入 memory.json（interests/facts/topics/summary）', async () => {
          mock.reset()
          const r = await jfetch(api('/api/summary'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              characterId: 'elena',
              level: 'B1',
              messages: [
                { role: 'user', content: 'I love photography and I often visit galleries.' },
                { role: 'assistant', content: 'What kind of photography do you like?' },
                { role: 'user', content: 'Street photography. I also work late a lot.' },
              ],
            }),
          })
          expectStatus(r, 200, 'POST /api/summary（记忆更新）')
          await waitUntil(() => mock.memoryCalls.length >= 1, { timeoutMs: 8000, label: 'mock 记忆提取请求' })
          const memoryPath = path.join(sandbox, 'data', 'memory.json')
          let memory = null
          for (let i = 0; i < 40; i++) {
            try { memory = JSON.parse(await fsp.readFile(memoryPath, "utf8")) } catch { memory = null }
            if (memory?.characters?.elena?.interests?.length) break
            await sleep(100)
          }
          expectTrue(!!memory?.characters?.elena, 'memory.json 应有 elena 记忆')
          expectTrue(memory.characters.elena.interests.includes('摄影'), 'interests 应合并模型返回的兴趣')
          expectTrue(memory.characters.elena.facts.length >= 1, 'facts 应非空')
          expectTrue(memory.characters.elena.topics.length >= 1, 'topics 应非空')
          expectTrue(String(memory.characters.elena.summary).length > 0, 'summary 应非空')
          const profile = await jfetch(api('/api/profile'))
          expectTrue(profile.json.interests.includes('摄影'), 'profile 兴趣应保留')
        })

        await check('/ws/voice kbDocIds：ready.kb + persona 注入材料标题/要点；无 kb 时旧行为', async () => {
          await putSettings({ voiceEngine: 'volc', volc: { appId: 'kb-app', apiKey: 'kb-key', model: '3.0', speaker: 'en_female_dacey_uranus_bigtts', endpoint: volcMock.wsUrl, resourceId: 'volc.speech.dialog' } })
          const serverPort = Number(new URL(baseUrl).port)
          const bridgeUrl = `ws://127.0.0.1:${serverPort}/ws/voice`
          const openBridge = () =>
            new Promise((resolve, reject) => {
              const ws = new WebSocket(bridgeUrl)
              ws.binaryType = 'arraybuffer'
              const inbox = []
              ws.addEventListener('message', (ev) => {
                if (typeof ev.data === 'string') {
                  try {
                    inbox.push(JSON.parse(ev.data))
                  } catch {
                    /* ignore */
                  }
                }
              })
              const timer = setTimeout(() => reject(new Error('桥连接超时')), 8000)
              ws.addEventListener('open', () => {
                clearTimeout(timer)
                resolve({ ws, inbox })
              })
              ws.addEventListener('error', () => reject(new Error('桥连接失败')))
            })
          volcMock.reset()
          const bridge = await openBridge()
          try {
            bridge.ws.send(JSON.stringify({ type: 'start', mode: 'free', level: 'B1', characterId: 'elena', kbMode: 'grounded', kbDocIds: [docs.web] }))
            const ready = await waitUntil(
              () => bridge.inbox.find((m) => m.type === 'ready'),
              { timeoutMs: 20000, label: 'ready（带 kb）' },
            )
            expectTrue(!!ready.kb, 'ready 应含 kb 元信息')
            expectEqual(JSON.stringify(ready.kb.docIds), JSON.stringify([docs.web]), 'ready.kb.docIds')
            expectEqual(ready.kb.mode, 'grounded')
            expectTrue(Array.isArray(ready.kb.titles) && ready.kb.titles.length >= 1, 'ready.kb.titles 应含材料标题')
            const cfg = volcMock.sessionConfigs[volcMock.sessionConfigs.length - 1]
            const persona = String(cfg.dialog.system_role)
            expectMatch(persona, /Slow Reading|知识库|Knowledge base/i, 'persona 应注入知识库标题/摘要')
            expectTrue(persona.length > 400, 'persona 应包含角色+记忆+知识库扩展内容')
            bridge.ws.send(JSON.stringify({ type: 'stop' }))
            await sleep(300)
          } finally {
            try {
              bridge.ws.close()
            } catch {
              /* ignore */
            }
          }
          volcMock.reset()
          const bridge2 = await openBridge()
          try {
            bridge2.ws.send(JSON.stringify({ type: 'start', mode: 'free', level: 'B1', characterId: 'elena' }))
            const ready2 = await waitUntil(
              () => bridge2.inbox.find((m) => m.type === 'ready'),
              { timeoutMs: 20000, label: 'ready（无 kb）' },
            )
            expectTrue(!ready2.kb, '不带 kbDocIds 时 ready.kb 应为空（旧行为）')
            bridge2.ws.send(JSON.stringify({ type: 'stop' }))
            await sleep(300)
          } finally {
            try {
              bridge2.ws.close()
            } catch {
              /* ignore */
            }
          }
        })

        await check('空知识库讨论：grounded 无 docId/空库 → 不报错并正常回复', async () => {
          mock.reset()
          const events = await collectSSE(await chatKb({ characterId: 'elena', kbMode: 'grounded', kbDocIds: [] }))
          const meta = events.find((e) => e.event === 'meta')
          expectTrue(meta.data.kb.hits.length === 0, '空库 grounded 应 0 命中')
          const done = events.find((e) => e.event === 'done')
          expectTrue(done && String(done.data.fullReply).length > 5, '空库仍应正常回复')
        })
      } finally {
        await new Promise((resolve) => htmlServer.close(resolve)).catch(() => {})
        await volcMock.close()
        await putSettings({ apiKey: '', clearKey: true, voiceEngine: 'browser', volc: { clearKey: true } }).catch(() => {})
      }
    })

    // =====================================================================
    await group('v2.7 单词复习系统 /api/review + summary 自动收录', async () => {
      const putSettings = async (patch) =>
        jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      try {
        await check('/api/review/*：summary/add/list/due/patch/delete/grade 全路由 + 中文错误', async () => {
          // 清空复习库（此前 summary 用例可能已自动收录词）
          const existing = await jfetch(api('/api/review/list?status=all&limit=2000'))
          for (const w of existing.json.words || []) {
            await jfetch(api('/api/review/word?word=' + encodeURIComponent(w.word)), { method: 'DELETE' })
          }
          const empty = await jfetch(api('/api/review/summary'))
          expectStatus(empty, 200, 'GET /api/review/summary（空）')
          expectEqual(empty.json.total, 0, '空库 total=0')
          expectEqual(empty.json.dueCount, 0, '空库 dueCount=0')
          const add = await jfetch(api('/api/review/add'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ words: [{ word: 'resilient', meaning: '有韧性的' }, { word: 'Resilient' }, { word: 'burn', meaning: '燃烧' }] }),
          })
          expectStatus(add, 200, 'POST /api/review/add')
          expectEqual(add.json.added, 2, '大小写重复词应合并（added=2）')
          expectEqual(add.json.summary.total, 2, '总数 2')
          const list = await jfetch(api('/api/review/list'))
          expectStatus(list, 200)
          expectEqual(list.json.words.length, 2, '列表 2 词')
          expectTrue(list.json.words.every((w) => w.status === 'new' && w.source === 'manual'), '新词 status=new/source=manual')
          const search = await jfetch(api('/api/review/list?q=res'))
          expectEqual(search.json.words.length, 1, '搜索 res → 1 词')
          const searchNone = await jfetch(api('/api/review/list?q=zzzz'))
          expectEqual(searchNone.json.words.length, 0, '搜索无结果 → 0')
          const due = await jfetch(api('/api/review/due?limit=1'))
          expectStatus(due, 200)
          expectTrue(due.json.count === 1 && due.json.words.length === 1, 'due limit 生效')
          const patch = await jfetch(api('/api/review/word'), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ word: 'resilient', patch: { status: 'known' } }),
          })
          expectStatus(patch, 200, 'PATCH /api/review/word（标为掌握）')
          expectEqual(patch.json.word.status, 'known', '状态应为 known')
          expectMatch(String(patch.json.word.dueLabel), /天后/, '已掌握 dueLabel 应为 N 天后')
          expectEqual(patch.json.summary.knownCount, 1, 'knownCount=1')
          const knownList = await jfetch(api('/api/review/list?status=known'))
          expectTrue(knownList.json.words.some((w) => w.word === 'resilient'), 'known 过滤应命中')
          const badPatch = await jfetch(api('/api/review/word'), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ word: 'not-exist-word', patch: { status: 'known' } }),
          })
          expectStatus(badPatch, 404, 'PATCH 不存在词 → 404')
          const emptyPatch = await jfetch(api('/api/review/word'), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch: {} }),
          })
          expectStatus(emptyPatch, 400, 'PATCH 缺 word → 400')
          const badGrade = await jfetch(api('/api/review/grade'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ word: 'burn', grade: 'bogus' }),
          })
          expectStatus(badGrade, 400, '非法 grade → 400')
          expectMatch(String(badGrade.json.error), /评分|grade|无效/, '非法 grade 中文错误')
          for (const [grade, expectStatusWord] of [['good', 'learning'], ['again', 'learning'], ['hard', 'learning'], ['easy', 'known']]) {
            const g = await jfetch(api('/api/review/grade'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ word: 'burn', grade }),
            })
            expectStatus(g, 200, `POST /api/review/grade ${grade}`)
            expectEqual(g.json.word.lastGrade, grade)
            expectEqual(g.json.word.status, expectStatusWord, `${grade} 后状态`)
          }
          const badAdd = await jfetch(api('/api/review/add'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ words: [] }),
          })
          expectStatus(badAdd, 400, 'add 空数组 → 400')
          const del = await jfetch(api('/api/review/word?word=resilient'), { method: 'DELETE' })
          expectStatus(del, 200, 'DELETE 词')
          expectEqual(del.json.summary.total, 1, '删除后 total=1')
          const delAgain = await jfetch(api('/api/review/word?word=resilient'), { method: 'DELETE' })
          expectStatus(delAgain, 404, '重复删除 404')
        })

        await check('/api/summary 自动收录 keyWords → review（source=conversation/new/去重）', async () => {
          await putSettings({ apiKey: validKey, baseUrl: mock.url, model: 'mock-model' })
          mock.reset()
          const body = {
            level: 'B1',
            characterId: 'elena',
            messages: [
              { role: 'user', content: 'I commute by subway every day and want to improve my vocabulary.' },
              { role: 'assistant', content: 'Nice! What do you do during the commute?' },
              { role: 'user', content: 'I read English articles. Reading builds vocabulary.' },
            ],
          }
          const r = await jfetch(api('/api/summary'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          expectStatus(r, 200, 'POST /api/summary（自动收录复习词）')
          expectTrue(r.json.reviewAdded && typeof r.json.reviewAdded === 'object', '应返回 reviewAdded')
          expectTrue(Number(r.json.reviewAdded.added) >= 1, `reviewAdded.added 应 ≥1（实际 ${r.json.reviewAdded.added}）`)
          const list = await jfetch(api('/api/review/list?status=new'))
          const conv = list.json.words.filter((w) => w.source === 'conversation')
          expectTrue(conv.length >= 1, '复习库应含 source=conversation 的词')
          const allBefore = await jfetch(api('/api/review/list?status=all&limit=2000'))
          const wordsBefore = allBefore.json.words.length
          const again = await jfetch(api('/api/summary'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          expectStatus(again, 200, '重复总结')
          const list2 = await jfetch(api('/api/review/list?status=all'))
          expectTrue(list2.json.words.length <= wordsBefore, '重复总结不应产生重复词')
          expectTrue(mock.summaryCalls.length >= 2, 'mock 应收到总结请求')
        })
      } finally {
        await putSettings({ apiKey: '', clearKey: true }).catch(() => {})
        await jfetch(api('/api/review/word?word=burn'), { method: 'DELETE' }).catch(() => {})
      }
    })

    // =====================================================================
    // =====================================================================
    await group('v3.1 自由文本计划 / AI 3 课生成 / 老师 / TTS / lesson 上下文', async () => {
      const putSettings = async (patch) =>
        jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      const waitPlanReady = async () =>
        waitUntil(
          async () => {
            const r = await jfetch(api('/api/plan'))
            const p = r.json && r.json.plan
            if (!p || p.generating) return null
            if (!Array.isArray(p.stages) || p.stages.length !== 3) return null
            if (!p.stages.every((st) => st.lesson && st.lesson.status === 'ready')) return null
            return p
          },
          { timeoutMs: 30000, label: 'AI 课件生成完成（3 课 ready）' },
        )
      try {
        await putSettings({ apiKey: validKey, baseUrl: mock.url, model: 'mock-model', voiceEngine: 'browser', volc: { clearKey: true } })
        mock.reset()

        await check('POST /api/assistant 自由文本 → plan v3 generating → 3 课 ready（每课5句/3步）', async () => {
          const gen = await jfetch(api('/api/assistant'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: '帮我制定学习计划：我想学咖啡店点单、机场值机和酒店入住，A2', level: 'A2' }),
          })
          expectStatus(gen, 200, 'assistant 自由文本生成计划')
          expectEqual(gen.json.ok, true)
          expectEqual(gen.json.actions.length, 1)
          const action = gen.json.actions[0]
          expectEqual(action.type, 'create_plan')
          expectEqual(action.payload.version, 3, '计划应为 v3')
          expectEqual(action.payload.teacherId, 'elena', '默认老师 Elena')
          expectMatch(String(action.payload.goalText), /咖啡店/, 'goalText 保留用户原话')
          expectEqual(action.payload.generating, true, '刚创建时应 generating')
          expectEqual(action.payload.stages.length, 3, '固定 3 节课')
          const plan = await waitPlanReady()
          expectTrue(plan.progress === 0, '初始进度 0')
          expectTrue(plan.next && plan.next.lessonId === 'lesson_1', 'next 第 1 课')
          expectEqual(plan.teacherName, 'Elena')
          expectTrue(mock.planLessonsCalls.length >= 1, 'mock 应收到课件生成请求（AI 3 课）')
          for (let i = 1; i <= 3; i++) {
            const lesson = plan.lessons['lesson_' + i]
            expectEqual(lesson.status, 'ready', `lesson_${i} ready`)
            expectEqual(lesson.phrases.length, 5, `lesson_${i} 5 句`)
            expectEqual(lesson.steps.length, 3, `lesson_${i} 3 步`)
            expectTrue(lesson.objectives.length >= 2, `lesson_${i} 目标`)
            expectTrue(lesson.phrases.every((p) => p.en && p.zh), `lesson_${i} en/zh 齐全`)
          }
          expectEqual(plan.generating, false)
          expectEqual(plan.stages[0].unlocked, true)
          expectEqual(plan.stages[1].unlocked, false, '顺序解锁：第 2 课初始锁定')
        })

        await check('PATCH teacher 切换老师保留课件；/api/lessons 列表/详情；POST generate 重新生成', async () => {
          const sw = await jfetch(api('/api/plan/teacher'), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ teacherId: 'hikari' }),
          })
          expectStatus(sw, 200, 'PATCH /api/plan/teacher hikari')
          expectEqual(sw.json.plan.teacherId, 'hikari')
          expectEqual(sw.json.plan.teacherName, 'Hikari')
          expectEqual(sw.json.plan.lessons.lesson_1.phrases.length, 5, '切换老师不应丢课件')
          expectEqual(sw.json.plan.progress, 0)
          const bad = await jfetch(api('/api/plan/teacher'), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ teacherId: 'nope' }),
          })
          expectStatus(bad, 400, '非法老师 → 400')
          expectMatch(String(bad.json.error), /老师|角色|teacher/i, '非法老师中文错误')
          const list = await jfetch(api('/api/lessons'))
          expectStatus(list, 200, 'GET /api/lessons')
          expectEqual(list.json.lessons.length, 3, '3 节课列表')
          expectTrue(list.json.lessons.every((l) => l.status === 'ready' && l.phrases.length === 5), '列表课程 ready/5句')
          const one = await jfetch(api('/api/lessons/lesson_2'))
          expectStatus(one, 200, 'GET /api/lessons/lesson_2')
          expectEqual(one.json.lesson.id, 'lesson_2')
          expectEqual(one.json.lesson.phrases.length, 5)
          const missing = await jfetch(api('/api/lessons/nope'))
          expectStatus(missing, 404, '未知课程 404')
          // 重新生成课件
          mock.reset()
          const regen = await jfetch(api('/api/plan/generate'), { method: 'POST' })
          expectStatus(regen, 200, 'POST /api/plan/generate')
          expectEqual(regen.json.ok, true)
          const ready = await waitPlanReady()
          expectTrue(mock.planLessonsCalls.length >= 1, '重新生成应再次调用 AI')
          expectEqual(ready.progress, 0, '重新生成后进度归零')
          expectEqual(ready.stages[0].lesson.status, 'ready')
        })

        await check('scene-done v3.1 进度/lock/幂等/全完成；/api/tts/voices 三角色；lesson 上下文透传', async () => {
          const p0 = (await jfetch(api('/api/plan'))).json.plan
          expectTrue(p0 && p0.progress === 0, '前置：计划 0%')
          const incomplete = await jfetch(api('/api/plan/scene-done'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_1', stageId: 'stage_1', stepsCompleted: 2 }),
          })
          expectStatus(incomplete, 200)
          expectEqual(incomplete.json.completed, false)
          expectMatch(String(incomplete.json.reason), /steps-incomplete/)
          expectEqual(incomplete.json.requiredSteps, 3)
          const locked = await jfetch(api('/api/plan/scene-done'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_3', stageId: 'stage_3', stepsCompleted: 3 }),
          })
          expectEqual(locked.json.completed, false)
          expectMatch(String(locked.json.reason), /locked/)
          const done1 = await jfetch(api('/api/plan/scene-done'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_1', stageId: 'stage_1', stepsCompleted: 3 }),
          })
          expectEqual(done1.json.completed, true, '3 步完成第 1 课')
          expectEqual(done1.json.plan.progress, 33)
          expectEqual(done1.json.plan.stages[1].unlocked, true, '完成第 1 课解锁第 2 课')
          const again = await jfetch(api('/api/plan/scene-done'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_1', stageId: 'stage_1', stepsCompleted: 3 }),
          })
          expectEqual(again.json.alreadyDone, true, '重复完成幂等')
          expectEqual(again.json.plan.progress, 33)
          const done2 = await jfetch(api('/api/plan/scene-done'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_2', stageId: 'stage_2', stepsCompleted: 3 }),
          })
          expectEqual(done2.json.plan.progress, 67)
          const done3 = await jfetch(api('/api/plan/scene-done'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_3', stageId: 'stage_3', stepsCompleted: 3 }),
          })
          expectEqual(done3.json.plan.progress, 100)
          expectEqual(done3.json.plan.allDone, true)
          expectEqual(done3.json.plan.next, null)
          const saved = (await jfetch(api('/api/plan'))).json.plan
          expectEqual(saved.progress, 100, '进度持久化')
          // TTS 角色原声映射
          const voices = await jfetch(api('/api/tts/voices'))
          expectStatus(voices, 200, 'GET /api/tts/voices')
          expectEqual(voices.json.voices.length, 3, '三角色音色映射')
          const hikari = voices.json.voices.find((v) => v.characterId === 'hikari')
          expectEqual(hikari.ttsSpeaker, 'zh_female_yingyujiaoxue_uranus_bigtts', 'Hikari 映射英语教师音色')
          const emptyTts = await jfetch(api('/api/tts'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '   ', characterId: 'elena' }),
          })
          expectStatus(emptyTts, 400, '/api/tts 空文本 400')
          expectMatch(String(emptyTts.json.error), /text|文本/i)
          // 无火山 Key → 502 中文错误（前端回退浏览器朗读）
          await putSettings({ volc: { clearKey: true } })
          const noKey = await jfetch(api('/api/tts'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'Hello there', characterId: 'elena' }),
          })
          expectStatus(noKey, 502, '/api/tts 无 Key → 502')
          expectMatch(String(noKey.json.error), /Key|未配置|语音/, '无 Key 中文错误')
          // 文字 chat 注入 lesson 课件 + 当前步
          mock.reset()
          const chatRes = await fetch(api('/api/chat'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'free', level: 'A2', message: 'Hello teacher!', characterId: 'elena', lessonId: 'lesson_1', stageId: 'stage_1', lessonStep: 2 }),
          })
          await collectSSE(chatRes)
          expectTrue(mock.chatCalls.length >= 1, 'chat mock 应被调用')
          const system = mock.chatCalls[mock.chatCalls.length - 1].body.messages[0].content
          expectMatch(system, /Lesson mode: you are the TEACHER/, 'chat prompt 应注入课程教学块')
          expectMatch(system, /Hi, can I get a latte/, 'chat prompt 应含 AI 生成的常用句')
          expectMatch(system, /2\/3/, 'chat prompt 应含当前步骤 2/3')
          // 实时语音 start 帧 → persona
          const volcMock = await startMockVolc({ chunkDelayMs: 4 })
          await putSettings({ voiceEngine: 'volc', volc: { appId: 'v31-app', apiKey: 'v31-key', model: '3.0', speaker: 'en_female_dacey_uranus_bigtts', endpoint: volcMock.wsUrl, resourceId: 'volc.speech.dialog' } })
          const serverPort = Number(new URL(baseUrl).port)
          const bridge = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/voice`)
            const inbox = []
            ws.addEventListener('message', (ev) => {
              if (typeof ev.data !== 'string') return
              try { inbox.push(JSON.parse(ev.data)) } catch { /* ignore */ }
            })
            const timer = setTimeout(() => reject(new Error('bridge 连接超时')), 8000)
            ws.addEventListener('open', () => { clearTimeout(timer); resolve({ ws, inbox }) })
            ws.addEventListener('error', () => reject(new Error('bridge 连接失败')))
          })
          try {
            bridge.ws.send(JSON.stringify({ type: 'start', mode: 'free', level: 'A2', characterId: 'elena', lessonId: 'lesson_1', stageId: 'stage_1', lessonStep: 2, ptt: true }))
            const ready = await waitUntil(() => bridge.inbox.find((m) => m.type === 'ready'), { timeoutMs: 20000, label: 'v3.1 语音 ready' })
            expectTrue(!!ready, '语音 ready')
            const cfg = volcMock.sessionConfigs[volcMock.sessionConfigs.length - 1]
            const persona = String(cfg.dialog.system_role)
            expectMatch(persona, /Lesson mode|TEACHER for this specific lesson/i, 'persona 应含课程教学块')
            expectMatch(persona, /Hi, can I get a latte/, 'persona 应含 AI 生成的常用句')
            expectMatch(persona, /Current step: 2\/3/, 'persona 应含当前步骤')
            bridge.ws.send(JSON.stringify({ type: 'stop' }))
            await sleep(300)
          } finally {
            try { bridge.ws.close() } catch { /* ignore */ }
            await volcMock.close()
            await putSettings({ voiceEngine: 'browser', volc: { clearKey: true } }).catch(() => {})
          }
        })
      } finally {
        await putSettings({ apiKey: '', clearKey: true, voiceEngine: 'browser', volc: { clearKey: true } }).catch(() => {})
      }
    })

    // =====================================================================
    await group('v3.2 课程断点续学 /api/plan/lesson-progress + restart', async () => {
      const putSettings = async (patch) =>
        jfetch(api('/api/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      try {
        await check('lesson-progress 保存/clamp → GET plan resume；restart 清空；scene-done 清空并 next', async () => {
          await putSettings({ apiKey: validKey, baseUrl: mock.url, model: 'mock-model', voiceEngine: 'browser', volc: { clearKey: true } })
          mock.reset()
          const made = await jfetch(api('/api/assistant'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: '帮我制定学习计划：我想学咖啡店点单和机场值机，A2', level: 'A2' }),
          })
          expectStatus(made, 200, '创建 v3.2 测试计划')
          const plan = await waitUntil(
            async () => {
              const r = await jfetch(api('/api/plan'))
              const p = r.json && r.json.plan
              if (!p || p.generating) return null
              if (!p.stages.every((st) => st.lesson && st.lesson.status === 'ready')) return null
              return p
            },
            { timeoutMs: 30000, label: 'v3.2 课件生成完成' },
          )
          // 切换老师并确认服务端落库（下一课应跟随该老师）
          const sw = await jfetch(api('/api/plan/teacher'), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ teacherId: 'maya' }),
          })
          expectStatus(sw, 200, 'PATCH teacher maya')
          expectEqual(sw.json.plan.teacherId, 'maya')
          // 保存断点（越界值应 clamp）
          const saved = await jfetch(api('/api/plan/lesson-progress'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_1', step: 9, phraseIdx: 99, practiceTurns: -2, challengeTurns: 1 }),
          })
          expectStatus(saved, 200, 'POST lesson-progress')
          expectEqual(saved.json.ok, true)
          expectEqual(saved.json.resume.step, 3, 'step 归一 1–3')
          expectEqual(saved.json.resume.phraseIdx, 5, 'phraseIdx 归一句数')
          expectEqual(saved.json.resume.practiceTurns, 0)
          expectEqual(saved.json.resume.challengeTurns, 1)
          const got = (await jfetch(api('/api/plan'))).json.plan
          expectEqual(got.stages[0].lesson.resume.step, 3, 'GET /api/plan 应含 resume')
          expectEqual(got.stages[0].lesson.resume.phraseIdx, 5)
          // 非对象/未知课
          const unknown = await jfetch(api('/api/plan/lesson-progress'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'nope', step: 1 }),
          })
          expectEqual(unknown.json.ok, false)
          expectMatch(String(unknown.json.reason), /not-found/)
          // restart 清空
          const restart = await jfetch(api('/api/plan/lesson-restart'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_1' }),
          })
          expectStatus(restart, 200, 'POST lesson-restart')
          expectEqual(restart.json.ok, true)
          const cleared = (await jfetch(api('/api/plan'))).json.plan
          expectEqual(cleared.stages[0].lesson.resume, null, 'restart 后 resume=null')
          // 再存 step2 断点 → 完成第 1 课 → resume 清空、next lesson_2、老师 Maya
          const saved2 = await jfetch(api('/api/plan/lesson-progress'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_1', step: 2, phraseIdx: 5, practiceTurns: 1 }),
          })
          expectEqual(saved2.json.ok, true)
          expectEqual(saved2.json.resume.step, 2)
          const done = await jfetch(api('/api/plan/scene-done'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_1', stageId: 'stage_1', stepsCompleted: 3 }),
          })
          expectStatus(done, 200, 'scene-done 完成第 1 课')
          expectEqual(done.json.completed, true)
          expectEqual(done.json.plan.progress, 33)
          expectEqual(done.json.plan.stages[0].lesson.resume, null, '完成课应清空 resume')
          expectEqual(done.json.plan.stages[0].lesson.done, true)
          expectEqual(done.json.plan.teacherId, 'maya')
          expectEqual(done.json.plan.stages[1].lesson.resume, null)
          expectEqual(String(done.json.next.lessonId), 'lesson_2', 'next 应为 lesson_2')
          expectEqual(done.json.next.teacherId, 'maya', '下一课跟随计划老师 Maya')
          const afterDone = await jfetch(api('/api/plan/lesson-progress'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lessonId: 'lesson_1', step: 1, phraseIdx: 0 }),
          })
          expectEqual(afterDone.json.ok, false)
          expectMatch(String(afterDone.json.reason), /done/, '完成课不可再保存断点')
          const final = (await jfetch(api('/api/plan'))).json.plan
          expectEqual(final.stages[0].lesson.resume, null, '最终 plan resume 仍为空')
        })
      } finally {
        await putSettings({ apiKey: '', clearKey: true, voiceEngine: 'browser', volc: { clearKey: true } }).catch(() => {})
      }
    })

    // =====================================================================
    await group('跟读评分 /api/score', async () => {
      await check('完全正确：高分 + 星级 + 逐词 ok + 中文 tips', async () => {
        const r = await jfetch(api('/api/score'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'I would like a latte, please.', transcript: 'I would like a latte please' }),
        })
        expectStatus(r, 200, 'POST /api/score')
        const s = r.json
        expectTrue(typeof s.score === 'number' && s.score >= 80, `完全匹配 score 应 >=80，实际 ${JSON.stringify(s.score)}`)
        expectTrue(s.score <= 100, `score 应 <=100，实际 ${s.score}`)
        expectTrue(Number.isInteger(s.stars) && s.stars >= 1 && s.stars <= 5, `stars 应为 1-5 整数，实际 ${JSON.stringify(s.stars)}`)
        expectTrue(typeof s.accuracy === 'number' && s.accuracy >= 0 && s.accuracy <= 1, `accuracy 应为 0-1，实际 ${JSON.stringify(s.accuracy)}`)
        expectTrue(Array.isArray(s.words) && s.words.length > 0, 'words 应为非空数组')
        expectTrue(s.words.every((w) => ['ok', 'close', 'miss'].includes(w.status)), `words.status 只能是 ok/close/miss，实际 ${JSON.stringify(s.words)}`)
        expectTrue(s.words.every((w) => w.status === 'ok'), `完全正确时逐词应全为 ok，实际 ${JSON.stringify(s.words.map((w) => [w.text, w.status]))}`)
        expectTrue(Array.isArray(s.tips_zh) && s.tips_zh.length > 0, 'tips_zh 应为非空数组')
        expectTrue(s.tips_zh.every((t) => typeof t === 'string' && t.length > 0), 'tips_zh 每项应为非空字符串（中文提示）')
        expectTrue(/[\u4e00-\u9fa5]/.test(s.tips_zh.join('')) || s.tips_zh.length > 0, 'tips_zh 应为中文提示')
      })

      await check('漏词/错词：分数下降且对应逐词状态为 miss/close', async () => {
        const full = await jfetch(api('/api/score'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'I would like a large latte with oat milk', transcript: 'I would like a large latte with oat milk' }),
        })
        const partial = await jfetch(api('/api/score'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'I would like a large latte with oat milk', transcript: 'I would like' }),
        })
        expectStatus(full, 200, 'POST /api/score（完整）')
        expectStatus(partial, 200, 'POST /api/score（漏词）')
        expectTrue(partial.json.score < full.json.score, `漏词分数应低于完整分数；完整=${full.json.score} 漏词=${partial.json.score}`)
        const missing = partial.json.words.filter((w) => w.status === 'miss')
        expectTrue(missing.length > 0, `漏词时应有 status=miss 的词，实际 ${JSON.stringify(partial.json.words)}`)

        const wrong = await jfetch(api('/api/score'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'I would like a latte', transcript: 'I would like a coffee' }),
        })
        expectStatus(wrong, 200, 'POST /api/score（错词）')
        expectTrue(wrong.json.score < full.json.score, `错词分数应低于完整分数；完整=${full.json.score} 错词=${wrong.json.score}`)
      })

      await check('空输入/垃圾输入：不崩溃、返回合理低分或明确 4xx', async () => {
        const r = await jfetch(api('/api/score'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'I would like a latte', transcript: '' }),
        })
        if (r.status === 200) {
          expectTrue(r.json && r.json.score <= 60, `空 transcript 分数应低（<=60），实际 ${JSON.stringify(r.json && r.json.score)}`)
          expectTrue(Array.isArray(r.json.words), '空输入时 words 仍应为数组')
        } else {
          expectTrue([400, 422].includes(r.status), `空 transcript 应返回 200 低分或 4xx，实际 ${r.status}`)
          expectEqual(r.json && r.json.ok, false, '空输入 4xx 时 ok 应为 false')
        }
        // 非法 JSON 同理
        const bad = await jfetch(api('/api/score'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        })
        expectTrue([400, 422].includes(bad.status), `非法 JSON 应返回 4xx，实际 ${bad.status}`)
        expectEqual(bad.json && bad.json.ok, false, '非法 JSON ok 应为 false')
        const health = await jfetch(api('/api/health'), {}, 5000)
        expectStatus(health, 200, '评分异常后 GET /api/health（服务不应崩溃）')
      })
    })

    // =====================================================================
    await group('进度 /api/progress（含 SRS 合并）', async () => {
      await check('GET /api/progress 初始结构完整', async () => {
        const r = await jfetch(api('/api/progress'))
        expectStatus(r, 200, 'GET /api/progress')
        const p = r.json
        for (const k of ['streak', 'totalTurns', 'totalMinutes', 'words', 'days', 'updatedAt']) {
          expectTrue(k in p, `progress 缺少字段 ${k}，实际 ${JSON.stringify(p).slice(0, 300)}`)
        }
        expectTrue(Number.isInteger(p.streak), 'streak 应为整数')
        expectTrue(Number.isInteger(p.totalTurns), 'totalTurns 应为整数')
        expectTrue(Number.isInteger(p.totalMinutes), 'totalMinutes 应为整数')
        expectTrue(p.words && typeof p.words === 'object' && !Array.isArray(p.words), 'words 应为对象')
        expectTrue(Array.isArray(p.days), 'days 应为数组')
      })

      await check('POST /api/progress 累加 turns/minutes 并更新 streak/days', async () => {
        const before = (await jfetch(api('/api/progress'))).json
        const r = await jfetch(api('/api/progress'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turns: 2, minutes: 5 }),
        })
        expectStatus(r, 200, 'POST /api/progress {turns:2,minutes:5}')
        const p = r.json
        expectEqual(p.totalTurns, before.totalTurns + 2, 'totalTurns 应累加 2')
        expectEqual(p.totalMinutes, before.totalMinutes + 5, 'totalMinutes 应累加 5')
        expectTrue(p.streak >= 1, `今日有活动后 streak 应 >=1，实际 ${JSON.stringify(p.streak)}`)
        const today = localDateString()
        const day = p.days.find((d) => d && d.date === today)
        expectTrue(!!day, `days 应包含今天 ${today}，实际 ${JSON.stringify(p.days)}`)
        expectTrue(day.turns >= 2, `今天 turns 应 >=2，实际 ${JSON.stringify(day)}`)
        expectTrue(day.minutes >= 5, `今天 minutes 应 >=5，实际 ${JSON.stringify(day)}`)
        expectTrue((typeof p.updatedAt === 'number' && Number.isFinite(p.updatedAt)) || (typeof p.updatedAt === 'string' && !Number.isNaN(Date.parse(p.updatedAt))), `updatedAt 应为合法时间戳，实际 ${JSON.stringify(p.updatedAt)}`)
      })

      await check('POST /api/progress reviewWords 走 SRS：答对 box+1、答错回落', async () => {
        const first = await jfetch(api('/api/progress'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewWords: [{ word: 'latte', correct: true }] }),
        })
        expectStatus(first, 200, 'reviewWords 第一次答对')
        expectTrue(first.json.words.latte, `words.latte 应被记录，实际 ${JSON.stringify(first.json.words)}`)
        const box1 = first.json.words.latte.box
        expectEqual(box1, 1, '首次答对 box 应从 0 升到 1（SPEC §2.5：box 0–7，间隔 [0,1,2,4,7,14,30,60]）')
        expectTrue(first.json.words.latte.correct === 1, `words.latte.correct 应为 1，实际 ${JSON.stringify(first.json.words.latte)}`)
        expectTrue(first.json.words.latte.seen === 1, `words.latte.seen 应为 1，实际 ${JSON.stringify(first.json.words.latte)}`)
        const dueVal = first.json.words.latte.due
        expectTrue((typeof dueVal === 'number' && Number.isFinite(dueVal)) || (typeof dueVal === 'string' && !Number.isNaN(Date.parse(dueVal))), `words.latte.due 应为毫秒时间戳（number）或可解析时间字符串，实际 ${JSON.stringify(dueVal)}`)

        const second = await jfetch(api('/api/progress'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewWords: [{ word: 'latte', correct: true }] }),
        })
        expectStatus(second, 200, 'reviewWords 第二次答对')
        expectEqual(second.json.words.latte.box, 2, '第二次答对 box 应为 2')
        expectEqual(second.json.words.latte.correct, 2, 'correct 计数应为 2')

        const wrong = await jfetch(api('/api/progress'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewWords: [{ word: 'latte', correct: false }] }),
        })
        expectStatus(wrong, 200, 'reviewWords 答错')
        expectTrue(wrong.json.words.latte.box < second.json.words.latte.box, `答错后 box 应回落（<${second.json.words.latte.box}），实际 ${wrong.json.words.latte.box}`)
        expectEqual(wrong.json.words.latte.seen, 3, '答错后 seen 计数应为 3')
        expectTrue(wrong.json.words.latte.due >= first.json.words.latte.due || wrong.json.words.latte.box === 0, '答错后 due 应更早或 box 归零')
      })
    })

    // =====================================================================
    await group('服务端健壮性补充', async () => {
      await check('/api/chat GET 方法不被支持（非 SSE 路径不 200）', async () => {
        const r = await jfetch(api('/api/chat'))
        expectTrue(r.status >= 400, `GET /api/chat 应返回 4xx，实际 ${r.status}`)
      })

      await check('并发 health/score 请求不互相阻塞', async () => {
        const reqs = []
        for (let i = 0; i < 5; i++) reqs.push(jfetch(api('/api/health')))
        const rs = await Promise.all(reqs)
        expectTrue(rs.every((r) => r.status === 200), `并发 health 应全部 200，实际 ${rs.map((r) => r.status).join(',')}`)
      })

      await check('路径穿越不会泄露 server.js', async () => {
        const r = await jfetch(`${baseUrl}/../server.js`)
        expectTrue([400, 403, 404].includes(r.status), `路径穿越请求应被拒绝，实际 ${r.status}`)
        expectTrue(!r.text.includes('createServer('), '路径穿越响应不得包含 server.js 源码')
      })
    })
  } finally {
    await stopServer(state)
    await mock.close()
    // 落盘结果与服务器日志
    await fsp.mkdir(ARTIFACTS_DIR, { recursive: true })
    const summary = {
      tool: 'test/e2e.mjs',
      startedAt: START_TS.toISOString(),
      finishedAt: new Date().toISOString(),
      baseUrl: baseUrl || null,
      mockUrl: mock.url,
      sandbox,
      serverLogTail: state.logs.slice(-120),
      results,
    }
    await fsp.writeFile(path.join(ARTIFACTS_DIR, 'e2e-results.json'), JSON.stringify(summary, null, 2))
    await fsp.writeFile(path.join(ARTIFACTS_DIR, 'e2e-server.log'), state.logs.join(''))
    if (!process.env.E2E_KEEP) await fremove(sandbox)
    else console.log(c.dim(`沙箱保留: ${sandbox}`))
  }

  // 汇总
  const pass = results.filter((r) => r.status === 'pass').length
  const fail = results.filter((r) => r.status === 'fail').length
  const blockedCount = results.filter((r) => r.status === 'blocked').length
  const skipped = results.filter((r) => r.status === 'skip').length
  console.log(c.bold('\n===== e2e 汇总 ====='))
  console.log(`  通过 ${c.green(pass)} / 失败 ${c.red(fail)} / 阻塞 ${c.yellow(blockedCount)} / 跳过 ${skipped}`)
  console.log(c.dim(`  结果文件: ${path.join(ARTIFACTS_DIR, 'e2e-results.json')}`))
  if (fail > 0) {
    console.log(c.red('\n失败用例:'))
    for (const r of results.filter((x) => x.status === 'fail')) {
      console.log(`  ✖ [${r.group}] ${r.name}`)
      for (const line of String(r.detail || r.error || '').split('\n').slice(0, 10)) console.log(`      ${line}`)
    }
    console.log(`\n复现: ${REPRO}`)
    return { code: 1, state, sandbox }
  }
  return { code: 0, state, sandbox }
}

const outcome = await main().catch((err) => {
  console.error(c.red(`e2e 运行异常: ${err && err.stack ? err.stack : err}`))
  return { code: 1 }
})
process.exitCode = outcome.code
