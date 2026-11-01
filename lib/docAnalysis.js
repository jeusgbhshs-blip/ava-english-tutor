/**
 * 阅读材料分析：有 Key 走大模型严格 JSON，失败/无 Key 自动降级规则化 demo 分析。
 */
import { buildDocAnalysisMessages } from '../content/prompts.js';
import { buildDemoDocAnalysis } from '../content/demo.js';
import { loadSettings } from './config.js';
import { friendlyErrorMessage, joinUrl } from './llm.js';

function str(value, max = 400) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeKeyPoints(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({ en: str(p.en, 400), zh: str(p.zh, 240) }))
    .filter((p) => p.en)
    .slice(0, 6);
}

export function normalizeKeyWords(list, max = 10) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const word = str(item.word, 60);
    if (!word || !/[A-Za-z]/.test(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      word,
      phonetic: str(item.phonetic, 60),
      meaning: str(item.meaning, 160),
      example: str(item.example, 300),
      why_zh: str(item.why_zh, 160),
    });
    if (out.length >= max) break;
  }
  return out;
}

function normalizeQuestions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((q) => q && typeof q === 'object')
    .map((q) => ({ en: str(q.en, 240), zh: str(q.zh, 160) }))
    .filter((q) => q.en)
    .slice(0, 6);
}

export function countWords(text) {
  return String(text || '').split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

/** 规范化分析结构（纯函数，QA 可单测） */
export function normalizeDocAnalysis(raw, { text = '', name = '' } = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const analysis = {
    summary_zh: str(data.summary_zh, 800),
    keyPoints: normalizeKeyPoints(data.keyPoints),
    keyWords: normalizeKeyWords(data.keyWords),
    questions: normalizeQuestions(data.questions),
    readAloud: str(data.readAloud, 1200),
    wordCount: Number.isFinite(data.wordCount) && Number(data.wordCount) > 0 ? Math.round(Number(data.wordCount)) : countWords(text),
  };
  if (!analysis.summary_zh) analysis.summary_zh = `这份材料${name ? `《${name}》` : ''}共 ${analysis.wordCount} 个英文单词，建议先听我读一遍要点，再逐段精读。`;
  if (!analysis.readAloud) analysis.readAloud = String(text || '').slice(0, 800);
  return analysis;
}

/** 从模型输出中解析 JSON（允许 markdown 围栏） */
export function parseDocAnalysisJson(text) {
  let raw = str(text, 30000);
  if (!raw) throw new Error('分析内容为空');
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('分析内容不是合法 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

async function readErrorBody(res) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      detail = json?.error?.message || json?.message || body;
    } catch {
      detail = body;
    }
  } catch {
    /* ignore */
  }
  return `HTTP ${res.status} ${res.statusText} ${String(detail).slice(0, 300)}`;
}

/** 调用大模型做阅读分析（非流式，严格 JSON） */
export async function requestLiveDocAnalysis({ settings, text, name = '', level = 'A2', signal }) {
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
      temperature: 0.3,
      max_tokens: 1800,
      messages: buildDocAnalysisMessages({ text, name, level }),
    }),
    signal: signal || AbortSignal.timeout(75_000),
  });
  if (!res.ok) throw new Error(await readErrorBody(res));
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  const parsed = parseDocAnalysisJson(content);
  return normalizeDocAnalysis(parsed, { text, name });
}

/**
 * 分析一份文档；永不 throw（无 Key / 失败时降级 demo）。
 * @param {{doc:object, level?:string, settings?:object}} opts
 * @returns {Promise<{analysis:object, demo:boolean, fallback?:boolean, reason?:string}>}
 */
export async function analyzeDocument({ doc, level = 'A2', settings = loadSettings() }) {
  const text = String(doc?.text || '');
  const name = String(doc?.name || '');
  const demoAnalysis = normalizeDocAnalysis(buildDemoDocAnalysis({ text, name, level }), { text, name });

  if (!settings?.apiKey) {
    return { analysis: { ...demoAnalysis, demo: true }, demo: true };
  }
  try {
    const live = await requestLiveDocAnalysis({ settings, text, name, level });
    // 模型漏项时补足关键字段，保证 UI 可用
    if (!live.keyPoints.length) live.keyPoints = demoAnalysis.keyPoints;
    if (live.keyWords.length < 3) live.keyWords = normalizeKeyWords([...live.keyWords, ...demoAnalysis.keyWords]);
    if (!live.questions.length) live.questions = demoAnalysis.questions;
    return { analysis: live, demo: false };
  } catch (err) {
    return {
      analysis: { ...demoAnalysis, demo: true },
      demo: true,
      fallback: true,
      reason: friendlyErrorMessage(err),
    };
  }
}

export default { analyzeDocument, normalizeDocAnalysis, normalizeKeyWords, parseDocAnalysisJson, countWords };
