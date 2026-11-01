/**
 * 阅读讲解文档持久化：data/docs/{id}.json（只保存提取后的文字，不保存原始二进制）。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readJsonFile, writeJsonFile } from './config.js';

export const DOCS_DIR = join(DATA_DIR, 'docs');
const ID_RE = /^d_[a-f0-9]{8,20}$/;
const MAX_DOCS = 30;

export function ensureDocsDir() {
  // writeJsonFile 会递归创建目录
  return DOCS_DIR;
}

export function makeDocId() {
  return `d_${randomBytes(8).toString('hex')}`;
}

export function isValidDocId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function docPath(id) {
  if (!isValidDocId(id)) throw new Error('无效的文档 id');
  return join(DOCS_DIR, `${id}.json`);
}

function sanitizeName(name) {
  const base = String(name || 'document')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/]+/g, '_')
    .trim()
    .slice(0, 120);
  return base || 'document';
}

/** 保存文档（含提取文字与可选分析） */
export function saveDoc(doc) {
  if (!doc || !doc.text) throw new Error('文档内容为空');
  const id = isValidDocId(doc.id) ? doc.id : makeDocId();
  const payload = {
    id,
    name: sanitizeName(doc.name),
    kind: String(doc.kind || 'text').slice(0, 20),
    chars: Number(doc.chars) || String(doc.text).length,
    truncated: doc.truncated === true,
    warnings: Array.isArray(doc.warnings) ? doc.warnings.slice(0, 5).map((w) => String(w).slice(0, 200)) : [],
    text: String(doc.text),
    createdAt: Number(doc.createdAt) || Date.now(),
    analysis: doc.analysis || null,
  };
  writeJsonFile(docPath(id), payload);
  pruneDocs();
  return payload;
}

export function getDoc(id) {
  if (!isValidDocId(id)) return null;
  const path = docPath(id);
  if (!existsSync(path)) return null;
  try {
    const doc = readJsonFile(path, null);
    return doc && doc.id && doc.text ? doc : null;
  } catch {
    return null;
  }
}

/** 保存分析结果（缓存） */
export function saveDocAnalysis(id, analysis) {
  const doc = getDoc(id);
  if (!doc) throw new Error('文档不存在');
  const next = { ...doc, analysis: analysis || null };
  writeJsonFile(docPath(id), next);
  return next;
}

/** 轻量元数据列表（按创建时间倒序，最多 30 份） */
export function listDocs(limit = MAX_DOCS) {
  if (!existsSync(DOCS_DIR)) return [];
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.json'));
  const docs = [];
  for (const file of files) {
    try {
      const doc = readJsonFile(join(DOCS_DIR, file), null);
      if (!doc || !doc.id) continue;
      docs.push({
        id: doc.id,
        name: doc.name,
        kind: doc.kind,
        chars: doc.chars,
        createdAt: doc.createdAt,
        analyzed: Boolean(doc.analysis),
      });
    } catch {
      /* 跳过损坏文件 */
    }
  }
  docs.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  return docs.slice(0, Math.max(0, Number(limit) || MAX_DOCS));
}

export function deleteDoc(id) {
  if (!isValidDocId(id)) return false;
  const path = docPath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** 只保留最近 30 份，避免无限增长 */
function pruneDocs() {
  const docs = listDocs(1000);
  for (const doc of docs.slice(MAX_DOCS)) {
    try {
      deleteDoc(doc.id);
    } catch {
      /* ignore */
    }
  }
}

/** 给前端的文档元数据 */
export function publicDoc(doc, { text = false, analysis = false, preview = false } = {}) {
  if (!doc) return null;
  const out = {
    id: doc.id,
    name: doc.name,
    kind: doc.kind,
    chars: doc.chars,
    truncated: Boolean(doc.truncated),
    warnings: doc.warnings || [],
    createdAt: doc.createdAt,
    analyzed: Boolean(doc.analysis),
  };
  if (preview) out.preview = String(doc.text || '').slice(0, 400);
  if (text) out.text = doc.text;
  if (analysis) out.analysis = doc.analysis || null;
  return out;
}

export default { saveDoc, getDoc, saveDocAnalysis, listDocs, deleteDoc, makeDocId, isValidDocId, publicDoc, DOCS_DIR };
