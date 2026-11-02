/**
 * 英文文档 / 图片文字提取（零第三方依赖）。
 * - txt / md / csv / json：直接 UTF-8
 * - doc / docx / rtf / odt / html：macOS 内置 textutil（跨平台降级：docx 用内置 zip+XML 解析）
 * - pptx：内置 ZIP 解析（Node zlib）+ 逐页 <a:t> 文本
 * - pdf：内置 FlateDecode 流解析 + 文本算子提取（扫描版会给出明确提示）
 * - png / jpg / webp / gif / bmp / heic：macOS 内置 Vision OCR（JXA，离线）
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { htmlTextOnly } from './htmlText.js';

const execFileAsync = promisify(execFile);

export const MAX_TEXT_CHARS = 60_000;
// Source files and extracted teaching text have separate limits. Large PDFs often
// contain images; accepting them must not imply unlimited text or decompression.
const configuredUploadMb = Number(process.env.AVA_MAX_UPLOAD_MB || 100);
export const MAX_UPLOAD_BYTES = Math.round((Number.isFinite(configuredUploadMb) && configuredUploadMb >= 1
  ? Math.min(configuredUploadMb, 500) : 100) * 1024 * 1024);
export const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.text', '.csv', '.tsv', '.json', '.log']);
const TEXTUTIL_EXT = new Set(['.doc', '.docx', '.rtf', '.odt', '.html', '.htm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif', '.tif', '.tiff']);
const PPTX_EXT = new Set(['.pptx', '.pptm']);
const PDF_EXT = new Set(['.pdf']);

export const SUPPORTED_EXTENSIONS = [...TEXT_EXT, ...TEXTUTIL_EXT, ...IMAGE_EXT, ...PPTX_EXT, ...PDF_EXT];

export function extOf(filename) {
  return extname(String(filename || '')).toLowerCase();
}

export function isSupportedFile(filename) {
  return SUPPORTED_EXTENSIONS.includes(extOf(filename));
}

export function fileKind(filename) {
  const ext = extOf(filename);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (PPTX_EXT.has(ext)) return 'slides';
  if (PDF_EXT.has(ext)) return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  if (TEXTUTIL_EXT.has(ext)) return 'doc';
  return 'unknown';
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim();
}

export function usefulText(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return { ok: false, reason: '没有提取到文字内容' };
  const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
  // 中文材料同样有效（知识库允许中英文混合）
  const cjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const printable = (cleaned.match(/[\p{L}\p{N}\p{P}\s]/gu) || []).length;
  if (letters < 20 && cjk < 40) return { ok: false, reason: '提取到的文字内容太少（可能是扫描版/纯图片，或内容非常短）' };
  if (printable / Math.max(1, cleaned.length) < 0.7) return { ok: false, reason: '提取到的内容乱码太多' };
  return { ok: true, text: cleaned };
}

/* ------------------------------- ZIP 解析 ------------------------------- */

/** 极简 ZIP 读取：返回 Map<name, Buffer>（支持 stored / deflate） */
export function readZip(buffer, { accept = () => true } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new Error('不是有效的 ZIP 文件');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 目录结构损坏');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const directorySize = buf.readUInt32LE(eocd + 12);
  let offset = buf.readUInt32LE(eocd + 16);
  const directoryEnd = offset + directorySize;
  if (entryCount > 10000 || entryCount === 65535 || directoryEnd > eocd || buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('压缩文档结构过大或格式不受支持，请拆分或转为 PDF/TXT');
  }
  const entries = new Map();
  let totalBytes = 0;
  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > directoryEnd || buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 目录结构损坏');
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    if (offset + 46 + nameLen + extraLen + commentLen > directoryEnd) throw new Error('ZIP 文件目录不完整');
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    // Never inflate embedded pictures/media when only document XML is needed.
    if (!accept(name)) continue;
    if (flags & 1) throw new Error('暂不支持加密文档，请解除密码后上传');
    if (size > MAX_ARCHIVE_ENTRY_BYTES || totalBytes + size > MAX_EXTRACTED_BYTES) throw new Error('文档解压后的内容过大，请拆分文件后上传');
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 文件条目损坏');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error('ZIP 文件内容不完整');
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let decoded;
    if (method === 0) decoded = raw;
    else if (method === 8) {
      try {
        decoded = inflateRawSync(raw, { maxOutputLength: Math.min(size + 1, MAX_ARCHIVE_ENTRY_BYTES + 1) });
      } catch {
        throw new Error('文档无法安全解压（内容损坏或解压后过大）');
      }
    } else throw new Error('文档使用了不支持的压缩方式，请转为 PDF/TXT');
    if (decoded.length !== size) throw new Error('ZIP 文件大小校验失败');
    totalBytes += decoded.length;
    entries.set(name, decoded);
  }
  return entries;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** docx：从 ZIP 内的 word/document.xml 提取正文（textutil 不可用时兜底） */
export function extractDocxZipText(buffer) {
  const entries = readZip(buffer, { accept: (name) => name === 'word/document.xml' });
  const xml = entries.get('word/document.xml');
  if (!xml) throw new Error('docx 中找不到正文（不是有效的 Word 文档）');
  const text = decodeXmlEntities(
    xml
      .toString('utf8')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n'),
  );
  return cleanText(text);
}

/** pptx：逐页提取 <a:t> 文本 */
export function extractPptxText(buffer) {
  const entries = readZip(buffer, { accept: (name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name) });
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/i)?.[1] || 0);
      const nb = Number(b.match(/slide(\d+)\.xml$/i)?.[1] || 0);
      return na - nb;
    });
  if (!slides.length) throw new Error('pptx 中没有找到幻灯片文字');
  const pages = [];
  for (const name of slides) {
    const xml = entries.get(name).toString('utf8');
    const pieces = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const text = cleanText(pieces.join('\n'));
    if (text) pages.push(text);
  }
  return pages.join('\n\n');
}

/* ------------------------------- PDF 解析 ------------------------------- */


function decodePdfHex(hex) {
  let h = String(hex || '').replace(/\s+/g, '');
  if (h.length % 2) h += '0';
  const bytes = Buffer.from(h, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
    return out;
  }
  return bytes.toString('latin1');
}

/** 从 PDF 内容流中提取文本操作符 */
export function extractPdfContentText(content) {
  const src = Buffer.isBuffer(content) ? content.toString('latin1') : String(content);
  const limit = MAX_TEXT_CHARS + 1;
  let out = '';
  let value = '';
  let arrayValue = '';
  let arrayDepth = 0;
  const append = (text) => { out += text.slice(0, Math.max(0, limit - out.length)); };
  const addValue = (text) => {
    if (arrayDepth) arrayValue += text.slice(0, Math.max(0, limit - arrayValue.length));
    else value = text;
  };
  // A linear scanner avoids pathological backtracking on damaged PDF arrays.
  for (let i = 0; i < src.length && out.length < limit;) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '%') { const end = src.indexOf('\n', i); i = end < 0 ? src.length : end + 1; continue; }
    if (ch === '(') {
      let text = '';
      let depth = 1;
      i++;
      while (i < src.length && depth) {
        let c = src[i++];
        if (c === '\\') {
          if (i >= src.length) break;
          c = src[i++];
          if (c === '\n') continue;
          if (c === '\r') { if (src[i] === '\n') i++; continue; }
          if (/[0-7]/.test(c)) {
            let octal = c;
            for (let n = 0; n < 2 && /[0-7]/.test(src[i] || 'x'); n++) octal += src[i++];
            c = String.fromCharCode(parseInt(octal, 8));
          } else c = ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] || c;
        } else if (c === '(') depth++;
        else if (c === ')') { depth--; if (!depth) break; }
        if (text.length < limit) text += c;
      }
      if (!depth) addValue(text);
      continue;
    }
    if (ch === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i + 1);
      if (end < 0) break;
      const hex = src.slice(i + 1, end);
      if (/^[0-9a-f\s]*$/i.test(hex)) addValue(decodePdfHex(hex.slice(0, limit * 4)));
      i = end + 1;
      continue;
    }
    if (ch === '[') { if (!arrayDepth) arrayValue = ''; arrayDepth++; i++; continue; }
    if (ch === ']') { if (arrayDepth && --arrayDepth === 0) value = arrayValue; i++; continue; }
    if (/[<>{}/]/.test(ch)) { value = ''; i++; continue; }
    let end = i + 1;
    while (end < src.length && !/[\s()[\]<>{}/%]/.test(src[end])) end++;
    const token = src.slice(i, end);
    i = end;
    if (arrayDepth) continue;
    if (token === 'Tj' || token === 'TJ') append(value);
    else if (token === "'" || token === '"') { append('\n'); append(value); }
    else if (['T*', 'Td', 'TD', 'ET'].includes(token)) append('\n');
    else if (/^[+-]?(?:\d*\.?\d+)$/.test(token)) continue;
    value = '';
  }
  return out;
}

/** 抽取 PDF 文本（best effort，扫描版会失败并提示） */
export function extractPdfText(buffer, { details = false } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!buf.subarray(0, 1024).includes('%PDF-')) throw new Error('不是有效的 PDF 文件');
  const pieces = [];
  let cursor = 0;
  let guard = 0;
  let extractedBytes = 0;
  let textChars = 0;
  while (guard++ < 10000) {
    const streamIdx = buf.indexOf('stream', cursor);
    if (streamIdx < 0) break;
    const objectStart = buf.lastIndexOf(' obj', streamIdx);
    const dictStart = Math.max(0, streamIdx - 64 * 1024, objectStart >= 0 ? objectStart + 4 : 0);
    const dict = buf.subarray(dictStart, streamIdx).toString('latin1');
    let dataStart = streamIdx + 6;
    if (buf[dataStart] === 13) dataStart += 1;
    if (buf[dataStart] === 10) dataStart += 1;
    const endIdx = buf.indexOf('endstream', dataStart);
    if (endIdx < 0) break;
    cursor = endIdx + 9;
    if (/\/Subtype\s*\/Image|DCTDecode|JPXDecode|JBIG2Decode/i.test(dict)) continue;
    let data = buf.subarray(dataStart, endIdx);
    if (/\/FlateDecode/i.test(dict)) {
      const options = { maxOutputLength: MAX_ARCHIVE_ENTRY_BYTES };
      try { data = inflateSync(data, options); }
      catch (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('PDF 解压后的单页内容过大，请拆分文件');
        try { data = inflateRawSync(data, options); }
        catch (rawErr) {
          if (rawErr.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('PDF 解压后的单页内容过大，请拆分文件');
          continue;
        }
      }
    } else if (data.length > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error('PDF 单页内容过大，请拆分文件');
    }
    extractedBytes += data.length;
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('PDF 解压后的内容过大，请拆分文件');
    const text = cleanText(extractPdfContentText(data).replace(/[^\S\n]{2,}/g, ' '));
    if (text) {
      pieces.push(text.slice(0, Math.max(0, MAX_TEXT_CHARS + 1 - textChars)));
      textChars += text.length + (pieces.length > 1 ? 1 : 0);
      if (textChars > MAX_TEXT_CHARS) break;
    }
  }
  if (guard > 10000 && buf.indexOf('stream', cursor) >= 0) throw new Error('PDF 包含过多内容段，请拆分文件后上传');
  const text = cleanText(pieces.join('\n').replace(/\u0000/g, '').replace(/[^\S\n]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n'));
  return details ? { text, truncated: textChars > MAX_TEXT_CHARS } : text;
}

/** ODT has a standard content.xml body and can be read on Linux as well. */
export function extractOdtText(buffer) {
  const xml = readZip(buffer, { accept: (name) => name === 'content.xml' }).get('content.xml');
  if (!xml) throw new Error('ODT 中找不到正文');
  return cleanText(decodeXmlEntities(xml.toString('utf8')
    .replace(/<text:tab\b[^>]*\/>/g, '\t')
    .replace(/<text:line-break\b[^>]*\/>/g, '\n')
    .replace(/<\/text:(?:p|h)>/g, '\n')
    .replace(/<[^>]+>/g, '')));
}

export function extractHtmlText(buffer) {
  return cleanText(htmlTextOnly(buffer.toString('utf8')));
}

/* ---------------------------- textutil / OCR ---------------------------- */

async function runTextutil(buffer, ext) {
  const dir = mkdtempSync(join(tmpdir(), 'ava-doc-'));
  const file = join(dir, `input${ext}`);
  try {
    writeFileSync(file, buffer);
    const { stdout } = await execFileAsync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', '-encoding', 'UTF-8', file], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
    });
    return cleanText(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildOcrScript(imagePath) {
  return `
ObjC.import('Foundation');
ObjC.import('Vision');
ObjC.import('AppKit');
const path = ${JSON.stringify(imagePath)};
const url = $.NSURL.fileURLWithPath(path);
const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $());
const request = $.VNRecognizeTextRequest.alloc.init;
request.recognitionLevel = 1;
request.usesLanguageCorrection = true;
handler.performRequestsError($([request]), $());
const results = request.results;
const lines = [];
for (let i = 0; i < results.count; i++) {
  const candidates = results.objectAtIndex(i).topCandidates(1);
  if (candidates.count > 0) lines.push(ObjC.unwrap(candidates.objectAtIndex(0).string));
}
console.log(JSON.stringify(lines));
`;
}

/** macOS Vision OCR（离线，零依赖） */
export async function ocrImage(buffer, filename = 'image.png') {
  const ext = IMAGE_EXT.has(extOf(filename)) ? extOf(filename) : '.png';
  const dir = mkdtempSync(join(tmpdir(), 'ava-ocr-'));
  const file = join(dir, `image${ext}`);
  const script = join(dir, 'ocr.jxa');
  try {
    writeFileSync(file, buffer);
    writeFileSync(script, buildOcrScript(file), 'utf8');
    const { stdout, stderr } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', script], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 40_000,
    });
    // osascript 的 JXA console.log 输出到 stderr，这里合并处理
    const output = String(stdout || '').trim() || String(stderr || '').trim();
    let lines = null;
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) lines = parsed.map(String);
    } catch {
      /* 旧格式 / 非 JSON 输出 */
    }
    if (lines) return cleanText(lines.join('\n'));
    return cleanText(output);
  } catch (err) {
    throw new Error(`图片文字识别失败：${String(err?.stderr || err?.message || err).slice(0, 160)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* -------------------------------- 统一入口 -------------------------------- */

/**
 * 从上传文件提取文字。
 * @param {{filename:string, buffer:Buffer}} file
 * @returns {Promise<{text:string, kind:string, chars:number, truncated:boolean, warnings:string[]}>}
 */
export async function extractText({ filename, buffer }) {
  if (!buffer || !buffer.length) throw new Error('文件为空');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`文件太大（最大 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`);
  const ext = extOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`暂不支持 ${ext || '该'} 格式，支持：txt / md / csv / doc / docx / rtf / pptx / pdf / png / jpg / webp`);
  }
  const kind = fileKind(filename);
  const warnings = [];
  let rawText = '';
  let sourceTruncated = false;

  if (TEXT_EXT.has(ext)) {
    const maxTextBytes = (MAX_TEXT_CHARS + 1) * 4;
    sourceTruncated = buffer.length > maxTextBytes;
    const decoded = buffer.subarray(0, maxTextBytes).toString('utf8');
    if (decoded.includes('\uFFFD') && buffer.includes(0)) throw new Error('这不是文本文件，请上传英文文档或图片');
    rawText = cleanText(decoded.replace(/^\uFEFF/, ''));
  } else if (IMAGE_EXT.has(ext)) {
    if (process.platform !== 'darwin') throw new Error('图片 OCR 目前仅支持 macOS（使用系统 Vision 框架）');
    rawText = await ocrImage(buffer, filename);
    if (!rawText) throw new Error('图片里没有识别到英文文字，试试更清晰的截图或直接上传文档');
    warnings.push('文字来自图片 OCR，个别字符可能有误，建议核对原文。');
  } else if (PPTX_EXT.has(ext)) {
    rawText = extractPptxText(buffer);
  } else if (PDF_EXT.has(ext)) {
    const pdf = extractPdfText(buffer, { details: true });
    rawText = pdf.text;
    sourceTruncated = pdf.truncated;
    if (!usefulText(rawText).ok) {
      throw new Error('这份 PDF 没有可提取的文字（可能是扫描版）。可以上传它的截图（图片）或 txt/docx 版本。');
    }
    warnings.push('PDF 为自动抽取，排版可能不完整（表格/分栏内容可能乱序）。');
  } else if (ext === '.docx') {
    rawText = extractDocxZipText(buffer);
  } else if (ext === '.odt') {
    rawText = extractOdtText(buffer);
  } else if (ext === '.html' || ext === '.htm') {
    rawText = extractHtmlText(buffer.subarray(0, MAX_ARCHIVE_ENTRY_BYTES));
    sourceTruncated = buffer.length > MAX_ARCHIVE_ENTRY_BYTES;
  } else if (TEXTUTIL_EXT.has(ext)) {
    if (process.platform === 'darwin') {
      try {
        rawText = await runTextutil(buffer, ext);
      } catch {
        rawText = '';
      }
    }
    if (!rawText) throw new Error('此格式目前需要 macOS 文档转换，请转为 DOCX、ODT、PDF 或 TXT 后上传');
  }

  const useful = usefulText(rawText);
  if (!useful.ok) throw new Error(useful.reason || '没有提取到可用的英文内容');
  let text = useful.text;
  let truncated = false;
  if (text.length > MAX_TEXT_CHARS || sourceTruncated) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
    warnings.push(`内容较长，已截取前 ${Math.round(MAX_TEXT_CHARS / 1000)}k 字符用于讲解。`);
  }
  return {
    text,
    kind,
    chars: text.length,
    truncated,
    warnings,
    originalChars: sourceTruncated ? null : useful.text.length,
    name: basename(String(filename || 'document')),
  };
}

export default { extractText, isSupportedFile, fileKind, extOf, SUPPORTED_EXTENSIONS, readZip, extractPptxText, extractDocxZipText, extractPdfText, extractPdfContentText, ocrImage };
