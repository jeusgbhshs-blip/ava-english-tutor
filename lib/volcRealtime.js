/**
 * 火山引擎「豆包实时语音模型」WebSocket 客户端（零第三方依赖，使用 Node 内置 WebSocket）。
 * 协议见 lib/volcProtocol.js；事件/鉴权见 SPEC v1.4 §B。
 */
import {
  encodeEvent,
  encodeAudio,
  parseFrame,
  CLIENT_EVENT,
  SERVER_EVENT,
  MSG_TYPE,
  generateId,
} from './volcProtocol.js';

export const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
export const DEFAULT_RESOURCE_ID = 'volc.speech.dialog';
export const DEFAULT_MODEL = '3.0';
export const DEFAULT_SPEAKER = 'en_female_dacey_uranus_bigtts';

/** 组装鉴权头（API Key 新版 / Access Token 旧版二选一） */
export function buildVolcHeaders(volc = {}) {
  const appId = String(volc.appId || '').trim();
  const apiKey = String(volc.apiKey || '').trim();
  const accessToken = String(volc.accessToken || '').trim();
  const headers = {
    'X-Api-App-Id': appId,
    'X-Api-Resource-Id': String(volc.resourceId || DEFAULT_RESOURCE_ID),
  };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  else if (accessToken) headers['X-Api-Access-Key'] = accessToken;
  return headers;
}

/** 火山会话配置（SPEC v1.4 §B6） */
export function buildSessionConfig({ volc = {}, persona = '', textMode = false, pttMode = false } = {}) {
  const model = String(volc.model || DEFAULT_MODEL);
  const speaker = String(volc.speaker || DEFAULT_SPEAKER);
  const dialogExtra = { model };
  if (textMode) {
    // 文本模式：只发文本、只收文本（用于翻译等辅助任务，不产生 TTS 音频）
    dialogExtra.input_mod = 'text';
    dialogExtra.output_modalities = ['text'];
  }
  return {
    asr: {
      audio_info: { format: 'pcm', sample_rate: 16000, channel: 1 },
      extra: { end_smooth_window_ms: pttMode ? 2000 : 1200 },
    },
    tts: {
      speaker,
      audio_config: { format: 'pcm_s16le', sample_rate: 24000, channel: 1 },
      extra: {},
    },
    dialog: {
      bot_name: textMode ? 'Translator' : 'Ava',
      system_role: String(persona || '').slice(0, 8000),
      extra: dialogExtra,
    },
  };
}

const ERROR_HINTS = [
  { re: /speaker.*empty|InvalidSpeaker|speaker/i, msg: '音色 ID 与模型版本不匹配：请在设置里换一个该模型支持的音色（英文女声可试 en_female_dacey_uranus_bigtts）。' },
  { re: /model.*(not support|unknown|invalid)/i, msg: '模型版本不被支持：请在设置页核对模型版本（如 3.0 / 1.2.1.1 / 2.2.0.0，以控制台为准）。' },
  { re: /token|auth|api key|unauthorized|forbidden|401|403/i, msg: '鉴权失败：请检查 App ID / API Key（或 Access Token）/ 资源 ID 是否正确，以及账号是否已开通「端到端实时语音」。' },
  { re: /quota|qpm|tpm|limit|exceed/i, msg: '调用额度或频率超限：请稍后再试或在火山引擎控制台检查配额。' },
  { re: /timeout|time out|timeout error/i, msg: '连接火山引擎超时：请检查网络。' },
  { re: /silence|idle/i, msg: '会话因长时间静默被释放，请重新开始对话。' },
];

/** 把火山错误码/文案转成中文可操作提示 */
export function friendlyVolcError(code, message) {
  const text = String(message || code || '未知错误');
  for (const hint of ERROR_HINTS) {
    if (hint.re.test(text)) return hint.msg;
  }
  if (code) return `豆包实时语音返回错误（${code}）：${text.slice(0, 200)}`;
  return `豆包实时语音连接失败：${text.slice(0, 200)}`;
}

/**
 * 建立一次实时语音会话。
 * 事件回调：
 *  - onReady({model, speaker, sessionId, dialogId})
 *  - onFrame(frame) 原始协议帧（可选）
 *  - onASR({text, final, interim})  451/450/459
 *  - onChat({text, final})          550/559
 *  - onTTSStart({text}) / onTTSEnd()
 *  - onAudio(Buffer)                352 音频块
 *  - onInterrupted()                450 检测到用户开口
 *  - onError(Error) / onClose(reason)
 */
export class VolcRealtimeSession {
  constructor({ volc = {}, persona = '', handlers = {}, connectTimeoutMs = 25_000, label = '', textMode = false, pttMode = false } = {}) {
    this.volc = volc;
    this.persona = persona;
    this.handlers = handlers;
    this.connectTimeoutMs = connectTimeoutMs;
    this.label = label;
    this.textMode = textMode === true;
    this.pttMode = pttMode === true;
    this.connectId = generateId();
    this.sessionId = generateId();
    this.dialogId = '';
    this.ws = null;
    this.closed = false;
    this.ready = false;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectPromise = null;
    this._connectTimer = null;
    this._finishing = false;
    this._closeNotified = false;
  }

  /** 建立连接并启动会话 */
  connect() {
    if (this.closed) return Promise.reject(new Error('豆包实时语音会话已关闭，请重新建立连接'));
    if (this._connectPromise) return this._connectPromise;
    const endpoint = String(this.volc.endpoint || DEFAULT_ENDPOINT);
    const headers = buildVolcHeaders(this.volc);
    if (!headers['X-Api-App-Id']) return Promise.reject(new Error('未填写 App ID'));
    if (!headers['X-Api-Key'] && !headers['X-Api-Access-Key']) return Promise.reject(new Error('未填写 API Key 或 Access Token'));

    this._connectPromise = new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._connectTimer = setTimeout(() => {
        this.fail(new Error(`连接豆包实时语音超时（${this.connectTimeoutMs / 1000} 秒）`));
      }, this.connectTimeoutMs);
      this._connectTimer.unref?.();

      let ws;
      try {
        ws = new WebSocket(endpoint, { headers });
      } catch (err) {
        return this.fail(new Error(`无法连接豆包实时语音：${err.message}`));
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        try {
          ws.send(
            encodeEvent({
              msgType: MSG_TYPE.FULL_CLIENT_REQUEST,
              eventId: CLIENT_EVENT.START_CONNECTION,
              connectId: this.connectId,
              includeConnectId: false,
              payload: {},
            }),
          );
        } catch (err) {
          this.fail(err);
        }
      };

      ws.onmessage = (event) => this.#onMessage(event);
      ws.onerror = () => {
        if (!this.ready) this.fail(new Error('连接豆包实时语音失败（网络或鉴权问题）'));
      };
      ws.onclose = () => this.#onClose('socket-closed');
    });
    return this._connectPromise;
  }

  #settleConnect(error = null) {
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    const resolve = this._connectResolve;
    const reject = this._connectReject;
    this._connectResolve = null;
    this._connectReject = null;
    if (error) reject?.(error);
    else resolve?.(true);
  }

  #onMessage(event) {
    if (this.closed) return;
    let frame;
    try {
      if (typeof event.data === 'string') return;
      frame = parseFrame(Buffer.from(event.data));
    } catch {
      return;
    }
    const h = this.handlers;
    h.onFrame?.(frame);
    if (this.closed) return;
    // 协议错误可没有业务 event id；不能只处理 51 / 153 / 599。
    if (frame.msgType === MSG_TYPE.ERROR) {
      const message = frame.json?.error || frame.json?.message || frame.payload?.toString('utf8') || '语音协议错误';
      this.fail(new Error(friendlyVolcError(frame.errorCode, message)));
      return;
    }

    switch (frame.eventId) {
      case SERVER_EVENT.CONNECTION_STARTED:
        this.#startSession();
        break;
      case SERVER_EVENT.SESSION_STARTED:
        if (this.ready) break;
        this.ready = true;
        this.dialogId = frame.json?.dialog_id || '';
        this.#settleConnect();
        h.onReady?.({
          model: this.volc.model || DEFAULT_MODEL,
          speaker: this.volc.speaker || DEFAULT_SPEAKER,
          sessionId: this.sessionId,
          dialogId: this.dialogId,
        });
        break;
      case SERVER_EVENT.CONNECTION_FAILED:
      case SERVER_EVENT.SESSION_FAILED:
      case SERVER_EVENT.DIALOG_COMMON_ERROR: {
        const message = frame.json?.error || frame.json?.message || '火山引擎返回失败';
        const friendly = friendlyVolcError(frame.json?.status_code || frame.errorCode, message);
        this.fail(new Error(friendly));
        break;
      }
      case SERVER_EVENT.ASR_RESPONSE: {
        // 真实响应：results[0].text 为识别文本，is_interim 标记中间结果；
        // 最终句还会带 extra.endpoint=true（以及 soft_finish_paralinguistic.asr_text）
        const results = Array.isArray(frame.json?.results) ? frame.json.results : [];
        const first = results[0] || {};
        const text = String(first.text || frame.json?.extra?.origin_text || frame.json?.text || '').trim();
        const isFinal = first.is_interim === false || frame.json?.extra?.endpoint === true;
        if (text) this.lastASRText = text;
        h.onASR?.({ text, final: Boolean(isFinal) });
        break;
      }
      case SERVER_EVENT.ASR_INFO:
        this.lastASRText = '';
        h.onInterrupted?.();
        break;
      case SERVER_EVENT.ASR_ENDED: {
        const finalText = this.lastASRText || '';
        this.lastASRText = '';
        h.onASR?.({ text: finalText, final: true });
        h.onASREnded?.();
        break;
      }
      case SERVER_EVENT.CHAT_RESPONSE:
        // 真实响应：550 的增量文本在 content 字段
        h.onChat?.({ text: String(frame.json?.content ?? frame.json?.text ?? ''), final: false });
        break;
      case SERVER_EVENT.CHAT_ENDED:
        h.onChat?.({ text: '', final: true });
        break;
      case SERVER_EVENT.TTS_SENTENCE_START:
        h.onTTSStart?.({ text: String(frame.json?.text || '') });
        break;
      case SERVER_EVENT.TTS_SENTENCE_END:
        h.onTTSEnd?.(frame.json || {});
        break;
      case SERVER_EVENT.TTS_RESPONSE:
        if (frame.payload && frame.payload.length) h.onAudio?.(frame.payload);
        break;
      case SERVER_EVENT.TTS_ENDED:
        h.onTTSAllEnded?.(frame.json || {});
        break;
      case SERVER_EVENT.USAGE_RESPONSE:
        h.onUsage?.(frame.json || {});
        break;
      default:
        break;
    }
  }

  #startSession() {
    try {
      const config = buildSessionConfig({ volc: this.volc, persona: this.persona, textMode: this.textMode, pttMode: this.pttMode });
      this.ws.send(
        encodeEvent({
          msgType: MSG_TYPE.FULL_CLIENT_REQUEST,
          eventId: CLIENT_EVENT.START_SESSION,
          sessionId: this.sessionId,
          payload: config,
        }),
      );
    } catch (err) {
      this.fail(err);
    }
  }

  /** 上行 16k mono s16le PCM（任意块大小，建议 20ms/640B） */
  sendAudio(buffer) {
    if (!this.ready || this.closed || !this.ws) return;
    try {
      this.ws.send(encodeAudio(buffer, this.sessionId));
    } catch {
      /* 发送失败由 close 事件统一处理 */
    }
  }

  /** 发送文本查询（501；文本模式翻译等场景使用） */
  sendTextQuery(content) {
    if (!this.ready || this.closed || !this.ws) return false;
    try {
      this.ws.send(
        encodeEvent({
          msgType: MSG_TYPE.FULL_CLIENT_REQUEST,
          eventId: CLIENT_EVENT.CHAT_TEXT_QUERY,
          sessionId: this.sessionId,
          payload: { content: String(content || '').slice(0, 4000) },
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** 打断（push-to-talk 场景；默认 VAD 下服务端会自动检测） */
  interrupt() {
    if (!this.ready || this.closed || !this.ws) return;
    try {
      this.ws.send(
        encodeEvent({
          msgType: MSG_TYPE.FULL_CLIENT_REQUEST,
          eventId: CLIENT_EVENT.CLIENT_INTERRUPT,
          sessionId: this.sessionId,
          payload: {},
        }),
      );
    } catch {
      /* ignore */
    }
  }

  /** 结束会话与连接 */
  async finish() {
    if (this._finishing || this.closed) return;
    this._finishing = true;
    try {
      if (this.ws && this.ready) {
        this.ws.send(
          encodeEvent({
            msgType: MSG_TYPE.FULL_CLIENT_REQUEST,
            eventId: CLIENT_EVENT.FINISH_SESSION,
            sessionId: this.sessionId,
            payload: {},
          }),
        );
        await new Promise((r) => setTimeout(r, 120));
      }
      if (this.ws) {
        try {
          this.ws.send(
            encodeEvent({
              msgType: MSG_TYPE.FULL_CLIENT_REQUEST,
              eventId: CLIENT_EVENT.FINISH_CONNECTION,
              connectId: this.connectId,
              includeConnectId: false,
              payload: {},
            }),
          );
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    } finally {
      this.close('finished');
    }
  }

  close(reason = 'closed') {
    if (this._closeNotified) return;
    try {
      this.#onClose(reason);
    } finally {
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
    }
  }

  fail(err) {
    if (this.closed) return;
    this.#settleConnect(err);
    try {
      this.handlers.onError?.(err);
    } finally {
      this.close('error');
    }
  }

  #onClose(reason) {
    if (this._closeNotified) return;
    this._closeNotified = true;
    this.closed = true;
    this.ready = false;
    this.#settleConnect(new Error('豆包实时语音连接在会话就绪前已关闭，请重试'));
    this.handlers.onClose?.(reason);
  }
}

/** 测试连接：建立会话→等 ready→立即结束 */
export async function testVolcConnection(volc, { timeoutMs = 20_000 } = {}) {
  const started = Date.now();
  const session = new VolcRealtimeSession({
    volc,
    persona: 'You are a friendly English teacher. Say hello briefly.',
    connectTimeoutMs: timeoutMs,
    handlers: {},
  });
  try {
    await session.connect();
    return {
      ok: true,
      latencyMs: Date.now() - started,
      model: volc.model || DEFAULT_MODEL,
      speaker: volc.speaker || DEFAULT_SPEAKER,
      dialogId: session.dialogId,
    };
  } finally {
    try {
      await session.finish();
    } catch {
      session.close('test-done');
    }
  }
}

export default {
  VolcRealtimeSession,
  buildVolcHeaders,
  buildSessionConfig,
  friendlyVolcError,
  testVolcConnection,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_SPEAKER,
  DEFAULT_RESOURCE_ID,
};
