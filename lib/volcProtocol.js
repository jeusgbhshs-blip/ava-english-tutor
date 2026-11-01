/**
 * 火山引擎「端到端实时语音大模型」二进制协议编解码（零依赖）。
 * 帧结构：[4 字节头][可选字段][4 字节负载长度][负载]
 * 头部：byte0 版本(4b)|头长(4b)；byte1 消息类型(4b)|flags(4b)；
 *       byte2 序列化(4b)|压缩(4b)；byte3 保留。
 * 可选字段顺序：错误码（仅错误帧）/ sequence / event id / connect id / session id。
 */
import { gzipSync, gunzipSync } from 'node:zlib';

export const PROTOCOL_VERSION = 0x01;
export const HEADER_SIZE_UNITS = 0x01; // 1 unit = 4 bytes
export const FLAG_EVENT = 0b0100;

export const MSG_TYPE = {
  FULL_CLIENT_REQUEST: 0b0001,
  FULL_SERVER_RESPONSE: 0b1001,
  AUDIO_ONLY_REQUEST: 0b0010,
  AUDIO_ONLY_RESPONSE: 0b1011,
  ERROR: 0b1111,
};

export const SERIALIZATION = { RAW: 0b0000, JSON: 0b0001 };
export const COMPRESSION = { NONE: 0b0000, GZIP: 0b0001 };

export const CLIENT_EVENT = {
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  START_SESSION: 100,
  FINISH_SESSION: 102,
  TASK_REQUEST: 200,
  UPDATE_CONFIG: 201,
  SAY_HELLO: 300,
  END_ASR: 400,
  CHAT_TTS_TEXT: 500,
  CHAT_TEXT_QUERY: 501,
  CHAT_RAG_TEXT: 502,
  CONVERSATION_CREATE: 510,
  CONVERSATION_UPDATE: 511,
  CONVERSATION_RETRIEVE: 512,
  CONVERSATION_TRUNCATE: 513,
  CONVERSATION_DELETE: 514,
  CLIENT_INTERRUPT: 515,
};

export const SERVER_EVENT = {
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  CONNECTION_FINISHED: 52,
  SESSION_STARTED: 150,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  USAGE_RESPONSE: 154,
  CONFIG_UPDATED: 251,
  TTS_SENTENCE_START: 350,
  TTS_SENTENCE_END: 351,
  TTS_RESPONSE: 352,
  TTS_ENDED: 359,
  ASR_INFO: 450,
  ASR_RESPONSE: 451,
  ASR_ENDED: 459,
  CHAT_RESPONSE: 550,
  CHAT_TEXT_QUERY_CONFIRMED: 553,
  CHAT_ENDED: 559,
  CONVERSATION_CREATED: 567,
  CONVERSATION_UPDATED: 568,
  CONVERSATION_RETRIEVED: 569,
  CONVERSATION_TRUNCATED: 570,
  CONVERSATION_DELETED: 571,
  DIALOG_COMMON_ERROR: 599,
};

export const CONNECT_LEVEL_EVENTS = new Set([1, 2, 50, 51, 52]);

function buildHeader(msgType, flags, serialization, compression = COMPRESSION.NONE) {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNITS,
    ((msgType & 0x0f) << 4) | (flags & 0x0f),
    ((serialization & 0x0f) << 4) | (compression & 0x0f),
    0x00,
  ]);
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/**
 * 编码一个带事件 id 的 JSON 帧（客户端请求 / 服务端响应通用）。
 * @param {{msgType?:number, eventId:number, payload?:object, sessionId?:string, connectId?:string,
 *          serialization?:number, compression?:number, errorCode?:number}} opts
 */
export function encodeEvent({
  msgType = MSG_TYPE.FULL_CLIENT_REQUEST,
  eventId,
  payload = {},
  sessionId = '',
  connectId = '',
  includeConnectId = true,
  serialization = SERIALIZATION.JSON,
  compression = COMPRESSION.NONE,
  errorCode = 0,
}) {
  const flags = FLAG_EVENT;
  const parts = [buildHeader(msgType, flags, serialization, compression)];
  if (msgType === MSG_TYPE.ERROR) parts.push(u32(errorCode));
  parts.push(u32(eventId));

  if (CONNECT_LEVEL_EVENTS.has(eventId)) {
    // 注意：火山线上服务不接受 connect-level 帧里的 connect id 可选字段
    //（会报 body size mismatch），真实桥接时传 includeConnectId:false。保留该字段仅为测试/兼容。
    if (connectId && includeConnectId) {
      const cid = Buffer.from(String(connectId), 'utf8');
      parts.push(u32(cid.length), cid);
    }
  } else if (sessionId) {
    const sid = Buffer.from(String(sessionId), 'utf8');
    parts.push(u32(sid.length), sid);
  }

  let body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  if (compression === COMPRESSION.GZIP) body = gzipSync(body);
  parts.push(u32(body.length), body);
  return Buffer.concat(parts);
}

/** 编码音频上行帧（TaskRequest 200，音频-only 消息） */
export function encodeAudio(audio, sessionId) {
  const parts = [buildHeader(MSG_TYPE.AUDIO_ONLY_REQUEST, FLAG_EVENT, SERIALIZATION.RAW)];
  parts.push(u32(CLIENT_EVENT.TASK_REQUEST));
  if (sessionId) {
    const sid = Buffer.from(String(sessionId), 'utf8');
    parts.push(u32(sid.length), sid);
  }
  const data = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  parts.push(u32(data.length), data);
  return Buffer.concat(parts);
}

/** 编码服务端事件（供测试 mock 使用） */
export function encodeServerEvent({ eventId, payload = {}, sessionId = '', compression = COMPRESSION.NONE }) {
  return encodeEvent({
    msgType: MSG_TYPE.FULL_SERVER_RESPONSE,
    eventId,
    payload,
    sessionId,
    compression,
  });
}

/** 编码服务端音频下行帧（供测试 mock 使用） */
export function encodeServerAudio(audio, sessionId = '') {
  const parts = [buildHeader(MSG_TYPE.AUDIO_ONLY_RESPONSE, 0, SERIALIZATION.RAW)];
  if (sessionId) {
    const sid = Buffer.from(String(sessionId), 'utf8');
    parts.push(u32(sid.length), sid);
  }
  const data = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  parts.push(u32(data.length), data);
  return Buffer.concat(parts);
}

/** 编码错误帧（协议层错误） */
export function encodeError({ code = 0, message = '', sessionId = '' }) {
  return encodeEvent({
    msgType: MSG_TYPE.ERROR,
    eventId: 0,
    payload: { error: message },
    sessionId,
    errorCode: code,
  });
}

/**
 * 解析服务端/客户端二进制帧。
 * @returns {{msgType:number, flags:number, serialization:number, compression:number,
 *   eventId:number|null, sessionId:string|null, connectId:string|null, sequence:number|null,
 *   errorCode:number|null, payload:Buffer|null, json:object|null}}
 */
export function parseFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 4) throw new Error(`帧太短：${buf.length} 字节`);
  const frame = {
    msgType: (buf[1] >> 4) & 0x0f,
    flags: buf[1] & 0x0f,
    serialization: (buf[2] >> 4) & 0x0f,
    compression: buf[2] & 0x0f,
    eventId: null,
    sessionId: null,
    connectId: null,
    sequence: null,
    errorCode: null,
    payload: null,
    json: null,
  };
  let pos = 4;
  const readU32 = () => {
    if (pos + 4 > buf.length) return 0;
    const v = buf.readUInt32BE(pos);
    pos += 4;
    return v;
  };

  if (frame.msgType === MSG_TYPE.ERROR && pos + 4 <= buf.length) {
    frame.errorCode = readU32();
  }

  const seqMode = frame.flags & 0b0011;
  if ((seqMode === 0b0001 || seqMode === 0b0011) && pos + 4 <= buf.length) {
    frame.sequence = buf.readInt32BE(pos);
    pos += 4;
  }

  if (frame.flags & FLAG_EVENT && pos + 4 <= buf.length) {
    frame.eventId = readU32();
    const isConnectLevel = CONNECT_LEVEL_EVENTS.has(frame.eventId);
    if (frame.eventId >= 100 || isConnectLevel) {
      const idLen = readU32();
      if (idLen > 0 && pos + idLen <= buf.length) {
        const id = buf.subarray(pos, pos + idLen).toString('utf8');
        pos += idLen;
        if (isConnectLevel) frame.connectId = id;
        else frame.sessionId = id;
      }
    }
  }

  if (pos + 4 <= buf.length) {
    const payloadSize = buf.readUInt32BE(pos);
    pos += 4;
    if (payloadSize > 0 && pos + payloadSize <= buf.length) {
      let raw = buf.subarray(pos, pos + payloadSize);
      if (frame.compression === COMPRESSION.GZIP) {
        try {
          raw = gunzipSync(raw);
        } catch {
          /* 保持原始负载 */
        }
      }
      frame.payload = raw;
      if (frame.serialization === SERIALIZATION.JSON) {
        try {
          frame.json = JSON.parse(raw.toString('utf8'));
        } catch {
          frame.json = null;
        }
      }
    }
  }
  return frame;
}

/** 生成随机会话/连接 id（uuid v4 形式） */
export function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default {
  MSG_TYPE,
  SERIALIZATION,
  COMPRESSION,
  CLIENT_EVENT,
  SERVER_EVENT,
  FLAG_EVENT,
  CONNECT_LEVEL_EVENTS,
  encodeEvent,
  encodeAudio,
  encodeServerEvent,
  encodeServerAudio,
  encodeError,
  parseFrame,
  generateId,
};
