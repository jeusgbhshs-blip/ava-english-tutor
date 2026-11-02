/** Bounded, disk-spooled uploads. Raw File bodies avoid base64 copies on phones. */
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_UPLOAD_BYTES, MAX_TEXT_CHARS, SUPPORTED_EXTENSIONS, isSupportedFile } from './docExtract.js';

const LEGACY_UPLOAD_BYTES = 12 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
let activeUploads = 0;

function uploadError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function uploadCapabilities() {
  return {
    maxFileBytes: MAX_UPLOAD_BYTES,
    maxTextChars: MAX_TEXT_CHARS,
    extensions: SUPPORTED_EXTENSIONS,
    imageOcr: process.platform === 'darwin',
    binaryUpload: true,
  };
}

/** The caller owns the returned buffer; temporary disk files are always removed. */
export async function readBinaryUpload(req, { limit = MAX_UPLOAD_BYTES, timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw uploadError(`文件太大（最大 ${limit / 1024 / 1024}MB）`, 413);
  }
  const dir = await mkdtemp(join(tmpdir(), 'ava-upload-'));
  const path = join(dir, 'source');
  try {
    const size = await new Promise((resolve, reject) => {
      const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
      let received = 0;
      let settled = false;
      const timer = setTimeout(() => fail(uploadError('上传超时，请检查网络后重试', 408)), timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', fail);
        req.off('aborted', onAborted);
        output.off('drain', onDrain);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        output.destroy();
        req.resume();
        reject(err);
      };
      const onDrain = () => { if (!settled) req.resume(); };
      const onAborted = () => fail(uploadError('上传已取消', 400));
      const onData = (chunk) => {
        received += chunk.length;
        if (received > limit) return fail(uploadError(`文件太大（最大 ${limit / 1024 / 1024}MB）`, 413));
        if (!output.write(chunk)) req.pause();
      };
      const onEnd = () => output.end();
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', fail);
      req.on('aborted', onAborted);
      output.on('error', fail);
      output.on('drain', onDrain);
      output.on('finish', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(received);
      });
      if (req.aborted || req.destroyed) onAborted();
    });
    if (!size) throw uploadError('文件为空');
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Keep extraction serialized so several 100MB PDFs cannot exhaust server RAM. */
export async function withUploadedFile(req, url, readJsonBody, operation) {
  if (activeUploads >= 1) {
    req.resume();
    throw uploadError('正在处理另一份文件，请稍后重试', 429);
  }
  activeUploads += 1;
  try {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let name;
    let buffer;
    if (contentType === 'application/octet-stream') {
      name = String(url.searchParams.get('name') || '').trim();
      if (!name || name.length > 240 || /[\u0000-\u001f]/.test(name)) {
        req.resume();
        throw uploadError('请提供有效的文件名');
      }
      if (!isSupportedFile(name)) {
        req.resume();
        throw uploadError('暂不支持此文件格式，请转换为 PDF、DOCX 或 TXT');
      }
      buffer = await readBinaryUpload(req);
    } else {
      // The old desktop API remains compatible, with its original memory budget.
      const body = await readJsonBody(req, 20 * 1024 * 1024);
      name = typeof body.name === 'string' ? body.name : 'document';
      const encoded = typeof body.dataBase64 === 'string' ? body.dataBase64.replace(/^data:[^;]+;base64,/, '') : '';
      if (!encoded) throw uploadError('缺少文件内容（dataBase64）');
      if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) || !/^[^=]*={0,2}$/.test(encoded)) {
        throw uploadError('文件内容不是合法的 base64');
      }
      if (encoded.length > 4 * Math.ceil(LEGACY_UPLOAD_BYTES / 3)) {
        throw uploadError('旧版上传最大 12MB；请使用新版知识库页面上传大文件', 413);
      }
      buffer = Buffer.from(encoded, 'base64');
      if (!buffer.length) throw uploadError('文件为空');
    }
    return await operation({ name, buffer });
  } finally {
    activeUploads -= 1;
  }
}
