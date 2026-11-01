/**
 * 用户自定义计划的课件生成：
 * 用户用自由文本描述想学的场景 → 生成 3 节英语课（每节 5 句常用句 + 3 步教学）。
 * 生成在后台进行，课程页轮询 /api/plan 看到 status: ready。
 */
import { chatJSON } from './llmJson.js';
import { loadSettings } from './config.js';
import { loadPlan, savePlan, fillPlanLessons, setPlanLessonError, PLAN_LESSON_COUNT } from './plans.js';
import { buildPlanLessonsMessages } from '../content/prompts.js';

const generating = new Set();

export function isPlanGenerating(planId = '') {
  return generating.has(String(planId));
}

function cleanText(value, max = 400) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeLesson(raw, index, plan) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanText(raw.title || raw.name || raw.topic, 80);
  const topic = cleanText(raw.topic || raw.title || '', 120);
  const phrases = (Array.isArray(raw.phrases) ? raw.phrases : [])
    .map((p) => {
      if (!p) return null;
      const en = cleanText(typeof p === 'string' ? p : p.en || p.english, 180);
      const zh = cleanText(typeof p === 'string' ? '' : p.zh || p.chinese || p.meaning, 180);
      return en ? { en, zh } : null;
    })
    .filter(Boolean)
    .slice(0, 5);
  const objectives = (Array.isArray(raw.objectives) ? raw.objectives : [])
    .map((o) => cleanText(typeof o === 'string' ? o : o && (o.zh || o.text), 100))
    .filter(Boolean)
    .slice(0, 4);
  if (!title || phrases.length < 3) return null;
  return {
    title,
    topic: topic || title,
    emoji: cleanText(raw.emoji, 8) || ['📘', '📗', '📙'][index] || '📘',
    level: plan.level || 'A2',
    objectives: objectives.length ? objectives : [`学会「${title}」场景的常用表达`, '能听懂并回应自然语速', '敢于开口完成一次完整对话'],
    phrases,
    steps: [
      { id: 'repeat', title: '跟读常用句', desc: `她读一句，你重复一句，共 ${phrases.length} 句。` },
      { id: 'practice', title: '场景练习', desc: `在「${title}」场景里用刚学的句子对话（至少 2 轮）。` },
      { id: 'challenge', title: '完成挑战', desc: '独立完成一次完整的场景对话，用上至少 3 句目标表达。' },
    ],
    taskPrompt: cleanText(raw.taskPrompt || raw.task || `完成一次「${title}」场景对话，并用上今天学的常用句。`, 200),
    teacherIntro: cleanText(
      raw.teacherIntro ||
        `Today we are going to practice "${title}". I will teach you five useful phrases, then we will use them in a real conversation.`,
      400,
    ),
  };
}

function normalizeResult(parsed, plan) {
  const rawLessons = Array.isArray(parsed && parsed.lessons)
    ? parsed.lessons
    : Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed.data)
        ? parsed.data
        : [];
  const lessons = rawLessons.map((raw, index) => normalizeLesson(raw, index, plan)).filter(Boolean);
  if (lessons.length < PLAN_LESSON_COUNT) return null;
  return {
    planTitle: cleanText(parsed && (parsed.planTitle || parsed.title), 60),
    lessons: lessons.slice(0, PLAN_LESSON_COUNT),
  };
}

/** 后台生成课件（同一 plan 只跑一个任务） */
export function generatePlanLessonsInBackground(planId = '') {
  const id = String(planId || '');
  if (!id || generating.has(id)) return false;
  generating.add(id);
  void (async () => {
    let revision;
    try {
      const plan = loadPlan();
      if (!plan || plan.id !== id || !plan.generating) return;
      revision = Number(plan.generationRevision) || 0;
      const settings = loadSettings();
      if (!settings.apiKey) throw new Error('未配置模型 API Key，无法生成课件');
      const result = await chatJSON({
        settings,
        messages: buildPlanLessonsMessages({
          goalText: plan.goalText,
          level: plan.level,
          teacherName: plan.teacherName,
        }),
        temperature: 0.7,
        maxTokens: 4000,
        timeoutMs: 120_000,
        json: true,
      });
      const normalized = normalizeResult(result.parsed, plan);
      if (!normalized) throw new Error('课件生成格式不完整，请重试');
      const current = loadPlan();
      if (!current || current.id !== id || (Number(current.generationRevision) || 0) !== revision) return;
      const filled = fillPlanLessons(current, normalized.lessons);
      if (normalized.planTitle) {
        filled.title = normalized.planTitle.slice(0, 60);
      }
      savePlan(filled);
    } catch (err) {
      const current = loadPlan();
      if (current && current.id === id && (Number(current.generationRevision) || 0) === revision) {
        savePlan(setPlanLessonError(current, err.message || '课件生成失败'));
      }
    } finally {
      generating.delete(id);
      // An edit can arrive while a generation is in flight. Discard that result
      // above, then resume only the latest revision of the still-active plan.
      const latest = loadPlan();
      if (latest && latest.id === id && latest.generating && revision !== undefined &&
          (Number(latest.generationRevision) || 0) !== revision) {
        generatePlanLessonsInBackground(id);
      }
    }
  })();
  return true;
}

/** 同步生成（测试用；生产走后台） */
export async function generatePlanLessons({ goalText = '', level = 'A2', teacherName = 'Ava' } = {}) {
  const settings = loadSettings();
  if (!settings.apiKey) throw new Error('未配置模型 API Key');
  const result = await chatJSON({
    settings,
    messages: buildPlanLessonsMessages({ goalText, level, teacherName }),
    temperature: 0.7,
    maxTokens: 4000,
    timeoutMs: 120_000,
    json: true,
  });
  return result.parsed;
}

export default { generatePlanLessonsInBackground, generatePlanLessons, isPlanGenerating };
