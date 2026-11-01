/**
 * 非流式 JSON 调用助手：给对话导演/记忆/知识库增强/检索重排等内部任务用。
 */
import { joinUrl } from './llm.js';

/**
 * 从模型输出里尽量抽取 JSON（支持 ```json 围栏、前后废话）。
 * @param {string} text
 * @returns {any|null}
 */
export function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  candidates.push(raw);
  for (const c of candidates) {
    const s = c.trim();
    try {
      return JSON.parse(s);
    } catch {
      /* continue */
    }
    // 尝试截取第一个 { 到最后一个 } 或 [ 到最后一个 ]
    for (const [open, close] of [
      ['{', '}'],
      ['[', ']'],
    ]) {
      const a = s.indexOf(open);
      const b = s.lastIndexOf(close);
      if (a >= 0 && b > a) {
        try {
          return JSON.parse(s.slice(a, b + 1));
        } catch {
          /* continue */
        }
      }
    }
  }
  return null;
}

/**
 * 调用一次非流式 chat/completions，返回 { content, parsed, usage }。
 * @param {{settings:object, messages:Array, temperature?:number, maxTokens?:number, timeoutMs?:number, json?:boolean}} opts
 */
export async function chatJSON({
  settings,
  messages,
  temperature = 0.5,
  maxTokens = 900,
  timeoutMs = 20_000,
  json = true,
} = {}) {
  if (!settings?.apiKey) throw new Error('缺少模型 API Key');
  const res = await fetch(joinUrl(settings.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      temperature,
      max_tokens: maxTokens,
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`模型请求失败（HTTP ${res.status}）${body ? '：' + body.slice(0, 120) : ''}`);
  }
  const data = await res.json();
  const content = String(data?.choices?.[0]?.message?.content || '').trim();
  return { content, parsed: extractJson(content), usage: data?.usage || null };
}

export default { chatJSON, extractJson };
