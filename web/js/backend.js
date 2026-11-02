/** One backend boundary for the web app and the bundled iOS app.
 * Provider credentials never belong here. The optional access token authenticates
 * this installation to its private Ava server and is kept in native Keychain.
 */
let backendOrigin = ''
let accessToken = ''

export function isNativeApp() {
  return globalThis.Capacitor?.isNativePlatform?.() === true
}

export function normalizeBackendOrigin(value, { allowLocalHttp = false } = {}) {
  const url = new URL(String(value || '').trim())
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) {
    throw new Error('服务地址必须使用 HTTPS')
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('请填写服务根地址，例如 https://ava.example.com，不含路径或密码')
  }
  return url.origin
}

export function configureBackend({ origin = '', token = '', allowLocalHttp = false } = {}) {
  backendOrigin = origin ? normalizeBackendOrigin(origin, { allowLocalHttp }) : ''
  accessToken = String(token || '').trim()
}

export function getBackendOrigin() { return backendOrigin }

export function apiUrl(input) {
  const path = input instanceof URL ? input.href : String(input)
  if (/^https?:\/\//i.test(path)) return path
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('无效的服务请求路径')
  if (!backendOrigin && isNativeApp()) throw new Error('请先连接你的 Ava 服务')
  return backendOrigin + path
}

function isBackendUrl(url) {
  if (!backendOrigin) return url.startsWith('/') && !url.startsWith('//')
  try { return new URL(url).origin === backendOrigin } catch { return false }
}

export function getApiHeaders(path = '/api/') {
  return accessToken && isBackendUrl(apiUrl(path)) ? { Authorization: `Bearer ${accessToken}` } : {}
}

export function apiFetch(input, init = {}) {
  const url = apiUrl(input)
  const auth = getApiHeaders(url)
  const headers = new Headers(init.headers || {})
  for (const [key, value] of Object.entries(auth)) headers.set(key, value)
  // A server redirect must never forward installation credentials to another host.
  return globalThis.fetch(url, { ...init, headers, ...(auth.Authorization ? { redirect: 'error' } : {}) })
}

/** A string for existing same-origin callers; Promise<string> for ticketed access. */
export function apiWebSocketUrl(path) {
  const base = backendOrigin || globalThis.location?.href || globalThis.window?.location?.href || 'http://127.0.0.1'
  const url = new URL(path, base)
  if (!['http:', 'https:'].includes(url.protocol) || (backendOrigin && url.origin !== backendOrigin)) {
    throw new Error('无效的语音服务地址')
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (!accessToken) return url.href
  return (async () => {
    const response = await apiFetch('/api/access/ws-ticket', {
      method: 'POST', signal: AbortSignal.timeout(15000),
    })
    const data = await response.json()
    if (!response.ok || !data.ticket) throw new Error(data.error || '语音连接授权失败，请重新连接服务')
    url.searchParams.set('ticket', data.ticket)
    return url.href
  })()
}
