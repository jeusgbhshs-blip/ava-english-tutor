/**
 * OpenAI 兼容大模型客户端：流式对话 + 反馈 JSON 抽取 + 连接测试。
 * 无第三方依赖，使用 Node 24 内置 fetch / AbortSignal。
 */
import { FEEDBACK_MARKER, EMPTY_FEEDBACK } from '../content/prompts.js';

/** 拼 URL，避免双斜杠 */
export function joinUrl(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function emptyFeedback(extra = {}) {
  return {
    corrections: [],
    better: [],
    newWords: [],
    encouragement_zh: '',
    followUp: '',
    ...extra,
  };
}

/** 规范化中文求助对象（模型/演示输出），容错 null/缺字段/超长 */
export function normalizeChineseHelp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const original_zh = str(raw.original_zh, 300);
  const english = str(raw.english, 300);
  if (!original_zh && !english) return null;
  const chunks = Array.isArray(raw.chunks)
    ? raw.chunks
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({ en: str(c.en, 120), zh: str(c.zh, 120) }))
        .filter((c) => c.en)
        .slice(0, 4)
    : [];
  return { original_zh, english, chunks, tips_zh: str(raw.tips_zh, 300) };
}

/** 把模型给的反馈对象校正为安全结构 */
export function normalizeFeedback(raw) {
  if (!raw || typeof raw !== 'object') return emptyFeedback();
  const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    corrections: asArray(raw.corrections)
      .map((c) => ({
        original: str(c.original, 200),
        corrected: str(c.corrected, 200),
        explanation_zh: str(c.explanation_zh, 300),
      }))
      .filter((c) => c.corrected)
      .slice(0, 3),
    better: asArray(raw.better)
      .map((b) => ({ original: str(b.original, 200), better: str(b.better, 200), why_zh: str(b.why_zh, 300) }))
      .filter((b) => b.better)
      .slice(0, 2),
    newWords: asArray(raw.newWords)
      .map((w) => ({
        word: str(w.word, 60),
        phonetic: str(w.phonetic, 60),
        meaning: str(w.meaning, 100),
        example: str(w.example, 200),
      }))
      .filter((w) => w.word)
      .slice(0, 4),
    encouragement_zh: str(raw.encouragement_zh, 80),
    followUp: str(raw.followUp, 200),
    chineseHelp: normalizeChineseHelp(raw.chineseHelp),
  };
}

/** 从 <<<FEEDBACK>>> 之后的文本中解析 JSON */
export function parseFeedback(raw) {
  let text = String(raw || '').trim();
  if (!text) return emptyFeedback();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    return normalizeFeedback(JSON.parse(text));
  } catch {
    return emptyFeedback();
  }
}

/**
 * 流式文本抽取器：把「英文正文 + 标记 + JSON」安全拆开，正文增量回调。
 * 处理标记被切分到多个 chunk 的情况。
 * @param {(text:string)=>void} onText
 */
export function createStreamExtractor(onText = () => {}) {
  let full = '';
  let emitted = 0;
  let markerIndex = -1;
  return {
    /** 推入一个增量 chunk */
    push(chunk) {
      if (typeof chunk !== 'string' || !chunk) return;
      full += chunk;
      if (markerIndex >= 0) return;
      const idx = full.indexOf(FEEDBACK_MARKER);
      if (idx >= 0) {
        markerIndex = idx;
        if (idx > emitted) {
          onText(full.slice(emitted, idx));
          emitted = idx;
        }
        return;
      }
      // 只发送"确定不属于标记前缀"的部分，尾部留标记长度-1 的缓冲
      const safe = full.length - (FEEDBACK_MARKER.length - 1);
      if (safe > emitted) {
        onText(full.slice(emitted, safe));
        emitted = safe;
      }
    },
    /** 结束流：发送剩余正文并返回 {fullReply, feedback} */
    end() {
      if (markerIndex >= 0) {
        return {
          fullReply: full.slice(0, markerIndex).trim(),
          feedback: parseFeedback(full.slice(markerIndex + FEEDBACK_MARKER.length)),
        };
      }
      if (emitted < full.length) onText(full.slice(emitted));
      return { fullReply: full.trim(), feedback: emptyFeedback() };
    },
  };
}

/** 友好中文错误信息 */
export function friendlyErrorMessage(err) {
  const msg = String(err?.message || err || '');
  if (/abort|timeout|timed out/i.test(msg)) return '连接大模型超时，请检查网络或换一个模型接口。';
  if (/401|unauthorized|invalid.*key|api key/i.test(msg)) return 'API Key 无效或已过期，请在设置页检查。';
  if (/403|forbidden/i.test(msg)) return '接口拒绝访问（403），请检查账号权限。';
  if (/404|not found/i.test(msg)) return '接口地址或模型名不正确（404），请检查 Base URL 与模型名称。';
  if (/429|rate limit|quota/i.test(msg)) return '请求太频繁或额度不足（429），稍后再试。';
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|getaddrinfo/i.test(msg)) return '网络连接失败，请检查网络或代理设置。';
  if (/\b5\d\d\b/.test(msg)) return '模型服务暂时不可用（5xx），稍后再试。';
  return `调用大模型失败：${msg.slice(0, 200) || '未知错误'}`;
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

/** 构造 chat completions 请求体 */
export function buildRequestPayload(settings, messages) {
  return {
    model: settings.model,
    stream: true,
    temperature: 0.75,
    max_tokens: 1000,
    messages,
  };
}

/**
 * 流式对话。
 * @param {object} opts
 * @param {object} opts.settings 含 baseUrl/model/apiKey
 * @param {{role:string,content:string}[]} opts.messages
 * @param {AbortSignal} [opts.signal]
 * @param {()=>void} [opts.onOpen] 上游返回 200 后调用（用于先发 meta）
 * @param {(text:string)=>void} [opts.onDelta]
 */
export async function streamChat({ settings, messages, signal, onOpen, onDelta = () => {} }) {
  if (!settings?.apiKey) throw new Error('缺少 API Key');
  const url = joinUrl(settings.baseUrl, 'chat/completions');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`,
      accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(buildRequestPayload(settings, messages)),
    signal,
  });
  if (!res.ok) throw new Error(await readErrorBody(res));
  if (typeof onOpen === 'function') onOpen();

  const extractor = createStreamExtractor(onDelta);
  const contentType = String(res.headers.get('content-type') || '');

  // 个别服务商忽略 stream:true，直接返回 JSON
  if (contentType.includes('application/json')) {
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    extractor.push(typeof content === 'string' ? content : '');
    return extractor.end();
  }

  if (!res.body) throw new Error('模型返回了空的响应体');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const json = JSON.parse(payload);
      const delta = json?.choices?.[0]?.delta;
      const content = delta?.content ?? json?.choices?.[0]?.text ?? '';
      if (typeof content === 'string' && content) extractor.push(content);
    } catch {
      /* 忽略无法解析的行（部分服务商的 keep-alive） */
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer.trim()) handleLine(buffer);
  return extractor.end();
}

/** 测试连接：先试 /models，不行再用极短 chat 请求兜底 */
export async function testConnection(settings) {
  if (!settings?.apiKey) throw new Error('没有填写 API Key');
  const started = Date.now();
  const timeout = AbortSignal.timeout(15_000);
  try {
    const res = await fetch(joinUrl(settings.baseUrl, 'models'), {
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal: timeout,
    });
    if (res.ok) {
      return { ok: true, model: settings.model, latencyMs: Date.now() - started };
    }
    if (res.status === 401) throw new Error(await readErrorBody(res));
  } catch (err) {
    if (/401|unauthorized|invalid/i.test(String(err?.message))) throw err;
    // /models 不存在时继续用 chat 兜底
  }

  const res2 = await fetch(joinUrl(settings.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 1,
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res2.ok) throw new Error(await readErrorBody(res2));
  return { ok: true, model: settings.model, latencyMs: Date.now() - started };
}

export default { streamChat, testConnection, createStreamExtractor, parseFeedback, normalizeFeedback, normalizeChineseHelp, friendlyErrorMessage, joinUrl };
