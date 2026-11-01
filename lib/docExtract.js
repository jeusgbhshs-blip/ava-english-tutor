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

const execFileAsync = promisify(execFile);

export const MAX_TEXT_CHARS = 60_000;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.text', '.csv', '.json', '.log']);
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
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const minEocd = 22;
  if (buf.length < minEocd) throw new Error('不是有效的 ZIP 文件');
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 目录结构损坏');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      if (method === 0) entries.set(name, raw);
      else if (method === 8) entries.set(name, inflateRawSync(raw));
    } catch {
      /* 单个条目损坏不影响其它 */
    }
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
  const entries = readZip(buffer);
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
  const entries = readZip(buffer);
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

function decodePdfString(raw) {
  const s = raw.replace(/\\([nrtbf()\\]|[0-7]{1,3}|.)/g, (m, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    if (ch === 'b') return '\b';
    if (ch === 'f') return '\f';
    if (ch === '(' || ch === ')' || ch === '\\') return ch;
    if (/^[0-7]{1,3}$/.test(ch)) return String.fromCharCode(parseInt(ch, 8));
    return ch;
  });
  return s;
}

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
  let out = '';
  // 用顺序扫描：文本串（()Tj / []TJ / <>Tj）以及换行/定位算子
  const tokenRe = /\((?:\\[\s\S]|[^\\()])*\)\s*Tj|\[(?:[^\[\]]|\((?:\\[\s\S]|[^\\()])*\))*\]\s*TJ|<[0-9A-Fa-f\s]+>\s*Tj|T\*|\bTd\b|\bTD\b|\bET\b/g;
  let m;
  while ((m = tokenRe.exec(src))) {
    const token = m[0];
    if (token === 'T*' || token === 'Td' || token === 'TD' || token === 'ET') {
      out += '\n';
      continue;
    }
    if (token.endsWith('Tj')) {
      if (token.startsWith('(')) {
        const inner = token.slice(1, token.indexOf(') Tj') >= 0 ? token.indexOf(') Tj') : token.lastIndexOf(')'));
        out += decodePdfString(inner);
      } else if (token.startsWith('<')) {
        out += decodePdfHex(token.slice(1, token.lastIndexOf('>')));
      }
    } else if (token.endsWith('TJ')) {
      const inner = token.slice(1, token.lastIndexOf(']'));
      const strRe = /\((?:\\[\s\S]|[^\\()])*\)/g;
      let s;
      while ((s = strRe.exec(inner))) out += decodePdfString(s[0].slice(1, -1));
    }
  }
  return out;
}

/** 抽取 PDF 文本（best effort，扫描版会失败并提示） */
export function extractPdfText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const latin = buf.toString('latin1');
  const chunks = [];
  let cursor = 0;
  let guard = 0;
  while (guard++ < 4000) {
    const streamIdx = latin.indexOf('stream', cursor);
    if (streamIdx < 0) break;
    const dictStart = Math.max(0, streamIdx - 600);
    const dict = latin.slice(dictStart, streamIdx);
    if (/\/Subtype\s*\/Image|DCTDecode|JPXDecode|JBIG2Decode/i.test(dict)) {
      cursor = streamIdx + 6;
      continue;
    }
    let dataStart = streamIdx + 6;
    if (latin[dataStart] === '\r') dataStart += 1;
    if (latin[dataStart] === '\n') dataStart += 1;
    const endIdx = latin.indexOf('endstream', dataStart);
    if (endIdx < 0) break;
    let data = buf.subarray(dataStart, endIdx);
    cursor = endIdx + 9;
    const isFlate = /\/FlateDecode/i.test(dict);
    try {
      if (isFlate) {
        try {
          data = inflateSync(data);
        } catch {
          try {
            data = inflateRawSync(data);
          } catch {
            continue;
          }
        }
      }
      chunks.push(data);
    } catch {
      /* 跳过损坏流 */
    }
  }
  const text = chunks.map((c) => extractPdfContentText(c)).join('\n');
  return cleanText(
    text
      .replace(/\u0000/g, '')
      .replace(/[^\S\n]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n'),
  );
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
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('文件太大（最大 12MB）');
  const ext = extOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`暂不支持 ${ext || '该'} 格式，支持：txt / md / csv / doc / docx / rtf / pptx / pdf / png / jpg / webp`);
  }
  const kind = fileKind(filename);
  const warnings = [];
  let rawText = '';

  if (TEXT_EXT.has(ext)) {
    const decoded = buffer.toString('utf8');
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
    rawText = extractPdfText(buffer);
    if (!usefulText(rawText).ok) {
      throw new Error('这份 PDF 没有可提取的文字（可能是扫描版）。可以上传它的截图（图片）或 txt/docx 版本。');
    }
    warnings.push('PDF 为自动抽取，排版可能不完整（表格/分栏内容可能乱序）。');
  } else if (TEXTUTIL_EXT.has(ext)) {
    if (process.platform === 'darwin') {
      try {
        rawText = await runTextutil(buffer, ext);
      } catch {
        rawText = '';
      }
    }
    if (!rawText && (ext === '.docx' || ext === '.doc')) rawText = extractDocxZipText(buffer);
  }

  const useful = usefulText(rawText);
  if (!useful.ok) throw new Error(useful.reason || '没有提取到可用的英文内容');
  let text = useful.text;
  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
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
    originalChars: useful.text.length,
    name: basename(String(filename || 'document')),
  };
}

export default { extractText, isSupportedFile, fileKind, extOf, SUPPORTED_EXTENSIONS, readZip, extractPptxText, extractDocxZipText, extractPdfText, extractPdfContentText, ocrImage };
