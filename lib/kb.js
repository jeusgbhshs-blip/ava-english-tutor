/**
 * 本地个人知识库：文档存储、切块、BM25 检索、DeepSeek 语义扩展/重排/增强。
 * 数据只在本机 data/kb/ 下，不上传任何第三方（除模型 API 调用外）。
 */
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readJsonFile, writeJsonFile } from './config.js';
import { extractText, MAX_TEXT_CHARS } from './docExtract.js';
import { chatJSON } from './llmJson.js';
import {
  buildKBEnrichMessages,
  buildKBQueryMessages,
  buildKBRerankMessages,
} from '../content/prompts.js';

export const KB_DIR = join(DATA_DIR, 'kb');
export const KB_INDEX_PATH = join(KB_DIR, 'index.json');
export const MAX_KB_DOCS = 200;
const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 0; // 资料按原文展示/教学，不能有重叠尾巴（否则会重复读同一句）
const enrichmentJobs = new Map();

function ensureKbDir() {
  if (!existsSync(KB_DIR)) {
    try {
      writeJsonFile(KB_INDEX_PATH, { docs: [] });
    } catch {
      /* ignore */
    }
  }
}

/** 中文/英文/混合 */
export function detectLang(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[a-zA-Z]/g) || []).length;
  if (cjk > latin * 0.6) return 'zh';
  if (latin > cjk * 2) return 'en';
  return cjk || latin ? 'mixed' : 'unknown';
}

/** 简易 HTML 实体解码 */
export function decodeEntities(html) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(html || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, k) => map[k.toLowerCase()] ?? m);
}

/** HTML → 正文（去掉脚本/样式/标签） */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 切块：段落优先，约 size 字，重叠 overlap */
export function chunkText(text, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  if (!clean) return [];
  // 把段内单换行还原成空格；否则 PDF/粘贴/OCR 的换行会把单词粘在一起（somethingabout）
  const paras = clean
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const tail = (s) => (overlap > 0 ? s.slice(-Math.min(overlap, Math.floor(s.length * 0.25))) : '');
  const chunks = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = '';
  };
  for (const para of paras) {
    if (para.length > size * 2) {
      const sentences = para.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [para];
      for (const sent of sentences) {
        if (buf.length + sent.length > size) {
          const carry = tail(buf);
          flush();
          buf = carry + sent;
        } else {
          buf += sent;
        }
      }
    } else if (buf.length + para.length + 2 > size) {
      const carry = tail(buf);
      flush();
      buf = carry + para;
    } else {
      buf += (buf ? '\n\n' : '') + para;
    }
  }
  flush();
  return chunks.map((t, i) => ({ id: `c${i + 1}`, text: t })).slice(0, 120);
}

/** 中英混合分词（英文词 + 中文 bigram） */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const latin = s.match(/[a-z][a-z0-9'-]{1,}/g) || [];
  const runs = s.match(/[\u4e00-\u9fff]+/g) || [];
  const cjk = [];
  for (const run of runs) {
    if (run.length === 1) cjk.push(run);
    else for (let i = 0; i < run.length - 1; i += 1) cjk.push(run.slice(i, i + 2));
  }
  return [...latin, ...cjk];
}

function ensureKbIndex() {
  ensureKbDir();
  const idx = readJsonFile(KB_INDEX_PATH, { docs: [] });
  if (!Array.isArray(idx.docs)) idx.docs = [];
  return idx;
}

export function listDocuments() {
  const idx = ensureKbIndex();
  // Older versions left documents pending even when no job was ever started.
  // A restarted process also has no active job for those persisted statuses.
  let recovered = false;
  idx.docs = idx.docs.map((meta) => {
    if (!meta || meta.enrichStatus !== 'pending' || enrichmentJobs.has(meta.id)) return meta;
    const doc = getDocument(meta.id);
    if (!doc) return meta;
    const count = enrichedChunkCount(doc.chunks);
    const total = Array.isArray(doc.chunks) ? doc.chunks.length : 0;
    doc.enrichStatus = count === total && total > 0 ? 'done' : count > 0 ? 'partial' : 'stored';
    doc.enrichedChunks = count;
    writeJsonFile(docPath(meta.id), doc);
    recovered = true;
    return { ...meta, enrichStatus: doc.enrichStatus, enrichedChunks: count };
  });
  if (recovered) saveIndex(idx.docs);
  return idx.docs
    .filter((d) => d && d.id)
    .slice()
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function saveIndex(docs) {
  ensureKbIndex();
  writeJsonFile(KB_INDEX_PATH, { docs: docs.slice(0, MAX_KB_DOCS), updatedAt: Date.now() });
}

function docPath(id) {
  if (!/^kb_[a-z0-9_]+$/i.test(String(id || ''))) throw new Error('无效的知识库文档 ID');
  return join(KB_DIR, `${id}.json`);
}

export function getDocument(id) {
  return readJsonFile(docPath(id), null);
}

export function deleteDocument(id) {
  const p = docPath(id);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
  const idx = ensureKbIndex();
  saveIndex(idx.docs.filter((d) => d.id !== id));
  return true;
}

export function makeDocId() {
  return `kb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function titleFromText(text, fallback) {
  const first = String(text || '')
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l && l.length > 2);
  return (first || fallback || '未命名文档').slice(0, 80);
}

/**
 * 新增文档（同步切块/入库；语义增强可异步 enrichDocument）
 * @returns {object} 文档元数据
 */
export function addDocument({ text, title = '', source = 'file', kind = 'txt', meta = {} } = {}) {
  const clean = String(text || '').trim();
  if (clean.length < 20) throw new Error('内容太短（至少 20 个字符）');
  const chunks = chunkText(clean);
  if (!chunks.length) throw new Error('无法切分内容');
  const id = makeDocId();
  const doc = {
    id,
    title: (title || titleFromText(clean, '未命名文档')).slice(0, 120),
    source,
    kind,
    lang: detectLang(clean),
    chars: clean.length,
    chunks: chunks.map((c) => ({ ...c, summary: '', keywords: [] })),
    preview: clean.slice(0, 320),
    enrichStatus: 'stored',
    enrichedChunks: 0,
    createdAt: Date.now(),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  ensureKbDir();
  writeJsonFile(docPath(id), doc);
  const idx = ensureKbIndex();
  idx.docs.unshift({
    id: doc.id,
    title: doc.title,
    source: doc.source,
    kind: doc.kind,
    lang: doc.lang,
    chars: doc.chars,
    chunkCount: doc.chunks.length,
    preview: doc.preview,
    enrichStatus: doc.enrichStatus,
    enrichedChunks: doc.enrichedChunks,
    createdAt: doc.createdAt,
  });
  saveIndex(idx.docs);
  return doc;
}

/** 从文件导入（复用 docExtract） */
export async function addFromFile({ filename, buffer } = {}) {
  const extracted = await extractText({ filename: filename || 'document', buffer });
  const text = String(extracted.text || '').trim();
  const doc = addDocument({
    text,
    title: (filename || '未命名文档').replace(/\.[a-z0-9]+$/i, ''),
    source: 'file',
    kind: extracted.kind || 'txt',
    meta: { filename: filename || '', warnings: extracted.warnings || [], truncated: extracted.truncated || false },
  });
  return { doc, extracted };
}

/** 网页导入 */
export async function importWebPage(url) {
  const raw = String(url || '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('网页链接格式不对（需要 http/https 开头）');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http/https 网页');
  const res = await fetch(parsed.toString(), {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(25_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`网页抓取失败（HTTP ${res.status}）`);
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 120) : parsed.hostname;
  const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
  if (text.length < 80) throw new Error('没有从网页里提取到正文（可能是动态渲染页面），请改用文件上传');
  const doc = addDocument({
    text,
    title,
    source: 'web',
    kind: 'html',
    meta: { url: res.url || parsed.toString() },
  });
  return { doc, title };
}

/* ------------------------------ 语义增强 ------------------------------ */

function enrichedChunkCount(chunks) {
  return (Array.isArray(chunks) ? chunks : []).filter((chunk) =>
    String(chunk.summary || '').trim() || (Array.isArray(chunk.keywords) && chunk.keywords.some((word) => String(word).trim())),
  ).length;
}

function saveEnrichmentState(doc) {
  writeJsonFile(docPath(doc.id), doc);
  const idx = ensureKbIndex();
  saveIndex(idx.docs.map((meta) => meta.id === doc.id
    ? { ...meta, enrichStatus: doc.enrichStatus, enrichedChunks: doc.enrichedChunks || 0 }
    : meta));
}

/** 生成每块的摘要+关键词（DeepSeek，失败保持原文不影响检索） */
export async function enrichDocument(id, settings) {
  if (enrichmentJobs.has(id)) return enrichmentJobs.get(id);
  const doc = getDocument(id);
  if (!doc) throw new Error('文档不存在');
  if (!settings?.apiKey) throw new Error('请先配置文本模型 API Key');
  const job = (async () => {
    doc.enrichStatus = 'pending';
    doc.enrichedChunks = enrichedChunkCount(doc.chunks);
    saveEnrichmentState(doc);
    const chunks = Array.isArray(doc.chunks) ? doc.chunks : [];
    const output = [];
    const batchSize = 10;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize).map((c, j) => ({ i: i + j + 1, text: c.text.slice(0, 900) }));
      try {
        const { parsed } = await chatJSON({
          settings,
          messages: buildKBEnrichMessages(batch),
          temperature: 0.2,
          maxTokens: 1600,
          timeoutMs: 30_000,
        });
        const items = Array.isArray(parsed) ? parsed : parsed?.items;
        if (Array.isArray(items)) {
          for (const it of items) {
            if (!it || typeof it !== 'object') continue;
            const idx = Number(it.i || it.index || 0) - 1;
            if (!Number.isInteger(idx) || idx < i || idx >= i + batch.length) continue;
            const summary = String(it.summary || '').trim().slice(0, 220);
            const keywords = Array.isArray(it.keywords)
              ? it.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 8) : [];
            if (summary || keywords.length) output[idx] = { summary, keywords };
          }
        }
      } catch {
        /* 单批失败不影响原文；最终结果必须体现缺失的摘要。 */
      }
    }
    // Deleting a document while its provider call runs must not resurrect it.
    if (!getDocument(id)) return { ok: false, id, error: '材料已删除，摘要结果未保存' };
    doc.chunks = chunks.map((c, i) => ({
      ...c,
      summary: output[i]?.summary || c.summary || '',
      keywords: output[i]?.keywords?.length ? output[i].keywords : c.keywords || [],
    }));
    doc.enrichedChunks = enrichedChunkCount(doc.chunks);
    doc.enrichStatus = doc.enrichedChunks === chunks.length && chunks.length > 0 ? 'done'
      : doc.enrichedChunks > 0 ? 'partial' : 'failed';
    doc.updatedAt = Date.now();
    saveEnrichmentState(doc);
    const ok = output.some(Boolean);
    return { ok, id, enrichStatus: doc.enrichStatus, chunks: chunks.length, enrichedChunks: doc.enrichedChunks,
      remainingChunks: chunks.length - doc.enrichedChunks,
      ...(ok
        ? { message: doc.enrichStatus === 'done' ? '摘要已完成，原文和摘要均可用于学习' : `已生成 ${doc.enrichedChunks}/${chunks.length} 块摘要，其余可重试；原文仍可使用` }
        : { error: '摘要生成失败，原文和已有摘要已保留，可稍后重试' }),
    };
  })();
  enrichmentJobs.set(id, job);
  try {
    return await job;
  } finally {
    enrichmentJobs.delete(id);
  }
}

/** 后台异步增强（不阻塞接口） */
export function enrichInBackground(id, settings) {
  enrichDocument(id, settings).catch(() => {
    try {
      const doc = getDocument(id);
      if (doc) {
        doc.enrichStatus = 'failed';
        writeJsonFile(docPath(id), doc);
        const idx = ensureKbIndex();
        saveIndex(idx.docs.map((d) => (d.id === id ? { ...d, enrichStatus: 'failed' } : d)));
      }
    } catch {
      /* ignore */
    }
  });
}

/* ------------------------------ 检索 ------------------------------ */

function loadChunks(docs) {
  const out = [];
  for (const meta of docs) {
    const doc = getDocument(meta.id);
    if (!doc || !Array.isArray(doc.chunks)) continue;
    for (const c of doc.chunks) {
      const searchText = [c.text, c.summary || '', (c.keywords || []).join(' ')].join('\n');
      out.push({
        docId: doc.id,
        docTitle: doc.title,
        source: doc.source,
        kind: doc.kind,
        chunkId: c.id,
        text: c.text,
        summary: c.summary || '',
        keywords: c.keywords || [],
        tokens: tokenize(searchText),
      });
    }
  }
  return out;
}

/** 纯本地 BM25（导出以便测试；不调用模型） */
export function bm25Rank(chunks, queryTokens, { limit = 10 } = {}) {
  if (!chunks.length || !queryTokens.length) return [];
  const df = new Map();
  for (const c of chunks) {
    for (const t of new Set(c.tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = chunks.length;
  const avgLen = chunks.reduce((s, c) => s + c.tokens.length, 0) / N || 1;
  const k1 = 1.4;
  const b = 0.75;
  const qset = [...new Set(queryTokens)];
  const scored = chunks.map((c) => {
    const tf = new Map();
    for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of qset) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      const n = df.get(q) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.tokens.length) / avgLen)));
    }
    return { ...c, score };
  });
  return scored
    .filter((c) => c.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit)
    .map(({ tokens, ...rest }) => rest);
}

/**
 * 混合检索：查询扩展（DeepSeek）→ BM25 → LLM 重排。
 * @returns {Promise<{hits:Array, query:{terms:string[], expanded:boolean}}>}
 */
export async function searchKB({ query, docIds = [], limit = 6, settings = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return { hits: [], query: { terms: [], expanded: false } };
  const metas = listDocuments();
  const selected = docIds.length ? metas.filter((m) => docIds.includes(m.id)) : metas;
  if (!selected.length) return { hits: [], query: { terms: tokenize(q), expanded: false } };
  let expanded = false;
  let extraTerms = [];
  let english = [];
  if (settings?.apiKey) {
    try {
      const { parsed } = await chatJSON({
        settings,
        messages: buildKBQueryMessages(q),
        temperature: 0.3,
        maxTokens: 400,
        timeoutMs: 12_000,
      });
      if (parsed) {
        extraTerms = Array.isArray(parsed.terms) ? parsed.terms.map(String) : [];
        english = Array.isArray(parsed.english_terms) ? parsed.english_terms.map(String) : [];
        expanded = extraTerms.length + english.length > 0;
      }
    } catch {
      /* 用原始 query */
    }
  }
  const tokens = [...tokenize(q), ...tokenize(extraTerms.join(' ')), ...tokenize(english.join(' '))];
  const corpus = loadChunks(selected);
  let hits = bm25Rank(corpus, tokens, { limit: Math.max(limit * 2, 12) });
  if (!hits.length) {
    // 回退：子串匹配
    const lower = q.toLowerCase();
    hits = corpus
      .filter((c) => c.text.toLowerCase().includes(lower) || lower.includes(c.text.slice(0, 12).toLowerCase()))
      .slice(0, limit)
      .map(({ tokens: _t, ...rest }) => ({ ...rest, score: 1 }));
  }
  if (hits.length > limit && settings?.apiKey) {
    try {
      const candidates = hits.slice(0, 12);
      const { parsed } = await chatJSON({
        settings,
        messages: buildKBRerankMessages(
          q,
          candidates.map((h) => ({ title: h.docTitle, text: h.text.slice(0, 500) })),
        ),
        temperature: 0.1,
        maxTokens: 300,
        timeoutMs: 15_000,
      });
      const order = Array.isArray(parsed?.order) ? parsed.order : [];
      if (order.length) {
        const reordered = [];
        for (const idx of order) {
          const c = candidates[Number(idx) - 1];
          if (c && !reordered.includes(c)) reordered.push(c);
        }
        for (const c of hits) if (!reordered.includes(c)) reordered.push(c);
        hits = reordered.slice(0, limit);
      } else {
        hits = hits.slice(0, limit);
      }
    } catch {
      hits = hits.slice(0, limit);
    }
  } else {
    hits = hits.slice(0, limit);
  }
  return { hits, query: { terms: [...new Set(tokens)].slice(0, 30), expanded } };
}

/** 语音通话前用的知识库摘要（不做逐轮检索） */
export function buildKBrief(docIds = [], { maxDocs = 3, maxPoints = 6 } = {}) {
  const metas = listDocuments();
  const selected = docIds.length ? metas.filter((m) => docIds.includes(m.id)) : [];
  if (!selected.length) return '';
  const lines = [];
  let points = 0;
  for (const meta of selected.slice(0, maxDocs)) {
    const doc = getDocument(meta.id);
    if (!doc) continue;
    lines.push(`《${doc.title}》（${doc.source === 'web' ? '网页' : '文件'}，${doc.lang === 'en' ? '英文' : doc.lang === 'zh' ? '中文' : '中英'}）`);
    for (const c of (doc.chunks || []).slice(0, 3)) {
      if (points >= maxPoints) break;
      const brief = c.summary || c.text.slice(0, 140);
      if (brief) {
        lines.push(`- ${brief}`);
        points += 1;
      }
    }
  }
  return lines.join('\n').slice(0, 4000);
}

/** 去掉相邻 chunk 的重叠尾巴，避免资料复习/朗读时重复句子。 */
function stripChunkOverlap(chunks = []) {
  const out = [];
  for (const chunk of chunks) {
    let text = String((chunk && chunk.text) || '');
    if (!text) continue;
    if (out.length) {
      const prev = out[out.length - 1];
      const prevText = prev.replace(/\s+/g, ' ').trim();
      const curText = text.replace(/\s+/g, ' ').trim();
      const max = Math.min(prevText.length, curText.length, 200);
      let cut = 0;
      for (let k = max; k >= 24; k -= 1) {
        if (prevText.endsWith(curText.slice(0, k))) {
          cut = k;
          break;
        }
      }
      if (cut) {
        // 找回原文本中 cut 字符后的位置（利用去空白后的前缀长度近似）
        let seen = 0;
        let idx = 0;
        while (idx < text.length && seen < cut) {
          if (!/\s/.test(text[idx])) seen += 1;
          idx += 1;
        }
        text = text.slice(idx);
      }
    }
    out.push(text);
  }
  return out;
}

/** 实时语音教学用的完整资料（不像 buildKBrief 那样只取摘要） */
export function buildKBTeachingMaterial(docIds = [], { maxChars = 7200 } = {}) {
  const metas = listDocuments();
  const selected = docIds.length ? metas.filter((m) => docIds.includes(m.id)) : [];
  if (!selected.length) return '';
  const perDoc = Math.max(1200, Math.floor(maxChars / selected.length));
  const lines = [];
  for (const meta of selected.slice(0, 3)) {
    const doc = getDocument(meta.id);
    if (!doc) continue;
    const text = stripChunkOverlap(doc.chunks || []).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    lines.push(`《${doc.title}》\n${text.slice(0, perDoc)}`);
  }
  return lines.join('\n\n').slice(0, maxChars);
}

export function kbStats() {
  const docs = listDocuments();
  return {
    docs: docs.length,
    chunks: docs.reduce((s, d) => s + (d.chunkCount || 0), 0),
    enriching: docs.filter((d) => d.enrichStatus === 'pending').length,
    chars: docs.reduce((s, d) => s + (d.chars || 0), 0),
  };
}

export default {
  addDocument,
  addFromFile,
  importWebPage,
  deleteDocument,
  getDocument,
  listDocuments,
  enrichDocument,
  enrichInBackground,
  searchKB,
  bm25Rank,
  chunkText,
  tokenize,
  buildKBrief,
  buildKBTeachingMaterial,
  kbStats,
  detectLang,
};
