/**
 * 对话记忆与用户兴趣档案（本地 JSON，不上云）。
 * - data/profile.json：用户自填兴趣
 * - data/memory.json：按角色的长期记忆（兴趣/事实/聊过的话题/摘要）
 */
import { join } from 'node:path';
import { DATA_DIR, readJsonFile, writeJsonFile } from './config.js';
import { chatJSON } from './llmJson.js';
import { buildMemoryMessages } from '../content/prompts.js';

const PROFILE_PATH = join(DATA_DIR, 'profile.json');
const MEMORY_PATH = join(DATA_DIR, 'memory.json');
const MAX_INTERESTS = 24;
const MAX_FACTS = 24;
const MAX_TOPICS = 30;

function normList(list, max) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const s = String(item == null ? '' : typeof item === 'string' ? item : item.topic || item.text || '')
      .trim()
      .slice(0, 60);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function loadProfile() {
  const p = readJsonFile(PROFILE_PATH, { interests: [] });
  return { interests: normList(p.interests, MAX_INTERESTS), updatedAt: p.updatedAt || 0 };
}

export function saveProfile(patch = {}) {
  const cur = loadProfile();
  const next = {
    interests: patch.interests !== undefined ? normList(patch.interests, MAX_INTERESTS) : cur.interests,
    updatedAt: Date.now(),
  };
  writeJsonFile(PROFILE_PATH, next);
  return next;
}

export function loadMemory() {
  const m = readJsonFile(MEMORY_PATH, { characters: {} });
  if (!m || typeof m !== 'object') return { characters: {} };
  if (!m.characters || typeof m.characters !== 'object') m.characters = {};
  return m;
}

function emptyMemory() {
  return { interests: [], facts: [], topics: [], summary: '', updatedAt: 0 };
}

export function getCharacterMemory(characterId) {
  const m = loadMemory();
  const entry = m.characters[characterId];
  if (!entry || typeof entry !== 'object') return emptyMemory();
  return {
    interests: normList(entry.interests, MAX_INTERESTS),
    facts: normList(entry.facts, MAX_FACTS),
    topics: normList(entry.topics, MAX_TOPICS),
    summary: String(entry.summary || '').slice(0, 400),
    updatedAt: entry.updatedAt || 0,
  };
}

export function saveCharacterMemory(characterId, memory) {
  const m = loadMemory();
  m.characters[characterId] = { ...emptyMemory(), ...memory, updatedAt: Date.now() };
  writeJsonFile(MEMORY_PATH, m);
  return m.characters[characterId];
}

/** 合并新旧记忆（并集、保序、限量） */
export function mergeMemory(existing, patch = {}) {
  const union = (a, b, max) => normList([...(a || []), ...(b || [])], max);
  return {
    interests: union(existing?.interests, patch.interests, MAX_INTERESTS),
    facts: union(existing?.facts, patch.facts, MAX_FACTS),
    topics: union(existing?.topics, patch.topics, MAX_TOPICS),
    summary: String(patch.summary || existing?.summary || '').slice(0, 400),
    updatedAt: Date.now(),
  };
}

/** 生成注入 prompt 的记忆文本 */
export function formatMemoryForPrompt(characterId) {
  const profile = loadProfile();
  const memory = getCharacterMemory(characterId);
  const parts = [];
  if (profile.interests.length) parts.push(`User's stated interests: ${profile.interests.join('、')}`);
  if (memory.interests.length) parts.push(`Learned interests: ${memory.interests.join('、')}`);
  if (memory.facts.length) parts.push(`Facts about the student: ${memory.facts.join('；')}`);
  if (memory.topics.length) parts.push(`Topics already discussed recently: ${memory.topics.slice(-12).join('、')}`);
  if (memory.summary) parts.push(`Recent life summary: ${memory.summary}`);
  return parts.join('\n').slice(0, 2000);
}

/** 从历史里提取最近问过的问题（避免重复） */
export function recentQuestionsFromHistory(history = [], limit = 8) {
  const questions = [];
  for (const msg of Array.isArray(history) ? history : []) {
    if (!msg || msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
    const sentences = msg.content.split(/(?<=[?？.。!！])\s*/);
    for (const s of sentences) {
      if (/[?？]\s*$/.test(s.trim())) {
        const q = s.trim().slice(0, 160);
        if (q && !questions.includes(q)) questions.push(q);
      }
    }
  }
  return questions.slice(-limit);
}

/**
 * 从一段对话更新角色记忆（DeepSeek JSON；失败返回 null 不影响主流程）。
 */
export async function updateMemoryFromConversation({ settings, characterId, character, messages = [] } = {}) {
  if (!settings?.apiKey || !characterId) return null;
  const existing = getCharacterMemory(characterId);
  try {
    const { parsed } = await chatJSON({
      settings,
      messages: buildMemoryMessages({ character, existingSummary: existing.summary, messages }),
      temperature: 0.3,
      maxTokens: 800,
      timeoutMs: 25_000,
    });
    if (!parsed || typeof parsed !== 'object') return null;
    const merged = mergeMemory(existing, {
      interests: parsed.interests,
      facts: parsed.facts,
      topics: parsed.topics,
      summary: parsed.summary,
    });
    saveCharacterMemory(characterId, merged);
    return merged;
  } catch {
    return null;
  }
}

/** 后台更新记忆（不阻塞请求） */
export function updateMemoryInBackground(opts) {
  updateMemoryFromConversation(opts).catch(() => {});
}

export default {
  loadProfile,
  saveProfile,
  loadMemory,
  getCharacterMemory,
  saveCharacterMemory,
  mergeMemory,
  formatMemoryForPrompt,
  recentQuestionsFromHistory,
  updateMemoryFromConversation,
  updateMemoryInBackground,
};
