/**
 * 单词间隔复习（Leitner 简化版）纯函数模块，无 I/O。
 * box 0–7，对应间隔天数 [0,1,2,4,7,14,30,60]。
 */

export const BOX_DAY = 86_400_000;
export const BOX_INTERVALS_DAYS = [0, 1, 2, 4, 7, 14, 30, 60];
export const MAX_BOX = BOX_INTERVALS_DAYS.length - 1;

/** 新建一个词条记录 */
export function newWordRecord(now = Date.now()) {
  return { box: 0, due: now, seen: 0, correct: 0, last: 0 };
}

/**
 * 复习一个词。
 * @param {{box?:number, seen?:number, correct?:number, due?:number, last?:number}} rec 旧记录（可为空）
 * @param {boolean} correct 本次是否答对
 * @param {number} now 时间戳 ms
 */
export function reviewWord(rec, correct, now = Date.now()) {
  const old = rec || newWordRecord(now);
  const box = Math.max(0, Math.min(MAX_BOX, Number.isFinite(old.box) ? old.box : 0));
  const nextBox = correct ? Math.min(MAX_BOX, box + 1) : Math.max(0, box - 1);
  const interval = BOX_INTERVALS_DAYS[nextBox];
  return {
    box: nextBox,
    due: now + interval * BOX_DAY,
    seen: (Number(old.seen) || 0) + 1,
    correct: (Number(old.correct) || 0) + (correct ? 1 : 0),
    last: now,
  };
}

/** 是否到期（due <= now） */
export function isDue(rec, now = Date.now()) {
  if (!rec) return true;
  const due = Number(rec.due) || 0;
  return due <= now;
}

/** 到期词列表（按到期时间升序），最多 limit 个 */
export function dueWords(words, now = Date.now(), limit = 20) {
  if (!words || typeof words !== 'object') return [];
  return Object.entries(words)
    .filter(([, rec]) => isDue(rec, now))
    .sort((a, b) => (Number(a[1]?.due) || 0) - (Number(b[1]?.due) || 0))
    .slice(0, Math.max(0, limit))
    .map(([word, rec]) => ({ word, ...rec }));
}

/** 已掌握单词数（box >= 3 视作掌握） */
export function masteryCount(words) {
  if (!words || typeof words !== 'object') return 0;
  return Object.values(words).filter((rec) => (Number(rec?.box) || 0) >= 3).length;
}

/** 批量合并复习结果，返回新 words 对象（不修改入参） */
export function mergeReviews(words, reviews, now = Date.now()) {
  const next = { ...(words || {}) };
  for (const item of reviews || []) {
    if (!item || typeof item.word !== 'string' || !item.word.trim()) continue;
    const word = item.word.trim().toLowerCase();
    next[word] = reviewWord(next[word], !!item.correct, now);
  }
  return next;
}

export default { newWordRecord, reviewWord, isDue, dueWords, masteryCount, mergeReviews, BOX_INTERVALS_DAYS };
