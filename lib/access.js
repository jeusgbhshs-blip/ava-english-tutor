import { timingSafeEqual, randomBytes } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertSafeBinding(host, token, allowInsecureLan = false) {
  if (!LOOPBACK.has(host) && !token && !allowInsecureLan) {
    throw new Error('远程访问需要设置 AVA_ACCESS_TOKEN（至少 32 个字符）。仅本机使用请保持 --host 127.0.0.1。');
  }
  if (token && token.length < 32) throw new Error('AVA_ACCESS_TOKEN 至少需要 32 个字符。');
}

/** Private single-user deployment boundary; deliberately not a multi-user account system. */
export function createAccessControl({
  token = process.env.AVA_ACCESS_TOKEN || '',
  allowedOrigins = (process.env.AVA_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  now = Date.now,
  allowInsecureLan = process.env.AVA_ALLOW_INSECURE_LAN === '1',
} = {}) {
  const expected = Buffer.from(token);
  const allowed = new Set(allowedOrigins);
  if (token) allowed.add('capacitor://localhost');
  const tickets = new Map();
  const ticketLifetimeMs = 30000;

  function originAllowed(req) {
    if (!token && !allowInsecureLan) {
      try {
        const host = new URL(`http://${req.headers.host || ''}`).hostname;
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
      } catch { return false; }
    }
    const origin = req.headers.origin;
    if (!origin) return true; // Native/non-browser clients are still authenticated.
    if (allowed.has(origin)) return true;
    try {
      const url = new URL(origin);
      return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host;
    } catch { return false; }
  }

  function authenticated(req) {
    if (!token) return true;
    const value = String(req.headers.authorization || '');
    if (!value.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(value.slice(7));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  function json(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function prune() {
    for (const [key, value] of tickets) if (value.expires <= now()) tickets.delete(key);
  }

  function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;
    if (!originAllowed(req)) {
      json(res, 403, { ok: false, error: '此来源未获准连接 Ava 服务' });
      return true;
    }
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
      if (!methods.includes(req.headers['access-control-request-method'] || 'GET') || requestedHeaders.some(h => !['authorization', 'content-type', 'accept'].includes(h))) {
        json(res, 403, { ok: false, error: '不支持的跨域请求' });
        return true;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Methods': methods.join(', '),
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return true;
    }
    if (url.pathname === '/api/access/status' && req.method === 'GET') {
      json(res, 200, { ok: true, authenticationRequired: !!token });
      return true;
    }
    if (!authenticated(req)) {
      json(res, 401, { ok: false, error: '请连接服务并输入有效的访问码' });
      return true;
    }
    if (url.pathname === '/api/access/ws-ticket' && req.method === 'POST') {
      prune();
      if (tickets.size >= 1000) {
        json(res, 429, { ok: false, error: '连接请求过多，请稍后重试' });
        return true;
      }
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { expires: now() + ticketLifetimeMs, origin: origin || '' });
      json(res, 200, { ok: true, ticket, expiresIn: 30 });
      return true;
    }
    return false;
  }

  function authorizeWebSocket(req) {
    if (!originAllowed(req)) return false;
    if (!token) return true;
    // Long-lived bearer tokens are never accepted in a query string.
    let value;
    try { value = new URL(req.url, 'http://localhost').searchParams.get('ticket'); } catch { return false; }
    prune();
    const ticket = tickets.get(value);
    if (!ticket || ticket.origin !== (req.headers.origin || '')) return false;
    tickets.delete(value);
    return true;
  }
  return { handle, authorizeWebSocket, authenticationRequired: !!token };
}
