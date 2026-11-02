import { apiFetch, configureBackend, isNativeApp, normalizeBackendOrigin } from './backend.js'
import { installScopedStorage } from './scoped-storage.js'

const native = isNativeApp()
const entry = new URL(import.meta.url).searchParams.get('entry') || 'mobile'
const sessionKey = 'ava.connection.v1'
let connection = null
let panelOpen = false
let appStarted = false
const secureStore = native
  ? globalThis.Capacitor?.registerPlugin?.('AvaSecureStore') || globalThis.Capacitor?.Plugins?.AvaSecureStore
  : null

function applyConnection(value) {
  configureBackend({ origin: value?.origin || '', token: value?.token || '', allowLocalHttp: !native })
}

async function savedConnection() {
  if (native) {
    if (!secureStore) throw new Error('应用安全存储尚未就绪，请重新打开应用')
    const result = await secureStore.load()
    return result.connection || null
  }
  try { return JSON.parse(sessionStorage.getItem(sessionKey) || 'null') } catch { return null }
}

async function persist(value) {
  if (native) await secureStore.save({ connection: value })
  else sessionStorage.setItem(sessionKey, JSON.stringify(value))
}

async function verifyConnection(candidate = null) {
  const request = candidate ? (path, options) => fetch(candidate.origin + path, { ...options, headers: { Authorization: `Bearer ${candidate.token}` }, redirect: 'error' }) : apiFetch
  const result = await request('/api/health', { signal: AbortSignal.timeout(15000), cache: 'no-store' })
  if (!result.ok) throw new Error(result.status === 401 ? '访问码不正确，请重新输入' : `服务暂不可用（${result.status}）`)
  const data = await result.json()
  if (data.ok !== true) throw new Error('这个地址没有返回有效的 Ava 服务')
}

function connectionPanel({ required = false, message = '' } = {}) {
  if (panelOpen) return Promise.resolve(false)
  panelOpen = true
  return new Promise(resolve => {
    const panel = document.createElement('dialog')
    panel.className = 'ava-connection-dialog'
    panel.setAttribute('aria-labelledby', 'ava-connection-title')
    panel.innerHTML = `
      <form class="ava-connection-form">
        <div class="ava-connection-brand" aria-hidden="true">A</div>
        <h1 id="ava-connection-title">连接你的 Ava</h1>
        <p>连接学习空间，继续课程、资料带读和语音练习。</p>
        <label>服务地址<input name="origin" type="url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://ava.example.com" required></label>
        <label>访问码<input name="token" type="password" autocomplete="current-password" spellcheck="false" required></label>
        <p class="ava-connection-note">语音练习会将麦克风音频发送给豆包（火山引擎）。你提交的文字和资料会由所连接的 Ava 服务及其配置的 AI 服务处理。</p>
        <label class="ava-connection-consent"><input name="consent" type="checkbox" required><span>我了解并同意上述数据处理方式。<a href="./privacy.html">查看数据说明</a></span></label>
        <p class="ava-connection-error" role="status" aria-live="polite"></p>
        <button class="ava-connection-submit" type="submit">连接并开始</button>
        ${required ? '' : '<button class="ava-connection-cancel" type="button">取消</button>'}
        ${native && connection ? '<button class="ava-connection-disconnect" type="button">断开连接</button><p class="ava-connection-note">仅移除本机保存的访问码，不删除学习记录或服务端资料。</p>' : ''}
      </form>`
    const form = panel.querySelector('form')
    const originField = form.elements.origin
    const tokenField = form.elements.token
    const consent = form.elements.consent
    const error = panel.querySelector('[role=status]')
    const submit = panel.querySelector('[type=submit]')
    const cancel = panel.querySelector('.ava-connection-cancel')
    const disconnect = panel.querySelector('.ava-connection-disconnect')
    const setBusy = busy => {
      submit.disabled = busy
      if (cancel) cancel.disabled = busy
      if (disconnect) disconnect.disabled = busy
    }
    originField.value = connection?.origin || globalThis.AVA_APP_CONFIG?.backendUrl || (native ? '' : location.origin)
    tokenField.value = connection?.token || ''
    consent.checked = connection?.consentVersion === 1
    error.textContent = message
    if (!native) { originField.readOnly = true; originField.value = location.origin }
    const close = success => {
      panel.close()
      panel.remove()
      panelOpen = false
      resolve(success)
    }
    panel.addEventListener('cancel', event => {
      event.preventDefault()
      if (!required && !submit.disabled) close(false)
    })
    cancel?.addEventListener('click', () => { if (!submit.disabled) close(false) })
    disconnect?.addEventListener('click', async () => {
      if (submit.disabled) return
      setBusy(true)
      error.textContent = '正在断开连接…'
      try {
        await secureStore.clear()
        connection = null
        applyConnection(null)
        tokenField.value = ''
        close(false)
        location.reload()
      } catch (err) {
        error.textContent = err?.message || '无法移除访问码，请重试'
      } finally { setBusy(false) }
    })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (submit.disabled || !form.reportValidity()) return
      setBusy(true)
      error.textContent = '正在连接…'
      try {
        const origin = normalizeBackendOrigin(originField.value, { allowLocalHttp: !native })
        const token = tokenField.value.trim()
        if (token.length < 32) throw new Error('请输入完整的访问码（至少 32 个字符）')
        const next = { origin, token, consentVersion: 1 }
        await verifyConnection(next)
        await persist(next)
        connection = next
        // Existing modules and their pagehide saves still belong to the old service.
        // The reloaded page applies the new backend and storage namespace together.
        if (!appStarted) applyConnection(next)
        tokenField.value = ''
        close(true)
      } catch (err) {
        if (!appStarted) applyConnection(connection)
        error.textContent = err?.name === 'TimeoutError' ? '连接超时，请检查网络与服务地址' : (err?.message || '连接失败，请稍后重试')
      } finally { setBusy(false) }
    })
    document.body.append(panel)
    panel.showModal()
  })
}

async function start() {
  let initialError = ''
  try { connection = await savedConnection(); applyConnection(connection) }
  catch (err) { connection = null; initialError = err.message }
  if (native) {
    if (connection?.consentVersion === 1) {
      try { await verifyConnection() } catch (err) { initialError = err.message }
    }
    if (!connection || connection.consentVersion !== 1 || initialError) {
      if (!await connectionPanel({ required: true, message: initialError })) return
    }
  } else {
    const result = await fetch('/api/access/status', { signal: AbortSignal.timeout(10000), cache: 'no-store' })
    if (!result.ok) throw new Error('无法连接 Ava 服务，请重新打开页面')
    const status = await result.json()
    if (status.authenticationRequired) {
      try { await verifyConnection() } catch (err) { await connectionPanel({ required: true, message: connection ? err.message : '' }) }
    }
  }
  if (native) installScopedStorage(window, connection.origin)
  document.addEventListener('click', async event => {
    if (native) {
      const link = event.target.closest('a[href]')
      if (link) {
        const target = new URL(link.href, location.href)
        if (target.origin === location.origin && target.pathname === '/' && target.searchParams.get('settings') === '1') {
          event.preventDefault(); location.href = './settings.html?settings=1'; return
        }
      }
    }
    if (!event.target.closest('[data-ava-connection]')) return
    event.preventDefault()
    if (await connectionPanel()) location.reload()
  })
  // The packaged app contains both entries; the web server continues to use its routes.
  appStarted = true
  if (entry === 'settings') await import('./main.js')
  else await import('./mobile/app.js')
}

start().catch(error => {
  const panel = document.createElement('div')
  panel.className = 'ava-startup-error'
  const text = document.createElement('p')
  text.textContent = error?.message || '应用暂时无法启动'
  const retry = document.createElement('button')
  retry.textContent = '重新打开'
  retry.onclick = () => location.reload()
  panel.append(text, retry)
  document.body.append(panel)
})
