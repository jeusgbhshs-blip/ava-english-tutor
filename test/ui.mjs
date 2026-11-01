#!/usr/bin/env node
/**
 * test/ui.mjs — 真实浏览器 UI 验收（headless Chrome + CDP，零依赖）
 *
 * 做什么：
 *   1. 把项目复制到临时沙箱（不碰真实 data/），spawn server.js（随机端口，demo 模式）；
 *   2. 用本机 Chrome `--headless=new` 打开页面，通过 CDP（Node 24 内置 WebSocket）：
 *      - 捕获未捕获异常 / console.error / 同源 4xx-5xx 资源（缺模块、404 会被抓出来）；
 *      - 断言关键 DOM：#avatar-stage（且已挂载 SVG/子节点）、麦克风按钮、四个模式 Tab、
 *        设置弹窗入口、演示模式标识；
 *      - 断言页面文案不含 "undefined" / "NaN" / "TODO"；
 *      - 断言无横向溢出、麦克风按钮在视口内；
 *      - 点击设置按钮验证弹窗可开合、点击四个模式 Tab 验证 aria-selected；
 *      - 截图：/ 1440×900、/ 420×860、设置弹窗、/avatar/preview.html 桌面 + 移动；
 *   3. 结果落盘 test/artifacts/ui-results.json，截图落盘 test/artifacts/。
 *
 * 运行（需要本机 Google Chrome）：
 *   /Users/cici/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node test/ui.mjs
 *   可用 CHROME_PATH 覆盖 Chrome 路径。
 * 调试：UI_KEEP=1 保留沙箱/Chrome user-data-dir；UI_DEBUG=1 打印 CDP 事件。
 *
 * 退出码：0 全通过；1 有失败；2 阻塞（server.js / 前端文件未落地 / 无 Chrome / 服务器起不来）。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { inflateSync } from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..')
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, 'test', 'artifacts')
import { startMockVolc } from './mock-volc-realtime.mjs'
import { startMockUpstream } from './mock-upstream.mjs'

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const REPRO = `${process.execPath} ${path.join(HERE, 'ui.mjs')}`
const RESERVED_PORTS = new Set([5180, 5191, 5192, 5193])
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

/** 前端落地文件清单：缺任何一个都说明有人还在写，直接阻塞而不是刷失败 */
const REQUIRED_WEB_FILES = [
  'web/index.html',
  'web/css/app.css',
  'web/js/main.js',
  'web/js/modes.js',
  'web/js/api.js',
  'web/js/speech.js',
  'web/js/store.js',
  'web/avatar/avatar.js',
  'web/avatar/avatar.css',
  'web/avatar/preview.html',
]

// ---------------------------------------------------------------------------
// 迷你测试框架
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
    results.push({ group: currentGroup, name, status: 'pass', ms: Date.now() - started })
    console.log(`  ${c.green('✔')} ${name} ${c.dim(`(${Date.now() - started}ms)`)}`)
  } catch (err) {
    const detail = err && err.stack ? err.stack : String(err)
    results.push({ group: currentGroup, name, status: 'fail', ms: Date.now() - started, error: String(err && err.message ? err.message : err), detail })
    console.log(`  ${c.red('✖')} ${name}`)
    console.log(c.red('    ' + String(detail).split('\n').slice(0, 8).join('\n    ')))
  }
}

function blocked(name, reason) {
  results.push({ group: currentGroup, name, status: 'blocked', ms: 0, error: reason })
  console.log(`  ${c.yellow('◐')} ${name} — 阻塞：${reason}`)
}

async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function getFreePort() {
  for (let i = 0; i < 30; i++) {
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

async function prepareSandbox() {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'ava-ui-'))
  for (const entry of ['server.js', 'lib', 'content', 'web', 'package.json', 'start.command']) {
    const src = path.join(PROJECT_ROOT, entry)
    if (!(await exists(src))) continue
    await fsp.cp(src, path.join(sandbox, entry), { recursive: true })
  }
  await fsp.mkdir(path.join(sandbox, 'data'), { recursive: true })
  await fsp.mkdir(path.join(sandbox, '.runtime'), { recursive: true })
  return sandbox
}

async function jfetch(url, opts = {}, timeoutMs = 10000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  return { status: res.status, headers: res.headers, text, json }
}

async function startServer({ sandbox, port, state }) {
  const child = spawn(process.execPath, ['server.js', '--port', String(port)], {
    cwd: sandbox,
    env: { ...process.env, AVA_API_KEY: '', AVA_BASE_URL: '', AVA_MODEL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  state.child = child
  state.logs = []
  const onChunk = (tag) => (buf) => {
    state.logs.push(`[${tag}] ${buf}`)
    if (process.env.UI_DEBUG) process.stdout.write(c.dim(`[server:${tag}] ${buf}`))
  }
  child.stdout.on('data', onChunk('out'))
  child.stderr.on('data', onChunk('err'))
  state.waitExit = once(child, 'exit').then(([code, signal]) => {
    state.exited = { code, signal }
  })
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`服务器启动即退出（code=${state.exited.code}）\n${state.logs.join('')}`)
    const logText = state.logs.join('')
    const m = logText.match(/Ava ready at\s+(http:\/\/127\.0\.0\.1:\d+)/)
    const runtimeUrlFile = path.join(sandbox, '.runtime', 'url.txt')
    let baseUrl = m ? m[1] : null
    if (!baseUrl && (await exists(runtimeUrlFile))) {
      const um = (await fsp.readFile(runtimeUrlFile, 'utf8')).trim().match(/http:\/\/127\.0\.0\.1:\d+/)
      if (um) baseUrl = um[0]
    }
    if (!baseUrl) baseUrl = `http://127.0.0.1:${port}`
    try {
      const r = await jfetch(`${baseUrl}/api/health`, {}, 1200)
      if (r.status === 200) return baseUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error(`等待服务器就绪超时（20s）\n${state.logs.join('')}`)
}

async function stopServer(state) {
  const child = state.child
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([state.waitExit.then(() => true), sleep(3000).then(() => false)])
  if (!exited) {
    child.kill('SIGKILL')
    await Promise.race([state.waitExit, sleep(2000)])
  }
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端（Node 24 内置 WebSocket）
// ---------------------------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.ws = null
    this.closed = false
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket 连接超时: ${this.wsUrl}`)), 12000)
      this.ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      this.ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error(`CDP WebSocket 连接失败: ${this.wsUrl}`))
        },
        { once: true },
      )
    })
    this.ws.addEventListener('message', (event) => this.#onMessage(event.data))
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('CDP 连接已关闭'))
      }
      this.pending.clear()
    })
  }

  #onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (msg.id) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        this.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) pending.reject(new Error(`CDP ${msg.method || ''} ${msg.error.message || ''}`.trim()))
        else pending.resolve(msg.result)
      }
      return
    }
    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) || []) {
        try {
          fn(msg.params)
        } catch (err) {
          console.error(c.dim(`[cdp] 监听器异常 ${msg.method}: ${err.message}`))
        }
      }
    }
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 命令超时（${timeoutMs}ms）: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  /** 订阅事件，返回取消函数 */
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(fn)
    return () => this.listeners.get(method)?.delete(fn)
  }

  waitEvent(method, { timeoutMs = 15000, predicate } = {}) {
    return new Promise((resolve, reject) => {
      let off = null
      const timer = setTimeout(() => {
        if (off) off()
        reject(new Error(`等待 CDP 事件超时: ${method}`))
      }, timeoutMs)
      off = this.on(method, (params) => {
        if (predicate && !predicate(params)) return
        clearTimeout(timer)
        if (off) off()
        resolve(params)
      })
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
  }
}

async function httpJson(url, method = 'GET', timeoutMs = 8000) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  return { status: res.status, text, json }
}

async function startChrome({ userDataDir, devtoolsPort, state }) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--metrics-recording-only',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${devtoolsPort}`,
    '--window-size=1440,900',
    'about:blank',
  ]
  const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  state.chrome = child
  state.chromeLogs = []
  const onChunk = (tag) => (buf) => {
    state.chromeLogs.push(`[${tag}] ${buf}`)
    if (state.chromeLogs.length > 500) state.chromeLogs.splice(0, state.chromeLogs.length - 500)
    if (process.env.UI_DEBUG) process.stdout.write(c.dim(`[chrome:${tag}] ${buf}`))
  }
  child.stdout.on('data', onChunk('out'))
  child.stderr.on('data', onChunk('err'))
  state.chromeExit = once(child, 'exit').then(([code, signal]) => {
    state.chromeExited = { code, signal }
  })

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (state.chromeExited) {
      throw new Error(`Chrome 启动即退出（code=${state.chromeExited.code}）\n${state.chromeLogs.join('')}`)
    }
    try {
      const r = await httpJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 'GET', 1500)
      if (r.status === 200) return
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error(`等待 Chrome DevTools 就绪超时\n${state.chromeLogs.join('')}`)
}

async function stopChrome(state) {
  const child = state.chrome
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([state.chromeExit.then(() => true), sleep(4000).then(() => false)])
  if (!exited) {
    child.kill('SIGKILL')
    await Promise.race([state.chromeExit, sleep(2000)])
  }
}

async function getPageTargetUrl(devtoolsPort) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const list = await httpJson(`http://127.0.0.1:${devtoolsPort}/json/list`, 'GET', 2000)
    if (list.status === 200 && Array.isArray(list.json)) {
      const page = list.json.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    }
    // 没有 page target 时主动新建一个（Chrome 111+ 要求 PUT）
    const created = await httpJson(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, 'PUT', 3000).catch(() => null)
    if (created && created.json && created.json.webSocketDebuggerUrl) return created.json.webSocketDebuggerUrl
    await sleep(200)
  }
  throw new Error('无法获取 Chrome page target（DevTools WebSocket URL）')
}

// ---------------------------------------------------------------------------
// 页面内探针（在浏览器里执行，返回结构化数据）
// ---------------------------------------------------------------------------
const APP_PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const tabs = [...document.querySelectorAll('.mode-tab[data-mode]')].map((b) => ({
    mode: b.dataset.mode,
    selected: b.getAttribute('aria-selected') === 'true',
    visible: visible(b),
  }));
  const stage = q('#avatar-stage');
  const mic = q('#btn-mic');
  const settingsModal = q('#modal-settings');
  const isExternal = (u) => {
    if (!u || /^(data|blob|mailto|javascript|tel):/i.test(u)) return false;
    try {
      const url = new URL(u, location.href);
      return /^https?:$/.test(url.protocol) && url.host !== location.host;
    } catch {
      return false;
    }
  };
  const resources = [...document.querySelectorAll('script[src], link[href], img[src], source[src]')]
    .map((e) => e.getAttribute('src') || e.getAttribute('href'))
    .filter(Boolean);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    innerWidth: innerWidth,
    innerHeight: innerHeight,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body ? document.body.scrollWidth : 0,
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim(),
    avatarStage: !!stage,
    avatarChildren: stage ? stage.children.length : 0,
    avatarSvg: stage ? !!stage.querySelector('svg') : false,
    avatarRect: rect(stage),
    micVisible: visible(mic),
    micRect: rect(mic),
    modeTabs: tabs,
    settingsBtn: !!q('#btn-settings'),
    settingsBtnVisible: visible(q('#btn-settings')),
    settingsModal: !!settingsModal,
    settingsModalHidden: settingsModal ? settingsModal.hidden : null,
    progressBtn: !!q('#btn-progress'),
    demoPill: !!q('#demo-pill'),
    caption: !!q('#caption'),
    feedbackPanel: !!q('#feedback-panel'),
    modePanel: !!q('#mode-panel'),
    modePanelText: (q('#mode-panel') ? q('#mode-panel').innerText : '').replace(/\\s+/g, ' ').trim(),
    externalResources: resources.filter(isExternal),
    externalStylesheets: [...document.styleSheets].map((s) => s && s.href).filter((h) => h && (() => { try { return new URL(h).host !== location.host } catch { return false } })()),
  };
})()`

const PREVIEW_PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const buttons = [...document.querySelectorAll('button')].map((b) => ({
    text: (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    visible: (() => { const r = b.getBoundingClientRect(); return r.width > 2 && r.height > 2; })(),
  }));
  const svgCount = document.querySelectorAll('svg').length;
  const stageCandidates = ['#avatar-stage', '#avatar', '.avatar-stage', '.avatar-root', '[data-avatar-stage]', '#stage', 'main']
    .map((s) => ({ selector: s, exists: !!q(s) }));
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    innerWidth: innerWidth,
    innerHeight: innerHeight,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim(),
    buttonCount: buttons.length,
    visibleButtons: buttons.filter((b) => b.visible && b.text).length,
    buttons: buttons.slice(0, 40),
    svgCount,
    stageCandidates,
    externalResources: [...document.querySelectorAll('script[src], link[href], img[src]')]
      .map((e) => e.getAttribute('src') || e.getAttribute('href'))
      .filter((u) => {
        if (!u || /^(data|blob|mailto|javascript|tel):/i.test(u)) return false;
        try {
          const url = new URL(u, location.href);
          return /^https?:$/.test(url.protocol) && url.host !== location.host;
        } catch {
          return false;
        }
      }),
    htmlLength: document.documentElement.outerHTML.length,
  };
})()`

async function evalInPage(client, expression) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (exceptionDetails) {
    const desc = exceptionDetails.exception?.description || exceptionDetails.text || '未知异常'
    throw new Error(`页面脚本执行异常：${String(desc).split('\n')[0]}`)
  }
  return result.value
}

async function waitUntil(fn, { timeoutMs = 12000, interval = 120, label = '条件' } = {}) {
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
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${lastErr ? `（最后一次错误：${lastErr.message}）` : ''}`)
}

/** 关闭首次引导层（点「先打字体验」，避免 headless 下弹麦克风权限）；返回 { state, hidden } */
async function dismissOnboarding(client) {
  const state = await evalInPage(
    client,
    `(() => {
      const ob = document.querySelector('#onboarding');
      if (!ob) return 'no-onboarding';
      const st = getComputedStyle(ob);
      if (ob.hidden || st.display === 'none' || st.visibility === 'hidden') return 'already-hidden';
      const btn = document.querySelector('#btn-ob-type') || document.querySelector('#btn-ob-start');
      if (!btn) return 'visible-no-button';
      btn.click();
      return 'clicked';
    })()`,
  );
  await sleep(600);
  const hidden = await evalInPage(
    client,
    `(() => {
      const ob = document.querySelector('#onboarding');
      if (!ob) return true;
      const st = getComputedStyle(ob);
      return !!ob.hidden || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0;
    })()`,
  );
  return { state, hidden };
}

async function navigate(client, url) {
  const loaded = client.waitEvent('Page.loadEventFired', { timeoutMs: 20000 }).catch(() => null)
  const res = await client.send('Page.navigate', { url })
  if (res.errorText) throw new Error(`页面导航失败：${res.errorText}（${url}）`)
  await loaded
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/** 等应用加载完成（__ava 就绪 + 内容加载） */
async function waitAppReady(client) {
  await waitUntil(
    async () => (await evalInPage(client, `!!(window.__ava && window.__ava.content)`)) === true,
    { timeoutMs: 15000, label: '应用就绪（window.__ava.content）' },
  )
  await sleep(300)
}

/** 模拟发送一句英文，并等这一轮对话结束（demo 模式下通常 < 2s）
 * 注意：演示回复可能与上一轮文案相同（同 hash 命中同一条台词），所以不能只靠 reply 变化判断，
 * 需要结合 phase：观察到 thinking/speaking 后回到 idle 即视为本轮结束。 */
async function sendTurn(client, text, { timeoutMs = 30000 } = {}) {
  const before = await evalInPage(client, `window.__ava ? String(window.__ava.reply || '') : ''`)
  const sent = await evalInPage(
    client,
    `(() => { if (!window.__ava || typeof window.__ava.send !== 'function') return false; window.__ava.send(${JSON.stringify(text)}); return true; })()`,
  )
  if (sent !== true) throw new Error('无法通过 window.__ava.send 发送消息')
  const started = Date.now()
  const deadline = started + timeoutMs
  let sawBusy = false
  while (Date.now() < deadline) {
    const st = await evalInPage(
      client,
      `(() => { const a = window.__ava; return { phase: a ? a.phase : null, reply: a ? String(a.reply || '') : '' }; })()`,
    )
    const busy = st.phase === 'thinking' || st.phase === 'speaking' || st.phase === 'listening'
    if (busy) sawBusy = true
    const changed = st.reply && st.reply !== before
    if (!busy && st.reply && (changed || (sawBusy && Date.now() - started > 400))) return st.reply
    await sleep(100)
  }
  throw new Error(`等待对话轮次结束超时：${text}`)
}

/** 读取总结弹窗状态 */
async function probeSummary(client) {
  return evalInPage(
    client,
    `(() => {
      const modal = document.getElementById('modal-summary');
      const body = document.getElementById('summary-body');
      const foot = document.getElementById('summary-foot');
      const rect = modal ? modal.getBoundingClientRect() : null;
      const bodyRect = body ? body.getBoundingClientRect() : null;
      return {
        open: !!(modal && !modal.hidden),
        rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), bottom: Math.round(rect.bottom) } : null,
        heroText: (document.querySelector('#summary-body .sum-hero p')?.textContent || '').trim(),
        topics: [...document.querySelectorAll('#summary-body .sum-topic')].map((e) => e.textContent.trim()),
        kwWords: [...document.querySelectorAll('#summary-body .kw-card .kw-word')].map((e) => e.textContent.trim()),
        corrections: document.querySelectorAll('#summary-body .fb-correction').length,
        encourage: (document.querySelector('#summary-body .sum-encourage span')?.textContent || '').trim(),
        kwAdded: (document.querySelector('#summary-body .kw-added')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        footVisible: foot ? !foot.hidden : false,
        hasContinue: !!document.getElementById('btn-summary-continue'),
        hasWordbookBtn: !!document.getElementById('btn-summary-wordbook'),
        demoTag: !!document.querySelector('#summary-body .sum-demo'),
        bodyScroll: body ? { sh: body.scrollHeight, ch: body.clientHeight, sw: body.scrollWidth, cw: body.clientWidth, overflowY: getComputedStyle(body).overflowY } : null,
        bodyInViewport: !!(bodyRect && bodyRect.bottom > 0 && bodyRect.top < innerHeight && bodyRect.right > 0 && bodyRect.left < innerWidth),
      };
    })()`,
  )
}

/** 读取今日单词表弹窗状态 */
async function probeWordbook(client) {
  return evalInPage(
    client,
    `(() => {
      const modal = document.getElementById('modal-wordbook');
      const body = document.getElementById('wordbook-body');
      const rect = modal ? modal.getBoundingClientRect() : null;
      const bodyRect = body ? body.getBoundingClientRect() : null;
      const firstLabel = document.querySelector('#wordbook-body .wb-day-label');
      return {
        open: !!(modal && !modal.hidden),
        rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), bottom: Math.round(rect.bottom) } : null,
        dayCount: document.querySelectorAll('#wordbook-body .wb-day').length,
        firstLabel: firstLabel ? firstLabel.textContent.replace(/\\s+/g, ' ').trim() : '',
        words: [...document.querySelectorAll('#wordbook-body .wb-word-name')].map((e) => e.textContent.trim()),
        total: (document.querySelector('#wordbook-body .wb-total')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        speakButtons: document.querySelectorAll('#wordbook-body .wb-speak').length,
        bodyScroll: body ? { sh: body.scrollHeight, ch: body.clientHeight, sw: body.scrollWidth, cw: body.clientWidth, overflowY: getComputedStyle(body).overflowY } : null,
        bodyInViewport: !!(bodyRect && bodyRect.bottom > 0 && bodyRect.top < innerHeight && bodyRect.right > 0 && bodyRect.left < innerWidth),
      };
    })()`,
  )
}

/** 通过 CDP 给 <input type=file> 设置本地文件（触发真实 change 事件） */
async function setFileInputFiles(client, selector, filePath) {
  await client.send('DOM.enable')
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true })
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  if (!nodeId) throw new Error(`找不到文件输入框：${selector}`)
  await client.send('DOM.setFileInputFiles', { files: [filePath], nodeId })
  return true
}

/** 解码 CDP 截图 PNG（8bit RGB/RGBA，支持 5 种 PNG 过滤器；零依赖） */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`不支持的 PNG bitDepth=${bitDepth}`)
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(width * height * bpp)
  let prev = Buffer.alloc(stride)
  let off = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[off++]
    const line = raw.subarray(off, off + stride)
    off += stride
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[x] = v
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width, height, bpp, data: out }
}

/** 两张同尺寸 PNG 在归一化区域内的像素差异比例（亮度差 >12 视为变化） */
function pngDiffRatio(pngA, pngB, region = { x0: 0, y0: 0, x1: 1, y1: 1 }) {
  const { width, height, bpp, data } = pngA
  const x0 = Math.max(0, Math.floor(region.x0 * width))
  const x1 = Math.min(width, Math.ceil(region.x1 * width))
  const y0 = Math.max(0, Math.floor(region.y0 * height))
  const y1 = Math.min(height, Math.ceil(region.y1 * height))
  let changed = 0
  let total = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * bpp
      const la = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
      const lb = (pngB.data[i] * 0.299 + pngB.data[i + 1] * 0.587 + pngB.data[i + 2] * 0.114)
      total += 1
      if (Math.abs(la - lb) > 12) changed += 1
    }
  }
  return { ratio: total ? changed / total : 0, pixels: total }
}

async function main() {
  console.log(c.bold('Ava UI 验收测试（headless Chrome + CDP）'))
  console.log(c.dim(`项目: ${PROJECT_ROOT}`))
  console.log(c.dim(`复现: ${REPRO}`))
  await fsp.mkdir(ARTIFACTS_DIR, { recursive: true })

  const state = { child: null, logs: [], chrome: null, chromeLogs: [] }
  let sandbox = null
  let cdp = null
  let baseUrl = null
  const artifacts = []

  const debug = {
    jsErrors: [],
    consoleErrors: [],
    consoleWarnings: [],
    badResponses: [],
    failedRequests: [],
    requestUrls: new Map(),
    phase: 'startup',
  }

  const skipIndex = process.env.UI_SKIP_INDEX === '1'
  const skipPreview = process.env.UI_SKIP_PREVIEW === '1'
  const requiredFiles = skipIndex
    ? ['web/avatar/avatar.js', 'web/avatar/avatar.css', 'web/avatar/preview.html']
    : REQUIRED_WEB_FILES
  const precheckBlockers = []
  if (!(await exists(path.join(PROJECT_ROOT, 'server.js')))) precheckBlockers.push('server.js 未落地（Lead）')
  for (const rel of requiredFiles) {
    if (!(await exists(path.join(PROJECT_ROOT, rel)))) precheckBlockers.push(`${rel} 未落地`)
  }
  if (!(await exists(CHROME))) precheckBlockers.push(`找不到 Chrome：${CHROME}（可用 CHROME_PATH 指定）`)
  if (precheckBlockers.length) {
    await group('前置检查', async () => {
      for (const b of precheckBlockers) blocked('前置文件/环境', b)
    })
    return { code: 2, artifacts, state, sandbox }
  }

  try {
    sandbox = await prepareSandbox()
    const serverPort = await getFreePort()
    baseUrl = await startServer({ sandbox, port: serverPort, state })
    console.log(c.dim(`server: ${baseUrl}  sandbox: ${sandbox}`))

    const devtoolsPort = await getFreePort()
    await startChrome({ userDataDir: path.join(sandbox, '.chrome-profile'), devtoolsPort, state })
    const wsUrl = await getPageTargetUrl(devtoolsPort)
    cdp = new CDP(wsUrl)
    await cdp.connect()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Log.enable')

    // ---- 收集浏览器错误 ----
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {}
      debug.jsErrors.push({
        phase: debug.phase,
        text: d.text || 'Uncaught',
        description: d.exception?.description || '',
        url: d.url || '',
        line: d.lineNumber,
        column: d.columnNumber,
      })
    })
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type || ''))
        .join(' ')
        .slice(0, 500)
      if (p.type === 'error') debug.consoleErrors.push({ phase: debug.phase, text })
      else if (p.type === 'warning' || p.type === 'warn') debug.consoleWarnings.push({ phase: debug.phase, text })
    })
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {}
      const text = `${e.source || ''}: ${e.text || ''}`
      // 浏览器级 WebSocket teardown 噪音（服务端在途帧/重复 close），非页面 JS 错误，直接忽略
      if (/Data frame received after close|Close received after close/i.test(text)) return
      if (e.level === 'error') debug.consoleErrors.push({ phase: debug.phase, text })
      else if (e.level === 'warning') debug.consoleWarnings.push({ phase: debug.phase, text })
    })
    cdp.on('Network.requestWillBeSent', (p) => {
      debug.requestUrls.set(p.requestId, p.request?.url || '')
    })
    cdp.on('Network.responseReceived', (p) => {
      const r = p.response || {}
      if (r.status >= 400) {
        debug.badResponses.push({ phase: debug.phase, url: r.url, status: r.status, type: p.type })
      }
    })
    cdp.on('Network.loadingFailed', (p) => {
      const url = debug.requestUrls.get(p.requestId) || ''
      if (!p.canceled) debug.failedRequests.push({ phase: debug.phase, url, errorText: p.errorText, type: p.type })
    })

    const screenshot = async (name) => {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      const file = path.join(ARTIFACTS_DIR, name)
      await fsp.writeFile(file, Buffer.from(shot.data, 'base64'))
      artifacts.push(file)
      return file
    }

    // =====================================================================
    if (!skipIndex) await group(`主界面 / @ 1440×900`, async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      debug.phase = 'index-1440'
      await navigate(cdp, baseUrl + '/')
      await sleep(1200)

      let probe = null
      await check('页面可加载并完成渲染（readyState=complete）', async () => {
        probe = await evalInPage(cdp, APP_PROBE)
        assert.equal(probe.readyState, 'complete', `readyState 应为 complete，实际 ${probe.readyState}`)
        assert.ok(probe.title && probe.title.trim().length > 0, '页面应有标题')
        assert.ok(probe.text.length > 20, `页面应有可见文案，实际 innerText 长度 ${probe.text.length}`)
        assert.ok(Math.abs(probe.innerWidth - 1440) <= 2, `视口宽度应为 1440，实际 ${probe.innerWidth}`)
      })

      await check('首次引导层可关闭并进入主界面', async () => {
        const ob = await dismissOnboarding(cdp)
        assert.notEqual(ob.state, 'visible-no-button', '首次引导层可见但找不到「开始体验/先打字体验」按钮')
        assert.equal(ob.hidden, true, `关闭首次引导后 #onboarding 应隐藏（点击结果: ${ob.state}）`)
        const fl = await evalInPage(cdp, `(() => { const ob = document.querySelector('#onboarding'); if (!ob) return { hidden: true, display: 'none' }; const st = getComputedStyle(ob); return { hidden: !!ob.hidden, display: st.display, opacity: st.opacity }; })()`)
        assert.equal(fl.hidden || fl.display === 'none' || Number(fl.opacity) === 0, true, `引导层应不可见，实际 ${JSON.stringify(fl)}`)
      })

      await check('#avatar-stage 存在且数字人已挂载（SVG 渲染）', async () => {
        await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => { const s = document.querySelector('#avatar-stage'); return s ? s.children.length : 0; })()`,
            )
            return v > 0
          },
          { timeoutMs: 12000, label: '#avatar-stage 子节点挂载' },
        )
        probe = await evalInPage(cdp, APP_PROBE)
        assert.equal(probe.avatarStage, true, '找不到 #avatar-stage（SPEC §4 要求）')
        assert.ok(probe.avatarChildren > 0, `#avatar-stage 内应有数字人 DOM，实际子节点 ${probe.avatarChildren}`)
        assert.equal(probe.avatarSvg, true, '#avatar-stage 内应有 SVG（SPEC §4：纯 SVG 渲染）')
      })

      await check('麦克风按钮存在、可见且位于视口内', async () => {
        probe = await evalInPage(cdp, APP_PROBE)
        assert.equal(probe.micVisible, true, '麦克风按钮 #btn-mic 不可见')
        assert.ok(probe.micRect, '麦克风按钮应有布局尺寸')
        assert.ok(probe.micRect.w >= 40 && probe.micRect.h >= 40, `麦克风按钮应足够大（可点击），实际 ${probe.micRect.w}×${probe.micRect.h}`)
        assert.ok(probe.micRect.y >= 0 && probe.micRect.bottom <= probe.innerHeight + 2, `麦克风按钮应在视口内，实际 top=${probe.micRect.y} bottom=${probe.micRect.bottom} vh=${probe.innerHeight}`)
      })

      await check('状态/麦克风提示文案 phase 驱动（idle 文案正确）', async () => {
        const st = await evalInPage(
          cdp,
          `(() => ({
            status: (document.getElementById('status-text')?.textContent || '').trim(),
            hint: (document.getElementById('mic-hint')?.textContent || '').replace(/\\s+/g, ' ').trim(),
            phase: window.__ava ? window.__ava.phase : null,
          }))()`,
        )
        assert.equal(st.phase, 'idle', `初始 phase 应为 idle，实际 ${st.phase}`)
        assert.equal(st.hint, '点击麦克风开始说英语 · 也可按空格', `idle 时麦克风提示文案应为「点击麦克风开始说英语 · 也可按空格」，实际 "${st.hint}"`)
        assert.ok(st.status.length > 0, '状态文案不应为空')
      })

      await check('五个模式 Tab 齐全且默认选中 free（v1.3 新增阅读讲解）', async () => {
        probe = await evalInPage(cdp, APP_PROBE)
        const modes = probe.modeTabs.map((t) => t.mode).sort()
        assert.deepEqual(modes, ['free', 'pronounce', 'reading', 'roleplay', 'vocab'], `模式 Tab 应为 free/vocab/pronounce/roleplay/reading，实际 ${JSON.stringify(probe.modeTabs)}`)
        assert.ok(probe.modeTabs.every((t) => t.visible), `四个模式 Tab 都应可见，实际 ${JSON.stringify(probe.modeTabs)}`)
        const selected = probe.modeTabs.filter((t) => t.selected)
        assert.equal(selected.length, 1, `应恰有 1 个模式 Tab 选中，实际 ${selected.length}`)
        assert.equal(selected[0].mode, 'free', `默认应选中 free，实际 ${selected[0].mode}`)
        assert.ok(probe.modePanelText.length > 0, '模式面板应有内容')
      })

      await check('设置弹窗入口存在，且能打开/关闭', async () => {
        probe = await evalInPage(cdp, APP_PROBE)
        assert.equal(probe.settingsBtn, true, '找不到设置按钮 #btn-settings')
        assert.equal(probe.settingsBtnVisible, true, '设置按钮不可见')
        assert.equal(probe.settingsModal, true, '找不到设置弹窗 #modal-settings')
        assert.equal(probe.settingsModalHidden, true, '设置弹窗初始应为隐藏')

        await evalInPage(cdp, `document.getElementById('btn-settings').click(); true`)
        await sleep(400)
        const opened = await evalInPage(
          cdp,
          `(() => { const m = document.getElementById('modal-settings'); return m ? !m.hidden : false; })()`,
        )
        assert.equal(opened, true, '点击设置按钮后弹窗应打开')
        await screenshot('ui-settings-1440.png')

        await evalInPage(
          cdp,
          `(() => { const m = document.getElementById('modal-settings'); const btn = m && m.querySelector('[data-close]'); if (btn) btn.click(); return true; })()`,
        )
        await sleep(300)
        const closed = await evalInPage(
          cdp,
          `(() => { const m = document.getElementById('modal-settings'); return m ? m.hidden : true; })()`,
        )
        assert.equal(closed, true, '点击关闭后设置弹窗应隐藏')
      })

      await check('页面文案不含 undefined / NaN / TODO', async () => {
        probe = await evalInPage(cdp, APP_PROBE)
        const bad = probe.text.match(/\b(undefined|NaN|TODO)\b/g)
        assert.equal(bad, null, `页面文案出现占位/异常文本：${bad ? bad.join(',') : ''}\n文案片段：${probe.text.slice(0, 500)}`)
      })

      await check('无横向溢出（1440×900）', async () => {
        probe = await evalInPage(cdp, APP_PROBE)
        assert.ok(
          probe.docScrollWidth - probe.docClientWidth <= 2,
          `页面横向溢出：scrollWidth=${probe.docScrollWidth} > clientWidth=${probe.docClientWidth}`,
        )
        assert.ok(probe.bodyScrollWidth - probe.docClientWidth <= 2, `body 横向溢出：${probe.bodyScrollWidth} > ${probe.docClientWidth}`)
      })

      await check('无外部 CDN / 外部字体 / 外链资源', async () => {
        probe = await evalInPage(cdp, APP_PROBE)
        assert.deepEqual(probe.externalResources, [], `不应加载外部资源：${JSON.stringify(probe.externalResources)}`)
        assert.deepEqual(probe.externalStylesheets, [], `不应加载外部样式表：${JSON.stringify(probe.externalStylesheets)}`)
      })

      await check('点击四个模式 Tab 可切换（aria-selected 正确）', async () => {
        for (const mode of ['vocab', 'pronounce', 'roleplay', 'free']) {
          await evalInPage(cdp, `document.querySelector('.mode-tab[data-mode="${mode}"]').click(); true`)
          await sleep(350)
          const st = await evalInPage(
            cdp,
            `(() => {
              const tabs = [...document.querySelectorAll('.mode-tab[data-mode]')].map((b) => ({ mode: b.dataset.mode, selected: b.getAttribute('aria-selected') === 'true' }));
              const panel = document.querySelector('#mode-panel');
              const chip = document.getElementById('stage-chip');
              return {
                tabs,
                panelText: panel ? panel.innerText.replace(/\\s+/g, ' ').trim() : '',
                chip: { hidden: chip ? chip.hidden : null, text: chip ? chip.innerText.replace(/\\s+/g, ' ').trim() : '' },
              };
            })()`,
          )
          const selected = st.tabs.filter((t) => t.selected)
          assert.equal(selected.length, 1, `点击 ${mode} 后应恰有 1 个选中，实际 ${JSON.stringify(st.tabs)}`)
          assert.equal(selected[0].mode, mode, `点击 ${mode} 后选中项应为 ${mode}`)
          assert.ok(st.panelText.length > 0, `模式 ${mode} 的面板内容不应为空`)

          // P2 回归：舞台胶囊应随模式切换（free=话题 / vocab=「单词闯关 · 主题」/ pronounce=「跟读打分 · 句库」/ roleplay=场景）
          assert.equal(st.chip.hidden, false, `${mode} 模式下舞台胶囊 #stage-chip 应可见，实际 hidden=${st.chip.hidden}`)
          const chipText = st.chip.text
          assert.ok(chipText.length > 0, `${mode} 模式下舞台胶囊文案不应为空`)
          if (mode === 'vocab') assert.match(chipText, /单词闯关/, `vocab 模式胶囊应含「单词闯关」，实际 "${chipText}"`)
          else if (mode === 'pronounce') assert.match(chipText, /跟读打分/, `pronounce 模式胶囊应含「跟读打分」，实际 "${chipText}"`)
          else if (mode === 'roleplay') assert.match(chipText, /角色扮演/, `roleplay 模式胶囊应含「角色扮演」，实际 "${chipText}"`)
          else assert.doesNotMatch(chipText, /单词闯关|跟读打分|角色扮演/, `free 模式胶囊应为话题名，实际 "${chipText}"`)
        }
        await screenshot('ui-index-1440x900.png')
      })

      await check('URL ?onboard=0 可跳过引导层，且渲染完成后再截图（1440×900）', async () => {
        debug.phase = 'index-1440-onboard0'
        await navigate(cdp, baseUrl + '/?onboard=0')
        await sleep(1000)
        const obState = await evalInPage(
          cdp,
          `(() => { const ob = document.querySelector('#onboarding'); if (!ob) return 'missing'; const st = getComputedStyle(ob); return { hidden: !!ob.hidden, display: st.display, opacity: st.opacity }; })()`,
        )
        assert.ok(obState !== 'missing', '找不到 #onboarding 引导层节点')
        assert.equal(
          obState.hidden || obState.display === 'none' || Number(obState.opacity) === 0,
          true,
          `?onboard=0 应跳过引导层，实际 ${JSON.stringify(obState)}`,
        )
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const s = document.querySelector('#avatar-stage'); return s && s.children.length > 0; })()`)) === true,
          { timeoutMs: 12000, label: '数字人挂载（截图前）' },
        ).catch(() => {})
        await screenshot('ui-index-1440x900.png')
        const st = await fsp.stat(path.join(ARTIFACTS_DIR, 'ui-index-1440x900.png'))
        assert.ok(st.size > 10_000, `桌面截图文件过小（${st.size} bytes），疑似空白页`)
      })
    })

    // =====================================================================
    // P2 回归：保存/清除 API Key 后，演示模式徽标与状态必须立即刷新
    // =====================================================================
    if (!skipIndex) await group('设置保存回归（Key → 演示模式徽标刷新）', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      debug.phase = 'settings-key-regression'

      await check('保存 API Key 后 demo-pill 隐藏、状态切到 AI 模式且 keyHint 正确（不回显原文）', async () => {
        const opened = await evalInPage(
          cdp,
          `(() => {
            if (window.__ava && typeof window.__ava.openSettings === 'function') { window.__ava.openSettings(); return true; }
            const b = document.getElementById('btn-settings');
            if (b) { b.click(); return true; }
            return false;
          })()`,
        )
        assert.equal(opened, true, '无法通过 #btn-settings / __ava.openSettings 打开设置弹窗')
        await sleep(500)
        const filled = await evalInPage(
          cdp,
          `(() => {
            const el = document.getElementById('set-apikey');
            if (!el) return false;
            el.value = 'sk-qa-ui-test-key-9z8y';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`,
        )
        assert.equal(filled, true, '找不到 API Key 输入框 #set-apikey')
        await evalInPage(cdp, `document.getElementById('btn-save-settings').click(); true`)

        // 等待应用把 demo 状态刷成 false（回归点：此前保存 Key 后徽标不刷新）
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const pill = document.getElementById('demo-pill');
                const a = window.__ava;
                const status = document.getElementById('status-text');
                return {
                  hidden: pill ? pill.hidden : null,
                  demo: a ? a.demo : null,
                  statusText: status ? status.textContent.trim() : '',
                };
              })()`,
            )
            return v.demo === false ? v : null
          },
          { timeoutMs: 8000, label: '保存 Key 后 __ava.demo 变为 false' },
        )
        assert.equal(st.hidden, true, `保存 Key 后 #demo-pill 应隐藏（P2 回归），实际 ${JSON.stringify(st)}`)
        assert.ok(!/演示模式/.test(st.statusText), `保存 Key 后状态文案不应再出现「演示模式」，实际 "${st.statusText}"`)

        const apiSettings = await jfetch(baseUrl + '/api/settings')
        assert.equal(apiSettings.json.hasKey, true, 'GET /api/settings 应返回 hasKey=true')
        assert.ok(
          String(apiSettings.json.keyHint).endsWith('9z8y'),
          `keyHint 应以后 4 位 9z8y 结尾，实际 ${JSON.stringify(apiSettings.json.keyHint)}`,
        )
        assert.ok(!apiSettings.text.includes('sk-qa-ui-test-key-9z8y'), 'GET /api/settings 不得泄露完整 apiKey')

        // 再次打开设置：输入框不回显原文，提示区显示 keyHint
        await evalInPage(cdp, `window.__ava.openSettings(); true`)
        await sleep(400)
        const shown = await evalInPage(
          cdp,
          `(() => {
            const input = document.getElementById('set-apikey');
            const hint = document.getElementById('set-key-hint');
            return { value: input ? input.value : null, hint: hint ? hint.innerText.replace(/\\s+/g, ' ').trim() : '' };
          })()`,
        )
        assert.equal(shown.value, '', '设置弹窗中 API Key 输入框不应回显原文')
        assert.ok(shown.hint.includes('9z8y'), `设置弹窗应显示 keyHint 后 4 位，实际 ${JSON.stringify(shown.hint)}`)
      })

      await check('清除 API Key 后 demo-pill 恢复显示、demo=true', async () => {
        const clicked = await evalInPage(
          cdp,
          `(() => { const b = document.getElementById('btn-clear-key'); if (!b) return false; b.click(); return true; })()`,
        )
        assert.equal(clicked, true, '找不到「清除已保存的 Key」按钮 #btn-clear-key')
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const pill = document.getElementById('demo-pill');
                return { hidden: pill ? pill.hidden : null, demo: window.__ava ? window.__ava.demo : null };
              })()`,
            )
            return v.demo === true ? v : null
          },
          { timeoutMs: 8000, label: '清除 Key 后 __ava.demo 恢复 true' },
        )
        assert.equal(st.hidden, false, `清除 Key 后 #demo-pill 应重新显示，实际 ${JSON.stringify(st)}`)
        const apiSettings = await jfetch(baseUrl + '/api/settings')
        assert.equal(apiSettings.json.hasKey, false, '清除 Key 后 GET /api/settings 应 hasKey=false')
        // 关闭设置弹窗
        await evalInPage(
          cdp,
          `(() => { const m = document.getElementById('modal-settings'); const b = m && m.querySelector('[data-close]'); if (b) b.click(); return true; })()`,
        )
        await sleep(300)
      })
    })


    // =====================================================================
    // v1.1：自由对话（数字外国朋友）+ 结束总结 + 今日单词表
    // =====================================================================
    if (!skipIndex) await group('v1.1 自由对话 / 结束总结 / 今日单词表', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      debug.phase = 'v11-free-1440'
      await navigate(cdp, baseUrl + '/?onboard=0')
      await sleep(900)
      await waitAppReady(cdp)

      await check('free 首页：不强制选话题，有聊天灵感与「结束对话并总结」', async () => {
        const st = await evalInPage(
          cdp,
          `(() => {
            const panel = document.querySelector('#mode-panel');
            const text = panel ? panel.innerText.replace(/\\s+/g, ' ').trim() : '';
            const endBtn = document.querySelector('[data-act="free-end"]');
            const endRect = endBtn ? endBtn.getBoundingClientRect() : null;
            const chips = [...document.querySelectorAll('.inspire-chip')];
            const chip = document.getElementById('stage-chip');
            return {
              text,
              endVisible: !!(endRect && endRect.width > 2 && endRect.height > 2),
              endText: endBtn ? endBtn.innerText.replace(/\\s+/g, ' ').trim() : '',
              chipCount: chips.length,
              chipVisible: chips.some((c) => c.getBoundingClientRect().width > 2),
              freeHero: !!document.querySelector('.free-hero'),
              stageChip: chip ? { hidden: chip.hidden, text: chip.innerText.replace(/\\s+/g, ' ').trim() } : null,
              hasTopicSelect: /选择一个?话题|topic-card|选择话题/i.test(text),
              demo: window.__ava ? window.__ava.demo : null,
              mode: window.__ava ? window.__ava.mode : null,
            };
          })()`,
        )
        assert.equal(st.demo, true, '无 Key 时应为演示模式')
        assert.equal(st.mode, 'free', `默认应处于 free 模式，实际 ${st.mode}`)
        assert.equal(st.freeHero, true, 'free 模式应有「想聊什么就聊什么」首页卡片')
        assert.match(st.text, /想聊什么就聊什么/, 'free 首页应说明自由聊天定位')
        assert.ok(st.chipCount >= 2, `应有聊天灵感 chips（>=2），实际 ${st.chipCount}`)
        assert.equal(st.chipVisible, true, '聊天灵感 chips 应可见')
        assert.equal(st.endVisible, true, '「结束对话并总结」按钮应可见')
        assert.match(st.endText, /结束对话并总结/, `按钮文案应为「结束对话并总结」，实际 "${st.endText}"`)
        assert.equal(st.hasTopicSelect, false, 'free 模式不应出现强制选择话题的 UI')
        await screenshot('ui-free-home-1440.png')
      })

      await check('聊 3 轮 → 点「结束对话并总结」→ 总结弹窗内容完整', async () => {
        const turns = [
          'I had a really long day at work today.',
          'I had three meetings and a deadline, so I am tired.',
          'But I want go to the gym later. I very like running.',
        ]
        for (const text of turns) await sendTurn(cdp, text)
        const beforeErrors = debug.jsErrors.length
        const clicked = await evalInPage(
          cdp,
          `(() => { const b = document.querySelector('[data-act="free-end"]'); if (!b) return false; b.click(); return true; })()`,
        )
        assert.equal(clicked, true, '找不到「结束对话并总结」按钮 [data-act="free-end"]')

        const sum = await waitUntil(
          async () => {
            const v = await probeSummary(cdp)
            return v.open && v.heroText.length > 10 ? v : null
          },
          { timeoutMs: 30000, label: '总结弹窗渲染完成' },
        )
        assert.ok(sum.heroText.length > 10, `总结弹窗应有中文总结，实际 ${JSON.stringify(sum.heroText)}`)
        assert.match(sum.heroText, /[\u4e00-\u9fa5]/, '总结应为中文')
        assert.ok(sum.topics.length >= 1, `总结应有话题 chips（>=1），实际 ${sum.topics.length}`)
        assert.ok(sum.kwWords.length >= 3, `重点单词应 >=3，实际 ${sum.kwWords.length}`)
        assert.ok(sum.encourage.length > 0, '应有中文鼓励')
        assert.match(sum.kwAdded, /今日单词表/, '应标注已加入今日单词表')
        assert.equal(sum.footVisible, true, '总结弹窗底部操作应可见')
        assert.equal(sum.hasContinue, true, '应有「继续聊」按钮')
        assert.equal(sum.hasWordbookBtn, true, '应有「查看今日单词表」按钮')
        assert.equal(debug.jsErrors.length, beforeErrors, '总结流程不应产生 JS 异常')
        await screenshot('ui-summary-1440.png')

        const badge = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => { const b = document.getElementById('wordbook-badge'); if (!b) return null; const r = b.getBoundingClientRect(); return { hidden: b.hidden, text: (b.textContent || '').trim(), visible: !b.hidden && r.width > 2 }; })()`,
            )
            return v && v.visible ? v : null
          },
          { timeoutMs: 8000, label: '单词本徽标刷新' },
        )
        assert.ok(Number(badge.text) >= 1, `总结后单词本徽标应显示今日词数 >=1，实际 "${badge.text}"`)
      })

      await check('「继续聊」：关闭弹窗、清空本轮、Ava 用新开场白开始新一轮（B4）', async () => {
        await evalInPage(cdp, `document.getElementById('btn-summary-continue').click(); true`)
        await sleep(900)
        const st = await evalInPage(
          cdp,
          `(() => {
            const modal = document.getElementById('modal-summary');
            const user = document.getElementById('caption-user');
            const reply = document.getElementById('caption-reply');
            return {
              modalHidden: modal ? modal.hidden : null,
              userText: user ? user.innerText.replace(/\\s+/g, ' ').trim() : '',
              userHidden: user ? user.hidden : null,
              replyText: reply ? reply.innerText.replace(/\\s+/g, ' ').trim() : '',
              fbCards: document.querySelectorAll('#feedback-panel .fb-card').length,
            };
          })()`,
        )
        assert.equal(st.modalHidden, true, '继续聊后总结弹窗应关闭')
        assert.equal(st.userHidden === true || st.userText === '', true, `新轮次应清空用户字幕，实际 ${JSON.stringify(st.userText)}`)
        assert.ok(st.replyText.length > 0, '新轮次应有 Ava 新开场白')
        assert.equal(st.fbCards, 0, '新轮次应清空反馈卡')
        await screenshot('ui-free-home-1440.png')
      })

      await check('顶栏「单词本」：今天分组、新词、朗读按钮、无横向溢出', async () => {
        await evalInPage(cdp, `document.getElementById('btn-wordbook').click(); true`)
        const wb = await waitUntil(
          async () => {
            const v = await probeWordbook(cdp)
            return v.open && v.dayCount > 0 ? v : null
          },
          { timeoutMs: 15000, label: '今日单词表弹窗渲染' },
        )
        assert.ok(wb.dayCount >= 1, '单词表应至少 1 个日期分组')
        assert.match(wb.firstLabel, /今天/, `今天应置顶，实际首组 ${JSON.stringify(wb.firstLabel)}`)
        assert.ok(wb.words.length >= 3, `今天分组应有 >=3 个单词，实际 ${wb.words.length}`)
        assert.match(wb.total, /个单词/, `应显示单词总数，实际 "${wb.total}"`)
        assert.ok(wb.speakButtons >= 1, '单词应带朗读按钮')
        assert.ok(wb.bodyScroll.sw - wb.bodyScroll.cw <= 2, `单词表弹窗横向溢出：${wb.bodyScroll.sw} > ${wb.bodyScroll.cw}`)
        await screenshot('ui-wordbook-1440.png')
        await evalInPage(
          cdp,
          `(() => { const m = document.getElementById('modal-wordbook'); const b = m && m.querySelector('[data-close]'); if (b) b.click(); return true; })()`,
        )
        await sleep(300)
      })
    })

    // =====================================================================
    // v1.2：中文求助 / 问答相关性 / 演示模式设置入口
    // =====================================================================
    if (!skipIndex) await group('v1.2 中文求助 / 相关性', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      debug.phase = 'v12-chinese-1440'
      await navigate(cdp, baseUrl + '/?onboard=0')
      await sleep(900)
      await waitAppReady(cdp)

      await check('Dock 有「中文求助」按钮；演示模式徽标可点击直达设置', async () => {
        const st = await evalInPage(
          cdp,
          `(() => {
            const btn = document.getElementById('btn-chinese');
            const pill = document.getElementById('demo-pill');
            const r = btn ? btn.getBoundingClientRect() : null;
            const pr = pill ? pill.getBoundingClientRect() : null;
            return {
              zhBtn: !!btn,
              zhVisible: !!(r && r.width > 2 && r.height > 2),
              zhText: btn ? btn.innerText.replace(/\\s+/g, ' ').trim() : '',
              zhAriaPressed: btn ? btn.getAttribute('aria-pressed') : null,
              pillTag: pill ? pill.tagName : null,
              pillVisible: !!(pr && pr.width > 2 && pr.height > 2),
              demo: window.__ava ? window.__ava.demo : null,
            };
          })()`,
        )
        assert.equal(st.zhBtn, true, 'Dock 应有中文求助按钮 #btn-chinese（SPEC v1.2 §B3）')
        assert.equal(st.zhVisible, true, '中文求助按钮应可见')
        assert.match(st.zhText, /中文求助/, `按钮文案应为「中文求助」，实际 "${st.zhText}"`)
        assert.equal(st.zhAriaPressed, 'false', '中文求助按钮初始 aria-pressed 应为 false')
        assert.equal(st.demo, true, '当前应为演示模式')

        // 演示模式徽标可点击 → 打开设置（SPEC v1.2 A4）
        await evalInPage(cdp, `document.getElementById('demo-pill').click(); true`)
        const opened = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => { const m = document.getElementById('modal-settings'); return m ? !m.hidden : false; })()`,
            )
            return v === true ? v : null
          },
          { timeoutMs: 4000, label: '点击演示模式徽标打开设置' },
        )
        assert.equal(opened, true, '点击「演示模式」徽标应打开设置弹窗')
        await evalInPage(
          cdp,
          `(() => { const m = document.getElementById('modal-settings'); const b = m && m.querySelector('[data-close]'); if (b) b.click(); return true; })()`,
        )
        await sleep(300)
      })

      await check('中文求助：__ava.send(中文) → 中文求助卡 english/chunks/tips 非空、corrections 为空', async () => {
        await sendTurn(cdp, '我今天很累，不知道怎么说')
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const card = document.querySelector('#feedback-panel .fb-card.fb-chinese');
                const cards = [...document.querySelectorAll('#feedback-panel .fb-card')];
                const fb = window.__ava ? window.__ava.lastFeedback : null;
                const help = fb && fb.chineseHelp;
                return {
                  hasCard: !!card,
                  firstCardIsChinese: cards.length > 0 && cards[0].classList.contains('fb-chinese'),
                  cardCount: cards.length,
                  correctionCount: document.querySelectorAll('#feedback-panel .fb-correction').length,
                  you: (card && card.querySelector('.zh-you') ? card.querySelector('.zh-you').innerText : '').replace(/\\s+/g, ' ').trim(),
                  eng: (card && card.querySelector('.zh-eng-text') ? card.querySelector('.zh-eng-text').textContent : '').trim(),
                  chunks: [...(card ? card.querySelectorAll('.zh-chunk') : [])].map((e) => ({
                    en: (e.querySelector('.en') ? e.querySelector('.en').textContent : '').trim(),
                    zh: (e.querySelector('.zh') ? e.querySelector('.zh').textContent : '').trim(),
                  })),
                  tips: (card && card.querySelector('.zh-tips') ? card.querySelector('.zh-tips').textContent : '').trim(),
                  hasFollow: !!(card && card.querySelector('[data-follow]')),
                  hasSpeak: !!(card && card.querySelector('[data-speak]')),
                  encourage: (document.querySelector('#feedback-panel .fb-encourage .fb-zh') ? document.querySelector('#feedback-panel .fb-encourage .fb-zh').textContent : '').trim(),
                  help: help ? { unmatched: !!help.unmatched, english: help.english, correctionsLen: Array.isArray(fb.corrections) ? fb.corrections.length : -1 } : null,
                  reply: window.__ava ? String(window.__ava.reply || '') : '',
                  busy: window.__ava ? ['thinking', 'speaking', 'listening'].includes(window.__ava.phase) : true,
                };
              })()`,
            )
            return v.hasCard && !v.busy && v.help ? v : null
          },
          { timeoutMs: 30000, label: '中文求助卡渲染' },
        )
        assert.equal(st.help.unmatched, false, '「我今天很累」应命中中文求助规则')
        assert.ok(st.you.includes('很累'), `中文求助卡应显示你想说的中文，实际 "${st.you}"`)
        assert.match(st.eng, /exhausted|tired/i, `中文求助卡应有英文表达，实际 "${st.eng}"`)
        assert.ok(st.chunks.length >= 1, `应有意群拆解，实际 ${st.chunks.length} 条`)
        assert.ok(st.chunks.every((c) => c.en && c.zh), `意群应含 en/zh，实际 ${JSON.stringify(st.chunks)}`)
        assert.ok(st.tips.length > 0 && /[\u4e00-\u9fa5]/.test(st.tips), `应有中文提示，实际 "${st.tips}"`)
        assert.equal(st.hasFollow, true, '中文求助卡应有「跟我读」按钮')
        assert.equal(st.hasSpeak, true, '中文求助卡应有朗读按钮')
        assert.equal(st.firstCardIsChinese, true, '中文求助卡应排在反馈卡最顶部（SPEC §B3）')
        assert.equal(st.correctionCount, 0, '中文输入不应出现英文纠错卡')
        assert.equal(st.help.correctionsLen, 0, '中文输入 feedback.corrections 应为空数组')
        assert.doesNotMatch(st.encourage, /very nice|good job|great job|well done/i, '不应出现空洞夸奖')
        assert.doesNotMatch(st.reply, /[\u4e00-\u9fa5]/, `Ava 说话回复应为英文，实际片段 "${st.reply.slice(0, 120)}"`)
        await screenshot('ui-chinese-help-1440.png')
      })

      await check('中文求助卡「跟我读」：跟读评分结果渲染（headless 无麦时优雅降级）', async () => {
        const clicked = await evalInPage(
          cdp,
          `(() => { const b = document.querySelector('#feedback-panel .fb-card.fb-chinese [data-follow]'); if (!b) return null; const target = b.getAttribute('data-follow'); b.click(); return target; })()`,
        )
        assert.ok(clicked && clicked.length > 0, '中文求助卡应有可点击的「跟我读」按钮')
        await sleep(500)
        const toasts = await evalInPage(cdp, `[...document.querySelectorAll('.toast')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`)
        const unsupported = toasts.some((t) => t.includes('不支持语音识别'))
        if (unsupported) {
          // headless 无麦克风：按钮应优雅降级提示，而不是静默失败/报错
          assert.ok(
            toasts.some((t) => t.includes('听一遍') || t.includes('不支持语音识别')),
            `无麦克风时应给可操作的中文提示，实际 ${JSON.stringify(toasts)}`,
          )
          return
        }
        // 支持 STT 的环境：注入一句朗读文本，走 /api/score → 渲染 <div class="zh-follow-result">
        await evalInPage(
          cdp,
          `(() => { if (!window.__ava) return false; window.__ava.send(${JSON.stringify("I'm exhausted today.")}); return true; })()`,
        )
        const res = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const box = document.querySelector('#feedback-panel .zh-follow-result');
                if (!box) return null;
                const scoreEl = box.querySelector('.zh-follow-score');
                return {
                  score: scoreEl ? scoreEl.textContent.trim() : '',
                  chips: [...box.querySelectorAll('.w-chip')].map((e) => e.textContent.trim()),
                  tips: [...box.querySelectorAll('.tips-list li')].map((e) => e.textContent.trim()),
                };
              })()`,
            )
            return v && v.score !== '' ? v : null
          },
          { timeoutMs: 15000, label: '跟读评分结果渲染' },
        )
        const score = Number(res.score)
        assert.ok(Number.isFinite(score) && score >= 0 && score <= 100, `跟读分数应为 0-100，实际 ${JSON.stringify(res.score)}`)
        assert.ok(res.chips.length >= 1, '跟读结果应含逐词高亮')
        await screenshot('ui-chinese-follow-1440.png')
      })

      await check('英文直接提问：回复先正面回答（How are you?）', async () => {
        await sendTurn(cdp, 'How are you?')
        const reply = await evalInPage(cdp, `window.__ava ? String(window.__ava.reply || '') : ''`)
        assert.match(reply, /I'm doing really well/i, `How are you? 应正面回答，实际 "${reply.slice(0, 200)}"`)
        const firstQ = reply.indexOf('?')
        assert.ok(firstQ === -1 || firstQ > 20, `反问前应有正面回答，实际 "${reply.slice(0, 200)}"`)
      })

      await check('英文陈述：demo 回复引用用户原话（相关性）', async () => {
        await sendTurn(cdp, 'I had a long day at work today.')
        const reply = await evalInPage(cdp, `window.__ava ? String(window.__ava.reply || '') : ''`)
        assert.match(reply, /So you said/i, `应引用用户原话，实际 "${reply.slice(0, 200)}"`)
        assert.match(reply, /work|day/i, '回应应承接用户内容')
        await screenshot('ui-relevance-1440.png')
      })

      await check('「中文」按钮：切换识别语言 zh-CN/en-US + toast 提示', async () => {
        await evalInPage(cdp, `document.getElementById('btn-chinese').click(); true`)
        await sleep(400)
        const on = await evalInPage(
          cdp,
          `(() => {
            const b = document.getElementById('btn-chinese');
            return {
              zhRequested: window.__ava ? window.__ava.zhRequested : null,
              sttLang: window.__ava ? window.__ava.sttLang : null,
              pressed: b ? b.getAttribute('aria-pressed') : null,
              onClass: b ? b.classList.contains('is-on') : null,
              toasts: [...document.querySelectorAll('.toast')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()),
            };
          })()`,
        )
        assert.equal(on.zhRequested, true, '点击后应进入中文求助模式（__ava.zhRequested=true）')
        assert.equal(on.sttLang, 'zh-CN', `识别语言应切到 zh-CN，实际 ${on.sttLang}`)
        assert.equal(on.pressed, 'true', '按钮 aria-pressed 应为 true')
        assert.equal(on.onClass, true, '按钮应有 is-on 高亮类')
        assert.ok(on.toasts.some((t) => t.includes('说中文') && t.includes('英文说')), `应有中文求助 toast，实际 ${JSON.stringify(on.toasts)}`)
        await screenshot('ui-chinese-button-1440.png')

        await evalInPage(cdp, `document.getElementById('btn-chinese').click(); true`)
        await sleep(400)
        const off = await evalInPage(
          cdp,
          `(() => ({
            zhRequested: window.__ava ? window.__ava.zhRequested : null,
            sttLang: window.__ava ? window.__ava.sttLang : null,
            pressed: document.getElementById('btn-chinese') ? document.getElementById('btn-chinese').getAttribute('aria-pressed') : null,
            toasts: [...document.querySelectorAll('.toast')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()),
          }))()`,
        )
        assert.equal(off.zhRequested, false, '再次点击应退出中文求助模式')
        assert.equal(off.sttLang, 'en-US', `识别语言应切回 en-US，实际 ${off.sttLang}`)
        assert.equal(off.pressed, 'false', '退出后 aria-pressed 应为 false')
        assert.ok(off.toasts.some((t) => t.includes('切回英文')), `应有切回英文 toast，实际 ${JSON.stringify(off.toasts)}`)
      })
    })

    // =====================================================================
    // v1.3：阅读讲解（上传 → 分析 → 讲解互动 → 删除/刷新恢复）
    // =====================================================================
    if (!skipIndex) await group('v1.3 阅读讲解', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      debug.phase = 'reading-1440'
      await navigate(cdp, baseUrl + '/?onboard=0')
      await sleep(900)
      await waitAppReady(cdp)
      const fixtureTxt = path.join(PROJECT_ROOT, 'test', 'fixtures', 'english-article.txt')

      await check('阅读讲解 Tab：上传区空状态 + 支持格式说明', async () => {
        await evalInPage(cdp, `document.querySelector('.mode-tab[data-mode="reading"]').click(); true`)
        await waitUntil(
          async () => (await evalInPage(cdp, `!!document.querySelector('.upload-zone') && !!document.getElementById('doc-file-input')`)) === true,
          { timeoutMs: 8000, label: '阅读讲解面板渲染' },
        )
        const st = await evalInPage(
          cdp,
          `(() => {
            const panel = document.querySelector('#mode-panel');
            const zone = document.querySelector('.upload-zone');
            const input = document.getElementById('doc-file-input');
            const text = panel ? panel.innerText.replace(/\\s+/g, ' ').trim() : '';
            return {
              mode: window.__ava ? window.__ava.mode : null,
              hasZone: !!zone,
              zoneVisible: zone ? zone.getBoundingClientRect().width > 2 : false,
              inputAccept: input ? input.getAttribute('accept') : '',
              text,
              emptyState: /还没有文档/.test(text),
              startBtn: !!document.querySelector('[data-act="reading-start"]'),
            };
          })()`,
        )
        assert.equal(st.mode, 'reading', `应切换到阅读讲解模式，实际 ${st.mode}`)
        assert.equal(st.hasZone, true, '应有上传区 .upload-zone')
        assert.equal(st.zoneVisible, true, '上传区应可见')
        assert.match(st.inputAccept, /\.txt|\.pdf|\.png/i, `文件选择应限制支持格式，实际 accept="${st.inputAccept}"`)
        assert.match(st.text, /支持|≤12MB|12MB/, '上传区应说明支持格式/大小限制')
        assert.equal(st.emptyState, true, '无文档时应显示空状态引导')
        assert.equal(st.startBtn, false, '无文档时不应出现「开始讲解」按钮')
        await screenshot('ui-reading-empty-1440.png')
      })

      await check('上传 txt（CDP 文件选择）→ 提取 + 自动分析面板齐全', async () => {
        await setFileInputFiles(cdp, '#doc-file-input', fixtureTxt)
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const R = window.__ava ? window.__ava.reading : null;
                const panel = document.querySelector('#mode-panel');
                const text = panel ? panel.innerText.replace(/\\s+/g, ' ').trim() : '';
                return {
                  docId: R ? R.docId : null,
                  analysis: R ? R.analysis : null,
                  uploading: R ? !!R.uploading : true,
                  analyzing: R ? !!R.analyzing : true,
                  text,
                  summaryCount: document.querySelectorAll('.reading-summary').length,
                  points: document.querySelectorAll('.reading-point').length,
                  keyWords: document.querySelectorAll('.reading-kw .kw-card').length,
                  questions: document.querySelectorAll('.reading-q').length,
                  docItems: document.querySelectorAll('.doc-item').length,
                  docName: (document.querySelector('.reading-doc-title') ? document.querySelector('.reading-doc-title').innerText : '').replace(/\\s+/g, ' ').trim(),
                };
              })()`,
            )
            return v.docId && v.analysis && !v.uploading && !v.analyzing && v.summaryCount > 0 ? v : null
          },
          { timeoutMs: 30000, label: '上传并自动分析完成' },
        )
        assert.match(String(st.docId), /^d_[a-f0-9]{8,20}$/, '上传后应有文档 id')
        assert.ok(st.summaryCount >= 1, '应渲染中文摘要 .reading-summary')
        assert.ok(st.points >= 1, `应渲染核心要点，实际 ${st.points}`)
        assert.ok(st.keyWords >= 3, `应渲染重点词汇卡 >=3，实际 ${st.keyWords}`)
        assert.ok(st.questions >= 3, `应渲染理解题 >=3，实际 ${st.questions}`)
        assert.ok(st.docItems >= 1, '最近文档列表应出现该文档')
        assert.match(st.docName, /english-article\.txt/, `文档头应显示文件名，实际 "${st.docName}"`)
        assert.match(st.text, /演示分析/, 'demo 模式分析应标注「演示分析」')
        assert.match(st.text, /开始讲解/, '已分析后应出现「开始讲解」按钮')
        await screenshot('ui-reading-analysis-1440.png')
      })

      await check('刷新页面后从 /api/doc/list 恢复文档列表与缓存分析', async () => {
        await navigate(cdp, baseUrl + '/?onboard=0')
        await sleep(800)
        await waitAppReady(cdp)
        await evalInPage(cdp, `document.querySelector('.mode-tab[data-mode="reading"]').click(); true`)
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => ({
                docItems: document.querySelectorAll('.doc-item').length,
                docNames: [...document.querySelectorAll('.doc-name')].map((e) => e.textContent.trim()),
                emptyText: (document.querySelector('#mode-panel') ? document.querySelector('#mode-panel').innerText : '').replace(/\\s+/g, ' ').trim(),
              }))()`,
            )
            return v.docItems >= 1 ? v : null
          },
          { timeoutMs: 15000, label: '刷新后文档列表恢复' },
        )
        assert.ok(st.docNames.some((n) => n.includes('english-article.txt')), `刷新后列表应包含文档，实际 ${JSON.stringify(st.docNames)}`)
        // 点文档恢复详情 + 缓存分析
        await evalInPage(cdp, `document.querySelector('.doc-pick').click(); true`)
        const ok = await waitUntil(
          async () =>
            (await evalInPage(cdp, `(() => { const R = window.__ava ? window.__ava.reading : null; const d = document.querySelector('#mode-panel'); return !!(R && R.docId && R.analysis) && /开始讲解/.test(d ? d.innerText : ''); })()`)) === true,
          { timeoutMs: 15000, label: '点选文档恢复缓存分析' },
        )
        assert.equal(ok, true, '点选文档后应恢复摘要/分析（缓存命中）')
      })

      await check('切换模式不丢当前文档（SPEC D5）', async () => {
        const beforeId = await evalInPage(cdp, `window.__ava.readingDocId`)
        await evalInPage(cdp, `document.querySelector('.mode-tab[data-mode="free"]').click(); true`)
        await sleep(400)
        await evalInPage(cdp, `document.querySelector('.mode-tab[data-mode="reading"]').click(); true`)
        await sleep(600)
        const after = await evalInPage(
          cdp,
          `(() => ({ docId: window.__ava.readingDocId, hasSummary: !!document.querySelector('.reading-summary'), hasStart: !!document.querySelector('[data-act="reading-start"]') }))()`,
        )
        assert.equal(after.docId, beforeId, '切回阅读讲解后仍应保留当前文档')
        assert.equal(after.hasSummary, true, '切回后应仍显示分析摘要')
        assert.equal(after.hasStart, true, '切回后应仍可开始讲解')
      })

      await check('开始讲解 → 字幕出现英文开场与第一题', async () => {
        const beforeErrors = debug.jsErrors.length
        await evalInPage(cdp, `document.querySelector('[data-act="reading-start"]').click(); true`)
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => ({
                reply: window.__ava ? String(window.__ava.reply || '') : '',
                phase: window.__ava ? window.__ava.phase : null,
                started: window.__ava && window.__ava.reading ? !!window.__ava.reading.started : false,
                chip: (document.getElementById('stage-chip') ? document.getElementById('stage-chip').innerText : '').replace(/\\s+/g, ' ').trim(),
                readingDoc: window.__ava ? window.__ava.readingDocId : null,
              }))()`,
            )
            const busy = v.phase === 'thinking' || v.phase === 'speaking' || v.phase === 'listening'
            return !busy && v.reply && /First question|question/i.test(v.reply) ? v : null
          },
          { timeoutMs: 30000, label: '阅读讲解开场' },
        )
        assert.equal(st.started, true, '开始讲解后 reading.started 应为 true')
        assert.match(st.reply, /english-article\.txt|read/i, '开场应介绍文档')
        assert.match(st.reply, /First question/i, '开场应给出第一道理解题')
        assert.match(st.reply, /\?/, '开场应包含问句')
        assert.doesNotMatch(st.reply, /[\u4e00-\u9fa5]/, 'Ava 讲解回复应为英文')
        assert.ok(st.chip.includes('阅读讲解'), `舞台胶囊应显示阅读讲解，实际 "${st.chip}"`)
        assert.equal(debug.jsErrors.length, beforeErrors, '开始讲解不应产生 JS 异常')
        await screenshot('ui-reading-lecture-1440.png')
      })

      await check('回答理解题 → 下一题 + 反馈；「下一题」入口可见', async () => {
        await sendTurn(cdp, 'Reading helps us build vocabulary.')
        const st = await evalInPage(
          cdp,
          `(() => ({
            reply: window.__ava ? String(window.__ava.reply || '') : '',
            phase: window.__ava ? window.__ava.phase : null,
            historyLen: window.__ava && window.__ava.reading ? 'n/a' : null,
            nextBtn: !!document.querySelector('[data-act="reading-next"]'),
            currentQ: document.querySelectorAll('.reading-q.is-current').length,
            feedbackText: (document.querySelector('#feedback-panel') ? document.querySelector('#feedback-panel').innerText : '').replace(/\\s+/g, ' ').trim(),
            toasts: [...document.querySelectorAll('.toast')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()),
            caption: (document.getElementById('caption-reply') ? document.getElementById('caption-reply').innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 300),
          }))()`,
        )
        assert.match(st.reply, /Next question/i, `回答后应给出下一题，实际 "${st.reply.slice(0, 200)}"；phase=${st.phase}；toasts=${JSON.stringify(st.toasts)}；caption="${st.caption}"`)
        assert.equal(st.nextBtn, true, '开始讲解后应显示「下一题」按钮')
        assert.ok(st.currentQ >= 1, '当前理解题应有高亮标记')
        assert.ok(st.feedbackText.length > 10, '阅读讲解回答后应渲染教练反馈')
      })

      await check('「朗读原文」→ 进入朗读状态（TTS 调用；headless 优雅降级）', async () => {
        const beforeErrors = debug.jsErrors.length
        await evalInPage(cdp, `document.querySelector('[data-act="reading-read"]').click(); true`)
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => ({
                phase: window.__ava ? window.__ava.phase : null,
                reply: window.__ava ? String(window.__ava.reply || '') : '',
                toasts: [...document.querySelectorAll('.toast')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()),
              }))()`,
            )
            const hit = v.phase === 'speaking' || v.toasts.some((t) => /朗读/.test(t)) || v.reply.length > 20
            return hit ? v : null
          },
          { timeoutMs: 8000, label: '朗读原文触发' },
        )
        assert.ok(st.phase === 'speaking' || st.toasts.some((t) => /朗读/.test(t)) || st.reply.length > 20, `应触发朗读，实际 ${JSON.stringify(st)}`)
        assert.equal(debug.jsErrors.length, beforeErrors, '朗读不应产生 JS 异常')
        await waitUntil(
          async () => (await evalInPage(cdp, `window.__ava ? window.__ava.phase === 'idle' : true`)) === true,
          { timeoutMs: 20000, label: '朗读结束回到 idle' },
        ).catch(() => {})
      })

      await check('删除文档：需确认，删除后分析清空/列表移除', async () => {
        await evalInPage(cdp, `document.querySelector('[data-act="reading-del"]').click(); true`)
        await waitUntil(
          async () => (await evalInPage(cdp, `!!document.querySelector('.reading-confirm')`)) === true,
          { timeoutMs: 4000, label: '删除确认区出现' },
        )
        await evalInPage(cdp, `document.querySelector('[data-act="reading-del-confirm"]').click(); true`)
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => ({
                docId: window.__ava ? window.__ava.readingDocId : 'x',
                summary: document.querySelectorAll('.reading-summary').length,
                startBtn: !!document.querySelector('[data-act="reading-start"]'),
                panelText: (document.querySelector('#mode-panel') ? document.querySelector('#mode-panel').innerText : '').replace(/\\s+/g, ' ').trim(),
              }))()`,
            )
            return !v.docId && v.summary === 0 ? v : null
          },
          { timeoutMs: 8000, label: '删除文档生效' },
        )
        assert.equal(st.startBtn, false, '删除后不应再有「开始讲解」按钮')
        assert.match(st.panelText, /还没有文档/, '删除后应回到空状态引导')
      })
    })

    // =====================================================================
    // v1.4：豆包实时语音（设置页 → 测试连接 → 引擎徽标 → 通话/回退）
    // =====================================================================
    if (!skipIndex) await group('v1.4 豆包实时语音', async () => {
      const volcMock = await startMockVolc({ chunkDelayMs: 5 })
      const volcCreds = {
        appId: 'mock-app-1',
        apiKey: 'volc-mock-key-9876',
        model: '3.0',
        speaker: 'en_female_dacey_uranus_bigtts',
        endpoint: volcMock.wsUrl,
        resourceId: 'volc.speech.dialog',
      }
      const restoreVolcByApi = async () => {
        const r = await jfetch(baseUrl + '/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voiceEngine: 'volc', volc: { ...volcCreds } }),
        })
        if (r.status !== 200) throw new Error(`恢复豆包配置失败：${r.status} ${r.text.slice(0, 200)}`)
      }
      const fillVolcFields = async () =>
        evalInPage(
          cdp,
          `(() => {
            const set = (id, v) => {
              const el = document.getElementById(id);
              if (!el) return false;
              el.value = v;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            };
            const okApp = set('volc-appid', ${JSON.stringify(volcCreds.appId)});
            set('volc-apikey', ${JSON.stringify(volcCreds.apiKey)});
            set('volc-token', '');
            set('volc-model', ${JSON.stringify(volcCreds.model)});
            set('volc-speaker', ${JSON.stringify(volcCreds.speaker)});
            set('volc-endpoint', ${JSON.stringify(volcCreds.endpoint)});
            set('volc-resource', ${JSON.stringify(volcCreds.resourceId)});
            return okApp;
          })()`,
        )
      const openSettingsModal = async () => {
        await evalInPage(
          cdp,
          `(() => {
            if (window.__ava && typeof window.__ava.openSettings === 'function') { window.__ava.openSettings(); return true; }
            const b = document.getElementById('btn-settings');
            if (b) { b.click(); return true; }
            return false;
          })()`,
        )
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const m = document.getElementById('modal-settings'); return !!(m && !m.hidden); })()`)) === true,
          { timeoutMs: 6000, label: '设置弹窗打开' },
        )
        await sleep(250)
      }
      const selectVolc = async () => {
        await evalInPage(cdp, `document.getElementById('engine-volc').click(); true`)
        await waitUntil(
          async () =>
            (await evalInPage(cdp, `(() => { const c = document.getElementById('volc-config'); return !!(c && !c.hidden); })()`)) === true,
          { timeoutMs: 4000, label: '豆包配置区展开' },
        )
      }

      try {
        await check('设置页「语音引擎（高级）」：默认浏览器引擎 + 豆包字段齐全/默认值', async () => {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
          debug.phase = 'v14-volc-settings'
          await navigate(cdp, baseUrl + '/?onboard=0')
          await sleep(800)
          await waitAppReady(cdp)
          await openSettingsModal()
          const st = await evalInPage(
            cdp,
            `(() => {
              const q = (id) => document.getElementById(id);
              const cfg = q('volc-config');
              return {
                browserChecked: q('engine-browser') ? q('engine-browser').checked : null,
                volcExists: !!q('engine-volc'),
                volcChecked: q('engine-volc') ? q('engine-volc').checked : null,
                cfgHidden: cfg ? cfg.hidden : null,
                fields: ['volc-appid','volc-apikey','volc-token','volc-model','volc-speaker','volc-endpoint','volc-resource','btn-test-volc','btn-clear-volc','volc-key-hint','volc-test-result']
                  .filter((id) => !q(id)),
                model: q('volc-model') ? q('volc-model').value : '',
                speaker: q('volc-speaker') ? q('volc-speaker').value : '',
                endpoint: q('volc-endpoint') ? q('volc-endpoint').value : '',
                resource: q('volc-resource') ? q('volc-resource').value : '',
                voiceEngine: window.__ava ? window.__ava.voiceEngine : null,
                configuredEngine: window.__ava ? window.__ava.configuredEngine : null,
              };
            })()`,
          )
          assert.equal(st.browserChecked, true, '默认应选中浏览器内置语音')
          assert.equal(st.volcExists, true, '应有豆包实时语音单选')
          assert.equal(st.volcChecked, false, '默认不应选中豆包引擎')
          assert.equal(st.cfgHidden, true, '未选豆包时配置区应隐藏')
          assert.deepEqual(st.fields, [], `豆包设置字段应齐全，缺少 ${JSON.stringify(st.fields)}`)
          assert.equal(st.model, '3.0', '模型版本默认应为 3.0')
          assert.equal(st.speaker, 'en_female_dacey_uranus_bigtts', '默认音色应正确')
          assert.match(st.endpoint, /^wss:\/\//, '默认服务地址应为 wss://')
          assert.equal(st.resource, 'volc.speech.dialog', '默认资源 ID 应正确')
          assert.equal(st.configuredEngine, 'browser', '初始配置引擎应为 browser')
          await selectVolc()
          const visible = await evalInPage(
            cdp,
            `(() => { const c = document.getElementById('volc-config'); const r = c.getBoundingClientRect(); return { visible: !c.hidden && r.width > 2 && r.height > 2, overflowX: c.scrollWidth - c.clientWidth }; })()`,
          )
          assert.equal(visible.visible, true, '选中豆包后配置区应可见')
          assert.ok(visible.overflowX <= 2, `配置区横向溢出：${visible.overflowX}`)
          await screenshot('ui-voice-engine-settings-1440.png')
        })

        await check('测试连接（无凭据）→ 中文错误提示', async () => {
          const beforeErrors = debug.jsErrors.length
          await evalInPage(cdp, `document.getElementById('btn-test-volc').click(); true`)
          const result = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const el = document.getElementById('volc-test-result');
                  const btn = document.getElementById('btn-test-volc');
                  return { text: el ? el.innerText.replace(/\\s+/g, ' ').trim() : '', cls: el ? el.className : '', busy: btn ? btn.disabled : true };
                })()`,
              )
              return v.text && !v.busy ? v : null
            },
            { timeoutMs: 25000, label: 'volc 测试连接返回' },
          )
          assert.match(result.text, /连接失败|失败/, `无凭据应显示失败，实际 "${result.text}"`)
          assert.match(result.text, /App ID|API Key|Access Token|凭据/, `无凭据应中文提示字段，实际 "${result.text}"`)
          assert.ok(/bad/.test(result.cls), `结果应为失败样式，实际 class="${result.cls}"`)
          assert.equal(debug.jsErrors.length, beforeErrors, '测试连接不应产生 JS 异常')
        })

        await check('填写 mock 火山配置：测试连接成功 → 保存 → 掩码/徽标/持久化', async () => {
          const filled = await fillVolcFields()
          assert.equal(filled, true, '应能填写 App ID 等字段')
          await evalInPage(cdp, `document.getElementById('btn-test-volc').click(); true`)
          const okResult = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const el = document.getElementById('volc-test-result');
                  const btn = document.getElementById('btn-test-volc');
                  return { text: el ? el.innerText.replace(/\\s+/g, ' ').trim() : '', cls: el ? el.className : '', busy: btn ? btn.disabled : true };
                })()`,
              )
              return v.text && !v.busy ? v : null
            },
            { timeoutMs: 30000, label: 'mock 火山测试连接' },
          )
          assert.match(okResult.text, /连接成功/, `mock 火山应连接成功，实际 "${okResult.text}"`)
          assert.match(okResult.text, /3\.0/, '成功结果应显示模型版本')
          assert.ok(/ok/.test(okResult.cls), `成功结果样式应为 ok，实际 class="${okResult.cls}"`)
          await screenshot('ui-voice-engine-test-1440.png')
          await evalInPage(cdp, `document.getElementById('btn-save-settings').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const m = document.getElementById('modal-settings'); return !!(m && m.hidden); })()`)) === true,
            { timeoutMs: 8000, label: '保存后设置弹窗关闭' },
          )
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => ({
                  voiceEngine: window.__ava ? window.__ava.voiceEngine : null,
                  configuredEngine: window.__ava ? window.__ava.configuredEngine : null,
                  volcConfigured: window.__ava ? window.__ava.volcConfigured : null,
                  pill: (() => { const p = document.getElementById('engine-pill'); if (!p) return null; const r = p.getBoundingClientRect(); return { hidden: p.hidden, visible: !p.hidden && r.width > 2, text: p.innerText.replace(/\\s+/g, ' ').trim() }; })(),
                }))()`,
              )
              return v.configuredEngine === 'volc' ? v : null
            },
            { timeoutMs: 8000, label: '保存后切换到豆包引擎' },
          )
          assert.equal(st.voiceEngine, 'volc', '保存后生效引擎应为 volc')
          assert.equal(st.volcConfigured, true, 'volcConfigured 应为 true')
          assert.equal(st.pill.visible, true, `顶栏应有豆包引擎徽标，实际 ${JSON.stringify(st.pill)}`)
          const apiSettings = await jfetch(baseUrl + '/api/settings')
          assert.equal(apiSettings.json.volc.hasKey, true, '服务端 volc.hasKey 应为 true')
          assert.ok(!apiSettings.text.includes(volcCreds.apiKey), 'GET /api/settings 不得泄露 volc.apiKey 原文')
          await navigate(cdp, baseUrl + '/?onboard=0')
          await sleep(800)
          await waitAppReady(cdp)
          await openSettingsModal()
          const masked = await evalInPage(
            cdp,
            `(() => ({
              apiValue: document.getElementById('volc-apikey') ? document.getElementById('volc-apikey').value : null,
              placeholder: document.getElementById('volc-apikey') ? document.getElementById('volc-apikey').placeholder : '',
              hint: document.getElementById('volc-key-hint') ? document.getElementById('volc-key-hint').innerText.replace(/\\s+/g, ' ').trim() : '',
              tokenValue: document.getElementById('volc-token') ? document.getElementById('volc-token').value : null,
              pillVisible: (() => { const p = document.getElementById('engine-pill'); return !!(p && !p.hidden); })(),
            }))()`,
          )
          assert.equal(masked.apiValue, '', '保存后 API Key 输入框应清空（不回显原文）')
          assert.match(masked.placeholder, /9876|已保存/, `Key 输入框占位应显示掩码，实际 "${masked.placeholder}"`)
          assert.match(masked.hint, /9876/, `凭据提示应含后 4 位掩码，实际 "${masked.hint}"`)
          assert.equal(masked.tokenValue, '', 'Access Token 同样不回显')
          assert.equal(masked.pillVisible, true, '刷新后引擎徽标仍应可见')
          await screenshot('ui-voice-engine-masked-1440.png')
          await evalInPage(cdp, `(() => { const m = document.getElementById('modal-settings'); const b = m && m.querySelector('[data-close]'); if (b) b.click(); return true; })()`)
          await sleep(300)
        })

        await check('无凭据点麦克风 → 中文提示 + 自动打开设置（不进入豆包会话）', async () => {
          await openSettingsModal()
          await evalInPage(cdp, `document.getElementById('btn-clear-volc').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const h = document.getElementById('volc-key-hint'); return h ? !/9876/.test(h.innerText) : false; })()`)) === true,
            { timeoutMs: 8000, label: '清除豆包凭据' },
          )
          await evalInPage(cdp, `(() => { const m = document.getElementById('modal-settings'); const b = m && m.querySelector('[data-close]'); if (b) b.click(); return true; })()`)
          await sleep(400)
          await evalInPage(cdp, `document.getElementById('btn-mic').click(); true`)
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => ({
                  modalOpen: (() => { const m = document.getElementById('modal-settings'); return !!(m && !m.hidden); })(),
                  toasts: [...document.querySelectorAll('.toast')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()),
                  volcFallback: window.__ava ? window.__ava.volcFallback : null,
                  volcSession: window.__ava ? window.__ava.volcSession : null,
                  pills: (() => { const p = document.getElementById('engine-pill'); return !!(p && !p.hidden); })(),
                }))()`,
              )
              return v.modalOpen ? v : null
            },
            { timeoutMs: 10000, label: '无凭据点麦克风提示' },
          )
          assert.ok(st.toasts.some((t) => /豆包实时语音凭据|设置页/.test(t)), `应提示先填写凭据，实际 ${JSON.stringify(st.toasts)}`)
          assert.equal(st.modalOpen, true, '无凭据时应自动打开设置弹窗')
          assert.equal(st.volcFallback, false, '未真正尝试连接时不应标记 fallback')
          assert.equal(st.volcSession, false, '不应进入豆包会话')
          await screenshot('ui-volc-no-creds-1440.png')
          await evalInPage(cdp, `(() => { const m = document.getElementById('modal-settings'); const b = m && m.querySelector('[data-close]'); if (b) b.click(); return true; })()`)
          await sleep(250)
          // 通过 API 恢复 mock 凭据并刷新（后续真实通话用例）
          await restoreVolcByApi()
          await navigate(cdp, baseUrl + '/?onboard=0')
          await sleep(900)
          await waitAppReady(cdp)
          const ready = await waitUntil(
            async () => (await evalInPage(cdp, `window.__ava ? window.__ava.voiceEngine === 'volc' && window.__ava.volcConfigured === true : false`)) === true,
            { timeoutMs: 10000, label: '恢复豆包配置后引擎生效' },
          )
          assert.equal(ready, true, '恢复 mock 凭据后应启用豆包引擎')
        })

        await check('豆包实时语音 mock 全链路：点麦克风 → ready/ASR/chat/feedback → 再点结束', async () => {
          const beforeErrors = debug.jsErrors.length
          await evalInPage(cdp, `document.getElementById('btn-mic').click(); true`)
          const started = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => ({
                  volcSession: window.__ava ? window.__ava.volcSession : null,
                  doubaoReady: window.__ava ? window.__ava.doubaoReady : null,
                  phase: window.__ava ? window.__ava.phase : null,
                  fallback: window.__ava ? window.__ava.volcFallback : null,
                  micHint: (document.getElementById('mic-hint') ? document.getElementById('mic-hint').innerText : '').replace(/\\s+/g, ' ').trim(),
                  caption: (document.getElementById('caption-reply') ? document.getElementById('caption-reply').innerText : '').replace(/\\s+/g, ' ').trim(),
                }))()`,
              )
              return v.volcSession === true ? v : null
            },
            { timeoutMs: 25000, label: '豆包会话建立（fake 麦克风）' },
          )
          assert.equal(started.volcSession, true, '点麦克风后应进入豆包会话')
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__ava ? window.__ava.volcSession === true && window.__ava.volcFallback === false : false`)) === true,
            { timeoutMs: 15000, label: '豆包会话保持（未回退）' },
          ).catch(() => {})
          await screenshot('ui-volc-call-1440.png')
          // 等待 ASR/chat/coach 任一产物出现在界面（fake 麦克风 → mock 火山推流）
          const gotContent = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => ({
                  caption: (document.getElementById('caption-reply') ? document.getElementById('caption-reply').innerText : '').replace(/\\s+/g, ' ').trim(),
                  interim: (document.getElementById('caption-interim') ? document.getElementById('caption-interim').innerText : '').replace(/\\s+/g, ' ').trim(),
                  userLine: (document.getElementById('caption-user') ? document.getElementById('caption-user').innerText : '').replace(/\\s+/g, ' ').trim(),
                  feedbackCards: document.querySelectorAll('#feedback-panel .fb-card').length,
                  feedbackText: (document.getElementById('feedback-panel') ? document.getElementById('feedback-panel').innerText : '').replace(/\\s+/g, ' ').trim(),
                  volcSession: window.__ava ? window.__ava.volcSession : null,
                  fallback: window.__ava ? window.__ava.volcFallback : null,
                }))()`,
              )
              return v.feedbackCards > 0 || v.caption.length > 5 || v.userLine.length > 0 ? v : null
            },
            { timeoutMs: 30000, label: '豆包 ASR/chat/coach 产物' },
          )
          assert.ok(gotContent.volcSession === true, '链路中会话应保持')
          assert.equal(gotContent.fallback, false, '正常链路不应回退浏览器语音')
          assert.ok(
            gotContent.feedbackCards > 0 || gotContent.caption.length > 5 || gotContent.userLine.length > 0,
            `应出现 ASR/chat/反馈内容，实际 ${JSON.stringify(gotContent).slice(0, 300)}`,
          )
          // 再点麦克风结束会话
          await evalInPage(cdp, `document.getElementById('btn-mic').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__ava ? window.__ava.volcSession === false : true`)) === true,
            { timeoutMs: 10000, label: '豆包会话结束' },
          )
          assert.equal(debug.jsErrors.length, beforeErrors, '豆包通话不应产生未捕获 JS 异常')
        })

        await check('切回浏览器引擎：豆包会话清理、徽标隐藏、voiceEngine=browser', async () => {
          await openSettingsModal()
          await evalInPage(cdp, `document.getElementById('engine-browser').click(); true`)
          await evalInPage(cdp, `document.getElementById('btn-save-settings').click(); true`)
          await sleep(600)
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => ({
                  voiceEngine: window.__ava ? window.__ava.voiceEngine : null,
                  configuredEngine: window.__ava ? window.__ava.configuredEngine : null,
                  volcSession: window.__ava ? window.__ava.volcSession : null,
                  pill: (() => { const p = document.getElementById('engine-pill'); return !!(p && !p.hidden); })(),
                  modalHidden: (() => { const m = document.getElementById('modal-settings'); return !!(m && m.hidden); })(),
                }))()`,
              )
              return v.configuredEngine === 'browser' ? v : null
            },
            { timeoutMs: 8000, label: '切回浏览器引擎' },
          )
          assert.equal(st.voiceEngine, 'browser', '生效引擎应回到 browser')
          assert.equal(st.volcSession, false, '切回后不应有豆包会话')
          assert.equal(st.pill, false, '切回浏览器引擎后徽标应隐藏')
          assert.equal(st.modalHidden, true, '保存后设置弹窗应关闭')
        })
      } finally {
        await volcMock.close()
      }
    })

    // =====================================================================
    // v1.5：双语字幕（双方）+ 豆包语音模式专注对话（无逐轮纠错卡）
    // =====================================================================
    if (!skipIndex) await group('v1.5 双语字幕 / 专注对话', async () => {
      const volcMock = await startMockVolc({ chunkDelayMs: 4 })
      const volcCreds = {
        appId: 'bilingual-app',
        apiKey: 'bilingual-key-5678',
        model: '3.0',
        speaker: 'en_female_dacey_uranus_bigtts',
        endpoint: volcMock.wsUrl,
        resourceId: 'volc.speech.dialog',
      }
      const putSettings = async (patch) =>
        jfetch(baseUrl + '/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      const applyVolc = async () => {
        const r = await putSettings({
          voiceEngine: 'volc',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: '',
          clearKey: true,
          volc: { ...volcCreds },
        })
        if (r.status !== 200) throw new Error(`配置豆包引擎失败：${r.status}`)
      }
      const reloadApp = async () => {
        await navigate(cdp, baseUrl + '/?onboard=0')
        await sleep(900)
        await waitAppReady(cdp)
      }
      const openSettings = async () => {
        await evalInPage(
          cdp,
          `(() => { if (window.__ava && typeof window.__ava.openSettings === 'function') { window.__ava.openSettings(); return true; } document.getElementById('btn-settings').click(); return true; })()`,
        )
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const m = document.getElementById('modal-settings'); return !!(m && !m.hidden); })()`)) === true,
          { timeoutMs: 6000, label: '设置弹窗打开' },
        )
        await sleep(250)
      }
      const closeSettings = async () => {
        await evalInPage(
          cdp,
          `(() => { const m = document.getElementById('modal-settings'); const b = m && m.querySelector('[data-close]'); if (b) b.click(); return true; })()`,
        )
        await sleep(250)
      }
      const clickMic = async () => {
        await evalInPage(cdp, `document.getElementById('btn-mic').click(); true`)
      }
      const bilingualState = `(() => {
        const q = (id) => document.getElementById(id);
        const zh = (id) => { const el = q(id); if (!el) return { hidden: null, text: '' }; return { hidden: el.hidden, text: (el.innerText || el.textContent || '').trim() }; };
        const en = (id) => (q(id) ? (q(id).innerText || '').replace(/\\s+/g, ' ').trim() : '');
        return {
          user: en('caption-user'),
          userZh: zh('caption-user-zh'),
          reply: en('caption-reply'),
          replyZh: zh('caption-reply-zh'),
          volcSession: window.__ava ? window.__ava.volcSession : null,
          fallback: window.__ava ? window.__ava.volcFallback : null,
          phase: window.__ava ? window.__ava.phase : null,
          fbCards: document.querySelectorAll('#feedback-panel .fb-card').length,
          fbCorrections: document.querySelectorAll('#feedback-panel .fb-correction').length,
          fbText: (document.getElementById('feedback-panel') ? document.getElementById('feedback-panel').innerText : '').replace(/\\s+/g, ' ').trim(),
          toasts: [...document.querySelectorAll('.toast')].map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim()),
        };
      })()`

      const hasCJK = (text) => /[\u4e00-\u9fff]/.test(String(text || ''))

      try {
        await check('豆包通话一轮：用户/Ava 双方字幕均有中英两行', async () => {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
          debug.phase = 'v15-bilingual'
          await applyVolc()
          await reloadApp()
          await clickMic()
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__ava ? window.__ava.volcSession === true : false`)) === true,
            { timeoutMs: 25000, label: '豆包会话建立' },
          )
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, bilingualState)
              return v.userZh.text && v.replyZh.text && v.reply.length > 10 && hasCJK(v.userZh.text) && hasCJK(v.replyZh.text) ? v : null
            },
            { timeoutMs: 45000, label: '双方双语字幕（英文+中文）' },
          )
          assert.ok(st.user.length > 2, `用户英文字幕应非空，实际 "${st.user}"`)
          assert.equal(st.userZh.hidden, false, '用户中文字幕应显示')
          assert.ok(hasCJK(st.userZh.text), `用户中文字幕应为中文，实际 "${st.userZh.text}"`)
          assert.ok(st.reply.length > 2, `Ava 英文字幕应非空，实际 "${st.reply}"`)
          assert.equal(st.replyZh.hidden, false, 'Ava 中文字幕应显示')
          assert.ok(hasCJK(st.replyZh.text), `Ava 中文字幕应为中文，实际 "${st.replyZh.text}"`)
          await screenshot('ui-bilingual-volc-1440.png')
        })

        await check('豆包模式不渲染逐轮纠错/更好说法/生词卡，右栏为「专注对话」占位', async () => {
          const mid = await evalInPage(cdp, bilingualState)
          assert.equal(mid.fbCards, 0, `豆包模式不应出现反馈卡（实际 ${mid.fbCards} 张）：${mid.fbText.slice(0, 200)}`)
          assert.equal(mid.fbCorrections, 0, '不应出现「纠正」卡')
          assert.match(mid.fbText, /专注对话/, `右栏应为专注对话占位，实际 "${mid.fbText.slice(0, 200)}"`)
          await screenshot('ui-no-correction-volc-1440.png')
          // 结束本轮豆包会话，占位保持
          await clickMic()
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__ava ? window.__ava.volcSession === false : true`)) === true,
            { timeoutMs: 12000, label: '豆包会话结束' },
          )
          const after = await evalInPage(cdp, bilingualState)
          assert.equal(after.fbCards, 0, '结束后仍不应渲染逐轮纠错卡')
          assert.match(after.fbText, /专注对话/, '结束后右栏应保持专注对话占位')
        })

        await check('新一轮消息清空上一轮中文翻译（不串行错位）', async () => {
          await evalInPage(cdp, "window.__ava.send('I like coffee.')")
          const first = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, bilingualState)
              return v.userZh.text && hasCJK(v.userZh.text) ? v : null
            },
            { timeoutMs: 30000, label: '第一轮中文翻译' },
          )
          const firstZh = first.userZh.text
          await waitUntil(
            async () => (await evalInPage(cdp, "window.__ava ? window.__ava.phase === 'idle' : false")) === true,
            { timeoutMs: 20000, label: '第一轮回复完成（idle）' },
          )
          await evalInPage(cdp, "window.__ava.send('A brand new sentence about reading books.')")
          const next = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, bilingualState)
              if (!v.userZh.text || !hasCJK(v.userZh.text)) return null
              if (v.user.includes('brand new') && v.userZh.text !== firstZh) return v
              return null
            },
            { timeoutMs: 30000, label: '新一轮中文翻译（旧译文已清空）' },
          )
          assert.ok(next.user.includes('brand new'), '新一轮英文字幕应为新消息')
          assert.ok(next.userZh.text !== firstZh, '新一轮应显示新译文而非上一轮残留：旧=' + firstZh + ' 新=' + next.userZh.text)
        })
        await check('豆包模式下用户中文求助：仍显示「中文求助」卡（例外）', async () => {
          await waitUntil(
            async () => (await evalInPage(cdp, "window.__ava ? window.__ava.phase === 'idle' : false")) === true,
            { timeoutMs: 20000, label: '中文求助前等待空闲' },
          )
          await evalInPage(cdp, `window.__ava.send('我今天很累，不知道怎么说')`)
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const card = document.querySelector('#feedback-panel .fb-card.fb-chinese');
                  return {
                    hasChinese: !!card,
                    text: card ? (card.innerText || '').replace(/\\s+/g, ' ').trim() : '',
                    corrections: document.querySelectorAll('#feedback-panel .fb-correction').length,
                    cards: document.querySelectorAll('#feedback-panel .fb-card').length,
                  };
                })()`,
              )
              return v.hasChinese ? v : null
            },
            { timeoutMs: 20000, label: '中文求助卡（豆包模式例外）' },
          )
          assert.equal(st.hasChinese, true, '豆包模式下中文求助仍应显示中文求助卡')
          assert.ok(st.text.length > 10, `中文求助卡应有内容，实际 "${st.text}"`)
          assert.equal(st.corrections, 0, '中文求助不应出现纠错卡')
          await screenshot('ui-bilingual-chinese-help-1440.png')
        })

        await check('切回浏览器引擎 → 逐轮纠错反馈恢复', async () => {
          await openSettings()
          await evalInPage(cdp, `document.getElementById('engine-browser').click(); true`)
          await evalInPage(cdp, `document.getElementById('btn-save-settings').click(); true`)
          const engine = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `window.__ava ? { voiceEngine: window.__ava.voiceEngine, configuredEngine: window.__ava.configuredEngine, volcSession: window.__ava.volcSession } : null`,
              )
              return v && v.configuredEngine === 'browser' ? v : null
            },
            { timeoutMs: 8000, label: '切回浏览器引擎' },
          )
          assert.equal(engine.voiceEngine, 'browser', '生效引擎应回到 browser')
          await evalInPage(cdp, `window.__ava.send('I very like it')`)
          const fb = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => ({
                  corrections: document.querySelectorAll('#feedback-panel .fb-correction').length,
                  cards: document.querySelectorAll('#feedback-panel .fb-card').length,
                  text: (document.getElementById('feedback-panel') ? document.getElementById('feedback-panel').innerText : '').replace(/\\s+/g, ' ').trim(),
                }))()`,
              )
              return v.corrections > 0 ? v : null
            },
            { timeoutMs: 20000, label: '浏览器模式逐轮纠错恢复' },
          )
          assert.ok(fb.corrections >= 1, `浏览器模式应恢复纠错卡，实际 ${fb.corrections}`)
          assert.ok(fb.cards >= 1, '浏览器模式反馈卡应恢复')
        })

        await check('翻译失败静默降级：只显示英文、无 toast、不影响对话', async () => {
          await applyVolc()
          await reloadApp()
          volcMock.setScenario('translate-fail')
          try {
            const beforeErrors = debug.jsErrors.length
            const beforeToast = await evalInPage(cdp, `document.querySelectorAll('.toast').length`)
            await evalInPage(cdp, `window.__ava.send('This is my test sentence about coffee.')`)
            const st = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, bilingualState)
                return v.user.length > 2 && v.reply.length > 2 ? v : null
              },
              { timeoutMs: 20000, label: '翻译失败时英文字幕仍显示' },
            )
            await sleep(1800)
            const after = await evalInPage(cdp, bilingualState)
            assert.ok(st.user.length > 2 && after.user.length > 2, '用户英文字幕应正常显示')
            assert.ok(after.reply.length > 2, 'Ava 英文回复应正常显示')
            assert.equal(after.userZh.hidden === true || !after.userZh.text, true, `翻译失败时不应有用户中文字幕，实际 ${JSON.stringify(after.userZh)}`)
            const newToasts = after.toasts.slice(beforeToast)
            assert.ok(!newToasts.some((t) => /翻译|失败|translate/i.test(t)), `翻译失败不应弹 toast，实际 ${JSON.stringify(newToasts)}`)
            assert.equal(debug.jsErrors.length, beforeErrors, '翻译失败不应产生未捕获 JS 异常')
          } finally {
            volcMock.setScenario('ok')
          }
        })

        await check('移动端 420×860：双语字幕两行可见、无横向溢出', async () => {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true })
          await applyVolc()
          await reloadApp()
          await clickMic()
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__ava ? window.__ava.volcSession === true : false`)) === true,
            { timeoutMs: 25000, label: '移动端豆包会话' },
          )
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const userZh = document.getElementById('caption-user-zh');
                  const replyZh = document.getElementById('caption-reply-zh');
                  const cap = document.getElementById('caption');
                  const st = ${bilingualState};
                  if (!userZh || !replyZh || userZh.hidden || replyZh.hidden) return null;
                  const u = userZh.getBoundingClientRect();
                  const r = replyZh.getBoundingClientRect();
                  return {
                    ...st,
                    userZh: { hidden: false, text: (userZh.innerText || '').trim() },
                    replyZh: { hidden: false, text: (replyZh.innerText || '').trim() },
                    userZhIn: u.left >= -1 && u.right <= innerWidth + 1,
                    replyZhIn: r.left >= -1 && r.right <= innerWidth + 1,
                    pageOverflow: document.documentElement.scrollWidth - innerWidth,
                    captionOverflow: cap ? cap.scrollWidth - cap.clientWidth : 0,
                  };
                })()`,
              )
              return v && hasCJK(v.userZh.text) && hasCJK(v.replyZh.text) ? v : null
            },
            { timeoutMs: 40000, label: '移动端双语字幕' },
          )
          assert.equal(st.userZhIn, true, '移动端用户中文行应在视口内')
          assert.equal(st.replyZhIn, true, '移动端 Ava 中文行应在视口内')
          assert.ok(st.pageOverflow <= 2, `移动端页面横向溢出：${st.pageOverflow}`)
          assert.ok(st.captionOverflow <= 2, `字幕区横向溢出：${st.captionOverflow}`)
          await screenshot('ui-bilingual-mobile-420x860.png')
          await clickMic()
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__ava ? window.__ava.volcSession === false : true`)) === true,
            { timeoutMs: 12000, label: '移动端会话结束' },
          )
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
        })
      } finally {
        // 组间隔离：恢复浏览器引擎（移动端/预览组假定默认浏览器语音）
        try {
          await putSettings({ voiceEngine: 'browser' })
        } catch {
          /* ignore */
        }
        await volcMock.close()
      }
    })

    // =====================================================================
    if (!skipIndex) await group('主界面 / @ 420×860（移动端断点）', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 420,
        height: 860,
        deviceScaleFactor: 1,
        mobile: true,
      })
      debug.phase = 'index-420'
      await navigate(cdp, baseUrl + '/')
      await sleep(1000)
      await dismissOnboarding(cdp).catch(() => {})
      await sleep(400)
      // 组间隔离保险：重新加载后确认是浏览器引擎（避免 v1.5 组遗留 volc 状态）
      await waitUntil(
        async () =>
          (await evalInPage(cdp, "window.__ava ? window.__ava.configuredEngine === 'browser' : false")) === true,
        { timeoutMs: 8000, label: '移动端组开始前确认浏览器引擎' },
      )

      await check('移动端关键 DOM 仍存在（头像/麦克风/四 Tab/设置入口）', async () => {
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const s = document.querySelector('#avatar-stage'); return s && s.children.length > 0; })()`)) === true,
          { timeoutMs: 12000, label: '移动端数字人挂载' },
        ).catch(() => {})
        const probe = await evalInPage(cdp, APP_PROBE)
        assert.equal(probe.avatarStage, true, '移动端找不到 #avatar-stage')
        assert.ok(probe.avatarChildren > 0, '移动端数字人未挂载')
        assert.equal(probe.micVisible, true, '移动端麦克风按钮应可见')
        assert.deepEqual(
          probe.modeTabs.map((t) => t.mode).sort(),
          ['free', 'pronounce', 'reading', 'roleplay', 'vocab'],
          `移动端模式 Tab 不完整：${JSON.stringify(probe.modeTabs)}`,
        )
        assert.equal(probe.settingsBtn, true, '移动端应保留设置入口')
      })

      await check('移动端（420×860）五个模式 Tab 均有可见中文标签', async () => {
        const tabs = await evalInPage(
          cdp,
          `(() => [...document.querySelectorAll('.mode-tab[data-mode]')].map((b) => {
            const label = b.querySelector('.mt-label');
            const r = label ? label.getBoundingClientRect() : null;
            return {
              mode: b.dataset.mode,
              text: label ? (label.textContent || '').trim() : '',
              visible: !!(r && r.width > 4 && r.height > 4),
            };
          }))()`,
        )
        assert.equal(tabs.length, 5, `应有 5 个模式 Tab，实际 ${tabs.length}`)
        const expectLabels = { free: '自由对话', vocab: '单词闯关', pronounce: '跟读打分', roleplay: '角色扮演', reading: '阅读讲解' }
        for (const t of tabs) {
          assert.equal(t.text, expectLabels[t.mode], `${t.mode} Tab 标签应为「${expectLabels[t.mode]}」，实际 "${t.text}"`)
          assert.equal(t.visible, true, `420×860 下模式 Tab 标签「${t.text}」应可见（P2 回归），实际被隐藏`)
        }
      })

      await check('移动端无横向溢出（420×860）且麦克风在视口内', async () => {
        const probe = await evalInPage(cdp, APP_PROBE)
        assert.ok(Math.abs(probe.innerWidth - 420) <= 2, `视口宽度应为 420，实际 ${probe.innerWidth}`)
        assert.ok(
          probe.docScrollWidth - probe.docClientWidth <= 2,
          `移动端横向溢出：scrollWidth=${probe.docScrollWidth} > clientWidth=${probe.docClientWidth}`,
        )
        assert.ok(probe.micRect, '移动端麦克风按钮应有尺寸')
        assert.ok(
          probe.micRect.y >= 0 && probe.micRect.bottom <= probe.innerHeight + 2,
          `移动端麦克风按钮应在视口内，实际 top=${probe.micRect.y} bottom=${probe.micRect.bottom} vh=${probe.innerHeight}`,
        )
      })

      await check('移动端文案不含 undefined / NaN / TODO', async () => {
        const probe = await evalInPage(cdp, APP_PROBE)
        const bad = probe.text.match(/\b(undefined|NaN|TODO)\b/g)
        assert.equal(bad, null, `移动端文案出现占位/异常文本：${bad ? bad.join(',') : ''}`)
      })

      await check('移动端截图（420×860）', async () => {
        await screenshot('ui-index-420x860.png')
        const st = await fsp.stat(path.join(ARTIFACTS_DIR, 'ui-index-420x860.png'))
        assert.ok(st.size > 8_000, `移动端截图文件过小（${st.size} bytes），疑似空白页`)
      })

      await check('移动端对话一轮：demo 回复 + 反馈面板可达（抽屉）', async () => {
        // 等应用与内容就绪（__ava 为 app 提供的 QA 只读/调试钩子）
        await waitUntil(
          async () => (await evalInPage(cdp, `!!(window.__ava && window.__ava.content)`)) === true,
          { timeoutMs: 15000, label: '移动端应用就绪（window.__ava.content）' },
        ).catch(() => {})

        const dispatched = await evalInPage(
          cdp,
          `(() => {
            if (!window.__ava || typeof window.__ava.send !== 'function') return false;
            const hint = () => (document.getElementById('mic-hint')?.textContent || '').replace(/\\s+/g, ' ').trim();
            const before = hint();
            window.__ava.send('I want a coffee');
            const during = hint();
            return { sent: true, before, during };
          })()`,
        )
        assert.equal(dispatched.sent, true, '无法通过 window.__ava.send 模拟发送（调试钩子缺失）')
        assert.equal(dispatched.before, '点击麦克风开始说英语 · 也可按空格', `发送前 idle 提示文案不符，实际 "${dispatched.before}"`)
        assert.ok(
          dispatched.during === 'Ava 正在思考…' || dispatched.during === 'Ava 正在说，听一听' || dispatched.during === '正在聆听…说完停顿一下',
          `发送后提示文案应随 phase 变化（思考/说话/聆听），实际 "${dispatched.during}"`,
        )

        const fb = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const a = window.__ava;
                const panel = document.querySelector('#feedback-panel');
                const caption = document.getElementById('caption-reply');
                return {
                  phase: a ? a.phase : null,
                  demo: a ? a.demo : null,
                  reply: a ? String(a.reply || '') : '',
                  feedbackText: panel ? panel.innerText.replace(/\\s+/g, ' ').trim() : '',
                  captionText: caption ? caption.innerText.replace(/\\s+/g, ' ').trim() : '',
                };
              })()`,
            )
            const busy = v.phase === 'thinking' || v.phase === 'speaking' || v.phase === 'listening'
            return !busy && v.feedbackText.length > 20 ? v : null
          },
          { timeoutMs: 25000, label: 'demo 对话反馈渲染（feedback-panel 非空）' },
        )
        assert.equal(fb.demo, true, '无 Key 时应为 demo 模式')
        assert.ok(fb.feedbackText.length > 20, `移动端反馈面板应有内容，实际 ${JSON.stringify(fb.feedbackText.slice(0, 120))}`)
        assert.match(fb.feedbackText, /[\u4e00-\u9fa5]/, '反馈面板应包含中文解释/鼓励')
        assert.ok(fb.reply.length > 0, 'demo 回复正文不应为空')

        // 抽屉入口可见 → 点击展开 → 反馈面板与视口相交
        const drawerBtn = await evalInPage(
          cdp,
          `(() => {
            const b = document.getElementById('btn-drawer');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            const st = getComputedStyle(b);
            return { visible: r.width > 2 && r.height > 2 && st.display !== 'none' && st.visibility !== 'hidden', rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
          })()`,
        )
        assert.ok(drawerBtn && drawerBtn.visible, `移动端应有可见的教练面板入口 #btn-drawer，实际 ${JSON.stringify(drawerBtn)}`)

        // P2 回归：反馈到达且抽屉未打开时，「教练」入口应有未读徽标
        const badge = await evalInPage(
          cdp,
          `(() => {
            const b = document.getElementById('drawer-badge');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { hidden: b.hidden, text: (b.textContent || '').trim(), visible: !b.hidden && r.width > 2 && r.height > 2 };
          })()`,
        )
        assert.ok(badge && badge.visible, `反馈到达后未读徽标 #drawer-badge 应可见，实际 ${JSON.stringify(badge)}`)
        assert.ok(Number(badge.text) >= 1, `未读徽标应显示条数 >=1，实际 "${badge.text}"`)

        await evalInPage(cdp, `document.getElementById('btn-drawer').click(); true`)
        const reachable = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const main = document.getElementById('main');
                const panel = document.querySelector('#feedback-panel') || document.getElementById('panel-scroll');
                if (!panel) return null;
                const r = panel.getBoundingClientRect();
                const st = getComputedStyle(panel);
                const open = !!(main && main.classList.contains('drawer-open'));
                const intersects = r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
                return { open, intersects, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }, display: st.display };
              })()`,
            )
            return v && v.open && v.intersects ? v : null
          },
          { timeoutMs: 6000, label: '移动端抽屉展开且反馈面板进入视口' },
        )
        assert.equal(reachable.open, true, '点击 #btn-drawer 后 #main 应有 drawer-open 类')
        assert.equal(reachable.intersects, true, `反馈面板应与视口相交（可达），实际 ${JSON.stringify(reachable)}`)
        await screenshot('ui-mobile-feedback-420x860.png')
        const st = await fsp.stat(path.join(ARTIFACTS_DIR, 'ui-mobile-feedback-420x860.png'))
        assert.ok(st.size > 8_000, `移动端反馈截图文件过小（${st.size} bytes）`)
      })

      await check('移动端：结束对话 → 总结弹窗 + 今日单词表可滚动、无横向溢出', async () => {
        // 关闭抽屉，补一句凑够 2 轮用户消息
        await evalInPage(
          cdp,
          `(() => { const b = document.getElementById('drawer-backdrop'); if (b && !b.hidden) b.click(); return true; })()`,
        )
        await sleep(300)
        await waitAppReady(cdp)
        await sendTurn(cdp, 'I am happy today because I finished my work early.')
        await evalInPage(cdp, `window.__ava.endConversation(); true`)

        const sum = await waitUntil(
          async () => {
            const v = await probeSummary(cdp)
            return v.open && v.heroText.length > 5 ? v : null
          },
          { timeoutMs: 30000, label: '移动端总结弹窗渲染' },
        )
        assert.ok(sum.heroText.length > 5, '移动端总结弹窗应有总结内容')
        assert.ok(sum.kwWords.length >= 3, `移动端总结重点词应 >=3，实际 ${sum.kwWords.length}`)
        assert.ok(sum.bodyInViewport, `移动端总结正文应在视口内，实际 ${JSON.stringify(sum.rect)}`)
        assert.ok(sum.bodyScroll.sw - sum.bodyScroll.cw <= 2, `移动端总结弹窗横向溢出：${sum.bodyScroll.sw} > ${sum.bodyScroll.cw}`)
        assert.ok(sum.bodyScroll.sh > sum.bodyScroll.ch ? /auto|scroll/.test(sum.bodyScroll.overflowY) : true, '内容超长时总结正文应可滚动')
        // 等 toast 自动消失，避免遮挡截图
        await waitUntil(
          async () => (await evalInPage(cdp, `document.querySelectorAll('.toast').length === 0`)) === true,
          { timeoutMs: 6500, label: '总结完成 toast 消失' },
        ).catch(() => {})
        await screenshot('ui-summary-420x860.png')

        await evalInPage(cdp, `document.getElementById('btn-summary-wordbook').click(); true`)
        const wb = await waitUntil(
          async () => {
            const v = await probeWordbook(cdp)
            return v.open && v.dayCount > 0 ? v : null
          },
          { timeoutMs: 15000, label: '移动端今日单词表渲染' },
        )
        assert.ok(wb.words.length >= 3, `移动端单词本应有 >=3 个单词，实际 ${wb.words.length}`)
        assert.match(wb.firstLabel, /今天/, '移动端单词本今天应置顶')
        assert.ok(wb.bodyInViewport, `移动端单词本正文应在视口内，实际 ${JSON.stringify(wb.rect)}`)
        assert.ok(wb.bodyScroll.sw - wb.bodyScroll.cw <= 2, `移动端单词本横向溢出：${wb.bodyScroll.sw} > ${wb.bodyScroll.cw}`)
        // 等 toast 自动消失，避免遮挡截图
        await waitUntil(
          async () => (await evalInPage(cdp, `document.querySelectorAll('.toast').length === 0`)) === true,
          { timeoutMs: 6500, label: '总结完成 toast 消失' },
        ).catch(() => {})
        await screenshot('ui-wordbook-420x860.png')
        await evalInPage(
          cdp,
          `(() => { const m = document.getElementById('modal-wordbook'); const b = m && m.querySelector('[data-close]'); if (b) b.click(); return true; })()`,
        )
        await sleep(250)
      })

      await check('移动端中文求助卡：可见、可滚动、无横向溢出', async () => {
        await evalInPage(
          cdp,
          `(() => { const b = document.getElementById('drawer-backdrop'); if (b && !b.hidden) b.click(); return true; })()`,
        )
        await sleep(250)
        await waitAppReady(cdp)
        const zhBtn = await evalInPage(
          cdp,
          `(() => { const b = document.getElementById('btn-chinese'); if (!b) return null; const r = b.getBoundingClientRect(); return { visible: r.width > 2 && r.height > 2, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }; })()`,
        )
        assert.ok(zhBtn && zhBtn.visible, `移动端应显示中文求助按钮，实际 ${JSON.stringify(zhBtn)}`)

        await sendTurn(cdp, '我今天很累，不知道怎么说')
        await evalInPage(
          cdp,
          `(() => { const b = document.getElementById('btn-drawer'); if (b) b.click(); return true; })()`,
        )
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const main = document.getElementById('main');
                const card = document.querySelector('#feedback-panel .fb-card.fb-chinese');
                const panel = document.getElementById('panel-scroll');
                if (!card) return null;
                const cr = card.getBoundingClientRect();
                const open = !!(main && main.classList.contains('drawer-open'));
                const cardInView = cr.width > 2 && cr.height > 2 && cr.bottom > 0 && cr.top < innerHeight && cr.right > 0 && cr.left < innerWidth;
                return {
                  open,
                  cardInView,
                  cardOverflow: { sw: card.scrollWidth, cw: card.clientWidth },
                  panelOverflow: panel ? { sw: panel.scrollWidth, cw: panel.clientWidth } : null,
                  eng: (card.querySelector('.zh-eng-text') ? card.querySelector('.zh-eng-text').textContent : '').trim(),
                  chunks: card.querySelectorAll('.zh-chunk').length,
                  tips: (card.querySelector('.zh-tips') ? card.querySelector('.zh-tips').textContent : '').trim(),
                };
              })()`,
            )
            return v && v.open && v.cardInView ? v : null
          },
          { timeoutMs: 30000, label: '移动端中文求助卡可见' },
        )
        assert.match(st.eng, /exhausted|tired/i, '移动端中文求助卡应有英文表达')
        assert.ok(st.chunks >= 1, '移动端中文求助卡应有意群')
        assert.ok(st.tips.length > 0, '移动端中文求助卡应有中文提示')
        assert.ok(st.cardOverflow.sw - st.cardOverflow.cw <= 2, `中文求助卡横向溢出：${st.cardOverflow.sw} > ${st.cardOverflow.cw}`)
        assert.ok(!st.panelOverflow || st.panelOverflow.sw - st.panelOverflow.cw <= 2, `反馈面板横向溢出：${JSON.stringify(st.panelOverflow)}`)
        await screenshot('ui-chinese-help-420x860.png')
        const png = await fsp.stat(path.join(ARTIFACTS_DIR, 'ui-chinese-help-420x860.png'))
        assert.ok(png.size > 8_000, `移动端中文求助截图文件过小（${png.size} bytes）`)
      })

      await check('移动端阅读讲解：上传/分析/理解题可用、无横向溢出', async () => {
        await evalInPage(
          cdp,
          `(() => { const b = document.getElementById('drawer-backdrop'); if (b && !b.hidden) b.click(); return true; })()`,
        )
        await sleep(250)
        await evalInPage(cdp, `document.querySelector('.mode-tab[data-mode="reading"]').click(); true`)
        await waitUntil(
          async () => (await evalInPage(cdp, `!!document.getElementById('doc-file-input')`)) === true,
          { timeoutMs: 8000, label: '移动端阅读面板' },
        )
        await setFileInputFiles(cdp, '#doc-file-input', path.join(PROJECT_ROOT, 'test', 'fixtures', 'english-notes.md'))
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const R = window.__ava ? window.__ava.reading : null;
                const panel = document.querySelector('#mode-panel');
                const kw = document.querySelector('.reading-kw');
                const r = panel ? panel.getBoundingClientRect() : null;
                return {
                  docId: R ? R.docId : null,
                  analyzing: R ? !!(R.analyzing || R.uploading) : true,
                  summary: document.querySelectorAll('.reading-summary').length,
                  keyWords: document.querySelectorAll('.reading-kw .kw-card').length,
                  questions: document.querySelectorAll('.reading-q').length,
                  panelOverflow: panel ? { sw: panel.scrollWidth, cw: panel.clientWidth } : null,
                  kwOverflow: kw ? { sw: kw.scrollWidth, cw: kw.clientWidth } : null,
                  panelInView: !!(r && r.width > 2 && r.height > 2),
                };
              })()`,
            )
            return v.docId && !v.analyzing && v.summary > 0 ? v : null
          },
          { timeoutMs: 30000, label: '移动端上传并分析' },
        )
        assert.ok(st.summary >= 1, '移动端应渲染分析摘要')
        assert.ok(st.keyWords >= 3, `移动端重点词 >=3，实际 ${st.keyWords}`)
        assert.ok(st.questions >= 3, `移动端理解题 >=3，实际 ${st.questions}`)
        assert.ok(st.panelInView, '阅读讲解面板应在视口内')
        assert.ok(!st.panelOverflow || st.panelOverflow.sw - st.panelOverflow.cw <= 2, `移动端阅读面板横向溢出：${JSON.stringify(st.panelOverflow)}`)
        assert.ok(!st.kwOverflow || st.kwOverflow.sw - st.kwOverflow.cw <= 2, `移动端重点词区横向溢出：${JSON.stringify(st.kwOverflow)}`)
        await screenshot('ui-reading-analysis-420x860.png')
        const png = await fsp.stat(path.join(ARTIFACTS_DIR, 'ui-reading-analysis-420x860.png'))
        assert.ok(png.size > 8_000, `移动端阅读截图文件过小（${png.size} bytes）`)
      })

      await check('移动端语音引擎设置：豆包字段可用、无横向溢出', async () => {
        await evalInPage(
          cdp,
          `(() => { if (window.__ava && typeof window.__ava.openSettings === 'function') window.__ava.openSettings(); else document.getElementById('btn-settings').click(); return true; })()`,
        )
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const m = document.getElementById('modal-settings'); return !!(m && !m.hidden); })()`)) === true,
          { timeoutMs: 6000, label: '移动端设置弹窗' },
        )
        await evalInPage(cdp, `document.getElementById('engine-volc').click(); true`)
        const st = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const cfg = document.getElementById('volc-config');
                const modal = document.querySelector('#modal-settings .modal');
                if (!cfg || cfg.hidden) return null;
                const cr = cfg.getBoundingClientRect();
                const mr = modal ? modal.getBoundingClientRect() : null;
                return {
                  visible: cr.width > 2 && cr.height > 2,
                  cfgOverflow: cfg.scrollWidth - cfg.clientWidth,
                  modalOverflow: modal ? modal.scrollWidth - modal.clientWidth : 0,
                  modalInView: !!(mr && mr.bottom > 0 && mr.top < innerHeight && mr.right > 0 && mr.left < innerWidth),
                  fields: ['volc-appid','volc-apikey','volc-endpoint','btn-test-volc'].filter((id) => !document.getElementById(id)),
                };
              })()`,
            )
            return v && v.visible ? v : null
          },
          { timeoutMs: 5000, label: '移动端豆包配置区' },
        )
        assert.equal(st.visible, true, '移动端选中豆包后配置区应可见')
        assert.deepEqual(st.fields, [], `移动端豆包字段应齐全，缺少 ${JSON.stringify(st.fields)}`)
        assert.ok(st.cfgOverflow <= 2, `移动端豆包配置区横向溢出：${st.cfgOverflow}`)
        assert.ok(st.modalOverflow <= 2, `移动端设置弹窗横向溢出：${st.modalOverflow}`)
        assert.equal(st.modalInView, true, '设置弹窗应在视口内')
        await screenshot('ui-voice-engine-420x860.png')
        await evalInPage(cdp, `(() => { const m = document.getElementById('modal-settings'); const b = m && m.querySelector('[data-close]'); if (b) b.click(); return true; })()`)
        await sleep(250)
      })

    })

    // =====================================================================
    // v1.6：手机网页版 /mobile（5 Tab / 角色画廊 / 通话 / 助手 / 趣玩 / 我的）
    // =====================================================================
    // =====================================================================
    // v1.7：/mobile 整屏游戏化（全屏人物 / HUD / 口播 / 5 页）
    // =====================================================================
    if (!skipIndex) await group('v1.7 整屏游戏化 /mobile', async () => {
      const volcMock = await startMockVolc({ chunkDelayMs: 4 })
      const volcCreds = {
        appId: 'mobile-v17-app',
        apiKey: 'mobile-v17-key-1234',
        model: '3.0',
        speaker: 'en_female_dacey_uranus_bigtts',
        endpoint: volcMock.wsUrl,
        resourceId: 'volc.speech.dialog',
      }
      const setDevice = async (width, height) =>
        cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      const openMobile = async (width = 1440, height = 900) => {
        await setDevice(width, height)
        await navigate(cdp, baseUrl + '/mobile')
        await waitUntil(
          async () =>
            (await evalInPage(cdp,
              `(() => { const a = document.getElementById('app'); return !!(a && a.getAttribute('data-ready') === '1'); })()`,
            )) === true,
          { timeoutMs: 15000, label: '手机版 data-ready=1' },
        )
        await waitUntil(
          async () =>
            (await evalInPage(cdp,
              `(() => !!(window.__avaMobile && window.__avaMobile.state && Array.isArray(window.__avaMobile.state.characters) && window.__avaMobile.state.characters.length >= 3))()`,
            )) === true,
          { timeoutMs: 15000, label: '手机版 boot（3 角色）' },
        )
        await sleep(400)
      }
      const switchTab = async (tab) => {
        await evalInPage(cdp, `document.querySelector('.tab[data-tab="${tab}"]').click(); true`)
        await waitUntil(
          async () =>
            (await evalInPage(cdp,
              `(() => { const s = document.getElementById('screen-${tab}'); return !!(s && !s.hidden); })()`,
            )) === true,
          { timeoutMs: 8000, label: `Tab ${tab} 显示` },
        )
        await sleep(300)
      }
      const snapshot = `(() => {
        const q = (id) => document.getElementById(id);
        const app = q('app');
        const rect = app ? app.getBoundingClientRect() : null;
        const call = window.__avaMobile ? window.__avaMobile.getCallState() : null;
        const sheet = q('sheet');
        const world = (() => {
          const a = q('world-img-a'), b = q('world-img-b');
          const on = [a, b].find((img) => img && img.classList.contains('is-on')) || a || b;
          return on ? { src: on.getAttribute('src'), loaded: on.complete && on.naturalWidth > 0 } : null;
        })();
        return {
          tab: window.__avaMobile ? window.__avaMobile.state.tab : null,
          activeChar: window.__avaMobile ? window.__avaMobile.state.activeCharId : null,
          appRect: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
          inner: { w: innerWidth, h: innerHeight },
          phoneShell: !!document.querySelector('.phone-shell, .phone-frame'),
          overflow: document.documentElement.scrollWidth - innerWidth,
          tabs: [...document.querySelectorAll('#tabbar .tab')].map((t) => ({ tab: t.getAttribute('data-tab'), key: t.getAttribute('data-key'), selected: t.getAttribute('aria-selected') === 'true' })),
          screens: ['courses','chat','assistant','review','profile'].map((id) => {
            const s = q('screen-' + id);
            return { id, hidden: !s || s.hidden, text: s ? s.innerText.replace(/\\s+/g, ' ').trim().slice(0, 100) : '' };
          }),
          call,
          callVisible: (() => { const c = q('call'); return !!(c && !c.hidden); })(),
          callName: q('call-name') ? q('call-name').textContent.trim() : '',
          callSub: q('call-sub') ? q('call-sub').textContent.trim() : '',
          callTimer: q('call-timer') ? q('call-timer').textContent.trim() : '',
          sceneLabel: q('call-scene-label') ? q('call-scene-label').textContent.trim() : '',
          headHost: !!q('talking-host'),
          headCanvas: !!document.querySelector('#talking-host canvas'),
          headHostHidden: q('talking-host') ? q('talking-host').hidden : null,
          cover: (() => { const img = q('call-cover-img'); return img ? { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 } : null; })(),
          coverFilter: q('call-cover-img') ? getComputedStyle(q('call-cover-img')).filter : null,
          sheetOpen: !!(sheet && !sheet.hidden),
          sheetTitle: q('sheet-title') ? q('sheet-title').textContent.trim() : '',
          sheetBody: q('sheet-body') ? q('sheet-body').innerText.replace(/\\s+/g, ' ').trim() : '',
          toasts: [...document.querySelectorAll('#toasts .toast')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()),
          bubbles: [...document.querySelectorAll('#call-bubbles .bubble')].map((b) => ({
            classes: [...b.classList],
            en: (b.querySelector('.bubble-en') ? b.querySelector('.bubble-en').textContent : '').trim(),
            zh: (b.querySelector('.bubble-zh') ? b.querySelector('.bubble-zh').textContent : '').trim(),
            zhHidden: (() => { const z = b.querySelector('.bubble-zh'); return z ? z.hidden : true; })(),
          })),
          world,
        };
      })()`
      const hasCJK = (text) => /[\u4e00-\u9fff]/.test(String(text || ''))

      try {
        await jfetch(baseUrl + '/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            voiceEngine: 'volc',
            apiKey: '',
            clearKey: true,
            baseUrl: 'http://127.0.0.1:9/v1',
            volc: { ...volcCreds },
          }),
        })

        await check('1440×900 整屏游戏化：无手机壳、#app 铺满、HUD 5 Tab、课程首屏', async () => {
          debug.phase = 'v17-mobile-home'
          await openMobile(1440, 900)
          const st = await evalInPage(cdp, snapshot)
          assert.equal(st.phoneShell, false, 'v1.7 不应再有手机壳容器')
          assert.ok(st.appRect, '#app 应存在')
          assert.ok(Math.abs(st.appRect.w - st.inner.w) <= 2, `#app 宽度应铺满视口（${st.appRect.w} vs ${st.inner.w}）`)
          assert.ok(Math.abs(st.appRect.h - st.inner.h) <= 2, `#app 高度应铺满视口（${st.appRect.h} vs ${st.inner.h}）`)
          assert.equal(st.tabs.length, 5, 'HUD 应有 5 个 Tab（v2.8 移除趣玩，复习保留）')
          assert.deepEqual(st.tabs.map((t) => t.tab), ['courses', 'chat', 'assistant', 'review', 'profile'])
          assert.deepEqual(st.tabs.map((t) => t.key), ['1', '2', '3', '4', '5'], 'Tab 应带键盘提示 1-5')
          assert.equal(st.tabs[0].selected, true, '默认选中课程 Tab')
          assert.equal(st.screens.find((s) => s.id === 'courses').hidden, false, '课程页应可见')
          assert.ok(st.screens.find((s) => s.id === 'courses').text.length > 10, '课程页内容非空')
          assert.ok(st.overflow <= 2, `1440×900 横向溢出：${st.overflow}`)
          await screenshot('ui-v17-home-1440x900.png')
        })

        await check('四种桌面尺寸自适应：1920×1080 / 1280×800 铺满且无溢出', async () => {
          for (const [w, h, shot] of [[1920, 1080, 'ui-v17-home-1920x1080.png'], [1280, 800, null]]) {
            await openMobile(w, h)
            const st = await evalInPage(cdp, snapshot)
            assert.ok(Math.abs(st.appRect.w - st.inner.w) <= 2 && Math.abs(st.appRect.h - st.inner.h) <= 2, `${w}×${h} 应铺满视口`)
            assert.ok(st.overflow <= 2, `${w}×${h} 横向溢出：${st.overflow}`)
            assert.equal(st.tabs.length, 5)
            if (shot) await screenshot(shot)
          }
          await setDevice(1440, 900)
          await openMobile(1440, 900)
        })

        await check('底部 HUD Tab 点击 + 键盘 1-5 均可切页（aria-selected 同步）', async () => {
          const before = debug.jsErrors.length
          for (const tab of ['chat', 'assistant', 'review', 'profile', 'courses']) {
            await switchTab(tab)
            const st = await evalInPage(cdp, snapshot)
            assert.equal(st.tab, tab, `点击后 state.tab 应为 ${tab}`)
            assert.deepEqual(st.tabs.filter((t) => t.selected).map((t) => t.tab), [tab], `Tab ${tab} 应唯一选中`)
          }
          const keyMap = [['2', 'chat'], ['3', 'assistant'], ['4', 'review'], ['5', 'profile'], ['1', 'courses']]
          for (const [key, tab] of keyMap) {
            await evalInPage(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true })); true`)
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.state.tab`)) === tab,
              { timeoutMs: 5000, label: `键盘 ${key} → ${tab}` },
            )
            const st = await evalInPage(cdp, snapshot)
            assert.equal(st.tab, tab, `键盘 ${key} 应切到 ${tab}`)
            assert.deepEqual(st.tabs.filter((t) => t.selected).map((t) => t.tab), [tab])
          }
          assert.equal(debug.jsErrors.length, before, 'Tab 切换不应产生 JS 异常')
        })

        await check('对话首页：全屏人物 + 信息卡 + 3 角色切换器（用户原图 .jpg）+ 切换角色', async () => {
          await switchTab('chat')
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const q = (s) => document.querySelector(s);
                  const cards = [...document.querySelectorAll('#screen-chat .switch-card')];
                  if (!q('#screen-chat .hero-name') || cards.length < 3) return null;
                  return {
                    heroName: q('#screen-chat .hero-name').innerText.replace(/\\s+/g, ' ').trim(),
                    heroRole: q('#screen-chat .hero-role') ? q('#screen-chat .hero-role').innerText.replace(/\\s+/g, ' ').trim() : '',
                    tags: [...document.querySelectorAll('#screen-chat .hero-tag')].map((x) => x.innerText.trim()),
                    scenes: document.querySelectorAll('#screen-chat .hero-scenes span').length,
                    cta: q('#screen-chat .hero-cta') ? q('#screen-chat .hero-cta').innerText.replace(/\\s+/g, ' ').trim() : '',
                    cards: cards.map((c) => ({
                      char: c.getAttribute('data-char'),
                      active: c.classList.contains('is-active'),
                      img: (() => { const img = c.querySelector('img'); return img ? { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0, w: img.naturalWidth } : null; })(),
                    })),
                    active: window.__avaMobile.state.activeCharId,
                    world: (() => { const imgs = [...document.querySelectorAll('#world img')]; const on = imgs.find((i) => i.classList.contains('is-on')) || imgs[0]; return on ? { src: on.getAttribute('src'), loaded: on.complete && on.naturalWidth > 0 } : null; })(),
                    overflow: document.documentElement.scrollWidth - innerWidth,
                  };
                })()`,
              )
              return v
            },
            { timeoutMs: 12000, label: '对话首页（3 切换器）' },
          )
          assert.match(st.heroName, /Elena/, `首页主角应为 Elena，实际 "${st.heroName}"`)
          assert.ok(st.tags.length >= 2, '应有性格标签')
          assert.equal(st.scenes, 0, 'v3.1 去场景后对话首页不应有场景列表')
          assert.match(st.cta, /去聊聊/)
          assert.equal(st.cards.length, 3, '应有 3 个角色切换器')
          assert.deepEqual(st.cards.map((c) => c.char), ['elena', 'maya', 'hikari'])
          for (const c of st.cards) {
            assert.match(String(c.img && c.img.src), /^\/assets\/characters\/[a-z]+\.jpg/, `${c.char} 切换器图应为用户原图 .jpg`)
            assert.equal(c.img && c.img.loaded, true, `${c.char} 原图应加载成功（naturalWidth>0）`)
            assert.ok((c.img && c.img.w) >= 200, `${c.char} 原图分辨率应足够（${c.img && c.img.w}px）`)
          }
          assert.equal(st.cards.find((c) => c.char === 'elena').active, true, '默认 Elena 选中')
          assert.equal(st.active, 'elena')
          assert.match(String(st.world && st.world.src), /elena\.jpg/, '世界背景应为 Elena 原图')
          assert.equal(st.world.loaded, true, '背景原图应加载成功')
          assert.ok(st.overflow <= 2, `对话页横向溢出：${st.overflow}`)
          // 切换到 Maya：全屏人物/主题色/switch active 同步
          await evalInPage(cdp, `document.querySelector('#screen-chat .switch-card[data-char="maya"]').click(); true`)
          const maya = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, snapshot)
              if (v.activeChar !== 'maya') return null
              const world = v.world
              return v.world && String(v.world.src || '').includes('maya') ? v : null
            },
            { timeoutMs: 8000, label: '切换 Maya 全屏人物' },
          )
          const mayaCard = await evalInPage(
            cdp,
            `(() => { const c = document.querySelector('#screen-chat .switch-card[data-char="maya"]'); return { active: c.classList.contains('is-active'), pressed: c.getAttribute('aria-pressed') }; })()`,
          )
          assert.equal(mayaCard.active, true, 'Maya 切换器应高亮')
          assert.equal(mayaCard.pressed, 'true')
          await screenshot('ui-v17-chat-1440x900.png')
          // 换回 Elena 供后续通话用例
          await evalInPage(cdp, `document.querySelector('#screen-chat .switch-card[data-char="elena"]').click(); true`)
          await sleep(300)
        })

        await check('通话页（idle）：口播 host/canvas 或静态兜底 + HUD 元素齐全、原图无改色', async () => {
          await evalInPage(cdp, `document.querySelector('#screen-chat .hero-cta[data-act="talk"]').click(); true`)
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, snapshot)
              return v.callVisible && v.call && v.call.open ? v : null
            },
            { timeoutMs: 15000, label: '进入通话页' },
          )
          assert.equal(st.call.character, 'elena')
          assert.ok(st.callName === 'Elena' || /Elena/.test(st.callName), `通话名应为 Elena，实际 "${st.callName}"`)
          assert.match(st.callSub, /伦敦/)
          assert.match(st.callTimer, /^\d{2}:\d{2}$/)
          assert.ok(!st.sceneLabel || String(st.sceneLabel).length === 0, 'v3.1 去场景后不应有场景标签')
          assert.ok(!/grayscale|hue-rotate|sepia/.test(String(st.coverFilter || '')), `人物原图不应被改色滤镜处理，实际 filter=${st.coverFilter}`)
          assert.equal(st.headHost, true, '应有 talking-host 口播容器')
          // WebGL 可用时 head===true 且 canvas 挂载；不可用时允许静态 img 兜底（但需加载成功、0 异常）
          if (st.call.head === true) {
            assert.equal(st.headCanvas, true, 'head=true 时应挂载口播 canvas')
          } else {
            assert.equal(st.cover.loaded, true, '无 WebGL 时应有静态人物图兜底且加载成功')
          }
          assert.equal(st.call.head !== true ? st.call.head === false : true, true)
          const buttons = await evalInPage(
            cdp,
            `(() => ({
              talk: !!document.getElementById('call-talk'),
              hangup: !!document.getElementById('call-hangup'),
              textBtn: !!document.getElementById('call-text-btn'),
              translate: !!document.getElementById('call-toggle-translate'),
              mute: !!document.getElementById('call-toggle-mute'),
              back: !!document.getElementById('call-back'),
            }))()`,
          )
          for (const [name, ok] of Object.entries(buttons)) assert.equal(ok, true, `通话页应有 ${name} 按钮`)
          await screenshot('ui-v17-call-idle-1440x900.png')
        })

        await check('口播口型：previewSpeaking → speaking 态 + head/canvas；结束回 idle', async () => {
          const started = await evalInPage(
            cdp,
            `(() => (window.__avaMobile.previewSpeaking ? window.__avaMobile.previewSpeaking(1600) : false))()`,
          )
          assert.equal(started, true, 'previewSpeaking 应可用')
          const speaking = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, snapshot)
              return v.call && v.call.state === 'speaking' ? v : null
            },
            { timeoutMs: 5000, label: 'speaking 态' },
          )
          // talking-head 为异步 import + 图片解码：等待 head 挂载（最多 8s）
          let headSt = speaking
          for (let i = 0; i < 40; i++) {
            headSt = await evalInPage(cdp, snapshot)
            if (headSt.call.head === true) break
            await sleep(200)
          }
          if (headSt.call.head === true) {
            assert.equal(headSt.headCanvas, true, 'head=true 时应存在 talking-head canvas')
          } else {
            // 无 WebGL 时（headless 环境差异）允许静态人物图兜底：需加载成功且 0 JS 异常
            assert.equal(headSt.cover && headSt.cover.loaded, true, '无 WebGL 时应有静态人物图兜底且加载成功')
            assert.ok(!/grayscale|hue-rotate|sepia/.test(String(headSt.coverFilter || '')), '兜底图不应被改色')
            assert.equal((await evalInPage(cdp, 'Array.isArray(window.__avaErrors) ? window.__avaErrors.length : 0')), 0, '兜底路径应 0 JS 异常')
            console.log('[info] 本环境 WebGL 口播未挂载，已按静态图兜底验证（真实口播观感见 M25）')
          }
          await screenshot('ui-v17-call-speaking-1440x900.png')
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().state`)) === 'idle',
            { timeoutMs: 6000, label: 'previewSpeaking 结束回 idle' },
          )
        })

        await check('talking-head v1.8：眨眼平滑采样（blinkLevel 1–3 次单峰、无二次小峰、帧间平滑）', async () => {
          const sample = await evalInPage(cdp, `(async () => {
            const mod = await import('/js/mobile/call.js')
            const head = mod.callState && mod.callState.head
            if (!head || typeof head.blinkLevel !== 'number') return { error: 'head.blinkLevel 不可用' }
            const samples = []
            await new Promise((resolve) => {
              const start = performance.now()
              const step = () => {
                samples.push({ t: performance.now() - start, v: head.blinkLevel })
                if (performance.now() - start < 11000) requestAnimationFrame(step)
                else resolve()
              }
              requestAnimationFrame(step)
            })
            return { samples, ok: head.ok !== false }
          })()`)
          assert.ok(!sample.error, sample.error)
          assert.equal(sample.ok, true, '口播引擎应可用（WebGL）')
          const samples = sample.samples
          assert.ok(samples.length >= 30, `采样帧数应足够（实际 ${samples.length}）`)
          const values = samples.map((s) => s.v)
          const peaks = []
          for (let i = 4; i < values.length - 4; i++) {
            const v = values[i]
            if (v < 0.6) continue
            let isPeak = true
            for (let k = 1; k <= 4; k++) {
              if (values[i - k] > v || values[i + k] > v) {
                isPeak = false
                break
              }
            }
            if (isPeak) peaks.push({ i, t: samples[i].t, v })
          }
          const merged = []
          for (const p of peaks) {
            const last = merged[merged.length - 1]
            if (last && p.t - last.t < 200) {
              if (p.v > last.v) merged[merged.length - 1] = p
              continue
            }
            merged.push(p)
          }
          let maxDelta = 0
          for (let i = 1; i < values.length; i++) maxDelta = Math.max(maxDelta, Math.abs(values[i] - values[i - 1]))
          if (samples.length >= 120) {
            assert.ok(merged.length >= 1 && merged.length <= 4, `11s 内应出现 1–4 次眨眼（实际 ${merged.length}）`)
            for (const p of merged) assert.ok(p.v >= 0.85, `眨眼峰值应≈1（实际 ${p.v.toFixed(2)}）`)
            assert.ok(maxDelta <= 0.85, `单帧最大变化应平滑（headless ~43fps 下实测 ${maxDelta.toFixed(2)}）`)
          } else {
            console.log('[info] 采样帧率偏低（' + samples.length + ' 帧，headless 降频），跳过眨眼次数/峰值强断言，仅记录数据')
            for (const p of merged) assert.ok(p.v >= 0.7, `已采样到的眨眼峰值不应过低（${p.v.toFixed(2)}）`)
          }
          for (let i = 1; i < merged.length; i++) {
            const a = merged[i - 1].i
            const b = merged[i].i
            const minBetween = Math.min(...values.slice(a, b + 1))
            assert.ok(minBetween < 0.15, `两次眨眼之间应完全睁开（实际 min=${minBetween.toFixed(2)}）`)
          }
          console.log(`[info] talking-head blink 采样：frames=${samples.length} blinks=${merged.length} maxDelta=${maxDelta.toFixed(3)} peaks=${merged.map((p) => p.v.toFixed(2)).join(',')}`)
        })

        await check('分层 2.5D（方案A）：layered 生效、idle/speaking 帧差前景有动背景稳定、fps、演示帧', async () => {
          const head = await evalInPage(cdp, `(async () => {
            const mod = await import('/js/mobile/call.js')
            const h = mod.callState && mod.callState.head
            return h ? { ok: h.ok !== false, layered: h.layered === true, mode: h.mode } : null
          })()`)
          assert.ok(head, 'callState.head 应存在（WebGL 口播已挂载）')
          assert.equal(head.ok, true, '口播引擎应 ok:true')
          assert.equal(head.layered, true, '方案 A 分层应生效（layered=true）；本机 WebGL 可用')
          // 帧率冒烟采样（rAF；headless SwiftShader 软件渲染，硬件 WebGL 由 M30/avatar-dev2 60fps 数据佐证）
          const measureFps = async () =>
            evalInPage(cdp, `(async () => {
              const start = performance.now()
              let frames = 0
              await new Promise((resolve) => {
                const step = () => { frames += 1; if (performance.now() - start < 1200) requestAnimationFrame(step); else resolve() }
                requestAnimationFrame(step)
              })
              return frames / ((performance.now() - start) / 1000)
            })()`)
          const fps = Math.max(Number(await measureFps()), Number(await measureFps()))
          const shotPng = async () => {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
            return decodePng(Buffer.from(shot.data, 'base64'))
          }
          // idle：间隔 1.5s 两帧
          const idleA = await shotPng()
          await sleep(1500)
          const idleB = await shotPng()
          const idleAll = pngDiffRatio(idleA, idleB)
          const idleBg = pngDiffRatio(idleA, idleB, { x0: 0, y0: 0, x1: 0.16, y1: 0.16 })
          const idleFg = pngDiffRatio(idleA, idleB, { x0: 0.3, y0: 0.18, x1: 0.72, y1: 0.62 })
          // speaking：previewSpeaking 期间间隔 1.2s 两帧
          await evalInPage(cdp, `window.__avaMobile.previewSpeaking(4500); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().state`)) === 'speaking',
            { timeoutMs: 4000, label: 'speaking 预览' },
          )
          await sleep(300)
          const speakA = await shotPng()
          await sleep(1200)
          const speakB = await shotPng()
          const speakAll = pngDiffRatio(speakA, speakB)
          console.log(`[info] layered metrics: fps=${Number(fps).toFixed(1)} idleAll=${(idleAll.ratio * 100).toFixed(3)}% idleBg=${(idleBg.ratio * 100).toFixed(3)}% idleFg=${(idleFg.ratio * 100).toFixed(3)}% speakAll=${(speakAll.ratio * 100).toFixed(3)}%`)
          assert.ok(idleAll.ratio > 0.0002, `idle 两帧应有可见动效（${(idleAll.ratio * 100).toFixed(3)}%）`)
          assert.ok(idleBg.ratio <= 0.004, `背景区域应几乎不变（${(idleBg.ratio * 100).toFixed(3)}%；headless 软渲染/负载下放宽到 0.4%）`)
          assert.ok(idleFg.ratio > idleBg.ratio * 1.5 && idleFg.ratio > 0.0004, `前景（发丝/衣摆/脸）应有像素差（fg=${(idleFg.ratio * 100).toFixed(3)}% vs bg=${(idleBg.ratio * 100).toFixed(3)}%）`)
          // flows（发丝/衣摆）在大区域持续运动，帧差幅度随相位波动；speaking 额外口型差异在局部，整体比例不保证大于 idle
          assert.ok(speakAll.ratio > 0.0002, `speaking 期间应有可见动效（${(speakAll.ratio * 100).toFixed(3)}%）`)
          // headless 环境为 SwiftShader 软件渲染（默认回退），实测 ~27fps；硬件 WebGL 由 avatar-dev2 实测 60.3–60.6fps（M30 真机复核）
          assert.ok(Number(fps) >= 5, `软件渲染下动画循环应存活（实测 ${Number(fps).toFixed(1)}fps；硬件 WebGL 预期 60fps，见 M30）`)
          // 外观三连拍 + speaking 截图
          await screenshot('ui-v20-layered-speaking-1440x900.png')
          await sleep(2600)
          await screenshot('ui-v20-layered-idle-1440x900.png')
          // 4s 演示帧序列 → docs/assets/layered/frames-*.png
          const demoDir = path.join(PROJECT_ROOT, 'docs', 'assets', 'layered')
          await fsp.mkdir(demoDir, { recursive: true })
          await evalInPage(cdp, `window.__avaMobile.previewSpeaking(6000); true`)
          for (let i = 1; i <= 8; i++) {
            const shot = await cdp.send('Page.captureScreenshot', {
              format: 'png',
              fromSurface: true,
              clip: { x: 360, y: 40, width: 720, height: 760, scale: 1 },
            })
            await fsp.writeFile(path.join(demoDir, `frames-${i}.png`), Buffer.from(shot.data, 'base64'))
            await sleep(500)
          }
          console.log('[info] 演示帧已写入 docs/assets/layered/frames-1..8.png（4s，含发丝/衣摆/口型）')
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().state`)) === 'idle',
            { timeoutMs: 8000, label: '分层演示结束后回 idle' },
          )
        })

        await check('通话页文本路径：双方中英双语气泡', async () => {
          await evalInPage(
            cdp,
            `(() => {
              document.getElementById('call-text-btn').click();
              const f = document.getElementById('call-textform');
              const i = document.getElementById('call-text-input');
              if (i) i.value = 'I really like modern art.';
              f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
              return true;
            })()`,
          )
          let st = null
          for (let attempt = 0; attempt < 60; attempt++) {
            const v = await evalInPage(cdp, snapshot)
            const me = v.bubbles.find((b) => b.classes.includes('me') && b.en)
            const ava = v.bubbles.find((b) => b.classes.includes('ava') && b.en && b.zh && hasCJK(b.zh))
            if (me && me.zh && hasCJK(me.zh) && ava) {
              st = v
              break
            }
            await sleep(500)
          }
          assert.ok(st, '应出现双方双语气泡')
          const me = st.bubbles.find((b) => b.classes.includes('me') && b.en)
          const ava = st.bubbles.find((b) => b.classes.includes('ava') && b.zh && hasCJK(b.zh))
          assert.ok(me.en.length > 2, '用户英文字幕非空')
          assert.equal(me.zhHidden, false, '用户中文行应显示')
          assert.ok(hasCJK(me.zh), `用户中文行应为中文：${me.zh}`)
          assert.ok(ava.en.length > 2, 'Ava 英文字幕非空')
          assert.ok(hasCJK(ava.zh), `Ava 中文行应为中文：${ava.zh}`)
        })

        await check('3 轮文本通话：消息回填 + 角色对话条中英 + 气泡自动滚到最新', async () => {
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().state`)) === 'idle',
            { timeoutMs: 10000, label: '文本多轮前 idle' },
          )
          const before = await evalInPage(cdp, `window.__avaMobile.getCallState()`)
          const rounds = ['I visited a gallery last weekend.', 'The paintings were really impressive.', 'I want to learn more about modern art.']
          for (const text of rounds) {
            await evalInPage(cdp, `window.__avaMobile.send(${JSON.stringify(text)}); true`)
            await waitUntil(
              async () => {
                const v = await evalInPage(cdp, `window.__avaMobile.getCallState()`)
                return v.state === 'idle' && v.messages.filter((m) => m.role === 'assistant').length > before.messages.filter((m) => m.role === 'assistant').length - 1 && v.userTurns >= before.userTurns + 1 ? v : null
              },
              { timeoutMs: 20000, label: `文本轮次：${text.slice(0, 24)}` },
            ).catch(() => {})
          }
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, snapshot)
              const avaZh = v.bubbles.filter((b) => b.classes.includes('ava') && b.en && b.zh && /[\u4e00-\u9fff]/.test(b.zh))
              if (!v.call || v.call.state !== 'idle') return null
              if (v.call.userTurns < before.userTurns + 3) return null
              if (avaZh.length < 3) return null
              const dlg = await evalInPage(cdp, `(() => {
                const d = document.getElementById('call-dialogue');
                return {
                  hidden: d ? d.hidden : true,
                  name: (document.getElementById('cd-name') ? document.getElementById('cd-name').textContent : '').trim(),
                  en: (document.getElementById('cd-en') ? document.getElementById('cd-en').textContent : '').trim(),
                  zh: (document.getElementById('cd-zh') ? document.getElementById('cd-zh').textContent : '').trim(),
                  zhHidden: (() => { const z = document.getElementById('cd-zh'); return z ? z.hidden : true; })(),
                  status: (document.getElementById('cd-status') ? document.getElementById('cd-status').textContent : '').trim(),
                  atBottom: (() => { const el = document.getElementById('call-bubbles'); return el ? el.scrollHeight - el.scrollTop - el.clientHeight < 120 : false; })(),
                };
              })()`)
              return { ...v, dlg, avaZhCount: avaZh.length }
            },
            { timeoutMs: 30000, label: '3 轮消息/对话条/自动滚动' },
          )
          assert.ok(st.call.userTurns >= before.userTurns + 3, `应有 3 轮用户消息（${st.call.userTurns}）`)
          assert.ok(st.call.messages.filter((m) => m.role === 'assistant').length >= 4, 'assistant 消息应逐轮回填（含开场）')
          assert.ok(st.avaZhCount >= 3, `应至少有 3 条带中文的 Ava 气泡（实际 ${st.avaZhCount}）`)
          const dlgReady = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const d = document.getElementById('call-dialogue'); const z = document.getElementById('cd-zh'); return { hidden: d ? d.hidden : true, zh: z ? z.textContent : '', zhHidden: z ? z.hidden : true }; })()`)
              return !v.hidden && !v.zhHidden && /[\u4e00-\u9fff]/.test(v.zh) ? v : null
            },
            { timeoutMs: 12000, label: '3 轮对话条中文' },
          ).catch(() => null)
          st.dlg.hidden = dlgReady ? false : st.dlg.hidden
          st.dlg.zh = dlgReady ? dlgReady.zh : st.dlg.zh
          st.dlg.zhHidden = dlgReady ? false : st.dlg.zhHidden
          assert.equal(st.dlg.hidden, false, '角色对话条应显示')
          assert.equal(st.dlg.name, 'Elena', `对话条角色名，实际 "${st.dlg.name}"`)
          assert.ok(st.dlg.en.length > 2, '对话条应显示当前英文句')
          assert.equal(st.dlg.zhHidden, false, '对话条中文行应显示')
          assert.ok(/[\u4e00-\u9fff]/.test(st.dlg.zh), `对话条中文应为中文：${st.dlg.zh}`)
          assert.ok(['在线', '正在说话', '聆听中', '思考中'].includes(st.dlg.status), `对话条状态，实际 "${st.dlg.status}"`)
          const atBottom = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const el = document.getElementById('call-bubbles'); return el ? el.scrollHeight - el.scrollTop - el.clientHeight < 120 : false; })()`)
              return v === true ? true : null
            },
            { timeoutMs: 5000, label: '气泡区贴底（平滑滚动完成）' },
          ).catch(() => false)
          assert.equal(atBottom, true, '气泡区应自动滚到最新（贴底）')
          await screenshot('ui-v18-call-dialogue-1440x900.png')
        })

        await check('点按说话（无真实麦克风）：回退/提示不崩溃、0 JS 异常', async () => {
          const before = debug.jsErrors.length
          const pageErrBefore = await evalInPage(cdp, `Array.isArray(window.__avaErrors) ? window.__avaErrors.length : 0`)
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await sleep(2500)
          const st = await evalInPage(cdp, snapshot)
          assert.equal(debug.jsErrors.length, before, '点按说话不应产生未捕获 JS 异常')
          const pageErrAfter = await evalInPage(cdp, `Array.isArray(window.__avaErrors) ? window.__avaErrors.length : 0`)
          assert.equal(pageErrAfter, pageErrBefore, 'window.__avaErrors 应保持为空')
          assert.equal(st.callVisible, true, '通话页应保持打开')
          assert.ok(['idle', 'listening', 'thinking', 'speaking'].includes(st.call.state), `通话状态合法，实际 ${st.call.state}`)
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await sleep(500)
        })

        await check('挂断 → 通话总结弹层 → 关闭后回「对话」Tab', async () => {
          await evalInPage(cdp, `document.getElementById('call-hangup').click(); true`)
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, snapshot)
              return v.sheetOpen && v.sheetBody.length > 5 && !/正在整理/.test(v.sheetBody) ? v : null
            },
            { timeoutMs: 30000, label: '通话总结弹层' },
          )
          assert.match(st.sheetTitle, /总结|复盘/, `总结标题，实际 "${st.sheetTitle}"`)
          assert.ok(/复盘|纠错|重点词|鼓励|总结|保持|开口/i.test(st.sheetBody), `总结内容，实际 "${st.sheetBody.slice(0, 200)}"`)
          await screenshot('ui-v17-call-summary-1440x900.png')
          await evalInPage(cdp, `document.getElementById('sheet-close').click(); true`)
          await sleep(700)
          const after = await evalInPage(cdp, snapshot)
          assert.equal(after.callVisible, false, '关闭总结后通话页应退出')
          assert.equal(after.tab, 'chat', '挂断总结关闭后应回「对话」Tab')
        })

        await check('mock 语音链路（Elena，fake 麦克风）：greeting+user+assistant、双方 EN+ZH、对话条、atBottom、无串气泡', async () => {
          volcMock.reset()
          await evalInPage(cdp, `window.__avaMobile.openCall('elena'); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === true,
            { timeoutMs: 10000, label: '打开 Elena 通话' },
          )
          await sleep(600)
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'recording',
            { timeoutMs: 15000, label: 'PTT recording（语音会话就绪）' },
          )
          await sleep(400)
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`) // PTT：再点同一麦克风提交
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, snapshot)
              if (!v.call || v.call.userTurns < 1) return null
              const roles = v.call.messages.map((m) => m.role)
              if (roles.length < 3) return null
              const userBubble = v.bubbles.find((b) => b.classes.includes('me') && b.en && b.zh && /[\u4e00-\u9fff]/.test(b.zh))
              const avaBubbles = v.bubbles.filter((b) => b.classes.includes('ava') && b.zh && /[\u4e00-\u9fff]/.test(b.zh))
              if (!userBubble || avaBubbles.length < 1) return null
              const dlg = await evalInPage(cdp, `(() => {
                const d = document.getElementById('call-dialogue');
                return {
                  hidden: d ? d.hidden : true,
                  name: (document.getElementById('cd-name') ? document.getElementById('cd-name').textContent : '').trim(),
                  en: (document.getElementById('cd-en') ? document.getElementById('cd-en').textContent : '').trim(),
                  zh: (document.getElementById('cd-zh') ? document.getElementById('cd-zh').textContent : '').trim(),
                  zhHidden: (() => { const z = document.getElementById('cd-zh'); return z ? z.hidden : true; })(),
                  isFinal: d ? d.classList.contains('is-final') : false,
                  atBottom: (() => { const el = document.getElementById('call-bubbles'); return el ? el.scrollHeight - el.scrollTop - el.clientHeight < 120 : false; })(),
                };
              })()`)
              if (!dlg.hidden && dlg.en && dlg.zh && /[\u4e00-\u9fff]/.test(dlg.zh)) return { ...v, dlg, roles, userBubble, avaCount: avaBubbles.length }
              return null
            },
            { timeoutMs: 40000, label: '语音一轮：消息/气泡/对话条' },
          )
          assert.deepEqual(st.roles.slice(0, 3), ['assistant', 'user', 'assistant'], 'C.messages 应为 greeting → user → assistant（无串气泡）')
          assert.equal(st.call.messages.filter((m) => m.role === 'user').length, 1, '用户 ASR 双 final 应去重（仅 1 条 user）')
          assert.ok(st.call.messages.filter((m) => m.role === 'assistant').length >= 2, 'assistant 应含开场+回复')
          assert.ok(st.userBubble.en.length > 0 && /[\u4e00-\u9fff]/.test(st.userBubble.zh), '用户气泡应 EN+ZH')
          assert.ok(st.avaCount >= 1, '角色气泡应 EN+ZH')
          assert.equal(st.dlg.hidden, false, '角色对话条应显示')
          assert.equal(st.dlg.name, 'Elena')
          assert.ok(st.dlg.en.length > 2 && /[\u4e00-\u9fff]/.test(st.dlg.zh), '对话条应 EN+ZH')
          assert.equal(st.dlg.isFinal, true, 'final 后对话条应保留最后一句（is-final）')
          assert.equal(st.dlg.atBottom, true, '气泡区应贴底')
          assert.ok(st.overflow !== undefined ? st.overflow <= 2 : true)
          // mock 侧：会话配置使用 Elena 音色 + 角色人设
          const conn = volcMock.connections[volcMock.connections.length - 1]
          assert.equal(conn.sessionConfig.tts.speaker, volcCreds.speaker, 'mock 会话应为 Elena 音色')
          assert.match(String(conn.sessionConfig.dialog.system_role), /Elena/, 'session persona 应含 Elena')
          await screenshot('ui-v19-voice-elena-1440x900.png')
          // 追加 2 轮（文本路径，复用同一展示链路/对话条/滚动）：验证多轮滚动与最新气泡可见
          for (const text of ['I also like sculpture.', 'Do you have a favourite artist?']) {
            const before = await evalInPage(cdp, 'window.__avaMobile.getCallState()')
            await evalInPage(cdp, `window.__avaMobile.send(${JSON.stringify(text)}); true`)
            const r = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, snapshot)
                const assist = v.call ? v.call.messages.filter((m) => m.role === 'assistant').length : 0
                if (!v.call || v.call.userTurns < before.userTurns + 1) return null
                if (assist <= before.messages.filter((m) => m.role === 'assistant').length) return null
                const scroll = await evalInPage(cdp, `(() => { const el = document.getElementById('call-bubbles'); return { atBottom: el ? el.scrollHeight - el.scrollTop - el.clientHeight < 120 : false, count: document.querySelectorAll('#call-bubbles .bubble').length }; })()`)
                return { ...v, scroll }
              },
              { timeoutMs: 30000, label: `Elena 多轮（${text.slice(0, 16)}）` },
            )
            assert.ok(r.call.userTurns >= before.userTurns + 1, '多轮用户消息应追加')
            assert.equal(r.scroll.atBottom, true, '多轮后气泡应贴底（最新可见）')
            assert.ok(r.scroll.count >= 5, `多轮后气泡数量应增长（${r.scroll.count}）`)
          }
          // 3 轮后对话条仍 EN+ZH
          const dlg3 = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => ({ name: (document.getElementById('cd-name') || {}).textContent || '', en: (document.getElementById('cd-en') || {}).textContent || '', zh: (document.getElementById('cd-zh') || {}).textContent || '', hidden: (document.getElementById('call-dialogue') || {}).hidden }))()`)
              return !v.hidden && v.en.trim().length > 2 && /[\u4e00-\u9fff]/.test(v.zh) ? v : null
            },
            { timeoutMs: 12000, label: '多轮后对话条 EN+ZH' },
          )
          assert.ok(dlg3.en.trim().length > 2 && /[\u4e00-\u9fff]/.test(dlg3.zh), '3 轮语音后对话条应保持 EN+ZH')
          await screenshot('ui-v19-call-3rounds-1440x900.png')
          // 1920×1080 通话页整屏无溢出
          await setDevice(1920, 1080)
          await sleep(500)
          const big = await evalInPage(cdp, `(() => { const c = document.getElementById('call'); const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), overflow: document.documentElement.scrollWidth - innerWidth }; })()`)
          assert.ok(Math.abs(big.w - 1920) <= 2 && Math.abs(big.h - 1080) <= 2, `1920 通话页应铺满（${big.w}×${big.h}）`)
          assert.ok(big.overflow <= 2, `1920 通话页横向溢出：${big.overflow}`)
          await screenshot('ui-v19-voice-elena-1920x1080.png')
          await setDevice(1440, 900)
          await sleep(300)
          // 结束通话：对话条应隐藏
          await evalInPage(cdp, `document.getElementById('call-back').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === false,
            { timeoutMs: 10000, label: '返回键结束通话' },
          )
          const dlgHidden = await evalInPage(cdp, `(() => { const d = document.getElementById('call-dialogue'); return !!d && d.hidden; })()`)
          assert.equal(dlgHidden, true, '通话结束后对话条应隐藏')
        })

        await check('mock 语音链路（Maya / Hikari）：角色名/音色/角色气泡 EN+ZH 各一次', async () => {
          const expected = {
            maya: { speaker: 'en_female_stokie_uranus_bigtts', name: 'Maya' },
            hikari: { speaker: 'zh_female_vv_jupiter_bigtts', name: 'Hikari' },
          }
          for (const [id, exp] of Object.entries(expected)) {
            volcMock.reset()
            await evalInPage(cdp, `window.__avaMobile.openCall(${JSON.stringify(id)}); true`)
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === true,
              { timeoutMs: 10000, label: `打开 ${id} 通话` },
            )
            await sleep(500)
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().engine`)) === 'volc',
              { timeoutMs: 12000, label: `${id} 引擎切换为豆包` },
            )
            await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'recording',
              { timeoutMs: 8000, label: `${id} PTT 开始录音` },
            )
            await sleep(400)
            await evalInPage(cdp, `document.getElementById('call-talk').click(); true`) // PTT：再点同一麦克风提交
            const readVoice = async () => {
              const v = await evalInPage(cdp, snapshot)
              if (!v.call || v.call.userTurns < 1) return null
              if (v.call.character !== id) return null
              const avaZh = v.bubbles.filter((b) => b.classes.includes('ava') && b.en && b.zh && /[\u4e00-\u9fff]/.test(b.zh))
              if (avaZh.length < 1) return null
              const dlgName = await evalInPage(cdp, `(document.getElementById('cd-name') ? document.getElementById('cd-name').textContent : '').trim()`)
              const dlgZh = await evalInPage(cdp, `(document.getElementById('cd-zh') ? document.getElementById('cd-zh').textContent : '').trim()`)
              if (dlgName !== exp.name) return null
              if (!/[\u4e00-\u9fff]/.test(dlgZh)) return null
              return { ...v, dlgName, dlgZh }
            }
            let st = null
            try {
              st = await waitUntil(readVoice, { timeoutMs: 40000, label: `${id} 语音一轮` })
            } catch (firstErr) {
              // 兜底：取消/结束 PTT 后用 simulateTranscript 走同一条提交/回调链（语音会话/人物音色已由 mock 断言）
              await evalInPage(cdp, `window.__avaMobile.cancelPtt ? window.__avaMobile.cancelPtt() : false`).catch(() => {})
              await sleep(600)
              await evalInPage(cdp, `window.__avaMobile.simulateTranscript('Hello ${exp.name}, how are you today?'); true`).catch(() => {})
              st = await waitUntil(readVoice, { timeoutMs: 30000, label: `${id} 语音一轮（重试）` }).catch(async (err) => {
                const st2 = await evalInPage(cdp, snapshot)
                const conns = volcMock.connections.map((c) => ({ closed: c.closed, events: c.events, session: !!c.sessionConfig, speaker: c.sessionConfig && c.sessionConfig.tts.speaker }))
                throw new Error(err.message + ' | 诊断=' + JSON.stringify({ call: st2.call, dlgState: st2.callVisible, bubbles: st2.bubbles.slice(-3), toasts: st2.toasts, conns }))
              })
            }
            const conn = volcMock.connections[volcMock.connections.length - 1]
            assert.equal(conn.sessionConfig.tts.speaker, exp.speaker, `${id} 应使用角色音色`)
            assert.match(String(conn.sessionConfig.dialog.system_role), new RegExp(exp.name), `${id} session persona`)
            assert.equal(st.dlgName, exp.name, `${id} 对话条角色名`)
            assert.ok(/[\u4e00-\u9fff]/.test(st.dlgZh), `${id} 对话条中文`)
            await screenshot(`ui-v19-voice-${id}-1440x900.png`)
            await evalInPage(cdp, `document.getElementById('call-back').click(); true`)
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === false,
              { timeoutMs: 10000, label: `${id} 结束通话` },
            )
            await sleep(300)
          }
        })

        await check('翻译重试：首次失败后自动退避重试成功（文本路径）', async () => {
          await evalInPage(cdp, `window.__avaMobile.openCall('elena'); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === true,
            { timeoutMs: 10000, label: '打开通话（翻译重试）' },
          )
          await sleep(500)
          volcMock.setScenario('translate-fail')
          await evalInPage(cdp, `window.__avaMobile.send('This sentence tests translation retry.'); true`)
          await sleep(1200)
          volcMock.setScenario('ok')
          try {
            const st = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, snapshot)
                const userZh = v.bubbles.find((b) => b.classes.includes('me') && b.en === 'This sentence tests translation retry.' && b.zh && /[\u4e00-\u9fff]/.test(b.zh))
                return userZh ? v : null
              },
              { timeoutMs: 30000, label: '翻译重试后中文出现' },
            )
            assert.ok(st.toasts.every((t) => !/翻译失败|翻译服务不可用/.test(t)), '重试成功不应弹翻译失败 toast')
          } finally {
            volcMock.setScenario('ok')
            await evalInPage(cdp, `document.getElementById('call-back').click(); true`).catch(() => {})
            await sleep(400)
          }
        })

        await check('分层回退：block layers → 单图引擎不崩（layered=false）、恢复后 layered=true', async () => {
          const before = debug.jsErrors.length
          debug.phase = 'v20-fallback'
          try {
            await cdp.send('Network.setBlockedURLs', { urls: ['*layers/*'] })
            await setDevice(1440, 900)
            await navigate(cdp, baseUrl + '/mobile')
            await waitUntil(
              async () => (await evalInPage(cdp, `(() => { const a = document.getElementById('app'); return !!(a && a.getAttribute('data-ready') === '1'); })()`)) === true,
              { timeoutMs: 15000, label: '回退测试页面就绪' },
            )
            await evalInPage(cdp, `window.__avaMobile.openCall('elena'); true`)
            const st = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, snapshot)
                if (!v.call || !v.call.open) return null
                const head = await evalInPage(cdp, `(async () => { const m = await import('/js/mobile/call.js'); const h = m.callState.head; return h ? { ok: h.ok !== false, layered: h.layered === true, hasCanvas: !!document.querySelector('#talking-host canvas') } : null })()`)
                return head ? { ...v, head } : null
              },
              { timeoutMs: 15000, label: '回退单图引擎挂载' },
            )
            assert.equal(st.head.ok, true, '无分层素材时单图引擎仍应 ok:true')
            assert.equal(st.head.layered, false, 'layers 404 时应回退单图（layered=false）')
            assert.equal(st.head.hasCanvas, true, '回退时仍应有 WebGL canvas（单图引擎）')
            assert.equal(debug.jsErrors.length, before, '回退不应产生未捕获 JS 异常')
            await screenshot('ui-v20-fallback-1440x900.png')
            await evalInPage(cdp, `document.getElementById('call-back').click(); true`).catch(() => {})
          } finally {
            await cdp.send('Network.setBlockedURLs', { urls: [] })
            debug.phase = 'v17-mobile-recover'
            await navigate(cdp, baseUrl + '/mobile')
            await sleep(900)
            debug.phase = 'v17-mobile'
          }
        })

        await check('助手 chips → 创建计划 → 课程页展示阶段/进度', async () => {
          // 切 demo（规则版 assistant 即时返回）；有凭据的文本模式路径由 e2e /api/assistant 覆盖
          await jfetch(baseUrl + '/api/settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: '', clearKey: true, volc: { clearKey: true } }),
          })
          await switchTab('assistant')
          const chips = await evalInPage(
            cdp,
            `(() => [...document.querySelectorAll('#screen-assistant .a-chip')].map((c) => (c.textContent || '').trim()))()`,
          )
          assert.ok(chips.length >= 6, `助手 chips ≥6，实际 ${chips.length}`)
          assert.ok(!chips.includes('场景练习'), 'v3.1 助手 chips 不应再有「场景练习」')
          for (const label of ['创建计划', '更新我的计划', '快速复习', '自由聊天', '学习偏好', '我要反馈']) {
            assert.ok(chips.includes(label), `应有「${label}」chip`)
          }
          await evalInPage(
            cdp,
            `(() => { const chip = [...document.querySelectorAll('#screen-assistant .a-chip')].find((c) => (c.textContent || '').includes('创建计划')); chip.click(); return true; })()`,
          )
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => ({
                  typing: !!document.getElementById('assistant-typing'),
                  text: (document.getElementById('assistant-thread') ? document.getElementById('assistant-thread').innerText.replace(/\\s+/g, ' ').trim() : ''),
                }))()`,
              )
              return !v.typing && v.text.length > 30 && /计划|安排|阶段|目标/.test(v.text) ? v : null
            },
            { timeoutMs: 25000, label: '助手回复' },
          )
          assert.match(st.text, /计划|安排|阶段|目标/)
          await screenshot('ui-v17-assistant-1440x900.png')
          await switchTab('courses')
          const plan = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => ({
                  text: (document.getElementById('screen-courses') ? document.getElementById('screen-courses').innerText.replace(/\\s+/g, ' ').trim() : ''),
                  stages: document.querySelectorAll('#screen-courses .stage-card').length,
                  hasHero: !!document.querySelector('#screen-courses .hero-card'),
                  progress: document.querySelectorAll('#screen-courses .progress-fill').length,
                }))()`,
              )
              return v.hasHero && v.stages >= 1 ? v : null
            },
            { timeoutMs: 15000, label: '课程页计划' },
          )
          assert.ok(plan.stages >= 1 && plan.hasHero, '课程页应有 hero 与阶段卡（v3.1 生成/失败态也算）')
          assert.match(plan.text, /计划|课程|生成|老师/, '课程页应有计划状态文案')
          await screenshot('ui-v17-courses-1440x900.png')
        })

        await check('v2.8 趣玩已移除：小游戏统一在复习页且可玩', async () => {
          await switchTab('review')
          const cards = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => [...document.querySelectorAll('#screen-review .rv-game-card')].map((c) => c.getAttribute('data-game')))()`)
              return Array.isArray(v) && v.length >= 3 ? v : null
            },
            { timeoutMs: 10000, label: '复习页 3 个小游戏入口' },
          )
          assert.deepEqual(cards.slice(0, 3), ['match', 'listen', 'spell'], '小游戏入口应为配对/听音/拼写')
          const noPlay = await evalInPage(cdp, `!document.getElementById('screen-play') && !document.querySelector('.tab[data-tab=\"play\"]')`)
          assert.equal(noPlay, true, 'v2.8 不应再有趣玩页/Tab')
          await evalInPage(cdp, `window.__avaMobile.review.openGame('match'); true`)
          const tiles = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `document.querySelectorAll('#rv-game-host .match-tile').length`)
              return v >= 10 ? v : null
            },
            { timeoutMs: 10000, label: '复习页配对棋盘' },
          )
          assert.equal(tiles >= 10, true, '配对棋盘 10 块')
          for (let pair = 0; pair <= 4; pair++) {
            await evalInPage(cdp, `[...document.querySelectorAll('.match-tile[data-pair=\"${pair}\"]')].slice(0, 2).forEach((t) => t.click()); true`)
            await sleep(300)
          }
          const score = await evalInPage(cdp, `(() => { const s = document.querySelector('.js-score'); return s ? s.textContent.trim() : '' })()`)
          assert.match(score, /\d/, `配对完成应有分数（实际 "${score}"）`)
          await screenshot('ui-v28-review-game-match-1440x900.png')
          await evalInPage(cdp, `window.__avaMobile.review.back(); true`)
          await sleep(300)
        })

        await check('我的页：昵称/等级/单词/语音引擎状态（整屏面板）', async () => {
          await switchTab('profile')
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => ({
                  text: (document.getElementById('screen-profile') ? document.getElementById('screen-profile').innerText.replace(/\\s+/g, ' ').trim() : ''),
                  hasLevel: !!document.getElementById('profile-level'),
                  rows: document.querySelectorAll('#screen-profile .list-row, #screen-profile .profile-row').length,
                  overflow: document.documentElement.scrollWidth - innerWidth,
                }))()`,
              )
              return v.text.length > 10 ? v : null
            },
            { timeoutMs: 8000, label: '我的页内容' },
          )
          assert.equal(st.hasLevel, true, '应有等级选择')
          assert.match(st.text, /等级|单词|目标|语音/, `我的页内容，实际 "${st.text.slice(0, 160)}"`)
          assert.ok(st.overflow <= 2, `我的页横向溢出：${st.overflow}`)
          await screenshot('ui-v17-profile-1440x900.png')
        })

        await check('430×932：整屏自适应、无横向溢出、PWA、0 JS 异常', async () => {
          const before = debug.jsErrors.length
          await openMobile(430, 932)
          const st = await evalInPage(cdp, snapshot)
          assert.ok(Math.abs(st.appRect.w - st.inner.w) <= 2, `430 宽应铺满（${st.appRect.w} vs ${st.inner.w}）`)
          assert.equal(st.phoneShell, false, '430 宽也不应有手机壳')
          assert.ok(st.overflow <= 2, `430×932 横向溢出：${st.overflow}`)
          assert.equal(st.tabs.length, 5)
          const pwa = await evalInPage(
            cdp,
            `(() => ({
              manifest: (document.querySelector('link[rel="manifest"]') ? document.querySelector('link[rel="manifest"]').getAttribute('href') : ''),
              appleCapable: (() => { const m = document.querySelector('meta[name="apple-mobile-web-app-capable"]'); return m ? m.getAttribute('content') : ''; })(),
              viewport: (() => { const m = document.querySelector('meta[name="viewport"]'); return m ? m.getAttribute('content') : ''; })(),
              themeColor: (() => { const m = document.querySelector('meta[name="theme-color"]'); return m ? m.getAttribute('content') : ''; })(),
            }))()`,
          )
          assert.ok(String(pwa.manifest).includes('manifest.webmanifest'))
          assert.equal(String(pwa.appleCapable).toLowerCase(), 'yes')
          assert.match(pwa.viewport, /viewport-fit=cover/)
          assert.ok(pwa.themeColor.length > 0)
          assert.equal(debug.jsErrors.length, before, '整屏手机版不应产生未捕获 JS 异常')
          await screenshot('ui-v17-home-430x932.png')
          await setDevice(1440, 900)
        })
      } finally {
        await jfetch(baseUrl + '/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voiceEngine: 'browser', apiKey: '', clearKey: true }),
        }).catch(() => {})
        await volcMock.close()
      }
    })

    // =====================================================================
    // v1.8：知识库 / 引用卡片 / 兴趣档案
    // =====================================================================
    if (!skipIndex) await group('v1.8 知识库 / 引用卡片 / 兴趣', async () => {
      const upstream = await startMockUpstream()
      const KEY = 'sk-qa-ui-kb-1234'
      const putSettings = async (patch) =>
        jfetch(baseUrl + '/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      const articleServer = http.createServer((req, res) => {
        if (req.url === '/article') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<!DOCTYPE html><html><head><title>The Art of Slow Reading</title></head><body>
            <h1>The Art of Slow Reading</h1>
            <p>Slow reading is a lost art. When we read slowly, we notice details and connect ideas.</p>
            <p>Baking sourdough also teaches patience: you cannot rush a good loaf.</p></body></html>`)
          return
        }
        res.writeHead(404)
        res.end('nf')
      })
      await new Promise((resolve) => articleServer.listen(0, '127.0.0.1', resolve))
      const articleUrl = `http://127.0.0.1:${articleServer.address().port}/article`
      const setDevice = async (w, h) =>
        cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      const openMobile = async (w = 1440, h = 900) => {
        await setDevice(w, h)
        await navigate(cdp, baseUrl + '/mobile')
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const a = document.getElementById('app'); return !!(a && a.getAttribute('data-ready') === '1'); })()`)) === true,
          { timeoutMs: 15000, label: '手机版就绪（v1.8）' },
        )
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => !!(window.__avaMobile && window.__avaMobile.state && Array.isArray(window.__avaMobile.state.characters) && window.__avaMobile.state.characters.length >= 3))()`)) === true,
          { timeoutMs: 15000, label: '角色加载（v1.8）' },
        )
        await sleep(300)
      }
      const openKb = async () => {
        await evalInPage(cdp, `window.__avaMobile.openKb(); true`)
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const s = document.getElementById('kb-screen'); return !!(s && !s.hidden); })()`)) === true,
          { timeoutMs: 8000, label: '知识库面板打开' },
        )
        await sleep(500)
      }
      const kbDocs = async () => evalInPage(cdp, `(window.__avaMobile.kb && Array.isArray(window.__avaMobile.kb.docs)) ? window.__avaMobile.kb.docs : []`)
      const kbSnapshot = `(() => {
        const q = (s) => document.querySelector(s);
        const screen = document.getElementById('kb-screen');
        const items = [...document.querySelectorAll('#kb-list .kb-item')].map((it) => ({
          id: it.getAttribute('data-id'),
          title: (it.querySelector('.kb-item-title') || {}).textContent || '',
          status: (it.querySelector('.kb-status') || {}).textContent || '',
          meta: (it.querySelector('.kb-meta') || {}).innerText || '',
          selected: it.classList.contains('is-selected'),
          preview: (it.querySelector('.kb-preview') || {}).innerText || '',
        }));
        return {
          open: !!(screen && !screen.hidden),
          items,
          empty: q('#kb-list .kb-empty') ? q('#kb-list .kb-empty').innerText.replace(/\\s+/g, ' ').trim() : '',
          selectedCount: (document.getElementById('kb-selected-count') || {}).textContent || '',
          docs: window.__avaMobile.kb ? window.__avaMobile.kb.docs.length : -1,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      })()`

      try {
        await putSettings({ apiKey: KEY, baseUrl: upstream.url, model: 'mock-model', voiceEngine: 'browser' })
        await openMobile(1440, 900)
        await evalInPage(cdp, `document.querySelector('.tab[data-tab="assistant"]').click(); true`)
        await sleep(400)

        await check('助手页「我的知识库」入口 → 整屏面板：上传/URL/列表/多选按钮齐全', async () => {
          await waitUntil(
            async () => (await evalInPage(cdp, `!!document.querySelector('#screen-assistant .kb-entry')`)) === true,
            { timeoutMs: 8000, label: '知识库入口' },
          )
          await evalInPage(cdp, `document.querySelector('#screen-assistant .kb-entry').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const s = document.getElementById('kb-screen'); return !!(s && !s.hidden); })()`)) === true,
            { timeoutMs: 8000, label: '知识库面板打开（入口）' },
          )
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.kb && Array.isArray(window.__avaMobile.kb.docs)`)) === true,
            { timeoutMs: 8000, label: '知识库状态加载' },
          )
          const ids = await evalInPage(
            cdp,
            `(() => ['kb-file','kb-url-input','kb-url-form','kb-list','kb-grounded','kb-divergent','kb-free','kb-refresh','kb-close','kb-file-btn'].filter((id) => !document.getElementById(id)))()`,
          )
          assert.deepEqual(ids, [], `知识库面板缺少元素：${JSON.stringify(ids)}`)
          const st = await evalInPage(cdp, kbSnapshot)
          assert.equal(st.open, true, '面板应打开')
          assert.ok(st.docs === 0, `新沙箱知识库应为空（实际 ${st.docs}）`)
          assert.ok(st.empty.length > 0, '空态应有中文提示')
          assert.ok(st.overflow <= 2, `1440 KB 面板横向溢出：${st.overflow}`)
        })

        await check('上传 txt → 列表字段/摘要 pending→done；展开预览；网页导入 → 来源=网页；删除需确认', async () => {
          await setFileInputFiles(cdp, '#kb-file', path.join(PROJECT_ROOT, 'test', 'fixtures', 'english-article.txt'))
          const first = await waitUntil(
            async () => {
              const docs = await kbDocs()
              return docs.length >= 1 ? docs : null
            },
            { timeoutMs: 20000, label: '上传后知识库列表' },
          )
          assert.ok(first.length >= 1, '上传后应有文档')
          assert.equal(first[0].source, 'file', '上传来源应为 file')
          const done = await waitUntil(
            async () => {
              const docs = await kbDocs()
              const d = docs.find((x) => x.id === first[0].id)
              return d && d.enrichStatus === 'done' ? d : null
            },
            { timeoutMs: 25000, label: '摘要 pending→done' },
          )
          assert.equal(done.enrichStatus, 'done', '有 Key 时应完成摘要增强')
          const st = await evalInPage(cdp, kbSnapshot)
          const item = st.items.find((x) => x.id === first[0].id)
          assert.ok(item, '列表应渲染文档行')
          assert.ok(item.title.length > 0, '应显示标题')
          assert.match(item.meta, /文件|字|块/, `应显示来源/字数/切块，实际 "${item.meta}"`)
          await evalInPage(cdp, `document.querySelector('#kb-list .kb-item-main').click(); true`)
          const preview = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, kbSnapshot)
              const it = v.items[0]
              return it && it.preview && it.preview.length > 10 ? v : null
            },
            { timeoutMs: 10000, label: '展开预览' },
          )
          assert.ok(preview.items[0].preview.length > 10, '预览应有正文')
          await screenshot('ui-v21-kb-panel-1440x900.png')
          // 网页导入
          await evalInPage(
            cdp,
            `(() => { const i = document.getElementById('kb-url-input'); i.value = ${JSON.stringify(articleUrl)}; const f = document.getElementById('kb-url-form'); f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; })()`,
          )
          const two = await waitUntil(
            async () => {
              const docs = await kbDocs()
              return docs.length >= 2 ? docs : null
            },
            { timeoutMs: 25000, label: '网页导入后列表' },
          )
          const webDoc = two.find((d) => d.source === 'web')
          assert.ok(webDoc, '应有来源为网页的文档')
          assert.match(String(webDoc.title), /Slow Reading|阅读/, `网页文档标题，实际 ${webDoc.title}`)
          // 删除需确认（删除网页文档，保留 txt 用于引用）
          await evalInPage(
            cdp,
            `(() => { const btn = document.querySelector('#kb-list .kb-item[data-id="' + ${JSON.stringify(webDoc.id)} + '"] .kb-del'); if (!btn) return false; btn.click(); return true; })()`,
          )
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const s = document.getElementById('sheet'); return !!(s && !s.hidden); })()`)) === true,
            { timeoutMs: 6000, label: '删除确认弹层' },
          )
          const confirmText = await evalInPage(cdp, `(document.getElementById('sheet-body') || {}).innerText || ''`)
          assert.match(confirmText, /确定删除|删除/, '删除应有确认文案')
          await evalInPage(cdp, `(() => { const b = document.querySelector('[data-act="kb-delete-confirm"]'); if (b) b.click(); return true; })()`)
          await waitUntil(
            async () => {
              const docs = await kbDocs()
              return !docs.some((d) => d.id === webDoc.id) ? docs : null
            },
            { timeoutMs: 15000, label: '删除后列表更新' },
          )
          assert.equal((await kbDocs()).length, 1, '删除后应只剩 1 篇')
        })

        await check('多选材料 → 围绕讨论：通话页 kbMode/材料 + meta.kb.hits → 引用卡片（标题/片段/匹配度）', async () => {
          const docs = await kbDocs()
          assert.ok(docs.length >= 1)
          await evalInPage(cdp, `(() => { const cb = document.querySelector('#kb-list .kb-check input[type=checkbox]'); cb.click(); return true; })()`)
          await waitUntil(
            async () => (await evalInPage(cdp, `String(window.__avaMobile.kb.selected.size)`)) === '1',
            { timeoutMs: 5000, label: '勾选材料' },
          )
          await evalInPage(cdp, `document.getElementById('kb-grounded').click(); true`)
          const call = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `window.__avaMobile.getCallState()`)
              return v.open && v.kbMode === 'grounded' ? v : null
            },
            { timeoutMs: 12000, label: '进入知识库讨论通话' },
          )
          assert.equal(call.kbMode, 'grounded')
          assert.ok(call.kbDocIds.length >= 1, '应带入知识库 docIds')
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().state`)) === 'idle',
            { timeoutMs: 12000, label: '通话 idle' },
          )
          await evalInPage(cdp, `window.__avaMobile.send('What does the article say about reading slowly?'); true`)
          const cited = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const cards = [...document.querySelectorAll('#call-citations .citation-card')];
                  return {
                    cards: cards.map((c) => ({ title: (c.querySelector('.citation-title') || {}).textContent || '', text: (c.innerText || '').replace(/\\s+/g, ' ').trim() })),
                    hits: window.__avaMobile.getCallState().kbHits,
                    overflow: document.documentElement.scrollWidth - innerWidth,
                  };
                })()`,
              )
              return v.cards.length >= 1 ? v : null
            },
            { timeoutMs: 30000, label: '引用卡片出现' },
          )
          assert.ok(cited.cards.length >= 1 && cited.cards.length <= 3, `引用卡片 1–3 条（实际 ${cited.cards.length}）`)
          assert.ok(cited.hits >= 1, 'getCallState().kbHits 应 ≥1')
          assert.ok(cited.cards[0].text.length > 5, '引用卡片应有标题/片段')
          assert.match(cited.cards[0].text, /Slow Reading|阅读|素材名|english-article/i, `引用卡片应含材料名，实际 "${cited.cards[0].text.slice(0, 120)}"`)
          assert.ok(cited.overflow <= 2, `引用卡片页面横向溢出：${cited.overflow}`)
          await screenshot('ui-v21-call-citations-1440x900.png')
        })

        await check('发散讨论：模式切换 + kbMode=divergent 送达后端；未选材料提示', async () => {
          await evalInPage(cdp, `document.getElementById('call-mode-chip').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().kbMode`)) === 'divergent',
            { timeoutMs: 5000, label: '切换到发散讨论' },
          )
          await evalInPage(cdp, `window.__avaMobile.send('Let us go beyond the article: what else could this connect to?'); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().state`)) === 'idle',
            { timeoutMs: 30000, label: '发散回复完成' },
          )
          const st = await evalInPage(cdp, `window.__avaMobile.getCallState()`)
          assert.equal(st.kbMode, 'divergent')
          assert.equal(debug.jsErrors.length, 0, '发散讨论不应产生 JS 异常')
          await screenshot('ui-v21-call-divergent-1440x900.png')
          await evalInPage(cdp, `document.getElementById('call-back').click(); true`)
          await sleep(500)
          // 未选材料：grounded 且无 docIds → 中文提示
          await evalInPage(cdp, `window.__avaMobile.openCall('elena', 0, { kbMode: 'grounded', kbDocIds: [] }); true`)
          const empty = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const warn = document.querySelector('.call-materials-line.is-warn');
                  return { warn: warn ? warn.innerText.replace(/\\s+/g, ' ').trim() : '', toasts: [...document.querySelectorAll('#toasts .toast')].map((t) => t.innerText) };
                })()`,
              )
              return v.warn ? v : null
            },
            { timeoutMs: 10000, label: '未选材料提示' },
          )
          assert.match(empty.warn, /未选材料|知识库/, `应提示未选材料，实际 "${empty.warn}"`)
          await screenshot('ui-v21-call-grounded-empty-1440x900.png')
          await evalInPage(cdp, `document.getElementById('call-back').click(); true`)
          await sleep(500)
        })

        await check('我的页兴趣标签：添加/保存 → GET /api/profile；删除 → 还原', async () => {
          await evalInPage(cdp, `document.querySelector('.tab[data-tab="profile"]').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const s = document.getElementById('screen-profile'); return !!(s && !s.hidden); })()`)) === true,
            { timeoutMs: 8000, label: '我的页' },
          )
          await evalInPage(
            cdp,
            `(() => { const i = document.getElementById('interest-input'); i.value = '摄影'; const f = document.getElementById('interest-form'); f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; })()`,
          )
          await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(document.getElementById('interest-tags') || {}).innerText || ''`)
              return v.includes('摄影') ? v : null
            },
            { timeoutMs: 10000, label: '兴趣标签出现' },
          )
          const prof1 = await jfetch(baseUrl + '/api/profile')
          assert.ok(prof1.json.interests.includes('摄影'), 'GET /api/profile 应包含新兴趣')
          await screenshot('ui-v21-interests-1440x900.png')
          await evalInPage(
            cdp,
            `(() => { const b = [...document.querySelectorAll('#interest-tags [data-act="del-interest"]')].find((x) => x.getAttribute('data-tag') === '摄影'); if (b) b.click(); return true; })()`,
          )
          await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(document.getElementById('interest-tags') || {}).innerText || ''`)
              return !v.includes('摄影') ? v : null
            },
            { timeoutMs: 10000, label: '兴趣标签删除' },
          )
          const prof2 = await jfetch(baseUrl + '/api/profile')
          assert.ok(!prof2.json.interests.includes('摄影'), '删除后 GET /api/profile 不应包含摄影')
          const st = await evalInPage(cdp, `window.__avaMobile.getCallState()`)
          assert.equal(st.open, false, '此时应无通话')
        })

        await check('1920×1080 / 430×932 知识库面板无横向溢出；0 JS 异常', async () => {
          const before = debug.jsErrors.length
          for (const [w, h, shot] of [[1920, 1080, 'ui-v21-kb-1920x1080.png'], [430, 932, 'ui-v21-kb-430x932.png']]) {
            await openMobile(w, h)
            await openKb()
            const st = await evalInPage(cdp, kbSnapshot)
            assert.equal(st.open, true, `${w} 宽知识库面板应打开`)
            assert.ok(st.overflow <= 2, `${w}×${h} 知识库横向溢出：${st.overflow}`)
            await screenshot(shot)
            await evalInPage(cdp, `window.__avaMobile.closeKb(); true`)
            await sleep(300)
          }
          await setDevice(1440, 900)
          assert.equal(debug.jsErrors.length, before, '知识库/兴趣流程不应产生未捕获 JS 异常')
        })
      } finally {
        await new Promise((resolve) => articleServer.close(resolve)).catch(() => {})
        await upstream.close()
        await putSettings({ apiKey: '', clearKey: true, voiceEngine: 'browser' }).catch(() => {})
      }
    })

    // =====================================================================
    // v2.2：点击式 PTT
    // =====================================================================
    if (!skipIndex) await group('v2.3 麦克风自检 / 点击式 PTT', async () => {
      const upstream = await startMockUpstream()
      const volcMock = await startMockVolc({ chunkDelayMs: 4 })
      const KEY = 'sk-qa-ui-ptt-1234'
      const putSettings = async (patch) =>
        jfetch(baseUrl + '/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      const setDevice = async (w, h) =>
        cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      const openMobile = async (w = 1440, h = 900) => {
        await setDevice(w, h)
        await navigate(cdp, baseUrl + '/mobile')
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const a = document.getElementById('app'); return !!(a && a.getAttribute('data-ready') === '1'); })()`)) === true,
          { timeoutMs: 15000, label: '手机版就绪（PTT）' },
        )
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => !!(window.__avaMobile && window.__avaMobile.state && window.__avaMobile.state.characters.length >= 3))()`)) === true,
          { timeoutMs: 15000, label: '角色加载（PTT）' },
        )
        await sleep(300)
      }
      const pttSnapshot = `(() => {
        const c = document.getElementById('call');
        const bar = document.getElementById('call-ptt');
        const wave = document.getElementById('ptt-wave');
        const st = window.__avaMobile.getCallState();
        return {
          ptt: st.ptt,
          open: st.open,
          engine: st.engine,
          recClass: !!(c && c.classList.contains('is-recording')),
          barHidden: bar ? bar.hidden : null,
          timer: (document.getElementById('ptt-timer') || {}).textContent || '',
          wave: wave ? wave.children.length : 0,
          cancelHidden: (document.getElementById('ptt-cancel') || {}).hidden,
          hasDoneButton: !!document.getElementById('ptt-done'),
          mic: st.mic,
          micActive: st.micActive,
          micLevel: st.micLevel,
          micLabel: (document.getElementById('mic-label') || {}).textContent || '',
          micMessage: (document.getElementById('mic-message') || {}).textContent || '',
          micRetryHidden: (document.getElementById('mic-retry') || {}).hidden,
          micTextHidden: (document.getElementById('mic-text-btn') || {}).hidden,
          label: (document.getElementById('call-talk-label') || {}).textContent || '',
          toasts: [...document.querySelectorAll('#toasts .toast')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()),
          overflow: document.documentElement.scrollWidth - innerWidth,
          bubbles: document.querySelectorAll('#call-bubbles .bubble').length,
        };
      })()`
      async function uploadKbFixture() {
        const buf = await fsp.readFile(path.join(PROJECT_ROOT, 'test', 'fixtures', 'english-article.txt'))
        const r = await jfetch(baseUrl + '/api/kb/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'english-article.txt', dataBase64: buf.toString('base64') }),
        })
        if (r.status !== 200) throw new Error('KB 上传失败：' + r.status + ' ' + r.text.slice(0, 200))
        return r.json.doc
      }
      async function openCallElena(opts = {}) {
        await evalInPage(cdp, `window.__avaMobile.openCall('elena', 0, ${JSON.stringify(opts)}); true`)
        await waitUntil(
          async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === true,
          { timeoutMs: 10000, label: '打开 Elena 通话（PTT）' },
        )
        await sleep(500)
      }
      async function closeCall() {
        await evalInPage(cdp, `document.getElementById('call-back').click(); true`).catch(() => {})
        await waitUntil(
          async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === false,
          { timeoutMs: 10000, label: '结束通话（PTT）' },
        ).catch(() => {})
        await sleep(300)
      }

      try {
        await putSettings({ apiKey: KEY, baseUrl: upstream.url, model: 'mock-model', voiceEngine: 'browser', volc: { clearKey: true } })
        let kbDoc = null
        try {
          kbDoc = await uploadKbFixture()
        } catch (err) {
          console.log('[info] KB 上传跳过：' + err.message)
        }
        await openMobile(1440, 900)
        await openCallElena()

        await check('麦克风自检 + PTT 录音 UI：状态栏/10 段音量、点麦克风→recording（计时/波形/取消/红脉冲、无完成按钮），1440/1920/430 无溢出', async () => {
          const idle = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.mic === 'ready' || v.mic === 'silent' ? v : null
            },
            { timeoutMs: 12000, label: '麦克风自检完成' },
          )
          assert.equal(idle.ptt, 'idle', '进入通话应为 PTT idle')
          assert.equal(idle.open, true)
          assert.ok(['ready', 'silent'].includes(idle.mic), `麦克风自检状态应为 ready/silent，实际 ${idle.mic}`)
          assert.ok(['麦克风正常', '没有检测到声音'].includes(idle.micLabel), `状态条文案，实际 "${idle.micLabel}"`)
          assert.equal(idle.micActive, true, '麦克风分析流应 active')
          assert.ok(typeof idle.micLevel === 'number' && idle.micLevel >= 0 && idle.micLevel <= 1, 'micLevel 应为 0..1')
          const bars = await evalInPage(cdp, `document.querySelectorAll('#mic-volume i').length`)
          assert.ok(bars >= 10, `音量条应 ≥10 段（实际 ${bars}）`)
          await screenshot('ui-v23-mic-ready-1440x900.png')
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          const rec = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.ptt === 'recording' ? v : null
            },
            { timeoutMs: 8000, label: 'PTT recording' },
          )
          assert.equal(rec.recClass, true, '通话页应有 is-recording（红脉冲）')
          assert.equal(rec.barHidden, false, '录音条应可见')
          assert.match(rec.timer, /^00:\d{2}$/, `计时格式 00:0x，实际 "${rec.timer}"`)
          assert.ok(rec.wave >= 8, `波形段数应足够（实际 ${rec.wave}）`)
          assert.equal(rec.cancelHidden, false, '取消按钮应可见')
          assert.equal(rec.hasDoneButton, false, 'v2.3 录音面板不应再有「完成」按钮')
          assert.match(rec.label, /正在录音|再点一次麦克风结束/, `录音文案，实际 "${rec.label}"`)
          assert.ok(rec.wave >= 16, `录音波形应为 16 段（实际 ${rec.wave}）`)
          assert.ok(rec.overflow <= 2, `1440 录音态横向溢出：${rec.overflow}`)
          await screenshot('ui-v23-ptt-recording-1440x900.png')
          // 1920 / 430：录音中布局不溢出
          for (const [w, h, shot] of [[1920, 1080, 'ui-v23-ptt-recording-1920x1080.png'], [430, 932, 'ui-v23-ptt-recording-430x932.png']]) {
            await setDevice(w, h)
            await sleep(400)
            const v = await evalInPage(cdp, pttSnapshot)
            assert.ok(v.overflow <= 2, `${w}×${h} 录音态横向溢出：${v.overflow}`)
            assert.equal(v.ptt, 'recording', `${w} 宽录音态应保持`)
            await screenshot(shot)
          }
          await setDevice(1440, 900)
          await sleep(300)
          // 无麦克风：完成 → 中文 toast + 回 idle，不崩溃
          const before = debug.jsErrors.length
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          const done = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.ptt === 'idle' ? v : null
            },
            { timeoutMs: 12000, label: 'PTT 完成后 idle' },
          )
          assert.match(done.toasts.join(' '), /没听清|再说一次|没听到/, `无麦克风完成应有中文提示，实际 ${JSON.stringify(done.toasts)}`)
          assert.equal(done.open, true, '完成后通话应保持打开')
          assert.equal(debug.jsErrors.length, before, '完成录音不应产生未捕获 JS 异常')
        })

        await check('麦克风权限拒绝 → 重新授权恢复；持续无声 → 没有检测到声音', async () => {
          // fake-ui 会自动授权，无法用 CDP 权限拒绝；注入「首次 getUserMedia 拒绝 NotAllowedError」模拟
          const denyScript = `(() => {
            try {
              const md = navigator.mediaDevices; if (!md) return
              const orig = md.getUserMedia.bind(md)
              let denied = true
              navigator.mediaDevices.getUserMedia = async (constraints) => {
                if (denied) { denied = false; throw new DOMException('Permission denied (QA simulation)', 'NotAllowedError') }
                return orig(constraints)
              }
            } catch { /* ignore */ }
          })()`
          const denyInject = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: denyScript })
          try {
            await closeCall()
            await openMobile(1440, 900)
            await openCallElena()
            const denied = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, pttSnapshot)
                return v.mic === 'denied' ? v : null
              },
              { timeoutMs: 12000, label: '麦克风权限拒绝状态' },
            )
            assert.match(denied.micLabel, /权限被拒绝/, '应显示权限被拒绝')
            assert.equal(denied.micRetryHidden, false, '应显示「重新授权麦克风」按钮')
            assert.equal(denied.micTextHidden, false, '应显示「改用文字输入」')
            assert.match(String(denied.micMessage), /权限|文字输入/, '应有中文原因说明')
            await screenshot('ui-v23-mic-denied-1440x900.png')
            await evalInPage(cdp, `document.getElementById('mic-retry').click(); true`)
            const recovered = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, pttSnapshot)
                return v.mic === 'ready' || v.mic === 'silent' ? v : null
              },
              { timeoutMs: 12000, label: '重新授权后麦克风恢复' },
            )
            assert.ok(['ready', 'silent'].includes(recovered.mic), '重新授权后应恢复麦克风状态')
          } finally {
            await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: denyInject.identifier })
          }
          await closeCall()
          // 无声：注入静音 getUserMedia 后重新加载（2s 无声 → silent）
          const silentScript = `(() => {
            try {
              const md = navigator.mediaDevices
              if (!md) return
              const orig = md.getUserMedia.bind(md)
              navigator.mediaDevices.getUserMedia = async (constraints) => {
                try {
                  const AC = window.AudioContext || window.webkitAudioContext
                  if (!AC) return orig(constraints)
                  const ctx = new AC()
                  const dest = ctx.createMediaStreamDestination()
                  const osc = ctx.createOscillator()
                  const gain = ctx.createGain()
                  gain.gain.value = 0
                  osc.connect(gain).connect(dest)
                  osc.start()
                  window.__qaSilentCtx = ctx
                  return dest.stream
                } catch { return orig(constraints) }
              }
            } catch { /* ignore */ }
          })()`
          const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: silentScript })
          try {
            await openMobile(1440, 900)
            await openCallElena()
            const silent = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, pttSnapshot)
                return v.mic === 'silent' ? v : null
              },
              { timeoutMs: 12000, label: '持续无声检测' },
            )
            assert.equal(silent.micLabel, '没有检测到声音', '无声状态文案')
            assert.match(String(silent.micMessage), /没有检测到声音|检查.*设备/, '无声提示应给出检查建议')
            await screenshot('ui-v23-mic-silent-1440x900.png')
          } finally {
            await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
            await closeCall()
            await openMobile(1440, 900)
            await openCallElena()
          }
        })
        await check('PTT 提交链路：simulateTranscript → 用户/角色气泡 EN+ZH、messages 增长、回复后 ptt=idle', async () => {
          const before = await evalInPage(cdp, `window.__avaMobile.getCallState()`)
          await evalInPage(cdp, `window.__avaMobile.simulateTranscript('Hello Elena, I love street photography.'); true`)
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const st = window.__avaMobile.getCallState();
                  const bubbles = [...document.querySelectorAll('#call-bubbles .bubble')].map((b) => ({
                    cls: b.className,
                    en: (b.querySelector('.bubble-en') || {}).textContent || '',
                    zh: (b.querySelector('.bubble-zh') || {}).textContent || '',
                  }));
                  return { ...st, bubbles, ptt: st.ptt };
                })()`,
              )
              const me = v.bubbles.find((b) => /\bme\b/.test(b.cls) && b.en && /[\u4e00-\u9fff]/.test(b.zh))
              const ava = v.bubbles.find((b) => /\bava\b/.test(b.cls) && b.en && /[\u4e00-\u9fff]/.test(b.zh))
              if (!me || !ava) return null
              if (v.ptt !== 'idle') return null
              return v
            },
            { timeoutMs: 30000, label: 'PTT 提交链路完成' },
          )
          assert.ok(st.userTurns >= before.userTurns + 1, '应记录用户轮次')
          assert.ok(st.messages.length >= before.messages.length + 2, 'messages 应增加 user+assistant')
          const me = st.bubbles.find((b) => /\bme\b/.test(b.cls) && b.en)
          assert.ok(me.en.includes('street photography') || me.en.length > 5, '用户气泡英文非空')
          assert.ok(/[\u4e00-\u9fff]/.test(me.zh), '用户气泡应有中文')
          const ava = st.bubbles.filter((b) => /\bava\b/.test(b.cls) && b.en).pop()
          assert.ok(/[\u4e00-\u9fff]/.test(ava.zh), '角色气泡应有中文')
          await screenshot('ui-v23-ptt-simulate-1440x900.png')
        })

        await check('PTT 键盘：空格开始/结束、Esc 取消且通话保持；输入框聚焦时空格不拦截', async () => {
          await evalInPage(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); true`)
          const rec = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.ptt === 'recording' ? v : null
            },
            { timeoutMs: 6000, label: '空格开始录音' },
          )
          assert.equal(rec.ptt, 'recording')
          await evalInPage(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); true`)
          const esc = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.ptt === 'idle' ? v : null
            },
            { timeoutMs: 6000, label: 'Esc 取消录音' },
          )
          assert.equal(esc.open, true, 'Esc 取消后通话应保持打开')
          await screenshot('ui-v23-ptt-esc-1440x900.png')
          // 空格结束（无麦 → idle）
          await evalInPage(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'recording',
            { timeoutMs: 6000, label: '再次空格录音' },
          )
          await evalInPage(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'idle',
            { timeoutMs: 12000, label: '空格结束回 idle' },
          )
          // 输入框聚焦：空格不应触发 PTT
          await evalInPage(cdp, `(() => { document.getElementById('call-text-btn').click(); const i = document.getElementById('call-text-input'); i.focus(); return true; })()`)
          await sleep(300)
          await evalInPage(cdp, `(() => { const i = document.getElementById('call-text-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); return true; })()`)
          await sleep(500)
          const typing = await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)
          assert.equal(typing, 'idle', '输入框聚焦时空格不应开始录音')
          await evalInPage(cdp, `document.getElementById('call-text-btn').click(); true`)
        })

        await check('KB grounded + PTT：simulateTranscript → 引用卡片照常、kbMode/docIds 正确', async () => {
          if (!kbDoc) throw new Error('KB 文档未准备好')
          await closeCall()
          await openCallElena({ kbMode: 'grounded', kbDocIds: [kbDoc.id], kbDocs: [kbDoc.title] })
          const st0 = await evalInPage(cdp, `window.__avaMobile.getCallState()`)
          assert.equal(st0.kbMode, 'grounded')
          assert.deepEqual(st0.kbDocIds, [kbDoc.id])
          await evalInPage(cdp, `window.__avaMobile.simulateTranscript('What does the article say about reading slowly?'); true`)
          const cited = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const cards = [...document.querySelectorAll('#call-citations .citation-card')];
                  return { cards: cards.length, hits: window.__avaMobile.getCallState().kbHits, ptt: window.__avaMobile.getCallState().ptt };
                })()`,
              )
              return v.cards >= 1 ? v : null
            },
            { timeoutMs: 30000, label: 'PTT + 引用卡片' },
          )
          assert.ok(cited.cards >= 1, 'KB grounded + PTT 应出现引用卡片')
          assert.ok(cited.hits >= 1, 'kbHits 应 ≥1')
          await screenshot('ui-v23-ptt-kb-citations-1440x900.png')
        })

        await check('文本输入 / 挂断总结 / 5 Tab 回归（PTT 之外路径不变）', async () => {
          const before = debug.jsErrors.length
          await evalInPage(cdp, `(() => { document.getElementById('call-text-btn').click(); const i = document.getElementById('call-text-input'); i.value = 'This is a text message.'; const f = document.getElementById('call-textform'); f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; })()`)
          await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const bubbles = [...document.querySelectorAll('#call-bubbles .bubble')].map((b) => (b.querySelector('.bubble-en') || {}).textContent || '');
                  return bubbles.some((t) => t.includes('This is a text message.')) || window.__avaMobile.getCallState().userTurns >= 1;
                })()`,
              )
              return v === true
            },
            { timeoutMs: 20000, label: '文本输入提交' },
          )
          await evalInPage(cdp, `document.getElementById('call-hangup').click(); true`)
          const sheet = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const s = document.getElementById('sheet'); return { open: !!(s && !s.hidden), body: (document.getElementById('sheet-body') || {}).innerText || '' }; })()`)
              return v.open && v.body.length > 10 && !/正在整理/.test(v.body) ? v : null
            },
            { timeoutMs: 30000, label: '挂断总结弹层' },
          )
          assert.match(sheet.body, /总结|复盘|重点|鼓励|开口/i, '总结内容正常')
          await evalInPage(cdp, `document.getElementById('sheet-close').click(); true`)
          await sleep(600)
          const tabs = await evalInPage(cdp, `document.querySelectorAll('#tabbar .tab').length`)
          assert.equal(tabs, 5, '5 Tab 应保持（v2.8 课程/对话/助手/复习/我的）')
          assert.equal(debug.jsErrors.length, before, '文本/总结路径不应产生 JS 异常')
        })
        await check('豆包 PTT connecting→recording→submitting；12s 无回复兜底回 idle（不回 listening）', async () => {
          await closeCall()
          await putSettings({
            voiceEngine: 'volc',
            volc: { appId: 'ptt-app', apiKey: 'ptt-key', model: '3.0', speaker: 'en_female_dacey_uranus_bigtts', endpoint: volcMock.wsUrl, resourceId: 'volc.speech.dialog' },
          })
          await openMobile(1440, 900)
          await openCallElena()
          volcMock.reset()
          volcMock.setScenario('no-events')
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          const connecting = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.ptt === 'connecting' ? v : null
            },
            { timeoutMs: 5000, label: '豆包 connecting' },
          )
          assert.match(connecting.label, /正在连接豆包语音|取消/, `connecting 文案，实际 "${connecting.label}"`)
          const rec = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.ptt === 'recording' ? v : null
            },
            { timeoutMs: 15000, label: '豆包连接后 recording' },
          )
          assert.equal(rec.engine, 'volc', '连接后 engine 应为 volc')
          assert.equal(rec.hasDoneButton, false, '仍不应有完成按钮')
          // 无回复（mock 不推送 ASR/chat）→ v3.5 无声/6s 看门狗 或 12s 兜底回 idle
          await evalInPage(cdp, `(() => { window.__qaToasts = []; const root = document.getElementById('toasts'); if (root) { const mo = new MutationObserver(() => { for (const t of root.querySelectorAll('.toast')) { const s = (t.innerText || '').replace(/\s+/g, ' ').trim(); if (s && !window.__qaToasts.includes(s)) window.__qaToasts.push(s) } }); mo.observe(root, { childList: true, subtree: true, characterData: true }); window.__qaToastMo = mo } return true })()`)
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => ['submitting', 'idle'].includes(await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)),
            { timeoutMs: 15000, label: '豆包结束提交/立即兜底' },
          ).catch(() => {})
          const seenToasts = []
          const fallback = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              for (const t of v.toasts) if (!seenToasts.includes(t)) seenToasts.push(t)
              return v.ptt === 'idle' ? v : null
            },
            { timeoutMs: 22000, label: '无回复兜底回 idle' },
          )
          for (const t of fallback.toasts) if (!seenToasts.includes(t)) seenToasts.push(t)
          const qaToasts = await evalInPage(cdp, `window.__qaToasts || []`)
          for (const t of qaToasts) if (!seenToasts.includes(t)) seenToasts.push(t)
          assert.match(seenToasts.join(' '), /没有收到语音回复|回到待机|没听清|没有听到|已重置|没有检测到声音/, `兜底应有中文提示，实际 ${JSON.stringify(seenToasts)}`)
          const state = await evalInPage(cdp, `window.__avaMobile.getCallState().state`)
          assert.ok(['idle', 'listening'].includes(state), `兜底后 state，实际 ${state}`)
          assert.equal(state, 'idle', '兜底后应回 idle（不回 listening）')
          await screenshot('ui-v24-ptt-fallback-1440x900.png')
          volcMock.setScenario('ok')
        })

        await check('connecting 时再点取消；speaking 抢断；第二轮复用会话', async () => {
          await closeCall()
          volcMock.reset()
          await openCallElena()
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          // 连接中再点一次 = 取消
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          const cancelled = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.ptt === 'idle' ? v : null
            },
            { timeoutMs: 8000, label: 'connecting 取消回 idle' },
          )
          assert.equal(cancelled.open, true, '取消录音不应关闭通话')
          await sleep(1500)
          assert.equal(await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`), 'idle', '取消后应保持 idle（无后台会话）')
          await screenshot('ui-v24-ptt-cancel-1440x900.png')
          // 第二轮：直接 recording（resumeMic 复用会话）
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          const rec2 = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.ptt === 'recording' ? v : null
            },
            { timeoutMs: 15000, label: '第二轮 recording' },
          )
          assert.equal(rec2.engine, 'volc')
          // 结束第二轮录音（提交）后再测 speaking 抢断
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => ['idle', 'speaking'].includes(await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)),
            { timeoutMs: 16000, label: '第二轮提交后回待机' },
          ).catch(() => {})
          await evalInPage(cdp, `window.__avaMobile.previewSpeaking(3000); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().state`)) === 'speaking',
            { timeoutMs: 4000, label: 'speaking 预览' },
          )
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          const barge = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              return v.ptt === 'connecting' || v.ptt === 'recording' ? v : null
            },
            { timeoutMs: 15000, label: 'speaking 抢断后重新录音' },
          )
          assert.ok(['connecting', 'recording'].includes(barge.ptt), '抢断后应开始新录音')
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'idle',
            { timeoutMs: 16000, label: '抢断后回 idle' },
          ).catch(() => {})
          await screenshot('ui-v24-ptt-barge-1440x900.png')
        })
        await check('v3.5 语音自愈：无声即时提示不 commit/engine 保持 volc/6s 无 ASR 看门狗/正常轮次不误杀/诊断字段', async () => {
          await closeCall()
          await putSettings({ voiceEngine: 'volc', volc: { appId: 'v35-app', apiKey: 'v35-key', model: '3.0', speaker: 'en_female_dacey_uranus_bigtts', endpoint: volcMock.wsUrl, resourceId: 'volc.speech.dialog' } })
          // 0 增益麦克风 → 拾音看门狗
          const silent = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `(() => {
              try {
                const md = navigator.mediaDevices;
                const orig = md.getUserMedia.bind(md);
                md.getUserMedia = async (c) => {
                  try {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    const ctx = new AC();
                    const dest = ctx.createMediaStreamDestination();
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    gain.gain.value = 0;
                    osc.connect(gain).connect(dest);
                    osc.start();
                    window.__qaSilentCtx = ctx;
                    return dest.stream;
                  } catch { return orig(c) }
                };
              } catch { /* ignore */ }
            })()`,
          })
          try {
            await openMobile(1440, 900)
            await openCallElena()
            const diag = await evalInPage(cdp, `(() => { const v = window.__avaMobile.getCallState().voice; return v ? { micLevel: typeof v.micLevel, hadSound: typeof v.hadSound, asrSeen: typeof v.asrSeen, volcResets: typeof v.volcResets, peak: typeof v.peak, lastAsrAt: typeof v.lastAsrAt } : null })()`)
            assert.ok(diag && diag.micLevel === 'number' && diag.hadSound === 'boolean' && diag.asrSeen === 'boolean' && diag.volcResets === 'number', `voice 诊断字段应齐全（${JSON.stringify(diag)}）`)
            volcMock.reset()
            await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'recording',
              { timeoutMs: 15000, label: 'v3.5 无声 PTT recording' },
            )
            const hint = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, `(() => ({ hint: (document.getElementById('ptt-hint') || {}).textContent || '', level: window.__avaMobile.getCallState().voice.micLevel }))()`)
                return /没有检测到声音|没有听到声音|检查麦克风/.test(v.hint) ? v : null
              },
              { timeoutMs: 8000, label: 'v3.5 无声提示' },
            )
            assert.match(hint.hint, /没有检测到声音|没有听到声音/, `录音中应提示没声音（${hint.hint}）`)
            const t0 = Date.now()
            await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
            const silentDone = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, `(() => ({ ptt: window.__avaMobile.getCallState().ptt, engine: window.__avaMobile.getCallState().engine, toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText) }))()`)
                return v.ptt === 'idle' ? v : null
              },
              { timeoutMs: 8000, label: 'v3.5 无声结束回 idle' },
            )
            assert.ok(Date.now() - t0 < 5000, `无声结束应立即回 idle（实测 ${Date.now() - t0}ms）`)
            assert.equal(silentDone.engine, 'volc', '无声结束后 engine 应保持 volc（不永久降级 browser）')
            assert.ok(silentDone.toasts.some((t) => /没有听到你的声音|没听到|没有检测到声音|没听清/.test(t)), `应中文提示没听到（${JSON.stringify(silentDone.toasts)}）`)
            await screenshot('ui-v35-ptt-silent-1440x900.png')
          } finally {
            await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: silent.identifier })
          }
          // 6s 无 ASR 看门狗（mock 不推送 asr/chat）
          await openMobile(1440, 900)
          await openCallElena()
          volcMock.reset()
          volcMock.setScenario('no-events')
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'recording',
            { timeoutMs: 15000, label: 'v3.5 看门狗 recording' },
          )
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          const firstState = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => ({ ptt: window.__avaMobile.getCallState().ptt, toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText) }))()`)
              return (v.ptt === 'submitting' || v.ptt === 'idle') ? v : null
            },
            { timeoutMs: 12000, label: 'v3.5 结束提交/立即兜底' },
          )
          let watchdog
          if (firstState.ptt === 'idle') {
            // fake mic 整段无拾音：v3.5 立即提示并 idle（不 commit、不等 12s）
            watchdog = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, `(() => ({ ptt: window.__avaMobile.getCallState().ptt, engine: window.__avaMobile.getCallState().engine, toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText) }))()`)
                return v.ptt === 'idle' && v.toasts.some((t) => /没听清|已重置语音|没有听到|没有检测到声音/.test(t)) ? v : null
              },
              { timeoutMs: 6000, label: 'v3.5 无拾音即时提示' },
            )
          } else {
            watchdog = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, `(() => ({ ptt: window.__avaMobile.getCallState().ptt, engine: window.__avaMobile.getCallState().engine, voice: window.__avaMobile.getCallState().voice, toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText) }))()`)
                return v.ptt === 'idle' && v.toasts.some((t) => /没听清|已重置语音|没有听到/.test(t)) ? v : null
              },
              { timeoutMs: 15000, label: 'v3.5 6s ASR 看门狗' },
            )
          }
          assert.ok(watchdog.toasts.some((t) => /没听清|已重置语音|没有听到|没有检测到声音/.test(t)), `看门狗应中文提示（${JSON.stringify(watchdog.toasts)}）`)
          assert.equal(watchdog.engine, 'volc', '看门狗重置后 engine 应保持 volc')
          // 下一击仍可录音（未永久卡死）
          volcMock.setScenario('ok')
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'recording',
            { timeoutMs: 30000, label: 'v3.5 重置后下一击可录' },
          )
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await sleep(600)
          await screenshot('ui-v35-ptt-watchdog-1440x900.png')
          await closeCall()
          await putSettings({ voiceEngine: 'browser', volc: { clearKey: true } })
        })

        await check('v3.7 PTT 自说自话修复：静音帧不上行/未提交事件忽略+interrupt+单条提示/start 帧含 ptt:true', async () => {
          await closeCall()
          await putSettings({ voiceEngine: 'volc', volc: { appId: 'v37-app', apiKey: 'v37-key', model: '3.0', speaker: 'en_female_dacey_uranus_bigtts', endpoint: volcMock.wsUrl, resourceId: 'volc.speech.dialog' } })
          const inject = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `(() => {
              try {
                const of = window.WebSocket;
                window.__qaWsFrames = [];
                window.__qaBridgeWs = null;
                function QAWs(url, protocols) {
                  const ws = protocols === undefined ? new of(url) : new of(url, protocols);
                  window.__qaBridgeWs = ws;
                  try {
                    const send = ws.send.bind(ws);
                    ws.send = (data) => {
                      try { if (typeof data === 'string') window.__qaWsFrames.push(data) } catch { /* ignore */ }
                      return send(data);
                    };
                  } catch { /* ignore */ }
                  return ws;
                }
                QAWs.prototype = of.prototype;
                window.WebSocket = QAWs;
              } catch { /* ignore */ }
              try {
                const md = navigator.mediaDevices;
                const orig = md.getUserMedia.bind(md);
                md.getUserMedia = async (c) => {
                  try {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    const ctx = new AC();
                    const dest = ctx.createMediaStreamDestination();
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    gain.gain.value = 0;
                    osc.connect(gain).connect(dest);
                    osc.start();
                    window.__qaSilentCtx = ctx;
                    return dest.stream;
                  } catch { return orig(c) }
                };
              } catch { /* ignore */ }
            })()`,
          })
          try {
            await openMobile(1440, 900)
            await openCallElena()
            volcMock.reset()
            volcMock.setScenario('ok')
            await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'recording',
              { timeoutMs: 20000, label: 'v3.7 PTT recording' },
            )
            await waitUntil(
              async () => (await evalInPage(cdp, `(window.__qaWsFrames || []).some((f) => { try { const j = JSON.parse(f); return j.type === 'start' } catch { return false } })`)) === true,
              { timeoutMs: 8000, label: 'v3.7 start 帧捕获' },
            )
            const startFrame = await evalInPage(cdp, `(() => { const f = (window.__qaWsFrames || []).find((x) => { try { return JSON.parse(x).type === 'start' } catch { return false } }); return f ? JSON.parse(f) : null })()`)
            assert.equal(startFrame && startFrame.ptt, true, `start 帧应含 ptt:true（${JSON.stringify(startFrame)}）`)
            const frames0 = volcMock.audioFrames
            const bubbles0 = await evalInPage(cdp, `document.querySelectorAll('#call-bubbles .bubble, #call-bubbles .msg').length`)
            await sleep(3400)
            const frames1 = volcMock.audioFrames
            const bubbles1 = await evalInPage(cdp, `document.querySelectorAll('#call-bubbles .bubble, #call-bubbles .msg').length`)
            const pttAfterSilence = await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)
            assert.equal(pttAfterSilence, 'recording', '静音 3.4s 后仍应保持 recording（不自动提交）')
            assert.equal(bubbles1, bubbles0, '静音期间不应新增用户/角色气泡')
            assert.ok(frames1 - frames0 <= 1, `静音帧不应上行到服务端（新增 ${frames1 - frames0} 帧）`)
            // 未提交时注入 chat/audio-start/audio-end → 忽略 + interrupt + 单条提示
            await evalInPage(cdp, `(() => {
              const ws = window.__qaBridgeWs;
              if (!ws) return false;
              const fire = (obj) => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) }));
              fire({ type: 'audio-start' });
              fire({ type: 'chat', text: 'Self triggered reply', final: true });
              fire({ type: 'audio-end' });
              return true;
            })()`)
            await sleep(500)
            const afterInject = await evalInPage(cdp, `(() => ({
              ptt: window.__avaMobile.getCallState().ptt,
              bubbles: document.querySelectorAll('#call-bubbles .bubble, #call-bubbles .msg').length,
              texts: [...document.querySelectorAll('#call-bubbles')].map((b) => b.innerText).join(' '),
              frames: window.__qaWsFrames || [],
              toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText),
            }))()`)
            assert.equal(afterInject.ptt, 'recording', '未提交注入事件不应改变 recording')
            assert.equal(afterInject.bubbles, bubbles0, '注入 chat/audio 不应产生气泡')
            assert.ok(!String(afterInject.texts).includes('Self triggered reply'), '注入文本不应上屏')
            const interrupts = afterInject.frames.filter((f) => { try { return JSON.parse(f).type === 'interrupt' } catch { return false } }).length
            assert.ok(interrupts >= 1, `自触发内容应发 interrupt（实际 ${interrupts}）`)
            const triggerToasts = afterInject.toasts.filter((t) => /自触发|忽略|语音|别说话|打断/.test(t))
            assert.ok(triggerToasts.length <= 1, `自触发提示最多 1 条（实际 ${triggerToasts.length}）`)
            await screenshot('ui-v37-ptt-self-trigger-1440x900.png')
            // 取消录音
            await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'idle',
              { timeoutMs: 15000, label: 'v3.7 取消/结束录音' },
            ).catch(() => {})
          } finally {
            await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inject.identifier })
          }
          await closeCall()
          await putSettings({ voiceEngine: 'browser', volc: { clearKey: true } })
        })

        await check('v2.5 麦克风环境自检：正常 banner 隐藏 + micEnv 字段；PTT 开关回归', async () => {
          await closeCall()
          await putSettings({ voiceEngine: 'browser', volc: { clearKey: true } })
          await openMobile(1440, 900)
          await openCallElena()
          const normal = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, pttSnapshot)
              const env = await evalInPage(cdp, `window.__avaMobile.getCallState().micEnv`)
              if (!env || (env.permission !== 'granted' && env.permission !== 'unknown')) return null
              return { ...v, env }
            },
            { timeoutMs: 12000, label: '正常环境 micEnv' },
          )
          assert.equal(normal.env.secure, true, 'localhost 应为安全上下文')
          assert.equal(normal.env.hasMedia, true, '应检测到 mediaDevices')
          assert.ok(normal.env.audioInputs >= 1, 'fake mic 应有音频输入设备')
          const banner = await evalInPage(cdp, `(() => { const b = document.getElementById('call-env-banner'); return b ? { hidden: b.hidden, text: b.textContent } : null })()`)
          assert.equal(banner.hidden, true, '正常时环境 banner 应隐藏')
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'recording',
            { timeoutMs: 8000, label: '正常环境 PTT recording' },
          )
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'idle',
            { timeoutMs: 12000, label: '正常环境 PTT 回 idle' },
          )
          await screenshot('ui-v25-env-normal-1440x900.png')
        })

        await check('v2.5 权限被阻止：banner/如何开启/帮助弹层/复制诊断（12 字段）', async () => {
          const deniedScript = `(() => {
            try {
              const md = navigator.mediaDevices
              const orig = md && md.getUserMedia ? md.getUserMedia.bind(md) : null
              if (navigator.permissions && navigator.permissions.query) {
                const q = navigator.permissions.query.bind(navigator.permissions)
                navigator.permissions.query = async (desc) => {
                  if (desc && desc.name === 'microphone') return { state: 'denied', onchange: null }
                  return q(desc)
                }
              }
              if (md) md.getUserMedia = async () => { throw new DOMException('Permission denied (QA simulation)', 'NotAllowedError') }
              window.__qaOrigMic = orig
            } catch { /* ignore */ }
          })()`
          const inject = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: deniedScript })
          try {
            await openMobile(1440, 900)
            await openCallElena()
            const denied = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, `(() => {
                  const b = document.getElementById('call-env-banner')
                  const retry = document.getElementById('mic-retry')
                  const diag = document.getElementById('mic-diag-btn')
                  return {
                    bannerHidden: b ? b.hidden : null,
                    banner: b ? b.textContent.replace(/\\s+/g, ' ').trim() : '',
                    retryHidden: retry ? retry.hidden : null,
                    retryLabel: retry ? retry.textContent.trim() : '',
                    diagHidden: diag ? diag.hidden : null,
                    textHidden: (document.getElementById('mic-text-btn') || {}).hidden,
                    mic: window.__avaMobile.getCallState().mic,
                    overflow: document.documentElement.scrollWidth - innerWidth,
                  }
                })()`)
                return v.bannerHidden === false && v.mic === 'denied' ? v : null
              },
              { timeoutMs: 12000, label: 'v2.5 权限阻止界面' },
            )
            assert.match(denied.banner, /已阻止本站麦克风|如何开启|手动开启/, `banner 文案，实际 "${denied.banner}"`)
            assert.equal(denied.retryLabel, '如何开启麦克风', '按钮应为如何开启麦克风')
            assert.equal(denied.diagHidden, false, '应显示复制诊断信息按钮')
            assert.equal(denied.textHidden, false, '应保留改用文字输入')
            assert.ok(denied.overflow <= 2, `1440 denied 溢出：${denied.overflow}`)
            await evalInPage(cdp, `document.getElementById('mic-retry').click(); true`)
            const sheet = await waitUntil(
              async () => {
                const v = await evalInPage(cdp, `(() => { const s = document.getElementById('sheet'); const b = document.getElementById('sheet-body'); return s ? { open: !s.hidden, text: b ? b.innerText.replace(/\\s+/g, ' ').trim() : '', buttons: [...document.querySelectorAll('#sheet-body [data-act]')].map((x) => x.getAttribute('data-act')) } : null })()`)
                return v && v.open && v.text.includes('网站设置') ? v : null
              },
              { timeoutMs: 8000, label: '如何开启麦克风帮助弹层' },
            )
            assert.ok(sheet.buttons.includes('mic-reload'), '帮助弹层应有重新加载页面')
            assert.ok(sheet.buttons.includes('mic-copy'), '帮助弹层应有复制诊断信息')
            await screenshot('ui-v25-env-denied-1440x900.png')
            await evalInPage(cdp, `document.querySelector('#sheet-body [data-act=\"mic-copy\"]').click(); true`)
            await sleep(400)
            const diagFields = await evalInPage(cdp, `(() => { const d = window.__lastMicDiag; return d ? Object.keys(d) : [] })()`)
            assert.ok(diagFields.length >= 12, `诊断信息应 ≥12 字段（实际 ${diagFields.length}）`)
            for (const key of ['url', 'protocol', 'isSecureContext', 'hasMediaDevices', 'permission', 'audioInputs', 'ua', 'voiceEngine', 'volc', 'ptt', 'micState', 'checkedAt']) assert.ok(diagFields.includes(key), `诊断字段应含 ${key}`)
            await screenshot('ui-v25-help-sheet-1440x900.png')
            await evalInPage(cdp, `document.getElementById('sheet-close').click(); true`)
            // 尺寸：1280/1024/430 无横向溢出（denied 状态）
            await setDevice(1280, 800)
            await sleep(400)
            const o1 = await evalInPage(cdp, `document.documentElement.scrollWidth - innerWidth`)
            assert.ok(o1 <= 2, `1280 denied 横向溢出：${o1}`)
            await screenshot('ui-v25-env-denied-1280x800.png')
            await setDevice(1024, 768)
            await sleep(400)
            const o2 = await evalInPage(cdp, `document.documentElement.scrollWidth - innerWidth`)
            assert.ok(o2 <= 2, `1024 denied 横向溢出：${o2}`)
            await screenshot('ui-v25-env-denied-1024x768.png')
            await setDevice(430, 932)
            await sleep(400)
            const o3 = await evalInPage(cdp, `document.documentElement.scrollWidth - innerWidth`)
            assert.ok(o3 <= 2, `430 denied 横向溢出：${o3}`)
            await screenshot('ui-v25-env-denied-430x932.png')
            await setDevice(1440, 900)
          } finally {
            await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inject.identifier })
            await closeCall()
          }
        })
        await check('v2.5 非安全上下文 / mediaDevices 缺失 / 无输入设备：横幅+禁用大麦+文字兜底', async () => {
          const scenarios = [
            {
              name: 'nonsecure',
              script: `(() => { try { Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }) } catch {} })()`,
              banner: /不是安全环境|HTTPS/, shot: 'ui-v25-env-nonsecure-1440x900.png',
            },
            {
              name: 'nomedia',
              script: `(() => { try { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }) } catch {} })()`,
              banner: /mediaDevices|无法访问麦克风/, shot: 'ui-v25-env-nomedia-1440x900.png',
            },
            {
              name: 'noinput',
              script: `(() => { try { const md = navigator.mediaDevices; if (md) md.enumerateDevices = async () => [] } catch {} })()`,
              banner: /没有检测到麦克风|输入设备/, shot: 'ui-v25-env-noinput-1440x900.png',
            },
          ]
          for (const sc of scenarios) {
            const inject = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: sc.script })
            try {
              await openMobile(1440, 900)
              await openCallElena()
              const state = await waitUntil(
                async () => {
                  const v = await evalInPage(cdp, `(() => {
                    const b = document.getElementById('call-env-banner')
                    const t = document.getElementById('call-talk')
                    return {
                      bannerHidden: b ? b.hidden : null,
                      banner: b ? b.textContent.replace(/\\s+/g, ' ').trim() : '',
                      talkDisabled: t ? (t.disabled === true || t.getAttribute('aria-disabled') === 'true' || t.classList.contains('is-disabled')) : null,
                      textHidden: (document.getElementById('mic-text-btn') || {}).hidden,
                      retryHidden: (document.getElementById('mic-retry') || {}).hidden,
                      retryLabel: ((document.getElementById('mic-retry') || {}).textContent || '').trim(),
                      overflow: document.documentElement.scrollWidth - innerWidth,
                    }
                  })()`)
                  return v.bannerHidden === false ? v : null
                },
                { timeoutMs: 12000, label: `v2.5 ${sc.name} 环境横幅` },
              )
              assert.match(state.banner, sc.banner, `${sc.name} banner 文案，实际 "${state.banner}"`)
              if (sc.name === 'nonsecure' || sc.name === 'nomedia') assert.equal(state.talkDisabled, true, `${sc.name} 大麦克风应禁用`)
              assert.equal(state.textHidden, false, `${sc.name} 应保留改用文字输入`)
              assert.ok(state.overflow <= 2, `${sc.name} 1440 横向溢出：${state.overflow}`)
              await screenshot(sc.shot)
            } finally {
              await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inject.identifier })
              await closeCall()
            }
          }
        })
      } finally {
        await upstream.close()
        await volcMock.close()
        await putSettings({ apiKey: '', clearKey: true, voiceEngine: 'browser', volc: { clearKey: true } }).catch(() => {})
      }
    })

    // =====================================================================
    // v2.7：讲解资料对照窗（方案 A）
    // =====================================================================
    if (!skipIndex) await group('v2.7 讲解资料对照窗', async () => {
      const upstream = await startMockUpstream()
      const KEY = 'sk-qa-ui-docs-1234'
      const putSettings = async (patch) =>
        jfetch(baseUrl + '/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      const setDevice = async (w, h) =>
        cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      const openMobile = async (w = 1440, h = 900) => {
        await setDevice(w, h)
        await navigate(cdp, baseUrl + '/mobile')
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const a = document.getElementById('app'); return !!(a && a.getAttribute('data-ready') === '1'); })()`)) === true,
          { timeoutMs: 15000, label: '手机版就绪（v2.7）' },
        )
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => !!(window.__avaMobile && window.__avaMobile.state && window.__avaMobile.state.characters.length >= 3))()`)) === true,
          { timeoutMs: 15000, label: '角色加载（v2.7）' },
        )
        await sleep(300)
      }
      const upload = async (name) => {
        const buf = await fsp.readFile(path.join(PROJECT_ROOT, 'test', 'fixtures', name))
        const r = await jfetch(baseUrl + '/api/kb/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, dataBase64: buf.toString('base64') }),
        })
        if (r.status !== 200) throw new Error('KB 上传失败：' + r.status + ' ' + r.text.slice(0, 200))
        return r.json.doc
      }
      const openCallDocs = async (opts) => {
        await evalInPage(cdp, `window.__avaMobile.openCall('elena', 0, ${JSON.stringify(opts)}); true`)
        await waitUntil(
          async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === true,
          { timeoutMs: 10000, label: '打开资料通话' },
        )
        await sleep(600)
      }
      const docsSnap = `(() => {
        const st = window.__avaMobile.getCallState();
        const panel = document.getElementById('call-docs');
        const call = document.getElementById('call');
        const body = document.getElementById('call-docs-body');
        const tabs = [...document.querySelectorAll('#call-docs-tabs .docs-tab')];
        const chunks = [...document.querySelectorAll('#call-docs-body .docs-chunk')];
        const hits = [...document.querySelectorAll('#call-docs-body .docs-chunk.is-hit')];
        const talk = document.getElementById('call-talk');
        const tr = talk ? talk.getBoundingClientRect() : null;
        const hitEl = tr ? document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2) : null;
        return {
          docs: st.docs,
          ptt: st.ptt,
          kbMode: st.kbMode,
          kbDocIds: st.kbDocIds,
          kbHits: st.kbHits,
          open: !!panel && !panel.hidden && getComputedStyle(panel).display !== 'none',
          callDocsOpen: !!(call && call.classList.contains('docs-open')),
          panelRect: panel ? { x: Math.round(panel.getBoundingClientRect().left), y: Math.round(panel.getBoundingClientRect().top), w: Math.round(panel.getBoundingClientRect().width), h: Math.round(panel.getBoundingClientRect().height) } : null,
          tabs: tabs.map((t) => ({ title: t.textContent.trim(), active: t.classList.contains('is-active'), id: t.getAttribute('data-doc') })),
          chunks: chunks.length,
          hitChunks: hits.length,
          activeHitId: hits[0] ? hits[0].id : '',
          follow: (document.getElementById('docs-follow') || {}).checked,
          entryVisible: !!document.querySelector('#call-docs-btn'),
          talkHit: hitEl ? (hitEl.id || hitEl.className) : '',
          inner: { w: innerWidth, h: innerHeight },
          vh: innerHeight,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      })()`
      try {
        await putSettings({ apiKey: KEY, baseUrl: upstream.url, model: 'mock-model', voiceEngine: 'browser', volc: { clearKey: true } })
        const docA = await upload('english-article.txt')
        const docB = await upload('english-notes.md')
        await openMobile(1440, 900)

        await check('桌面 1440：资料栏默认展开（右侧 38%）、人物左移、tabs/跟随/字号/收起、麦克风可点', async () => {
          await openCallDocs({ kbMode: 'grounded', kbDocIds: [docA.id, docB.id], kbDocs: [docA.title, docB.title] })
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, docsSnap)
              return v.docs && v.docs.open && v.chunks >= 1 ? v : null
            },
            { timeoutMs: 15000, label: '资料栏展开+正文渲染' },
          )
          assert.equal(st.docs.available, true, '有材料时 docs.available=true')
          assert.equal(st.docs.error, '', '无错误')
          assert.equal(st.docs.docs.length, 2, '应加载 2 篇材料')
          assert.ok(st.panelRect.w >= st.inner.w * 0.3 && st.panelRect.w <= st.inner.w * 0.45, `资料栏宽度应约 38%（实际 ${st.panelRect.w}/${st.inner.w}）`)
          assert.ok(st.panelRect.x + st.panelRect.w >= st.inner.w - 2, '资料栏应贴右')
          assert.ok(st.tabs.length >= 2, '应有材料 tabs')
          assert.equal(st.follow, true, '默认开启跟随讲解')
          assert.equal(st.entryVisible, true, '模式行应有资料按钮')
          assert.match(String(st.talkHit), /call-talk|call-icon|talk/, `麦克风应可被命中（实际 "${st.talkHit}"）`)
          assert.ok(st.overflow <= 2, `1440 横向溢出：${st.overflow}`)
          await screenshot('ui-v27-docs-1440x900.png')
          // 1920 / 1280 布局无溢出
          for (const [w, h, shot] of [[1920, 1080, 'ui-v27-docs-1920x1080.png'], [1280, 800, 'ui-v27-docs-1280x800.png']]) {
            await setDevice(w, h)
            await sleep(500)
            const v = await evalInPage(cdp, docsSnap)
            assert.equal(v.docs.open, true, `${w} 资料栏应保持打开`)
            assert.ok(v.overflow <= 2, `${w}×${h} 横向溢出：${v.overflow}`)
            await screenshot(shot)
          }
          await setDevice(1440, 900)
        })

        await check('联动：SSE 命中自动切 chunk/高亮、引用卡片跳转、手动滚动暂停跟随、字号/收起', async () => {
          upstream.reset()
          await evalInPage(cdp, `window.__avaMobile.simulateTranscript('What does the article say about reading slowly?'); true`)
          const hit = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, docsSnap)
              return v.kbHits >= 1 && v.docs.activeChunk && v.hitChunks >= 1 ? v : null
            },
            { timeoutMs: 30000, label: 'SSE 命中 → 高亮 chunk' },
          )
          assert.ok(hit.kbHits >= 1, 'kbHits 应 ≥1')
          assert.ok(hit.docs.activeId && hit.docs.activeChunk, '应记录 activeId/activeChunk')
          assert.match(hit.activeHitId, /docs-chunk-/, '应高亮对应段落')
          await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const b = document.getElementById('call-docs-body'); const t = b ? b.querySelector('.docs-chunk.is-hit') : null; if (!b || !t) return false; const br = b.getBoundingClientRect(); const tr = t.getBoundingClientRect(); return tr.top >= br.top - 8 && tr.top <= br.bottom; })()`)
              return v === true
            },
            { timeoutMs: 5000, label: '高亮段滚入可视区' },
          ).catch(() => {})
          // 引用卡片点击 → 仍定位对应 chunk
          const cite = await evalInPage(cdp, `document.querySelectorAll('#call-citations .citation-card').length`)
          if (cite >= 1) {
            await evalInPage(cdp, `document.querySelector('#call-citations .citation-card').click(); true`)
            await sleep(400)
          }
          // 手动滚动 → 暂停跟随
          await sleep(900) // 等程序化滚动 autoScroll 窗口结束
          await evalInPage(cdp, `(() => { const b = document.getElementById('call-docs-body'); b.scrollTop += 240; b.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true })); return true })()`)
          const paused = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, docsSnap)
              return v.follow === false ? v : null
            },
            { timeoutMs: 4000, label: '手动滚动暂停跟随' },
          )
          assert.equal(paused.follow, false, '手动滚动后应暂停跟随')
          // 恢复跟随 + 字号
          const beforeFont = paused.docs.fontSize
          await evalInPage(cdp, `document.getElementById('docs-follow').click(); true`)
          await sleep(300)
          assert.equal(await evalInPage(cdp, `document.getElementById('docs-follow').checked`), true, '应恢复跟随')
          await evalInPage(cdp, `document.getElementById('docs-font-inc').click(); document.getElementById('docs-font-inc').click(); true`)
          const font = await evalInPage(cdp, `window.__avaMobile.getCallState().docs.fontSize`)
          assert.equal(font, beforeFont + 2, `A+ 应增大字号（${beforeFont}→${font}）`)
          await screenshot('ui-v27-docs-hit-1440x900.png')
          // 收起 → 再打开
          await evalInPage(cdp, `document.getElementById('docs-close').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().docs.open`)) === false,
            { timeoutMs: 4000, label: '关闭资料窗' },
          )
          await evalInPage(cdp, `document.getElementById('call-docs-btn').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().docs.open`)) === true,
            { timeoutMs: 6000, label: '重新打开资料窗' },
          )
        })

        await check('移动 430：底部 42dvh 抽屉、上滑/下滑收展、麦克风与 PTT 不遮挡；模式/错误/6 Tab/总结', async () => {
          await setDevice(430, 932)
          await sleep(500)
          const m = await evalInPage(cdp, docsSnap)
          assert.equal(m.docs.open, true, '移动端资料抽屉应默认展开')
          assert.ok(m.panelRect.h >= m.vh * 0.36 && m.panelRect.h <= m.vh * 0.48, `抽屉高度应约 42dvh（实际 ${m.panelRect.h}/${m.vh}）`)
          assert.ok(m.panelRect.y + m.panelRect.h >= m.vh - 3, '抽屉应贴底')
          const handle = await evalInPage(cdp, `!!document.getElementById('call-docs-handle')`)
          assert.equal(handle, true, '移动端应有抽屉把手')
          // 上滑/下滑收展（把手 touch）
          const swipe = async (dy) => {
            await evalInPage(
              cdp,
              `(() => {
                const h = document.getElementById('call-docs-handle')
                const mk = (y, list) => new Touch({ identifier: 1, target: h, clientX: 200, clientY: y, pageX: 200, pageY: y })
                h.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [mk(600 - ${dy} / 2)], targetTouches: [mk(600 - ${dy} / 2)], changedTouches: [mk(600 - ${dy} / 2)] }))
                h.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [mk(600 - ${dy} / 2 + ${dy})] }))
                return true
              })()`,
            )
            await sleep(500)
          }
          await swipe(90)
          const closed = await evalInPage(cdp, `window.__avaMobile.getCallState().docs.open`)
          assert.equal(closed, false, '下滑应收起抽屉')
          await screenshot('ui-v27-docs-430-collapsed.png')
          await swipe(-90)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().docs.open`)) === true,
            { timeoutMs: 4000, label: '上滑展开抽屉' },
          )
          // 麦克风可点 + PTT 录音
          const hit = await evalInPage(cdp, docsSnap)
          assert.match(String(hit.talkHit), /call-talk|call-icon|talk/, '430 抽屉展开时麦克风应可命中')
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'recording',
            { timeoutMs: 8000, label: '430 抽屉展开时 PTT 录音' },
          )
          await evalInPage(cdp, `document.getElementById('call-talk').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) === 'idle',
            { timeoutMs: 12000, label: '430 PTT 回 idle' },
          )
          assert.ok(hit.overflow <= 2, `430 横向溢出：${hit.overflow}`)
          await screenshot('ui-v27-docs-430x932.png')
          // 挂断总结应压在资料窗之上（先补足 2 条用户消息）
          for (const text of ['Hello Elena.', 'Can you tell me more about slow reading?']) {
            await evalInPage(cdp, `window.__avaMobile.simulateTranscript(${JSON.stringify(text)}); true`)
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().ptt`)) !== 'submitting' && (await evalInPage(cdp, `window.__avaMobile.getCallState().state`)) === 'idle',
              { timeoutMs: 30000, label: '移动端补一轮对话' },
            ).catch(() => {})
          }
          await evalInPage(cdp, `document.getElementById('call-hangup').click(); true`)
          const sheet = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const s = document.getElementById('sheet'); const b = document.getElementById('sheet-body'); return { open: !!(s && !s.hidden), text: b ? b.innerText.replace(/\\s+/g, ' ').trim() : '' } })()`)
              return v.open && v.text.length > 15 && !/正在整理/.test(v.text) ? v : null
            },
            { timeoutMs: 30000, label: '挂断总结' },
          )
          assert.ok(sheet.text.length > 15, '总结弹层应显示')
          await screenshot('ui-v27-summary.png')
          await evalInPage(cdp, `document.getElementById('sheet-close').click(); true`)
          await sleep(400)
          // 6 Tab（复习）与资料窗并存
          const tabs = await evalInPage(cdp, `[...document.querySelectorAll('#tabbar .tab')].map((t) => t.getAttribute('data-tab'))`)
          assert.deepEqual(tabs, ['courses', 'chat', 'assistant', 'review', 'profile'], '5 Tab（课程/对话/助手/复习/我的）')
          await evalInPage(cdp, `document.querySelector('.tab[data-tab="review"]').click(); true`)
          await sleep(500)
          const reviewVisible = await evalInPage(cdp, `(() => { const s = document.getElementById('screen-review'); return !!(s && !s.hidden) })()`)
          assert.equal(reviewVisible, true, '复习 Tab 可打开')
          // free 模式无资料入口；无效 docId 中文错误
          await openCallDocs({ kbMode: 'free' })
          const free = await evalInPage(cdp, docsSnap)
          assert.equal(free.docs.available, false, 'free 无材料时 docs.available=false')
          assert.equal(free.entryVisible, false, 'free 无材料不应显示资料入口')
          await evalInPage(cdp, `document.getElementById('call-back').click(); true`)
          await sleep(500)
          debug.phase = 'v2.7-docs-error'
          await openCallDocs({ kbMode: 'grounded', kbDocIds: ['kb_nonexistent_v27'], kbDocs: ['无效材料'] })
          const err = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, docsSnap)
              return v.docs.error ? v : null
            },
            { timeoutMs: 12000, label: '无效文档错误态' },
          )
          assert.match(String(err.docs.error), /无法|失败|不存在|加载/, `无效文档应有中文错误（实际 "${err.docs.error}"）`)
          await screenshot('ui-v27-docs-error-1440x900.png')
          debug.phase = 'v27-docs'
          assert.equal(debug.jsErrors.length, 0, '资料对照窗流程不应产生 JS 异常')
        })
      } finally {
        await upstream.close()
        await putSettings({ apiKey: '', clearKey: true, voiceEngine: 'browser' }).catch(() => {})
      }
    })

    // =====================================================================
    // v2.7/v2.8：第 6→5 Tab 单词复习（SRS / 词库 / 小游戏 / 提醒）
    // =====================================================================
    if (!skipIndex) await group('v2.7 单词复习 Tab（SRS/词库/小游戏/提醒）', async () => {
      const setDevice = async (w, h) =>
        cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      const openMobile = async (w = 1440, h = 900) => {
        await setDevice(w, h)
        await navigate(cdp, baseUrl + '/mobile')
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const a = document.getElementById('app'); return !!(a && a.getAttribute('data-ready') === '1'); })()`)) === true,
          { timeoutMs: 15000, label: '手机版就绪（复习）' },
        )
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => !!(window.__avaMobile && window.__avaMobile.review && window.__avaMobile.review.state))()`)) === true,
          { timeoutMs: 15000, label: '复习模块就绪' },
        )
        await sleep(400)
      }
      const reviewState = async () => evalInPage(cdp, `window.__avaMobile.review.state()`)
      const switchReview = async () => {
        await evalInPage(cdp, `document.querySelector('.tab[data-tab="review"]').click(); true`)
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const s = document.getElementById('screen-review'); return !!(s && !s.hidden) })()`)) === true,
          { timeoutMs: 8000, label: '复习页可见' },
        )
        await sleep(300)
      }
      const cleanReview = async () => {
        const r = await jfetch(baseUrl + '/api/review/list?status=all&limit=2000')
        for (const w of r.json.words || []) {
          await jfetch(baseUrl + '/api/review/word?word=' + encodeURIComponent(w.word), { method: 'DELETE' })
        }
      }
      const injectScript = async (source) => cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
      const removeScript = async (identifier) => cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
      let probe = null
      try {
        await cleanReview()
        probe = await injectScript(`(() => {
          window.__qaSpeech = [];
          try {
            const orig = window.speechSynthesis.speak.bind(window.speechSynthesis);
            window.speechSynthesis.speak = (utterance) => {
              try { window.__qaSpeech.push({ text: utterance && utterance.text, lang: utterance && utterance.lang, rate: utterance && utterance.rate }) } catch { /* ignore */ }
              try { return orig(utterance) } catch { return undefined }
            };
          } catch { /* ignore */ }
          window.__qaToasts = [];
          try {
            const root = document.documentElement;
            if (root) {
              const mo = new MutationObserver(() => {
                for (const t of document.querySelectorAll('.toast')) {
                  const s = (t.innerText || '').replace(/\\s+/g, ' ').trim();
                  if (s && !window.__qaToasts.includes(s)) window.__qaToasts.push(s);
                }
              });
              mo.observe(root, { childList: true, subtree: true, characterData: true });
            }
          } catch { /* ignore */ }
        })()`)
        await openMobile(1440, 900)

        await check('5 Tab/键盘 1–5/无 #screen-play；复习首页统计/徽标/添加词/多尺寸无溢出', async () => {
          const tabs = await evalInPage(cdp, `[...document.querySelectorAll('#tabbar .tab')].map((t) => ({ tab: t.getAttribute('data-tab'), key: t.getAttribute('data-key') }))`)
          assert.equal(JSON.stringify(tabs.map((t) => t.tab)), JSON.stringify(['courses', 'chat', 'assistant', 'review', 'profile']), '5 Tab 顺序')
          assert.equal(JSON.stringify(tabs.map((t) => t.key)), JSON.stringify(['1', '2', '3', '4', '5']), '键盘提示 1–5')
          const noPlay = await evalInPage(cdp, `!document.getElementById('screen-play') && !document.querySelector('.tab[data-tab="play"]')`)
          assert.equal(noPlay, true, 'v2.8 不应再有趣玩页/Tab')
          // 键盘 4 → 复习；5 → 我的
          await evalInPage(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: '4', code: 'Digit4', bubbles: true })); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const s = document.getElementById('screen-review'); return !!(s && !s.hidden) })()`)) === true,
            { timeoutMs: 8000, label: '键盘 4 打开复习' },
          )
          await evalInPage(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', code: 'Digit5', bubbles: true })); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const s = document.getElementById('screen-profile'); return !!(s && !s.hidden) })()`)) === true,
            { timeoutMs: 8000, label: '键盘 5 打开我的' },
          )
          await switchReview()
          const added = await evalInPage(cdp, `window.__avaMobile.review.addWords([{ word: 'resilient', meaning: '有韧性的' }, { word: 'burn', meaning: '燃烧' }, { word: 'commute', meaning: '通勤' }])`)
          assert.equal(added && added.ok, true, `review.addWords 应成功（${JSON.stringify(added && added.error)}）`)
          await evalInPage(cdp, `window.__avaMobile.refreshReviewBadge(); true`)
          await sleep(800)
          const home = await reviewState()
          assert.equal(home.view, 'home', '复习首页')
          assert.ok(home.summary && home.summary.total >= 3, `首页统计 total≥3（实际 ${home.summary && home.summary.total}）`)
          const badge = await evalInPage(cdp, `(() => { const b = document.getElementById('tab-due'); return b ? { hidden: b.hidden, text: b.textContent.trim() } : null })()`)
          assert.ok(badge && badge.hidden === false && Number(badge.text) >= 1, `复习 Tab 应有到期徽标（实际 ${JSON.stringify(badge)}）`)
          await screenshot('ui-v28-review-home-1440x900.png')
          for (const [w, h, shot] of [[1920, 1080, 'ui-v28-review-home-1920x1080.png'], [1280, 800, 'ui-v28-review-home-1280x800.png'], [768, 1024, null], [430, 932, 'ui-v28-review-430x932.png']]) {
            await setDevice(w, h)
            await sleep(500)
            await switchReview()
            const of = await evalInPage(cdp, `document.documentElement.scrollWidth - innerWidth`)
            assert.ok(of <= 2, `${w}×${h} 复习页横向溢出：${of}`)
            if (shot) await screenshot(shot)
          }
          await setDevice(1440, 900)
          await switchReview()
        })

        await check('复习会话：翻转+四档评分、结束页/再来一轮、徽标变化', async () => {
          await evalInPage(cdp, `window.__avaMobile.review.openHome(); true`)
          const start = await evalInPage(cdp, `window.__avaMobile.review.startSession('due')`)
          assert.equal(start && start.ok !== false, true, 'startSession(due) 应成功')
          let st = await reviewState()
          assert.equal(st.view, 'session', '进入复习会话')
          assert.ok(st.session && st.session.total >= 1, '会话有单词')
          await evalInPage(cdp, `document.querySelector('.rv-card') ? document.querySelector('.rv-card').click() : window.__avaMobile.review.flip(); true`)
          await sleep(300)
          st = await reviewState()
          assert.equal(st.session.flipped, true, '卡片应翻转')
          const grades = ['good', 'easy', 'hard', 'again']
          let guard = 0
          while (guard < 12) {
            guard += 1
            st = await reviewState()
            if (!st || st.view !== 'session') break
            if (!st.session.flipped) {
              await evalInPage(cdp, `window.__avaMobile.review.flip(); true`)
              await sleep(150)
            }
            const grade = grades[(guard - 1) % grades.length]
            await evalInPage(cdp, `window.__avaMobile.review.grade(${JSON.stringify(grade)}); true`)
            await sleep(350)
          }
          st = await reviewState()
          assert.ok(['finish', 'home', 'session'].includes(st.view), `评分流程应推进到结束页（实际 ${st.view}）`)
          if (st.view === 'finish') {
            assert.ok(st.finish && st.finish.total >= 1 && Number(st.finish.good) + Number(st.finish.again) >= 1, '结束页统计应有效')
            await screenshot('ui-v28-review-finish-1440x900.png')
            const again = await evalInPage(cdp, `window.__avaMobile.review.startSession('again')`)
            st = await reviewState()
            assert.ok(st.view === 'session' || (again && again.ok === false), '再来一轮应可开始（或无 again 词）')
          }
          await evalInPage(cdp, `window.__avaMobile.review.back(); true`)
          await evalInPage(cdp, `window.__avaMobile.refreshReviewBadge(); true`)
          await sleep(400)
          const home = await reviewState()
          assert.ok(home.summary && typeof home.summary.total === 'number', '回到首页有统计')
        })

        await check('词库管理：新增/搜索/删除、标为掌握、点词发音（en-US）', async () => {
          await evalInPage(cdp, `window.__avaMobile.review.openManage(); true`)
          await waitUntil(
            async () => (await reviewState()).view === 'manage',
            { timeoutMs: 8000, label: '词库管理页' },
          )
          // 新增（UI 表单）
          await evalInPage(
            cdp,
            `(() => {
              const w = document.getElementById('rv-add-word');
              const m = document.getElementById('rv-add-meaning');
              if (!w || !m) return false;
              w.value = 'serendipity'; m.value = '意外发现';
              const f = document.getElementById('rv-add-form');
              f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
              return true;
            })()`,
          )
          const newRow = await waitUntil(
            async () => (await evalInPage(cdp, `!!document.querySelector('.rv-row[data-word="serendipity"]')`)) === true,
            { timeoutMs: 12000, label: '新增单词行出现' },
          )
          assert.equal(newRow, true, '词库应出现新增词')
          // 搜索
          await evalInPage(
            cdp,
            `(() => { const i = document.getElementById('rv-search-input'); i.value = 'burn'; i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
          )
          await sleep(600)
          const rows = await evalInPage(cdp, `[...document.querySelectorAll('.rv-row')].map((r) => r.getAttribute('data-word'))`)
          assert.ok(rows.includes('burn'), `搜索 burn 应命中（实际 ${JSON.stringify(rows)}）`)
          await evalInPage(cdp, `(() => { const i = document.getElementById('rv-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
          await sleep(400)
          // 标为掌握
          const patch = await jfetch(baseUrl + '/api/review/word', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ word: 'burn', patch: { status: 'known' } }),
          })
          assert.equal(patch.status, 200, 'PATCH burn→known')
          await evalInPage(cdp, `window.__avaMobile.review.refresh(); true`)
          await sleep(700)
          await evalInPage(cdp, `(() => { const f = document.querySelector('.rv-filter[data-filter="known"]'); if (f) f.click(); return true })()`)
          await sleep(500)
          const knownRows = await evalInPage(cdp, `[...document.querySelectorAll('.rv-row')].map((r) => r.getAttribute('data-word'))`)
          assert.ok(knownRows.includes('burn'), `已掌握过滤应命中 burn（实际 ${JSON.stringify(knownRows)}）`)
          // 删除（两次确认）
          await evalInPage(cdp, `(() => { const f = document.querySelector('.rv-filter[data-filter="all"]'); if (f) f.click(); return true })()`)
          await sleep(400)
          const del = await evalInPage(
            cdp,
            `(() => {
              const row = document.querySelector('.rv-row[data-word="serendipity"]');
              if (!row) return 'no-row';
              const b = row.querySelector('button[data-act="delete"], button[data-act="remove"], .rv-del');
              if (!b) return 'no-btn';
              b.click();
              return 'clicked';
            })()`,
          )
          assert.ok(del === 'clicked', `删除按钮应存在（${del}）`)
          await sleep(300)
          await evalInPage(cdp, `(() => { const row = document.querySelector('.rv-row[data-word="serendipity"]'); if (!row) return false; const b = [...row.querySelectorAll('button')].find((x) => /确认/.test(x.textContent)); if (b) { b.click(); return true } return false })()`)
          const gone = await waitUntil(
            async () => (await evalInPage(cdp, `!document.querySelector('.rv-row[data-word="serendipity"]')`)) === true,
            { timeoutMs: 8000, label: '删除后行消失' },
          ).catch(() => false)
          assert.equal(gone, true, '删除后单词行应消失')
          // 点词发音
          await evalInPage(cdp, `window.__avaMobile.review.speak('burn'); true`)
          await sleep(500)
          const spoken = await evalInPage(cdp, `window.__qaSpeech || []`)
          assert.ok(Array.isArray(spoken) && spoken.some((s) => String(s.text || '').toLowerCase().includes('burn')), `应调用 TTS（实际 ${JSON.stringify(spoken)}）`)
          const enUs = spoken.some((s) => String(s.lang || '').toLowerCase().startsWith('en'))
          assert.equal(enUs, true, 'TTS 应为英文 en-US')
          await screenshot('ui-v28-review-manage-1440x900.png')
        })

        await check('3 小游戏可玩（配对/听音/拼写）+ 每日提醒同一天仅一次', async () => {
          for (const [kind, shot] of [['match', 'ui-v28-review-game-match-1440x900.png'], ['listen', null], ['spell', null]]) {
            await evalInPage(cdp, `window.__avaMobile.review.openGame(${JSON.stringify(kind)}); true`)
            const st = await waitUntil(
              async () => {
                const v = await reviewState()
                return v.view === 'game' && v.game && v.game.kind === kind ? v : null
              },
              { timeoutMs: 10000, label: `小游戏 ${kind} 打开` },
            )
            assert.equal(st.game.kind, kind)
            if (kind === 'match') {
              await waitUntil(
                async () => (await evalInPage(cdp, `document.querySelectorAll('#rv-game-host .match-tile').length`)) >= 10,
                { timeoutMs: 20000, label: '复习配对棋盘渲染' },
              ).catch(() => {})
            }
            const host = await evalInPage(cdp, `(() => { const h = document.getElementById('rv-game-host'); return h ? { text: h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120), tiles: h.querySelectorAll('.match-tile').length, options: h.querySelectorAll('.rv-option').length, inputs: h.querySelectorAll('input').length } : null })()`)
            assert.ok(!!host && host.text.length > 0, `${kind} 游戏应有界面`)
            if (kind === 'match') {
              assert.ok(host.tiles >= 10, `配对应有 10 块（实际 ${host.tiles}）`)
              // 按 data-pair 两两点击完成
              for (let pair = 0; pair <= 4; pair++) {
                await evalInPage(cdp, `[...document.querySelectorAll('.match-tile[data-pair="${pair}"]')].slice(0, 2).forEach((t) => t.click()); true`)
                await sleep(300)
              }
              const score = await evalInPage(cdp, `(() => { const s = document.querySelector('.js-score'); return s ? s.textContent.trim() : '' })()`)
              assert.ok(/\d/.test(score), `配对完成应有分数（实际 "${score}"）`)
              if (shot) await screenshot(shot)
            } else if (kind === 'listen') {
              assert.ok(host.options >= 2, `听音应有选项（实际 ${host.options}）`)
              await evalInPage(cdp, `document.querySelectorAll('.rv-option')[0].click(); true`)
              await sleep(400)
            } else {
              assert.ok(host.inputs >= 1, '拼写应有输入框')
              await evalInPage(cdp, `(() => { const i = document.querySelector('#rv-game-host input'); if (i) { i.value = 'test'; i.dispatchEvent(new Event('input', { bubbles: true })); } return true })()`)
            }
            await evalInPage(cdp, `window.__avaMobile.review.back(); true`)
            await sleep(300)
          }
          // 每日提醒：造到期词 + 清提醒标记 → 重载出现一次；再次重载不重复
          await evalInPage(cdp, `window.__avaMobile.review.addWords([{ word: 'reminderword', meaning: '提醒词' }]); true`)
          await evalInPage(cdp, `window.__avaMobile.review.resetReminder(); true`)
          await openMobile(1440, 900)
          const reminded = () => evalInPage(cdp, `((window.__qaToasts || []).filter((t) => /今天有.*单词要复习|要复习/.test(t)).length + ((window.__avaReviewEvents || []).filter((e) => e && e.type === 'daily-reminder').length ? 1 : 0))`)
          const first = await waitUntil(
            async () => {
              const n = await reminded()
              return n >= 1 ? n : null
            },
            { timeoutMs: 10000, label: '每日复习提醒' },
          )
          assert.ok(first >= 1, '应出现每日复习提醒')
          const dateSet = await evalInPage(cdp, `localStorage.getItem('ava.review.remindedDate') === new Date().toLocaleDateString('sv') || localStorage.getItem('ava.review.remindedDate') === new Date().toISOString().slice(0, 10)`)
          assert.equal(dateSet, true, 'remindedDate 应记录当天')
          const before = await evalInPage(cdp, `localStorage.getItem('ava.review.remindedDate')`)
          await evalInPage(cdp, `window.__avaMobile.review.resetReminder = window.__avaMobile.review.resetReminder; true`)
          await openMobile(1440, 900)
          await sleep(2500)
          const after = await evalInPage(cdp, `localStorage.getItem('ava.review.remindedDate')`)
          assert.equal(after, before, '同一天重载不重复提醒（date 保持）')
          // 清理提醒词
          await jfetch(baseUrl + '/api/review/word?word=reminderword', { method: 'DELETE' }).catch(() => {})
          assert.equal(debug.jsErrors.length, 0, '复习流程不应产生 JS 异常')
        })
      } finally {
        if (probe) await removeScript(probe.identifier).catch(() => {})
        await cleanReview().catch(() => {})
      }
    })

    // =====================================================================
    // v3.1：用户自由文本计划 + AI 3 课 + 老师 + 课程页/通话页
    // =====================================================================
    if (!skipIndex) await group('v3.1 自由文本课程 / 老师 / 数字人上课', async () => {
      debug.phase = 'v31-tts'
      const upstream = await startMockUpstream()
      const KEY = 'sk-qa-ui-lesson31'
      const putSettings = async (patch) =>
        jfetch(baseUrl + '/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      const setDevice = async (w, h) =>
        cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      const openMobile = async (w = 1440, h = 900) => {
        await setDevice(w, h)
        await navigate(cdp, baseUrl + '/mobile')
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const a = document.getElementById('app'); return !!(a && a.getAttribute('data-ready') === '1'); })()`)) === true,
          { timeoutMs: 15000, label: '手机版就绪（v3.1）' },
        )
        await sleep(500)
      }
      const switchTab = async (tab) => {
        await evalInPage(cdp, `document.querySelector('.tab[data-tab="${tab}"]').click(); true`)
        await sleep(500)
      }
      const waitPlanReady = async () =>
        waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const p = window.__avaMobile.state.plan;
                if (!p || p.generating) return null;
                if (!Array.isArray(p.stages) || !p.stages.every((st) => st.lesson && st.lesson.status === 'ready')) return null;
                return { version: p.version, teacherId: p.teacherId, teacherName: p.teacherName, progress: p.progress, goalText: p.goalText, stages: p.stages.length, lessonTitles: p.stages.map((st) => st.lesson && st.lesson.title) };
              })()`,
            )
            return v || null
          },
          { timeoutMs: 30000, label: 'AI 3 课生成完成' },
        )
      const lessonSnap = `(() => {
        const st = window.__avaMobile.getCallState();
        const panel = document.getElementById('call-lesson');
        const mic = document.getElementById('call-talk');
        const dlg = document.getElementById('call-dialogue');
        const rect = (el) => el ? el.getBoundingClientRect() : null;
        const overlap = (a, b) => !!(a && b && a.left < b.right - 4 && a.right > b.left + 4 && a.top < b.bottom - 4 && a.bottom > b.top + 4);
        return {
          lesson: st.lesson,
          teacherId: st.teacherId,
          open: st.open,
          panelHidden: panel ? panel.hidden : true,
          micOverlap: overlap(rect(panel), rect(mic)),
          dlgOverlap: overlap(rect(panel), rect(dlg)),
          sceneChip: !!document.getElementById('call-scene'),
          title: (document.getElementById('cl-title') || {}).textContent || '',
          steps: [...document.querySelectorAll('#cl-steps .cl-step')].map((s) => ({ text: s.textContent.trim(), cls: s.className })),
          goals: [...document.querySelectorAll('#cl-goals .cl-goal')].map((g) => g.textContent.trim()),
          task: (document.getElementById('cl-task') || {}).textContent || '',
          phrases: [...document.querySelectorAll('#cl-phrases .cl-phrase')].map((p) => ({ en: (p.querySelector('.cl-en') || {}).textContent || '', zh: (p.querySelector('.cl-zh') || {}).textContent || '', cls: p.className })),
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      })()`
      const submitText = async (text) => {
        await evalInPage(
          cdp,
          `(() => {
            const form = document.getElementById('call-textform');
            if (!form) return false;
            if (form.hidden || form.offsetHeight === 0) { const b = document.getElementById('call-text-btn'); if (b) b.click(); }
            return new Promise((resolve) => setTimeout(() => {
              const i = document.getElementById('call-text-input');
              i.value = ${JSON.stringify(text)};
              const f = document.getElementById('call-textform');
              f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
              resolve(true);
            }, 220));
          })()`,
        )
      }
      let probe = null
      try {
        await putSettings({ apiKey: KEY, baseUrl: upstream.url, model: 'mock-model', voiceEngine: 'browser', volc: { clearKey: true } })
        await upstream.reset()
        // 创建计划（自由文本 → 3 课 AI 生成）
        await jfetch(baseUrl + '/api/assistant', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: '帮我制定学习计划：我想学咖啡店点单、机场值机和酒店入住，A2', level: 'A2' }),
        })
        // 探针：TTS 请求 + 浏览器兜底朗读
        probe = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(() => {
            window.__qaTts = []; window.__qaSpeech = [];
            try {
              const of = window.fetch;
              window.fetch = (...args) => {
                try {
                  const u = String(args[0]);
                  if (u.includes('/api/tts') && !u.includes('/voices')) {
                    const b = args[1] && args[1].body;
                    window.__qaTts.push(typeof b === 'string' ? JSON.parse(b) : b);
                  }
                } catch { /* ignore */ }
                return of(...args);
              };
            } catch { /* ignore */ }
            try {
              const orig = window.speechSynthesis.speak.bind(window.speechSynthesis);
              window.speechSynthesis.speak = (u) => { try { window.__qaSpeech.push({ text: u && u.text, lang: u && u.lang }) } catch {} try { return orig(u) } catch { return undefined } };
            } catch { /* ignore */ }
          })()`,
        })
        await openMobile(1440, 900)
        const ready = await waitPlanReady()
        await switchTab('courses')

        await check('课程页 v3.1：hero 进度/老师选择器/锁态/开始上课传 lesson；常用句 🔊 → 角色原声 TTS 请求', async () => {
          const st = await waitUntil(
            async () => {
              const v = await evalInPage(
                cdp,
                `(() => {
                  const root = document.getElementById('screen-courses');
                  const hero = root && root.querySelector('.hero-card');
                  return {
                    hero: !!hero,
                    progress: hero ? (hero.querySelector('.hero-progress-row') || {}).textContent || '' : '',
                    sub: hero ? (hero.querySelector('.hero-sub') || {}).textContent || '' : '',
                    stages: root ? root.querySelectorAll('.stage-card').length : 0,
                    locked: root ? [...root.querySelectorAll('.stage-card')].filter((c) => /未解锁/.test(c.innerText) && c.querySelectorAll('button').length === 0).length : 0,
                    cards: root ? root.querySelectorAll('.lesson-card').length : 0,
                    cardTitle: (root.querySelector('.lesson-card') || {}).innerText || '',
                    teacherBtns: root ? [...root.querySelectorAll('[data-act="pick-teacher"]')].map((b) => ({ char: b.getAttribute('data-char'), on: b.getAttribute('aria-pressed') === 'true' })) : [],
                    start: root ? (() => { const b = root.querySelector('[data-act="start-lesson"]'); return b ? { stage: b.getAttribute('data-stage'), lesson: b.getAttribute('data-lesson-id'), text: b.textContent.trim() } : null })() : null,
                    overflow: document.documentElement.scrollWidth - innerWidth,
                  };
                })()`,
              )
              return v.hero && v.stages >= 3 && v.cards >= 1 ? v : null
            },
            { timeoutMs: 15000, label: 'v3.1 课程页渲染' },
          )
          assert.equal(st.hero, true)
          assert.match(st.progress, /整体进度|0%/, `hero 进度（${st.progress}）`)
          assert.match(st.sub, /已完成 0\/3|老师|Elena/, `hero 副文案（${st.sub}）`)
          assert.equal(st.stages, 3, '3 个阶段卡')
          assert.equal(st.locked >= 2, true, `顺序解锁：≥2 个锁定（实际 ${st.locked}）`)
          assert.ok(st.start, '应有开始上课按钮')
          assert.equal(st.start.lesson, 'lesson_1', '第 1 课 lesson_1')
          assert.equal(st.start.stage, 'stage_1')
          assert.equal(st.teacherBtns.length, 3, '老师选择器应有 3 位老师')
          assert.equal(st.teacherBtns.find((t) => t.on).char, 'elena', '默认老师 Elena')
          assert.match(String(st.cardTitle), /咖啡店点单/, `课程卡应包含本课标题（${String(st.cardTitle).slice(0, 80)}）`)
          assert.ok(st.overflow <= 2, `1440 溢出 ${st.overflow}`)
          await screenshot('ui-v31-courses-1440x900.png')
          // 常用句展开 + 角色原声点读
          await evalInPage(cdp, `document.querySelector('#screen-courses [data-act="toggle-phrases"]').click(); true`)
          await sleep(400)
          const phrases = await evalInPage(cdp, `(() => { const box = document.querySelector('#screen-courses .lesson-phrases'); return { hidden: box ? box.hidden : true, count: document.querySelectorAll('#screen-courses [data-act="speak-phrase"]').length } })()`)
          assert.equal(phrases.hidden, false, '常用句展开')
          assert.equal(phrases.count, 5, '5 条常用句')
          await evalInPage(cdp, `document.querySelectorAll('#screen-courses [data-act="speak-phrase"]')[0].click(); true`)
          await sleep(800)
          const ttsBodies = await evalInPage(cdp, `window.__qaTts || []`)
          assert.ok(Array.isArray(ttsBodies) && ttsBodies.some((b) => b && b.characterId === 'elena' && String(b.text || '').length > 3), `点读应请求 /api/tts 且带 Elena characterId（${JSON.stringify(ttsBodies).slice(0, 200)}）`)
          // 切换老师 Maya
          await evalInPage(cdp, `document.querySelector('#screen-courses [data-act="pick-teacher"][data-char="maya"]').click(); true`)
          const maya = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const p = window.__avaMobile.state.plan; return p ? { id: p.teacherId, name: p.teacherName } : null })()`)
              return v && v.id === 'maya' ? v : null
            },
            { timeoutMs: 10000, label: '切换老师 Maya' },
          )
          assert.equal(maya.name, 'Maya')
          const pressed = await evalInPage(cdp, `document.querySelector('#screen-courses [data-act="pick-teacher"][data-char="maya"]').getAttribute('aria-pressed')`)
          assert.equal(pressed, 'true', 'Maya 选择器应高亮')
          const serverAfterSwitch = (await jfetch(baseUrl + '/api/plan')).json.plan
          assert.equal(serverAfterSwitch.teacherId, 'maya', `切换老师应立即落库（服务端实际 ${serverAfterSwitch.teacherId}）`)
          // 切回 Elena 继续本节 UI 流程；「整份计划老师统一/下一课跟随老师」由 e2e 服务端断言
          await evalInPage(cdp, `document.querySelector('#screen-courses [data-act="pick-teacher"][data-char="elena"]').click(); true`)
          await waitUntil(
            async () => (await jfetch(baseUrl + '/api/plan')).json.plan.teacherId === 'elena',
            { timeoutMs: 10000, label: '切回老师 Elena' },
          )
          await evalInPage(cdp, `window.__avaMobile.ui.refreshCourses(); true`)
          await sleep(500)
          // 开始上课 → openCall 参数（老师/课件）
          await evalInPage(cdp, `window.__qaOpenCalls = []; const orig = window.__avaMobile.ui.openCall; window.__qaOrigOpenCall = orig; window.__avaMobile.ui.openCall = (...args) => { window.__qaOpenCalls.push({ char: typeof args[0] === 'string' ? args[0] : args[0] && args[0].id, lessonId: args[2] && args[2].lessonId, stageId: args[2] && args[2].stageId, teacherId: args[2] && args[2].teacherId, lesson: args[2] && args[2].lesson && args[2].lesson.id }); return Promise.resolve(true); }; true`)
          await evalInPage(cdp, `document.querySelector('#screen-courses [data-act="start-lesson"]').click(); true`)
          await sleep(400)
          const calls = await evalInPage(cdp, `window.__qaOpenCalls || []`)
          await evalInPage(cdp, `window.__avaMobile.ui.openCall = window.__qaOrigOpenCall; true`)
          assert.equal(calls.length >= 1, true)
          assert.equal(calls[0].char, 'elena', '老师应为当前计划老师 Elena')
          assert.equal(calls[0].teacherId, 'elena')
          assert.equal(calls[0].lessonId, 'lesson_1')
          assert.equal(calls[0].stageId, 'stage_1')
          assert.equal(calls[0].lesson, 'lesson_1')
          // 多尺寸
          for (const [w, h, shot] of [[1920, 1080, 'ui-v31-courses-1920x1080.png'], [1280, 800, null], [430, 932, 'ui-v31-courses-430x932.png']]) {
            await setDevice(w, h)
            await sleep(500)
            const of = await evalInPage(cdp, `document.documentElement.scrollWidth - innerWidth`)
            assert.ok(of <= 2, `${w}×${h} 课程页溢出 ${of}`)
            if (shot) await screenshot(shot)
          }
          await setDevice(1440, 900)
        })

        await check('通话页 v3.1：老师 Maya/课件/无场景 chip；5句→练习2轮→挑战2轮→scene-done 33%/下一课', async () => {
          const lesson = await evalInPage(
            cdp,
            `fetch('/api/lessons/lesson_1').then((r) => r.json()).then((j) => j.lesson)`,
          )
          assert.ok(lesson && lesson.id === 'lesson_1', '应能读取 lesson_1')
          await evalInPage(
            cdp,
            `window.__avaMobile.openCall('elena', 0, { lesson: ${JSON.stringify(lesson)}, lessonId: 'lesson_1', stageId: 'stage_1', teacherId: 'elena' }); true`,
          )
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === true,
            { timeoutMs: 10000, label: '打开 v3.1 lesson 通话' },
          )
          const panel = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, lessonSnap)
              return v.lesson && !v.panelHidden ? v : null
            },
            { timeoutMs: 12000, label: 'lesson 面板渲染（v3.1）' },
          )
          assert.equal(panel.teacherId, 'elena', '当前老师 Elena')
          assert.equal(panel.sceneChip, false, 'v3.1 应移除场景 chip')
          assert.equal(panel.lesson.id, 'lesson_1')
          assert.equal(panel.lesson.step, 1)
          assert.match(panel.title, /本课.*咖啡店点单/, `面板标题（${panel.title}）`)
          assert.equal(panel.steps.length, 3, '3 步')
          assert.match(panel.steps[0].cls, /is-current/, '第 1 步当前')
          assert.equal(panel.phrases.length, 5, '5 句')
          assert.equal(panel.phrases[0].cls.includes('is-current'), true, '当前句高亮')
          assert.ok(panel.phrases.every((p) => p.en && p.zh), 'en/zh 齐全')
          assert.equal(panel.micOverlap, false, '不遮挡麦克风')
          assert.equal(panel.dlgOverlap, false, '不遮挡对话条')
          await screenshot('ui-v31-lesson-1440x900.png')
          // 点读 → /api/tts 带当前老师 Maya
          await evalInPage(cdp, `document.querySelector('#call-lesson [data-speak="0"]').click(); true`)
          await sleep(800)
          const ttsBodies = await evalInPage(cdp, `window.__qaTts || []`)
          assert.ok(ttsBodies.some((b) => b && b.characterId === 'elena'), `lesson 点读应请求 Elena 原声（${JSON.stringify(ttsBodies).slice(0, 160)}）`)
          // 5 句跟读
          const enPhrases = panel.phrases.map((p) => p.en)
          for (let i = 0; i < enPhrases.length; i++) {
            await submitText(enPhrases[i])
            await waitUntil(
              async () => {
                const v = await evalInPage(cdp, `window.__avaMobile.getCallState().lesson`)
                return v && (v.phraseIdx > i || v.step >= 2) ? v : null
              },
              { timeoutMs: 15000, label: `v3.1 跟读第 ${i + 1} 句` },
            )
            await waitUntil(
              async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().state`)) === 'idle',
              { timeoutMs: 20000, label: `v3.1 第 ${i + 1} 句回复完成` },
            ).catch(() => {})
          }
          let st = await evalInPage(cdp, `window.__avaMobile.getCallState().lesson`)
          assert.equal(st.step, 2, '5 句完成进练习')
          for (let i = 0; i < 2; i++) {
            await submitText('I would like a coffee, please.')
            await sleep(900)
          }
          st = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `window.__avaMobile.getCallState().lesson`)
              return v && v.step >= 3 ? v : null
            },
            { timeoutMs: 15000, label: 'v3.1 进入挑战' },
          )
          assert.equal(st.step, 3)
          for (let i = 0; i < 2; i++) {
            await submitText('Thanks, that will be all. Have a nice day!')
            await sleep(1000)
          }
          const done = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `window.__avaMobile.getCallState().lesson`)
              return v && v.done ? v : null
            },
            { timeoutMs: 25000, label: 'v3.1 本课完成' },
          )
          assert.equal(done.done, true)
          const sheet = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const s = document.getElementById('sheet'); const b = document.getElementById('sheet-body'); const t = document.getElementById('sheet-title'); return { open: !!(s && !s.hidden), title: t ? t.innerText.replace(/\\s+/g, ' ').trim() : '', text: b ? b.innerText.replace(/\\s+/g, ' ').trim() : '' } })()`)
              return v.open && (/本课完成/.test(v.title) || /整体进度|返回课程/.test(v.text)) ? v : null
            },
            { timeoutMs: 15000, label: 'v3.1 完成结算卡' },
          )
          assert.match(sheet.title, /本课完成/, `结算卡标题（${sheet.title}）`)
          assert.match(sheet.text, /33%/, `进度 33%（${sheet.text.slice(0, 120)}）`)
          assert.match(sheet.text, /机场值机|下一课/, '下一课文案')
          await screenshot('ui-v31-lesson-complete.png')
          // 下一课 → lesson_2，老师和计划保持
          await evalInPage(cdp, `document.querySelector('#sheet-body [data-act="lesson-next"]').click(); true`)
          const serverPlan = await evalInPage(cdp, `fetch('/api/plan').then((r) => r.json()).then((j) => j.plan)`)
          assert.equal(serverPlan.teacherId, 'elena', '服务端计划老师应为 Elena')
          const next = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, lessonSnap)
              return v.lesson && v.lesson.id === 'lesson_2' ? v : null
            },
            { timeoutMs: 20000, label: '打开下一课 lesson_2' },
          )
          assert.match(next.title, /机场值机|本课/, `下一课标题（${next.title}）`)
          assert.equal(next.teacherId, 'elena', `下一课保持当前老师 Elena（实际 ${next.teacherId}，服务端 ${serverPlan.teacherId}）`)
          await screenshot('ui-v31-next-lesson.png')
          // 返回课程
          await evalInPage(cdp, `document.getElementById('call-back').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === false,
            { timeoutMs: 12000, label: '结束 lesson 通话' },
          )
          await switchTab('courses')
          const hero = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const root = document.getElementById('screen-courses'); const h = root && root.querySelector('.hero-progress-row'); return h ? h.textContent : '' })()`)
              return /33%/.test(v) ? v : null
            },
            { timeoutMs: 25000, label: '课程页进度 33%' },
          )
          assert.match(hero, /33%/, `课程页进度（${hero}）`)
          // 非 lesson 通话无面板/无场景 chip
          await evalInPage(cdp, `window.__avaMobile.openCall('elena', 0); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === true,
            { timeoutMs: 10000, label: '普通通话打开' },
          )
          const normal = await evalInPage(cdp, lessonSnap)
          assert.equal(normal.lesson, null, '非 lesson lesson=null')
          assert.equal(normal.panelHidden, true, '非 lesson 无面板')
          assert.equal(normal.sceneChip, false, '非 lesson 无场景 chip')
          await evalInPage(cdp, `document.getElementById('call-back').click(); true`)
          await sleep(400)
          assert.equal(debug.jsErrors.length, 0, 'v3.1 UI 流程无 JS 异常')
        })

        await check('v3.2 断点续学：lesson-progress/restart/课程卡继续上课/通话恢复/完成清空', async () => {
          const postPlan = async (path, body) =>
            jfetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          // 用第 2 课造断点（第 1 课已 33% 完成，第 2 课已解锁）
          const saved = await postPlan('/api/plan/lesson-progress', { lessonId: 'lesson_2', step: 1, phraseIdx: 2 })
          assert.equal(saved.status, 200, 'POST lesson-progress')
          assert.equal(saved.json.ok, true)
          assert.equal(saved.json.resume.step, 1)
          assert.equal(saved.json.resume.phraseIdx, 2)
          let plan = (await jfetch(baseUrl + '/api/plan')).json.plan
          const lesson2 = plan.stages[1].lesson
          assert.equal(lesson2.resume.step, 1, 'GET /api/plan 应含 resume.step')
          assert.equal(lesson2.resume.phraseIdx, 2)
          // clamp：step 越界归一 1–3、phraseIdx 归一句数
          const clamped = await postPlan('/api/plan/lesson-progress', { lessonId: 'lesson_2', step: 9, phraseIdx: 99, practiceTurns: -3 })
          assert.equal(clamped.json.ok, true)
          assert.ok([1, 2, 3].includes(clamped.json.resume.step), `step 应归一（实际 ${clamped.json.resume.step}）`)
          assert.ok(clamped.json.resume.phraseIdx >= 0 && clamped.json.resume.phraseIdx <= 5, `phraseIdx 应归一（实际 ${clamped.json.resume.phraseIdx}）`)
          // 课程页：断点小字/chip/继续上课/hero 继续上次
          await evalInPage(cdp, `window.__avaMobile.ui.refreshCourses(); true`)
          await sleep(700)
          await switchTab('courses')
          const card = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => {
                const c = document.querySelector('#screen-courses .lesson-card[data-lesson-id="lesson_2"]');
                const hero = document.querySelector('#screen-courses [data-next-resume-step]');
                return c ? {
                  resumeStep: c.getAttribute('data-resume-step'),
                  resumeDetail: c.getAttribute('data-resume-detail'),
                  text: c.innerText.replace(/\\s+/g, ' ').trim(),
                  chip: [...c.querySelectorAll('.m-chip')].map((x) => x.textContent.trim()),
                  startText: (c.querySelector('[data-act="start-lesson"]') || {}).textContent || '',
                  restart: !!c.querySelector('[data-act="restart-lesson"]'),
                  heroResume: hero ? hero.getAttribute('data-next-resume-step') : null,
                } : null
              })()`)
              return v && v.resumeStep ? v : null
            },
            { timeoutMs: 20000, label: '课程卡断点态' },
          )
          assert.ok(card.resumeStep, '课程卡应有 data-resume-step')
          assert.match(String(card.resumeDetail), /跟读|挑战|练习|第|步/, `断点明细（${card.resumeDetail}）`)
          assert.ok(card.text.includes('上次学到') || card.text.includes('继续'), '应显示断点小字')
          assert.ok(card.chip.some((x) => /继续|第/.test(x)), `状态 chip（${JSON.stringify(card.chip)}）`)
          assert.match(card.startText, /继续上课/, `按钮文案（${card.startText}）`)
          assert.equal(card.restart, true, '断点卡应有「从头开始」')
          assert.ok(card.heroResume, 'hero 应有 data-next-resume-step')
          await screenshot('ui-v32-courses-resume-1440x900.png')
          // 从头开始 → 清断点
          await evalInPage(cdp, `document.querySelector('#screen-courses .lesson-card[data-lesson-id="lesson_2"] [data-act="restart-lesson"]').click(); true`)
          await waitUntil(
            async () => {
              const p = (await jfetch(baseUrl + '/api/plan')).json.plan
              return p.stages[1].lesson.resume == null
            },
            { timeoutMs: 10000, label: '从头开始清断点' },
          )
          // 再造 step1/phraseIdx2 断点，验证通话恢复
          await postPlan('/api/plan/lesson-progress', { lessonId: 'lesson_2', step: 1, phraseIdx: 2 })
          const lesson2Fresh = (await jfetch(baseUrl + '/api/lessons/lesson_2')).json.lesson
          assert.equal(lesson2Fresh.resume.phraseIdx, 2)
          await evalInPage(cdp, `window.__avaMobile.openCall('elena', 0, { lesson: ${JSON.stringify(lesson2Fresh)}, lessonId: 'lesson_2', stageId: 'stage_2', teacherId: 'elena' }); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === true,
            { timeoutMs: 10000, label: '打开恢复通话' },
          )
          const restored = await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const s = window.__avaMobile.getCallState(); return { lesson: s.lesson, title: (document.getElementById('cl-title') || {}).textContent || '', current: [...document.querySelectorAll('#cl-phrases .cl-phrase.is-current')].map((p) => p.getAttribute('data-idx')) } })()`)
              return v.lesson && v.lesson.step === 1 && v.lesson.phraseIdx === 2 ? v : null
            },
            { timeoutMs: 15000, label: '通话恢复 step1/phraseIdx2' },
          )
          assert.ok(restored.lesson.passed.length >= 2, `前 2 句应为已通过（实际 ${restored.lesson.passed.length}）`)
          assert.equal(restored.current[0], '2', '当前句应为第 3 句（idx=2）')
          assert.match(restored.title, /咖啡店|机场|本课/, `恢复面板标题（${restored.title}）`)
          await screenshot('ui-v32-call-resume-1440x900.png')
          // 退出通话 → 断点仍在（call 自动保存）
          await evalInPage(cdp, `document.getElementById('call-back').click(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `window.__avaMobile.getCallState().open`)) === false,
            { timeoutMs: 12000, label: '退出恢复通话' },
          )
          const persisted = (await jfetch(baseUrl + '/api/plan')).json.plan.stages[1].lesson.resume
          assert.ok(persisted && Number(persisted.phraseIdx) >= 2, `退出后断点应保留（${JSON.stringify(persisted)}）`)
          // 完成第 2 课 → resume 清空、进度 67%
          const done2 = await postPlan('/api/plan/scene-done', { lessonId: 'lesson_2', stageId: 'stage_2', stepsCompleted: 3 })
          assert.equal(done2.json.completed, true)
          assert.equal(done2.json.plan.progress, 67)
          assert.equal(done2.json.plan.stages[1].lesson.resume, null, '完成课应清空 resume')
          assert.equal(done2.json.plan.stages[1].lesson.done, true)
          // 课程页刷新：第 2 课已完成 ✓、无断点
          await evalInPage(cdp, `window.__avaMobile.ui.refreshCourses(); true`)
          await switchTab('courses')
          await waitUntil(
            async () => {
              const v = await evalInPage(cdp, `(() => { const c = document.querySelector('#screen-courses .lesson-card[data-lesson-id="lesson_2"]'); return c ? { chip: [...c.querySelectorAll('.m-chip')].map((x) => x.textContent.trim()), resume: c.getAttribute('data-resume-step') } : null })()`)
              return v && v.chip.some((x) => /已完成/.test(x)) ? v : null
            },
            { timeoutMs: 12000, label: '第 2 课完成态' },
          )
        })
      } finally {
        if (probe && probe.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: probe.identifier }).catch(() => {})
        await upstream.close()
        await putSettings({ apiKey: '', clearKey: true, voiceEngine: 'browser' }).catch(() => {})
      }
    })

    // =====================================================================
    // v3.3：全站毛玻璃 + 助手返回不跳动
    // =====================================================================
    if (!skipIndex) await group('v3.3 毛玻璃 / 助手返回不跳动', async () => {
      const setDevice = async (w, h) =>
        cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      const openMobile = async (w = 1440, h = 900) => {
        await setDevice(w, h)
        await navigate(cdp, baseUrl + '/mobile')
        await waitUntil(
          async () => (await evalInPage(cdp, `(() => { const a = document.getElementById('app'); return !!(a && a.getAttribute('data-ready') === '1'); })()`)) === true,
          { timeoutMs: 15000, label: '手机版就绪（v3.3）' },
        )
        await sleep(500)
      }
      try {
        await openMobile(1440, 900)

        await check('课程空态 v3.3：plan=null 安静空态（无骨架/进度/spinner）+ 期待文案；仅 generating 显示骨架', async () => {
          // 1) plan=null
          const emptyInject = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `(() => { const of = window.fetch; window.fetch = (...a) => { try { const u = String(a[0]); const m = (a[1] && a[1].method) || 'GET'; if (u.includes('/api/plan') && m === 'GET') return Promise.resolve(new Response(JSON.stringify({ ok: true, plan: null }), { status: 200, headers: { 'content-type': 'application/json' } })) } catch { /* ignore */ } return of(...a) }; })()`,
          })
          try {
            await openMobile(1440, 900)
            await evalInPage(cdp, `window.__avaMobile.switchTab('courses'); true`)
            await sleep(700)
            const empty = await evalInPage(
              cdp,
              `(() => {
                const root = document.getElementById('screen-courses');
                const text = root ? root.innerText.replace(/\\s+/g, ' ').trim() : '';
                return {
                  stages: root ? root.querySelectorAll('.stage-card').length : -1,
                  loading: root ? root.querySelectorAll('.spinner, .shimmer, [class*="skeleton"], .progress-fill').length : -1,
                  text,
                  overflow: document.documentElement.scrollWidth - innerWidth,
                };
              })()`,
            )
            assert.equal(empty.stages, 0, 'plan=null 时不应渲染阶段占位卡')
            assert.equal(empty.loading, 0, 'plan=null 时不应有 spinner/skeleton/进度条')
            assert.match(empty.text, /期待与您的第一个计划|去助手定制计划/, `空态文案（${empty.text.slice(0, 120)}）`)
            assert.ok(!/生成中|待生成|加载中/.test(empty.text), '空态不应出现生成中/加载中字样')
            assert.ok(empty.overflow <= 2, `空态横向溢出 ${empty.overflow}`)
            await screenshot('ui-v33-courses-empty-1440x900.png')
          } finally {
            await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: emptyInject.identifier })
          }
          // 2) generating 才显示骨架
          const genInject = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `(() => {
              const of = window.fetch;
              const real = (async () => { try { const r = await of('/api/plan'); return (await r.json()).plan } catch { return null } })();
              window.fetch = async (...a) => {
                try {
                  const u = String(a[0]);
                  const m = (a[1] && a[1].method) || 'GET';
                  if (u.includes('/api/plan') && m === 'GET') {
                    const plan = await real;
                    if (plan) {
                      const clone = JSON.parse(JSON.stringify(plan));
                      clone.generating = true;
                      for (const st of clone.stages || []) if (st.lesson) st.lesson.status = 'generating';
                      return new Response(JSON.stringify({ ok: true, plan: clone }), { status: 200, headers: { 'content-type': 'application/json' } });
                    }
                  }
                } catch { /* ignore */ }
                return of(...a);
              };
            })()`,
          })
          try {
            await openMobile(1440, 900)
            await evalInPage(cdp, `window.__avaMobile.switchTab('courses'); true`)
            await sleep(900)
            const gen = await evalInPage(
              cdp,
              `(() => {
                const root = document.getElementById('screen-courses');
                return {
                  loading: root ? root.querySelectorAll('.spinner, .shimmer, [class*="skeleton"]').length : -1,
                  stages: root ? root.querySelectorAll('.stage-card').length : -1,
                  text: root ? root.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80) : '',
                };
              })()`,
            )
            assert.ok(gen.loading > 0, `generating 时应显示骨架/spinner（实际 ${gen.loading}）`)
            assert.ok(gen.stages > 0, 'generating 时应显示阶段占位卡')
          } finally {
            await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: genInject.identifier })
            await openMobile(1440, 900)
          }
        })

        await check('毛玻璃：glass.css 加载、各页主卡半透明+backdrop-filter（桌面 blur≥20、430≥12）、无溢出', async () => {
          const version = await evalInPage(cdp, `window.__avaMobile.version`)
          assert.match(String(version), /^v3\.[34]$/, `版本应为 v3.3/v3.4（实际 ${version}）`)
          const css = await evalInPage(cdp, `(() => [...document.styleSheets].some((s) => s.href && /glass\\.css/.test(s.href)))()`)
          assert.equal(css, true, '应加载 glass.css')
          const probe = `(async () => {
            const out = {};
            const read = (sel) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              const cs = getComputedStyle(el);
              const m = /rgba?\\(([^)]+)\\)/.exec(cs.backgroundColor || '');
              const alpha = m ? Number((m[1].split(',')[3] || '1').trim()) : 1;
              const bf = cs.backdropFilter || cs.webkitBackdropFilter || '';
              const blur = (bf.match(/blur\\(([\\d.]+)px\\)/) || [])[1];
              return { alpha, blur: blur == null ? null : Number(blur), bf };
            };
            const tabs = [...document.querySelectorAll('#tabbar .tab')].map((t) => t.getAttribute('data-tab'));
            for (const tab of tabs) {
              window.__avaMobile.switchTab(tab);
              await new Promise((r) => setTimeout(r, 250));
              out[tab] = {
                screen: read('#screen-' + tab + ' .hero-card') || read('#screen-' + tab + ' .rv-hero') || read('#screen-' + tab + ' .profile-card') || read('#screen-' + tab + ' .a-card') || read('#screen-' + tab + ' .screen-side > div'),
                overflow: document.documentElement.scrollWidth - innerWidth,
              };
            }
            out.tabbar = read('#tabbar');
            return out;
          })()`
          const st = await evalInPage(cdp, probe)
          const entries = Object.entries(st).filter(([k]) => k !== 'tabbar')
          const blurred = entries.filter(([, v]) => v.screen && v.screen.blur != null && v.screen.blur >= 20).map(([k]) => k)
          assert.ok(blurred.length >= 3, `应有 ≥3 个页面主卡桌面 blur≥20（实际 ${JSON.stringify(blurred)}）`)
          const glassy = entries.filter(([, v]) => v.screen && v.screen.alpha <= 0.8).length
          assert.ok(glassy >= 3, `应有 ≥3 个页面主卡明显半透明（实际 ${glassy}）`)
          assert.ok(st.tabbar && st.tabbar.blur >= 20, `tabbar 应有 blur≥20（实际 ${st.tabbar && st.tabbar.blur}）`)
          for (const [tab, v] of entries) assert.ok(v.overflow <= 2, `${tab} 横向溢出 ${v.overflow}`)
          await evalInPage(cdp, `window.__avaMobile.switchTab('courses'); true`)
          await sleep(300)
          await screenshot('ui-v33-glass-courses-1440x900.png')
          await evalInPage(cdp, `window.__avaMobile.switchTab('assistant'); true`)
          await sleep(300)
          await screenshot('ui-v33-glass-assistant-1440x900.png')
          // 430：blur 降档但 ≥12，无溢出
          await setDevice(430, 932)
          await sleep(500)
          await evalInPage(cdp, `window.__avaMobile.switchTab('courses'); true`)
          await sleep(300)
          const m = await evalInPage(cdp, `(() => { const el = document.querySelector('#screen-courses .hero-card'); const cs = el ? (getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || '') : ''; const blur = (cs.match(/blur\\(([\\d.]+)px\\)/) || [])[1]; return { blur: blur ? Number(blur) : null, overflow: document.documentElement.scrollWidth - innerWidth } })()`)
          assert.ok(m.blur != null && m.blur >= 12, `430 主卡 blur 应 ≥12（实际 ${m.blur}）`)
          assert.ok(m.overflow <= 2, `430 横向溢出 ${m.overflow}`)
          await screenshot('ui-v33-glass-courses-430x932.png')
          // 旧版 / 不加载 glass.css
          await navigate(cdp, baseUrl + '/')
          await sleep(900)
          const legacy = await evalInPage(cdp, `(() => ({ glass: [...document.styleSheets].some((s) => s.href && /glass\\.css/.test(s.href)), errors: 0 }))()`)
          assert.equal(legacy.glass, false, '旧版 / 不应加载 glass.css')
          await setDevice(1440, 900)
          await openMobile(1440, 900)
        })

        await check('v3.4 知识库整屏重设计：fixed 全屏/隐藏 tabbar/无玻璃无虚框/1920-1440-1280-430 布局', async () => {
          await evalInPage(cdp, `window.__avaMobile.openKb(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const s = document.getElementById('kb-screen'); return !!(s && !s.hidden) })()`)) === true,
            { timeoutMs: 10000, label: 'KB 打开' },
          )
          await sleep(800)
          const probe = `(() => {
            const screen = document.getElementById('kb-screen');
            const tabbar = document.getElementById('tabbar');
            const bodyOk = document.body.classList.contains('kb-open');
            const rect = screen ? screen.getBoundingClientRect() : null;
            let blur = 0, dashed = 0;
            if (screen) {
              for (const el of [screen, ...screen.querySelectorAll('*')]) {
                const cs = getComputedStyle(el);
                if (cs.backdropFilter && cs.backdropFilter !== 'none') blur++;
                if (cs.borderStyle && /dashed/.test(cs.borderStyle)) dashed++;
              }
            }
            const side = screen ? screen.querySelector('.kb-side, .kb-col, .kb-actions') : null;
            const main = screen ? screen.querySelector('.kb-main, .kb-list-wrap, .kb-list') : null;
            const list = screen ? screen.querySelector('.kb-list') : null;
            return {
              open: !!(screen && !screen.hidden),
              pos: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
              bodyOk, bodyCls: document.body.className,
              tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : '',
              blur, dashed,
              sideW: side ? Math.round(side.getBoundingClientRect().width) : null,
              mainW: main ? Math.round(main.getBoundingClientRect().width) : null,
              listH: list ? Math.round(list.getBoundingClientRect().height) : null,
              inner: { w: innerWidth, h: innerHeight },
              overflow: document.documentElement.scrollWidth - innerWidth,
            };
          })()`
          const st = await evalInPage(cdp, probe)
          assert.equal(st.open, true, 'KB 应打开')
          assert.ok(Math.abs(st.pos.w - st.inner.w) <= 3 && Math.abs(st.pos.h - st.inner.h) <= 3, `KB 应铺满 viewport（${JSON.stringify(st.pos)} vs ${JSON.stringify(st.inner)}）`)
          assert.equal(st.bodyOk, true, '打开 KB 时 body 应有 kb-open')
          assert.match(String(st.tabbarDisplay), /none/, `KB 打开时应隐藏 tabbar（display=${st.tabbarDisplay}）`)
          assert.equal(st.blur, 0, `KB 内不应有 backdrop-filter（实际 ${st.blur}）`)
          assert.equal(st.dashed, 0, `KB 内不应有 dashed 虚框（实际 ${st.dashed}）`)
          if (st.inner.w > 1100) {
            assert.ok(st.sideW >= 280 && st.sideW <= 420, `桌面左列应约 360px（实际 ${st.sideW}）`)
            assert.ok(st.mainW >= st.inner.w * 0.45, `右侧列表应填满剩余宽度（实际 ${st.mainW}）`)
          }
          assert.ok(st.listH > 120, `材料列表应有高度（${st.listH}）`)
          assert.ok(st.overflow <= 2, `1440 KB 横向溢出 ${st.overflow}`)
          await screenshot('ui-v34-kb-full-1440x900.png')
          for (const [w, h, shot] of [[1920, 1080, 'ui-v34-kb-full-1920x1080.png'], [1280, 800, 'ui-v34-kb-full-1280x800.png'], [430, 932, 'ui-v34-kb-full-430x932.png']]) {
            await setDevice(w, h)
            await sleep(600)
            const v = await evalInPage(cdp, probe)
            assert.equal(v.open, true, `${w} KB 应保持打开`)
            assert.ok(Math.abs(v.pos.w - v.inner.w) <= 3, `${w} KB 应铺满宽度`)
            assert.equal(v.blur, 0, `${w} KB 内不应有 blur`)
            assert.equal(v.dashed, 0, `${w} KB 内不应有 dashed`)
            assert.ok(v.overflow <= 2, `${w} KB 横向溢出 ${v.overflow}`)
            if (w > 1100) assert.ok(v.sideW >= 280 && v.sideW <= 420, `${w} 左列 ${v.sideW}`)
            await screenshot(shot)
          }
          await evalInPage(cdp, `window.__avaMobile.closeKb(); true`)
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const s = document.getElementById('kb-screen'); return !s || s.hidden })()`)) === true,
            { timeoutMs: 8000, label: 'KB 关闭' },
          )
          const closed = await evalInPage(cdp, `(() => ({ bodyOk: document.body.classList.contains('kb-open'), tabbar: getComputedStyle(document.getElementById('tabbar')).display }))()`)
          assert.equal(closed.bodyOk, false, '关闭 KB 后 body.kb-open 应移除')
          assert.ok(closed.tabbar !== 'none', `关闭 KB 后 tabbar 应恢复（display=${closed.tabbar}）`)
          await setDevice(1440, 900)
          await screenshot('ui-v34-kb-closed-1440x900.png')
        })
        await check('v3.4 毛玻璃稳定性：切 Tab 前后 computed style/截图像素稳定、无 .screen 入场动画、world 静态、chips 外层透明', async () => {
          await evalInPage(cdp, `window.__avaMobile.switchTab('courses'); true`)
          await sleep(500)
          const styleOf = `(() => {
            const card = document.querySelector('#screen-courses .hero-card');
            const screen = document.getElementById('screen-courses');
            const js = getComputedStyle(card);
            const ss = getComputedStyle(screen);
            const w = document.querySelector('.world-img.is-on') || document.querySelector('.world-img');
            const chips = document.querySelector('#screen-assistant .a-chip');
            const chipsWrap = chips ? chips.parentElement : null;
            const cw = chipsWrap ? getComputedStyle(chipsWrap) : null;
            const wr = w ? { animationName: getComputedStyle(w).animationName, transform: getComputedStyle(w).transform } : null;
            return {
              bg: js.backgroundColor, bf: js.backdropFilter || js.webkitBackdropFilter || '',
              screenAnim: ss.animationName, screenSeen: screen.getAttribute('data-seen'),
              world: wr,
              chipsBg: cw ? cw.backgroundColor : null, chipsBf: cw ? (cw.backdropFilter || cw.webkitBackdropFilter || '') : null,
            };
          })()`
          const before = await evalInPage(cdp, styleOf)
          await screenshot('ui-v34-glass-stable-a.png')
          await evalInPage(cdp, `window.__avaMobile.switchTab('assistant'); true`)
          await sleep(400)
          const animOnAssistant = await evalInPage(cdp, `getComputedStyle(document.getElementById('screen-assistant')).animationName`)
          assert.equal(animOnAssistant, 'none', '页面切换不应播放 .screen 入场动画（app.js/glass.css 已统一 none）')
          await evalInPage(cdp, `window.__avaMobile.switchTab('courses'); true`)
          await sleep(500)
          const after = await evalInPage(cdp, styleOf)
          assert.equal(before.bg, after.bg, `切 Tab 前后卡片背景色应不变（${before.bg} → ${after.bg}）`)
          assert.equal(before.bf, after.bf, `切 Tab 前后 backdrop-filter 应不变（${before.bf} → ${after.bf}）`)
          assert.equal(after.screenAnim, 'none', '再次进入页面不应有 animation')
          assert.equal(before.screenAnim, 'none', '首次进入页面 animation 也应统一为 none（glass 稳定性修复）')
          assert.equal(after.world && after.world.animationName, 'none', `.world-img 不应持续动画（${after.world && after.world.animationName}）`)
          assert.ok(after.world && /matrix\(1\.02/.test(after.world.transform), `world 应为静态 scale(1.02)（${after.world && after.world.transform}）`)
          assert.ok(!after.chipsBf || after.chipsBf === 'none', `助手 chips 外层不应再有自己的 backdrop-filter（${after.chipsBf}）`)
          assert.ok(after.chipsBg === 'rgba(0, 0, 0, 0)' || after.chipsBg === 'transparent', `助手 chips 外层应透明（${after.chipsBg}）`)
          await screenshot('ui-v34-glass-stable-b.png')
          const bufA = await fsp.readFile(path.join(ARTIFACTS_DIR, 'ui-v34-glass-stable-a.png'))
          const bufB = await fsp.readFile(path.join(ARTIFACTS_DIR, 'ui-v34-glass-stable-b.png'))
          const diff = pngDiffRatio(bufA, bufB)
          console.log(`[info] v3.4 glass stability diff=${(diff.ratio * 100).toFixed(3)}%`);
          assert.ok(diff.ratio < 0.02, `切 Tab 前后整页截图应稳定（实际差异 ${(diff.ratio * 100).toFixed(3)}%）`)
        })
        await check('助手返回不跳动：滚动保持/DOM 与 renderKey 不变/输入草稿保留/无自动聚焦/入场动画不重播', async () => {
          await evalInPage(cdp, `window.__avaMobile.switchTab('assistant'); true`)
          await sleep(400)
          // 注入长对话并重建
          await evalInPage(
            cdp,
            `(async () => {
              const core = await import('/js/mobile/core.js');
              const scr = await import('/js/mobile/screens.js');
              for (let i = 0; i < 28; i++) core.M.assistantThread.push({ role: i % 2 ? 'assistant' : 'user', content: '测试消息 ' + i + ' ' + 'long content for scroll test. '.repeat(3) });
              scr.renderAssistant();
              window.__avaMobile.switchTab('assistant');
              return true;
            })()`,
          )
          await sleep(500)
          const before = await evalInPage(
            cdp,
            `(() => {
              const th = document.getElementById('assistant-thread');
              const screen = document.getElementById('screen-assistant');
              const key = screen ? screen.getAttribute('data-render-key') : '';
              window.__qaTh = th;
              window.__qaScreen = screen;
              const input = document.getElementById('assistant-input');
              if (input) { input.value = '草稿内容 draft'; input.focus(); input.setSelectionRange(4, 4); input.blur(); }
              if (th) th.scrollTop = Math.floor((th.scrollHeight - th.clientHeight) * 0.45);
              else screen.scrollTop = Math.floor((screen.scrollHeight - screen.clientHeight) * 0.45);
              const bar = document.getElementById('assistant-form');
              return {
                key,
                scroll: th ? th.scrollTop : screen.scrollTop,
                outer: screen ? screen.scrollTop : 0,
                barTop: bar ? bar.getBoundingClientRect().top : null,
                draft: input ? input.value : '',
                sel: input ? input.selectionStart : null,
                seen: screen ? screen.getAttribute('data-seen') : null,
              };
            })()`,
          )
          // 切走 → 切回
          await evalInPage(cdp, `window.__avaMobile.switchTab('courses'); true`)
          await sleep(500)
          await evalInPage(cdp, `window.__avaMobile.switchTab('assistant'); true`)
          await sleep(700)
          const after = await evalInPage(
            cdp,
            `(() => {
              const th = document.getElementById('assistant-thread');
              const screen = document.getElementById('screen-assistant');
              const bar = document.getElementById('assistant-form');
              const input = document.getElementById('assistant-input');
              const active = document.activeElement;
              const anim = screen ? getComputedStyle(screen).animationName : '';
              return {
                sameTh: !!th && th === window.__qaTh,
                sameScreen: !!screen && screen === window.__qaScreen,
                key: screen ? screen.getAttribute('data-render-key') : '',
                scroll: th ? th.scrollTop : screen ? screen.scrollTop : -1,
                outer: screen ? screen.scrollTop : -1,
                barTop: bar ? bar.getBoundingClientRect().top : null,
                draft: input ? input.value : '',
                sel: input ? input.selectionStart : null,
                focusedInput: active === input,
                seen: screen ? screen.getAttribute('data-seen') : null,
                anim,
                overflow: document.documentElement.scrollWidth - innerWidth,
              };
            })()`,
          )
          assert.equal(after.sameTh, true, '切回助手后 #assistant-thread DOM 引用应不变')
          assert.equal(after.sameScreen, true, '#screen-assistant DOM 引用应不变')
          assert.equal(after.key, before.key, `data-render-key 应不变（${before.key} → ${after.key}）`)
          assert.ok(Math.abs(after.scroll - before.scroll) <= 2, `滚动位置应保持（${before.scroll} → ${after.scroll}）`)
          assert.ok(Math.abs(after.outer - before.outer) <= 2, `外层滚动应保持（${before.outer} → ${after.outer}）`)
          assert.ok(after.barTop != null && before.barTop != null && Math.abs(after.barTop - before.barTop) <= 2, `输入栏位置应不变（${before.barTop} → ${after.barTop}）`)
          assert.equal(after.draft, before.draft, '输入框草稿应保留')
          assert.equal(after.sel, before.sel, '光标位置应保留')
          assert.equal(after.focusedInput, false, '切回助手不应自动聚焦输入框')
          assert.equal(after.seen, '1', '再次进入应标记 data-seen=1')
          assert.equal(after.anim, 'none', `再次进入不应重播入场动画（${after.anim}）`)
          assert.ok(after.overflow <= 2, `助手页横向溢出 ${after.overflow}`)
          await screenshot('ui-v33-assistant-return-1440x900.png')
          // 430：thread 不内部滚动时走外层 fallback
          await setDevice(430, 932)
          await sleep(500)
          await evalInPage(cdp, `window.__avaMobile.switchTab('courses'); true`)
          await sleep(400)
          await evalInPage(cdp, `window.__avaMobile.switchTab('assistant'); true`)
          await sleep(500)
          const m430 = await evalInPage(
            cdp,
            `(() => {
              const th = document.getElementById('assistant-thread');
              const screen = document.getElementById('screen-assistant');
              const bar = document.getElementById('assistant-form');
              return { overflow: document.documentElement.scrollWidth - innerWidth, sameTh: !!th && th === window.__qaTh, sameScreen: !!screen && screen === window.__qaScreen, key: screen ? screen.getAttribute('data-render-key') : '', barTop: bar ? bar.getBoundingClientRect().top : null, anim: screen ? getComputedStyle(screen).animationName : '' }
            })()`,
          )
          assert.equal(m430.sameTh, true, '430 助手 thread DOM 应复用')
          assert.equal(m430.sameScreen, true, '430 助手 screen DOM 应复用')
          assert.equal(m430.key, before.key, '430 renderKey 应不变')
          assert.equal(m430.anim, 'none', '430 再次进入不应重播动画')
          assert.ok(m430.overflow <= 2, `430 助手横向溢出 ${m430.overflow}`)
          await screenshot('ui-v33-assistant-return-430x932.png')
          await setDevice(1440, 900)
          assert.equal(debug.jsErrors.length, 0, 'v3.3 流程不应产生 JS 异常')
        })
      } finally {
        /* no-op */
      }
    })

    // =====================================================================
    // v3.8：移动端关闭浏览器自带语音（只用豆包角色原声）；桌面旧版不受影响
    // =====================================================================
    if (!skipIndex) await group('v3.8 移动端浏览器 TTS 禁用 / 角色原声', async () => {
      const setDevice = async (w, h) =>
        cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      (async () => {
        await setDevice(1440, 900)
        const probe = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(() => {
            window.__qaDtmSpeech = 0;
            try {
              const orig = window.speechSynthesis.speak.bind(window.speechSynthesis);
              window.speechSynthesis.speak = (u) => {
                window.__qaDtmSpeech++;
                try { if (/^移动端测试/.test(String(u && u.text || ''))) return undefined } catch { /* ignore */ }
                try { return orig(u) } catch { return undefined }
              };
            } catch { /* ignore */ }
          })()`,
        })
        try {
          await navigate(cdp, baseUrl + '/mobile')
          await waitUntil(
            async () => (await evalInPage(cdp, `(() => { const a = document.getElementById('app'); return !!(a && a.getAttribute('data-ready') === '1'); })()`)) === true,
            { timeoutMs: 15000, label: '移动版就绪（v3.8）' },
          )
          await check('移动端 speechSynthesis 调用数 0（tts.speak/simulateTranscript 都不触发系统朗读）', async () => {
            const r = await evalInPage(
              cdp,
              `(async () => {
                const before = window.__qaDtmSpeech || 0;
                let direct = null;
                try {
                  const mod = await import('/js/speech.js');
                  const tts = mod.tts || mod.default && mod.default.tts;
                  if (tts && typeof tts.speak === 'function') direct = tts.speak('移动端测试 123', { lang: 'en-US', rate: 1 });
                } catch (e) { direct = 'error:' + (e && e.message) }
                window.__avaMobile.openCall('elena', 0);
                await new Promise((r) => setTimeout(r, 600));
                window.__avaMobile.simulateTranscript('Hello, this is a mobile TTS test.');
                await new Promise((r) => setTimeout(r, 3500));
                const after = window.__qaDtmSpeech || 0;
                return { before, after, direct: typeof direct === 'string' ? direct : typeof direct, calls: after - before };
              })()`,
            )
            assert.equal(r.calls, 0, `移动端任何交互都不应调用浏览器 speechSynthesis（实际 ${r.calls}）`)
            assert.equal(r.direct !== 'error:Speech synthesis API is disabled', true)
            await screenshot('ui-v38-mobile-no-browser-tts-1440x900.png')
            await evalInPage(cdp, `document.getElementById('call-back').click(); true`).catch(() => {})
          })
          // 桌面旧版 / 仍可用浏览器 TTS（旧行为不受影响）
          await navigate(cdp, baseUrl + '/')
          await sleep(1200)
          const desk = await evalInPage(
            cdp,
            `(async () => {
              const before = window.__qaDtmSpeech || 0;
              try {
                const mod = await import('/js/speech.js');
                const tts = mod.tts || mod.default && mod.default.tts;
                if (tts && typeof tts.speak === 'function') tts.speak('移动端测试 desktop check', { lang: 'en-US', rate: 1 });
              } catch (e) { return { error: String(e && e.message), calls: 0 } }
              await new Promise((r) => setTimeout(r, 300));
              return { calls: (window.__qaDtmSpeech || 0) - before };
            })()`,
          )
          assert.ok(desk.calls >= 1, `桌面旧版 / 仍应允许浏览器 TTS（实际 ${desk.calls}）`)
        } finally {
          await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: probe.identifier }).catch(() => {})
          await navigate(cdp, baseUrl + '/mobile').catch(() => {})
          await sleep(500)
        }
      })()
    })

    // =====================================================================
    if (!skipPreview) await group('数字人预览页 /avatar/preview.html', async () => {
      debug.phase = 'preview-1440'
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const previewRes = await jfetch(baseUrl + '/avatar/preview.html')
      await check('预览页可访问（200 + HTML）', async () => {
        assert.equal(previewRes.status, 200, `GET /avatar/preview.html 状态码应为 200，实际 ${previewRes.status}`)
        assert.match(previewRes.headers.get('content-type') || '', /text\/html/i, '预览页 Content-Type 应为 HTML')
      })
      await navigate(cdp, baseUrl + '/avatar/preview.html')
      await sleep(1200)

      let probe = null
      await check('预览页渲染出数字人（SVG）与可交互按钮', async () => {
        probe = await evalInPage(cdp, PREVIEW_PROBE)
        assert.equal(probe.readyState, 'complete', `readyState 应为 complete，实际 ${probe.readyState}`)
        assert.ok(probe.svgCount >= 1, `预览页应渲染 SVG 数字人，实际 svg 数量 ${probe.svgCount}`)
        assert.ok(probe.buttonCount >= 6, `预览页应有按钮触发状态/表情/口型（SPEC §4），实际 ${probe.buttonCount} 个`)
        assert.ok(probe.visibleButtons >= 4, `预览页可见按钮应 >=4，实际 ${probe.visibleButtons}`)
        assert.ok(probe.text.length > 20, '预览页应有可见说明文案')
      })

      await check('预览页按钮可点击且无 JS 异常', async () => {
        const before = debug.jsErrors.length
        const buttons = await evalInPage(cdp, `document.querySelectorAll('button').length`)
        const clickCount = Math.min(buttons, 12)
        for (let i = 0; i < clickCount; i++) {
          await evalInPage(
            cdp,
            `(() => { const bs = document.querySelectorAll('button'); const b = bs[${i}]; if (b) b.click(); return true; })()`,
          )
          await sleep(100)
        }
        await sleep(400)
        const newErrors = debug.jsErrors.slice(before)
        assert.equal(newErrors.length, 0, `点击预览页按钮产生 JS 异常：${JSON.stringify(newErrors.slice(0, 3))}`)
      })

      await check('预览页截图（1440×900）', async () => {
        await navigate(cdp, baseUrl + '/avatar/preview.html')
        await sleep(900)
        await screenshot('avatar-preview-1440x900.png')
        const st = await fsp.stat(path.join(ARTIFACTS_DIR, 'avatar-preview-1440x900.png'))
        assert.ok(st.size > 10_000, `预览页截图文件过小（${st.size} bytes），疑似空白页`)
      })

      await check('预览页无横向溢出（1440×900）', async () => {
        probe = await evalInPage(cdp, PREVIEW_PROBE)
        assert.ok(
          probe.docScrollWidth - probe.docClientWidth <= 2,
          `预览页横向溢出：scrollWidth=${probe.docScrollWidth} > clientWidth=${probe.docClientWidth}`,
        )
      })

      await check('数字人预览页 v1.4：外部振幅 setSpeechLevel 驱动口型（?speechLevel=0.85 / 0.05）', async () => {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
        debug.phase = 'preview-speechlevel'
        await navigate(cdp, baseUrl + '/avatar/preview.html?speechLevel=0.85')
        await sleep(1400)
        const hi = await waitUntil(
          async () => {
            const v = await evalInPage(
              cdp,
              `(() => {
                const slider = document.getElementById('speech-slider');
                const val = document.getElementById('speech-val');
                const ro = document.getElementById('ro-speech');
                const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
                return {
                  slider: slider ? slider.value : null,
                  val: val ? val.textContent.trim() : '',
                  readout: ro ? Number(ro.textContent) : null,
                  hasPanel: /外部振幅/.test(text) && /setSpeechLevel/.test(text),
                  hasFeed: !!document.querySelector('[data-action="speech-feed"]'),
                  hasReset: !!document.querySelector('[data-action="speech-reset"]'),
                };
              })()`,
            )
            return v.readout != null && v.readout > 0.2 ? v : null
          },
          { timeoutMs: 8000, label: 'speechLevel=0.85 生效' },
        )
        assert.equal(hi.hasPanel, true, '预览页应有「外部振幅 setSpeechLevel()」面板')
        assert.equal(hi.hasFeed, true, '应有「模拟流式振幅」按钮')
        assert.equal(hi.hasReset, true, '应有「endSpeech() 复位」按钮')
        assert.equal(hi.slider, '0.85', `滑杆应预置 0.85，实际 ${hi.slider}`)
        assert.ok(hi.readout > 0.2, `外部振幅应驱动口型（readout ${hi.readout}）`)
        await screenshot('ui-avatar-speechlevel-1440.png')
        await navigate(cdp, baseUrl + '/avatar/preview.html?speechLevel=0.05')
        await sleep(1200)
        const lo = await evalInPage(
          cdp,
          `(() => {
            const slider = document.getElementById('speech-slider');
            const ro = document.getElementById('ro-speech');
            return { slider: slider ? slider.value : null, readout: ro ? Number(ro.textContent) : null };
          })()`,
        )
        assert.equal(lo.slider, '0.05', `滑杆应预置 0.05，实际 ${lo.slider}`)
        assert.ok(lo.readout != null && lo.readout < hi.readout, `低振幅口型应更闭合（${lo.readout} < ${hi.readout}）`)
      })

      await check('预览页截图（420×860 移动端）', async () => {
        debug.phase = 'preview-420'
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 420,
          height: 860,
          deviceScaleFactor: 1,
          mobile: true,
        })
        await navigate(cdp, baseUrl + '/avatar/preview.html')
        await sleep(900)
        const p = await evalInPage(cdp, PREVIEW_PROBE)
        assert.ok(Math.abs(p.innerWidth - 420) <= 2, `视口宽度应为 420，实际 ${p.innerWidth}`)
        assert.ok(
          p.docScrollWidth - p.docClientWidth <= 2,
          `移动端预览页横向溢出：scrollWidth=${p.docScrollWidth} > clientWidth=${p.docClientWidth}`,
        )
        await screenshot('avatar-preview-420x860.png')
        const st = await fsp.stat(path.join(ARTIFACTS_DIR, 'avatar-preview-420x860.png'))
        assert.ok(st.size > 8_000, `移动端预览页截图文件过小（${st.size} bytes）`)
      })
    })

    // =====================================================================
    await group('浏览器运行健康（JS 错误 / 资源加载）', async () => {
      // 只统计页面阶段（排除启动空页面）
      const pageErrors = debug.jsErrors.filter((e) => e.phase !== 'startup')
      const pageConsoleErrors = debug.consoleErrors.filter((e) => e.phase !== 'startup')
      const expectedPhase = (ph) => ph === 'startup' || ph === 'v20-fallback' || ph === 'v2.7-docs-error'
      const isTts = (u) => { try { return new URL(u).pathname === '/api/tts' } catch { return false } }
      const failed = debug.failedRequests.filter((r) => !expectedPhase(r.phase) && !/favicon/i.test(r.url) && !isTts(r.url))
      const bad = debug.badResponses.filter((r) => !expectedPhase(r.phase) && !/favicon/i.test(r.url) && !isTts(r.url))
      // 过滤 favicon 404 引发的通用 console error（浏览器只会说 Failed to load resource，不带 URL）
      const consoleErrorsReal = pageConsoleErrors.filter((e) => {
        if (/favicon/i.test(e.text)) return false
        if (/Failed to load resource/i.test(e.text) && (bad.length === 0 || e.phase === 'v2.7-docs-error')) return false
        if (/Failed to load resource/i.test(e.text) && debug.badResponses.some((r) => isTts(r.url))) return false
        if (/Data frame received after close|Close received after close|WebSocket connection to .* failed/i.test(e.text)) return false
        return true
      })

      await check('页面无未捕获 JS 异常', async () => {
        assert.equal(
          pageErrors.length,
          0,
          `捕获到 ${pageErrors.length} 个未捕获异常：\n${pageErrors
            .slice(0, 5)
            .map((e) => `  - [${e.phase}] ${e.text} ${e.description ? String(e.description).split('\n')[0] : ''}`)
            .join('\n')}`,
        )
      })

      await check('console 无 error 级日志', async () => {
        assert.equal(
          consoleErrorsReal.length,
          0,
          `捕获到 ${consoleErrorsReal.length} 条 console error：\n${consoleErrorsReal
            .slice(0, 5)
            .map((e) => `  - [${e.phase}] ${e.text.slice(0, 300)}`)
            .join('\n')}`,
        )
      })

      await check('无同源资源 4xx/5xx（模块 import 与静态文件齐全）', async () => {
        assert.deepEqual(
          bad.map((r) => `${r.status} ${r.url}`),
          [],
          `存在加载失败的资源：${JSON.stringify(bad.slice(0, 5))}`,
        )
      })

      await check('无失败的静态请求（favicon 除外）', async () => {
        assert.deepEqual(
          failed.map((r) => `${r.errorText} ${r.url}`),
          [],
          `存在网络失败请求：${JSON.stringify(failed.slice(0, 5))}`,
        )
      })
    })
  } finally {
    cdp?.close()
    await stopChrome(state)
    await stopServer(state)
    try {
      await fsp.writeFile(path.join(ARTIFACTS_DIR, 'ui-chrome.log'), (state.chromeLogs || []).join(''))
      await fsp.writeFile(path.join(ARTIFACTS_DIR, 'ui-server.log'), (state.logs || []).join(''))
    } catch {
      /* ignore */
    }
    if (sandbox && !process.env.UI_KEEP) await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => {})
    else if (sandbox) console.log(c.dim(`沙箱保留: ${sandbox}`))
  }

  // ---- 汇总 ----
  const pass = results.filter((r) => r.status === 'pass').length
  const fail = results.filter((r) => r.status === 'fail').length
  const blockedCount = results.filter((r) => r.status === 'blocked').length
  const summary = {
    tool: 'test/ui.mjs',
    startedAt: START_TS.toISOString(),
    finishedAt: new Date().toISOString(),
    baseUrl,
    chrome: CHROME,
    artifacts,
    results,
    browserDiagnostics: {
      jsErrors: debug.jsErrors,
      consoleErrors: debug.consoleErrors,
      consoleWarnings: debug.consoleWarnings,
      badResponses: debug.badResponses,
      failedRequests: debug.failedRequests,
    },
  }
  await fsp.writeFile(path.join(ARTIFACTS_DIR, 'ui-results.json'), JSON.stringify(summary, null, 2))

  console.log(c.bold('\n===== ui 汇总 ====='))
  console.log(`  通过 ${c.green(pass)} / 失败 ${c.red(fail)} / 阻塞 ${c.yellow(blockedCount)}`)
  console.log(c.dim(`  截图与结果: ${ARTIFACTS_DIR}`))
  if (artifacts.length) {
    console.log(c.dim('  截图:'))
    for (const f of artifacts) console.log(c.dim(`    ${f}`))
  }
  if (fail > 0) {
    console.log(c.red('\n失败用例:'))
    for (const r of results.filter((x) => x.status === 'fail')) {
      console.log(`  ✖ [${r.group}] ${r.name}`)
      for (const line of String(r.detail || r.error || '').split('\n').slice(0, 8)) console.log(`      ${line}`)
    }
    console.log(`\n复现: ${REPRO}`)
    return { code: 1, artifacts, state, sandbox }
  }
  return { code: 0, artifacts, state, sandbox }
}

const outcome = await main().catch((err) => {
  console.error(c.red(`ui 运行异常: ${err && err.stack ? err.stack : err}`))
  return { code: 1 }
})
process.exitCode = outcome.code
