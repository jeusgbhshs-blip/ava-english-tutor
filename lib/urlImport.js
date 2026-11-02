/** Public webpage import with vetted/pinned DNS, bounded bodies and redirects. */
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const MAX_WEB_BYTES = 8 * 1024 * 1024;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

export function isPublicAddress(address) {
  const value = String(address || '');
  if (value.includes('%')) return false;
  const family = isIP(value);
  if (family === 4) {
    const [a, b, c] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  let normalized = value.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const octets = normalized.slice(lastColon + 1).split('.').map(Number);
    normalized = normalized.slice(0, lastColon + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':').map(x => parseInt(x, 16)) : [];
  const right = halves[1] ? halves[1].split(':').map(x => parseInt(x, 16)) : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
  if (words.length !== 8) return false;
  if (words.slice(0, 5).every(x => x === 0) && words[5] === 0xffff) {
    return isPublicAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  // Only global unicast; exclude translation/tunnel/documentation/benchmark ranges.
  if (words[0] < 0x2000 || words[0] >= 0x4000 || words[0] === 0x2002) return false;
  if (words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) return false;
  if (words[0] === 0x3fff && words[1] < 0x1000) return false;
  return true;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('网页抓取超时，请稍后重试'), { code: 'ETIMEDOUT' }));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function validatePublicUrl(input, {
  lookup = dnsLookup,
  allowPrivate = process.env.AVA_ALLOW_PRIVATE_URL_IMPORT === '1',
  signal,
} = {}) {
  let url;
  try { url = new URL(String(input || '').trim()); }
  catch { throw new Error('网页链接格式不对（需要 http/https 开头）'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持不含用户名和密码的 http/https 网页链接');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  let addresses;
  try {
    const resolved = literalFamily ? Promise.resolve([{ address: hostname, family: literalFamily }]) : lookup(hostname, { all: true, verbatim: true });
    addresses = signal ? await abortable(Promise.resolve(resolved), signal) : await resolved;
  } catch (error) {
    if (error.code === 'ETIMEDOUT') throw error;
    throw new Error('网页地址无法解析，请检查链接后重试');
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isIP(item.address) || (!allowPrivate && !isPublicAddress(item.address)))) {
    throw new Error('仅支持公开网页，不能导入本机、内网或保留网络地址');
  }
  return { url, address: addresses[0] };
}

function requestPage(url, address, { signal, maxBytes, requestImpl }) {
  return new Promise((resolve, reject) => {
    const request = requestImpl || (url.protocol === 'https:' ? https.request : http.request);
    // Keep hostname/SNI and Host intact while preventing a second DNS lookup.
    const pinnedLookup = (_hostname, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };
    const req = request(url, {
      method: 'GET', signal, family: address.family, lookup: pinnedLookup,
      headers: {
        'user-agent': 'Ava-English-Tutor/1.0 (document import)',
        accept: 'text/html,application/xhtml+xml,text/plain',
        'accept-encoding': 'identity',
      },
    });
    req.on('error', reject);
    req.on('response', res => {
      const status = res.statusCode || 0;
      if (REDIRECT_CODES.has(status)) {
        const location = res.headers.location;
        res.destroy();
        if (!location) return reject(new Error('网页重定向缺少目标地址'));
        return resolve({ redirect: location });
      }
      if (status < 200 || status >= 300) { res.destroy(); return reject(new Error(`网页抓取失败（HTTP ${status}）`)); }
      const rawType = String(res.headers['content-type'] || '');
      const contentType = rawType.split(';')[0].trim().toLowerCase();
      if (!TEXT_TYPES.has(contentType)) { res.destroy(); return reject(new Error('此链接不是可导入的 HTML 或文本网页，请使用文件上传')); }
      const encoding = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
      if (encoding && encoding !== 'identity') { res.destroy(); return reject(new Error('此网页返回了不支持的压缩内容，请下载文件后上传')); }
      const announcedSize = Number(res.headers['content-length']);
      if (Number.isFinite(announcedSize) && announcedSize > maxBytes) { res.destroy(); return reject(new Error(`网页内容太大（最大 ${Math.round(maxBytes / 1024 / 1024)}MB），请使用文件上传`)); }
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { res.destroy(); reject(new Error('网页内容太大，请使用文件上传')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('网页传输中断，请稍后重试')));
      res.on('end', () => {
        const charset = rawType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || 'utf-8';
        try {
          const text = new TextDecoder(charset).decode(Buffer.concat(chunks, bytes));
          resolve({ html: text, url: url.toString() });
        } catch { reject(new Error('网页字符编码暂不支持，请下载为 UTF-8 文本后上传')); }
      });
    });
    req.end();
  });
}

export async function fetchPublicHtml(input, {
  maxBytes = MAX_WEB_BYTES,
  timeoutMs = 30000,
  maxRedirects = 5,
  lookup = dnsLookup,
  requestImpl,
  allowPrivate = process.env.AVA_ALLOW_PRIVATE_URL_IMPORT === '1',
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let current = input;
  try {
    for (let count = 0; count <= maxRedirects; count++) {
      const { url, address } = await validatePublicUrl(current, { lookup, allowPrivate, signal: controller.signal });
      const result = await abortable(requestPage(url, address, { signal: controller.signal, maxBytes, requestImpl }), controller.signal);
      if (!result.redirect) return result;
      try { current = new URL(result.redirect, url).toString(); }
      catch { throw new Error('网页重定向地址无效'); }
    }
    throw new Error('网页重定向次数过多，请使用最终页面地址');
  } catch (error) {
    if (controller.signal.aborted || error.code === 'ETIMEDOUT' || error.name === 'AbortError') throw new Error('网页抓取超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
