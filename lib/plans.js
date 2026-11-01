/**
 * 学习计划 v3：完全由用户自定义（固定 3 节课），不再绑定任何数字人的预设场景。
 *
 * 结构：
 * {
 *   version: 3, id, teacherId, teacherName, level, goalText, title, summary,
 *   stages: [{ id, title, emoji, focus, lessonId }],
 *   lessons: {
 *     [lessonId]: {
 *       id, title, topic, emoji, level,
 *       objectives: string[], phrases: [{en,zh}], steps: [{id,title,desc}],
 *       taskPrompt, teacherIntro, status: 'generating'|'ready'|'error', error,
 *       done: boolean, doneAt
 *     }
 *   },
 *   createdAt, updatedAt, updatedAt
 * }
 * 进度：课完成数 / 总课数；阶段顺序解锁（完成上一节课才能进入下一节）。
 */
import { join } from 'node:path';
import { DATA_DIR, readJsonFile, writeJsonFile } from './config.js';
import { findCharacter, characters } from '../content/characters.js';

const PLAN_PATH = join(DATA_DIR, 'plans.json');
export const PLAN_VERSION = 3;
export const LESSON_STEPS = 3;
export const PLAN_LESSON_COUNT = 3;

export const GOAL_LABELS = {
  travel: '出国旅行',
  work: '职场英语',
  daily: '日常口语',
  exam: '考试口语',
  interest: '兴趣聊天',
};

const STAGE_META = [
  { title: '第一课', emoji: '🌱', focus: '先开口，跟读常用句' },
  { title: '第二课', emoji: '🌿', focus: '在场景里用出来' },
  { title: '第三课', emoji: '🌳', focus: '独立完成挑战' },
];

export function planPath() {
  return PLAN_PATH;
}

function makeId(prefix = 'plan') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function defaultTeacher(teacherId) {
  return findCharacter(teacherId) || characters[0];
}

function defaultSteps() {
  return [
    { id: 'repeat', title: '跟读常用句', desc: '她说一句，你重复一句，共 5 句。' },
    { id: 'practice', title: '场景练习', desc: '在场景里用刚学的句子对话。' },
    { id: 'challenge', title: '完成挑战', desc: '独立完成一次场景对话。' },
  ];
}

function skeletonLesson(index, teacher) {
  const n = index + 1;
  return {
    id: `lesson_${n}`,
    title: `第 ${n} 课 · 课件生成中`,
    topic: '',
    emoji: ['📘', '📗', '📙'][index] || '📘',
    level: 'A2',
    objectives: [],
    phrases: [],
    steps: defaultSteps(),
    taskPrompt: '',
    teacherIntro: '',
    status: 'generating',
    error: '',
    done: false,
    doneAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    teacherId: teacher.id,
  };
}

/** 用户的自由文本 → 计划骨架（3 节，课件异步生成） */
export function createUserPlan({ goalText = '', level = 'A2', teacherId = '', title = '' } = {}) {
  const teacher = defaultTeacher(teacherId);
  const cleanGoal = String(goalText || '').trim().slice(0, 500);
  const lessons = {};
  const stages = STAGE_META.map((meta, index) => {
    const lesson = skeletonLesson(index, teacher);
    lesson.level = level;
    lessons[lesson.id] = lesson;
    return {
      id: `stage_${index + 1}`,
      title: meta.title,
      emoji: meta.emoji,
      focus: meta.focus,
      lessonId: lesson.id,
    };
  });
  const plan = {
    version: PLAN_VERSION,
    id: makeId(),
    teacherId: teacher.id,
    teacherName: teacher.name,
    level,
    goalText: cleanGoal,
    title: String(title || '').trim() || `${teacher.name} 的专属英语计划`,
    summary: cleanGoal || '按你想学的场景安排 3 节课，先跟读，再场景练习，最后完成挑战。',
    stages,
    lessons,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return decoratePlan(plan);
}

export function loadPlan() {
  const data = readJsonFile(PLAN_PATH, { active: null });
  const plan = data && data.active ? data.active : null;
  if (!plan || !Array.isArray(plan.stages)) {
    if (plan) {
      // v1/v2 旧计划（绑定角色预设场景）→ 按用户要求删除，回到"请先告诉我你想学什么"
      try {
        savePlan(null);
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  if (Number(plan.version) !== PLAN_VERSION || !plan.lessons || typeof plan.lessons !== 'object') {
    try {
      savePlan(null);
    } catch {
      /* ignore */
    }
    return null;
  }
  return plan;
}

export function savePlan(plan) {
  const payload = { active: plan || null, updatedAt: Date.now() };
  writeJsonFile(PLAN_PATH, payload);
  return plan;
}

/** 生成完成后写入课件内容 */
export function fillPlanLessons(plan, generatedLessons = []) {
  if (!plan || !plan.lessons) return plan;
  const source = Array.isArray(generatedLessons) ? generatedLessons : [];
  const lessonIds = plan.stages.map((stage) => stage.lessonId);
  const nextLessons = { ...plan.lessons };
  lessonIds.forEach((lessonId, index) => {
    const current = nextLessons[lessonId] || skeletonLesson(index, defaultTeacher(plan.teacherId));
    const generated = source[index];
    if (!generated) {
      nextLessons[lessonId] = {
        ...current,
        status: 'error',
        error: '课件生成不完整，请点击重试',
        updatedAt: Date.now(),
      };
      return;
    }
    nextLessons[lessonId] = {
      ...current,
      ...generated,
      id: lessonId,
      level: generated.level || plan.level || current.level,
      emoji: generated.emoji || current.emoji,
      steps:
        Array.isArray(generated.steps) && generated.steps.length >= 3
          ? generated.steps.slice(0, 3)
          : defaultSteps(),
      phrases: Array.isArray(generated.phrases) ? generated.phrases.slice(0, 6) : [],
      objectives: Array.isArray(generated.objectives) ? generated.objectives.slice(0, 4) : [],
      status: 'ready',
      error: '',
      updatedAt: Date.now(),
    };
  });
  const stages = plan.stages.map((stage, index) => {
    const lesson = nextLessons[stage.lessonId];
    return {
      ...stage,
      title: STAGE_META[index] ? STAGE_META[index].title : stage.title,
      label: lesson ? lesson.title : stage.label,
      emoji: STAGE_META[index] ? STAGE_META[index].emoji : stage.emoji,
    };
  });
  return decoratePlan({ ...plan, stages, lessons: nextLessons, updatedAt: Date.now() });
}

/** 生成失败：标记每个生成中的课件为 error */
export function setPlanLessonError(plan, message = '课件生成失败') {
  if (!plan || !plan.lessons) return plan;
  const lessons = { ...plan.lessons };
  for (const id of Object.keys(lessons)) {
    if (lessons[id].status === 'generating') {
      lessons[id] = { ...lessons[id], status: 'error', error: String(message || '').slice(0, 200), updatedAt: Date.now() };
    }
  }
  return decoratePlan({ ...plan, lessons, updatedAt: Date.now() });
}

/** 课件生成失败后重试：把课件重置为 generating 状态（保留老师/目标） */
export function resetPlanForGeneration(plan) {
  if (!plan || !plan.lessons) return plan;
  const lessons = {};
  for (const id of Object.keys(plan.lessons)) {
    lessons[id] = { ...plan.lessons[id], status: 'generating', error: '', phrases: [], objectives: [], taskPrompt: '', teacherIntro: '', updatedAt: Date.now() };
  }
  return decoratePlan({ ...plan, lessons, updatedAt: Date.now() });
}

/** 更换整份计划的老师（可选任意角色；不影响进度） */
export function setPlanTeacher(plan, teacherId) {
  if (!plan) return null;
  const teacher = findCharacter(teacherId);
  if (!teacher) throw new Error('角色不存在');
  const lessons = { ...plan.lessons };
  for (const id of Object.keys(lessons)) lessons[id] = { ...lessons[id], teacherId: teacher.id };
  return decoratePlan({
    ...plan,
    teacherId: teacher.id,
    teacherName: teacher.name,
    lessons,
    updatedAt: Date.now(),
  });
}

/** 更新计划元信息（目标/水平；老师用 setPlanTeacher） */
export function updatePlan(plan, patch = {}) {
  if (!plan) return null;
  const next = { ...plan, updatedAt: Date.now() };
  if (typeof patch.goalText === 'string' && patch.goalText.trim()) {
    next.goalText = patch.goalText.trim().slice(0, 500);
    next.summary = next.goalText;
  }
  if (patch.level) next.level = patch.level;
  if (patch.teacherId) return setPlanTeacher(next, patch.teacherId);
  return decoratePlan(next);
}

export function getPlanLesson(plan, lessonId) {
  if (!plan || !plan.lessons) return null;
  const id = String(lessonId || '').trim();
  if (!id) return null;
  return plan.lessons[id] || null;
}

export function listPlanLessons(plan) {
  if (!plan || !plan.lessons) return [];
  return plan.stages.map((stage, index) => {
    const lesson = plan.lessons[stage.lessonId] || null;
    return {
      ...(lesson || {}),
      stageId: stage.id,
      stageTitle: stage.title,
      index,
    };
  });
}

/**
 * 记录某节课的中途进度（用户退出后下次从这里继续）。
 * resume: { step:1-3, phraseIdx, practiceTurns, challengeTurns, updatedAt }
 */
export function saveLessonProgress(plan, { lessonId = '', step = 1, phraseIdx = 0, practiceTurns = 0, challengeTurns = 0 } = {}) {
  const decorated = decoratePlan(plan);
  if (!decorated) return { ok: false, reason: 'no-plan' };
  const lesson = decorated.lessons[lessonId];
  if (!lesson) return { ok: false, reason: 'not-found' };
  if (lesson.status !== 'ready') return { ok: false, reason: 'not-ready' };
  if (lesson.done) return { ok: false, reason: 'done' };
  const phraseCount = Array.isArray(lesson.phrases) ? lesson.phrases.length : 5;
  const safeStep = Math.max(1, Math.min(3, Math.floor(Number(step) || 1)));
  const safePhrase = Math.max(0, Math.min(phraseCount, Math.floor(Number(phraseIdx) || 0)));
  const resume = {
    step: safeStep,
    phraseIdx: safePhrase,
    practiceTurns: Math.max(0, Math.min(50, Math.floor(Number(practiceTurns) || 0))),
    challengeTurns: Math.max(0, Math.min(50, Math.floor(Number(challengeTurns) || 0))),
    updatedAt: Date.now(),
  };
  const lessons = { ...decorated.lessons, [lessonId]: { ...lesson, resume, updatedAt: Date.now() } };
  return { ok: true, resume, plan: decoratePlan({ ...decorated, lessons, updatedAt: Date.now() }) };
}

/** 清除恢复点（重新开始 / 已完成） */
export function clearLessonProgress(plan, lessonId = '') {
  const decorated = decoratePlan(plan);
  if (!decorated || !decorated.lessons[lessonId]) return decorated;
  const lessons = { ...decorated.lessons, [lessonId]: { ...decorated.lessons[lessonId], resume: null, updatedAt: Date.now() } };
  return decoratePlan({ ...decorated, lessons, updatedAt: Date.now() });
}

/** 完成一节课（必须 3 个教学步骤；阶段必须已解锁） */
export function completeLesson(plan, { lessonId = '', stageId = '', stepsCompleted = 0 } = {}) {
  const decorated = decoratePlan(plan);
  if (!decorated) return { plan: null, completed: false, reason: 'no-plan' };
  const stage = decorated.stages.find((item) => item.id === (stageId || '') || (decorated.lessons[item.lessonId] || {}).id === lessonId || item.lessonId === lessonId);
  if (!stage) return { plan: decorated, completed: false, reason: 'not-found' };
  const lesson = decorated.lessons[stage.lessonId];
  if (!lesson) return { plan: decorated, completed: false, reason: 'not-found' };
  if (!stage.unlocked) return { plan: decorated, completed: false, reason: 'locked' };
  if (lesson.status !== 'ready') return { plan: decorated, completed: false, reason: 'not-ready' };
  if (lesson.done) return { plan: decorated, completed: true, alreadyDone: true, next: decorated.next };
  const steps = Math.max(0, Math.floor(Number(stepsCompleted) || 0));
  if (steps < LESSON_STEPS) {
    return { plan: decorated, completed: false, reason: 'steps-incomplete', requiredSteps: LESSON_STEPS };
  }
  const lessons = {
    ...decorated.lessons,
    [lesson.id]: { ...lesson, done: true, doneAt: Date.now(), resume: null, updatedAt: Date.now() },
  };
  const nextPlan = decoratePlan({ ...decorated, lessons, updatedAt: Date.now() });
  return { plan: nextPlan, completed: true, lesson: lesson.id, next: nextPlan.next };
}

/** 计算进度/锁定/下一课 */
export function decoratePlan(plan) {
  if (!plan || !Array.isArray(plan.stages)) return plan;
  const lessons = plan.lessons && typeof plan.lessons === 'object' ? plan.lessons : {};
  const stages = plan.stages.map((stage, index) => {
    const lesson = lessons[stage.lessonId] || null;
    const done = !!(lesson && lesson.done);
    const prev = index > 0 ? plan.stages[index - 1] : null;
    const prevLesson = prev ? lessons[prev.lessonId] : null;
    const prevDone = !prev || !!(prevLesson && prevLesson.done);
    return {
      ...stage,
      title: stage.title || (STAGE_META[index] ? STAGE_META[index].title : `第 ${index + 1} 课`),
      emoji: stage.emoji || (STAGE_META[index] ? STAGE_META[index].emoji : '📘'),
      focus: stage.focus || (STAGE_META[index] ? STAGE_META[index].focus : ''),
      lesson: lesson
        ? {
            id: lesson.id,
            title: lesson.title,
            topic: lesson.topic || '',
            emoji: lesson.emoji || stage.emoji || '📘',
            status: lesson.status,
            done,
            objectives: Array.isArray(lesson.objectives) ? lesson.objectives : [],
            phrases: Array.isArray(lesson.phrases) ? lesson.phrases : [],
            steps: Array.isArray(lesson.steps) ? lesson.steps : defaultSteps(),
            taskPrompt: lesson.taskPrompt || '',
            teacherIntro: lesson.teacherIntro || '',
            error: lesson.error || '',
            resume: lesson.resume && typeof lesson.resume === 'object' ? { ...lesson.resume } : null,
          }
        : null,
      done,
      progress: done ? 100 : 0,
      unlocked: index === 0 || prevDone,
    };
  });
  const total = stages.length || 1;
  const doneCount = stages.filter((stage) => stage.done).length;
  const progress = Math.round((doneCount / total) * 100);
  const nextStage = stages.find((stage) => stage.unlocked && !stage.done && stage.lesson) || null;
  const next = nextStage
    ? {
        stageId: nextStage.id,
        stageTitle: nextStage.title,
        lessonId: nextStage.lessonId,
        label: nextStage.lesson.title,
        emoji: nextStage.lesson.emoji,
        teacherId: plan.teacherId,
        teacherName: plan.teacherName,
      }
    : null;
  const generating = Object.values(lessons).some((lesson) => lesson && lesson.status === 'generating');
  const error = Object.values(lessons).find((lesson) => lesson && lesson.status === 'error') || null;
  void total;
  return {
    ...plan,
    version: PLAN_VERSION,
    stages,
    lessons,
    progress,
    totalLessons: stages.length,
    doneLessons: doneCount,
    allDone: doneCount === stages.length,
    generating,
    hasError: !!error,
    errorMessage: error ? error.error || '课件生成失败' : '',
    next,
  };
}

/** 对外精简（前端只读，不泄露内部字段） */
export function publicPlan(plan) {
  const decorated = decoratePlan(plan);
  if (!decorated) return null;
  return decorated;
}

export default {
  loadPlan,
  savePlan,
  createUserPlan,
  fillPlanLessons,
  setPlanLessonError,
  setPlanTeacher,
  resetPlanForGeneration,
  updatePlan,
  completeLesson,
  saveLessonProgress,
  clearLessonProgress,
  decoratePlan,
  getPlanLesson,
  listPlanLessons,
  publicPlan,
  LESSON_STEPS,
  PLAN_LESSON_COUNT,
  GOAL_LABELS,
};
