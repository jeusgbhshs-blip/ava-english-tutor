/**
 * 配置读写：data/settings.json（权限 600，apiKey 不落前端）。
 * 环境变量优先级最高：AVA_BASE_URL / AVA_MODEL / AVA_API_KEY（便于自动化测试）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialsForEndpoint } from './requestSafety.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.AVA_DATA_DIR
  ? resolve(process.env.AVA_DATA_DIR)
  : join(ROOT, 'data');
export const RUNTIME_DIR = join(ROOT, '.runtime');
export const WEB_ROOT = join(ROOT, 'web');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

export const LEVELS = [
  { id: 'A1', name: '入门', desc: '零基础 · 简单单词和短句' },
  { id: 'A2', name: '基础', desc: '能进行日常简单对话' },
  { id: 'B1', name: '进阶', desc: '能表达观点、描述经历' },
  { id: 'B2', name: '中高级', desc: '流利讨论抽象话题' },
  { id: 'C1', name: '高级', desc: '接近母语者的灵活表达' },
];

export const PRESETS = [
  { name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'Kimi 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
];

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  level: 'A2',
  teacherName: 'Ava',
  voice: '',
  explainChinese: true,
  autoListen: false,
  voiceEngine: 'browser',
  volc: {
    appId: '',
    apiKey: '',
    accessToken: '',
    model: '3.0',
    speaker: 'en_female_dacey_uranus_bigtts',
    endpoint: 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue',
    resourceId: 'volc.speech.dialog',
  },
};

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readJsonFile(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON */
export function writeJsonFile(path, data) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** 只保留已知字段 + 做边界校验 */
export function normalizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(input || {}) };
  const levelIds = LEVELS.map((l) => l.id);
  const baseUrl = String(merged.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(merged.model || '').trim();
  const rawVolc = merged.volc && typeof merged.volc === 'object' ? merged.volc : {};
  const endpoint = String(rawVolc.endpoint || DEFAULT_SETTINGS.volc.endpoint).trim();
  const volc = {
    appId: String(rawVolc.appId || '').trim().slice(0, 200),
    apiKey: String(rawVolc.apiKey || '').trim().slice(0, 1000),
    accessToken: String(rawVolc.accessToken || '').trim().slice(0, 2000),
    model: String(rawVolc.model || DEFAULT_SETTINGS.volc.model).trim().slice(0, 40),
    speaker: String(rawVolc.speaker || DEFAULT_SETTINGS.volc.speaker).trim().slice(0, 200),
    endpoint: /^wss?:\/\//i.test(endpoint) ? endpoint : DEFAULT_SETTINGS.volc.endpoint,
    resourceId: String(rawVolc.resourceId || DEFAULT_SETTINGS.volc.resourceId).trim().slice(0, 120),
  };
  return {
    baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : DEFAULT_SETTINGS.baseUrl,
    model: model.slice(0, 120) || DEFAULT_SETTINGS.model,
    apiKey: String(merged.apiKey || '').trim(),
    level: levelIds.includes(merged.level) ? merged.level : DEFAULT_SETTINGS.level,
    teacherName: String(merged.teacherName || 'Ava').trim().slice(0, 16) || 'Ava',
    voice: String(merged.voice || '').slice(0, 120),
    explainChinese: merged.explainChinese !== false,
    autoListen: merged.autoListen === true,
    voiceEngine: merged.voiceEngine === 'volc' ? 'volc' : 'browser',
    volc,
  };
}

/** 读取设置：文件 + 环境变量覆盖 */
export function loadSettings() {
  const fromFile = normalizeSettings(readJsonFile(SETTINGS_PATH, DEFAULT_SETTINGS));
  const env = {};
  if (process.env.AVA_BASE_URL) env.baseUrl = process.env.AVA_BASE_URL;
  if (process.env.AVA_MODEL) env.model = process.env.AVA_MODEL;
  if (process.env.AVA_API_KEY) env.apiKey = process.env.AVA_API_KEY;
  const volcEnv = {};
  if (process.env.AVA_VOLC_ENDPOINT) volcEnv.endpoint = process.env.AVA_VOLC_ENDPOINT;
  if (process.env.AVA_VOLC_APP_ID) volcEnv.appId = process.env.AVA_VOLC_APP_ID;
  if (process.env.AVA_VOLC_API_KEY) volcEnv.apiKey = process.env.AVA_VOLC_API_KEY;
  if (process.env.AVA_VOLC_ACCESS_TOKEN) volcEnv.accessToken = process.env.AVA_VOLC_ACCESS_TOKEN;
  if (process.env.AVA_VOLC_MODEL) volcEnv.model = process.env.AVA_VOLC_MODEL;
  if (process.env.AVA_VOLC_SPEAKER) volcEnv.speaker = process.env.AVA_VOLC_SPEAKER;
  if (Object.keys(volcEnv).length) env.volc = { ...fromFile.volc, ...volcEnv };
  return normalizeSettings({ ...fromFile, ...env });
}

/** 合并式保存（apiKey 非空才覆盖；clearKey 清空） */
export function saveSettingsPatch(patch = {}) {
  const current = loadSettings();
  const next = { ...current };
  const writable = ['baseUrl', 'model', 'level', 'teacherName', 'voice', 'explainChinese', 'autoListen'];
  for (const key of writable) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    next.apiKey = patch.apiKey.trim();
  }
  if (patch.clearKey === true) next.apiKey = '';
  if (patch.voiceEngine === 'browser' || patch.voiceEngine === 'volc') next.voiceEngine = patch.voiceEngine;
  if (patch.volc && typeof patch.volc === 'object' && !Array.isArray(patch.volc)) {
    const currentVolc = { ...(next.volc || {}) };
    const incoming = patch.volc;
    for (const key of ['appId', 'model', 'speaker', 'endpoint', 'resourceId']) {
      if (incoming[key] !== undefined) currentVolc[key] = incoming[key];
    }
    if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim()) currentVolc.apiKey = incoming.apiKey.trim();
    if (typeof incoming.accessToken === 'string' && incoming.accessToken.trim()) currentVolc.accessToken = incoming.accessToken.trim();
    if (incoming.clearKey === true) {
      currentVolc.apiKey = '';
      currentVolc.accessToken = '';
    }
    next.volc = currentVolc;
  }
  const normalized = normalizeSettings(next);
  // Environment credentials win on the next read, so a form key/clear cannot
  // replace them. Keep their origin fixed until the environment is updated.
  if (process.env.AVA_API_KEY?.trim()) {
    credentialsForEndpoint({
      previousUrl: current.baseUrl,
      nextUrl: normalized.baseUrl,
      previousCredentials: { apiKey: process.env.AVA_API_KEY },
      errorMessage: '当前模型密钥由 AVA_API_KEY 环境变量提供；更换接口源站前，请先更新或移除该环境变量。',
    });
  }
  if (process.env.AVA_VOLC_API_KEY?.trim() || process.env.AVA_VOLC_ACCESS_TOKEN?.trim()) {
    credentialsForEndpoint({
      previousUrl: current.volc.endpoint,
      nextUrl: normalized.volc.endpoint,
      previousCredentials: {
        apiKey: process.env.AVA_VOLC_API_KEY?.trim() || '',
        accessToken: process.env.AVA_VOLC_ACCESS_TOKEN?.trim() || '',
      },
      protocols: ['ws:', 'wss:'],
      errorMessage: '当前语音凭据由环境变量提供；更换接口源站前，请先更新或移除 AVA_VOLC_API_KEY / AVA_VOLC_ACCESS_TOKEN。',
    });
  }
  normalized.apiKey = credentialsForEndpoint({
    previousUrl: current.baseUrl,
    nextUrl: normalized.baseUrl,
    previousCredentials: { apiKey: current.apiKey },
    providedCredentials: { apiKey: patch.apiKey },
    clear: patch.clearKey,
    errorMessage: '更换模型接口源站时，请填写用于新地址的 API Key，或先清空已保存的 Key。',
  }).apiKey;
  const volcPatch = patch.volc && typeof patch.volc === 'object' && !Array.isArray(patch.volc) ? patch.volc : {};
  const volcCredentials = credentialsForEndpoint({
    previousUrl: current.volc.endpoint,
    nextUrl: normalized.volc.endpoint,
    previousCredentials: { apiKey: current.volc.apiKey, accessToken: current.volc.accessToken },
    providedCredentials: {
      apiKey: typeof volcPatch.apiKey === 'string' ? volcPatch.apiKey.trim().slice(0, 1000) : '',
      accessToken: typeof volcPatch.accessToken === 'string' ? volcPatch.accessToken.trim().slice(0, 2000) : '',
    },
    clear: volcPatch.clearKey,
    protocols: ['ws:', 'wss:'],
    errorMessage: '更换语音接口源站时，请填写用于新地址的 API Key 或 Access Token，或先清空已保存的凭据。',
  });
  Object.assign(normalized.volc, volcCredentials);
  writeJsonFile(SETTINGS_PATH, normalized);
  try {
    chmodSync(SETTINGS_PATH, 0o600);
  } catch {
    /* Windows 等平台忽略 */
  }
  return normalized;
}

/** 打码：sk-abcd…wxyz */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** 返回给前端的设置（绝不包含 apiKey 原文） */
export function publicSettings(settings = loadSettings()) {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasKey: Boolean(settings.apiKey),
    keyHint: maskKey(settings.apiKey),
    level: settings.level,
    teacherName: settings.teacherName,
    voice: settings.voice,
    explainChinese: settings.explainChinese,
    autoListen: settings.autoListen,
    voiceEngine: settings.voiceEngine || 'browser',
    volc: {
      appId: settings.volc?.appId || '',
      model: settings.volc?.model || '3.0',
      speaker: settings.volc?.speaker || '',
      endpoint: settings.volc?.endpoint || '',
      resourceId: settings.volc?.resourceId || '',
      hasKey: Boolean(settings.volc?.apiKey || settings.volc?.accessToken),
      keyHint: maskKey(settings.volc?.apiKey || settings.volc?.accessToken || ''),
      configured: Boolean(settings.volc?.appId && (settings.volc?.apiKey || settings.volc?.accessToken)),
    },
    presets: PRESETS,
    levels: LEVELS,
  };
}
