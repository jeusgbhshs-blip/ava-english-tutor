/**
 * 对话总结服务：有 Key 走大模型严格 JSON，失败/无 Key 自动降级规则化 demo 总结。
 */
import { buildSummaryMessages } from '../content/prompts.js';
import { buildDemoSummary } from '../content/demo.js';
import { loadSettings } from './config.js';
import { friendlyErrorMessage, joinUrl } from './llm.js';

const EMPTY = {
  summary_zh: '',
  topics_zh: [],
  strengths_zh: [],
  improvements_zh: [],
  corrections: [],
  keyPatterns: [],
  keyWords: [],
  encouragement_zh: '',
};

function str(value, max = 400) {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}

function strArray(value, maxItems = 4, maxLen = 60) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => str(v, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeKeyPatterns(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const pattern = str(item.pattern || item.en, 120);
    if (!pattern || !/[a-zA-Z]/.test(pattern)) continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      pattern,
      meaning: str(item.meaning || item.meaning_zh, 160),
      example: str(item.example, 240),
      usage_zh: str(item.usage_zh, 200),
    });
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeCorrections(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      original: str(c.original, 200),
      corrected: str(c.corrected, 200),
      explanation_zh: str(c.explanation_zh, 300),
    }))
    .filter((c) => c.corrected)
    .slice(0, 3);
}

/** 规范化 keyWords：去重、清洗、限制 0–8 个（调用方保证至少尝试补足 3 个） */
export function normalizeKeyWords(list, max = 8) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const word = str(item.word, 60);
    if (!word || !/[a-zA-Z]/.test(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      word,
      phonetic: str(item.phonetic, 60),
      meaning: str(item.meaning, 120),
      example: str(item.example, 240),
      why_zh: str(item.why_zh, 160),
    });
    if (out.length >= max) break;
  }
  return out;
}

/** 把模型输出（可能带 markdown 围栏）解析成总结对象；解析失败抛错 */
export function parseSummaryJson(text) {
  let raw = str(text, 20000);
  if (!raw) throw new Error('总结内容为空');
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('总结内容不是合法 JSON');
  const data = JSON.parse(raw.slice(start, end + 1));
  if (!data || typeof data !== 'object') throw new Error('总结 JSON 结构不正确');
  return data;
}

/** 规范化总结结构（纯函数，QA 可单测） */
export function normalizeSummary(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    summary_zh: str(data.summary_zh, 800) || EMPTY.summary_zh,
    topics_zh: strArray(data.topics_zh, 4, 30),
    strengths_zh: strArray(data.strengths_zh, 3, 160),
    improvements_zh: strArray(data.improvements_zh, 3, 160),
    corrections: normalizeCorrections(data.corrections),
    keyPatterns: normalizeKeyPatterns(data.keyPatterns),
    keyWords: normalizeKeyWords(data.keyWords),
    encouragement_zh: str(data.encouragement_zh, 120),
  };
}

async function readErrorBody(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json?.error?.message || json?.message || text;
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  return `HTTP ${res.status} ${res.statusText} ${String(detail).slice(0, 300)}`;
}

/** 调用大模型生成总结（非流式，严格 JSON） */
export async function requestLiveSummary({ settings, messages, level = 'A2', teacherName = 'Ava', signal }) {
  if (!settings?.apiKey) throw new Error('缺少 API Key');
  const res = await fetch(joinUrl(settings.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`,
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      temperature: 0.35,
      max_tokens: 1400,
      messages: buildSummaryMessages({ messages, level, teacherName }),
    }),
    signal: signal || AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(await readErrorBody(res));
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  const parsed = parseSummaryJson(content);
  return normalizeSummary(parsed);
}

/**
 * 生成对话总结；永不 throw（失败降级 demo）。
 * @param {{messages:{role:string,content:string}[], level?:string, teacherName?:string, mode?:string, settings?:object}} opts
 */
export async function summarizeConversation({
  messages = [],
  level = 'A2',
  teacherName = 'Ava',
  mode = 'free',
  settings = loadSettings(),
} = {}) {
  const msgs = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));

  const demo = buildDemoSummary(msgs, { teacherName, level });
  const demoResult = {
    ok: true,
    demo: true,
    ...normalizeSummary(demo),
    summary_zh: demo.summary_zh,
    topics_zh: demo.topics_zh,
    strengths_zh: demo.strengths_zh,
    improvements_zh: demo.improvements_zh,
    corrections: demo.corrections,
    keyWords: demo.keyWords,
    encouragement_zh: demo.encouragement_zh,
  };

  if (!settings?.apiKey) return demoResult;

  try {
    const live = await requestLiveSummary({ settings, messages: msgs, level, teacherName });
    // 模型漏给词时用演示词表补足到至少 3 个（去重）
    if (live.keyWords.length < 3) {
      const seen = new Set(live.keyWords.map((w) => w.word.toLowerCase()));
      for (const word of demo.keyWords) {
        if (live.keyWords.length >= 3) break;
        if (seen.has(word.word.toLowerCase())) continue;
        seen.add(word.word.toLowerCase());
        live.keyWords.push(word);
      }
    }
    if (!live.summary_zh) live.summary_zh = demo.summary_zh;
    if (!live.topics_zh.length) live.topics_zh = demo.topics_zh;
    if (!live.keyPatterns || !live.keyPatterns.length) {
      live.keyPatterns = Array.isArray(demo.keyPatterns) ? demo.keyPatterns : [];
    }
    if (!live.encouragement_zh) live.encouragement_zh = demo.encouragement_zh;
    return { ok: true, demo: false, ...live, mode };
  } catch (err) {
    return {
      ...demoResult,
      fallback: true,
      reason: friendlyErrorMessage(err),
    };
  }
}

export default { summarizeConversation, requestLiveSummary, parseSummaryJson, normalizeSummary, normalizeKeyWords, normalizeKeyPatterns };
