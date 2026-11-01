/**
 * 当天单词表持久化：data/wordbook.json（按日期分组，原子写，权限 600）。
 * 结构：{ version:1, days: { 'YYYY-MM-DD': [ {word,phonetic,meaning,example,why_zh,addedAt,source,timesSeen,lastAt} ] }, updatedAt }
 */
import { existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readJsonFile, writeJsonFile } from './config.js';

const WORDBOOK_PATH = join(DATA_DIR, 'wordbook.json');
const MAX_DAYS = 60;
const MAX_WORDS_PER_DAY = 60;

/** 本地时区 YYYY-MM-DD */
export function dateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天的词表时间戳（用于排序） */
function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

/** 日期显示标签：今天 / 昨天 / 10月20日 */
export function dateLabel(date, now = new Date()) {
  const today = dateKey(now);
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  const yesterday = dateKey(d);
  if (date === today) return '今天';
  if (date === yesterday) return '昨天';
  const [, m, day] = String(date).split('-');
  return `${Number(m)}月${Number(day)}日`;
}

export function loadWordbook() {
  const raw = readJsonFile(WORDBOOK_PATH, { version: 1, days: {}, updatedAt: 0 });
  const days = raw && typeof raw.days === 'object' && raw.days ? raw.days : {};
  return { version: 1, days, updatedAt: Number(raw?.updatedAt) || 0 };
}

export function saveWordbook(wordbook) {
  const days = wordbook?.days && typeof wordbook.days === 'object' ? wordbook.days : {};
  const sorted = Object.fromEntries(
    Object.entries(days)
      .filter(([date, list]) => date && Array.isArray(list) && list.length)
      .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
      .slice(0, MAX_DAYS),
  );
  const payload = { version: 1, days: sorted, updatedAt: Date.now() };
  writeJsonFile(WORDBOOK_PATH, payload);
  try {
    chmodSync(WORDBOOK_PATH, 0o600);
  } catch {
    /* 非 POSIX 平台忽略 */
  }
  return payload;
}

function cleanWord(input) {
  if (!input || typeof input !== 'object') return null;
  const word = String(input.word || '').trim();
  if (!word) return null;
  return {
    word: word.slice(0, 80),
    phonetic: String(input.phonetic || '').slice(0, 60),
    meaning: String(input.meaning || '').slice(0, 120),
    example: String(input.example || '').slice(0, 240),
    why_zh: String(input.why_zh || '').slice(0, 160),
    source: String(input.source || '').slice(0, 40),
    addedAt: Number(input.addedAt) || 0,
    timesSeen: Math.max(1, Number(input.timesSeen) || 1),
    lastAt: Number(input.lastAt) || 0,
  };
}

/**
 * 把词条加入某天的单词表（默认今天）：按 word 去重，重复则更新释义并 timesSeen+1。
 * @returns {{ day: object, addedCount: number, dailyWords: object, wordbook: object }}
 */
export function addWords(words, { source = 'conversation', date, now = Date.now() } = {}) {
  const ms = nowMs(now);
  const day = date || dateKey(new Date(ms));
  const book = loadWordbook();
  if (!Array.isArray(book.days[day])) book.days[day] = [];
  const list = book.days[day];
  let addedCount = 0;

  for (const item of Array.isArray(words) ? words : []) {
    const clean = cleanWord(item);
    if (!clean) continue;
    const existing = list.find((w) => String(w.word).toLowerCase() === clean.word.toLowerCase());
    if (existing) {
      existing.timesSeen = Math.max(1, Number(existing.timesSeen) || 1) + 1;
      existing.lastAt = ms;
      if (clean.phonetic) existing.phonetic = clean.phonetic;
      if (clean.meaning) existing.meaning = clean.meaning;
      if (clean.example) existing.example = clean.example;
      if (clean.why_zh) existing.why_zh = clean.why_zh;
    } else {
      if (list.length >= MAX_WORDS_PER_DAY) continue;
      list.push({ ...clean, addedAt: clean.addedAt || ms, lastAt: ms, timesSeen: 1, source: clean.source || source || 'conversation' });
      addedCount += 1;
    }
  }

  const saved = saveWordbook(book);
  const dailyWords = buildDay(day, saved.days[day] || [], new Date(ms));
  return { day: dailyWords, addedCount, dailyWords, wordbook: saved };
}

function buildDay(date, words, now = new Date()) {
  return {
    date,
    label: dateLabel(date, now),
    count: words.length,
    words: words.map((w) => ({
      word: w.word,
      phonetic: w.phonetic || '',
      meaning: w.meaning || '',
      example: w.example || '',
      why_zh: w.why_zh || '',
      addedAt: Number(w.addedAt) || 0,
      source: w.source || 'conversation',
      timesSeen: Math.max(1, Number(w.timesSeen) || 1),
    })),
  };
}

/**
 * 读取最近若干天的单词表（按日期倒序，今天在最前）。
 * @returns {{ today: string, totalWords: number, days: object[] }}
 */
export function getWordbook({ days = 7, now = new Date() } = {}) {
  const limit = Math.min(MAX_DAYS, Math.max(1, Number(days) || 7));
  const book = loadWordbook();
  const dates = Object.keys(book.days)
    .filter((d) => Array.isArray(book.days[d]) && book.days[d].length)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit);
  const dayList = dates.map((d) => buildDay(d, book.days[d], now));
  const unique = new Set();
  for (const list of Object.values(book.days)) {
    for (const w of list) unique.add(String(w.word).toLowerCase());
  }
  return { today: dateKey(now), totalWords: unique.size, days: dayList };
}

/** 今日新增词数（徽标用） */
export function todayCount(now = new Date()) {
  const book = loadWordbook();
  const list = book.days[dateKey(now)];
  return Array.isArray(list) ? list.length : 0;
}
