/**
 * 内容聚合入口：给 /api/content 使用。
 */
import { freeTalkTopics, roleplayScenarios, sentenceBanks, DEFAULT_TOPIC_ID, DEFAULT_SCENARIO_ID } from './scenarios.js';
import { vocabTopics } from './vocab.js';
import { freeOpeners, icebreakers } from './openers.js';
import { LEVELS, PRESETS } from '../lib/config.js';

export const MODES = [
  { id: 'free', name: '自由对话', emoji: '💬', desc: '像和朋友聊天一样练口语' },
  { id: 'vocab', name: '单词闯关', emoji: '🎯', desc: '词卡、跟读、拼写测验' },
  { id: 'pronounce', name: '跟读打分', emoji: '🎙️', desc: '逐词评分 + 发音提示' },
  { id: 'roleplay', name: '角色扮演', emoji: '🎭', desc: '真实场景对话演练' },
  { id: 'reading', name: '阅读讲解', emoji: '📄', desc: '上传英文文档/图片，Ava 带你精读' },
];

export function getContent() {
  return {
    topics: freeTalkTopics,
    scenarios: roleplayScenarios,
    sentenceBanks,
    vocabTopics,
    modes: MODES,
    levels: LEVELS,
    presets: PRESETS,
    defaults: { topicId: DEFAULT_TOPIC_ID, scenarioId: DEFAULT_SCENARIO_ID },
    openers: { free: freeOpeners },
    icebreakers,
    topicsNote: '话题卡只是聊天灵感，Ava 在自由对话里可以聊任何话题。',
  };
}

export function findTopic(id) {
  return freeTalkTopics.find((t) => t.id === id) || null;
}

export function findScenario(id) {
  return roleplayScenarios.find((s) => s.id === id) || null;
}

export function findSentenceBank(id) {
  return sentenceBanks.find((b) => b.id === id) || null;
}

export function findVocabTopic(id) {
  return vocabTopics.find((t) => t.id === id) || null;
}
