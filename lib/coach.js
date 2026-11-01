/**
 * 教练分析服务（豆包实时语音模式使用）：只分析学生这句话，不产生对话回复。
 * 有文本模型 Key 走严格 JSON；失败/无 Key 降级规则版（纠错 + 中文求助 + 生词）。
 */
import { buildCoachMessages } from '../content/prompts.js';
import { detectCorrections, buildChineseHelp, detectChinese } from '../content/demo.js';
import { loadSettings } from './config.js';
import { normalizeFeedback, friendlyErrorMessage, joinUrl } from './llm.js';

function demoCoachFeedback(message) {
  const text = String(message || '');
  if (detectChinese(text)) {
    const chineseHelp = buildChineseHelp(text);
    return {
      corrections: [],
      better: [],
      newWords: [],
      encouragement_zh: chineseHelp?.unmatched
        ? '遇到不会说的可以用简单英文解释，也可以先在设置里填入文本模型 Key 获得更准确的中文翻译。'
        : '这句英文表达已经给你了，点「跟我读」念一遍会记得更牢。',
      followUp: '',
      chineseHelp,
    };
  }
  const corrections = detectCorrections(text).slice(0, 2);
  return {
    corrections,
    better: [],
    newWords: [],
    encouragement_zh: corrections.length
      ? '我帮你把这两处改得更自然了，读一遍试试。'
      : '这句话没有明显语法问题，继续说下去。',
    followUp: '',
    chineseHelp: null,
  };
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

/**
 * 生成教练反馈。
 * @param {{message:string, level?:string, mode?:string, history?:object[]}} opts
 * @returns {Promise<{demo:boolean, fallback?:boolean, reason?:string, feedback:object}>}
 */
export async function coachAnalysis({ message, level = 'A2', mode = 'free', history = [], settings = loadSettings() } = {}) {
  const text = String(message || '').trim().slice(0, 1200);
  if (!text) {
    return { demo: true, feedback: demoCoachFeedback('') };
  }
  const demo = demoCoachFeedback(text);
  if (!settings?.apiKey) {
    return { demo: true, feedback: demo };
  }
  try {
    const messages = buildCoachMessages({ message: text, level, mode, history });
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
        max_tokens: 800,
        messages,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(await readErrorBody(res));
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    let raw = String(content || '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('教练分析返回的不是 JSON');
    const feedback = normalizeFeedback(JSON.parse(raw.slice(start, end + 1)));
    // 中文输入时 corrections 必须为空；若模型给出错误纠错则清掉
    if (detectChinese(text)) {
      feedback.corrections = [];
      if (!feedback.chineseHelp) feedback.chineseHelp = buildChineseHelp(text);
    }
    if (!feedback.newWords.length) feedback.newWords = demo.newWords;
    if (!feedback.encouragement_zh) feedback.encouragement_zh = demo.encouragement_zh;
    if (detectChinese(text) && !feedback.chineseHelp) feedback.chineseHelp = demo.chineseHelp;
    return { demo: false, feedback };
  } catch (err) {
    return {
      demo: true,
      fallback: true,
      reason: friendlyErrorMessage(err),
      feedback: demo,
    };
  }
}

export default { coachAnalysis };
