/**
 * 单词复习系统（A+C）：本地词库 + 双库状态 + 间隔重复 SRS。
 * 数据：data/review.json，words 以“小写单词”为 key。
 */
import { join } from 'node:path';
import { DATA_DIR, readJsonFile, writeJsonFile } from './config.js';

export const REVIEW_PATH = join(DATA_DIR, 'review.json');
const MAX_WORDS = 5000;
const MAX_INTERVAL_DAYS = 365;
const AGAIN_MINUTES = 10;
const DAY = 24 * 60 * 60 * 1000;

const STATUSES = new Set(['new', 'learning', 'known']);
const GRADES = new Set(['again', 'hard', 'good', 'easy']);

function nowMs() {
  return Date.now();
}

export function loadStore() {
  const s = readJsonFile(REVIEW_PATH, { words: {} });
  if (!s || typeof s !== 'object') return { words: {}, updatedAt: 0 };
  if (!s.words || typeof s.words !== 'object') s.words = {};
  return s;
}

function saveStore(store) {
  store.updatedAt = nowMs();
  writeJsonFile(REVIEW_PATH, store);
  return store;
}

export function wordKey(word) {
  return String(word || '').trim().toLowerCase().slice(0, 60);
}

function cleanText(value, max = 220) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeEntry(input = {}, existing = null) {
  const word = cleanText(input.word, 60);
  if (!word) return null;
  const now = nowMs();
  const entry = existing ? { ...existing } : {
    word,
    phonetic: '',
    meaning: '',
    example: '',
    source: 'manual',
    sourceTitle: '',
    status: 'new',
    interval: 0,
    ease: 2.5,
    due: now,
    reps: 0,
    lapses: 0,
    createdAt: now,
    updatedAt: now,
    lastGrade: '',
  };
  if (input.phonetic !== undefined) entry.phonetic = cleanText(input.phonetic, 80);
  if (input.meaning !== undefined) entry.meaning = cleanText(input.meaning, 220);
  if (input.example !== undefined) entry.example = cleanText(input.example, 300);
  if (input.source !== undefined) entry.source = cleanText(input.source, 30) || entry.source;
  if (input.sourceTitle !== undefined) entry.sourceTitle = cleanText(input.sourceTitle, 120);
  if (input.status !== undefined && STATUSES.has(input.status)) entry.status = input.status;
  if (input.due !== undefined && Number.isFinite(Number(input.due))) entry.due = Number(input.due);
  entry.updatedAt = now;
  return entry;
}

/** 批量新增/更新（手动添加、对话摘要自动收录） */
export function upsertWords(words, { defaults = {} } = {}) {
  const store = loadStore();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of Array.isArray(words) ? words : []) {
    const raw = typeof item === 'string' ? { word: item } : item;
    const key = wordKey(raw && raw.word);
    if (!key) {
      skipped += 1;
      continue;
    }
    const existing = store.words[key];
    if (existing) {
      // Defaults describe newly collected words, not an existing word's learning state.
      const next = normalizeEntry(raw, existing);
      if (!next) {
        skipped += 1;
        continue;
      }
      store.words[key] = next;
      updated += 1;
    } else {
      if (Object.keys(store.words).length >= MAX_WORDS) {
        skipped += 1;
        continue;
      }
      const next = normalizeEntry({ ...defaults, ...raw }, null);
      if (!next) {
        skipped += 1;
        continue;
      }
      store.words[key] = next;
      added += 1;
    }
  }
  if (added || updated) saveStore(store);
  return { added, updated, skipped, total: Object.keys(store.words).length };
}

function isDue(entry, now = nowMs()) {
  return Number(entry && entry.due) <= now;
}

/** 统计（徽标/每日提醒） */
export function getSummary() {
  const store = loadStore();
  const now = nowMs();
  const words = Object.values(store.words);
  return {
    total: words.length,
    dueCount: words.filter((w) => isDue(w, now)).length,
    newCount: words.filter((w) => w.status === 'new').length,
    learningCount: words.filter((w) => w.status === 'learning').length,
    knownCount: words.filter((w) => w.status === 'known').length,
    updatedAt: store.updatedAt || 0,
  };
}

function decorate(entry) {
  return {
    word: entry.word,
    phonetic: entry.phonetic || '',
    meaning: entry.meaning || '',
    example: entry.example || '',
    source: entry.source || 'manual',
    sourceTitle: entry.sourceTitle || '',
    status: STATUSES.has(entry.status) ? entry.status : 'new',
    due: Number(entry.due) || 0,
    interval: Number(entry.interval) || 0,
    ease: Number(entry.ease) || 2.5,
    reps: Number(entry.reps) || 0,
    lapses: Number(entry.lapses) || 0,
    createdAt: entry.createdAt || 0,
    updatedAt: entry.updatedAt || 0,
    lastGrade: entry.lastGrade || '',
    dueLabel: formatDue(entry.due),
  };
}

function formatDue(due) {
  const d = Number(due) || 0;
  if (!d) return '';
  const diff = d - nowMs();
  if (diff <= 0) return '现在';
  if (diff < DAY * 0.9) return `${Math.max(1, Math.round(diff / 60000))} 分钟后`;
  return `${Math.round(diff / DAY)} 天后`;
}

/** 今日到期列表（按到期时间升序；含已知/生词） */
export function getDue({ limit = 20 } = {}) {
  const store = loadStore();
  const now = nowMs();
  const list = Object.values(store.words)
    .filter((w) => isDue(w, now))
    .sort((a, b) => (Number(a.due) || 0) - (Number(b.due) || 0))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    .map(decorate);
  return { words: list, count: list.length, summary: getSummary() };
}

/** 词库列表（生词本/已掌握/全部 + 搜索） */
export function listWords({ status = 'all', q = '', limit = 200 } = {}) {
  const store = loadStore();
  const keyword = String(q || '').trim().toLowerCase();
  let words = Object.values(store.words);
  if (status === 'new' || status === 'learning' || status === 'known') {
    words = words.filter((w) => w.status === status);
  } else if (status === 'unfamiliar') {
    words = words.filter((w) => w.status !== 'known');
  }
  if (keyword) {
    words = words.filter(
      (w) =>
        String(w.word).toLowerCase().includes(keyword) ||
        String(w.meaning || '').toLowerCase().includes(keyword) ||
        String(w.example || '').toLowerCase().includes(keyword),
    );
  }
  words = words
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, Math.max(1, Math.min(2000, Number(limit) || 200)));
  return { words: words.map(decorate), counts: getSummary() };
}

export function getWord(word) {
  const store = loadStore();
  const entry = store.words[wordKey(word)];
  return entry ? decorate(entry) : null;
}

/** 编辑/改状态（加入生词本、标为掌握等） */
export function updateWord(word, patch = {}) {
  const store = loadStore();
  const key = wordKey(word);
  const existing = store.words[key];
  if (!existing) throw new Error('单词不存在');
  const next = normalizeEntry({ ...existing, ...patch, word: existing.word }, existing);
  if (patch.status === 'known') {
    next.status = 'known';
    next.due = nowMs() + 7 * DAY;
    next.interval = Math.max(7, Number(next.interval) || 0);
  } else if (patch.status === 'new' || patch.status === 'learning') {
    next.status = patch.status;
    next.due = payloadDueOrNow(patch, next);
  }
  store.words[key] = next;
  saveStore(store);
  return decorate(next);
}

function payloadDueOrNow(patch, entry) {
  const explicit = Number(patch && patch.due);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Number(entry && entry.due) || nowMs();
}

export function deleteWord(word) {
  const store = loadStore();
  const key = wordKey(word);
  if (!store.words[key]) return false;
  delete store.words[key];
  saveStore(store);
  return true;
}

function intervalDays(entry) {
  return Math.max(0, Math.min(MAX_INTERVAL_DAYS, Number(entry && entry.interval) || 0));
}

/** SRS 评分：again / hard / good / easy */
export function gradeWord(word, grade) {
  if (!GRADES.has(grade)) throw new Error('无效的评分（again/hard/good/easy）');
  const store = loadStore();
  const key = wordKey(word);
  let entry = store.words[key];
  if (!entry) {
    const created = normalizeEntry({ word: String(word || '').trim(), source: 'manual' });
    if (!created) throw new Error('单词不能为空');
    store.words[key] = created;
    entry = created;
  }
  const now = nowMs();
  let ease = Math.max(1.3, Math.min(3.2, Number(entry.ease) || 2.5));
  let interval = intervalDays(entry);
  let reps = Number(entry.reps) || 0;
  let lapses = Number(entry.lapses) || 0;
  let status = STATUSES.has(entry.status) ? entry.status : 'new';

  if (grade === 'again') {
    ease = Math.max(1.3, ease - 0.2);
    interval = 0;
    lapses += 1;
    status = 'learning';
    entry.due = now + AGAIN_MINUTES * 60 * 1000;
  } else if (grade === 'hard') {
    ease = Math.max(1.3, ease - 0.05);
    interval = Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(interval * 1.2) || 1));
    status = 'learning';
    entry.due = now + interval * DAY;
  } else if (grade === 'good') {
    interval = reps === 0 ? 1 : Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(interval * ease) || 1));
    status = 'learning';
    entry.due = now + interval * DAY;
  } else if (grade === 'easy') {
    ease = Math.min(3.2, ease + 0.15);
    interval = Math.min(MAX_INTERVAL_DAYS, Math.max(2, Math.round((interval || 1) * ease * 1.3) || 2));
    status = reps >= 2 ? 'known' : 'learning';
    entry.due = now + interval * DAY;
  }

  reps += 1;
  entry.ease = ease;
  entry.interval = interval;
  entry.reps = reps;
  entry.lapses = lapses;
  entry.status = status;
  entry.lastGrade = grade;
  entry.updatedAt = now;
  store.words[key] = entry;
  saveStore(store);
  return { word: decorate(entry), summary: getSummary() };
}

/** 对话总结后自动收录重点词（source=conversation，初始 due=now） */
export function syncFromSummary(keyWords, { characterId = '', characterName = '', mode = 'free' } = {}) {
  const words = (Array.isArray(keyWords) ? keyWords : [])
    .map((w) => (typeof w === 'string' ? { word: w } : w))
    .filter((w) => w && w.word)
    .map((w) => ({
      word: w.word,
      phonetic: w.phonetic || '',
      meaning: w.meaning || w.meaning_zh || '',
      example: w.example || '',
      source: 'conversation',
      sourceTitle: characterName ? `${characterName} · 对话` : mode === 'reading' ? '阅读材料' : '自由对话',
    }));
  return upsertWords(words, {
    defaults: { status: 'new', source: 'conversation' },
  });
}

/** 导出纯函数便于测试 */
export const __test__ = { formatDue, isDue, intervalDays };

export default {
  upsertWords,
  getSummary,
  getDue,
  listWords,
  getWord,
  updateWord,
  deleteWord,
  gradeWord,
  syncFromSummary,
};
