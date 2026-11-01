/**
 * 发音评测纯函数模块（无 I/O，可单测）。
 * 输入：目标句子 + 语音识别文本，输出 0-100 分、星级、逐词状态和中文提示。
 */

/** 常见缩写展开表：口语评测时按发音词对齐 */
const CONTRACTIONS = {
  "i'm": ['i', 'am'],
  "you're": ['you', 'are'],
  "he's": ['he', 'is'],
  "she's": ['she', 'is'],
  "it's": ['it', 'is'],
  "we're": ['we', 'are'],
  "they're": ['they', 'are'],
  "there's": ['there', 'is'],
  "that's": ['that', 'is'],
  "what's": ['what', 'is'],
  "who's": ['who', 'is'],
  "let's": ['let', 'us'],
  "i've": ['i', 'have'],
  "we've": ['we', 'have'],
  "they've": ['they', 'have'],
  "i'll": ['i', 'will'],
  "you'll": ['you', 'will'],
  "we'll": ['we', 'will'],
  "they'll": ['they', 'will'],
  "i'd": ['i', 'would'],
  "you'd": ['you', 'would'],
  "don't": ['do', 'not'],
  "doesn't": ['does', 'not'],
  "didn't": ['did', 'not'],
  "isn't": ['is', 'not'],
  "aren't": ['are', 'not'],
  "wasn't": ['was', 'not'],
  "weren't": ['were', 'not'],
  "can't": ['can', 'not'],
  "cannot": ['can', 'not'],
  "couldn't": ['could', 'not'],
  "won't": ['will', 'not'],
  "wouldn't": ['would', 'not'],
  "shouldn't": ['should', 'not'],
  "haven't": ['have', 'not'],
  "hasn't": ['has', 'not'],
  "gonna": ['going', 'to'],
  "wanna": ['want', 'to'],
  "gotta": ['got', 'to'],
  "kinda": ['kind', 'of'],
  "sorta": ['sort', 'of'],
};

const BOX_DAY = 86_400_000;
const SCORE_BY_STARS = [0, 40, 60, 75, 90]; // stars 由分数阈值反推

/** 清理单词语音识别噪声：统一小写、去标点、保留撇号 */
export function cleanToken(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

/** 切词，保留原顺序；返回清理后的 token 数组（空串剔除） */
export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ''))
    .filter(Boolean);
}

/** 把 token 序列展开成发音词序列，并记录它来自第几个目标 token */
function expandContractions(tokens) {
  /** @type {{word:string, ti:number}[]} */
  const out = [];
  tokens.forEach((tok, ti) => {
    const exp = CONTRACTIONS[tok] || [tok];
    for (const w of exp) out.push({ word: w, ti });
  });
  return out;
}

/** 标准 Levenshtein 距离（字符级，用于判断“接近”） */
export function wordDistance(a, b) {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/** 轻量词干化，用于识别单复数/时态导致的“接近” */
function stem(word) {
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('es') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && w.length > 3) w = w.slice(0, -1);
  return w;
}

/** 判断识别词与目标词是否“接近”（口音/时态/识别误差可接受） */
export function isCloseWord(target, heard) {
  if (!target || !heard) return false;
  if (target === heard) return true;
  const d = wordDistance(target, heard);
  const len = Math.max(target.length, heard.length);
  if (d <= 1 && len >= 4) return true;
  if (d <= 2 && len >= 8) return true;
  if (stem(target) === stem(heard) && Math.min(target.length, heard.length) >= 3) return true;
  return false;
}

/**
 * 词级对齐：返回每个目标 token 的状态，以及额外多出来的词。
 * 使用 Levenshtein 动态规划 + 回溯。
 */
function alignTokens(targetTokens, heardTokens) {
  const a = expandContractions(targetTokens);
  const b = expandContractions(heardTokens);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1].word === b[j - 1].word ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j - 1] + cost, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = a[i - 1].word === b[j - 1].word ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        ops.push({ type: cost === 0 ? 'match' : 'sub', a: a[i - 1], b: b[j - 1] });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: 'del', a: a[i - 1] });
      i--;
    } else {
      ops.push({ type: 'ins', b: b[j - 1] });
      j--;
    }
  }
  ops.reverse();

  const perTarget = targetTokens.map(() => ({ statuses: [], heard: [] }));
  let extras = 0;
  for (const op of ops) {
    if (op.type === 'match' || op.type === 'sub') {
      const slot = perTarget[op.a.ti];
      slot.heard.push(op.b.word);
      if (op.type === 'match') slot.statuses.push('ok');
      else slot.statuses.push(isCloseWord(op.a.word, op.b.word) ? 'close' : 'miss');
    } else if (op.type === 'del') {
      perTarget[op.a.ti].statuses.push('miss');
    } else {
      extras += 1;
    }
  }

  const words = targetTokens.map((text, idx) => {
    const slot = perTarget[idx];
    const statuses = slot.statuses;
    let status = 'miss';
    if (statuses.length && statuses.every((s) => s === 'ok')) status = 'ok';
    else if (statuses.length && statuses.every((s) => s === 'ok' || s === 'close')) status = 'close';
    const heard = slot.heard.join(' ');
    return { text, status, ...(heard ? { heard } : {}) };
  });
  return { words, extras };
}

/** 根据错词生成中文发音建议（最多 3 条，去重） */
export function buildTips(targetTokens, words, transcript, confidence) {
  const tips = [];
  const add = (t) => {
    if (t && !tips.includes(t) && tips.length < 3) tips.push(t);
  };
  const missed = words.filter((w) => w.status === 'miss');
  const close = words.filter((w) => w.status === 'close');
  const allText = targetTokens.join(' ');
  const missRate = words.length ? missed.length / words.length : 1;

  if (missed.length || close.length) {
    if (/\b\w*th\w*\b/i.test(missed.map((w) => w.text).join(' '))) {
      add('th 是咬舌音：舌尖轻触上齿，别读成 s / z / d。');
    }
    if (missed.some((w) => /[rl]/.test(w.text) && w.text.length > 2)) {
      add('r 要卷舌、l 舌尖抵上齿龈，别把两个音混在一起。');
    }
    if (missed.some((w) => /[vw]/.test(w.text))) {
      add('v 用上齿轻咬下唇送气，w 要圆唇，两个音不要互换。');
    }
    if (missed.some((w) => /(t|d|k|p|s|z)$/.test(w.text))) {
      add('句尾的辅音要发出来，不要吞音（如 want /t/、good /d/）。');
    }
    if (missed.some((w) => w.text.length >= 9)) {
      add('长单词按音节拆开慢读，再连起来读整句。');
    }
    if (missRate >= 0.5) {
      add('先放慢语速、一个词一个词读清楚，再逐渐连读。');
    } else if (missed.length) {
      add('个别词没读准，跟着示范按 0.8 倍速再读一遍。');
    }
    if (!missed.length && close.length) {
      add('已经很接近了，注意词尾变化和重音位置。');
    }
  } else if (transcript && words.length) {
    add('发音很标准，继续保持这个语速和节奏！');
  }

  if (!transcript) add('还没有听到你的声音，靠近麦克风再大声读一遍。');
  else if (typeof confidence === 'number' && confidence < 0.55 && missRate > 0.2) {
    add('可能是麦克风收音不清，靠近麦克风、在安静环境下再试一次。');
  }
  if (!tips.length) add(`整句是 “${allText}”，跟读时注意重读实词、弱读虚词。`);
  return tips;
}

/**
 * 计算发音得分。
 * @param {string} target 目标句子（教师示范）
 * @param {string} transcript 语音识别文本
 * @param {number} [confidence] 识别置信度 0-1（可选）
 */
export function scorePronunciation(target, transcript, confidence) {
  const targetTokens = tokenize(target);
  const heardTokens = tokenize(transcript);
  if (!targetTokens.length) {
    return { score: 0, stars: 1, words: [], tips_zh: ['没有可评测的示范句子。'], accuracy: 0 };
  }
  if (!heardTokens.length) {
    return {
      score: 0,
      stars: 1,
      words: targetTokens.map((text) => ({ text, status: 'miss' })),
      tips_zh: buildTips(targetTokens, targetTokens.map((text) => ({ text, status: 'miss' })), '', confidence),
      accuracy: 0,
    };
  }

  const { words, extras } = alignTokens(targetTokens, heardTokens);
  let weighted = 0;
  for (const w of words) weighted += w.status === 'ok' ? 1 : w.status === 'close' ? 0.6 : 0;
  const accuracy = weighted / targetTokens.length;
  let score = Math.round(accuracy * 100 - Math.min(15, extras * 3));
  score = Math.max(0, Math.min(100, score));
  const stars = score >= 90 ? 5 : score >= 75 ? 4 : score >= 60 ? 3 : score >= SCORE_BY_STARS[1] ? 2 : 1;
  return {
    score,
    stars,
    words,
    tips_zh: buildTips(targetTokens, words, transcript, confidence),
    accuracy: Math.round(accuracy * 100) / 100,
  };
}

export default { scorePronunciation, tokenize, cleanToken, wordDistance, isCloseWord, buildTips };
