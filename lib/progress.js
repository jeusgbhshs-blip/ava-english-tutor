/**
 * 学习进度持久化：data/progress.json。
 * 结构：{ version, streak, lastActive, totalTurns, totalMinutes, days:[{date,turns,minutes}], words:{word:rec}, updatedAt }
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readJsonFile, writeJsonFile } from './config.js';
import { mergeReviews, masteryCount, dueWords, isDue } from './srs.js';

const PROGRESS_PATH = join(DATA_DIR, 'progress.json');

export function defaultProgress() {
  return {
    version: 1,
    streak: 0,
    lastActive: '',
    totalTurns: 0,
    totalMinutes: 0,
    days: [],
    words: {},
    updatedAt: 0,
  };
}

/** 本地时区的 YYYY-MM-DD */
export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function yesterdayKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return dateKey(d);
}

export function normalizeProgress(raw) {
  const base = defaultProgress();
  const p = { ...base, ...(raw || {}) };
  p.streak = Number.isFinite(p.streak) ? Math.max(0, Math.floor(p.streak)) : 0;
  p.totalTurns = Math.max(0, Number(p.totalTurns) || 0);
  p.totalMinutes = Math.max(0, Number(p.totalMinutes) || 0);
  p.days = Array.isArray(p.days) ? p.days.filter((d) => d && d.date).slice(-60) : [];
  p.words = p.words && typeof p.words === 'object' ? p.words : {};
  p.updatedAt = Number(p.updatedAt) || 0;
  p.lastActive = typeof p.lastActive === 'string' ? p.lastActive : '';
  return p;
}

export function loadProgress() {
  try {
    if (!existsSync(PROGRESS_PATH)) return defaultProgress();
    return normalizeProgress(readJsonFile(PROGRESS_PATH, defaultProgress()));
  } catch {
    return defaultProgress();
  }
}

export function saveProgress(progress) {
  const normalized = normalizeProgress({ ...progress, updatedAt: Date.now() });
  writeJsonFile(PROGRESS_PATH, normalized);
  return normalized;
}

/**
 * 合并一次学习活动：新增句子数、时长、单词复习结果，并维护连续天数。
 * @param {{turns?:number, minutes?:number, reviewWords?:{word:string,correct:boolean}[]}} patch
 */
export function recordActivity(patch = {}, now = new Date()) {
  const p = loadProgress();
  const turns = Math.max(0, Math.floor(Number(patch.turns) || 0));
  const minutes = Math.max(0, Number(patch.minutes) || 0);
  const reviews = Array.isArray(patch.reviewWords) ? patch.reviewWords : [];
  const today = dateKey(now);
  const hasActivity = turns > 0 || minutes > 0 || reviews.length > 0;

  if (hasActivity) {
    if (p.lastActive === today) {
      // 今天已活跃，连续天数不变
    } else if (p.lastActive === yesterdayKey(now)) {
      p.streak = p.streak + 1;
    } else {
      p.streak = 1;
    }
    p.lastActive = today;

    const day = p.days.find((d) => d.date === today);
    if (day) {
      day.turns += turns;
      day.minutes = Math.round((day.minutes + minutes) * 10) / 10;
    } else {
      p.days.push({ date: today, turns, minutes: Math.round(minutes * 10) / 10 });
    }
    p.days = p.days.slice(-60);
  }

  p.totalTurns += turns;
  p.totalMinutes = Math.round((p.totalMinutes + minutes) * 10) / 10;
  if (reviews.length) p.words = mergeReviews(p.words, reviews, now.getTime());
  saveProgress(p);
  return p;
}


/**
 * 把新词加入 SRS 进度：仅新增缺失词条（box 0、今日到期），不重置已有记录。
 * @returns {{ added:number, progress:object }}
 */
export function addVocabWords(words, now = Date.now()) {
  const p = loadProgress();
  const ms = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  let added = 0;
  for (const item of Array.isArray(words) ? words : []) {
    const raw = typeof item === 'string' ? item : item && item.word;
    const word = String(raw || '').trim().toLowerCase();
    if (!word) continue;
    if (!p.words[word]) {
      p.words[word] = { box: 0, due: ms, seen: 0, correct: 0, last: 0 };
      added += 1;
    }
  }
  if (added) saveProgress(p);
  return { added, progress: p };
}

/** 给前端展示用的派生信息 */
export function publicProgress(progress = loadProgress(), now = new Date()) {
  const p = normalizeProgress(progress);
  const today = dateKey(now);
  const yesterday = yesterdayKey(now);
  const effectiveStreak = p.lastActive === today || p.lastActive === yesterday ? p.streak : 0;
  const words = p.words;
  return {
    streak: p.lastActive === today ? p.streak : effectiveStreak,
    lastActive: p.lastActive,
    totalTurns: p.totalTurns,
    totalMinutes: p.totalMinutes,
    totalWords: Object.keys(words).length,
    masteredWords: masteryCount(words),
    dueWords: dueWords(words, now.getTime(), 20).map((w) => w.word),
    dueCount: Object.values(words).filter((rec) => isDue(rec, now.getTime())).length,
    words,
    days: p.days,
    updatedAt: p.updatedAt,
  };
}
