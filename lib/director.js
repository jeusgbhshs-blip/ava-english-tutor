/**
 * 对话导演：每轮先规划一个「不重复、有角度」的下一步，再交给主模型回复。
 * 失败时用规则计划兜底（不阻塞对话）。
 */
import { chatJSON } from './llmJson.js';
import { buildDirectorMessages } from '../content/prompts.js';

export const ANGLES = ['细节追问', '反例', '跨领域联想', '个人故事', '观点碰撞', '知识关联', '情绪共鸣'];

function hashPick(text, arr) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

/** 规则版计划（无 Key / 模型失败时） */
export function rulePlan({ userMessage = '', history = [], recentQuestions = [], kbTitles = [], kbMode = 'free' } = {}) {
  const text = String(userMessage || '').trim();
  const asked = history.filter((m) => m && m.role === 'assistant').length;
  const angle = hashPick(text + asked, kbMode === 'grounded' ? ['知识关联', '观点碰撞', '细节追问'] : ANGLES);
  const short = text.length < 12;
  return {
    angle,
    stance: 'respond with a concrete opinion and one specific example, not a generic comment',
    question: !short && asked % 2 === 0,
    hook: kbTitles.length ? `connect to 《${kbTitles[0]}》 only if relevant` : 'pick out one concrete detail from the student message and build on it',
    avoid: recentQuestions.slice(-8),
    kbUse: kbMode,
    source: 'rule',
  };
}

/** 规范化模型返回的计划 */
export function normalizePlan(parsed, { recentQuestions = [], kbMode = 'free' } = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const angle = ANGLES.includes(parsed.angle) ? parsed.angle : null;
  if (!angle) return null;
  const avoid = [
    ...(Array.isArray(parsed.avoid) ? parsed.avoid.map((x) => String(x).slice(0, 120)).filter(Boolean) : []),
    ...recentQuestions,
  ];
  return {
    angle,
    stance: String(parsed.stance || '').slice(0, 200),
    question: parsed.question === true,
    hook: String(parsed.hook || '').slice(0, 200),
    avoid: [...new Set(avoid)].slice(0, 8),
    kbUse: kbMode,
    source: 'model',
  };
}

/**
 * 生成这一轮的计划。
 * @returns {Promise<object>} plan（永不 throw）
 */
export async function planTurn({
  settings = null,
  character = null,
  userMessage = '',
  history = [],
  memoryText = '',
  recentQuestions = [],
  kbTitles = [],
  kbMode = 'free',
} = {}) {
  const fallback = () => rulePlan({ userMessage, history, recentQuestions, kbTitles, kbMode });
  if (!settings?.apiKey) return fallback();
  try {
    const { parsed } = await chatJSON({
      settings,
      messages: buildDirectorMessages({
        character,
        userMessage,
        history,
        memoryText,
        recentQuestions,
        kbTitles,
        kbMode,
      }),
      temperature: 0.8,
      maxTokens: 500,
      timeoutMs: 12_000,
    });
    const normalized = normalizePlan(parsed, { recentQuestions, kbMode });
    if (!normalized) return fallback();
    // 防呆：最近对话里已有事实时，绝不允许导演计划「记不住/忘了/模糊」这类拒绝记忆的 stance
    const planText = `${normalized.stance} ${normalized.hook}`;
    const denial = /记不住|不记得|忘了|记不清|记忆.*(模糊|不好)|don'?t remember|can'?t remember|blurr/i.test(planText);
    const hasRecentFacts = Array.isArray(history) && history.some((m) => m && m.role === 'user' && String(m.content || '').trim().length > 8);
    if (denial && hasRecentFacts) {
      return {
        ...normalized,
        angle: '情绪共鸣',
        stance: 'answer the student\'s memory question accurately using the exact facts from the recent conversation; never claim you forgot them',
        hook: 'quote the specific detail the student mentioned earlier (name/colour/plan) and continue warmly from it',
        question: false,
        source: 'guard',
      };
    }
    return normalized;
  } catch {
    return fallback();
  }
}

export default { planTurn, rulePlan, normalizePlan, ANGLES };
