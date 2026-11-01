/**
 * 豆包独立语音合成（HTTP 单向流式，资源 seed-tts-2.0）。
 * 用途：课程常用句点读 / 浏览器兜底朗读时，使用数字人原声，而不是系统统一 TTS。
 *
 * 说明：
 * - 角色 voice.speaker 若属于旧 1.0 音色（不带 uranus / 非 seed-tts-2.0），映射到兼容的英语教师音色；
 * - 结果按 speaker+text+rate 缓存到 data/tts-cache/，点读重复句子不重复计费；
 * - 无 Key / 接口失败时抛错，前端回退浏览器 TTS。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, loadSettings } from './config.js';
import { findCharacter, characters } from '../content/characters.js';

const TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const TTS_RESOURCE = 'seed-tts-2.0';
const TTS_CACHE_DIR = join(DATA_DIR, 'tts-cache');
const MAX_CACHE_FILES = 400;
const MAX_CACHE_BYTES = 80 * 1024 * 1024;
const MAX_TEXT = 600;
const TTS_CHUNK_MAX = 500;
const TTS_INPUT_MAX = 4000;

/**
 * 旧音色找不到 seed-tts-2.0 资源时的英语教师兼容音色。
 * vv_jupiter 是 1.0 音色（资源 volc.service_type.10029），当前账号未授权，改用 2.0 英音教师音色。
 */
const COMPAT_SPEAKERS = {
  'zh_female_vv_jupiter_bigtts': 'zh_female_yingyujiaoxue_uranus_bigtts',
};

const KNOWN_SPEAKERS = new Set();
for (const character of characters) {
  const speaker = character.voice && character.voice.speaker;
  if (speaker) {
    KNOWN_SPEAKERS.add(speaker);
    if (COMPAT_SPEAKERS[speaker]) KNOWN_SPEAKERS.add(COMPAT_SPEAKERS[speaker]);
  }
}

function resolveVolc(settings) {
  const volc = (settings && settings.volc) || {};
  const apiKey = process.env.AVA_TTS_API_KEY || volc.apiKey || '';
  const appId = volc.appId || '';
  return { apiKey, appId };
}

function resolveSpeaker({ characterId = '', speaker = '' } = {}) {
  const requested = String(speaker || '').trim();
  if (requested) {
    if (KNOWN_SPEAKERS.has(requested)) return COMPAT_SPEAKERS[requested] || requested;
    return requested;
  }
  const character = findCharacter(characterId);
  if (character && character.voice && character.voice.speaker) {
    const raw = character.voice.speaker;
    return COMPAT_SPEAKERS[raw] || raw;
  }
  const settings = loadSettings();
  const fallback = (settings.volc && settings.volc.speaker) || 'en_female_dacey_uranus_bigtts';
  return COMPAT_SPEAKERS[fallback] || fallback;
}

function rateToSpeechRate(rate, characterId) {
  let value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) {
    const character = findCharacter(characterId);
    value = (character && character.voice && Number(character.voice.rate)) || 1;
  }
  // rate 0.95 → -5；1.02 → 2；范围 [-50,100]
  return Math.max(-50, Math.min(100, Math.round((value - 1) * 100)));
}

function cacheKey(speaker, text, speechRate) {
  return createHash('sha1').update(`${speaker}|${speechRate}|${text}`).digest('hex');
}

function ensureCacheDir() {
  mkdirSync(TTS_CACHE_DIR, { recursive: true });
}

function pruneCache() {
  try {
    const files = readdirSync(TTS_CACHE_DIR)
      .map((name) => {
        const path = join(TTS_CACHE_DIR, name);
        try {
          return { name, path, stat: statSync(path) };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    let total = files.reduce((sum, f) => sum + f.stat.size, 0);
    for (let i = MAX_CACHE_FILES; i < files.length; i++) {
      try {
        unlinkSync(files[i].path);
        total -= files[i].stat.size;
      } catch {
        /* ignore */
      }
    }
    for (let i = MAX_CACHE_FILES - 1; i >= 0 && total > MAX_CACHE_BYTES; i--) {
      try {
        unlinkSync(files[i].path);
        total -= files[i].stat.size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function parseTtsBody(bodyText) {
  const chunks = [];
  let lastError = null;
  for (const line of String(bodyText || '').split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    if (json.code && json.code !== 0 && json.code !== 20000000) {
      lastError = json.message || `TTS 错误码 ${json.code}`;
      continue;
    }
    if (typeof json.data === 'string' && json.data) {
      try {
        chunks.push(Buffer.from(json.data, 'base64'));
      } catch {
        /* ignore invalid base64 */
      }
    }
  }
  return { chunks, lastError };
}

/**
 * 合成语音（mp3 Buffer）。
 * @param {{ text: string, characterId?: string, speaker?: string, rate?: number }} opts
 * @returns {Promise<{ buffer: Buffer, mime: string, speaker: string, fromCache: boolean }>}
 */
async function synthesizeOne({ text = '', characterId = '', speaker = '', rate } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('文本不能为空');
  const settings = loadSettings();
  const { apiKey, appId } = resolveVolc(settings);
  if (!apiKey) throw new Error('未配置豆包语音 Key');
  const resolvedSpeaker = resolveSpeaker({ characterId, speaker });
  const speechRate = rateToSpeechRate(rate, characterId);
  ensureCacheDir();
  const key = cacheKey(resolvedSpeaker, clean, speechRate);
  const cachePath = join(TTS_CACHE_DIR, `${key}.mp3`);
  if (existsSync(cachePath)) {
    try {
      const buffer = readFileSync(cachePath);
      if (buffer.length > 1000) {
        return { buffer, mime: 'audio/mpeg', speaker: resolvedSpeaker, fromCache: true };
      }
    } catch {
      /* ignore and regenerate */
    }
  }

  const headers = {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': TTS_RESOURCE,
    'X-Api-Request-Id': cryptoRandomId(),
    'content-type': 'application/json',
  };
  if (appId) headers['X-Api-App-Id'] = appId;
  const body = {
    req_params: {
      text: clean,
      speaker: resolvedSpeaker,
      audio_params: {
        format: 'mp3',
        sample_rate: 24000,
        speech_rate: speechRate,
      },
    },
  };
  let response;
  try {
    response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`语音合成网络失败：${err.message}`);
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`语音合成请求失败（HTTP ${response.status}）：${raw.slice(0, 120)}`);
  }
  const { chunks, lastError } = parseTtsBody(raw);
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) {
    throw new Error(lastError || '语音合成没有返回音频');
  }
  try {
    writeFileSync(cachePath, buffer);
    pruneCache();
  } catch {
    /* cache 写失败不影响播放 */
  }
  return { buffer, mime: 'audio/mpeg', speaker: resolvedSpeaker, fromCache: false };
}

/** 把长文本切成适合 TTS 的块（≤500 字符），避免 600 字符上限直接截断。 */
function splitTtsText(value, max = TTS_CHUNK_MAX) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const sentences = text.match(/[^.!?。！？;；]+[.!?。！？;；]?/g) || [text];
  const chunks = [];
  let buf = '';
  const push = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = '';
  };
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > max) {
      push();
      const words = sentence.split(/\s+/);
      let part = '';
      for (const word of words) {
        if (word.length > max) {
          if (part) push();
          for (let i = 0; i < word.length; i += max) chunks.push(word.slice(i, i + max));
          continue;
        }
        if ((part + ' ' + word).trim().length > max) {
          if (part) chunks.push(part.trim());
          part = word;
        } else {
          part = part ? `${part} ${word}` : word;
        }
      }
      if (part) chunks.push(part.trim());
      continue;
    }
    if ((buf + ' ' + sentence).trim().length > max) push();
    buf = buf ? `${buf} ${sentence}` : sentence;
  }
  push();
  return chunks;
}

/**
 * 合成语音（mp3 Buffer）。
 * - 短文本一次请求；
 * - 长文本按句/词切成 ≤500 字符，逐块合成后拼接 mp3，避免被 600 字符上限截断。
 */
export async function synthesizeSpeech({ text = '', characterId = '', speaker = '', rate } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, TTS_INPUT_MAX);
  if (!clean) throw new Error('文本不能为空');
  const chunks = splitTtsText(clean);
  if (chunks.length <= 1) return synthesizeOne({ text: clean, characterId, speaker, rate });
  const buffers = [];
  let resolvedSpeaker = '';
  let fromCache = true;
  for (const chunk of chunks) {
    const result = await synthesizeOne({ text: chunk, characterId, speaker, rate });
    buffers.push(result.buffer);
    resolvedSpeaker = result.speaker || resolvedSpeaker;
    if (!result.fromCache) fromCache = false;
  }
  return {
    buffer: Buffer.concat(buffers),
    mime: 'audio/mpeg',
    speaker: resolvedSpeaker,
    fromCache,
  };
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 可用音色列表（诊断/前端展示用） */
export function listTtsVoices() {
  return characters.map((character) => {
    const raw = character.voice && character.voice.speaker;
    return {
      characterId: character.id,
      name: character.name,
      speaker: raw,
      ttsSpeaker: raw ? COMPAT_SPEAKERS[raw] || raw : '',
      realtimeSpeaker: raw || '',
    };
  });
}

export default { synthesizeSpeech, listTtsVoices };
