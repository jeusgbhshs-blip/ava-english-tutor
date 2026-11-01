/**
 * 英译中翻译服务（双语字幕用）。
 * 优先用已配置的豆包凭据开「文本模式」实时会话做翻译（不产生语音）；
 * 其次回退到已配置的文本模型；都没有或失败时返回 null（前端静默降级为只显示英文）。
 */
import { VolcRealtimeSession } from './volcRealtime.js';
import { loadSettings } from './config.js';
import { friendlyErrorMessage, joinUrl } from './llm.js';

const TRANSLATOR_PERSONA =
  'You are a precise English-to-Simplified-Chinese translator for live subtitles. ' +
  'Translate the user message into natural, concise Simplified Chinese. ' +
  'Keep the original tone (casual chat stays casual). Output ONLY the Chinese translation — ' +
  'no quotes, no explanations, no pinyin, no English.';

const MAX_TEXTS = 8;
const MAX_TEXT_LEN = 500;
const TRANSLATE_TIMEOUT_MS = 8000;

/** 清洗模型返回的译文 */
export function cleanTranslation(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  text = text
    // 只去掉 markdown 围栏标记，保留代码块里的译文内容
    .replace(/\s*```\s*$/, '')
    .replace(/^\s*```[^\n]*\n/, '')
    .replace(/^\s*```/, '')
    .replace(/^(中文翻译|翻译|译文)[:：]\s*/i, '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  // 明显是英文解释而不是译文时丢弃
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (!cjk) return null;
  return text.slice(0, 800);
}

function hasVolcCredentials(settings) {
  const v = settings?.volc || {};
  return Boolean(v.appId && (v.apiKey || v.accessToken));
}

function volcSignature(settings) {
  const v = settings?.volc || {};
  return [v.appId, v.apiKey, v.accessToken, v.model, v.speaker, v.endpoint, v.resourceId].join('|');
}

export class Translator {
  constructor() {
    this.session = null;
    this.sessionSignature = '';
    this.pending = null;
    this.queue = Promise.resolve();
  }

  reset() {
    const s = this.session;
    this.session = null;
    this.sessionSignature = '';
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve(null);
      this.pending = null;
    }
    if (s) {
      try {
        s.finish().catch(() => s.close('translator-reset'));
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
      pending.resolve(cleanTranslation(pending.chunks.join('')));
    }
  }

  async #ensureSession(settings) {
    const signature = volcSignature(settings);
    if (this.session && this.sessionSignature === signature) return this.session;
    this.reset();
    const session = new VolcRealtimeSession({
      volc: settings.volc,
      persona: TRANSLATOR_PERSONA,
      textMode: true,
      connectTimeoutMs: 12_000,
      handlers: {
        onChat: (evt) => this.#handleChat(evt),
        onError: () => {
          const pending = this.pending;
          if (pending) {
            clearTimeout(pending.timer);
            this.pending = null;
            pending.resolve(null);
          }
        },
        onClose: () => {
          this.session = null;
          this.sessionSignature = '';
        },
      },
    });
    await session.connect();
    this.session = session;
    this.sessionSignature = signature;
    return session;
  }

  /** 单条翻译（串行队列，8s 超时；失败返回 null） */
  async translateOnce(text, settings) {
    const input = String(text || '').trim().slice(0, MAX_TEXT_LEN);
    if (!input) return null;
    const run = async () => {
      try {
        const session = await this.#ensureSession(settings);
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (this.pending) {
              this.pending = null;
              resolve(null);
            }
          }, TRANSLATE_TIMEOUT_MS);
          this.pending = {
            chunks: [],
            timer,
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
          };
          const sent = session.sendTextQuery(
            `Translate this into Simplified Chinese (output only the translation):\n${input}`,
          );
          if (!sent) {
            clearTimeout(timer);
            this.pending = null;
            resolve(null);
          }
        });
        if (result === null) this.reset();
        return result;
      } catch {
        this.reset();
        return null;
      }
    };
    const task = this.queue.then(run, run);
    this.queue = task.catch(() => null);
    return task;
  }

  /** 批量翻译（保持顺序；失败项为 null） */
  async translateMany(texts, settings) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '')).slice(0, MAX_TEXTS);
    const out = [];
    for (const text of list) out.push(await this.translateOnce(text, settings));
    return out;
  }
}

export const translator = new Translator();

/** 文本模型回退翻译（豆包凭据不可用时） */
async function translateWithTextModel(texts, settings) {
  if (!settings?.apiKey) return null;
  try {
    const res = await fetch(joinUrl(settings.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: 'system', content: 'You are a translator. Translate each numbered line into natural Simplified Chinese. Output only the translations, one per line, prefixed with the same number and a period.' },
          { role: 'user', content: texts.map((t, i) => `${i + 1}. ${t}`).join('\n') },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = String(data?.choices?.[0]?.message?.content || '');
    const lines = content
      .split('\n')
      .map((l) => l.replace(/^\s*\d+[.、)]\s*/, '').trim())
      .filter(Boolean);
    const out = texts.map((_, i) => cleanTranslation(lines[i] || ''));
    return out.every((x) => x === null) ? null : out;
  } catch {
    return null;
  }
}

/**
 * 批量英译中。
 * @param {string[]} texts
 * @param {{settings?:object, target?:string}} [opts]
 * @returns {Promise<{ok:boolean, texts:(string|null)[], provider:'volc'|'llm'|null, error?:string}>}
 */
export async function translateTexts(texts, { settings = loadSettings(), target = 'zh' } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t || '').trim().slice(0, MAX_TEXT_LEN))
    .filter(Boolean)
    .slice(0, MAX_TEXTS);
  if (!list.length) return { ok: true, texts: [], provider: null };
  if (target !== 'zh') return { ok: false, texts: list.map(() => null), provider: null, error: '目前只支持翻译成中文' };

  if (hasVolcCredentials(settings)) {
    const out = await translator.translateMany(list, settings);
    if (out.some((x) => x !== null)) return { ok: true, texts: out, provider: 'volc' };
  }
  const llmOut = await translateWithTextModel(list, settings);
  if (llmOut) return { ok: true, texts: llmOut, provider: 'llm' };

  return {
    ok: false,
    texts: list.map(() => null),
    provider: null,
    error: '翻译服务暂不可用：请先在设置里配置豆包实时语音凭据，或填写文本模型 API Key。',
  };
}

export default { translateTexts, translator, cleanTranslation };
