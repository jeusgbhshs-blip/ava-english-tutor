#!/usr/bin/env node
/**
 * Ava — AI 数字人英语老师 · 本地服务器（零第三方依赖）
 * 静态资源 + /api 接口 + SSE 流式对话 + 演示模式降级。
 */
import http from 'node:http';
import os from 'node:os';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { credentialsForEndpoint } from './lib/requestSafety.js';
import {
  loadSettings,
  saveSettingsPatch,
  publicSettings,
  PRESETS,
  LEVELS,
  WEB_ROOT,
  RUNTIME_DIR,
  ROOT,
  DATA_DIR,
} from './lib/config.js';
import { getContent, findTopic, findScenario } from './content/index.js';
import { scorePronunciation } from './lib/score.js';
import { loadProgress, recordActivity, publicProgress, addVocabWords } from './lib/progress.js';
import { summarizeConversation } from './lib/summary.js';
import { addWords, getWordbook } from './lib/wordbook.js';
import { extractText } from './lib/docExtract.js';
import { saveDoc, getDoc, saveDocAnalysis, listDocs, deleteDoc, makeDocId, publicDoc } from './lib/docStore.js';
import { analyzeDocument } from './lib/docAnalysis.js';
import { attachWsServer } from './lib/wsServer.js';
import { VolcRealtimeSession, testVolcConnection, friendlyVolcError } from './lib/volcRealtime.js';
import { coachAnalysis } from './lib/coach.js';
import { getPublicCharacters, publicCharacter, findCharacter } from './content/characters.js';
import {
  loadPlan,
  savePlan,
  createUserPlan,
  updatePlan,
  setPlanTeacher,
  resetPlanForGeneration,
  completeLesson,
  saveLessonProgress,
  clearLessonProgress,
  decoratePlan,
  getPlanLesson,
  listPlanLessons,
} from './lib/plans.js';
import { generatePlanLessonsInBackground, isPlanGenerating } from './lib/lessonGen.js';
import { assistantReply } from './lib/assistant.js';
import {
  listDocuments as listKBDocs,
  getDocument as getKBDoc,
  addFromFile as addKBFile,
  addDocument as addKBText,
  importWebPage as importKBWeb,
  deleteDocument as deleteKBDoc,
  searchKB,
  enrichDocument as enrichKBDoc,
  enrichInBackground as enrichKBInBackground,
  buildKBrief,
  buildKBTeachingMaterial,
  kbStats,
} from './lib/kb.js';
import {
  loadProfile,
  saveProfile,
  formatMemoryForPrompt,
  recentQuestionsFromHistory,
  updateMemoryInBackground,
} from './lib/memory.js';
import { planTurn } from './lib/director.js';
import {
  getSummary as getReviewSummary,
  getDue as getReviewDue,
  listWords as listReviewWords,
  upsertWords as upsertReviewWords,
  updateWord as updateReviewWord,
  deleteWord as deleteReviewWord,
  gradeWord as gradeReviewWord,
  syncFromSummary as syncReviewFromSummary,
} from './lib/review.js';
import { translateTexts } from './lib/translator.js';
import { synthesizeSpeech, listTtsVoices } from './lib/tts.js';
import { streamChat, testConnection, friendlyErrorMessage } from './lib/llm.js';
import { buildSystemPrompt, buildGroundedChatSystemPrompt, buildRealtimePersona, EMPTY_FEEDBACK } from './content/prompts.js';
import { buildDemoReply, buildDemoReadingReply, buildDemoCharacterReply } from './content/demo.js';

const VERSION = '1.0.0';
const MAX_BODY = 1_000_000;
const VALID_MODES = new Set(['free', 'vocab', 'pronounce', 'roleplay', 'reading']);
const VALID_LEVELS = new Set(LEVELS.map((l) => l.id));
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------- 基础工具 ------------------------------- */

function parseArgs(argv) {
  const args = { port: null, open: false, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') args.open = true;
    else if (a === '--share') args.host = '0.0.0.0';
    else if (a.startsWith('--port=')) args.port = Number(a.split('=')[1]);
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a.startsWith('--host=')) args.host = String(a.split('=')[1] || '127.0.0.1');
    else if (a === '--host') args.host = String(argv[++i] || '127.0.0.1');
  }
  return args;
}

/** 本机局域网 IPv4 地址（用于分享链接提示） */
function lanAddresses() {
  const list = [];
  try {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces || []) {
        if (!iface || iface.internal) continue;
        if (iface.family !== 'IPv4' && iface.family !== 4) continue;
        list.push(iface.address);
      }
    }
  } catch {
    /* ignore */
  }
  return list;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, status, data) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function sseOpen(res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
}

function sseSend(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const data = JSON.parse(raw);
        resolve(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
      } catch {
        reject(Object.assign(new Error('请求体不是合法的 JSON'), { status: 400 }));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

/* ------------------------------- 静态文件 ------------------------------- */

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: '不支持的请求方法' });
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  if (rel === '/mobile' || rel === '/mobile/') rel = '/mobile.html';
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0')) return sendText(res, 400, 'Bad Request');
  const normalized = normalize(rel).replace(/^([/\\])+/, '');
  const fullPath = join(WEB_ROOT, normalized);
  if (!fullPath.startsWith(WEB_ROOT + sep)) return sendText(res, 403, 'Forbidden');

  let data;
  try {
    data = await readFile(fullPath);
  } catch {
    // 无扩展名的前端路由回退到 index.html
    if (!extname(pathname)) {
      try {
        data = await readFile(join(WEB_ROOT, 'index.html'));
      } catch {
        return sendText(res, 404, 'Not Found');
      }
    } else {
      return sendText(res, 404, 'Not Found');
    }
  }
  const type = MIME[extname(fullPath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': data.length,
  });
  if (req.method === 'HEAD') return res.end();
  res.end(data);
}

/* --------------------------------- 业务 --------------------------------- */

/**
 * 聊天历史：保留足够长的上下文，同时限制总字符数，避免一次请求过大。
 * v3.6：上限从 20 条/条 1200 字提高到 60 条 / 32k 字符；正常一次通话几百轮也不会过早丢失。
 */
function sanitizeHistory(history, { maxMessages = 60, maxChars = 32000 } = {}) {
  if (!Array.isArray(history)) return [];
  const clean = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  const kept = [];
  let chars = 0;
  for (let i = clean.length - 1; i >= 0 && kept.length < maxMessages; i -= 1) {
    const item = clean[i];
    if (chars + item.content.length > maxChars && kept.length > 0) break;
    kept.push(item);
    chars += item.content.length;
  }
  return kept.reverse();
}

/** 实时语音会话的最近上下文（客户端 start 帧携带；会话重连/重置后仍能接上前文） */
function sanitizeRealtimeHistory(history, { maxMessages = 24, maxChars = 6000 } = {}) {
  const clean = sanitizeHistory(history, { maxMessages, maxChars });
  return clean.map((m) => ({ role: m.role, content: m.content.slice(0, 300) }));
}

function buildChatContext(body, settings, docInfo = null, extras = {}) {
  const mode = VALID_MODES.has(body.mode) ? body.mode : 'free';
  const level = VALID_LEVELS.has(body.level) ? body.level : settings.level;
  // free 模式不锁话题：Ava 像朋友一样随便聊，忽略 topicId
  const topic = null;
  const scenario = mode === 'roleplay' ? findScenario(body.scenarioId) : null;
  const focusWords = Array.isArray(body.focusWords)
    ? body.focusWords.filter((w) => typeof w === 'string').slice(0, 6)
    : [];
  let userMsg = typeof body.message === 'string' ? body.message.trim().slice(0, 1200) : '';
  // 阅读讲解：允许用 start:true 触发 Ava 开场（内部合成一条用户消息）
  if (mode === 'reading' && !userMsg && body.start === true) {
    userMsg = 'Start reading. Introduce this text and ask me the first comprehension question.';
  }
  const character = mode === 'reading' ? null : findCharacter(body.characterId);
  const sceneId = typeof body.sceneId === 'string' ? body.sceneId.slice(0, 40) : '';
  const lessonId = typeof body.lessonId === 'string' ? body.lessonId.slice(0, 60) : '';
  const lessonStep = Math.max(1, Math.min(3, Number(body.lessonStep) || 1));
  const lesson = mode === 'reading' ? null : getPlanLesson(loadPlan(), lessonId || sceneId);
  const chinese = /[\u4e00-\u9fff]/.test(userMsg);
  const groundedMaterial = String(extras.kbMaterial || '').trim();
  const system =
    (extras.kbMode || 'free') === 'grounded' && groundedMaterial
      ? buildGroundedChatSystemPrompt({
          level,
          teacherName: (character && character.name) || settings.teacherName,
          character,
          chinese,
          material: groundedMaterial,
        })
      : buildSystemPrompt({
          mode,
          level,
          topic,
          scenario,
          focusWords,
          explainChinese: settings.explainChinese,
          teacherName: settings.teacherName,
          chinese,
          doc: mode === 'reading' ? docInfo : null,
          character,
          memoryText: extras.memoryText || '',
          recentQuestions: extras.recentQuestions || [],
          kbContext: extras.kbContext || '',
          kbMode: extras.kbMode || 'free',
          directorPlan: extras.directorPlan || null,
          lesson,
          lessonStep,
        });
  const historyClean = sanitizeHistory(body.history);
  const messages = [{ role: 'system', content: system }, ...historyClean];
  if (process.env.AVA_DEBUG_CONTEXT === '1') {
    const totalChars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
    void writeFile('/tmp/ava-ctx-system.txt', system, 'utf8').catch(() => {});
    console.log('[ctx-debug] systemChars=%d historyRaw=%d historyKept=%d messages=%d totalChars=%d firstHistory=%s',
      system.length,
      Array.isArray(body.history) ? body.history.length : -1,
      historyClean.length,
      messages.length,
      totalChars,
      historyClean[0] ? String(historyClean[0].content).slice(0, 80) : '(none)');
  }
  if (userMsg) messages.push({ role: 'user', content: userMsg });
  return { mode, level, topic, scenario, focusWords, userMsg, messages, chinese, doc: docInfo, character, sceneId, lesson, lessonStep, lessonId, stageId: typeof body.stageId === 'string' ? body.stageId.slice(0, 40) : '', kbMode: extras.kbMode || 'free', kbHits: extras.kbHits || [] };
}

async function streamDemoReply(res, demo, state) {
  const words = String(demo.text || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 2) {
    if (state.closed || res.writableEnded) return;
    const chunk = `${i === 0 ? '' : ' '}${words.slice(i, i + 2).join(' ')}`;
    sseSend(res, 'delta', { text: chunk });
    await sleep(36);
  }
  if (state.closed || res.writableEnded) return;
  sseSend(res, 'feedback', demo.feedback || EMPTY_FEEDBACK);
  sseSend(res, 'done', { fullReply: demo.text });
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, error: err.message });
  }
  const settings = loadSettings();
  let readingDoc = null;
  if ((body.mode || '') === 'reading') {
    const docId = typeof body.docId === 'string' ? body.docId : '';
    if (!docId) {
      return sendJson(res, 400, { ok: false, error: '阅读讲解需要提供 docId（请先上传材料）' });
    }
    readingDoc = getDoc(docId);
    if (!readingDoc) {
      return sendJson(res, 404, { ok: false, error: '材料不存在或已被删除，请重新上传' });
    }
  }
  const earlyUserMsg = typeof body.message === 'string' ? body.message.trim().slice(0, 1200) : '';
  const character = findCharacter(typeof body.characterId === 'string' ? body.characterId : '');
  const kbMode = ['free', 'grounded', 'divergent'].includes(body.kbMode) ? body.kbMode : 'free';
  const kbDocIds = Array.isArray(body.kbDocIds)
    ? body.kbDocIds.filter((x) => typeof x === 'string' && /^kb_[a-z0-9_]+$/i.test(x)).slice(0, 10)
    : [];
  let kbHits = [];
  let kbContext = '';
  let kbTitles = [];
  const kbTeachingMaterial = kbMode === 'grounded' && kbDocIds.length && (body.mode || '') !== 'reading'
    ? buildKBTeachingMaterial(kbDocIds, { maxChars: 6500 })
    : '';
  if (kbMode !== 'free' && kbDocIds.length && earlyUserMsg && (body.mode || '') !== 'reading') {
    try {
      const found = await searchKB({ query: earlyUserMsg, docIds: kbDocIds, limit: 5, settings });
      kbHits = found.hits || [];
      kbTitles = [...new Set(kbHits.map((h) => h.docTitle))].slice(0, 3);
      kbContext = kbHits
        .map((h, i) => `[${i + 1}] 《${h.docTitle}》${h.source === 'web' ? '（网页）' : ''}\n${h.summary ? h.summary + '\n' : ''}${h.text.slice(0, 900)}`)
        .join('\n\n');
    } catch {
      kbHits = [];
    }
  }
  const memoryText = character ? formatMemoryForPrompt(character.id) : formatMemoryForPrompt('global');
  const recentQuestions = recentQuestionsFromHistory(body.history);
  if (kbTeachingMaterial) {
    kbContext = `## FULL SELECTED MATERIAL (grounded lesson — stay strictly on this)\n${kbTeachingMaterial}${kbContext ? `\n\n## Relevant passages\n${kbContext}` : ''}`.slice(0, 10000);
  }
  const useDirector = ['free', 'roleplay'].includes(body.mode || 'free') && Boolean(earlyUserMsg) && kbMode !== 'grounded';
  const directorPlan = useDirector
    ? await planTurn({
        settings,
        character,
        userMessage: earlyUserMsg,
        history: body.history,
        memoryText,
        recentQuestions,
        kbTitles,
        kbMode,
      })
    : null;
  const ctx = buildChatContext(body, settings, readingDoc, {
    memoryText,
    recentQuestions,
    kbContext,
    kbMode,
    directorPlan,
    kbHits,
    kbMaterial: kbTeachingMaterial,
  });
  if (!ctx.userMsg) {
    return sendJson(res, 400, { ok: false, error: 'message 不能为空' });
  }
  const kbMeta = {
    mode: kbMode,
    hits: kbHits.slice(0, 5).map((h) => ({
      docId: h.docId,
      title: h.docTitle,
      chunkId: h.chunkId,
      source: h.source,
      score: Math.round((Number(h.score) || 0) * 100) / 100,
      text: String(h.text || '').slice(0, 300),
    })),
  };

  const docMeta = readingDoc ? { id: readingDoc.id, name: readingDoc.name, kind: readingDoc.kind } : null;
  const characterMeta = ctx.character
    ? { id: ctx.character.id, name: ctx.character.name, city: ctx.character.city, voiceLabel: ctx.character.voiceLabel }
    : null;
  const demo = readingDoc
    ? buildDemoReadingReply({ doc: readingDoc, analysis: readingDoc.analysis || {}, message: ctx.userMsg, history: body.history })
    : ctx.character
      ? buildDemoCharacterReply({ characterId: ctx.character.id, sceneId: ctx.sceneId, message: ctx.userMsg, history: body.history })
    : buildDemoReply({
        mode: ctx.mode,
        topicId: body.topicId,
        scenarioId: body.scenarioId,
        message: ctx.userMsg,
        history: body.history,
        focusWords: ctx.focusWords,
      });

  sseOpen(res);
  const state = { closed: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求大模型超时')), 60_000);
  req.on('close', () => {
    state.closed = true;
    controller.abort(new Error('客户端已断开'));
    clearTimeout(timer);
  });

  const wantLive = Boolean(settings.apiKey) && body.forceDemo !== true;
  try {
    if (!wantLive) {
      sseSend(res, 'meta', { demo: true, model: 'demo', level: ctx.level, chinese: ctx.chinese, doc: docMeta, character: characterMeta, kb: kbMeta });
      await streamDemoReply(res, demo, state);
    } else {
      let opened = false;
      let gotDelta = false;
      let result;
      try {
        result = await streamChat({
          settings,
          messages: ctx.messages,
          signal: controller.signal,
          onOpen: () => {
            opened = true;
            sseSend(res, 'meta', { demo: false, model: settings.model, level: ctx.level, chinese: ctx.chinese, doc: docMeta, character: characterMeta, kb: kbMeta });
          },
          onDelta: (text) => {
            gotDelta = true;
            sseSend(res, 'delta', { text });
          },
        });
        if (state.closed) return;
        sseSend(res, 'feedback', result.feedback || EMPTY_FEEDBACK);
        sseSend(res, 'done', { fullReply: result.fullReply });
      } catch (err) {
        if (state.closed) return;
        if (!opened) {
          // 上游连接失败：自动降级为演示模式，保证体验不中断
          sseSend(res, 'meta', {
            demo: true,
            fallback: true,
            reason: friendlyErrorMessage(err),
            model: settings.model,
            chinese: ctx.chinese,
            doc: docMeta,
            character: characterMeta,
          });
          await streamDemoReply(res, demo, state);
        } else if (!gotDelta) {
          sseSend(res, 'error', { message: friendlyErrorMessage(err) });
          sseSend(res, 'done', { fullReply: '', error: true });
        } else {
          sseSend(res, 'error', { message: friendlyErrorMessage(err) });
          sseSend(res, 'done', { fullReply: result?.fullReply || '', error: true });
        }
      }
    }
  } finally {
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  }
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;
  const m = method === 'HEAD' ? 'GET' : method;

  if (pathname === '/api/health' && m === 'GET') {
    const settings = loadSettings();
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      mode: settings.apiKey ? 'live' : 'demo',
      hasKey: Boolean(settings.apiKey),
      model: settings.apiKey ? settings.model : 'demo',
      baseUrl: settings.baseUrl,
      voiceEngine: settings.voiceEngine || 'browser',
      volcConfigured: Boolean(settings.volc?.appId && (settings.volc?.apiKey || settings.volc?.accessToken)),
      uptime: Math.round(process.uptime()),
    });
  }

  if (pathname === '/api/settings' && m === 'GET') {
    return sendJson(res, 200, publicSettings(loadSettings()));
  }

  if (pathname === '/api/settings' && m === 'PUT') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    try {
      const previousSettings = loadSettings();
      const saved = saveSettingsPatch(body);
      let updatedPlan = null;
      if (typeof body.level === 'string') {
        const current = loadPlan();
        if (current && current.level !== saved.level) {
          try {
            updatedPlan = updatePlan(current, { level: saved.level });
            savePlan(updatedPlan);
          } catch (err) {
            // Settings and plans are separate files. If the plan cannot be saved,
            // restore the settings change rather than report a completed update.
            try {
              saveSettingsPatch({ ...previousSettings, clearKey: !previousSettings.apiKey,
                volc: { ...previousSettings.volc, clearKey: !previousSettings.volc.apiKey && !previousSettings.volc.accessToken },
              });
            } catch {
              throw new Error('课程难度更新失败，设置回退也未完成；请重新读取设置后重试');
            }
            throw new Error(`课程难度更新失败，设置已恢复：${err.message}`);
          }
          if (updatedPlan.generating) generatePlanLessonsInBackground(updatedPlan.id);
          updatedPlan = decoratePlan(loadPlan());
        }
      }
      return sendJson(res, 200, { ...publicSettings(saved), ...(updatedPlan ? {
        planUpdated: true,
        plan: updatedPlan,
        message: updatedPlan.hasError
          ? `难度已保存，课件更新未完成：${updatedPlan.errorMessage}；旧课件和进度已保留`
          : updatedPlan.generating
            ? '难度已保存，未完成课件正在更新；已完成课程和进度保留'
            : '难度已保存；已完成课程和进度保留',
      } : {}) });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: `保存失败：${err.message}` });
    }
  }

  if (pathname === '/api/settings/test' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const stored = loadSettings();
    const candidate = {
      ...stored,
      baseUrl: String(body.baseUrl || stored.baseUrl).trim().replace(/\/+$/, ''),
      model: String(body.model || stored.model).trim(),
    };
    try {
      candidate.apiKey = credentialsForEndpoint({
        previousUrl: stored.baseUrl,
        nextUrl: candidate.baseUrl,
        previousCredentials: { apiKey: stored.apiKey },
        providedCredentials: { apiKey: body.apiKey },
        clear: body.clearKey,
        errorMessage: '测试新的模型接口源站时，请填写用于该地址的 API Key。已保存的 Key 不会发送到新地址。',
      }).apiKey;
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    if (!candidate.apiKey) {
      return sendJson(res, 200, { ok: false, error: '还没有填写 API Key' });
    }
    try {
      const result = await testConnection(candidate);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: friendlyErrorMessage(err) });
    }
  }

  if (pathname === '/api/content' && m === 'GET') {
    return sendJson(res, 200, getContent());
  }

  if (pathname === '/api/chat' && m === 'POST') {
    return handleChat(req, res);
  }






  /* ---------------------------- v3.1 豆包独立 TTS（角色原声点读） ---------------------------- */

  if (pathname === '/api/tts/voices' && m === 'GET') {
    return sendJson(res, 200, { ok: true, voices: listTtsVoices() });
  }

  if (pathname === '/api/tts' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, 64 * 1024);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return sendJson(res, 400, { ok: false, error: 'text 不能为空' });
    try {
      const result = await synthesizeSpeech({
        text,
        characterId: typeof body.characterId === 'string' ? body.characterId : '',
        speaker: typeof body.speaker === 'string' ? body.speaker : '',
        rate: body.rate,
      });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': result.mime,
        'content-length': result.buffer.length,
        'cache-control': 'no-store',
        'x-tts-speaker': result.speaker,
        'x-tts-cache': result.fromCache ? 'hit' : 'miss',
      });
      return res.end(result.buffer);
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message || '语音合成失败' });
    }
  }

  /* ---------------------------- v2.7 单词复习系统 ---------------------------- */

  if (pathname === '/api/review/summary' && m === 'GET') {
    return sendJson(res, 200, { ok: true, ...getReviewSummary() });
  }

  if (pathname === '/api/review/due' && m === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 20;
    return sendJson(res, 200, { ok: true, ...getReviewDue({ limit }) });
  }

  if (pathname === '/api/review/list' && m === 'GET') {
    const status = ['all', 'new', 'learning', 'known', 'unfamiliar'].includes(url.searchParams.get('status'))
      ? url.searchParams.get('status')
      : 'all';
    return sendJson(res, 200, {
      ok: true,
      ...listReviewWords({
        status,
        q: url.searchParams.get('q') || '',
        limit: Number(url.searchParams.get('limit')) || 200,
      }),
    });
  }

  if (pathname === '/api/review/add' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const words = Array.isArray(body.words) ? body.words.slice(0, 200) : [];
    if (!words.length) return sendJson(res, 400, { ok: false, error: 'words 不能为空' });
    const result = upsertReviewWords(words, { defaults: body.defaults && typeof body.defaults === 'object' ? body.defaults : {} });
    return sendJson(res, 200, { ok: true, ...result, summary: getReviewSummary() });
  }

  if (pathname === '/api/review/word' && m === 'PATCH') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const word = typeof body.word === 'string' ? body.word.trim() : '';
    if (!word) return sendJson(res, 400, { ok: false, error: 'word 不能为空' });
    try {
      const updated = updateReviewWord(word, body.patch && typeof body.patch === 'object' ? body.patch : {});
      return sendJson(res, 200, { ok: true, word: updated, summary: getReviewSummary() });
    } catch (err) {
      return sendJson(res, 404, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/review/word' && m === 'DELETE') {
    const word = String(url.searchParams.get('word') || '').trim();
    if (!word) return sendJson(res, 400, { ok: false, error: 'word 不能为空' });
    const ok = deleteReviewWord(word);
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true, summary: getReviewSummary() } : { ok: false, error: '单词不存在' });
  }

  if (pathname === '/api/review/grade' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const word = typeof body.word === 'string' ? body.word.trim() : '';
    const grade = typeof body.grade === 'string' ? body.grade : '';
    if (!word) return sendJson(res, 400, { ok: false, error: 'word 不能为空' });
    try {
      const result = gradeReviewWord(word, grade);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  /* ---------------------------- v1.8 知识库 / 兴趣档案 ---------------------------- */

  if (pathname === '/api/kb/list' && m === 'GET') {
    return sendJson(res, 200, { ok: true, docs: listKBDocs(), stats: kbStats() });
  }

  // 严格模式：先提取预览、不保存；用户校对后再 save-text
  if (pathname === '/api/kb/preview-file' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, 20 * 1024 * 1024);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const name = typeof body.name === 'string' ? body.name : 'preview';
    const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
    if (!dataBase64) return sendJson(res, 400, { ok: false, error: '缺少文件内容（dataBase64）' });
    let buffer;
    try {
      buffer = Buffer.from(dataBase64, 'base64');
    } catch {
      return sendJson(res, 400, { ok: false, error: '文件内容不是合法的 base64' });
    }
    try {
      const extracted = await extractText({ filename: name, buffer });
      return sendJson(res, 200, {
        ok: true,
        text: extracted.text,
        kind: extracted.kind,
        chars: String(extracted.text || '').length,
        warnings: extracted.warnings || [],
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/kb/save-text' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, 6 * 1024 * 1024);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const name = typeof body.name === 'string' ? body.name : '校对后的资料';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < 20) return sendJson(res, 400, { ok: false, error: '校对后的内容太短（至少 20 个字符）' });
    const kind = typeof body.kind === 'string' ? body.kind.slice(0, 20) : 'txt';
    const source = body.source === 'paste' ? 'paste' : body.source === 'library' ? 'library' : 'file';
    try {
      const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
      const title = (rawTitle || name.replace(/\.[a-z0-9]+$/i, '')).slice(0, 120) || '校对后的资料';
      const doc = addKBText({ text, title, source, kind, meta: { reviewed: true, method: source } });
      const settingsNow = loadSettings();
      if (settingsNow.apiKey) enrichKBInBackground(doc.id, settingsNow);
      return sendJson(res, 200, {
        ok: true,
        doc: publicKBMeta(getKBDoc(doc.id) || doc),
        message: settingsNow.apiKey ? '原文已入库，正在生成摘要；期间也可按原文学习' : '原文已入库，可按原文学习；未配置模型 Key，未生成摘要',
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/kb/upload' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, 20 * 1024 * 1024);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const name = typeof body.name === 'string' ? body.name : 'document';
    const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
    if (!dataBase64) return sendJson(res, 400, { ok: false, error: '缺少文件内容（dataBase64）' });
    let buffer;
    try {
      buffer = Buffer.from(dataBase64, 'base64');
    } catch {
      return sendJson(res, 400, { ok: false, error: '文件内容不是合法的 base64' });
    }
    try {
      const { doc, extracted } = await addKBFile({ filename: name, buffer });
      const settingsNow = loadSettings();
      if (settingsNow.apiKey) enrichKBInBackground(doc.id, settingsNow);
      return sendJson(res, 200, {
        ok: true,
        doc: publicKBMeta(getKBDoc(doc.id) || doc),
        extracted: { kind: extracted.kind, chars: doc.chars, warnings: extracted.warnings || [] },
        message: settingsNow.apiKey ? '原文已入库，正在生成摘要；期间也可按原文学习' : '原文已入库，可按原文学习；未配置模型 Key，未生成摘要',
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/kb/url' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const target = typeof body.url === 'string' ? body.url.trim() : '';
    if (!target) return sendJson(res, 400, { ok: false, error: '请填写网页链接' });
    try {
      const { doc } = await importKBWeb(target);
      const settingsNow = loadSettings();
      if (settingsNow.apiKey) enrichKBInBackground(doc.id, settingsNow);
      return sendJson(res, 200, { ok: true, doc: publicKBMeta(getKBDoc(doc.id) || doc),
        message: settingsNow.apiKey ? '网页已入库，正在生成摘要；期间也可按原文学习' : '网页已入库，可按原文学习；未配置模型 Key，未生成摘要',
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/kb/search' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return sendJson(res, 400, { ok: false, error: 'query 不能为空' });
    const docIds = Array.isArray(body.docIds) ? body.docIds.filter((x) => typeof x === 'string') : [];
    const limit = Math.max(1, Math.min(12, Number(body.limit) || 6));
    try {
      const result = await searchKB({ query, docIds, limit, settings: loadSettings() });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: `检索失败：${err.message}`, hits: [] });
    }
  }

  const kbEnrichMatch = pathname.match(/^\/api\/kb\/([^/]+)\/enrich$/);
  if (kbEnrichMatch && m === 'POST') {
    try {
      const result = await enrichKBDoc(decodeURIComponent(kbEnrichMatch[1]), loadSettings());
      return sendJson(res, 200, { ...result, ok: result.ok === true });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  const kbDocMatch = pathname.match(/^\/api\/kb\/([^/]+)$/);
  if (kbDocMatch && !['list', 'upload', 'url', 'search'].includes(kbDocMatch[1])) {
    const id = decodeURIComponent(kbDocMatch[1]);
    if (m === 'GET') {
      const doc = getKBDoc(id);
      if (!doc) return sendJson(res, 404, { ok: false, error: '文档不存在' });
      return sendJson(res, 200, { ok: true, doc });
    }
    if (m === 'DELETE') {
      const ok = deleteKBDoc(id);
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: '文档不存在' });
    }
  }

  if (pathname === '/api/profile' && m === 'GET') {
    const profile = loadProfile();
    return sendJson(res, 200, { ok: true, interests: profile.interests, updatedAt: profile.updatedAt });
  }

  if (pathname === '/api/profile' && m === 'PUT') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const profile = saveProfile({ interests: body.interests });
    return sendJson(res, 200, { ok: true, interests: profile.interests, updatedAt: profile.updatedAt });
  }

  /* ------------------------ v1.6 手机版：角色 / 计划 / 助手 ------------------------ */

  if (pathname === '/api/characters' && m === 'GET') {
    return sendJson(res, 200, { ok: true, characters: getPublicCharacters() });
  }

  if (pathname.startsWith('/api/characters/') && m === 'GET') {
    const id = pathname.slice('/api/characters/'.length);
    const character = findCharacter(id);
    if (!character) return sendJson(res, 404, { ok: false, error: '角色不存在' });
    return sendJson(res, 200, { ok: true, character: publicCharacter(character) });
  }

  if (pathname === '/api/plan' && m === 'GET') {
    let plan = loadPlan();
    // 后台生成中断（服务重启等）→ 自动续跑
    if (plan && plan.generating && !isPlanGenerating(plan.id)) {
      generatePlanLessonsInBackground(plan.id);
    }
    plan = decoratePlan(plan);
    return sendJson(res, 200, { ok: true, plan });
  }

  if (pathname === '/api/plan/teacher' && m === 'PATCH') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const current = loadPlan();
    if (!current) return sendJson(res, 200, { ok: false, error: '还没有学习计划' });
    try {
      const next = setPlanTeacher(current, typeof body.teacherId === 'string' ? body.teacherId : '');
      savePlan(next);
      return sendJson(res, 200, { ok: true, plan: decoratePlan(next) });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/plan/lesson-progress' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const current = loadPlan();
    if (!current) return sendJson(res, 200, { ok: false, error: '还没有学习计划' });
    const result = saveLessonProgress(current, {
      lessonId: typeof body.lessonId === 'string' ? body.lessonId : '',
      step: Number(body.step) || 1,
      phraseIdx: Number(body.phraseIdx) || 0,
      practiceTurns: Number(body.practiceTurns) || 0,
      challengeTurns: Number(body.challengeTurns) || 0,
    });
    if (!result.ok) return sendJson(res, 200, { ok: false, reason: result.reason || '' });
    savePlan(result.plan);
    return sendJson(res, 200, { ok: true, resume: result.resume, plan: result.plan });
  }

  if (pathname === '/api/plan/lesson-restart' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const current = loadPlan();
    if (!current) return sendJson(res, 200, { ok: false, error: '还没有学习计划' });
    const next = clearLessonProgress(current, typeof body.lessonId === 'string' ? body.lessonId : '');
    savePlan(next);
    return sendJson(res, 200, { ok: true, plan: next });
  }

  if (pathname === '/api/plan/generate' && m === 'POST') {
    const current = loadPlan();
    if (!current) return sendJson(res, 200, { ok: false, error: '还没有学习计划' });
    const reset = resetPlanForGeneration(current);
    savePlan(reset);
    if (reset.generating) generatePlanLessonsInBackground(reset.id);
    return sendJson(res, 200, { ok: true, plan: decoratePlan(reset) });
  }

  if (pathname === '/api/lessons' && m === 'GET') {
    const plan = decoratePlan(loadPlan());
    return sendJson(res, 200, { ok: true, lessons: plan ? listPlanLessons(plan) : [] });
  }

  {
    const lessonMatch = pathname.match(/^\/api\/lessons\/([^/]+)$/);
    if (lessonMatch && m === 'GET') {
      const plan = loadPlan();
      const lesson = getPlanLesson(plan, decodeURIComponent(lessonMatch[1]));
      if (!lesson) return sendJson(res, 404, { ok: false, error: '课程不存在' });
      return sendJson(res, 200, { ok: true, lesson });
    }
  }

  if (pathname === '/api/plan/scene-done' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const current = loadPlan();
    if (!current) return sendJson(res, 200, { ok: false, error: '还没有学习计划' });
    const result = completeLesson(current, {
      lessonId: typeof body.lessonId === 'string' ? body.lessonId : '',
      stageId: typeof body.stageId === 'string' ? body.stageId : '',
      stepsCompleted: Number(body.stepsCompleted) || 0,
    });
    if (result.completed && result.plan) savePlan(result.plan);
    const finalPlan = decoratePlan(result.plan || current);
    return sendJson(res, 200, {
      ok: true,
      completed: !!result.completed,
      reason: result.reason || '',
      requiredSteps: result.requiredSteps || 0,
      alreadyDone: !!result.alreadyDone,
      lesson: result.lesson || null,
      plan: finalPlan,
      next: result.next || finalPlan.next || null,
    });
  }

  if (pathname === '/api/assistant' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 1200) : '';
    if (!message) return sendJson(res, 400, { ok: false, error: 'message 不能为空' });
    const settings = loadSettings();
    const characterId = typeof body.characterId === 'string' ? body.characterId : '';
    const history = Array.isArray(body.history)
      ? body.history
          .filter((msg) => msg && (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string')
          .slice(-6)
          .map((msg) => ({ role: msg.role, content: msg.content.slice(0, 400) }))
      : [];
    const current = loadPlan();
    const result = await assistantReply({
      message,
      characterId,
      currentPlan: current,
      level: settings.level,
      history,
      settings,
    });
    let plan = current;
    const action = result.action || null;
    if (
      action &&
      (action.type === 'create_plan' || action.type === 'update_plan') &&
      action.payload &&
      Array.isArray(action.payload.stages)
    ) {
      // 直接保存助手生成的计划对象，避免路由层二次生成导致 response.actions[].payload.id 与 GET /api/plan 不一致（QA-017）
      plan = decoratePlan(action.payload);
      action.payload = plan;
      savePlan(plan);
      if (action.type === 'create_plan' || (action.type === 'update_plan' && plan.generating)) {
        generatePlanLessonsInBackground(plan.id);
      }
    }
    return sendJson(res, 200, {
      ok: true,
      demo: result.demo,
      reply: result.reply,
      actions: action ? [action] : [],
      plan: plan ? decoratePlan(plan) : null,
    });
  }

  /* ---------------------------- 阅读讲解：文档 API ---------------------------- */

  if (pathname === '/api/doc/upload' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, 20 * 1024 * 1024);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const name = typeof body.name === 'string' ? body.name : '';
    const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
    if (!dataBase64) {
      return sendJson(res, 400, { ok: false, error: '缺少文件内容（dataBase64）' });
    }
    let buffer;
    try {
      buffer = Buffer.from(dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    } catch {
      return sendJson(res, 400, { ok: false, error: '文件内容不是合法的 base64' });
    }
    if (!buffer.length) {
      return sendJson(res, 400, { ok: false, error: '文件内容为空' });
    }
    let extracted;
    try {
      extracted = await extractText({ filename: name || 'document', buffer });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    const doc = saveDoc({
      id: makeDocId(),
      name: name || extracted.name,
      kind: extracted.kind,
      chars: extracted.chars,
      truncated: extracted.truncated,
      warnings: extracted.warnings,
      text: extracted.text,
      createdAt: Date.now(),
    });
    return sendJson(res, 200, { ok: true, doc: publicDoc(doc, { preview: true }) });
  }

  if (pathname === '/api/doc/list' && m === 'GET') {
    return sendJson(res, 200, { ok: true, docs: listDocs(30) });
  }

  if (pathname === '/api/doc/analyze' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const id = typeof body.id === 'string' ? body.id : '';
    const doc = getDoc(id);
    if (!doc) {
      return sendJson(res, 404, { ok: false, error: '材料不存在或已被删除，请重新上传' });
    }
    if (doc.analysis) {
      return sendJson(res, 200, {
        ok: true,
        demo: Boolean(doc.analysis.demo),
        docId: id,
        cached: true,
        analysis: doc.analysis,
      });
    }
    const settings = loadSettings();
    const level = VALID_LEVELS.has(body.level) ? body.level : settings.level;
    try {
      const result = await analyzeDocument({ doc, level, settings });
      saveDocAnalysis(id, result.analysis);
      return sendJson(res, 200, {
        ok: true,
        demo: result.demo,
        fallback: result.fallback === true,
        reason: result.reason,
        docId: id,
        analysis: result.analysis,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `分析失败：${err.message}` });
    }
  }

  if (pathname.startsWith('/api/doc/') && m === 'GET') {
    const id = pathname.slice('/api/doc/'.length);
    const doc = getDoc(id);
    if (!doc) return sendJson(res, 404, { ok: false, error: '材料不存在或已被删除' });
    return sendJson(res, 200, { ok: true, doc: publicDoc(doc, { text: true, analysis: true }) });
  }

  if (pathname.startsWith('/api/doc/') && m === 'DELETE') {
    const id = pathname.slice('/api/doc/'.length);
    const removed = deleteDoc(id);
    if (!removed) return sendJson(res, 404, { ok: false, error: '材料不存在或已被删除' });
    return sendJson(res, 200, { ok: true });
  }


  /* ------------------------- 豆包实时语音：测试/教练 ------------------------- */

  if (pathname === '/api/volc/test' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const stored = loadSettings();
    const base = stored.volc || {};
    const candidate = { ...base };
    for (const key of ['appId', 'model', 'speaker', 'endpoint', 'resourceId']) {
      if (typeof body[key] === 'string' && body[key].trim()) candidate[key] = body[key].trim();
    }
    try {
      Object.assign(candidate, credentialsForEndpoint({
        previousUrl: base.endpoint,
        nextUrl: candidate.endpoint,
        previousCredentials: { apiKey: base.apiKey, accessToken: base.accessToken },
        providedCredentials: { apiKey: body.apiKey, accessToken: body.accessToken },
        clear: body.clearKey,
        protocols: ['ws:', 'wss:'],
        errorMessage: '测试新的语音接口源站时，请填写用于该地址的 API Key 或 Access Token。已保存的凭据不会发送到新地址。',
      }));
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    if (!candidate.appId) {
      return sendJson(res, 200, { ok: false, error: '请先填写 App ID（火山引擎控制台 → 语音技术 → 应用管理）' });
    }
    if (!candidate.apiKey && !candidate.accessToken) {
      return sendJson(res, 200, { ok: false, error: '请先填写 API Key 或 Access Token' });
    }
    try {
      const result = await testVolcConnection(candidate, { timeoutMs: 20_000 });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: friendlyVolcError(0, err?.message || String(err)) });
    }
  }

  if (pathname === '/api/coach' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return sendJson(res, 400, { ok: false, error: 'message 不能为空' });
    }
    const settings = loadSettings();
    const level = VALID_LEVELS.has(body.level) ? body.level : settings.level;
    const history = Array.isArray(body.history)
      ? body.history
          .filter((msg) => msg && (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string')
          .slice(-4)
          .map((msg) => ({ role: msg.role, content: msg.content.slice(0, 600) }))
      : [];
    const result = await coachAnalysis({
      message: body.message.slice(0, 1200),
      level,
      mode: typeof body.mode === 'string' ? body.mode.slice(0, 20) : 'free',
      history,
      settings,
    });
    return sendJson(res, 200, {
      ok: true,
      demo: result.demo,
      fallback: result.fallback === true,
      reason: result.reason,
      feedback: result.feedback,
    });
  }


  if (pathname === '/api/translate' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message, texts: [] });
    }
    const raw = Array.isArray(body.texts)
      ? body.texts
      : typeof body.text === 'string'
        ? [body.text]
        : [];
    const texts = raw
      .map((t) => String(t || '').trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 8);
    if (!texts.length) {
      return sendJson(res, 200, { ok: true, texts: [], provider: null });
    }
    const settings = loadSettings();
    try {
      const result = await translateTexts(texts, {
        settings,
        target: typeof body.target === 'string' ? body.target : 'zh',
      });
      if (!result.ok) {
        return sendJson(res, 200, { ok: false, error: result.error, texts: result.texts });
      }
      return sendJson(res, 200, { ok: true, texts: result.texts, provider: result.provider });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: `翻译失败：${err.message}`, texts: texts.map(() => null) });
    }
  }

  if (pathname === '/api/score' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    if (typeof body.target !== 'string' || !body.target.trim()) {
      return sendJson(res, 400, { ok: false, error: '缺少 target 示范句子' });
    }
    if (typeof body.transcript !== 'string') {
      return sendJson(res, 400, { ok: false, error: '缺少 transcript 识别文本' });
    }
    const confidence = Number.isFinite(body.confidence) ? Number(body.confidence) : undefined;
    return sendJson(res, 200, scorePronunciation(body.target.slice(0, 500), body.transcript.slice(0, 500), confidence));
  }

  if (pathname === '/api/progress' && m === 'GET') {
    return sendJson(res, 200, publicProgress(loadProgress()));
  }

  if (pathname === '/api/progress' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const reviewWords = Array.isArray(body.reviewWords)
      ? body.reviewWords
          .filter((r) => r && typeof r.word === 'string' && r.word.trim())
          .slice(0, 50)
          .map((r) => ({ word: r.word.trim().slice(0, 80), correct: r.correct === true }))
      : [];
    const turns = Math.min(1000, Math.max(0, Number(body.turns) || 0));
    const minutes = Math.min(600, Math.max(0, Number(body.minutes) || 0));
    recordActivity({ turns, minutes, reviewWords });
    return sendJson(res, 200, publicProgress(loadProgress()));
  }


  // 即时总结：不发 LLM，直接用规则总结返回，保证挂断后立刻有内容
  if (pathname === '/api/summary/quick' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((msg) => msg && (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string')
      .slice(-40)
      .map((msg) => ({ role: msg.role, content: msg.content.slice(0, 1500) }));
    if (!messages.length) return sendJson(res, 400, { ok: false, error: '缺少对话内容' });
    const settings = loadSettings();
    const level = VALID_LEVELS.has(body.level) ? body.level : settings.level;
    const teacherName = String(body.teacherName || settings.teacherName || 'Ava').slice(0, 16);
    try {
      const result = await summarizeConversation({ messages, level, teacherName, mode: 'free', settings: {} });
      return sendJson(res, 200, { ok: true, quick: true, ...result });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message || '即时总结失败' });
    }
  }

  if (pathname === '/api/summary' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((msg) => msg && (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string')
      .slice(-40)
      .map((msg) => ({ role: msg.role, content: msg.content.slice(0, 1500) }));
    if (!messages.length || !messages.some((msg) => msg.role === 'user')) {
      return sendJson(res, 400, { ok: false, error: '缺少对话内容：至少需要一条学生消息' });
    }
    const settings = loadSettings();
    const level = VALID_LEVELS.has(body.level) ? body.level : settings.level;
    const teacherName = String(body.teacherName || settings.teacherName || 'Ava').slice(0, 16);
    const result = await summarizeConversation({ messages, level, teacherName, mode: 'free', settings });
    const keyWords = Array.isArray(result.keyWords) ? result.keyWords : [];
    // 关键：重点词自动写入当天单词表 + SRS 进度
    const added = addWords(keyWords, { source: 'summary' });
    const vocabAdded = addVocabWords(keyWords.map((w) => w.word));
    const book = getWordbook({ days: 7 });
    const todayDay = book.days.find((d) => d.date === book.today);
    let reviewAdded = null;
    try {
      const character = typeof body.characterId === 'string' ? findCharacter(body.characterId) : null;
      reviewAdded = syncReviewFromSummary(keyWords, {
        characterId: body.characterId || '',
        characterName: character ? character.name : '',
        mode: 'free',
      });
    } catch {
      reviewAdded = null;
    }
    if (settings.apiKey && typeof body.characterId === 'string' && body.characterId) {
      updateMemoryInBackground({
        settings,
        characterId: body.characterId,
        character: findCharacter(body.characterId),
        messages,
      });
    }
    return sendJson(res, 200, {
      ...result,
      ok: true,
      dailyWords: added.dailyWords,
      addedCount: added.addedCount,
      vocabAdded: vocabAdded.added,
      reviewAdded,
      wordbook: { today: book.today, totalWords: book.totalWords, todayCount: todayDay?.count || 0 },
    });
  }

  if (pathname === '/api/wordbook' && m === 'GET') {
    const daysParam = Number(url.searchParams.get('days'));
    const book = getWordbook({ days: Number.isFinite(daysParam) && daysParam > 0 ? daysParam : 7 });
    return sendJson(res, 200, { ok: true, ...book });
  }

  if (pathname === '/api/wordbook' && m === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const words = Array.isArray(body.words) ? body.words : [];
    const source = typeof body.source === 'string' && body.source ? body.source.slice(0, 40) : 'manual';
    const added = addWords(words, { source });
    const book = getWordbook({ days: 7 });
    return sendJson(res, 200, { ok: true, addedCount: added.addedCount, dailyWords: added.dailyWords, ...book });
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, error: '接口不存在' });
  }
  return false;
}

/* -------------------------------- 服务器 -------------------------------- */

function publicKBMeta(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    title: doc.title,
    source: doc.source,
    kind: doc.kind,
    lang: doc.lang,
    chars: doc.chars,
    chunkCount: Array.isArray(doc.chunks) ? doc.chunks.length : 0,
    preview: doc.preview,
    enrichStatus: doc.enrichStatus,
    enrichedChunks: Number(doc.enrichedChunks) || 0,
    createdAt: doc.createdAt,
    meta: doc.meta || {},
  };
}

async function requestHandler(req, res) {
  let url;
  try {
    const host = req.headers.host || '127.0.0.1';
    url = new URL(req.url || '/', `http://${host}`);
  } catch {
    return sendJson(res, 400, { ok: false, error: '请求地址或 Host 格式不正确' });
  }
  try {
    const apiResult = await handleApi(req, res, url);
    if (apiResult !== false) return;
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: `服务器内部错误：${err.message}` });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}


/* --------------------------- 豆包实时语音 WS 桥 --------------------------- */

function handleVoiceSocket(conn, req) {
  const settings = loadSettings();
  const volc = settings.volc || {};
  if (!volc.appId || (!volc.apiKey && !volc.accessToken)) {
    conn.sendText({ type: 'error', message: '请先在设置页填写豆包实时语音凭据（App ID + API Key / Access Token）' });
    conn.close(1000, 'no-credentials');
    return;
  }

  let session = null;
  let starting = false;
  let stopped = false;

  const finish = (reason) => {
    if (stopped) return;
    stopped = true;
    const current = session;
    session = null;
    if (current) {
      current.finish().catch(() => {
        current.close(reason || 'bridge-close');
      });
    }
  };

  conn.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (session) session.sendAudio(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(String(data || '{}'));
    } catch {
      return;
    }
    if (msg.type === 'start') {
      if (session || starting) return;
      starting = true;
      const level = VALID_LEVELS.has(msg.level) ? msg.level : settings.level;
      const character = findCharacter(typeof msg.characterId === 'string' ? msg.characterId : '');
      const kbDocIds = Array.isArray(msg.kbDocIds)
        ? msg.kbDocIds.filter((x) => typeof x === 'string' && /^kb_[a-z0-9_]+$/i.test(x)).slice(0, 10)
        : [];
      const kbBrief = kbDocIds.length ? buildKBrief(kbDocIds) : '';
      const memoryText = character ? formatMemoryForPrompt(character.id) : '';
      const kbMode = msg.kbMode === 'divergent' ? 'divergent' : 'grounded';
      const kbMaterial = kbMode === 'grounded' && kbDocIds.length ? buildKBTeachingMaterial(kbDocIds, { maxChars: 5600 }) : '';
      const kbMeta = kbDocIds.length
        ? {
            docIds: kbDocIds,
            mode: kbMode,
            titles: listKBDocs()
              .filter((d) => kbDocIds.includes(d.id))
              .map((d) => d.title)
              .slice(0, 5),
          }
        : null;
      const pttMode = msg.ptt === true;
      const lesson = getPlanLesson(
        loadPlan(),
        typeof msg.lessonId === 'string' ? msg.lessonId : typeof msg.sceneId === 'string' ? msg.sceneId : '',
      );
      const lessonStep = Math.max(1, Math.min(3, Number(msg.lessonStep) || 1));
      const recentHistory = sanitizeRealtimeHistory(msg.history);
      const persona = buildRealtimePersona({
        level,
        teacherName: character ? character.name : settings.teacherName || 'Ava',
        mode: msg.mode === 'roleplay' ? 'roleplay' : lesson ? 'lesson' : 'free',
        character,
        memoryText,
        kbBrief,
        kbMode,
        kbMaterial,
        lesson,
        lessonStep,
        recentHistory,
      });
      const characterMeta = character
        ? { id: character.id, name: character.name, city: character.city, voiceLabel: character.voiceLabel }
        : null;
      const sessionVolc = character?.voice?.speaker
        ? { ...volc, speaker: character.voice.speaker }
        : volc;
      const handlers = {
        onReady: (info) => {
          conn.sendText({ type: 'ready', model: info.model, speaker: info.speaker, demo: false, character: characterMeta, kb: kbMeta });
        },
        onASR: (evt) => {
          if (!evt.text) return;
          conn.sendText({ type: 'asr', text: evt.text, final: Boolean(evt.final) });
        },
        onChat: (evt) => {
          conn.sendText({ type: 'chat', text: evt.text || '', final: Boolean(evt.final) });
        },
        onTTSStart: (evt) => {
          conn.sendText({ type: 'audio-start', text: evt.text || '' });
        },
        onAudio: (buf) => {
          conn.sendBinary(buf);
        },
        onTTSAllEnded: () => {
          conn.sendText({ type: 'audio-end' });
        },
        onInterrupted: () => {
          conn.sendText({ type: 'interrupted' });
        },
        onError: (err) => {
          console.warn('[voice] upstream error:', err?.message || err);
          conn.sendText({ type: 'error', message: err?.message || '豆包实时语音出错' });
        },
        onClose: (reason) => {
          if (stopped) return;
          console.warn('[voice] upstream closed:', reason || 'closed');
          conn.sendText({ type: 'ended', reason: reason || 'closed' });
          conn.close(1000, 'upstream-closed');
        },
      };
      session = new VolcRealtimeSession({ volc: sessionVolc, persona, handlers, pttMode });
      try {
        await session.connect();
      } catch (err) {
        session = null;
        conn.sendText({ type: 'error', message: friendlyVolcError(0, err?.message || String(err)) });
        conn.close(1000, 'connect-failed');
      } finally {
        starting = false;
      }
      return;
    }
    if (msg.type === 'interrupt') {
      session?.interrupt();
      return;
    }
    // v2.2 PTT：点“完成”后补一段静音，触发服务端 VAD 结束本轮并让角色出句
    if (msg.type === 'commit') {
      const current = session;
      if (!current || stopped) return;
      (async () => {
        const frames = current && current.pttMode ? 120 : 80; // PTT: 2.4s 静音以越过 2s VAD 窗口；旧模式 1.6s
        const silence = Buffer.alloc(640);
        for (let i = 0; i < frames; i += 1) {
          if (stopped || session !== current) return;
          current.sendAudio(silence);
          await new Promise((r) => setTimeout(r, 20));
        }
      })().catch(() => {});
      return;
    }
    if (msg.type === 'stop') {
      const current = session;
      if (current) {
        await current.finish().catch(() => current.close('stop'));
        session = null;
      }
      stopped = true;
      conn.sendText({ type: 'ended', reason: 'stopped' });
      conn.close(1000, 'stopped');
    }
  });

  conn.on('close', () => finish('client-close'));
}

const server = http.createServer(requestHandler);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
attachWsServer(server, '/ws/voice', handleVoiceSocket);

function listenOnce(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const desired = Number.isInteger(args.port) && args.port >= 0 ? args.port : 5180;
  const host = args.host || '127.0.0.1';
  let lastError = null;
  for (let i = 0; i < 20; i++) {
    const port = desired === 0 ? 0 : desired + i;
    try {
      await listenOnce(port, host);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (err.code !== 'EADDRINUSE') break;
    }
  }
  if (lastError) {
    console.error(`[Ava] 启动失败：${lastError.message}`);
    process.exit(1);
  }

  const actualPort = server.address().port;
  const shareMode = host === '0.0.0.0';
  const url = `http://127.0.0.1:${actualPort}`;
  try {
    await mkdir(RUNTIME_DIR, { recursive: true });
    await writeFile(join(RUNTIME_DIR, 'url.txt'), `${url}\n`, 'utf8');
    await writeFile(join(RUNTIME_DIR, 'pid.txt'), `${process.pid}\n`, 'utf8');
  } catch {
    /* 运行时目录写入失败不影响服务 */
  }
  console.log(`Ava ready at ${url}`);
  if (shareMode) {
    const lans = lanAddresses();
    if (lans.length) {
      for (const ip of lans) {
        console.log(`[Ava] 分享地址：http://${ip}:${actualPort}/mobile  （同一 Wi-Fi 的电脑/手机可访问）`);
      }
    } else {
      console.log('[Ava] 分享模式已开启，但没有检测到局域网 IPv4 地址；请检查网络连接。');
    }
    console.log(`[Ava] 分享模式数据目录：${DATA_DIR}`);
    console.log('[Ava] 提示：朋友访问会消耗当前设置里的 AI/语音额度；不需要时直接 Ctrl+C 关闭。');
  }
  console.log(`[Ava] 项目目录: ${ROOT}`);
  console.log('[Ava] 首次使用：打开页面后点右上角设置页，填入 API Key 即可升级为真 AI 对话；不填也能用演示模式。');

  if (args.open) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const target = process.platform === 'darwin' ? ['-a', 'Google Chrome', url] : [url];
    const openFailed = () => console.warn(`[Ava] 无法自动打开浏览器，请手动访问 ${url}`);
    try {
      const child = spawn(command, target, { detached: true, stdio: 'ignore' });
      child.once('error', openFailed);
      child.once('exit', (code) => { if (code && process.platform !== 'win32') openFailed(); });
      child.unref();
    } catch {
      openFailed();
    }
  }

  const shutdown = async (signal) => {
    console.log(`[Ava] 收到 ${signal}，正在关闭...`);
    try {
      await unlink(join(RUNTIME_DIR, 'url.txt'));
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[Ava] 启动异常：${err.stack || err.message}`);
  process.exit(1);
});
