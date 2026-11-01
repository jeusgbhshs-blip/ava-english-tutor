/**
 * Ava 助手（Midoo 式学习管家）：识别意图 → 生成回复 + 页面动作。
 * 有豆包凭据时用「文本模式」实时会话润色回复；失败/无凭据用规则模板，接口永不失败。
 */
import { VolcRealtimeSession } from './volcRealtime.js';
import { loadSettings } from './config.js';
import { characters, findCharacter, DEFAULT_CHARACTER_ID } from '../content/characters.js';
import { createUserPlan, updatePlan, setPlanTeacher, GOAL_LABELS } from './plans.js';

const ASSISTANT_PERSONA =
  '你是 Ava，一个亲切、利落的英语学习管家，帮助用户制定和调整学习计划、推荐练习场景、提醒复习。' +
  '回复用简体中文口语，最多两句话，不要列表、不要 emoji、不要解释系统。' +
  '不要编造用户没有说过的计划细节。';

const MAX_HISTORY = 6;

/** 从消息里猜学习目标 */
export function detectGoal(text) {
  const t = String(text || '');
  if (/旅行|旅游|出国|自由行|travel/i.test(t)) return 'travel';
  if (/工作|职场|商务|面试|开会|business|work/i.test(t)) return 'work';
  if (/考试|雅思|托福|口语考试|exam|ielts|toefl/i.test(t)) return 'exam';
  if (/兴趣|爱好|聊天|追剧|电影|游戏|音乐|interest/i.test(t)) return 'interest';
  return 'daily';
}

/** 从消息里猜 CEFR 等级 */
export function detectLevel(text) {
  const t = String(text || '');
  const m = t.match(/\b(A1|A2|B1|B2|C1)\b/i);
  if (m) return m[1].toUpperCase();
  if (/零基础|入门|初学/.test(t)) return 'A1';
  if (/初级|基础/.test(t)) return 'A2';
  if (/中级|进阶/.test(t)) return 'B1';
  if (/高级|流利/.test(t)) return 'B2';
  return '';
}

/** 从消息里猜角色 */
export function detectCharacterId(text, fallback = DEFAULT_CHARACTER_ID) {
  const t = String(text || '');
  for (const c of characters) {
    if (t.includes(c.name) || t.includes(c.nameZh) || t.includes(c.city) || t.includes(c.cityEn)) return c.id;
  }
  return fallback;
}

/** 规则意图识别 */
export function detectIntent(message) {
  const t = String(message || '').trim();
  if (!t) return { type: 'chat' };
  // 先判断“调整/更新现有计划”，避免“帮我更新一下现在的学习计划”被误判为新建
  if (/更新|调整|修改|更改|换个目标|换目标|现在的计划|当前计划/.test(t)) return { type: 'update_plan' };
  if (/创建|制定|生成|定个|来一个|安排.*计划|学习计划|做个计划|新计划/.test(t)) return { type: 'create_plan' };
  // 用户直接说“我想学 / 想练 / 想学某某场景”也要能生成计划
  if (/我想学|想学|想练|想学习|要学|想练练|帮我.{0,6}(学|练|安排)|安排.{0,6}(学|练)/.test(t)) return { type: 'create_plan' };
  if (/复习|单词|背词|回顾|错词/.test(t)) return { type: 'review_words' };
  if (/场景|练练|练习对话|找.*聊|打电话|通话|角色/.test(t)) return { type: 'open_scene' };
  if (/偏好|目标|水平|等级|设置/.test(t)) return { type: 'open_tab', tab: 'profile' };
  if (/反馈|建议|意见|问题|bug|不好用/.test(t)) return { type: 'feedback' };
  if (/你好|hi|hello|在吗|嗨/i.test(t)) return { type: 'greeting' };
  return { type: 'chat' };
}

/** 规则版回复模板（同时包含动作） */
export function buildAssistantReply({ message, characterId = DEFAULT_CHARACTER_ID, currentPlan = null, level = 'A2' } = {}) {
  const text = String(message || '').trim();
  const intent = detectIntent(text);
  const goal = detectGoal(text);
  const detectedLevel = detectLevel(text) || level;
  const charId = detectCharacterId(text, characterId);
  const character = findCharacter(charId) || characters[0];
  const goalLabel = GOAL_LABELS[goal] || GOAL_LABELS.daily;

  switch (intent.type) {
    case 'create_plan': {
      const plan = createUserPlan({ goalText: text, level: detectedLevel, teacherId: charId });
      return {
        reply: `好，按你说的内容排了 3 节课，正在生成每节课的常用句；去「课程」页就能看到，老师默认是 ${character.name}，也可以换。`,
        action: { type: 'create_plan', payload: plan },
        demo: true,
      };
    }
    case 'update_plan': {
      const plan = currentPlan
        ? updatePlan(currentPlan, {
            ...(text.length > 12 ? { goalText: text } : {}),
            level: detectedLevel,
            teacherId: charId,
          })
        : createUserPlan({ goalText: text, level: detectedLevel, teacherId: charId });
      return {
        reply: currentPlan
          ? `好的，计划已更新：老师 ${character.name}、${detectedLevel}；进度保留。`
          : `好，按你说的内容排了 3 节课，老师默认 ${character.name}。`,
        action: { type: 'update_plan', payload: plan },
        demo: true,
      };
    }
    case 'review_words':
      return {
        reply: '打开今日单词表复习吧，到期词优先过一遍，5 分钟就够。',
        action: { type: 'review_words', payload: {} },
        demo: true,
      };
    case 'open_scene': {
      const scene = character.scenes[0];
      return {
        reply: `走，和 ${character.name} 去「${scene.label}」聊几句，我先把场景切好。`,
        action: { type: 'open_scene', payload: { characterId: character.id, sceneId: scene.id, label: scene.label } },
        demo: true,
      };
    }
    case 'open_tab':
      return {
        reply: '在「我的」里可以改昵称、等级和学习目标，改完我会同步到计划里。',
        action: { type: 'open_tab', payload: { tab: intent.tab || 'profile' } },
        demo: true,
      };
    case 'feedback':
      return {
        reply: '收到，我把这条反馈记下了。想让我先给你调整计划还是换个场景练？',
        action: { type: 'feedback', payload: { message: text.slice(0, 500) } },
        demo: true,
      };
    case 'greeting':
      return {
        reply: `嗨，我是 Ava。是想创建学习计划、快速复习单词，还是找 ${character.name} 聊一会儿？`,
        action: null,
        demo: true,
      };
    default:
      return {
        reply: currentPlan
          ? `我在。你可以说「快速复习」「换个场景练习」，或者让我更新一下学习计划。`
          : '我在。要不要我先帮你按目标和水平排一个 3 阶段学习计划？',
        action: null,
        demo: true,
      };
  }
}

/* ------------------------------ 豆包文本增强 ------------------------------ */

class AssistantTextEngine {
  constructor() {
    this.session = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.signature = '';
  }

  reset() {
    const s = this.session;
    this.session = null;
    this.signature = '';
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve(null);
      this.pending = null;
    }
    if (s) {
      try {
        s.finish().catch(() => s.close('assistant-reset'));
      } catch {
        /* ignore */
      }
    }
  }

  #handleChat({ text, final }) {
    const pending = this.pending;
    if (!pending) return;
    if (text) pending.chunks.push(text);
    if (final) {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve(String(pending.chunks.join('')).trim() || null);
    }
  }

  async #ensureSession(settings) {
    const v = settings.volc || {};
    const sig = [v.appId, v.apiKey, v.model, v.speaker, v.endpoint, v.resourceId].join('|');
    if (this.session && this.signature === sig) return this.session;
    this.reset();
    const session = new VolcRealtimeSession({
      volc: settings.volc,
      persona: ASSISTANT_PERSONA,
      textMode: true,
      connectTimeoutMs: 12_000,
      handlers: {
        onChat: (evt) => this.#handleChat(evt),
        onError: () => {
          if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending = null;
            this.pending.resolve(null);
          }
        },
        onClose: () => {
          this.session = null;
          this.signature = '';
        },
      },
    });
    await session.connect();
    this.session = session;
    this.signature = sig;
    return session;
  }

  async ask(message, context, settings) {
    const v = settings?.volc || {};
    if (!v.appId || (!v.apiKey && !v.accessToken)) return null;
    const run = async () => {
      try {
        const session = await this.#ensureSession(settings);
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (this.pending) {
              this.pending = null;
              resolve(null);
            }
          }, 7000);
          this.pending = {
            chunks: [],
            timer,
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
          };
          const sent = session.sendTextQuery(
            `${context ? `当前信息：${context}\n` : ''}用户说：${message}\n请用一两句中文口语回复（不要列表/JSON）。`,
          );
          if (!sent) {
            clearTimeout(timer);
            this.pending = null;
            resolve(null);
          }
        });
      } catch {
        this.reset();
        return null;
      }
    };
    const task = this.queue.then(run, run);
    this.queue = task.catch(() => null);
    return task;
  }
}

const assistantEngine = new AssistantTextEngine();

/**
 * 助手入口：规则决定动作，豆包文本会话负责把回复说得自然（失败退回模板）。
 * @returns {Promise<{reply:string, action:object|null, demo:boolean, plan?:object}>}
 */
export async function assistantReply({ message, characterId = DEFAULT_CHARACTER_ID, currentPlan = null, level = 'A2', history = [], settings = loadSettings() } = {}) {
  const base = buildAssistantReply({ message, characterId, currentPlan, level });
  const character = findCharacter(detectCharacterId(message, characterId)) || characters[0];
  const context = [
    currentPlan
      ? `当前计划：${currentPlan.title}（老师 ${currentPlan.teacherName || 'Ava'}，${currentPlan.level}，用户想学：${String(currentPlan.goalText || '').slice(0, 120)}，已完成 ${currentPlan.doneLessons || 0}/${currentPlan.totalLessons || 3} 节课）`
      : '当前还没有学习计划',
    `默认角色：${character.name}（${character.city}）`,
    `用户等级：${level}`,
  ].join('；');
  const polished = await assistantEngine.ask(
    String(message || '').slice(0, 300),
    context,
    settings,
  );
  if (polished && polished.length >= 2) {
    return { ...base, reply: polished.slice(0, 300), demo: false };
  }
  return base;
}

export default { assistantReply, buildAssistantReply, detectIntent, detectGoal, detectLevel, detectCharacterId };
