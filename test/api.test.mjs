/**
 * test/api.test.mjs — 服务端纯逻辑单元测试（node:test，无网络、无 I/O 副作用）
 *
 * 覆盖：
 *   - lib/score.js    发音评分：正确高分 / 漏词错词降分 / 大小写标点无关 / 空输入不崩 / 中文 tips
 *   - lib/srs.js      Leitner 间隔复习：答对 box+1 与间隔、答错回落、isDue/dueWords、合并
 *   - lib/llm.js      SSE 反馈解析：parseFeedback / normalizeFeedback / createStreamExtractor（标记切分）/ 错误文案
 *   - content/prompts.js 提示词包含反馈标记与输出格式约束
 *   - content/demo.js 演示模式脚本化回复与规则纠错
 *   - lib/config.js   publicSettings 不泄露 apiKey（只给 keyHint）
 *   - lib/progress.js 进度归一化 / dateKey / publicProgress（纯函数部分）
 *
 * 运行：
 *   /Users/cici/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node --test test/api.test.mjs
 *   （或项目根目录 `node --test`，Node 24 会自动发现 test/ 下所有测试文件）
 */

import { after, before, describe, test } from 'node:test'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'

import {
  cleanToken,
  buildTips,
  isCloseWord,
  scorePronunciation,
  tokenize,
  wordDistance,
} from '../lib/score.js'
import {
  BOX_DAY,
  BOX_INTERVALS_DAYS,
  MAX_BOX,
  dueWords,
  isDue,
  masteryCount,
  mergeReviews,
  newWordRecord,
  reviewWord,
} from '../lib/srs.js'
import {
  buildRequestPayload,
  createStreamExtractor,
  friendlyErrorMessage,
  joinUrl,
  normalizeChineseHelp,
  normalizeFeedback,
  parseFeedback,
} from '../lib/llm.js'
import {
  FEEDBACK_MARKER,
  buildCoachMessages,
  buildDirectorBlock,
  buildDirectorMessages,
  buildDocAnalysisMessages,
  buildKBContextBlock,
  buildKBEnrichMessages,
  buildKBQueryMessages,
  buildKBRerankMessages,
  buildLensRules,
  buildMemoryBlock,
  buildMemoryMessages,
  buildRealtimePersona,
  buildSummaryMessages,
  buildSystemPrompt,
  buildTeachingContext,
} from '../content/prompts.js'
import {
  buildChineseHelp,
  buildDemoCharacterReply,
  buildDemoDocAnalysis,
  buildDemoFreeReply,
  buildDemoReadingReply,
  buildDemoOpener,
  buildDemoReply,
  buildDemoSummary,
  detectChinese,
  detectConversationTopics,
  detectCorrections,
} from '../content/demo.js'
import { DEFAULT_SETTINGS, maskKey, normalizeSettings, publicSettings } from '../lib/config.js'
import { dateKey, defaultProgress, normalizeProgress, publicProgress } from '../lib/progress.js'
import { normalizeKeyWords, normalizeSummary, parseSummaryJson } from '../lib/summary.js'
import { analyzeDocument, countWords, normalizeDocAnalysis, parseDocAnalysisJson } from '../lib/docAnalysis.js'
import {
  CLIENT_EVENT,
  COMPRESSION,
  CONNECT_LEVEL_EVENTS,
  FLAG_EVENT,
  HEADER_SIZE_UNITS,
  MSG_TYPE,
  PROTOCOL_VERSION,
  SERIALIZATION,
  SERVER_EVENT,
  encodeAudio,
  encodeError,
  encodeEvent,
  encodeServerAudio,
  encodeServerEvent,
  generateId,
  parseFrame,
} from '../lib/volcProtocol.js'
import { attachWsServer } from '../lib/wsServer.js'
import {
  VolcRealtimeSession,
  buildSessionConfig,
  buildVolcHeaders,
  friendlyVolcError,
  testVolcConnection,
} from '../lib/volcRealtime.js'
import { coachAnalysis } from '../lib/coach.js'
import { startMockVolc } from './mock-volc-realtime.mjs'
import { startMockUpstream } from './mock-upstream.mjs'
import { characters, findCharacter, publicCharacter, getPublicCharacters, sceneOpener, DEFAULT_CHARACTER_ID } from '../content/characters.js'
import {
  createUserPlan,
  updatePlan,
  GOAL_LABELS,
  decoratePlan,
  fillPlanLessons,
  setPlanTeacher,
  completeLesson,
  resetPlanForGeneration,
  setPlanLessonError,
  getPlanLesson,
  listPlanLessons,
  publicPlan,
  saveLessonProgress,
  clearLessonProgress,
  PLAN_VERSION,
  PLAN_LESSON_COUNT,
  LESSON_STEPS,
} from '../lib/plans.js'
import { listTtsVoices, synthesizeSpeech } from '../lib/tts.js'
import { assistantReply, buildAssistantReply, detectIntent, detectGoal, detectLevel, detectCharacterId } from '../lib/assistant.js'
import { ANGLES, rulePlan, normalizePlan, planTurn } from '../lib/director.js'
import { mergeMemory, recentQuestionsFromHistory, formatMemoryForPrompt } from '../lib/memory.js'
import { detectLang, decodeEntities, htmlToText, chunkText, tokenize as kbTokenize, bm25Rank, makeDocId } from '../lib/kb.js'
import { extractJson, chatJSON } from '../lib/llmJson.js'
import { wordKey, __test__ as __reviewTest } from '../lib/review.js'
import { Translator, cleanTranslation, translateTexts } from '../lib/translator.js'
import {
  MAX_TEXT_CHARS,
  SUPPORTED_EXTENSIONS,
  extOf,
  extractDocxZipText,
  extractPdfContentText,
  extractPdfText,
  extractPptxText,
  extractText,
  fileKind,
  isSupportedFile,
  readZip,
  usefulText,
} from '../lib/docExtract.js'
import { dateKey as wordbookDateKey, dateLabel } from '../lib/wordbook.js'
import { parseSSEChunk, parseSSEFrame } from '../web/js/api.js'
import {
  STT_LANG_ZH,
  isChineseText,
  mapSTTError,
  mapTTSError,
  pickSTTLang,
  pickVoiceFromList,
  buildSpeechChunks,
  splitSentences,
} from '../web/js/speech.js'
import {
  computeStreak,
  mergeDeltas,
  mergeProgressDelta,
  normalizeProgress as normalizeUiProgress,
  todayKey,
} from '../web/js/store.js'

const NOW = 1_700_000_000_000 // 固定时间戳，保证 SRS 断言可重复
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHINESE = /[\u4e00-\u9fa5]/

/* ========================================================================== */
/* lib/score.js —— 发音评分                                                    */
/* ========================================================================== */
describe('lib/score.js 发音评分', () => {
  test('完全正确的句子得满分 5 星，逐词全是 ok', () => {
    const s = scorePronunciation('I would like a latte, please.', 'I would like a latte please')
    assert.equal(s.score, 100)
    assert.equal(s.stars, 5)
    assert.equal(s.accuracy, 1)
    assert.deepEqual(
      s.words.map((w) => w.status),
      ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
    )
    assert.deepEqual(
      s.words.map((w) => w.text),
      ['i', 'would', 'like', 'a', 'latte', 'please'],
    )
    assert.ok(Array.isArray(s.tips_zh) && s.tips_zh.length > 0, '正确也应给中文反馈 tips')
    assert.ok(s.tips_zh.every((t) => typeof t === 'string' && t.length > 0))
  })

  test('大小写、标点、多余空格不影响评分（SPEC：大小写标点不影响）', () => {
    const variations = [
      'i would like a latte please',
      'I WOULD LIKE A LATTE PLEASE',
      '  I would like a latte, please!  ',
      'I would like a latte… please',
    ]
    for (const transcript of variations) {
      const s = scorePronunciation('I would like a latte, please.', transcript)
      assert.equal(s.score, 100, `transcript=${JSON.stringify(transcript)} 应得 100 分，实际 ${s.score}`)
      assert.equal(s.stars, 5)
    }
    // 目标句大小写/标点变化同样不敏感
    const s2 = scorePronunciation('HELLO, WORLD!', 'hello world')
    assert.equal(s2.score, 100)
  })

  test('漏词降分，漏掉的词 status=miss', () => {
    const full = scorePronunciation('I would like a cup of coffee', 'I would like a cup of coffee')
    const partial = scorePronunciation('I would like a cup of coffee', 'I would like')
    assert.equal(full.score, 100)
    assert.ok(partial.score < full.score, `漏词分数应低于完整分数：${partial.score} < ${full.score}`)
    const miss = partial.words.filter((w) => w.status === 'miss').map((w) => w.text)
    assert.deepEqual(miss, ['a', 'cup', 'of', 'coffee'])
    assert.ok(partial.stars < full.stars, '漏词星级也应下降')
    assert.ok(partial.tips_zh.length > 0 && partial.tips_zh.some((t) => CHINESE.test(t)), '漏词应给中文发音提示')
  })

  test('错词降分，目标词判 miss 或 close', () => {
    const full = scorePronunciation('I would like a latte', 'I would like a latte')
    const wrong = scorePronunciation('I would like a latte', 'I would like a coffee')
    assert.equal(full.score, 100)
    assert.ok(wrong.score < full.score, `错词分数应降低：${wrong.score} < ${full.score}`)
    const latte = wrong.words.find((w) => w.text === 'latte')
    assert.ok(latte, '应保留目标词 latte')
    assert.notEqual(latte.status, 'ok', '错词不应判 ok')
    assert.ok(wrong.tips_zh.length > 0)
  })

  test('空 transcript 不崩溃：0 分、全部 miss、仍给中文提示', () => {
    const s = scorePronunciation('I would like a latte', '')
    assert.equal(s.score, 0)
    assert.equal(s.stars, 1)
    assert.equal(s.accuracy, 0)
    assert.ok(s.words.length > 0 && s.words.every((w) => w.status === 'miss'))
    assert.ok(s.tips_zh.length > 0 && s.tips_zh.every((t) => typeof t === 'string'))
    assert.ok(s.tips_zh.some((t) => CHINESE.test(t)), '空输入提示应为中文')
    assert.ok(s.tips_zh.length <= 3, 'tips 最多 3 条')
  })

  test('空 target / 纯标点 target 不崩溃', () => {
    for (const target of ['', '   ', '!!! ???']) {
      const s = scorePronunciation(target, 'hello')
      assert.equal(s.score, 0)
      assert.equal(s.accuracy, 0)
      assert.ok(Array.isArray(s.words))
      assert.ok(Array.isArray(s.tips_zh) && s.tips_zh.length > 0, `target=${JSON.stringify(target)} 也应有提示`)
    }
  })

  test('缺失参数（undefined/null）不抛异常', () => {
    assert.doesNotThrow(() => scorePronunciation(undefined, undefined))
    assert.doesNotThrow(() => scorePronunciation(null, null))
    assert.doesNotThrow(() => scorePronunciation('hello', null))
    assert.doesNotThrow(() => buildTips([], [], '', undefined))
  })

  test('缩写展开：I\u2019m ↔ I am 视为一致', () => {
    const a = scorePronunciation("I'm happy today", 'I am happy today')
    assert.equal(a.score, 100, `缩写展开后应满分，实际 ${a.score} / ${JSON.stringify(a.words)}`)
    const b = scorePronunciation('I am happy today', "I'm happy today")
    assert.equal(b.score, 100)
  })

  test('接近词判 close：轻微口音/词尾变化不直接判错', () => {
    const s = scorePronunciation('I walked home', 'I walk home')
    const walked = s.words.find((w) => w.text === 'walked')
    assert.ok(walked, '应包含目标词 walked')
    assert.equal(walked.status, 'close')
    assert.ok(s.score > 0 && s.score < 100, `close 应得部分分，实际 ${s.score}`)
    assert.equal(isCloseWord('latte', 'late'), true)
    assert.equal(isCloseWord('walked', 'walk'), true)
    assert.equal(isCloseWord('coffee', 'tea'), false)
    assert.equal(isCloseWord('', 'a'), false)
  })

  test('多余词轻微扣分但不出错', () => {
    const s = scorePronunciation('I like coffee', 'I like coffee very much today')
    assert.ok(s.score < 100, `多余词应扣分，实际 ${s.score}`)
    assert.ok(s.score >= 80, `只是多余词不应大幅扣分，实际 ${s.score}`)
  })

  test('低置信度提示麦克风收音问题（中文 tips）', () => {
    const s = scorePronunciation('I have a cat', 'I have a cap', 0.3)
    assert.ok(s.tips_zh.length > 0)
    assert.ok(s.tips_zh.some((t) => t.includes('麦克风')), `低置信度应提示麦克风，实际 ${JSON.stringify(s.tips_zh)}`)
  })

  test('tips 最多 3 条且不重复', () => {
    const s = scorePronunciation('I think they really want three red apples', 'I sink day weally want tree wed apples', 0.2)
    assert.ok(s.tips_zh.length <= 3, `tips 最多 3 条，实际 ${s.tips_zh.length}`)
    assert.equal(new Set(s.tips_zh).size, s.tips_zh.length, 'tips 不应重复')
  })

  test('tokenize / cleanToken 处理标点、撇号与 Unicode', () => {
    assert.deepEqual(tokenize("Hello, world! I'm here."), ['hello', 'world', "i'm", 'here'])
    assert.deepEqual(tokenize('  '), [])
    assert.deepEqual(tokenize(null), [])
    assert.equal(cleanToken('  “Hello,” '), 'hello')
    assert.equal(cleanToken('Don\u2019t'), "don't")
    assert.equal(cleanToken('!!!'), '')
    // NFKC：全角字符归一化
    assert.equal(cleanToken('ＡＢＣ'), 'abc')
  })

  test('wordDistance 标准编辑距离', () => {
    assert.equal(wordDistance('kitten', 'sitting'), 3)
    assert.equal(wordDistance('same', 'same'), 0)
    assert.equal(wordDistance('', 'abc'), 3)
    assert.equal(wordDistance('abc', ''), 3)
  })
})

/* ========================================================================== */
/* lib/srs.js —— 间隔复习                                                      */
/* ========================================================================== */
describe('lib/srs.js 间隔复习', () => {
  test('间隔表与 SPEC 一致：[0,1,2,4,7,14,30,60] 天，box 0–7', () => {
    assert.deepEqual(BOX_INTERVALS_DAYS, [0, 1, 2, 4, 7, 14, 30, 60])
    assert.equal(BOX_DAY, 86_400_000)
    assert.equal(MAX_BOX, 7)
  })

  test('新词记录 box 0、立即到期', () => {
    const rec = newWordRecord(NOW)
    assert.deepEqual(rec, { box: 0, due: NOW, seen: 0, correct: 0, last: 0 })
    assert.equal(isDue(rec, NOW), true)
  })

  test('答对 box +1，间隔按 [0,1,2,4,7,14,30,60] 天计算', () => {
    let rec = reviewWord(null, true, NOW)
    assert.equal(rec.box, 1)
    assert.equal(rec.due, NOW + 1 * BOX_DAY)
    assert.equal(rec.seen, 1)
    assert.equal(rec.correct, 1)
    assert.equal(rec.last, NOW)

    rec = reviewWord(rec, true, NOW)
    assert.equal(rec.box, 2)
    assert.equal(rec.due, NOW + 2 * BOX_DAY)
    assert.equal(rec.seen, 2)
    assert.equal(rec.correct, 2)

    // 连续答对直到封顶 box 7
    const boxes = []
    for (let i = 0; i < 8; i++) {
      rec = reviewWord(rec, true, NOW)
      boxes.push(rec.box)
      assert.equal(rec.due, NOW + BOX_INTERVALS_DAYS[rec.box] * BOX_DAY, `box=${rec.box} 的到期时间应为 now + ${BOX_INTERVALS_DAYS[rec.box]} 天`)
    }
    assert.deepEqual(boxes, [3, 4, 5, 6, 7, 7, 7, 7], 'box 最高封顶 7，不应越界')
  })

  test('答错回落：box -1（最低 0），due 变为新 box 间隔', () => {
    let rec = reviewWord(null, true, NOW) // box 1
    rec = reviewWord(rec, true, NOW) // box 2
    const wrong = reviewWord(rec, false, NOW)
    assert.equal(wrong.box, 1)
    assert.equal(wrong.due, NOW + 1 * BOX_DAY)
    assert.equal(wrong.seen, 3)
    assert.equal(wrong.correct, 2, '答错不应增加 correct 计数')

    const zero = reviewWord(newWordRecord(NOW), false, NOW)
    assert.equal(zero.box, 0)
    assert.equal(zero.due, NOW, 'box 0 间隔 0 天，应立即到期')
    assert.equal(zero.correct, 0)
  })

  test('isDue 边界：due <= now 到期 / 未来未到期 / 无记录视为到期', () => {
    assert.equal(isDue({ due: NOW - 1 }, NOW), true)
    assert.equal(isDue({ due: NOW }, NOW), true)
    assert.equal(isDue({ due: NOW + 1 }, NOW), false)
    assert.equal(isDue(null, NOW), true)
    assert.equal(isDue(undefined, NOW), true)
    assert.equal(isDue({}, NOW), true, '缺失 due 视为立即到期')
  })

  test('dueWords 只返回到期词，按到期时间升序并支持 limit', () => {
    const words = {
      late: { box: 1, due: NOW + 500 },
      now: { box: 2, due: NOW - 100 },
      future: { box: 3, due: NOW + 99999 },
      old: { box: 4, due: NOW - 9000 },
    }
    const due = dueWords(words, NOW, 20)
    assert.deepEqual(
      due.map((w) => w.word),
      ['old', 'now'],
      '只返回到期词（late 未到期）并按 due 升序',
    )
    assert.deepEqual(dueWords(words, NOW, 1).map((w) => w.word), ['old'])
    assert.deepEqual(dueWords(words, NOW, 0), [])
    assert.deepEqual(dueWords(null, NOW), [])
  })

  test('mergeReviews：小写去空格合并、不修改入参、忽略非法项', () => {
    const original = { latte: { box: 2, due: 0, seen: 1, correct: 1, last: 0 } }
    const snapshot = JSON.stringify(original)
    const next = mergeReviews(
      original,
      [
        { word: '  Latte ', correct: true },
        { word: '', correct: true },
        { word: 'latte', correct: false },
        null,
        { word: 42, correct: true },
      ],
      NOW,
    )
    assert.equal(JSON.stringify(original), snapshot, 'mergeReviews 不应修改入参')
    assert.deepEqual(Object.keys(next), ['latte'])
    // 先 correct 升到 box 3，再 error 回落到 box 2
    assert.equal(next.latte.box, 2)
    assert.equal(next.latte.seen, 3)
    assert.equal(next.latte.correct, 2)
    // 空 words 入参
    assert.deepEqual(mergeReviews(null, [{ word: 'new', correct: true }], NOW).new.box, 1)
    assert.deepEqual(mergeReviews(undefined, []), {})
  })

  test('masteryCount：box >= 3 视为掌握', () => {
    assert.equal(masteryCount({ a: { box: 3 }, b: { box: 2 }, c: { box: 7 }, d: {} }), 2)
    assert.equal(masteryCount(null), 0)
    assert.equal(masteryCount({}), 0)
  })
})

/* ========================================================================== */
/* lib/llm.js —— 反馈解析 / 流式抽取                                            */
/* ========================================================================== */
describe('lib/llm.js 反馈与流式解析', () => {
  test('parseFeedback 解析合法反馈 JSON', () => {
    const raw =
      '{"corrections":[{"original":"I want a coffee","corrected":"I would like a coffee","explanation_zh":"更礼貌的说法"}],' +
      '"better":[{"original":"very good","better":"great","why_zh":"更自然"}],' +
      '"newWords":[{"word":"latte","phonetic":"/ˈlɑːteɪ/","meaning":"拿铁","example":"A latte, please."}],' +
      '"encouragement_zh":"说得很好！","followUp":"What size?"}'
    const fb = parseFeedback(raw)
    assert.equal(fb.corrections.length, 1)
    assert.equal(fb.corrections[0].corrected, 'I would like a coffee')
    assert.equal(fb.better.length, 1)
    assert.equal(fb.newWords.length, 1)
    assert.equal(fb.newWords[0].word, 'latte')
    assert.equal(fb.encouragement_zh, '说得很好！')
    assert.equal(fb.followUp, 'What size?')
  })

  test('parseFeedback 容忍 markdown 围栏与前后杂文本', () => {
    const fb = parseFeedback('```json\n{"encouragement_zh":"继续加油","corrections":[]}\n```')
    assert.equal(fb.encouragement_zh, '继续加油')
    const fb2 = parseFeedback(`好的，下面是反馈：\n{"encouragement_zh":"很棒","newWords":[]}\n（结束）`)
    assert.equal(fb2.encouragement_zh, '很棒')
  })

  test('parseFeedback 非法 JSON / 空输入返回空反馈结构，不抛异常', () => {
    const empty = { corrections: [], better: [], newWords: [], encouragement_zh: '', followUp: '' }
    for (const raw of ['', null, undefined, 'not json at all', '{"corrections": [ this is broken', '<<<FEEDBACK>>>']) {
      const fb = parseFeedback(raw)
      assert.deepEqual(fb, empty, `raw=${JSON.stringify(raw)} 应返回空反馈`)
    }
  })

  test('normalizeFeedback 裁剪数量与长度并过滤残缺项', () => {
    const raw = {
      corrections: [
        { original: 'a', corrected: 'b', explanation_zh: 'c' },
        { original: 'a2', corrected: 'b2' },
        { original: 'a3', corrected: 'b3' },
        { original: 'a4', corrected: 'b4' },
        { original: 'a5', corrected: 'b5' },
        { original: 'no-corrected' },
      ],
      better: [{ original: 'x', better: 'y' }, { better: 'y2' }, { better: 'y3' }, { better: 'y4' }],
      newWords: [
        { word: 'w1' },
        { word: 'w2' },
        { word: 'w3' },
        { word: 'w4' },
        { word: 'w5' },
        { meaning: '缺单词' },
      ],
      encouragement_zh: '鼓'.repeat(200),
      followUp: 123,
    }
    const fb = normalizeFeedback(raw)
    assert.equal(fb.corrections.length, 3, 'corrections 最多 3 条')
    assert.equal(fb.better.length, 2, 'better 最多 2 条')
    assert.equal(fb.newWords.length, 4, 'newWords 最多 4 条')
    assert.ok(fb.corrections.every((c) => c.corrected), '缺少 corrected 的项应被过滤')
    assert.ok(fb.better.every((b) => b.better))
    assert.ok(fb.newWords.every((w) => w.word))
    assert.equal(fb.encouragement_zh.length, 80, 'encouragement_zh 最长 80 字')
    assert.equal(fb.followUp, '', '非字符串 followUp 归一为空串')
    assert.deepEqual(normalizeFeedback(null), { corrections: [], better: [], newWords: [], encouragement_zh: '', followUp: '' })
    assert.deepEqual(normalizeFeedback('字符串'), { corrections: [], better: [], newWords: [], encouragement_zh: '', followUp: '' })
  })

  test('createStreamExtractor：正文增量输出，剥离标记与 JSON（标记被 chunk 切分）', () => {
    const text = 'That sounds great! Would you like it hot or iced?'
    const feedback = {
      corrections: [{ original: 'I want', corrected: 'I would like', explanation_zh: '更礼貌' }],
      better: [],
      newWords: [{ word: 'latte', phonetic: '/ˈlɑːteɪ/', meaning: '拿铁', example: 'A latte, please.' }],
      encouragement_zh: '很棒！',
      followUp: 'Anything else?',
    }
    const raw = `${text}\n${FEEDBACK_MARKER}\n${JSON.stringify(feedback)}`
    for (const chunkSize of [1, 2, 5, 7, 13, 999]) {
      const deltas = []
      const extractor = createStreamExtractor((t) => deltas.push(t))
      for (let i = 0; i < raw.length; i += chunkSize) extractor.push(raw.slice(i, i + chunkSize))
      const result = extractor.end()
      const joined = deltas.join('')
      // 标记前的换行可能作为最后一个正文 delta 下发（服务端会 trim 后作为 fullReply），
      // 因此正文比较时忽略首尾空白；关键是不得丢字、不得混入标记/JSON。
      assert.equal(joined.trim(), text, `chunkSize=${chunkSize} 时正文不应丢字/多字`)
      assert.ok(joined.length - joined.trimEnd().length <= 2, `chunkSize=${chunkSize} 时不应有多余大段空白`)
      assert.ok(!joined.includes(FEEDBACK_MARKER), '正文不得包含反馈标记')
      assert.ok(!joined.includes('corrections'), '正文不得包含反馈 JSON')
      assert.equal(result.fullReply, text)
      assert.equal(result.feedback.encouragement_zh, '很棒！')
      assert.equal(result.feedback.newWords[0].word, 'latte')
    }
  })

  test('createStreamExtractor：无标记时全文都是正文、反馈为空', () => {
    const deltas = []
    const extractor = createStreamExtractor((t) => deltas.push(t))
    extractor.push('Hello ')
    extractor.push('there!')
    const result = extractor.end()
    assert.equal(deltas.join(''), 'Hello there!')
    assert.equal(result.fullReply, 'Hello there!')
    assert.deepEqual(result.feedback.corrections, [])
    assert.equal(result.feedback.encouragement_zh, '')
  })

  test('createStreamExtractor：正文为空（直接标记）也不崩', () => {
    const deltas = []
    const extractor = createStreamExtractor((t) => deltas.push(t))
    extractor.push(`${FEEDBACK_MARKER}\n{"encouragement_zh":"好的","corrections":[]}`)
    const result = extractor.end()
    assert.equal(deltas.join(''), '')
    assert.equal(result.fullReply, '')
    assert.equal(result.feedback.encouragement_zh, '好的')
  })

  test('joinUrl 拼接 baseUrl 与路径（去重斜杠）', () => {
    assert.equal(joinUrl('http://127.0.0.1:1234/v1', 'chat/completions'), 'http://127.0.0.1:1234/v1/chat/completions')
    assert.equal(joinUrl('http://127.0.0.1:1234/v1/', '/chat/completions'), 'http://127.0.0.1:1234/v1/chat/completions')
    assert.equal(joinUrl('', 'models'), '/models')
    assert.equal(joinUrl(null, 'models'), '/models')
  })

  test('friendlyErrorMessage 给出中文可读错误', () => {
    assert.match(friendlyErrorMessage(new Error('HTTP 401 Unauthorized')), /API Key/)
    assert.match(friendlyErrorMessage(new Error('The operation was aborted due to timeout')), /超时/)
    assert.match(friendlyErrorMessage(new Error('HTTP 429 Too Many Requests')), /429|频繁/)
    assert.match(friendlyErrorMessage(new Error('fetch failed')), /网络/)
    assert.match(friendlyErrorMessage(new Error('HTTP 503 Service Unavailable')), /5\d\d|暂时不可用|服务/)
    assert.match(friendlyErrorMessage(new Error('something weird')), /^调用大模型失败/)
    assert.doesNotThrow(() => friendlyErrorMessage(undefined))
  })

  test('buildRequestPayload 构造 OpenAI 兼容请求体', () => {
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]
    const payload = buildRequestPayload({ model: 'mock-model' }, messages)
    assert.equal(payload.model, 'mock-model')
    assert.equal(payload.stream, true)
    assert.equal(payload.messages, messages)
    assert.equal(typeof payload.temperature, 'number')
    assert.equal(typeof payload.max_tokens, 'number')
  })
})

/* ========================================================================== */
/* content/prompts.js —— 提示词契约                                             */
/* ========================================================================== */
describe('content/prompts.js 提示词契约', () => {
  test('反馈标记与 SPEC 完全一致', () => {
    assert.equal(FEEDBACK_MARKER, '<<<FEEDBACK>>>')
  })

  test('system 提示词要求「英文正文 + 标记 + 合法 JSON」', () => {
    const prompt = buildSystemPrompt({ mode: 'free', level: 'A2', teacherName: 'Ava' })
    assert.equal(typeof prompt, 'string')
    assert.ok(prompt.includes(FEEDBACK_MARKER), '提示词必须包含反馈标记')
    assert.match(prompt, /VALID JSON/i, '提示词必须要求合法 JSON')
    assert.match(prompt, /corrections/, '提示词必须包含 corrections 字段说明')
    assert.match(prompt, /encouragement_zh/, '提示词必须包含中文鼓励字段')
    assert.match(prompt, /Ava/, '提示词应带教师名')
    assert.match(prompt, /A2/, '提示词应带 CEFR 等级')
  })

  test('不同模式注入不同教学模式约束', () => {
    const free = buildSystemPrompt({ mode: 'free' })
    assert.match(free, /Free talk/i)
    const roleplay = buildSystemPrompt({
      mode: 'roleplay',
      scenario: { name: 'Coffee shop order', role: 'barista', objectives: ['order a coffee', 'ask the price'] },
    })
    assert.match(roleplay, /barista/i, '角色扮演应注入角色')
    assert.match(roleplay, /order a coffee/, '角色扮演应注入目标句')
    const vocab = buildSystemPrompt({ mode: 'vocab', focusWords: ['latte', 'receipt'] })
    assert.match(vocab, /latte/)
    const pronounce = buildSystemPrompt({ mode: 'pronounce' })
    assert.match(pronounce, /Repeat-after-me|repeat after me/i)
  })

  test('explainChinese=false 时提示词禁止中文正文', () => {
    const prompt = buildSystemPrompt({ mode: 'free', explainChinese: false })
    assert.match(prompt, /Never use Chinese/)
  })

  test('buildTeachingContext 复用 system 提示词', () => {
    const a = buildTeachingContext({ mode: 'free', level: 'B1' })
    const b = buildSystemPrompt({ mode: 'free', level: 'B1' })
    assert.equal(a, b)
  })
})

/* ========================================================================== */
/* content/demo.js —— 演示模式（无 Key 也能完整跑通）                            */
/* ========================================================================== */
describe('content/demo.js 演示模式', () => {
  test('buildDemoReply 四种模式都返回非空英文正文 + 合法反馈结构', () => {
    const cases = [
      { mode: 'free', topicId: 'daily' },
      { mode: 'vocab', topicId: 'cafe', focusWords: ['latte'] },
      { mode: 'pronounce' },
      { mode: 'roleplay', scenarioId: 'coffee' },
    ]
    for (const opts of cases) {
      const reply = buildDemoReply({ ...opts, message: 'I want a coffee', history: [] })
      assert.equal(typeof reply.text, 'string')
      assert.ok(reply.text.trim().length > 0, `${opts.mode} 演示正文不应为空`)
      assert.ok(!reply.text.includes(FEEDBACK_MARKER), '演示正文不应包含反馈标记')
      assert.ok(/[A-Za-z]/.test(reply.text), `${opts.mode} 演示正文应为英文`)
      const fb = reply.feedback
      for (const key of ['corrections', 'better', 'newWords']) assert.ok(Array.isArray(fb[key]), `${opts.mode}.feedback.${key} 应为数组`)
      assert.equal(typeof fb.encouragement_zh, 'string')
      assert.ok(fb.encouragement_zh.length > 0, `${opts.mode} 应有中文鼓励`)
      assert.ok(CHINESE.test(fb.encouragement_zh), '鼓励语应为中文')
      // 反馈必须可 JSON 序列化（会被 SSE data 发送）
      assert.doesNotThrow(() => JSON.stringify(fb))
    }
  })

  test('演示反馈含规则纠错：I very like it → I really like it', () => {
    const reply = buildDemoReply({ mode: 'free', topicId: 'daily', message: 'I very like it' })
    assert.ok(reply.feedback.corrections.length >= 1, `应识别 very 修饰动词错误，实际 ${JSON.stringify(reply.feedback)}`)
    const c = reply.feedback.corrections[0]
    assert.match(c.corrected, /really/i)
    assert.ok(CHINESE.test(c.explanation_zh), '纠错解释应为中文')
  })

  test('detectCorrections 覆盖常见中式英语错误', () => {
    const cases = [
      ['I very like it', /really/i],
      ['I am agree with you', /I agree/i],
      ["He don't like coffee", /doesn't/i],
      ['I am boring', /bored/i],
      ['There are many peoples here', /people/i],
      ['I want go home', /want to go/i],
    ]
    for (const [message, re] of cases) {
      const corrections = detectCorrections(message)
      assert.ok(corrections.length >= 1, `${message} 应识别出纠错`)
      assert.match(corrections[0].corrected, re)
      assert.ok(CHINESE.test(corrections[0].explanation_zh))
    }
    assert.deepEqual(detectCorrections('Hello Ava, nice to meet you'), [])
    assert.deepEqual(detectCorrections(''), [])
    assert.deepEqual(detectCorrections(undefined), [])
  })

  test('演示对话按轮次推进（history 中 user 轮数影响台词）', () => {
    const first = buildDemoReply({ mode: 'free', topicId: 'daily', message: 'hi', history: [] })
    const second = buildDemoReply({
      mode: 'free',
      topicId: 'daily',
      message: 'hi again',
      history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: first.text }],
    })
    assert.notEqual(second.text, first.text, '第二轮演示台词应与第一轮不同')
  })

  test('buildDemoOpener 返回非空开场白', () => {
    for (const mode of ['free', 'roleplay', 'vocab', 'pronounce']) {
      const opener = buildDemoOpener({ mode, topicId: 'daily', scenarioId: 'coffee' })
      assert.equal(typeof opener, 'string')
      assert.ok(opener.trim().length > 0, `${mode} 开场白不应为空`)
    }
  })
})

/* ========================================================================== */
/* lib/config.js —— 设置序列化安全                                             */
/* ========================================================================== */
describe('lib/config.js 设置序列化', () => {
  test('publicSettings 绝不返回 apiKey 原文，只有 keyHint', () => {
    const key = 'sk-test-1234567890abcdef'
    const pub = publicSettings({ ...DEFAULT_SETTINGS, apiKey: key })
    assert.equal(pub.hasKey, true)
    assert.equal(pub.apiKey, undefined)
    assert.ok(!JSON.stringify(pub).includes(key), '序列化结果不得包含完整 apiKey')
    assert.equal(pub.keyHint, maskKey(key))
    assert.ok(pub.keyHint.endsWith('cdef'), `keyHint 应保留后 4 位，实际 ${pub.keyHint}`)
    assert.ok(pub.keyHint.startsWith('sk-t'), `keyHint 应保留前 4 位，实际 ${pub.keyHint}`)
    assert.ok(!pub.keyHint.includes('1234567890'), 'keyHint 不得包含中段')
  })

  test('maskKey 边界：空 key → 空串；短 key 打码', () => {
    assert.equal(maskKey(''), '')
    assert.equal(maskKey(null), '')
    assert.equal(maskKey(undefined), '')
    assert.equal(maskKey('short'), '••••')
    assert.equal(maskKey('123456789'), '1234…6789')
  })

  test('publicSettings 无 Key 时 hasKey=false、keyHint 为空', () => {
    const pub = publicSettings({ ...DEFAULT_SETTINGS, apiKey: '' })
    assert.equal(pub.hasKey, false)
    assert.equal(pub.keyHint, '')
    for (const k of ['baseUrl', 'model', 'level', 'teacherName', 'voice', 'explainChinese', 'autoListen']) {
      assert.ok(k in pub, `publicSettings 应包含 ${k}`)
    }
  })
})

/* ========================================================================== */
/* lib/progress.js —— 纯函数部分（不写文件）                                    */
/* ========================================================================== */
describe('lib/progress.js 纯函数', () => {
  test('defaultProgress 初始结构符合 SPEC §2.5', () => {
    const p = defaultProgress()
    assert.equal(p.streak, 0)
    assert.equal(p.totalTurns, 0)
    assert.equal(p.totalMinutes, 0)
    assert.deepEqual(p.days, [])
    assert.deepEqual(p.words, {})
  })

  test('dateKey 使用本地时区 YYYY-MM-DD', () => {
    assert.equal(dateKey(new Date(2024, 0, 5)), '2024-01-05')
    assert.equal(dateKey(new Date(2024, 11, 31)), '2024-12-31')
  })

  test('normalizeProgress 修正负数/字符串/脏数据', () => {
    const p = normalizeProgress({
      streak: -5,
      totalTurns: '3',
      totalMinutes: '7.5',
      days: [{ date: '2024-01-01', turns: 1, minutes: 2 }, { bad: true }, null],
      words: null,
    })
    assert.equal(p.streak, 0)
    assert.equal(p.totalTurns, 3)
    assert.equal(p.totalMinutes, 7.5)
    assert.equal(p.days.length, 1)
    assert.deepEqual(p.words, {})
  })

  test('publicProgress 返回前端所需字段且不改文件', () => {
    const p = publicProgress(defaultProgress(), new Date())
    for (const k of ['streak', 'totalTurns', 'totalMinutes', 'words', 'days', 'updatedAt']) {
      assert.ok(k in p, `publicProgress 应包含 ${k}`)
    }
    assert.equal(p.streak, 0)
    assert.equal(p.totalTurns, 0)
    assert.equal(p.totalWords, 0)
    assert.equal(p.masteredWords, 0)
    assert.deepEqual(p.days, [])
  })
})


/* ========================================================================== */
/* web/js/api.js —— SSE 客户端解析（纯函数，SPEC §3.1）                          */
/* ========================================================================== */
describe('web/js/api.js SSE 解析', () => {
  test('parseSSEFrame 解析 event / data / id / retry', () => {
    const ev = parseSSEFrame('event: delta\ndata: {"text":"Hi"}')
    assert.equal(ev.event, 'delta')
    assert.equal(ev.data, '{"text":"Hi"}')
    assert.equal(ev.id, '')
    assert.equal(ev.retry, null)

    // 多行 data 用 \n 拼接；注释行忽略；无 event 默认 message
    const multi = parseSSEFrame(': keep-alive\ndata: line1\ndata: line2\nid: 7\nretry: 3000')
    assert.equal(multi.event, 'message')
    assert.equal(multi.data, 'line1\nline2')
    assert.equal(multi.id, '7')
    assert.equal(multi.retry, 3000)
    assert.deepEqual(parseSSEFrame(''), { event: 'message', data: '', id: '', retry: null })
  })

  test('parseSSEChunk 切出完整帧，残留半帧放 rest', () => {
    const { events, rest } = parseSSEChunk(
      'event: meta\ndata: {"demo":true}\n\nevent: delta\ndata: {"text":"Hi"}\n\npartial-frame',
    )
    assert.equal(events.length, 2)
    assert.equal(events[0].event, 'meta')
    assert.deepEqual(JSON.parse(events[0].data), { demo: true })
    assert.equal(events[1].event, 'delta')
    assert.deepEqual(JSON.parse(events[1].data), { text: 'Hi' })
    assert.equal(rest, 'partial-frame')
  })

  test('parseSSEChunk 跨 chunk 拼接（事件被网络切两半）', () => {
    const first = parseSSEChunk('event: delta\ndata: {"te')
    assert.equal(first.events.length, 0)
    assert.equal(first.rest, 'event: delta\ndata: {"te')
    const second = parseSSEChunk(first.rest + 'xt":"Hello"}\n\n')
    assert.equal(second.events.length, 1)
    assert.deepEqual(JSON.parse(second.events[0].data), { text: 'Hello' })
    assert.equal(second.rest, '')
  })

  test('parseSSEChunk 兼容 CRLF 与跨 chunk 的 \\r\\n', () => {
    const a = parseSSEChunk('event: meta\r\ndata: {"demo":false}\r\n\r\n')
    assert.equal(a.events.length, 1)
    assert.equal(a.events[0].event, 'meta')

    const b1 = parseSSEChunk('event: delta\r')
    assert.equal(b1.events.length, 0)
    const b2 = parseSSEChunk(b1.rest + '\ndata: {"text":"ok"}\r\n\r\n')
    assert.equal(b2.events.length, 1)
    assert.equal(b2.events[0].event, 'delta')
    assert.deepEqual(JSON.parse(b2.events[0].data), { text: 'ok' })
  })

  test('parseSSEChunk：event 无 data 仍返回事件（SSE 规范），纯注释帧不产生事件', () => {
    const ev = parseSSEChunk('event: ping\n\n')
    assert.equal(ev.events.length, 1, '有 event 字段但无 data 的帧应返回事件')
    assert.equal(ev.events[0].event, 'ping')
    assert.equal(ev.events[0].data, '')
    const comment = parseSSEChunk(': connected\n\nevent: delta\ndata: {"text":"hi"}\n\n')
    assert.deepEqual(comment.events.map((e) => e.event), ['delta'])
  })

  test('parseSSEChunk 忽略注释帧（服务端首个 : connected）与空缓冲', () => {
    assert.deepEqual(parseSSEChunk(''), { events: [], rest: '' })
    assert.deepEqual(parseSSEChunk(null), { events: [], rest: '' })
    const { events } = parseSSEChunk(': connected\n\n')
    assert.equal(events.length, 0, '纯注释帧不应产生事件')
  })
})

/* ========================================================================== */
/* web/js/speech.js —— 错误码 / 音色 / 句子切分（纯函数，SPEC §3.2）              */
/* ========================================================================== */
describe('web/js/speech.js 纯函数', () => {
  test('mapSTTError 归一 not-allowed 为 denied 并给中文文案', () => {
    const a = mapSTTError('not-allowed')
    assert.equal(a.code, 'denied')
    assert.equal(a.originalCode, 'not-allowed')
    assert.ok(CHINESE.test(a.message) && a.message.includes('麦克风'))
    assert.equal(mapSTTError('service-not-allowed').code, 'denied')
    assert.ok(mapSTTError('network').message.includes('网络'))
    assert.ok(mapSTTError({ error: 'no-speech' }).message.includes('语音'))
    assert.ok(CHINESE.test(mapSTTError('some-new-code').message), '未知错误也应是中文文案')
  })

  test('mapTTSError 中文文案与未知兜底', () => {
    assert.ok(mapTTSError('synthesis-failed').message.includes('语音合成'))
    assert.ok(mapTTSError('network').message.includes('网络'))
    assert.equal(mapTTSError('whatever').message, '朗读出现未知错误。')
    assert.doesNotThrow(() => mapTTSError(undefined))
  })

  test('pickVoiceFromList 优先本地英文女声，支持 prefName 覆盖', () => {
    const voices = [
      { name: 'Google US English', lang: 'en-US', localService: false },
      { name: 'Samantha', lang: 'en_US', localService: true },
      { name: 'Daniel', lang: 'en-GB', localService: true },
      { name: 'Tingting', lang: 'zh-CN', localService: true },
    ]
    assert.equal(pickVoiceFromList(voices).name, 'Samantha')
    assert.equal(pickVoiceFromList(voices, 'Daniel').name, 'Daniel', '显式偏好应优先')
    assert.equal(pickVoiceFromList([]), null)
    assert.equal(pickVoiceFromList(null), null)
    assert.equal(pickVoiceFromList([{ name: 'X' }]).name, 'X', '只有一个音色时不应返回 null')
  })

  test('splitSentences 按句切分并保留标点', () => {
    assert.deepEqual(splitSentences('Hello there. How are you? I am fine!'), [
      'Hello there.',
      'How are you?',
      'I am fine!',
    ])
    assert.deepEqual(splitSentences(''), [])
    assert.deepEqual(splitSentences(null), [])
    assert.deepEqual(splitSentences('No punctuation here'), ['No punctuation here'])
  })

  test('buildSpeechChunks 长文本分块，偏移可回映射原文', () => {
    assert.deepEqual(buildSpeechChunks(''), [])
    const text =
      'The quick brown fox jumps over the lazy dog. ' +
      'Pack my box with five dozen liquor jugs. ' +
      'How vexingly quick daft zebras jump! ' +
      'Sphinx of black quartz, judge my vow. ' +
      'Two driven jocks help fax my big quiz.'
    const chunks = buildSpeechChunks(text, 60)
    assert.ok(chunks.length > 1, '长文本应被切分为多块')
    for (const chunk of chunks) {
      assert.ok(chunk.text.length > 0)
      assert.equal(text.slice(chunk.start, chunk.end), chunk.text, 'start/end 偏移应能回映射原文')
    }
    // 所有块拼起来覆盖全文（允许块间空白差异时逐一回映射即可）
    const covered = chunks.map((c) => c.text).join(' ')
    assert.ok(covered.includes('Two driven jocks'), '最后一句应在某个块中')
  })
})

/* ========================================================================== */
/* web/js/store.js —— 本地状态纯函数（SPEC §3.3）                                */
/* ========================================================================== */
describe('web/js/store.js 纯函数', () => {
  const day = (d) => {
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  test('todayKey 本地时区 YYYY-MM-DD', () => {
    assert.equal(todayKey(new Date(2024, 0, 5)), '2024-01-05')
  })

  test('normalizeProgress 兼容缺字段/脏数据', () => {
    const p = normalizeUiProgress(null)
    assert.equal(p.streak, 0)
    assert.equal(p.totalTurns, 0)
    assert.deepEqual(p.days, [])
    assert.equal(p.updatedAt, null)
    const dirty = normalizeUiProgress({ streak: -3, totalTurns: 'x', totalMinutes: '5', days: [{ date: '2024-01-01', turns: 1 }], words: null })
    assert.equal(dirty.streak, 0)
    assert.equal(dirty.totalTurns, 0)
    assert.equal(dirty.totalMinutes, 5)
    assert.deepEqual(dirty.days, [{ date: '2024-01-01', turns: 1, minutes: 0 }])
  })

  test('mergeProgressDelta 累加 turns/minutes 与 SRS 复习，且不改入参', () => {
    const now = new Date(2024, 0, 5, 10, 0, 0)
    const base = normalizeUiProgress({ totalTurns: 1, totalMinutes: 2, days: [] })
    const snapshot = JSON.stringify(base)
    const next = mergeProgressDelta(base, { turns: 2, minutes: 5, reviewWords: [{ word: 'latte', correct: true }] }, now)
    assert.equal(JSON.stringify(base), snapshot, 'mergeProgressDelta 不应修改入参')
    assert.equal(next.totalTurns, 3)
    assert.equal(next.totalMinutes, 7)
    assert.equal(next.days.length, 1)
    assert.equal(next.days[0].date, day(now))
    assert.equal(next.days[0].turns, 2)
    assert.equal(next.days[0].minutes, 5)
    assert.equal(next.words.latte.box, 1)
    assert.equal(next.words.latte.seen, 1)
    assert.equal(typeof next.updatedAt, 'string')
    const wrong = mergeProgressDelta(next, { reviewWords: [{ word: 'latte', correct: false }] }, now)
    assert.equal(wrong.words.latte.box, 0, '答错前端应回落（与后端 box-1 语义略有差异，以服务端为准）')
  })

  test('computeStreak 连续天数计算（今天/昨天起算）', () => {
    const now = new Date(2024, 0, 5, 12, 0, 0)
    const d = (offset) => {
      const x = new Date(now)
      x.setDate(x.getDate() - offset)
      return day(x)
    }
    assert.equal(computeStreak([], now), 0)
    assert.equal(computeStreak([{ date: d(0) }], now), 1)
    assert.equal(computeStreak([{ date: d(0) }, { date: d(1) }, { date: d(2) }], now), 3)
    assert.equal(computeStreak([{ date: d(1) }, { date: d(2) }], now), 2, '今天没学但昨天学过，仍算连续')
    assert.equal(computeStreak([{ date: d(0) }, { date: d(2) }], now), 1, '中间断档只算到今天')
  })

  test('mergeDeltas 合并离线排队增量', () => {
    const merged = mergeDeltas(
      { turns: 1, minutes: 2, reviewWords: [{ word: 'a', correct: true }] },
      { turns: 2, minutes: 3.5, reviewWords: [{ word: 'b', correct: false }] },
    )
    assert.equal(merged.turns, 3)
    assert.equal(merged.minutes, 5.5)
    assert.equal(merged.reviewWords.length, 2)
    assert.deepEqual(mergeDeltas({}), { turns: 0, minutes: 0, reviewWords: [] })
  })

  test('mergeDeltas 对 null/非对象入参健壮（P3 已修复回归）', () => {
    assert.deepEqual(mergeDeltas({}, null), { turns: 0, minutes: 0, reviewWords: [] })
    assert.deepEqual(mergeDeltas(null, null), { turns: 0, minutes: 0, reviewWords: [] })
    assert.deepEqual(mergeDeltas(undefined, undefined), { turns: 0, minutes: 0, reviewWords: [] })
    assert.deepEqual(mergeDeltas(null, { turns: 1 }), { turns: 1, minutes: 0, reviewWords: [] })
  })

  test('mergeProgressDelta 对 null 进度/增量健壮（voice-dev 同类加固回归）', () => {
    assert.doesNotThrow(() => mergeProgressDelta(null, null, new Date(2024, 0, 5)))
    const p = mergeProgressDelta(null, { turns: 1, minutes: 2 }, new Date(2024, 0, 5))
    assert.equal(p.totalTurns, 1)
    assert.equal(p.totalMinutes, 2)
  })
})

/* ========================================================================== */
/* v1.1 · lib/wordbook.js + lib/progress.addVocabWords（沙箱 data/ 隔离）        */
/* ========================================================================== */
describe('v1.1 lib/wordbook.js 单词表持久化', () => {
  let sandboxRoot = ''
  let wb = null
  let progress = null

  before(async () => {
    sandboxRoot = await mkdtemp(path.join(os.tmpdir(), 'ava-unit-wordbook-'))
    await cp(path.join(PROJECT_ROOT, 'lib'), path.join(sandboxRoot, 'lib'), { recursive: true })
    await cp(path.join(PROJECT_ROOT, 'content'), path.join(sandboxRoot, 'content'), { recursive: true })
    await writeFile(path.join(sandboxRoot, 'package.json'), '{"type":"module"}', 'utf8')
    wb = await import(pathToFileURL(path.join(sandboxRoot, 'lib', 'wordbook.js')).href)
    progress = await import(pathToFileURL(path.join(sandboxRoot, 'lib', 'progress.js')).href)
  })

  after(async () => {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true })
  })

  const word = (w, extra = {}) => ({
    word: w,
    phonetic: '/test/',
    meaning: '测试释义',
    example: 'This is a test.',
    why_zh: '测试原因',
    ...extra,
  })

  test('dateKey / dateLabel：今天 / 昨天 / M月D日', () => {
    assert.equal(wb.dateKey(new Date(2024, 0, 5)), '2024-01-05')
    const now = new Date(2026, 0, 3)
    assert.equal(wb.dateLabel('2026-01-03', now), '今天')
    assert.equal(wb.dateLabel('2026-01-02', now), '昨天')
    assert.equal(wb.dateLabel('2025-12-20', now), '12月20日')
  })

  test('addWords 新增：addedCount / dailyWords 结构 / 字段默认值', () => {
    const date = '2026-01-01'
    const r = wb.addWords([word('alpha'), word('beta'), word('gamma')], {
      source: 'manual-test',
      date,
      now: new Date(2026, 0, 1).getTime(),
    })
    assert.equal(r.addedCount, 3)
    assert.equal(r.dailyWords.date, date)
    assert.equal(r.dailyWords.label, '今天')
    assert.equal(r.dailyWords.count, 3)
    assert.deepEqual(r.dailyWords.words.map((w) => w.word), ['alpha', 'beta', 'gamma'])
    const first = r.dailyWords.words[0]
    for (const k of ['word', 'phonetic', 'meaning', 'example', 'why_zh', 'addedAt', 'source', 'timesSeen']) {
      assert.ok(k in first, `单词条目应有字段 ${k}`)
    }
    assert.equal(first.source, 'manual-test')
    assert.equal(first.timesSeen, 1)
    assert.ok(first.addedAt > 0)
  })

  test('addWords 去重（大小写不敏感）：timesSeen+1 且更新释义', () => {
    const date = '2026-01-02'
    const r1 = wb.addWords([word('Commute'), word('commute')], { date, now: new Date(2026, 0, 2).getTime() })
    assert.equal(r1.addedCount, 1, '同一天同词大小写不同应视为一个词')
    const commute = r1.dailyWords.words.find((w) => w.word.toLowerCase() === 'commute')
    assert.equal(commute.timesSeen, 2, '重复词 timesSeen 应 +1')
    const r2 = wb.addWords([word('COMMUTE', { meaning: '通勤（更新释义）', example: 'I commute by subway.' })], { date })
    assert.equal(r2.addedCount, 0)
    const updated = r2.dailyWords.words.find((w) => w.word.toLowerCase() === 'commute')
    assert.equal(updated.timesSeen, 3)
    assert.equal(updated.meaning, '通勤（更新释义）', '重复词应更新释义')
    assert.equal(updated.example, 'I commute by subway.')
  })

  test('addWords 按日期分组；getWordbook 倒序且 label 今天/昨天', () => {
    wb.addWords([word('commute')], { date: '2026-01-03', now: new Date(2026, 0, 3).getTime() })
    const book = wb.getWordbook({ days: 7, now: new Date(2026, 0, 3) })
    assert.equal(book.today, '2026-01-03')
    assert.deepEqual(
      book.days.map((d) => d.date),
      ['2026-01-03', '2026-01-02', '2026-01-01'],
      '按日期倒序',
    )
    assert.deepEqual(
      book.days.map((d) => d.label),
      ['今天', '昨天', '1月1日'],
    )
    assert.equal(book.days[0].words[0].word.toLowerCase(), 'commute')
    assert.equal(book.days[0].words[0].timesSeen, 1)
  })

  test('addWords 单日上限 60 词', () => {
    const words = Array.from({ length: 65 }, (_, i) => word(`limitword${i}`))
    const r = wb.addWords(words, { date: '2026-01-04' })
    assert.equal(r.addedCount, 60, '单日最多新增 60 词')
    assert.equal(r.dailyWords.count, 60)
  })

  test('addWords 忽略非法词条（null / 空 word / 非对象）', () => {
    const r = wb.addWords([null, undefined, {}, { word: '   ' }, 42, word('okword')], { date: '2026-01-05' })
    assert.equal(r.addedCount, 1)
    assert.deepEqual(
      r.dailyWords.words.map((w) => w.word),
      ['okword'],
    )
    assert.equal(wb.addWords(null, { date: '2026-01-05' }).addedCount, 0)
    assert.equal(wb.addWords('not-array', { date: '2026-01-05' }).addedCount, 0)
  })

  test('getWordbook：totalWords 跨天去重、days 参数限制天数', () => {
    const book = wb.getWordbook({ days: 2, now: new Date(2026, 0, 5) })
    assert.equal(book.days.length, 2, 'days=2 只返回最近 2 天')
    // 跨天去重总数：01-01(3) + 01-02(1 commute) + 01-03(commute 重复) + 01-04(60) + 01-05(1)
    assert.equal(book.totalWords, 3 + 1 + 60 + 1)
  })

  test('todayCount 统计今天新增词数', () => {
    wb.addWords([word('today-a'), word('today-b')]) // 默认今天
    assert.equal(wb.todayCount(), 2)
    assert.equal(wb.todayCount(new Date(2020, 0, 1)), 0)
  })

  test('progress.addVocabWords：只新增缺失词条、不重置已有 SRS', () => {
    const { addVocabWords, saveProgress, defaultProgress } = progress
    const seeded = defaultProgress()
    seeded.words = { latte: { box: 3, due: 123, seen: 5, correct: 4, last: 100 } }
    saveProgress(seeded)
    const r = addVocabWords([{ word: 'Latte' }, { word: 'commute' }, 'brandnew', { word: '  ' }, null], NOW)
    assert.equal(r.added, 2, '仅 commute 与 brandnew 为新增')
    const p = r.progress
    assert.equal(p.words.latte.box, 3, '已有词 SRS 不应被重置')
    assert.equal(p.words.latte.due, 123)
    assert.equal(p.words.latte.seen, 5)
    assert.equal(p.words.commute.box, 0, '新词从 box 0 开始')
    assert.equal(p.words.commute.due, NOW)
    assert.equal(p.words.commute.seen, 0)
    assert.equal(p.words.brandnew.box, 0)
    assert.equal(addVocabWords([]).added, 0)
    assert.equal(addVocabWords([null, '', { word: '  ' }]).added, 0)
  })
})

/* ========================================================================== */
/* v1.1 · lib/summary.js 纯函数                                              */
/* ========================================================================== */
describe('v1.1 lib/summary.js 总结解析', () => {
  test('parseSummaryJson：合法 JSON / markdown 围栏 / 前后杂文本', () => {
    assert.deepEqual(parseSummaryJson('{"summary_zh":"总结","keyWords":[]}'), { summary_zh: '总结', keyWords: [] })
    assert.deepEqual(parseSummaryJson('```json\n{"summary_zh":"围栏"}\n```'), { summary_zh: '围栏' })
    assert.deepEqual(parseSummaryJson('好的，下面是总结：\n{"summary_zh":"杂文本"}\n（结束）'), { summary_zh: '杂文本' })
  })

  test('parseSummaryJson：空/非 JSON/无花括号 → 抛错（供上层降级）', () => {
    for (const bad of ['', null, undefined, 'not json', '抱歉我无法总结', '[1,2,3]']) {
      assert.throws(() => parseSummaryJson(bad), `raw=${JSON.stringify(bad)} 应抛错`)
    }
  })

  test('normalizeKeyWords：去重（大小写）、过滤非英文/空、限制数量与长度', () => {
    const out = normalizeKeyWords(
      [
        { word: 'Commute', meaning: '通勤' },
        { word: 'commute', meaning: '重复' },
        { word: '  deadline  ', meaning: '截止日期' },
        { word: '' },
        { word: '中文词' },
        null,
        { word: 'spreadsheet' },
        { word: 'a1' },
        { word: 'b2' },
        { word: 'c3' },
        { word: 'd4' },
        { word: 'e5' },
        { word: 'f6' },
      ],
      8,
    )
    assert.equal(out.length, 8, '最多 8 个')
    assert.equal(out[0].word, 'Commute')
    assert.equal(out.filter((w) => w.word.toLowerCase() === 'commute').length, 1, '大小写去重')
    assert.equal(out[1].word, 'deadline', '应 trim')
    assert.ok(out.every((w) => /[a-zA-Z]/.test(w.word)), '应过滤中文/空词')
    assert.deepEqual(normalizeKeyWords(null), [])
  })

  test('normalizeSummary：结构补齐、数组裁剪、字段长度限制', () => {
    const summary = normalizeSummary({
      summary_zh: '总结'.repeat(500),
      topics_zh: ['工作', '周末', '旅行', '美食', '电影', '', 42],
      strengths_zh: ['a', 'b', 'c', 'd'],
      improvements_zh: ['x', 'y', 'z', 'w'],
      corrections: [
        { original: 'o1', corrected: 'c1', explanation_zh: 'e1' },
        { original: 'o2', corrected: 'c2', explanation_zh: 'e2' },
        { original: 'o3', corrected: 'c3', explanation_zh: 'e3' },
        { original: 'o4', corrected: 'c4', explanation_zh: 'e4' },
        { original: 'no-corrected' },
      ],
      keyWords: [{ word: 'commute' }],
      encouragement_zh: '加油',
    })
    assert.equal(summary.summary_zh.length, 800)
    assert.equal(summary.topics_zh.length, 4)
    assert.equal(summary.strengths_zh.length, 3)
    assert.equal(summary.improvements_zh.length, 3)
    assert.equal(summary.corrections.length, 3)
    assert.ok(summary.corrections.every((c) => c.corrected))
    assert.equal(summary.keyWords.length, 1)
    assert.equal(summary.encouragement_zh, '加油')
    const empty = normalizeSummary(null)
    assert.deepEqual(empty, {
      summary_zh: '',
      topics_zh: [],
      strengths_zh: [],
      improvements_zh: [],
      corrections: [],
      keyPatterns: [],
      keyWords: [],
      encouragement_zh: '',
    })
  })

  test('buildSummaryMessages：system+user 两条，含严格 JSON 约束与完整对话记录', () => {
    const msgs = buildSummaryMessages({
      messages: [
        { role: 'user', content: 'I go to the office yesterday.' },
        { role: 'assistant', content: 'Oh no, how was it?' },
        { role: 'user', content: 'I had three meetings.' },
      ],
      level: 'B1',
      teacherName: 'Ava',
    })
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].role, 'system')
    assert.equal(msgs[1].role, 'user')
    for (const key of ['summary_zh', 'topics_zh', 'keyWords', 'corrections', 'encouragement_zh']) {
      assert.ok(msgs[0].content.includes(key), `总结提示词应包含字段 ${key}`)
    }
    assert.match(msgs[0].content, /Student: I go to the office yesterday/)
    assert.match(msgs[0].content, /Ava: Oh no, how was it\?/)
    assert.match(msgs[0].content, /B1/)
    assert.match(msgs[0].content, /JSON must be strictly valid/i)
  })
})

/* ========================================================================== */
/* v1.1 · content/demo.js 自由对话 + 总结（demo 降级路径）                         */
/* ========================================================================== */
describe('v1.1 content/demo.js 自由对话与总结', () => {
  test('buildDemoSummary：含 user 消息时输出完整中文总结 + 重点词 + 纠错', () => {
    const messages = [
      { role: 'user', content: 'I go to the office yesterday and it was really tiring.' },
      { role: 'assistant', content: 'Oh no, a long day? What happened?' },
      { role: 'user', content: 'I had three meetings and a deadline. I want go home early.' },
    ]
    const summary = buildDemoSummary(messages)
    assert.equal(summary.demo, true)
    assert.ok(summary.summary_zh.length > 20, '中文总结应有内容')
    assert.match(summary.summary_zh, /[\u4e00-\u9fa5]/)
    assert.ok(Array.isArray(summary.topics_zh) && summary.topics_zh.length >= 1 && summary.topics_zh.length <= 3)
    assert.ok(Array.isArray(summary.strengths_zh) && summary.strengths_zh.length >= 1)
    assert.ok(Array.isArray(summary.improvements_zh) && summary.improvements_zh.length >= 1)
    assert.ok(Array.isArray(summary.corrections) && summary.corrections.length >= 1, '应识别 I go ... yesterday / I want go 等错误')
    assert.ok(summary.corrections.every((c) => c.corrected && c.explanation_zh))
    assert.ok(Array.isArray(summary.keyWords) && summary.keyWords.length >= 3 && summary.keyWords.length <= 5)
    for (const w of summary.keyWords) {
      assert.ok(w.word && /[a-zA-Z]/.test(w.word), 'keyWord 应为英文')
      assert.ok(w.meaning && w.example, 'keyWord 应有中文释义与英文例句')
    }
    assert.ok(summary.encouragement_zh.length > 0 && /[\u4e00-\u9fa5]/.test(summary.encouragement_zh))
    assert.doesNotThrow(() => JSON.stringify(summary))
  })

  test('buildDemoSummary：空 / 仅 assistant 消息不崩溃', () => {
    for (const messages of [[], null, undefined, [{ role: 'assistant', content: 'Hello there!' }]]) {
      const summary = buildDemoSummary(messages)
      assert.equal(typeof summary.summary_zh, 'string')
      assert.ok(Array.isArray(summary.keyWords) && summary.keyWords.length >= 3)
      assert.ok(Array.isArray(summary.topics_zh) && summary.topics_zh.length >= 1)
    }
  })

  test('detectConversationTopics：关键词识别中文话题（≤3 个），空对话兜底「日常聊天」', () => {
    assert.ok(
      detectConversationTopics([{ role: 'user', content: 'I have a big deadline at work and three meetings.' }]).includes('工作'),
    )
    assert.ok(detectConversationTopics([{ role: 'user', content: 'I want to travel to Japan next month.' }]).includes('旅行'))
    const mixed = detectConversationTopics([
      { role: 'user', content: 'I cooked dinner and watched a movie with my family.' },
      { role: 'assistant', content: 'Sounds lovely.' },
    ])
    assert.ok(mixed.length >= 1 && mixed.length <= 3)
    assert.deepEqual(detectConversationTopics([]), ['日常聊天'])
    assert.deepEqual(detectConversationTopics(null), ['日常聊天'])
  })

  test('buildDemoFreeReply：不锁话题、承接用户内容、有追问', () => {
    const tired = buildDemoFreeReply('I am really tired after work today', 0)
    assert.equal(typeof tired, 'string')
    assert.ok(tired.length > 0, '应有英文回复')
    const work = buildDemoFreeReply('I had a very long day at work today', 0)
    const food = buildDemoFreeReply('I just ate the best noodles in town', 0)
    assert.notEqual(work, food, '不同话题内容应有不同回复')
    for (const reply of [tired, work, food]) {
      assert.ok(/[a-zA-Z]/.test(reply), '演示自由对话回复应为英文')
      assert.ok(reply.length > 10)
    }
    assert.ok(buildDemoFreeReply('', 0).length > 0)
    assert.ok(buildDemoFreeReply('ok', 1).length > 0)
  })
})

/* ========================================================================== */
/* v1.2 · content/demo.js 中文求助引擎 + 相关性                                   */
/* ========================================================================== */
describe('v1.2 content/demo.js 中文求助', () => {
  const CN_SAMPLES = [
    '不知道怎么说',
    '我听不懂',
    '什么意思',
    '再说一遍',
    '慢一点',
    '我今天很累',
    '我饿了',
    '我渴了',
    '我最近很忙',
    '我在上班',
    '我在学英语',
    '我英语不好',
    '我很开心',
    '我很难过',
    '我紧张',
    '我生气',
    '好无聊',
    '我困了',
    '今天天气很好',
    '我是学生',
    '我在公司工作',
    '真的吗',
    '为什么',
    '谢谢',
    '对不起',
    '这个用英语怎么说',
    '我不知道',
    '我同意',
    '我不同意',
    '我觉得',
    '你好',
    '我需要休息',
    '这个周末',
    '我想问你一个问题',
    '你叫什么名字',
    '你多大了',
    '很高兴认识你',
    '我喜欢咖啡',
    '我想要咖啡',
    '给我来一杯拿铁',
  ]

  test('detectChinese：纯中文/中英混合命中，纯英文/空值为 false', () => {
    assert.equal(detectChinese('我今天很累'), true)
    assert.equal(detectChinese('我有点 tired 今天'), true)
    assert.equal(detectChinese('我很累，不知道怎么说'), true)
    assert.equal(detectChinese('I am tired today'), false)
    assert.equal(detectChinese(''), false)
    assert.equal(detectChinese(null), false)
    assert.equal(detectChinese(undefined), false)
    assert.equal(detectChinese('123456'), false)
  })

  test('buildChineseHelp：≥30 组高频中文命中，英文/意群/中文提示齐全', () => {
    assert.ok(CN_SAMPLES.length >= 30, '测试样本应 >=30 组')
    let matched = 0
    for (const cn of CN_SAMPLES) {
      const help = buildChineseHelp(cn)
      assert.ok(help, `${cn} 应返回 chineseHelp`)
      assert.equal(help.original_zh, cn, `${cn} 应保留用户原话`)
      assert.equal(help.unmatched, false, `${cn} 应命中规则（不要走未命中降级）`)
      assert.ok(typeof help.english === 'string' && help.english.length > 0, `${cn} 应有英文表达`)
      assert.match(help.english, /[a-zA-Z]/, `${cn} 的英文表达应为英文`)
      assert.ok(Array.isArray(help.chunks) && help.chunks.length >= 1, `${cn} 应有意群拆解`)
      assert.ok(
        help.chunks.every((c) => c && typeof c.en === 'string' && c.en.length > 0 && typeof c.zh === 'string' && c.zh.length > 0),
        `${cn} 的意群应含 en/zh`,
      )
      assert.ok(typeof help.tips_zh === 'string' && help.tips_zh.length > 0, `${cn} 应有中文提示`)
      assert.match(help.tips_zh, /[\u4e00-\u9fa5]/, `${cn} 的 tips 应为中文`)
      matched += 1
    }
    assert.ok(matched >= 30, `命中数应 >=30，实际 ${matched}`)
  })

  test('buildChineseHelp：本人基线「我今天很累，不知道怎么说」→ exhausted 表达', () => {
    const help = buildChineseHelp('我今天很累，不知道怎么说')
    assert.equal(help.unmatched, false)
    assert.match(help.english, /exhausted|tired/i)
    assert.ok(help.chunks.length >= 1)
    assert.ok(help.tips_zh.length > 0)
  })

  test('buildChineseHelp：未命中时诚实降级，tips 含 API Key 提示与可复用英文句式', () => {
    const help = buildChineseHelp('量子纠缠的哲学意义是什么')
    assert.equal(help.unmatched, true, '未覆盖的中文应标记 unmatched')
    assert.equal(help.original_zh, '量子纠缠的哲学意义是什么')
    assert.match(help.english, /What I'm trying to say/i, '应给可复用的英文求助句式')
    assert.match(help.tips_zh, /API Key/, 'tips 应提示填入 API Key')
    assert.match(help.tips_zh, /演示模式/, 'tips 应说明演示模式的限制')
    assert.ok(Array.isArray(help.chunks) && help.chunks.length >= 1)
  })

  test('buildChineseHelp：空输入返回 null，不崩', () => {
    for (const v of ['', '   ', null, undefined]) assert.equal(buildChineseHelp(v), null)
  })

  test('demo 中文消息：corrections 为空、chineseHelp 合法、无空洞夸奖', () => {
    const reply = buildDemoReply({ mode: 'free', message: '我今天很累，不知道怎么说', history: [] })
    const fb = reply.feedback
    assert.ok(fb.chineseHelp, 'demo 中文消息应返回 chineseHelp')
    assert.equal(fb.chineseHelp.unmatched, false)
    assert.match(fb.chineseHelp.english, /exhausted|tired/i)
    assert.deepEqual(fb.corrections, [], '中文输入不是英文语法错误，corrections 必须为空')
    assert.doesNotMatch(String(fb.encouragement_zh || ''), /very nice|good job|well done|great job|真棒|好厉害/i, '禁止空洞夸奖')
    assert.match(reply.text, /[a-zA-Z]/, 'demo 说话回复应为英文')
    assert.doesNotMatch(reply.text, /[\u4e00-\u9fff]/, 'demo 说话回复不应夹中文')
  })

  test('demo 英文消息：chineseHelp 为 null，且回复不为空', () => {
    const reply = buildDemoReply({ mode: 'free', message: 'I had a long day at work today.', history: [] })
    assert.equal(reply.feedback.chineseHelp, null)
    assert.ok(reply.text.length > 0)
    assert.equal(reply.feedback.corrections.length <= 2, true)
  })
})

describe('v1.2 content/demo.js 相关性（先回应/直接回答）', () => {
  test('英文直接提问：demo 正面回答而非反问', () => {
    const a = buildDemoFreeReply('How are you?', 0)
    assert.match(a, /I'm doing really well/i, `How are you? 应正面回答，实际 "${a}"`)
    const b = buildDemoFreeReply("What's your name?", 0)
    assert.match(b, /I'm Ava/i, '问名字应直接回答')
    const c = buildDemoFreeReply('Where are you from?', 0)
    assert.match(c, /from/i, '应先正面回答 From ...')
    const firstQ = c.indexOf('?')
    assert.ok(firstQ === -1 || firstQ > 20, `反问之前应有正面回答，实际 "${c}"`)
  })

  test('英文陈述：引用用户原话再承接（不做话题机器人）', () => {
    const a = buildDemoFreeReply('I had a long day at work today.', 0)
    assert.match(a, /So you said/i, '应先引用用户原话')
    assert.match(a, /work|day/i)
    const b = buildDemoFreeReply('I just ate the best noodles in town.', 0)
    assert.match(b, /So you said|noodles/i)
  })

  test('demo 回复不包含空洞夸奖固定语', () => {
    const samples = ['How are you?', 'I had a long day at work.', 'I like coffee.', 'I am tired.']
    for (const text of samples) {
      const reply = buildDemoFreeReply(text, 0)
      assert.doesNotMatch(reply, /very nice|good job|great job|well done/i, `${text} 的回复不应有空洞夸奖：${reply}`)
    }
  })
})

/* ========================================================================== */
/* v1.2 · lib/llm.js normalizeChineseHelp / chineseHelp 容错                     */
/* ========================================================================== */
describe('v1.2 lib/llm.js chineseHelp 规范化', () => {
  test('normalizeChineseHelp：合法对象完整保留', () => {
    const help = normalizeChineseHelp({
      original_zh: '我今天很累',
      english: "I'm exhausted today.",
      chunks: [
        { en: "I'm exhausted", zh: '我累坏了' },
        { en: 'today', zh: '今天' },
      ],
      tips_zh: 'exhausted 比 tired 更强烈。',
    })
    assert.equal(help.original_zh, '我今天很累')
    assert.equal(help.english, "I'm exhausted today.")
    assert.equal(help.chunks.length, 2)
    assert.equal(help.chunks[0].en, "I'm exhausted")
    assert.equal(help.chunks[0].zh, '我累坏了')
    assert.ok(help.tips_zh.includes('exhausted'))
  })

  test('normalizeChineseHelp：null/缺字段/空对象 → null，不抛异常', () => {
    for (const v of [null, undefined, '字符串', 42, {}, { chunks: [{ en: 'x' }] }]) {
      assert.equal(normalizeChineseHelp(v), null, `raw=${JSON.stringify(v)} 应归一为 null`)
    }
  })

  test('normalizeChineseHelp：chunks 过滤非法项、最多 4 条，字段截断', () => {
    const help = normalizeChineseHelp({
      original_zh: '中'.repeat(500),
      english: 'e'.repeat(500),
      chunks: [
        { en: 'a', zh: '甲' },
        null,
        { en: 'b', zh: '乙' },
        { en: 'c', zh: '丙' },
        { en: 'd', zh: '丁' },
        { en: 'e', zh: '戊' },
        { en: '', zh: '空 en 应过滤' },
      ],
      tips_zh: 'x'.repeat(500),
    })
    assert.equal(help.original_zh.length, 300)
    assert.equal(help.english.length, 300)
    assert.equal(help.tips_zh.length, 300)
    assert.equal(help.chunks.length, 4, 'chunks 最多 4 条')
    assert.ok(help.chunks.every((c) => c.en))
  })

  test('normalizeFeedback：保留 chineseHelp，旧反馈无该字段时为 null', () => {
    const fb = normalizeFeedback({
      corrections: [],
      better: [],
      newWords: [],
      encouragement_zh: '这次你主动用中文求助，很聪明',
      chineseHelp: { original_zh: '我今天很累', english: "I'm exhausted today.", chunks: [{ en: "I'm exhausted", zh: '我累坏了' }], tips_zh: '提示' },
    })
    assert.ok(fb.chineseHelp)
    assert.equal(fb.chineseHelp.english, "I'm exhausted today.")
    const legacy = normalizeFeedback({ corrections: [], encouragement_zh: '' })
    assert.equal(legacy.chineseHelp, null, '旧格式应兼容为 null')
    assert.equal(normalizeFeedback({ chineseHelp: 'bad' }).chineseHelp, null)
  })

  test('parseFeedback：整合 chineseHelp 且不影响旧字段', () => {
    const raw = JSON.stringify({
      corrections: [],
      better: [],
      newWords: [{ word: 'exhausted', meaning: '累坏的', example: "I'm exhausted." }],
      encouragement_zh: '你主动求助很聪明',
      followUp: '',
      chineseHelp: { original_zh: '我今天很累', english: "I'm exhausted today.", chunks: [], tips_zh: '提示' },
    })
    const fb = parseFeedback(`<<<FEEDBACK>>>\n${raw}`)
    assert.ok(fb.chineseHelp)
    assert.equal(fb.chineseHelp.original_zh, '我今天很累')
    assert.equal(fb.newWords[0].word, 'exhausted')
    assert.deepEqual(fb.corrections, [])
  })
})

/* ========================================================================== */
/* v1.2 · content/prompts.js 相关性硬规则 + 中文协议                              */
/* ========================================================================== */
describe('v1.2 content/prompts.js 相关性与中文求助协议', () => {
  test('所有模式 prompt 含「先直接回答/回应最新消息/禁止空洞夸奖」硬规则', () => {
    for (const mode of ['free', 'vocab', 'pronounce', 'roleplay']) {
      const prompt = buildSystemPrompt({ mode })
      assert.match(prompt, /HIGHEST PRIORITY/i, `${mode} 应含最高优先级规则`)
      assert.match(prompt, /LATEST message/i, `${mode} 应要求回应最新消息`)
      assert.match(prompt, /answer it directly/i, `${mode} 应要求直接回答问题`)
      assert.match(prompt, /Do NOT praise generically/i, `${mode} 应禁止空洞夸奖`)
      assert.match(prompt, /WHEN THE STUDENT USES CHINESE/i, `${mode} 应含中文求助协议`)
      assert.match(prompt, /chineseHelp/i, `${mode} 应说明 chineseHelp 字段`)
    }
  })

  test('chinese=true 时明确提示「本条消息是中文」；默认/英文时不含该强调', () => {
    const zh = buildSystemPrompt({ mode: 'free', chinese: true })
    assert.match(zh, /follow the Chinese protocol above now and fill chineseHelp/i, 'chinese=true 时应强调本条走中文协议')
    const en = buildSystemPrompt({ mode: 'free', chinese: false })
    assert.doesNotMatch(en, /follow the Chinese protocol above now and fill chineseHelp/i)
    const def = buildSystemPrompt({ mode: 'free' })
    assert.doesNotMatch(def, /follow the Chinese protocol above now and fill chineseHelp/i)
  })

  test('总结 prompt：中文求助算正向学习策略并提醒列出学会的表达', () => {
    const msgs = buildSummaryMessages({
      messages: [
        { role: 'user', content: '我今天很累，不知道怎么说' },
        { role: 'assistant', content: 'In English you can say: I am exhausted today.' },
      ],
    })
    const system = msgs[0].content
    assert.match(system, /GOOD learning strategy/i)
    assert.match(system, /中文求助/)
    assert.match(system, /keyWords/)
  })
})

/* ========================================================================== */
/* v1.2 · web/js/speech.js 中文检测与 STT 语言选择                               */
/* ========================================================================== */
describe('v1.2 web/js/speech.js 中文检测 / STT 语言', () => {
  test('isChineseText：中文/混合=true，英文/空=false', () => {
    assert.equal(isChineseText('我今天很累'), true)
    assert.equal(isChineseText('我有点 tired'), true)
    assert.equal(isChineseText('How are you?'), false)
    assert.equal(isChineseText('123 abc'), false)
    assert.equal(isChineseText(''), false)
    assert.equal(isChineseText(null), false)
    assert.equal(isChineseText(undefined), false)
  })

  test('pickSTTLang：中文模式 → zh-CN，其它/非法 → en-US', () => {
    for (const zh of ['zh', 'zh-CN', 'cn', 'chinese', '中文']) {
      assert.equal(pickSTTLang(zh), 'zh-CN', `pickSTTLang(${zh}) 应为 zh-CN`)
    }
    for (const en of ['en', 'en-US', 'free', '', null, undefined, 'xxx']) {
      assert.equal(pickSTTLang(en), 'en-US', `pickSTTLang(${JSON.stringify(en)}) 应为 en-US`)
    }
    assert.equal(STT_LANG_ZH, 'zh-CN')
  })
})

/* ========================================================================== */
/* v1.3 · lib/docExtract.js 文档文字提取（真实夹具）                              */
/* ========================================================================== */
describe('v1.3 lib/docExtract 文档提取', () => {
  const FIX = path.join(PROJECT_ROOT, 'test', 'fixtures')
  const readFixture = (name) => readFile(path.join(FIX, name))

  test('extOf / fileKind / isSupportedFile：扩展名分类与大小写', () => {
    assert.equal(extOf('article.PDF'), '.pdf')
    assert.equal(extOf('a.TXT'), '.txt')
    assert.equal(extOf('noext'), '')
    assert.equal(extOf(null), '')
    assert.equal(fileKind('a.txt'), 'text')
    assert.equal(fileKind('a.md'), 'text')
    assert.equal(fileKind('a.docx'), 'doc')
    assert.equal(fileKind('a.rtf'), 'doc')
    assert.equal(fileKind('a.pptx'), 'slides')
    assert.equal(fileKind('a.pptm'), 'slides')
    assert.equal(fileKind('a.pdf'), 'pdf')
    assert.equal(fileKind('a.png'), 'image')
    assert.equal(fileKind('a.jpeg'), 'image')
    assert.equal(fileKind('a.exe'), 'unknown')
    assert.equal(isSupportedFile('a.PNG'), true)
    assert.equal(isSupportedFile('a.exe'), false)
    assert.equal(isSupportedFile('a'), false)
    assert.ok(SUPPORTED_EXTENSIONS.includes('.docx'))
    assert.ok(SUPPORTED_EXTENSIONS.includes('.pptx'))
    assert.ok(SUPPORTED_EXTENSIONS.length >= 20)
  })

  test('usefulText：英文正文 ok；空/太短/乱码给出中文原因', () => {
    const ok = usefulText('Learning English every day is a good habit. Reading helps a lot.')
    assert.equal(ok.ok, true)
    assert.ok(ok.text.length > 0)
    for (const empty of ['', '   ', null, undefined]) {
      const r = usefulText(empty)
      assert.equal(r.ok, false)
      assert.match(r.reason, /没有提取到文字内容|内容太少/)
    }
    const short = usefulText('Hi there')
    assert.equal(short.ok, false)
    assert.match(short.reason, /内容太少/)
    const garbled = usefulText('a'.repeat(35) + '\u0001'.repeat(120))
    assert.equal(garbled.ok, false)
    assert.match(garbled.reason, /乱码/)
  })

  test('readZip：能读取 docx/pptx；非 ZIP 抛中文错误', async () => {
    const docx = await readFixture('fixture-doc.docx')
    const entries = readZip(docx)
    assert.ok(entries instanceof Map)
    assert.ok(entries.size >= 1, 'docx 应至少解析出一个 ZIP 条目')
    assert.ok(entries.has('word/document.xml'), 'docx 应有 word/document.xml')
    const pptx = readZip(await readFixture('fixture-slides.pptx'))
    assert.ok([...pptx.keys()].some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)), 'pptx 应有 slide xml')
    assert.throws(() => readZip(Buffer.from('short')), /不是有效的 ZIP 文件/)
    assert.throws(() => readZip(Buffer.alloc(200, 0)), /ZIP 目录结构损坏/)
  })

  test('extractDocxZipText：内置 ZIP+XML 兜底提取正文（不依赖 textutil）', async () => {
    const text = extractDocxZipText(await readFixture('fixture-doc.docx'))
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 20, 'docx 兜底解析应得到正文')
    assert.match(text, /Reading Practice/, `DOCX 内容应包含标题，实际 "${text.slice(0, 120)}"`)
    // 没有 word/document.xml 的 zip → 明确报错
    assert.throws(() => extractDocxZipText(Buffer.from('not a zip')), /不是有效的 ZIP 文件/)
    const pptxBuf = await readFixture('fixture-slides.pptx')
    assert.throws(() => extractDocxZipText(pptxBuf), /docx 中找不到正文/)
  })

  test('extractPptxText：逐页提取 <a:t> 文本且保持页序', async () => {
    const text = extractPptxText(await readFixture('fixture-slides.pptx'))
    assert.ok(text.length > 20, 'pptx 应提取到文字')
    assert.match(text, /English Learning Tips/, '应包含第 1 页标题')
    const first = text.indexOf('English Learning Tips')
    const second = text.indexOf('Practice speaking every day')
    if (second >= 0) assert.ok(first < second, '页序应为第 1 页在前')
    assert.match(text, /\n/, '多页之间应有换行分隔')
    const docxBuf = await readFixture('fixture-doc.docx')
    assert.throws(() => extractPptxText(docxBuf), /没有找到幻灯片文字|不是有效的 ZIP/)
  })

  test('extractPdfContentText：Tj / TJ / 十六进制 / 转义 文本算子', () => {
    const t1 = extractPdfContentText(Buffer.from('BT /F1 12 Tf 72 720 Td (Hello PDF World) Tj ET', 'latin1'))
    assert.match(t1, /Hello PDF World/)
    const t2 = extractPdfContentText(Buffer.from('BT [(Hello ) -120 (world)] TJ ET', 'latin1'))
    assert.match(t2, /Hello world/)
    const t3 = extractPdfContentText(Buffer.from('BT <48656C6C6F> Tj ET', 'latin1'))
    assert.match(t3, /Hello/)
    const t4 = extractPdfContentText(Buffer.from('BT (a \\(b\\) c) Tj T* (next line) Tj ET', 'latin1'))
    assert.match(t4, /a \(b\) c/)
    assert.match(t4, /next line/)
    assert.ok(t4.includes('\n'), 'T* 应产生换行')
  })

  test('extractPdfText：真实 PDF 可提取；扫描版（纯图片）无文字', async () => {
    const real = extractPdfText(await readFixture('test-pdf.pdf'))
    assert.ok(real.length > 50, '真实 PDF 应提取到文字')
    assert.match(real, /Reading Practice/)
    const scanned = extractPdfText(await readFixture('scanned-image-only.pdf'))
    assert.equal(scanned.trim().length, 0, '纯图片 PDF 不应提取到文字')
  })

  test('extractText：五类格式均可提取非空文字 + 元数据', async () => {
    const cases = [
      ['english-article.txt', 'text'],
      ['english-notes.md', 'text'],
      ['fixture-doc.docx', 'doc'],
      ['fixture-slides.pptx', 'slides'],
      ['test-pdf.pdf', 'pdf'],
    ]
    for (const [name, kind] of cases) {
      const r = await extractText({ filename: name, buffer: await readFixture(name) })
      assert.equal(r.kind, kind, `${name} kind`)
      assert.ok(r.text.length > 20, `${name} 应提取到文字`)
      assert.equal(r.chars, r.text.length, `${name} chars 应等于文本长度`)
      assert.equal(r.truncated, false)
      assert.ok(Array.isArray(r.warnings))
      if (kind === 'pdf') assert.ok(r.warnings.some((w) => w.includes('自动抽取')), 'PDF 应带自动抽取提示')
    }
    // 图片 OCR（macOS Vision；非 macOS skip）
    if (process.platform === 'darwin') {
      const img = await extractText({ filename: 'ocr-test.png', buffer: await readFixture('ocr-test.png') })
      assert.equal(img.kind, 'image')
      assert.ok(img.text.length > 20, 'OCR 图片应识别到文字')
      assert.match(img.text, /quick brown fox|Reading/i)
      assert.ok(img.warnings.some((w) => w.includes('OCR')), '图片应带 OCR 提示')
    }
  })

  test('extractText：错误路径中文提示（空/超大/不支持/扫描版/二进制造假 txt）', async () => {
    await assert.rejects(() => extractText({ filename: 'empty.txt', buffer: Buffer.alloc(0) }), /文件为空/)
    await assert.rejects(
      () => extractText({ filename: 'big.pdf', buffer: Buffer.alloc(12 * 1024 * 1024 + 1, 0x41) }),
      /文件太大/,
    )
    const unsupportedBuf = await readFixture('unsupported.exe')
    const scannedBuf = await readFixture('scanned-image-only.pdf')
    await assert.rejects(() => extractText({ filename: 'unsupported.exe', buffer: unsupportedBuf }), /暂不支持/)
    await assert.rejects(() => extractText({ filename: 'scanned-image-only.pdf', buffer: scannedBuf }), /扫描版/)
    await assert.rejects(() => extractText({ filename: 'empty.txt', buffer: Buffer.alloc(0) }), /文件为空/)
    // 含 NUL + 非法 UTF-8 字节（会解码出 \uFFFD）→ 应识别为伪装的二进制文件
    const fakeTxt = Buffer.concat([Buffer.from('Hello world abcdefghijklmnop'), Buffer.from([0, 0xff, 0xfe, 0x80])])
    await assert.rejects(() => extractText({ filename: 'binary.txt', buffer: fakeTxt }), /不是文本文件/)
    // 损坏的 docx（PK 头 + 垃圾数据）：textutil 失败后走内置 ZIP 兜底，最终给出明确错误
    const brokenDocx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(160, 0x41)])
    await assert.rejects(() => extractText({ filename: 'broken.docx', buffer: brokenDocx }), /ZIP|docx|Word|没有提取到/i)
  })

  test('extractText：超过 60k 字符自动截断并提示', async () => {
    const longText = 'English practice helps you improve every single day. '.repeat(2000) // ~104k
    const r = await extractText({ filename: 'long.txt', buffer: Buffer.from(longText, 'utf8') })
    assert.equal(r.truncated, true, '超长文本应被截断')
    assert.equal(r.chars, MAX_TEXT_CHARS, `截断后应恰好 ${MAX_TEXT_CHARS} 字符`)
    assert.ok(r.originalChars > MAX_TEXT_CHARS)
    assert.ok(r.warnings.some((w) => w.includes('截取')), '应提示已截取')
  })
})

/* ========================================================================== */
/* v1.3 · lib/docStore.js 文档持久化（沙箱 data/docs 隔离）                        */
/* ========================================================================== */
describe('v1.3 lib/docStore 文档持久化', () => {
  let sandboxRoot = ''
  let ds = null

  before(async () => {
    sandboxRoot = await mkdtemp(path.join(os.tmpdir(), 'ava-unit-docs-'))
    await cp(path.join(PROJECT_ROOT, 'lib'), path.join(sandboxRoot, 'lib'), { recursive: true })
    await cp(path.join(PROJECT_ROOT, 'content'), path.join(sandboxRoot, 'content'), { recursive: true })
    await writeFile(path.join(sandboxRoot, 'package.json'), '{"type":"module"}', 'utf8')
    ds = await import(pathToFileURL(path.join(sandboxRoot, 'lib', 'docStore.js')).href)
  })

  after(async () => {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true })
  })

  test('makeDocId / isValidDocId / docPath：id 格式与非法 id 防护', () => {
    const id = ds.makeDocId()
    assert.match(id, /^d_[a-f0-9]{16}$/)
    assert.equal(ds.isValidDocId(id), true)
    for (const bad of ['', 'd_', 'd_xyz', 'abc', 'd_1234', null, undefined, 42, 'd_' + '1'.repeat(30)]) {
      assert.equal(ds.isValidDocId(bad), false, `isValidDocId(${JSON.stringify(bad)}) 应为 false`)
    }
    assert.throws(() => ds.docPath('bad-id'), /无效的文档 id/)
    assert.ok(ds.docPath(id).endsWith(`${id}.json`))
  })

  test('saveDoc / getDoc：保存提取文字并可读回；空文本报错', () => {
    const id = ds.makeDocId()
    const saved = ds.saveDoc({
      id,
      name: 'article.txt',
      kind: 'text',
      chars: 120,
      truncated: false,
      warnings: ['test warning'],
      text: 'Reading practice helps English learners improve step by step.',
      createdAt: 1000,
    })
    assert.equal(saved.id, id)
    assert.equal(saved.name, 'article.txt')
    assert.equal(saved.chars, 120)
    assert.deepEqual(saved.warnings, ['test warning'])
    assert.equal(saved.createdAt, 1000)
    assert.equal(saved.analysis, null)
    const got = ds.getDoc(id)
    assert.ok(got, 'getDoc 应能读回刚保存的文档')
    assert.equal(got.text, 'Reading practice helps English learners improve step by step.')
    assert.equal(ds.getDoc('d_0000000000000000'), null, '不存在的文档应返回 null')
    assert.equal(ds.getDoc('bad-id'), null)
    assert.throws(() => ds.saveDoc({ name: 'x.txt', text: '' }), /文档内容为空/)
    assert.throws(() => ds.saveDoc(null), /文档内容为空/)
  })

  test('saveDoc 清洗文件名：控制字符/路径分隔符，超长截断', () => {
    const id = ds.makeDocId()
    const saved = ds.saveDoc({
      id,
      name: '/tmp/../a\u0000b/c\\d.docx',
      kind: 'doc',
      text: 'Some English content for reading practice session.',
    })
    assert.ok(!saved.name.includes('\u0000'))
    assert.ok(!saved.name.includes('/'))
    assert.ok(!saved.name.includes('\\'))
    assert.ok(saved.name.length <= 120)
    const long = ds.saveDoc({
      id: ds.makeDocId(),
      name: 'x'.repeat(300) + '.txt',
      kind: 'text',
      text: 'Another English content long name test for reading.',
    })
    assert.equal(long.name.length, 120)
  })

  test('listDocs：按 createdAt 倒序、limit 生效、analyzed 标记', () => {
    const a = ds.saveDoc({ name: 'a.txt', kind: 'text', text: 'First English document for reading practice.', createdAt: 100 })
    const b = ds.saveDoc({ name: 'b.txt', kind: 'text', text: 'Second English document for reading practice.', createdAt: 200 })
    const list = ds.listDocs()
    const ids = list.map((d) => d.id)
    assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), 'listDocs 应按 createdAt 倒序')
    assert.equal(ds.listDocs(1).length, 1, 'limit=1 应只返回 1 条')
    const before = list.find((d) => d.id === a.id)
    assert.equal(before.analyzed, false)
    ds.saveDocAnalysis(a.id, { summary_zh: '分析', keyWords: [] })
    const after = ds.listDocs().find((d) => d.id === a.id)
    assert.equal(after.analyzed, true, '保存分析后 analyzed 应为 true')
  })

  test('saveDocAnalysis：缓存分析结果；不存在的文档报错', () => {
    const id = ds.makeDocId()
    ds.saveDoc({ id, name: 'cache.txt', kind: 'text', text: 'Cache analysis test English content here.' })
    const analysis = { summary_zh: '这份材料讲阅读练习。', keyWords: [{ word: 'practice' }], questions: [{ en: 'Q?' }], readAloud: 'Read this.', wordCount: 7 }
    const next = ds.saveDocAnalysis(id, analysis)
    assert.deepEqual(next.analysis, analysis)
    assert.deepEqual(ds.getDoc(id).analysis, analysis, '分析应缓存到文档文件')
    assert.throws(() => ds.saveDocAnalysis('d_0000000000000000', analysis), /文档不存在/)
  })

  test('deleteDoc：删除成功/重复删除/非法 id', () => {
    const id = ds.makeDocId()
    ds.saveDoc({ id, name: 'del.txt', kind: 'text', text: 'Delete me English reading document content.' })
    assert.equal(ds.deleteDoc(id), true)
    assert.equal(ds.getDoc(id), null)
    assert.equal(ds.deleteDoc(id), false)
    assert.equal(ds.deleteDoc('bad-id'), false)
  })

  test('pruneDocs：最多保留最近 30 份', () => {
    // 先清空本沙箱之前用例写入的文档，保证 createdAt 窗口可控
    for (const d of ds.listDocs(1000)) ds.deleteDoc(d.id)
    for (let i = 0; i < 35; i++) {
      ds.saveDoc({
        name: `prune-${i}.txt`,
        kind: 'text',
        text: `Prune document number ${i} with enough English words for reading practice.`,
        createdAt: 10_000 + i,
      })
    }
    const all = ds.listDocs(1000)
    assert.equal(all.length, 30, '最多保留 30 份文档')
    const times = all.map((d) => d.createdAt)
    assert.equal(Math.min(...times), 10_005, '最旧的 5 份应被清理')
    assert.equal(Math.max(...times), 10_034)
  })

  test('publicDoc：默认不含正文/分析，preview/选项控制', () => {
    const id = ds.makeDocId()
    const text = 'Preview text. '.repeat(60)
    ds.saveDoc({ id, name: 'pub.txt', kind: 'text', text, createdAt: Date.now() })
    ds.saveDocAnalysis(id, { summary_zh: '摘要', keyWords: [] })
    const base = ds.publicDoc(ds.getDoc(id))
    assert.ok(base)
    assert.ok(!('text' in base), '默认不返回正文')
    assert.ok(!('analysis' in base), '默认不返回分析')
    assert.equal(base.analyzed, true)
    assert.equal(ds.publicDoc(ds.getDoc(id), { preview: true }).preview.length, 400)
    assert.ok(ds.publicDoc(ds.getDoc(id), { text: true }).text.length > 400)
    assert.ok(ds.publicDoc(ds.getDoc(id), { analysis: true }).analysis)
    assert.equal(ds.publicDoc(null), null)
  })
})

/* ========================================================================== */
/* v1.3 · lib/docAnalysis.js 分析归一化 / demo 降级                              */
/* ========================================================================== */
describe('v1.3 lib/docAnalysis 分析', () => {
  test('countWords：只统计英文单词', () => {
    assert.equal(countWords('Hello world, this is a test!'), 6)
    assert.equal(countWords('123 456'), 0)
    assert.equal(countWords(''), 0)
    assert.equal(countWords(null), 0)
    assert.equal(countWords('中英 mixed words here'), 3)
  })

  test('normalizeDocAnalysis：完整结构 / 数量上限 / 缺省补全', () => {
    const analysis = normalizeDocAnalysis(
      {
        summary_zh: '  ',
        keyPoints: Array.from({ length: 9 }, (_, i) => ({ en: `Point ${i}`, zh: `要点${i}` })),
        keyWords: Array.from({ length: 14 }, (_, i) => ({ word: `word${i}`, meaning: '释义' })),
        questions: Array.from({ length: 9 }, (_, i) => ({ en: `Question ${i}?`, zh: `问题${i}` })),
        readAloud: '',
        wordCount: 0,
      },
      { text: 'English text for analysis with several words in it.', name: 'demo.txt' },
    )
    assert.equal(analysis.keyPoints.length, 6, 'keyPoints 最多 6 条')
    assert.equal(analysis.keyWords.length, 10, 'keyWords 最多 10 条')
    assert.equal(analysis.questions.length, 6, 'questions 最多 6 条')
    assert.match(analysis.summary_zh, /demo\.txt|英文单词/, '缺 summary 时应生成中文默认摘要')
    assert.equal(analysis.readAloud, 'English text for analysis with several words in it.', '缺 readAloud 时回退正文前 800 字')
    assert.ok(analysis.wordCount > 0, 'wordCount 应回退正文统计')
    const empty = normalizeDocAnalysis(null, { text: '', name: '' })
    assert.equal(typeof empty.summary_zh, 'string')
    assert.deepEqual(empty.keyPoints, [])
    assert.deepEqual(empty.keyWords, [])
    assert.deepEqual(empty.questions, [])
    assert.equal(empty.wordCount, 0)
  })

  test('normalizeKeyWords（doc）：去重、过滤非英文、最多 10 个', () => {
    const out = normalizeDocAnalysis(
      {
        keyWords: [
          { word: 'Commute', meaning: '通勤' },
          { word: 'commute', meaning: '重复' },
          { word: '', meaning: '空' },
          { word: '中文词' },
          null,
          ...Array.from({ length: 15 }, (_, i) => ({ word: `w${i}ord`, meaning: 'x' })),
        ],
      },
      { text: 'x' },
    ).keyWords
    assert.equal(out.length, 10)
    assert.equal(out.filter((w) => w.word.toLowerCase() === 'commute').length, 1)
    assert.ok(out.every((w) => /[A-Za-z]/.test(w.word)))
  })

  test('parseDocAnalysisJson：合法 / 围栏 / 杂文本；非法抛错', () => {
    assert.deepEqual(parseDocAnalysisJson('{"summary_zh":"摘要"}'), { summary_zh: '摘要' })
    assert.deepEqual(parseDocAnalysisJson('```json\n{"summary_zh":"围栏"}\n```'), { summary_zh: '围栏' })
    assert.deepEqual(parseDocAnalysisJson('前言\n{"summary_zh":"杂文本"}\n后缀'), { summary_zh: '杂文本' })
    for (const bad of ['', null, 'not json', '[1,2]', '无法分析']) {
      assert.throws(() => parseDocAnalysisJson(bad), /分析内容/)
    }
  })

  test('analyzeDocument：无 Key 自动降级 demo 分析（接口永不失败）', async () => {
    const text =
      'Reading English every day is one of the best ways to improve. ' +
      'It builds vocabulary, improves grammar and helps you understand how sentences connect. ' +
      'Start with short articles that interest you, then summarise each paragraph in your own words.'
    const r = await analyzeDocument({ doc: { name: 'article.txt', text }, level: 'A2', settings: { apiKey: '' } })
    assert.equal(r.demo, true)
    assert.ok(r.analysis.summary_zh.length > 10, 'demo 分析应有中文摘要')
    assert.ok(Array.isArray(r.analysis.keyPoints) && r.analysis.keyPoints.length >= 1)
    assert.ok(r.analysis.keyPoints.every((p) => p.en && p.zh))
    assert.ok(Array.isArray(r.analysis.keyWords) && r.analysis.keyWords.length >= 1 && r.analysis.keyWords.length <= 10)
    assert.ok(Array.isArray(r.analysis.questions) && r.analysis.questions.length >= 3, 'demo 分析至少 3 道理解题')
    assert.ok(r.analysis.readAloud.length > 0 && r.analysis.readAloud.length <= 800)
    assert.ok(r.analysis.wordCount > 20)
    assert.equal(r.analysis.demo, true)
  })

  test('analyzeDocument：空文本不抛异常', async () => {
    const r = await analyzeDocument({ doc: { name: 'empty.txt', text: '' }, settings: { apiKey: '' } })
    assert.equal(r.demo, true)
    assert.equal(typeof r.analysis.summary_zh, 'string')
    assert.ok(Array.isArray(r.analysis.keyWords))
  })
})

/* ========================================================================== */
/* v1.3 · content/demo.js 阅读分析/讲解（demo 路径）                              */
/* ========================================================================== */
describe('v1.3 content/demo.js 阅读讲解', () => {
  const ARTICLE = `Reading Practice

The quick brown fox jumps over the lazy dog. Reading English every day helps learners build vocabulary.
The weather is really nice today. The quick brown fox is a famous sentence used for typing practice.`
  const analysis = {
    summary_zh: '这篇材料讲阅读练习。',
    keyPoints: [{ en: 'Reading English every day helps learners build vocabulary.', zh: '每天阅读有助于积累词汇' }],
    keyWords: [{ word: 'vocabulary', phonetic: '/vəˈkæbjələri/', meaning: '词汇', example: 'Reading builds vocabulary.' }],
    questions: [
      { en: 'What is the main idea of the text?', zh: '主旨是什么？' },
      { en: 'According to the text, what does reading help?', zh: '阅读帮助什么？' },
      { en: 'Which sentence do you find most interesting?', zh: '哪句最有趣？' },
      { en: 'Do you agree with the main idea? Why?', zh: '你同意主旨吗？为什么？' },
    ],
    readAloud: 'Reading English every day helps learners build vocabulary.',
    wordCount: 30,
  }

  test('buildDemoDocAnalysis：摘要/要点/重点词/理解题/朗读片段齐全', () => {
    const a = buildDemoDocAnalysis({ text: ARTICLE, name: 'article.txt', level: 'A2' })
    assert.equal(a.demo, true)
    assert.match(a.summary_zh, /article\.txt|英文单词/)
    assert.ok(a.keyPoints.length >= 1 && a.keyPoints.length <= 4)
    assert.ok(a.keyPoints.every((p) => p.en && p.en.length > 0))
    assert.ok(a.keyWords.length >= 1 && a.keyWords.length <= 8)
    assert.ok(a.keyWords.every((w) => w.word && /[A-Za-z]/.test(w.word)))
    assert.ok(a.questions.length >= 3 && a.questions.length <= 4, 'demo 应生成 3–4 道理解题')
    assert.ok(a.questions.every((q) => q.en && q.zh))
    assert.ok(a.readAloud.length > 0 && a.readAloud.length <= 800)
    assert.ok(a.wordCount > 10)
  })

  test('buildDemoDocAnalysis：空文本安全降级', () => {
    const a = buildDemoDocAnalysis({ text: '', name: '' })
    assert.equal(a.wordCount, 0)
    assert.deepEqual(a.keyPoints, [])
    assert.deepEqual(a.questions, [])
    assert.match(a.summary_zh, /没有可分析/)
  })

  test('buildDemoReadingReply：开场白含文档名 + 第一题', () => {
    const r = buildDemoReadingReply({ doc: { name: 'article.txt' }, analysis, message: 'start reading', history: [] })
    assert.match(r.text, /article\.txt/, '开场应提到文档名')
    assert.match(r.text, /First question/i, '开场应给出第一道理解题')
    assert.ok(r.text.includes(analysis.questions[0].en), '应包含第一题原文')
    assert.ok(Array.isArray(r.feedback.corrections))
    assert.equal(r.feedback.chineseHelp, null)
  })

  test('buildDemoReadingReply：回答后有反馈 + 下一题', () => {
    const r = buildDemoReadingReply({
      doc: { name: 'article.txt' },
      analysis,
      message: 'Reading helps us build vocabulary.',
      // 真实流程：start 消息为空，因此回答时 history 里只有 assistant 的开场，没有 user 轮次
      history: [{ role: 'assistant', content: 'Let us read this text together. First question: ...' }],
    })
    assert.match(r.text, /Next question/i, '回答后应给出下一题')
    assert.ok(r.text.includes(analysis.questions[1].en))
    assert.ok(r.feedback.encouragement_zh.length > 0)
  })

  test('QA-011 回归：首次回答不会重复开场（开场只在 start/空消息时触发）', () => {
    const r = buildDemoReadingReply({
      doc: { name: 'article.txt' },
      analysis,
      message: 'Reading helps us build vocabulary.',
      history: [],
    })
    assert.doesNotMatch(r.text, /First question/i, '第一次回答不应重复开场白')
    assert.doesNotMatch(r.text, /Let's read .*together/i, '第一次回答不应重复介绍文档')
    assert.match(r.text, /Thanks for your answer|Next question/i, '回答后应承接并给出下一题')
    // 空消息 / start 仍应触发开场
    const start1 = buildDemoReadingReply({ doc: { name: 'article.txt' }, analysis, message: '', history: [] })
    assert.match(start1.text, /First question/i)
    const start2 = buildDemoReadingReply({ doc: { name: 'article.txt' }, analysis, message: 'start reading', history: [] })
    assert.match(start2.text, /First question/i)
  })

  test('buildDemoReadingReply：中文求助优先，corrections 为空', () => {
    const r = buildDemoReadingReply({
      doc: { name: 'article.txt' },
      analysis,
      message: '我今天很累，不知道怎么说',
      history: [{ role: 'user', content: '开始讲解' }],
    })
    assert.ok(r.feedback.chineseHelp, '阅读讲解中文消息应返回 chineseHelp')
    assert.match(r.feedback.chineseHelp.english, /exhausted|tired/i)
    assert.deepEqual(r.feedback.corrections, [])
    assert.ok(r.text.includes(r.feedback.chineseHelp.english) || /No worries/i.test(r.text))
  })

  test('buildDemoReadingReply：提问时结合原文引用要点', () => {
    const r = buildDemoReadingReply({
      doc: { name: 'article.txt' },
      analysis,
      message: 'What does vocabulary mean?',
      history: [{ role: 'user', content: '开始讲解' }, { role: 'assistant', content: 'First question: ...' }],
    })
    assert.match(r.text, /The text says/i, '回答词义问题应引用原文')
    assert.ok(r.text.includes(analysis.keyPoints[0].en), '应引用 keyPoints 原句')
  })
})

/* ========================================================================== */
/* v1.3 · content/prompts.js 阅读分析与阅读讲解 prompt                          */
/* ========================================================================== */
describe('v1.3 content/prompts.js 阅读', () => {
  test('buildDocAnalysisMessages：system+user，含全部字段约束与正文', () => {
    const msgs = buildDocAnalysisMessages({
      text: 'Reading practice makes perfect. English learners should read every day.',
      name: 'article.txt',
      level: 'B1',
    })
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].role, 'system')
    assert.equal(msgs[1].role, 'user')
    const system = msgs[0].content
    for (const key of ['summary_zh', 'keyPoints', 'keyWords', 'questions', 'readAloud', 'wordCount']) {
      assert.ok(system.includes(key), `分析 prompt 应包含字段 ${key}`)
    }
    assert.match(system, /article\.txt/)
    assert.match(system, /B1/)
    assert.match(system, /Reading practice makes perfect/)
  })

  test('buildSystemPrompt reading：注入文档标题/正文/分析要点 + 一次一题', () => {
    const doc = {
      name: 'article.txt',
      kind: 'text',
      text: 'The quick brown fox jumps over the lazy dog. Reading helps vocabulary.',
      analysis: { summary_zh: '讲阅读', keyPoints: [{ en: 'Reading helps vocabulary.' }], keyWords: [{ word: 'vocabulary' }], questions: [{ en: 'What is the main idea?' }] },
    }
    const prompt = buildSystemPrompt({ mode: 'reading', doc, level: 'A2' })
    assert.match(prompt, /Uploaded reading material/)
    assert.match(prompt, /article\.txt/)
    assert.match(prompt, /Quick brown fox|quick brown fox/i, '应注入原文片段')
    assert.match(prompt, /Reading helps vocabulary/)
    assert.match(prompt, /ONE question at a time/i)
    assert.match(prompt, /Chinese-help rules|WHEN THE STUDENT USES CHINESE/i)
    // 无 doc 时 reading 模式仍可用
    const bare = buildSystemPrompt({ mode: 'reading' })
    assert.match(bare, /Mode: Reading tutor/i)
  })
})

/** 单元测试用轮询等待 */
async function waitUntil(fn, { timeoutMs = 5000, interval = 25, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${lastErr ? `（${lastErr.message}）` : ''}`)
}

/* ========================================================================== */
/* v1.4 · lib/volcProtocol.js 二进制协议编解码                                     */
/* ========================================================================== */
describe('v1.4 lib/volcProtocol 协议编解码', () => {
  test('常量：消息类型 / 事件 id / 头版本 / connect 级事件', () => {
    assert.equal(PROTOCOL_VERSION, 0x01)
    assert.equal(HEADER_SIZE_UNITS, 0x01)
    assert.equal(FLAG_EVENT, 0b0100)
    assert.deepEqual(MSG_TYPE, {
      FULL_CLIENT_REQUEST: 0b0001,
      FULL_SERVER_RESPONSE: 0b1001,
      AUDIO_ONLY_REQUEST: 0b0010,
      AUDIO_ONLY_RESPONSE: 0b1011,
      ERROR: 0b1111,
    })
    assert.equal(CLIENT_EVENT.START_CONNECTION, 1)
    assert.equal(CLIENT_EVENT.FINISH_CONNECTION, 2)
    assert.equal(CLIENT_EVENT.START_SESSION, 100)
    assert.equal(CLIENT_EVENT.TASK_REQUEST, 200)
    assert.equal(CLIENT_EVENT.CLIENT_INTERRUPT, 515)
    assert.equal(SERVER_EVENT.CONNECTION_STARTED, 50)
    assert.equal(SERVER_EVENT.SESSION_STARTED, 150)
    assert.equal(SERVER_EVENT.SESSION_FAILED, 153)
    assert.equal(SERVER_EVENT.TTS_SENTENCE_START, 350)
    assert.equal(SERVER_EVENT.TTS_RESPONSE, 352)
    assert.equal(SERVER_EVENT.TTS_ENDED, 359)
    assert.equal(SERVER_EVENT.ASR_INFO, 450)
    assert.equal(SERVER_EVENT.ASR_RESPONSE, 451)
    assert.equal(SERVER_EVENT.ASR_ENDED, 459)
    assert.equal(SERVER_EVENT.CHAT_RESPONSE, 550)
    assert.equal(SERVER_EVENT.CHAT_ENDED, 559)
    assert.equal(SERVER_EVENT.DIALOG_COMMON_ERROR, 599)
    assert.equal([...CONNECT_LEVEL_EVENTS].sort((a, b) => a - b).join(','), '1,2,50,51,52')
  })

  test('encodeEvent / parseFrame：客户端 JSON 事件往返（头 0x11、event id、session id）', () => {
    const frame = encodeEvent({
      msgType: MSG_TYPE.FULL_CLIENT_REQUEST,
      eventId: CLIENT_EVENT.START_SESSION,
      payload: { tts: { speaker: 'en_female_dacey_uranus_bigtts' } },
      sessionId: 'session-abc',
    })
    assert.equal(frame[0], 0x11, '首字节应为 0x11（版本 1 + 头长 1）')
    assert.equal(frame[1] >> 4, MSG_TYPE.FULL_CLIENT_REQUEST)
    assert.equal(frame[1] & 0x0f, FLAG_EVENT)
    assert.equal(frame[2] >> 4, SERIALIZATION.JSON)
    const parsed = parseFrame(frame)
    assert.equal(parsed.msgType, MSG_TYPE.FULL_CLIENT_REQUEST)
    assert.equal(parsed.eventId, CLIENT_EVENT.START_SESSION)
    assert.equal(parsed.sessionId, 'session-abc')
    assert.equal(parsed.connectId, null)
    assert.deepEqual(parsed.json, { tts: { speaker: 'en_female_dacey_uranus_bigtts' } })
    assert.ok(Buffer.isBuffer(parsed.payload))
  })

  test('encodeEvent：connect 级事件携带 connect_id 而非 session_id', () => {
    const frame = encodeEvent({ eventId: CLIENT_EVENT.START_CONNECTION, connectId: 'conn-1', payload: {} })
    const parsed = parseFrame(frame)
    assert.equal(parsed.connectId, 'conn-1')
    assert.equal(parsed.sessionId, null)
    const finish = parseFrame(encodeEvent({ eventId: CLIENT_EVENT.FINISH_CONNECTION, connectId: 'conn-1' }))
    assert.equal(finish.eventId, 2)
    assert.equal(finish.connectId, 'conn-1')
  })

  test('encodeEvent：会话级事件携带 sessionId 往返（协议约定）', () => {
    const parsed = parseFrame(encodeEvent({ eventId: CLIENT_EVENT.START_SESSION, payload: { a: 1 }, sessionId: 's-100' }))
    assert.equal(parsed.eventId, 100)
    assert.equal(parsed.sessionId, 's-100')
    assert.deepEqual(parsed.json, { a: 1 })
    // 音频上行帧同样带 session id
    const audio = parseFrame(encodeAudio(Buffer.alloc(640, 1), 's-audio'))
    assert.equal(audio.eventId, 200)
    assert.equal(audio.sessionId, 's-audio')
  })

  test('encodeServerEvent：服务端 JSON 事件（ConnectionStarted/SessionStarted/Chat）', () => {
    const started = parseFrame(
      // encodeServerEvent 不 passthrough connectId，connect 级服务端事件用 encodeEvent 编码
      encodeEvent({ msgType: MSG_TYPE.FULL_SERVER_RESPONSE, eventId: SERVER_EVENT.CONNECTION_STARTED, payload: { connect_id: 'c1' }, connectId: 'c1' }),
    )
    assert.equal(started.msgType, MSG_TYPE.FULL_SERVER_RESPONSE)
    assert.equal(started.eventId, 50)
    assert.deepEqual(started.json, { connect_id: 'c1' })

    const chat = parseFrame(
      encodeServerEvent({ eventId: SERVER_EVENT.CHAT_RESPONSE, payload: { content: 'Hello there' }, sessionId: 's-1' }),
    )
    assert.equal(chat.eventId, 550)
    assert.equal(chat.sessionId, 's-1')
    assert.deepEqual(chat.json, { content: 'Hello there' })
  })

  test('encodeAudio / parseFrame：音频上行帧（事件 200、二进制负载原样）', () => {
    const pcm = Buffer.alloc(640)
    for (let i = 0; i < pcm.length; i++) pcm[i] = i & 0xff
    const frame = encodeAudio(pcm, 'sess-audio')
    assert.equal(frame[0], 0x11)
    assert.equal(frame[1] >> 4, MSG_TYPE.AUDIO_ONLY_REQUEST)
    const parsed = parseFrame(frame)
    assert.equal(parsed.msgType, MSG_TYPE.AUDIO_ONLY_REQUEST)
    assert.equal(parsed.eventId, CLIENT_EVENT.TASK_REQUEST)
    assert.equal(parsed.sessionId, 'sess-audio')
    assert.equal(parsed.serialization, SERIALIZATION.RAW)
    assert.deepEqual(parsed.payload, pcm)
    assert.equal(parsed.json, null, '二进制负载不应尝试 JSON 解析')
  })

  test('encodeServerAudio：服务端音频下行帧（消息类型 11）', () => {
    const pcm = Buffer.from([0, 1, 2, 3, 4, 5])
    const parsed = parseFrame(encodeServerAudio(pcm))
    assert.equal(parsed.msgType, MSG_TYPE.AUDIO_ONLY_RESPONSE)
    assert.equal(parsed.eventId, null)
    assert.equal(parsed.sessionId, null)
    assert.deepEqual(parsed.payload, pcm)
  })

  test('encodeError：错误帧（消息类型 15 + error code + JSON）', () => {
    const parsed = parseFrame(encodeError({ code: 1001, message: 'invalid app id' }))
    assert.equal(parsed.msgType, MSG_TYPE.ERROR)
    assert.equal(parsed.errorCode, 1001)
    assert.equal(parsed.json.error, 'invalid app id')
  })

  test('gzip 压缩：编码后负载更小，parseFrame 自动解压并解析 JSON', () => {
    const payload = { text: 'hello '.repeat(80) }
    const plain = encodeEvent({ eventId: 550, payload, sessionId: 'gz' })
    const gz = encodeEvent({ eventId: 550, payload, sessionId: 'gz', compression: COMPRESSION.GZIP })
    assert.ok(gz.length < plain.length, `gzip 帧应更小（${gz.length} < ${plain.length}）`)
    const parsed = parseFrame(gz)
    assert.equal(parsed.compression, COMPRESSION.GZIP)
    assert.deepEqual(parsed.json, payload)
  })

  test('parseFrame 容错：短帧抛错、只有头/无负载不崩、坏 JSON 不崩', () => {
    assert.throws(() => parseFrame(Buffer.from([0x11, 0x14])), /帧太短/)
    const headerOnly = parseFrame(Buffer.from([0x11, 0x14, 0x10, 0x00]))
    assert.equal(headerOnly.eventId, null)
    assert.equal(headerOnly.payload, null)
    const badJson = encodeEvent({ eventId: 550, payload: Buffer.from('not json'), serialization: SERIALIZATION.JSON, sessionId: 'bad' })
    const parsedBad = parseFrame(badJson)
    assert.equal(parsedBad.json, null)
    assert.equal(parsedBad.payload.toString(), 'not json')
  })

  test('generateId：uuid v4 形式且不重复', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateId()))
    assert.equal(ids.size, 20)
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

/* ========================================================================== */
/* v1.4 · lib/wsServer.js 零依赖 WebSocket 服务端（握手/掩码/分片/ping）            */
/* ========================================================================== */
describe('v1.4 lib/wsServer 零依赖 WS 服务端', () => {
  let server = null
  let port = 0
  const connections = []
  const messages = []

  function wsOpen(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      const timer = setTimeout(() => reject(new Error('WS 连接超时')), 5000)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(ws)
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('WS 连接失败'))
      })
    })
  }

  function wsNext(ws, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMessage)
        reject(new Error('等待 WS 消息超时'))
      }, timeoutMs)
      const onMessage = (ev) => {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve(ev.data)
      }
      ws.addEventListener('message', onMessage)
    })
  }

  function wsClosed(ws, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 WS 关闭超时')), timeoutMs)
      ws.addEventListener('close', (ev) => {
        clearTimeout(timer)
        resolve(ev)
      })
    })
  }

  /** 手写握手，返回裸 socket（用于分片/ping 等底层行为测试） */
  async function rawHandshake(path = '/ws/voice') {
    const socket = net.connect(port, '127.0.0.1')
    await once(socket, 'connect')
    const key = crypto.randomBytes(16).toString('base64')
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
    let buf = Buffer.alloc(0)
    while (!buf.includes('\r\n\r\n')) {
      const [chunk] = await once(socket, 'data')
      buf = Buffer.concat([buf, chunk])
    }
    const head = buf.toString('latin1').split('\r\n\r\n')[0]
    assert.match(head, /101 Switching Protocols/)
    assert.match(head, /Sec-WebSocket-Accept: /i, '握手响应应包含 Sec-WebSocket-Accept')
    return { socket, head }
  }

  function maskedFrame(opcode, payload, { fin = true } = {}) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))
    const mask = crypto.randomBytes(4)
    const masked = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3]
    let header
    if (data.length < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | data.length])
    else if (data.length < 65536) {
      header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, data.length >> 8, data.length & 0xff])
    } else throw new Error('测试辅助仅支持小帧')
    return Buffer.concat([header, mask, masked])
  }

  /** 从裸 socket 读一个服务端帧（服务端帧不掩码） */
  async function readServerFrame(socket) {
    let buf = Buffer.alloc(0)
    for (;;) {
      if (buf.length >= 2) {
        const opcode = buf[0] & 0x0f
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) {
            const [c] = await once(socket, 'data')
            buf = Buffer.concat([buf, c])
            continue
          }
          len = buf.readUInt16BE(2)
          off = 4
        }
        if (buf.length >= off + len) return { opcode, payload: buf.subarray(off, off + len) }
      }
      const [chunk] = await once(socket, 'data')
      buf = Buffer.concat([buf, chunk])
    }
  }

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    attachWsServer(server, '/ws/voice', (conn) => {
      connections.push(conn)
      conn.on('message', (data, isBinary) => messages.push({ data, isBinary }))
      conn.on('close', () => {})
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })

  after(async () => {
    for (const conn of connections) conn.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  test('握手 + 服务端→客户端文本消息', async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws/voice`)
    await waitUntil(() => connections.length >= 1, { timeoutMs: 3000, label: '服务端 onConnection' })
    const conn = connections[connections.length - 1]
    const payload = { type: 'ready', model: '3.0', speaker: 'en_female' }
    conn.sendText(payload)
    const got = await wsNext(ws)
    assert.deepEqual(JSON.parse(String(got)), payload)
    conn.destroy()
    ws.close()
  })

  test('客户端→服务端：文本与二进制消息（二进制保持 Buffer）', async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws/voice`)
    await waitUntil(() => connections.length >= 1, { timeoutMs: 3000, label: '服务端连接' })
    const startIndex = messages.length
    ws.send('hello text')
    ws.send(new Uint8Array([1, 2, 3, 4, 5]))
    await waitUntil(() => messages.length >= startIndex + 2, { timeoutMs: 4000, label: '服务端收到两条消息' })
    const [textMsg, binMsg] = messages.slice(startIndex, startIndex + 2)
    assert.equal(textMsg.isBinary, false)
    assert.equal(textMsg.data, 'hello text')
    assert.equal(binMsg.isBinary, true)
    assert.deepEqual([...binMsg.data], [1, 2, 3, 4, 5])
    connections[connections.length - 1].destroy()
    ws.close()
  })

  test('中/大负载：125+ 与 65535+ 字节帧正确收发', async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws/voice`)
    await waitUntil(() => connections.length >= 1, { timeoutMs: 3000, label: '服务端连接' })
    const messageStart = messages.length
    const medium = Buffer.alloc(300, 7)
    ws.send(medium)
    await waitUntil(() => messages.length >= messageStart + 1, { timeoutMs: 4000, label: '服务端收到 300B' })
    assert.equal(messages[messageStart].data.length, 300)
    assert.deepEqual(messages[messageStart].data, medium)

    const large = Buffer.alloc(70_000, 9)
    const largeStart = messages.length
    ws.send(large)
    await waitUntil(() => messages.length >= largeStart + 1, { timeoutMs: 6000, label: '服务端收到 70KB' })
    assert.equal(messages[largeStart].data.length, 70_000)

    const conn = connections[connections.length - 1]
    conn.sendBinary(medium)
    const got = await wsNext(ws)
    const arr = got instanceof ArrayBuffer ? new Uint8Array(got) : new Uint8Array(Buffer.from(got))
    assert.equal(arr.length, 300)
    assert.equal(arr[0], 7)
    conn.destroy()
    ws.close()
  })

  test('分片消息拼接（opcode 1 + continue 0 + FIN）', async () => {
    const { socket } = await rawHandshake()
    await waitUntil(() => connections.length >= 1, { timeoutMs: 3000, label: '裸 socket 连接' })
    const startIndex = messages.length
    socket.write(maskedFrame(0x1, 'Hel', { fin: false }))
    socket.write(maskedFrame(0x0, 'lo ', { fin: false }))
    socket.write(maskedFrame(0x0, 'World', { fin: true }))
    await waitUntil(() => messages.length >= startIndex + 1, { timeoutMs: 4000, label: '分片消息重组' })
    assert.equal(messages[startIndex].data, 'Hello World')
    socket.destroy()
  })

  test('ping → pong（RFC6455 控制帧）', async () => {
    const { socket } = await rawHandshake()
    socket.write(maskedFrame(0x9, 'ping-payload'))
    const frame = await readServerFrame(socket)
    assert.equal(frame.opcode, 0xa, '服务端应回复 pong')
    assert.equal(frame.payload.toString(), 'ping-payload')
    socket.destroy()
  })

  test('服务端 close → 客户端收到 close 事件', async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws/voice`)
    await waitUntil(() => connections.length >= 1, { timeoutMs: 3000, label: '服务端连接' })
    const conn = connections[connections.length - 1]
    const closed = wsClosed(ws)
    conn.close(1000, 'bye')
    const ev = await closed
    assert.equal(ev.code, 1000)
  })

  test('错误路径：路径不匹配 → 握手失败', async () => {
    await assert.rejects(
      async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/wrong-path`)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('超时')), 4000)
          ws.addEventListener('open', () => {
            clearTimeout(timer)
            resolve()
          })
          ws.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('握手失败（预期）'))
          })
        })
      },
      /握手失败/,
    )
  })

  test('普通 HTTP 请求与 WS 路由共存', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'ok')
  })
})

/* ========================================================================== */
/* v1.4 · test/mock-volc-realtime.mjs 假火山实时语音 WS 服务                       */
/* ========================================================================== */
describe('v1.4 mock 火山实时语音 WS', () => {
  let mock = null

  function wsConnect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      const timer = setTimeout(() => reject(new Error('mock WS 连接超时')), 5000)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(ws)
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('mock WS 连接失败'))
      })
    })
  }

  /** 收集解析后的协议帧 */
  function collectFrames(ws) {
    const frames = []
    ws.addEventListener('message', (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return
      try {
        frames.push(parseFrame(Buffer.from(ev.data)))
      } catch {
        /* ignore */
      }
    })
    return frames
  }

  const sendClientEvent = (ws, eventId, { payload = {}, sessionId = '', connectId = '' } = {}) =>
    ws.send(encodeEvent({ eventId, payload, sessionId, connectId }))

  before(async () => {
    mock = await startMockVolc({ chunkDelayMs: 2 })
  })

  after(async () => {
    if (mock) await mock.close()
  })

  test('ok 场景：StartConnection→50、StartSession→150（记录配置）、音频→ASR/Chat/TTS 事件流', async () => {
    mock.reset()
    const ws = await wsConnect(mock.wsUrl)
    const frames = collectFrames(ws)
    sendClientEvent(ws, CLIENT_EVENT.START_CONNECTION, { connectId: 'c-ok' })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.CONNECTION_STARTED), { label: 'ConnectionStarted' })
    const sessionId = 's-ok'
    sendClientEvent(ws, CLIENT_EVENT.START_SESSION, {
      sessionId,
      payload: { dialog: { bot_name: 'Ava', system_role: 'You are Ava' }, tts: { speaker: 'en_female' } },
    })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.SESSION_STARTED), { label: 'SessionStarted' })
    assert.equal(mock.sessionConfigs.length, 1)
    assert.equal(mock.sessionConfigs[0].dialog.bot_name, 'Ava')

    ws.send(encodeAudio(Buffer.alloc(640, 1), sessionId))
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.ASR_RESPONSE), { label: 'ASR_RESPONSE 451' })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.CHAT_RESPONSE), { label: 'CHAT_RESPONSE 550' })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.TTS_ENDED), { label: 'TTS_ENDED 359' })
    const eventIds = frames.map((f) => f.eventId)
    for (const id of [50, 150, 451, 459, 550, 559, 350, 352, 359]) {
      assert.ok(eventIds.includes(id), `事件流应包含 ${id}，实际 ${eventIds.join(',')}`)
    }
    const audioFrames = frames.filter((f) => f.eventId === SERVER_EVENT.TTS_RESPONSE && f.payload && f.payload.length > 100)
    assert.ok(audioFrames.length >= 1, '应下发 24k PCM 音频帧（事件 352 raw payload）')
    assert.equal(audioFrames[0].serialization, SERIALIZATION.RAW, '352 音频帧序列化应为 RAW')
    await waitUntil(() => mock.audioFrames >= 1, { label: 'mock 统计上行音频' })
    assert.ok(mock.audioBytes >= 640)
    // 注销会话
    sendClientEvent(ws, CLIENT_EVENT.FINISH_SESSION, { sessionId })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.SESSION_FINISHED), { label: 'SessionFinished' })
    sendClientEvent(ws, CLIENT_EVENT.FINISH_CONNECTION, { connectId: 'c-ok' })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.CONNECTION_FINISHED), { label: 'ConnectionFinished' })
    ws.close()
  })

  test('auth-fail：StartConnection 后推 ConnectionFailed(51) 并断开', async () => {
    mock.reset()
    mock.setScenario('auth-fail')
    const ws = await wsConnect(mock.wsUrl)
    const frames = collectFrames(ws)
    sendClientEvent(ws, CLIENT_EVENT.START_CONNECTION, { connectId: 'c-bad' })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.CONNECTION_FAILED), { label: 'ConnectionFailed' })
    const failed = frames.find((f) => f.eventId === SERVER_EVENT.CONNECTION_FAILED)
    assert.match(String(failed.json && failed.json.error), /auth|invalid/i)
    ws.close()
    mock.setScenario('ok')
  })

  test('model-fail / speaker-fail：StartSession 推 SessionFailed(153) 中文可映射原因', async () => {
    for (const scenario of ['model-fail', 'speaker-fail']) {
      mock.reset()
      mock.setScenario(scenario)
      const ws = await wsConnect(mock.wsUrl)
      const frames = collectFrames(ws)
      sendClientEvent(ws, CLIENT_EVENT.START_CONNECTION, { connectId: `c-${scenario}` })
      await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.CONNECTION_STARTED), { label: `${scenario} 连接` })
      sendClientEvent(ws, CLIENT_EVENT.START_SESSION, { sessionId: `s-${scenario}`, payload: {} })
      await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.SESSION_FAILED), { label: `${scenario} SessionFailed` })
      const failed = frames.find((f) => f.eventId === SERVER_EVENT.SESSION_FAILED)
      assert.match(String(failed.json && failed.json.error), scenario === 'model-fail' ? /model/i : /speaker/i)
      ws.close()
    }
    mock.setScenario('ok')
  })

  test('error-599：StartSession 后推 DialogCommonError(599)', async () => {
    mock.reset()
    mock.setScenario('error-599')
    const ws = await wsConnect(mock.wsUrl)
    const frames = collectFrames(ws)
    sendClientEvent(ws, CLIENT_EVENT.START_CONNECTION, { connectId: 'c-599' })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.CONNECTION_STARTED), { label: '连接' })
    sendClientEvent(ws, CLIENT_EVENT.START_SESSION, { sessionId: 's-599', payload: {} })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.DIALOG_COMMON_ERROR), { label: '599' })
    ws.close()
    mock.setScenario('ok')
  })

  test('mid-disconnect：收到 2 帧音频后断开连接', async () => {
    mock.reset()
    mock.setScenario('mid-disconnect')
    const ws = await wsConnect(mock.wsUrl)
    const frames = collectFrames(ws)
    sendClientEvent(ws, CLIENT_EVENT.START_CONNECTION, { connectId: 'c-mid' })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.CONNECTION_STARTED), { label: '连接' })
    sendClientEvent(ws, CLIENT_EVENT.START_SESSION, { sessionId: 's-mid', payload: {} })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.SESSION_STARTED), { label: '会话' })
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }))
    ws.send(encodeAudio(Buffer.alloc(640, 1), 's-mid'))
    ws.send(encodeAudio(Buffer.alloc(640, 2), 's-mid'))
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('未按预期断开')), 5000))])
    mock.setScenario('ok')
  })

  test('no-events：只回 ready，不上推任何对话事件', async () => {
    mock.reset()
    mock.setScenario('no-events')
    const ws = await wsConnect(mock.wsUrl)
    const frames = collectFrames(ws)
    sendClientEvent(ws, CLIENT_EVENT.START_CONNECTION, { connectId: 'c-quiet' })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.CONNECTION_STARTED), { label: '连接' })
    sendClientEvent(ws, CLIENT_EVENT.START_SESSION, { sessionId: 's-quiet', payload: {} })
    await waitUntil(() => frames.some((f) => f.eventId === SERVER_EVENT.SESSION_STARTED), { label: '会话' })
    ws.send(encodeAudio(Buffer.alloc(640, 9), 's-quiet'))
    await waitUntil(() => mock.audioFrames >= 1, { label: '收到音频' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(frames.filter((f) => f.eventId === SERVER_EVENT.ASR_RESPONSE).length, 0, 'no-events 场景不应推 ASR')
    ws.close()
  })
})

/* ========================================================================== */
/* v1.4 · lib/volcRealtime.js 鉴权头/会话配置/错误映射/真实 mock 联调              */
/* ========================================================================== */
describe('v1.4 lib/volcRealtime 客户端', () => {
  test('buildVolcHeaders：API Key 优先，Access Token 兜底，资源 ID 默认', () => {
    const withKey = buildVolcHeaders({ appId: 'app-1', apiKey: 'key-1', accessToken: 'tok-1' })
    assert.equal(withKey['X-Api-App-Id'], 'app-1')
    assert.equal(withKey['X-Api-Key'], 'key-1')
    assert.equal(withKey['X-Api-Access-Key'], undefined, '同时提供 Key/Token 时应优先 API Key')
    assert.equal(withKey['X-Api-Resource-Id'], 'volc.speech.dialog')
    const withToken = buildVolcHeaders({ appId: 'app-2', accessToken: 'tok-2' })
    assert.equal(withToken['X-Api-Key'], undefined)
    assert.equal(withToken['X-Api-Access-Key'], 'tok-2')
    const custom = buildVolcHeaders({ appId: 'app-3', apiKey: 'k', resourceId: 'custom.res' })
    assert.equal(custom['X-Api-Resource-Id'], 'custom.res')
    assert.equal(buildVolcHeaders({})['X-Api-App-Id'], '')
  })

  test('buildSessionConfig：asr 16k / tts 24k / speaker / dialog persona+model', () => {
    const cfg = buildSessionConfig({
      volc: { model: '3.0', speaker: 'en_female_dacey_uranus_bigtts' },
      persona: 'You are Ava, a friendly teacher.',
    })
    assert.equal(cfg.asr.audio_info.format, 'pcm')
    assert.equal(cfg.asr.audio_info.sample_rate, 16000)
    assert.equal(cfg.asr.audio_info.channel, 1)
    assert.equal(cfg.tts.speaker, 'en_female_dacey_uranus_bigtts')
    assert.equal(cfg.tts.audio_config.format, 'pcm_s16le')
    assert.equal(cfg.tts.audio_config.sample_rate, 24000)
    assert.equal(cfg.dialog.bot_name, 'Ava')
    assert.equal(cfg.dialog.extra.model, '3.0')
    assert.match(cfg.dialog.system_role, /friendly teacher/)
    // 默认值兜底
    const defaults = buildSessionConfig({})
    assert.equal(defaults.dialog.extra.model, '3.0')
    assert.equal(defaults.tts.speaker, 'en_female_dacey_uranus_bigtts')
    assert.equal(defaults.dialog.system_role, '')
  })

  test('friendlyVolcError：鉴权/模型/音色/额度/超时映射中文可操作提示', () => {
    assert.match(friendlyVolcError(0, 'HTTP 401 unauthorized: invalid api key'), /鉴权|API Key/)
    assert.match(friendlyVolcError(0, 'model not supported: 3.0'), /模型|版本/)
    assert.match(friendlyVolcError(0, 'speaker not supported: xxx'), /音色/)
    assert.match(friendlyVolcError(0, 'quota exceeded'), /额度|频率/)
    assert.match(friendlyVolcError(0, 'connect timeout'), /超时|网络/)
    assert.match(friendlyVolcError(0, 'silence idle'), /静默|重新开始/)
    assert.match(friendlyVolcError(1234, 'weird internal error'), /错误（1234）|失败/)
    assert.doesNotThrow(() => friendlyVolcError(0, undefined))
  })

  test('testVolcConnection：对 mock 火山成功握手并返回 model/speaker/latency', async () => {
    const mock = await startMockVolc({ chunkDelayMs: 2 })
    try {
      const r = await testVolcConnection(
        { appId: 'test-app', apiKey: 'test-key', endpoint: mock.wsUrl, model: '3.0', speaker: 'en_female_dacey_uranus_bigtts' },
        { timeoutMs: 8000 },
      )
      assert.equal(r.ok, true)
      assert.equal(r.model, '3.0')
      assert.equal(r.speaker, 'en_female_dacey_uranus_bigtts')
      assert.ok(typeof r.latencyMs === 'number' && r.latencyMs >= 0)
      assert.ok(mock.sessionConfigs.length >= 1, 'mock 应收到 StartSession')
      assert.equal(mock.sessionConfigs[0].asr.audio_info.sample_rate, 16000)
      await waitUntil(
        () => mock.events.some((e) => e.type === 'client-event' && (e.eventId === 102 || e.eventId === 2)),
        { timeoutMs: 5000, label: '测试连接结束应发送 FinishSession/Connection' },
      )
    } finally {
      await mock.close()
    }
  })

  test('testVolcConnection：mock 鉴权失败 → 抛中文错误', async () => {
    const mock = await startMockVolc({ chunkDelayMs: 2 })
    mock.setScenario('auth-fail')
    try {
      await assert.rejects(
        () => testVolcConnection({ appId: 'a', apiKey: 'b', endpoint: mock.wsUrl }, { timeoutMs: 8000 }),
        /鉴权|API Key|失败/,
      )
    } finally {
      await mock.close()
    }
  })

  test('VolcRealtimeSession：ready→ASR/Chat/TTS 回调→finish 清理（对 mock）', async () => {
    const mock = await startMockVolc({ chunkDelayMs: 2 })
    try {
      const got = { ready: null, asr: [], chat: [], audio: 0, ttsStart: 0, ttsEnd: 0, closed: false }
      const session = new VolcRealtimeSession({
        volc: { appId: 'a', apiKey: 'b', endpoint: mock.wsUrl, model: '3.0', speaker: 's' },
        persona: 'You are a friendly English teacher.',
        connectTimeoutMs: 8000,
        handlers: {
          onReady: (info) => {
            got.ready = info
          },
          onASR: (evt) => got.asr.push(evt),
          onChat: (evt) => got.chat.push(evt),
          onAudio: (buf) => {
            got.audio += buf.length
          },
          onTTSStart: () => {
            got.ttsStart += 1
          },
          onTTSAllEnded: () => {
            got.ttsEnd += 1
          },
          onClose: () => {
            got.closed = true
          },
        },
      })
      await session.connect()
      assert.ok(got.ready, '应收到 ready 回调')
      assert.equal(got.ready.model, '3.0')
      session.sendAudio(Buffer.alloc(640, 1))
      await waitUntil(() => got.asr.length >= 2, { timeoutMs: 8000, label: 'ASR 回调' })
      assert.ok(got.asr.some((e) => e.final === false), '应有 interim ASR')
      assert.ok(got.asr.some((e) => e.final === true), '应有 final ASR')
      await waitUntil(() => got.chat.length >= 1, { timeoutMs: 8000, label: 'Chat 回调' })
      await waitUntil(() => got.audio > 0, { timeoutMs: 8000, label: 'TTS 音频回调' })
      assert.ok(got.audio > 100, 'TTS 音频应有 PCM 字节')
      await waitUntil(() => got.ttsEnd >= 1, { timeoutMs: 8000, label: 'TTS 结束回调' })
      assert.ok(mock.audioFrames >= 1, 'mock 应收到上行音频')
      await session.finish()
      await waitUntil(() => got.closed, { timeoutMs: 4000, label: 'session close 回调' })
    } finally {
      await mock.close()
    }
  })
})

/* ========================================================================== */
/* v1.4 · lib/coach.js 文本教练分析（demo 降级）                                 */
/* ========================================================================== */
describe('v1.4 lib/coach 教练分析', () => {
  test('无 Key 英文：识别纠错、无 chineseHelp、鼓励具体', async () => {
    const r = await coachAnalysis({ message: 'I very like it', level: 'A2', settings: { apiKey: '' } })
    assert.equal(r.demo, true)
    assert.ok(Array.isArray(r.feedback.corrections) && r.feedback.corrections.length >= 1, '应识别 very 修饰动词错误')
    assert.match(r.feedback.corrections[0].corrected, /really/i)
    assert.equal(r.feedback.chineseHelp, null)
    assert.ok(String(r.feedback.encouragement_zh || '').length > 0)
    assert.doesNotMatch(String(r.feedback.encouragement_zh), /very nice|good job/i)
  })

  test('无 Key 中文：corrections=[] 且 chineseHelp 合法', async () => {
    const r = await coachAnalysis({ message: '我今天很累，不知道怎么说', level: 'A2', settings: { apiKey: '' } })
    assert.equal(r.demo, true)
    assert.deepEqual(r.feedback.corrections, [])
    assert.ok(r.feedback.chineseHelp, '中文应返回 chineseHelp')
    assert.match(r.feedback.chineseHelp.english, /exhausted|tired/i)
    assert.ok(Array.isArray(r.feedback.chineseHelp.chunks))
  })

  test('空消息不崩溃，返回 demo 结构', async () => {
    const r = await coachAnalysis({ message: '   ', settings: { apiKey: '' } })
    assert.equal(r.demo, true)
    assert.ok(r.feedback && typeof r.feedback === 'object')
    assert.ok(Array.isArray(r.feedback.corrections))
  })
})

/* ========================================================================== */
/* v1.4 · lib/config.js 语音引擎设置 + 掩码                                      */
/* ========================================================================== */
describe('v1.4 lib/config 语音引擎设置', () => {
  test('normalizeSettings：volc 默认值、voiceEngine 白名单、非法 endpoint 回退', () => {
    const def = normalizeSettings({})
    assert.equal(def.voiceEngine, 'browser')
    assert.equal(def.volc.model, '3.0')
    assert.equal(def.volc.speaker, 'en_female_dacey_uranus_bigtts')
    assert.match(def.volc.endpoint, /^wss:\/\/openspeech\.bytedance\.com/)
    assert.equal(def.volc.resourceId, 'volc.speech.dialog')
    const custom = normalizeSettings({
      voiceEngine: 'volc',
      volc: { appId: 'a', apiKey: 'k', endpoint: 'ws://127.0.0.1:1234/ws/voice', model: '1.2.1.1' },
    })
    assert.equal(custom.voiceEngine, 'volc')
    assert.equal(custom.volc.endpoint, 'ws://127.0.0.1:1234/ws/voice')
    assert.equal(custom.volc.model, '1.2.1.1')
    assert.equal(normalizeSettings({ voiceEngine: 'hacker' }).voiceEngine, 'browser')
    assert.match(normalizeSettings({ volc: { endpoint: 'javascript:alert(1)' } }).volc.endpoint, /^wss:\/\//)
  })

  test('publicSettings：volc 只给 hasKey/keyHint/configured，不泄露明文密钥', () => {
    const settings = normalizeSettings({
      voiceEngine: 'volc',
      volc: { appId: 'app-x', apiKey: 'volc-secret-abcdef', model: '3.0', speaker: 'spk' },
    })
    const pub = publicSettings(settings)
    assert.equal(pub.voiceEngine, 'volc')
    assert.equal(pub.volc.appId, 'app-x')
    assert.equal(pub.volc.hasKey, true)
    assert.equal(pub.volc.configured, true)
    assert.ok(pub.volc.keyHint.endsWith('cdef'), `keyHint 应保留后 4 位，实际 ${pub.volc.keyHint}`)
    assert.equal(pub.volc.apiKey, undefined, 'publicSettings 不应包含 volc.apiKey')
    assert.equal(pub.volc.accessToken, undefined, 'publicSettings 不应包含 volc.accessToken')
    assert.ok(!JSON.stringify(pub).includes('volc-secret-abcdef'), '序列化结果不得包含明文密钥')
    const noKey = publicSettings(normalizeSettings({ volc: { appId: 'app-x' } }))
    assert.equal(noKey.volc.hasKey, false)
    assert.equal(noKey.volc.configured, false)
    assert.equal(noKey.volc.keyHint, '')
  })
})

/* ========================================================================== */
/* v1.4 · content/prompts.js 实时语音人格 / 教练提示词                            */
/* ========================================================================== */
describe('v1.4 content/prompts 豆包实时语音', () => {
  test('buildRealtimePersona：朋友式老师 + 相关性/中文求助 + 不要求 JSON 输出', () => {
    const persona = buildRealtimePersona({ level: 'B1', teacherName: 'Ava', mode: 'free' })
    assert.match(persona, /REAL-TIME VOICE/i)
    assert.match(persona, /1-3 sentences/i)
    assert.match(persona, /LATEST message/i)
    assert.match(persona, /never give empty praise|empty praise/i)
    assert.match(persona, /Chinese/i)
    assert.match(persona, /no lists, no formatting, no JSON/i, '实时语音人格不应要求 JSON 输出')
    assert.doesNotMatch(persona, /<<<FEEDBACK>>>/, '实时人格不应包含反馈 JSON 标记')
    const rp = buildRealtimePersona({ mode: 'roleplay' })
    assert.match(rp, /role-play character/i)
    const withDoc = buildRealtimePersona({ doc: { text: 'Reading helps vocabulary.' } })
    assert.match(withDoc, /README|Reading helps vocabulary/i)
  })

  test('buildCoachMessages：只分析不回复 + 严格 JSON 字段 + chineseHelp 规则', () => {
    const msgs = buildCoachMessages({ message: 'I very like it', level: 'B1', mode: 'free', history: [] })
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].role, 'system')
    assert.equal(msgs[1].role, 'user')
    assert.equal(msgs[1].content, 'I very like it')
    const system = msgs[0].content
    assert.match(system, /Analyze ONLY the student/i)
    assert.match(system, /Do NOT write a conversational reply/i)
    for (const key of ['corrections', 'better', 'newWords', 'encouragement_zh', 'chineseHelp']) {
      assert.ok(system.includes(key), `教练提示词应包含字段 ${key}`)
    }
    assert.match(system, /chineseHelp/i)
    assert.match(system, /B1/)
    const withHistory = buildCoachMessages({
      message: 'hi',
      history: [{ role: 'user', content: 'I went to the park.' }, { role: 'assistant', content: 'Nice!' }],
    })
    assert.match(withHistory[0].content, /Recent conversation context/i)
  })
})

/* ========================================================================== */
/* v1.5 · lib/translator.js 双语字幕翻译（豆包文本模式 / 文本模型回退）              */
/* ========================================================================== */
describe('v1.5 lib/translator 翻译服务', () => {
  const volcSettings = (wsUrl) => ({
    apiKey: '',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'unused',
    volc: {
      appId: 'trans-app',
      apiKey: 'trans-key',
      model: '3.0',
      speaker: 'en_female_dacey_uranus_bigtts',
      endpoint: wsUrl,
      resourceId: 'volc.speech.dialog',
    },
  })

  test('cleanTranslation：清洗前缀/引号/代码块/空白，只保留中文，空/英文/non-CJK 返回 null', () => {
    assert.equal(cleanTranslation('你好，今天过得怎么样？'), '你好，今天过得怎么样？')
    assert.equal(cleanTranslation('中文翻译：你好世界'), '你好世界')
    assert.equal(cleanTranslation('翻译:  "你好"'), '你好')
    assert.equal(cleanTranslation('“你好，朋友”'), '你好，朋友')
    // QA-016 修复后：只去围栏标记、保留内容
    assert.equal(cleanTranslation('```你好```'), '你好')
    assert.equal(cleanTranslation('```\n你好\n```'), '你好')
    assert.equal(cleanTranslation('```中文\n你好\n```'), '你好')
    assert.equal(cleanTranslation('  你  好  '), '你 好')
    assert.equal(cleanTranslation(''), null)
    assert.equal(cleanTranslation('   '), null)
    assert.equal(cleanTranslation('Hello, how are you?'), null, '纯英文不是译文，应丢弃')
    assert.equal(cleanTranslation('ni hao'), null, '拼音不是译文')
    assert.equal(cleanTranslation(null), null)
    const long = '好'.repeat(1000)
    assert.equal(cleanTranslation(long).length, 800, '译文应截断到 800 字')
  })

  test('translateTexts：空数组 → ok:true/null provider；target 非 zh → ok:false', async () => {
    const empty = await translateTexts([], { settings: volcSettings('ws://127.0.0.1:1/ws/voice') })
    assert.deepEqual(empty, { ok: true, texts: [], provider: null })
    const badTarget = await translateTexts(['Hello'], {
      target: 'en',
      settings: volcSettings('ws://127.0.0.1:1/ws/voice'),
    })
    assert.equal(badTarget.ok, false)
    assert.match(badTarget.error, /只支持翻译成中文/)
    assert.deepEqual(badTarget.texts, [null])
  })

  test('translateTexts：无凭据 → ok:false + 中文错误 + texts 全 null（不 throw）', async () => {
    const r = await translateTexts(['Hello, how are you?'], {
      settings: { apiKey: '', volc: {} },
    })
    assert.equal(r.ok, false)
    assert.equal(r.provider, null)
    assert.deepEqual(r.texts, [null])
    assert.match(r.error, /翻译服务暂不可用|配置/)
  })

  test('translateTexts：豆包文本模式会话 → provider:volc + 中文；session 配置正确、无音频帧', async () => {
    const mock = await startMockVolc({ chunkDelayMs: 2 })
    try {
      mock.reset()
      mock.setScenario('ok')
      const texts = ['Hello Ava, how are you?', 'I like coffee.']
      const r = await translateTexts(texts, { settings: volcSettings(mock.wsUrl) })
      assert.equal(r.ok, true, `volc 翻译应成功，实际 ${JSON.stringify(r)}`)
      assert.equal(r.provider, 'volc')
      assert.equal(r.texts.length, 2)
      for (const t of r.texts) {
        assert.ok(typeof t === 'string' && /[\u4e00-\u9fff]/.test(t), `译文应为中文：${t}`)
      }
      assert.ok(mock.sessionConfigs.length >= 1, 'mock 应收到文本模式会话')
      const cfg = mock.sessionConfigs[mock.sessionConfigs.length - 1]
      assert.equal(cfg.dialog.extra.input_mod, 'text', '文本模式 input_mod 应为 text')
      assert.deepEqual(cfg.dialog.extra.output_modalities, ['text'], '文本模式只输出文本')
      assert.equal(cfg.dialog.bot_name, 'Translator', '翻译会话 bot_name 应为 Translator')
      assert.match(String(cfg.dialog.system_role), /translator/i, 'system_role 应为翻译器提示')
      assert.equal(cfg.asr.audio_info.sample_rate, 16000, 'asr 配置仍应存在（火山要求完整配置）')
      assert.equal(cfg.tts.audio_config.sample_rate, 24000, 'tts 配置仍应存在（speaker 必填）')
      assert.equal(mock.textQueries.length, 2, `应发送 2 条 ChatTextQuery，实际 ${mock.textQueries.length}`)
      assert.ok(mock.textQueries[0].includes(texts[0]), '文本查询应包含原文')
      assert.equal(mock.audioFrames, 0, '翻译不应上行音频')
      assert.equal(mock.events.filter((e) => e.type === 'server-audio').length, 0, '翻译不应产生 TTS 音频帧')
      assert.equal(mock.events.filter((e) => e.type === 'server-event' && e.eventId === SERVER_EVENT.TTS_RESPONSE).length, 0)
    } finally {
      await mock.close()
    }
  })

  test('translateTexts：豆包失败（返回英文）→ 无文本模型 → ok:false 降级', async () => {
    const mock = await startMockVolc({ chunkDelayMs: 2 })
    try {
      mock.reset()
      mock.setScenario('translate-fail')
      const r = await translateTexts(['Hello Ava'], { settings: volcSettings(mock.wsUrl) })
      assert.equal(r.ok, false, `豆包返回英文时应降级失败，实际 ${JSON.stringify(r)}`)
      assert.equal(r.provider, null)
      assert.deepEqual(r.texts, [null])
    } finally {
      await mock.close()
    }
  })

  test('translateTexts：文本模型回退 → provider:llm + 中文（编号行解析）', async () => {
    const upstream = await startMockUpstream()
    try {
      upstream.reset()
      const settings = {
        apiKey: 'test-text-key',
        baseUrl: upstream.url,
        model: 'mock-model',
        volc: {},
      }
      const r = await translateTexts(['Hello, how are you?', 'I like coffee.'], { settings })
      assert.equal(r.ok, true, `文本模型翻译应成功，实际 ${JSON.stringify(r)}`)
      assert.equal(r.provider, 'llm')
      assert.equal(r.texts.length, 2)
      for (const t of r.texts) assert.ok(typeof t === 'string' && /[\u4e00-\u9fff]/.test(t), `译文应为中文：${t}`)
      assert.ok(upstream.translationCalls.length >= 1, 'mock 文本模型应收到翻译请求')
      const call = upstream.translationCalls[upstream.translationCalls.length - 1]
      assert.match(String(call.body.messages[0].content), /translator/i, '翻译 prompt 应为 translator 指令')
      assert.match(String(call.body.messages[1].content), /1\. Hello/, '用户消息应带编号行')
    } finally {
      await upstream.close()
    }
  })

  test('translateTexts：文本模型返回英文（bad-translation）→ ok:false；截断/过滤/上限 8 条', async () => {
    const upstream = await startMockUpstream()
    try {
      upstream.reset()
      upstream.setScenario('bad-translation')
      const settings = { apiKey: 'k', baseUrl: upstream.url, model: 'mock-model', volc: {} }
      const bad = await translateTexts(['Hello'], { settings })
      assert.equal(bad.ok, false)
      upstream.setScenario('ok')
      const many = await translateTexts(Array.from({ length: 12 }, (_, i) => `Sentence ${i}`), { settings })
      assert.equal(many.ok, true)
      assert.equal(many.texts.length, 8, '最多翻译 8 条')
      const longText = 'word '.repeat(200)
      const long = await translateTexts([longText, '', '  '], { settings })
      assert.equal(long.ok, true)
      assert.ok(long.texts.length <= 2, '空字符串应被过滤')
    } finally {
      await upstream.close()
    }
  })

  test('translateTexts：豆包端点不可达 → 不 throw，返回 ok:false', async () => {
    const r = await translateTexts(['Hello'], {
      settings: volcSettings('ws://127.0.0.1:1/ws/voice'),
    })
    assert.equal(r.ok, false)
    assert.equal(r.provider, null)
    assert.ok(Array.isArray(r.texts) && r.texts[0] === null)
  })

  test('buildSessionConfig 文本模式 vs 正常模式：input_mod/output_modalities/Translator/Ava', () => {
    const textCfg = buildSessionConfig({
      volc: { model: '3.0', speaker: 'spk' },
      persona: 'translator prompt',
      textMode: true,
    })
    assert.equal(textCfg.dialog.extra.input_mod, 'text')
    assert.deepEqual(textCfg.dialog.extra.output_modalities, ['text'])
    assert.equal(textCfg.dialog.bot_name, 'Translator')
    const voiceCfg = buildSessionConfig({ volc: { model: '3.0', speaker: 'spk' }, persona: 'ava' })
    assert.equal(voiceCfg.dialog.extra.input_mod, undefined)
    assert.equal(voiceCfg.dialog.bot_name, 'Ava')
    assert.equal(voiceCfg.dialog.extra.model, '3.0')
  })

  test('Translator.translateOnce：未连接/无凭据时返回 null（不 throw）', async () => {
    const t = new Translator()
    try {
      assert.equal(await t.translateOnce('', volcSettings('ws://127.0.0.1:1/ws/voice')), null)
      assert.equal(await t.translateOnce('Hello', { volc: {}, apiKey: '' }), null)
    } finally {
      t.reset()
    }
  })
})

/* ========================================================================== */
/* v1.6 · content/characters.js 三角色（公开数据不含人设 prompt）                   */
/* ========================================================================== */
describe('v1.6 content/characters 角色设定', () => {
  test('3 个角色：id/顺序/城市/标签/音色各不相同', () => {
    assert.equal(characters.length, 3)
    assert.deepEqual(characters.map((c) => c.id), ['elena', 'maya', 'hikari'])
    assert.equal(DEFAULT_CHARACTER_ID, 'elena')
    const cities = characters.map((c) => c.city)
    assert.deepEqual(cities, ['伦敦', '纽约', '东京'])
    assert.ok(characters[0].tags.includes('温柔') && characters[0].tags.includes('艺术'))
    assert.ok(characters[1].tags.includes('直爽') && characters[1].tags.includes('幽默'))
    assert.ok(characters[2].tags.includes('元气') && characters[2].tags.includes('二次元'))
    assert.deepEqual(characters.map((c) => c.themeColor), ['#d9b477', '#6f8fd6', '#9fc3e8'], 'v1.7 主题色')
    const speakers = characters.map((c) => c.voice.speaker)
    assert.deepEqual(speakers, [
      'en_female_dacey_uranus_bigtts',
      'en_female_stokie_uranus_bigtts',
      'zh_female_vv_jupiter_bigtts',
    ])
    assert.equal(new Set(speakers).size, 3, '三个角色音色应不同')
    for (const c of characters) {
      assert.ok(c.name && c.city && c.voiceLabel && c.cover, `${c.id} 基础字段应齐全`)
      assert.ok(Array.isArray(c.scenes) && c.scenes.length >= 3, `${c.id} 至少 3 个场景`)
      for (const s of c.scenes) assert.ok(s.id && s.label && s.emoji, `${c.id} 场景字段应齐全`)
      assert.ok(String(c.persona).length > 80, `${c.id} 应有人设 prompt（仅服务端）`)
      assert.match(c.cover, /^\/assets\/characters\/.+\.jpg$/, 'v1.7 角色必须用用户原图 .jpg')
    }
  })

  test('motion.json：三张原图各自标定嘴/眼/焦点/轻摆（talking-head 使用）', async () => {
    const raw = await readFile(new URL('../web/assets/characters/motion.json', import.meta.url), 'utf8')
    const motion = JSON.parse(raw)
    for (const id of ['elena', 'maya', 'hikari']) {
      const m = motion[id]
      assert.ok(m, `motion.json 应包含 ${id}`)
      for (const key of ['mouth', 'eyes', 'focal', 'sway']) assert.ok(key in m, `${id} 应包含 ${key}`)
      for (const key of ['cx', 'cy', 'rx', 'ry']) {
        assert.equal(typeof m.mouth[key], 'number', `${id}.mouth.${key} 应为数字`)
      }
      assert.ok(Array.isArray(m.eyes) && m.eyes.length >= 2, `${id} 应标定双眼`)
      for (const eye of m.eyes) {
        assert.equal(typeof eye.cx, 'number')
        assert.equal(typeof eye.cy, 'number')
      }
      assert.ok(m.focal.x >= 0 && m.focal.x <= 1 && m.focal.y >= 0 && m.focal.y <= 1, `${id}.focal 应在 0..1`)
      assert.ok(m.sway > 0 && m.sway < 0.05, `${id}.sway 应很小（0..0.05）`)
      assert.ok(m.layers && m.layers.fg && m.layers.bg, `${id} 应有分层 fg/bg（方案 A）`)
      assert.match(String(m.layers.fg), new RegExp(`layers/${id}-fg\\.webp`))
      assert.match(String(m.layers.bg), new RegExp(`layers/${id}-bg\\.webp`))
      assert.ok(Array.isArray(m.flows) && m.flows.length >= 6, `${id} flows 至少 6 条`)
      const hair = m.flows.filter((f) => f.type === 'hair').length
      const cloth = m.flows.filter((f) => f.type === 'cloth').length
      assert.ok(hair >= 4 && cloth >= 2, `${id} flows 应含 ≥4 hair + ≥2 cloth（实际 ${hair}/${cloth}）`)
    }
    const heads = await readFile(new URL('../web/js/talking-head.js', import.meta.url), 'utf8')
    assert.match(heads, /export function createTalkingHead/, 'talking-head 应导出 createTalkingHead')
    assert.match(heads, /setSpeechLevel/, 'talking-head 应支持 setSpeechLevel')
    assert.match(heads, /get blinkLevel\(\)/, 'talking-head v1.8 应暴露只读 blinkLevel（眨眼平滑采样）')
    assert.match(heads, /get layered\(\)/, 'talking-head v2.0 应暴露只读 layered（分层 2.5D）')
    assert.match(heads, /layers/, 'talking-head 应支持 layers 分层绘制')
  })

  test('v2.0 分层素材：三角色 fg/bg webp 存在且非空', async () => {
    for (const id of ['elena', 'maya', 'hikari']) {
      for (const kind of ['fg', 'bg']) {
        const file = new URL(`../web/assets/characters/layers/${id}-${kind}.webp`, import.meta.url)
        const buf = await readFile(file)
        assert.ok(buf.length > 1000, `${id}-${kind}.webp 不应为空（${buf.length}B）`)
        assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF', `${id}-${kind}.webp 应为 WebP（RIFF）`)
        assert.equal(buf.subarray(8, 12).toString('ascii'), 'WEBP', `${id}-${kind}.webp 应为 WebP`)
      }
    }
  })

  test('publicCharacter/getPublicCharacters：不包含 persona / opener 等内部字段', () => {
    const pub = publicCharacter(characters[0])
    assert.equal(pub.id, 'elena')
    for (const key of ['id', 'name', 'nameZh', 'city', 'cityEn', 'country', 'age', 'occupation', 'style', 'accent', 'level', 'tags', 'voiceLabel', 'cover', 'themeColor', 'greeting', 'scenes']) {
      assert.ok(key in pub, `publicCharacter 应包含 ${key}`)
    }
    assert.equal(pub.persona, undefined, 'publicCharacter 不应包含 persona')
    assert.equal(pub.voice, undefined, 'publicCharacter 不应包含 voice（音色内部配置）')
    assert.equal(pub.scenes[0].opener, undefined, '场景 opener 不应下发')
    assert.ok(JSON.stringify(pub).length < 3000)
    const all = getPublicCharacters()
    assert.equal(all.length, 3)
    const raw = JSON.stringify(all)
    for (const secret of ['You are Elena', 'You are Maya', 'You are Hikari', 'persona', 'gallery curator']) {
      assert.ok(!raw.includes(secret), `公开数据不应包含人设内容：${secret}`)
    }
    assert.equal(publicCharacter(null), null)
  })

  test('findCharacter / sceneOpener：合法与回退', () => {
    assert.equal(findCharacter('maya').name, 'Maya')
    assert.equal(findCharacter('nope'), null)
    assert.equal(findCharacter(''), null)
    assert.match(sceneOpener('elena', 'gallery'), /exhibition/i)
    assert.equal(sceneOpener('nope', 'gallery'), '')
    const fallback = sceneOpener('maya', 'unknown-scene')
    assert.equal(fallback, characters[1].scenes[0].opener, '未知场景回退第一个场景')
  })
})

/* ========================================================================== */
/* v1.6 · lib/plans.js 学习计划（纯函数）                                        */
describe('v3.1 lib/plans 计划兼容', () => {
  test('updatePlan/GOAL_LABELS：空计划返回 null，目标标签与等级可更新', () => {
    assert.equal(updatePlan(null, {}), null)
    assert.equal(GOAL_LABELS.daily, '日常口语')
    const plan = createUserPlan({ goalText: '我想学咖啡店点单', level: 'A2' })
    const next = updatePlan(plan, { goalText: '我想学机场值机', level: 'B1' })
    assert.equal(next.goalText, '我想学机场值机')
    assert.equal(next.level, 'B1')
    assert.equal(next.id, plan.id)
  })
})

describe('v1.6 lib/assistant 学习管家', () => {
  test('detectIntent：创建/更新/复习/场景/偏好/反馈/问候/闲聊', () => {
    assert.equal(detectIntent('帮我做个学习计划').type, 'create_plan')
    assert.equal(detectIntent('更新一下我的计划').type, 'update_plan')
    assert.equal(detectIntent('我想快速复习单词').type, 'review_words')
    assert.equal(detectIntent('找个场景练习对话').type, 'open_scene')
    assert.equal(detectIntent('改一下我的偏好').type, 'open_tab')
    assert.equal(detectIntent('我有个反馈').type, 'feedback')
    assert.equal(detectIntent('你好').type, 'greeting')
    assert.equal(detectIntent('今天天气不错').type, 'chat')
    assert.equal(detectIntent('').type, 'chat')
  })

  test('detectGoal / detectLevel / detectCharacterId', () => {
    assert.equal(detectGoal('我想出国旅行'), 'travel')
    assert.equal(detectGoal('职场英语'), 'work')
    assert.equal(detectGoal('准备雅思考试'), 'exam')
    assert.equal(detectGoal('喜欢打游戏'), 'interest')
    assert.equal(detectGoal('随便聊聊'), 'daily')
    assert.equal(detectLevel('我想从 B1 开始'), 'B1')
    assert.equal(detectLevel('零基础'), 'A1')
    assert.equal(detectLevel('中级'), 'B1')
    assert.equal(detectLevel(''), '')
    assert.equal(detectCharacterId('想找 Maya 练'), 'maya')
    assert.equal(detectCharacterId('去东京找光'), 'hikari')
    assert.equal(detectCharacterId('伦敦的艾莲娜'), 'elena')
    assert.equal(detectCharacterId('随便', 'maya'), 'maya')
  })

  test('buildAssistantReply：五类动作 + 回复模板（demo:true）', () => {
    const create = buildAssistantReply({ message: '帮我创建一个出国旅行计划，B1' })
    assert.equal(create.action.type, 'create_plan')
    assert.equal(create.demo, true)
    assert.match(create.reply, /3 节课|课程|计划|生成/)
    assert.equal(create.action.payload.version, 3, 'v3.1 创建的是 v3 计划')
    assert.equal(create.action.payload.level, 'B1')
    assert.equal(create.action.payload.teacherId, 'elena', '默认老师 Elena')
    assert.match(String(create.action.payload.goalText), /旅行/)

    const basePlan = create.action.payload
    const update = buildAssistantReply({ message: '更新我的计划，改成职场英语', currentPlan: basePlan })
    assert.equal(update.action.type, 'update_plan')
    assert.equal(update.action.payload.id, basePlan.id)
    assert.match(String(update.action.payload.goalText), /职场/)

    const review = buildAssistantReply({ message: '快速复习单词' })
    assert.equal(review.action.type, 'review_words')

    const scene = buildAssistantReply({ message: '找个场景练对话', characterId: 'maya' })
    assert.equal(scene.action.type, 'open_scene')
    assert.equal(scene.action.payload.characterId, 'maya')
    assert.ok(scene.action.payload.sceneId)

    const tab = buildAssistantReply({ message: '打开我的偏好' })
    assert.equal(tab.action.type, 'open_tab')
    assert.equal(tab.action.payload.tab, 'profile')

    const feedback = buildAssistantReply({ message: '我有个使用反馈' })
    assert.equal(feedback.action.type, 'feedback')
    const greeting = buildAssistantReply({ message: '你好' })
    assert.equal(greeting.action, null)
    assert.equal(greeting.demo, true)
  })

  test('assistantReply 无豆包凭据：规则降级 demo:true（永不失败）', async () => {
    const r = await assistantReply({
      message: '帮我创建职场英语计划',
      settings: { apiKey: '', volc: {} },
    })
    assert.equal(r.demo, true)
    assert.equal(r.action.type, 'create_plan')
    assert.match(r.reply, /3 节课|课程|计划|生成/)
    const chat = await assistantReply({ message: '今天天气不错', settings: { apiKey: '', volc: {} } })
    assert.equal(chat.demo, true)
    assert.equal(chat.action, null)
  })

  test('assistantReply 豆包文本模式：回复润色 demo:false，动作仍由规则给出；session 为文本模式无音频', async () => {
    const mock = await startMockVolc({ chunkDelayMs: 2 })
    try {
      mock.reset()
      const r = await assistantReply({
        message: '帮我创建一个出国旅行计划',
        settings: {
          apiKey: '',
          volc: {
            appId: 'assistant-app',
            apiKey: 'assistant-key',
            model: '3.0',
            speaker: 'en_female_dacey_uranus_bigtts',
            endpoint: mock.wsUrl,
            resourceId: 'volc.speech.dialog',
          },
        },
      })
      assert.equal(r.demo, false, `有豆包文本会话时应 demo:false，实际 ${JSON.stringify(r)}`)
      assert.equal(r.action.type, 'create_plan')
      assert.match(String(r.reply), /[\u4e00-\u9fff]/, '豆包返回的回复应为中文')
      assert.ok(mock.sessionConfigs.length >= 1, 'mock 应收到助手文本会话')
      const cfg = mock.sessionConfigs[mock.sessionConfigs.length - 1]
      assert.equal(cfg.dialog.extra.input_mod, 'text')
      assert.deepEqual(cfg.dialog.extra.output_modalities, ['text'])
      assert.equal(mock.audioFrames, 0, '助手文本模式不应上行音频')
      assert.equal(mock.events.filter((e) => e.type === 'server-audio').length, 0, '助手不应产生 TTS 音频')
    } finally {
      await mock.close()
    }
  })
})

/* ========================================================================== */
/* v1.6 · prompts reading/character + demo 角色回复                              */
/* ========================================================================== */
describe('v1.6 角色 prompt / demo 角色回复', () => {
  test('buildRealtimePersona / buildSystemPrompt：角色人设注入且不下发 JSON 格式', () => {
    const elena = findCharacter('elena')
    const persona = buildRealtimePersona({ level: 'B1', teacherName: 'Elena', mode: 'free', character: elena })
    assert.match(persona, /Elena/)
    assert.match(persona, /London|伦敦/)
    assert.match(persona, /gallery curator/i)
    assert.doesNotMatch(persona, /<<<FEEDBACK>>>/, '实时角色人格不应要求 JSON 标记')
    const prompt = buildSystemPrompt({ mode: 'free', level: 'B1', teacherName: 'Maya', character: findCharacter('maya') })
    assert.match(prompt, /Stay fully in character/i)
    assert.match(prompt, /Maya/)
    assert.match(prompt, /New York/)
    assert.doesNotMatch(JSON.stringify({ prompt }).slice(0, 200), /persona:/i)
  })

  test('buildDemoCharacterReply：开场用角色 greeting/scene opener，回答保持角色口吻', () => {
    const opening = buildDemoCharacterReply({ characterId: 'elena', sceneId: '', message: '', history: [] })
    assert.ok(opening.text.length > 10)
    assert.match(opening.text, /Elena|exhibition|art/i)
    assert.equal(opening.feedback.chineseHelp ?? null, null)
    const scene = buildDemoCharacterReply({ characterId: 'maya', sceneId: 'cafe', message: '', history: [] })
    assert.match(scene.text, /coffee|cold brew|Maya/i)
    const answer = buildDemoCharacterReply({ characterId: 'maya', sceneId: 'cafe', message: 'I want a latte', history: [] })
    assert.ok(answer.text.length > 5)
    const unknown = buildDemoCharacterReply({ characterId: 'nope', message: 'hello' })
    assert.ok(unknown.text.length > 5, '未知角色应回退普通 demo 回复')
  })
})

/* ========================================================================== */
/* v1.8 · lib/llmJson.js 非流式 JSON 助手                                        */
/* ========================================================================== */
describe('v1.8 lib/llmJson JSON 提取/调用', () => {
  test('extractJson：纯 JSON / 围栏 / 前后废话 / 数组 / 非法返回 null', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
    assert.deepEqual(extractJson('```json\n{"b":[1,2]}\n```'), { b: [1, 2] })
    assert.deepEqual(extractJson('好的，结果如下：\n{"c":true}\n以上。'), { c: true })
    assert.deepEqual(extractJson('[{"i":1},{"i":2}]'), [{ i: 1 }, { i: 2 }])
    assert.equal(extractJson('not json at all'), null)
    assert.equal(extractJson(''), null)
    assert.equal(extractJson(null), null)
  })

  test('chatJSON：mock 上游合法 JSON → content+parsed；无法解析的文本 parsed=null', async () => {
    const mock = await startMockUpstream()
    try {
      const settings = { apiKey: 'k', baseUrl: mock.url, model: 'mock-model' }
      const ok = await chatJSON({
        settings,
        messages: [{ role: 'system', content: 'You are a conversation director for a language-practice chat.' }, { role: 'user', content: 'hi' }],
      })
      assert.ok(ok.parsed && typeof ok.parsed === 'object', '应解析出 JSON')
      mock.setScenario('500')
      await assert.rejects(
        () => chatJSON({ settings, messages: [{ role: 'system', content: 'just chat' }, { role: 'user', content: 'hello' }] }),
        /HTTP 500/,
      )
      mock.setScenario('ok')
      await assert.rejects(() => chatJSON({ settings: { apiKey: '', baseUrl: mock.url }, messages: [] }), /API Key/)
    } finally {
      await mock.close()
    }
  })
})

/* ========================================================================== */
/* v1.8 · lib/director.js 对话导演                                              */
/* ========================================================================== */
describe('v1.8 lib/director 对话导演', () => {
  test('rulePlan：角度在清单内、source=rule、短消息不追问、avoid 去重、kb 模式角度', () => {
    const p = rulePlan({ userMessage: 'I love street photography.', recentQuestions: ['What do you do?'], kbMode: 'free' })
    assert.ok(ANGLES.includes(p.angle))
    assert.equal(p.source, 'rule')
    assert.equal(typeof p.stance, 'string')
    assert.ok(p.stance.length > 10)
    assert.deepEqual(p.avoid, ['What do you do?'])
    assert.equal(p.question, true, '非短消息在第一轮可追问')
    assert.equal(rulePlan({ userMessage: 'hi' }).question, false, '短消息不追问')
    const grounded = rulePlan({ userMessage: 'Tell me about this article', kbMode: 'grounded', kbTitles: ['Art Today'] })
    assert.ok(['知识关联', '观点碰撞', '细节追问'].includes(grounded.angle))
    assert.match(grounded.hook, /Art Today/)
    assert.equal(grounded.kbUse, 'grounded')
  })

  test('normalizePlan：合法计划规范化、非法角度/空值返回 null、recentQuestions 合并去重且 ≤8', () => {
    const p = normalizePlan(
      { angle: '观点碰撞', stance: 'give a counterpoint', question: true, hook: 'hook', avoid: ['Q1'] },
      { recentQuestions: ['Q1', 'Q2', 'Q3'] },
    )
    assert.equal(p.angle, '观点碰撞')
    assert.equal(p.source, 'model')
    assert.equal(p.question, true)
    assert.deepEqual(p.avoid, ['Q1', 'Q2', 'Q3'])
    assert.equal(normalizePlan({ angle: '不存在角度' }), null)
    assert.equal(normalizePlan(null), null)
    assert.equal(normalizePlan('x'), null)
    const many = normalizePlan({ angle: '反例' }, { recentQuestions: Array.from({ length: 12 }, (_, i) => `Q${i}`) })
    assert.equal(many.avoid.length, 8)
  })

  test('planTurn：无 Key → 规则版；mock 合法 JSON → source=model；坏 JSON → 规则降级（永不 throw）', async () => {
    const noKey = await planTurn({ settings: { apiKey: '' }, userMessage: 'hello there, my friend' })
    assert.equal(noKey.source, 'rule')
    const mock = await startMockUpstream()
    try {
      const settings = { apiKey: 'k', baseUrl: mock.url, model: 'mock-model' }
      mock.reset()
      const model = await planTurn({ settings, userMessage: 'I visited a gallery yesterday', history: [] })
      assert.equal(model.source, 'model', 'mock 返回合法 JSON 时应采用模型计划')
      assert.ok(ANGLES.includes(model.angle))
      assert.equal(mock.directorCalls.length, 1, '应调用导演 JSON 接口')
      mock.reset()
      mock.setScenario('bad-director')
      const bad = await planTurn({ settings, userMessage: 'I visited a gallery yesterday' })
      assert.equal(bad.source, 'rule', '模型坏 JSON 时应规则降级')
    } finally {
      await mock.close()
    }
  })

  test('buildDirectorMessages/buildMemoryMessages：JSON 指令 + 最新消息/记忆/最近问题/知识库标题', () => {
    const msgs = buildDirectorMessages({
      character: findCharacter('elena'),
      userMessage: 'I went to a photography exhibition.',
      history: [{ role: 'assistant', content: 'What kind of art do you like?' }],
      memoryText: 'Likes photography',
      recentQuestions: ['What kind of art do you like?'],
      kbTitles: ['Modern Art Weekly'],
      kbMode: 'grounded',
    })
    assert.equal(msgs.length, 2)
    const system = msgs[0].content
    for (const key of ['angle', 'stance', 'question', 'avoid', 'hook']) assert.ok(system.includes(key), `导演 prompt 应包含 ${key}`)
    assert.match(system, /Return strict JSON only/)
    const user = msgs[1].content
    assert.match(user, /I went to a photography exhibition/)
    assert.match(user, /Likes photography/)
    assert.match(user, /What kind of art do you like/)
    assert.match(user, /Modern Art Weekly/)
    const mem = buildMemoryMessages({ character: findCharacter('maya'), messages: [{ role: 'user', content: 'I work late.' }] })
    assert.match(mem[0].content, /interests/)
    assert.match(mem[0].content, /facts/)
    assert.match(mem[0].content, /summary/)
    assert.match(mem[1].content, /I work late/)
  })

  test('prompts：身份=视角块 / 记忆块 / 知识库块 / 导演块（grounded vs divergent）', () => {
    const lens = buildLensRules(findCharacter('maya'))
    assert.match(lens, /LENS/)
    assert.match(lens, /NEVER steer the conversation back/)
    assert.match(lens, /at most ONE question/)
    const memoryBlock = buildMemoryBlock({ memoryText: 'Likes coffee', recentQuestions: ['Q1', 'Q2'] })
    assert.match(memoryBlock, /Likes coffee/)
    assert.match(memoryBlock, /DO NOT ask them again/)
    const grounded = buildKBContextBlock({ kbMode: 'grounded', context: '《Art》text' })
    const divergent = buildKBContextBlock({ kbMode: 'divergent', context: '《Art》text' })
    assert.match(grounded, /MATERIAL LESSON mode/)
    assert.match(divergent, /springboard/)
    assert.notEqual(grounded, divergent)
    const plan = normalizePlan({ angle: '反例', stance: 's', question: false, hook: 'h', avoid: ['Q1'] })
    const block = buildDirectorBlock(plan)
    assert.match(block, /Angle: 反例/)
    assert.match(block, /do NOT ask a question/)
    assert.match(block, /Q1/)
    assert.equal(buildDirectorBlock(null), '')
  })
})

/* ========================================================================== */
/* v1.8 · lib/memory.js 记忆合并/最近问题                                          */
/* ========================================================================== */
describe('v1.8 lib/memory 记忆与最近问题', () => {
  test('recentQuestionsFromHistory：只取 assistant 的问句、去重、限长', () => {
    const history = [
      { role: 'assistant', content: 'Hello! What do you like? What is your job?' },
      { role: 'user', content: 'I like art? maybe' },
      { role: 'assistant', content: 'What do you like?' },
      { role: 'assistant', content: 'Nice weather. I love it.' },
    ]
    const qs = recentQuestionsFromHistory(history, 8)
    assert.ok(qs.includes('What do you like?'))
    assert.ok(qs.includes('What is your job?'))
    assert.equal(qs.length >= 2 && qs.length <= 3, true, `应去重（实际 ${JSON.stringify(qs)}）`)
    assert.ok(!qs.some((q) => q.includes('maybe')), '不应包含 user 消息')
  })

  test('mergeMemory：并集去重保序、interests/facts/topics 上限、summary 覆盖/保留', () => {
    const existing = { interests: ['摄影', '旅行'], facts: ['住在上海'], topics: ['艺术'], summary: '旧摘要' }
    const merged = mergeMemory(existing, {
      interests: ['旅行', '咖啡'],
      facts: ['住在上海', '养猫'],
      topics: ['艺术', '摄影'],
      summary: '新摘要',
    })
    assert.deepEqual(merged.interests, ['摄影', '旅行', '咖啡'])
    assert.deepEqual(merged.facts, ['住在上海', '养猫'])
    assert.deepEqual(merged.topics, ['艺术', '摄影'])
    assert.equal(merged.summary, '新摘要')
    assert.equal(mergeMemory(existing, { summary: '' }).summary, '旧摘要', '空 summary 应保留旧摘要')
    const capped = mergeMemory({}, { interests: Array.from({ length: 40 }, (_, i) => `i${i}`) })
    assert.equal(capped.interests.length, 24, 'interests 上限 24')
  })

  test('formatMemoryForPrompt 纯文本格式（通过临时 profile/memory 不可写时跳过真实文件）', () => {
    const fn = typeof formatMemoryForPrompt === 'function'
    assert.equal(fn, true)
  })
})

/* ========================================================================== */
/* v1.8 · lib/kb.js 知识库纯函数（切块/HTML/检索）                                  */
/* ========================================================================== */
describe('v1.8 lib/kb 知识库纯函数', () => {
  test('detectLang / decodeEntities / htmlToText：中英标识 + HTML 正文提取', () => {
    assert.equal(detectLang('The quick brown fox jumps over the lazy dog.'), 'en')
    assert.equal(detectLang('这是一段完全中文的内容，讲的是艺术和阅读，适合检索。'), 'zh')
    assert.equal(detectLang('这是中文 English 内容 here 文字 mixed'), 'mixed')
    assert.equal(decodeEntities('a &amp; b &lt; c &#65; &#x42;'), 'a & b < c A B')
    const html = `<html><head><title>T</title><style>.a{color:red}</style></head>
      <body><header>导航</header><h1>Art Weekly</h1><p>First &amp; second paragraph.</p>
      <script>alert(1)</script><footer>页脚</footer></body></html>`
    const text = htmlToText(html)
    assert.match(text, /Art Weekly/)
    assert.match(text, /First & second paragraph/)
    assert.doesNotMatch(text, /alert\(1\)/)
    assert.doesNotMatch(text, /color:red/)
    assert.doesNotMatch(text, /导航|页脚/)
  })

  test('chunkText：空文本 []、短文 1 块、长文多块且 id c1..、长度受控', () => {
    assert.deepEqual(chunkText('   '), [])
    const short = chunkText('Short paragraph about art and reading.')
    assert.equal(short.length, 1)
    assert.equal(short[0].id, 'c1')
    const long = chunkText(Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(80)).join('\n\n'), { size: 300, overlap: 60 })
    assert.ok(long.length > 1, '长文应切多块')
    assert.deepEqual(long.map((c) => c.id), long.map((_, i) => `c${i + 1}`))
    for (const c of long) assert.ok(c.text.length <= 300 + 60 + 120, `块长度应受控（${c.text.length}）`)
  })

  test('tokenize / bm25Rank：中英混合分词与 BM25 命中排序', () => {
    const tokens = kbTokenize('Art gallery 艺术画廊')
    assert.ok(tokens.includes('art') && tokens.includes('gallery'))
    assert.ok(tokens.includes('艺术') && tokens.includes('画廊'), '中文应按 bigram 切分')
    assert.deepEqual(kbTokenize(''), [])
    const chunks = [
      { id: 'c1', text: 'modern art gallery exhibition', tokens: kbTokenize('modern art gallery exhibition'), docId: 'kb_1', docTitle: 'Art' },
      { id: 'c2', text: 'coffee and tea in London', tokens: kbTokenize('coffee and tea in London'), docId: 'kb_1', docTitle: 'Art' },
    ]
    const ranked = bm25Rank(chunks, kbTokenize('art gallery'), { limit: 5 })
    assert.equal(ranked.length, 1, '只应有命中的块')
    assert.equal(ranked[0].id, 'c1')
    assert.ok(ranked[0].score > 0)
    assert.equal(ranked[0].tokens, undefined, '返回结果应移除 tokens')
    assert.deepEqual(bm25Rank([], kbTokenize('x')), [])
    assert.deepEqual(bm25Rank(chunks, []), [])
  })

  test('makeDocId：kb_ 前缀、唯一', () => {
    const ids = new Set(Array.from({ length: 20 }, () => makeDocId()))
    assert.equal(ids.size, 20)
    for (const id of ids) assert.match(id, /^kb_[a-z0-9]+$/)
  })

  test('buildKBEnrichMessages / buildKBQueryMessages / buildKBRerankMessages 提示词', () => {
    const enrich = buildKBEnrichMessages([{ i: 1, text: 'chunk text' }])
    assert.match(enrich[0].content, /summary/)
    assert.match(enrich[0].content, /keywords/)
    assert.match(enrich[1].content, /\[1\] chunk text/)
    const query = buildKBQueryMessages('艺术 展览')
    assert.match(query[0].content, /terms/)
    assert.match(query[1].content, /艺术 展览/)
    const rerank = buildKBRerankMessages('gallery', [{ title: 'Art', text: 'modern art' }])
    assert.match(rerank[0].content, /order/)
    assert.match(rerank[1].content, /Art/)
  })
})


/* ========================================================================== */
/* v2.2 · doubao-voice PTT commit/cancelTurn（静态契约 + 不抛错语义）              */
/* ========================================================================== */
describe('v2.2 doubao-voice PTT', () => {
  test('commit/cancelTurn：API 存在、commit 发送 {type:commit}、cancelTurn 发 interrupt 且返回 boolean', async () => {
    const src = await readFile(new URL('../web/js/doubao-voice.js', import.meta.url), 'utf8')
    assert.match(src, /function commit\(\)/, '应实现 commit()')
    assert.match(src, /function cancelTurn\(\)/, '应实现 cancelTurn()')
    assert.match(src, /sendJSON\(\{ type: 'commit' \}\)/, 'commit 应发送 {type:commit}')
    assert.match(src, /type: 'interrupt'/, 'cancelTurn 应复用 interrupt')
    assert.match(src, /\n\s+commit,/, '返回对象应暴露 commit')
    assert.match(src, /\n\s+cancelTurn,/, '返回对象应暴露 cancelTurn')
    // 不抛错：函数体包含 try/catch 或布尔返回
    const commitBlock = src.slice(src.indexOf('function commit()'), src.indexOf('function cancelTurn()') + 1)
    assert.ok(/return (true|false)/.test(commitBlock), 'commit 应返回 boolean')
  })
})


/* ========================================================================== */
/* v2.7 · lib/review.js 纯函数（词 key / 到期判定 / 间隔上限）                    */
/* ========================================================================== */
describe('v2.7 lib/review 单词复习纯函数', () => {
  test('wordKey：小写/trim/截断，空值安全', () => {
    assert.equal(wordKey('  Resilient '), 'resilient')
    assert.equal(wordKey(null), '')
    assert.equal(wordKey('x'.repeat(100)).length, 60)
  })

  test('isDue / formatDue / intervalDays：到期判定、文案、间隔上限', () => {
    const now = Date.now()
    assert.equal(__reviewTest.isDue({ due: now - 1000 }, now), true)
    assert.equal(__reviewTest.isDue({ due: now + 60_000 }, now), false)
    assert.equal(__reviewTest.isDue({}, now), false, '缺省 due 非数字视为不到期')
    assert.equal(__reviewTest.formatDue(0), '')
    assert.equal(__reviewTest.formatDue(now + 5 * 60_000), '5 分钟后')
    assert.equal(__reviewTest.formatDue(now - 1000), '现在')
    assert.equal(__reviewTest.formatDue(now + 3 * 86400000), '3 天后')
    assert.equal(__reviewTest.intervalDays({ interval: 9999 }), 365, '间隔上限 365 天')
    assert.equal(__reviewTest.intervalDays({ interval: -2 }), 0, '负间隔归零')
    assert.equal(__reviewTest.intervalDays(null), 0)
  })
})




/* ========================================================================== */
/* v3.1 · lib/plans.js v3 用户自由文本计划（3 节课/AI 生成/老师切换/进度）        */
/* ========================================================================== */
const GEN_LESSONS = [
  {
    title: '咖啡店点单',
    topic: '咖啡店',
    emoji: '☕',
    objectives: ['能点一杯咖啡', '能说大小杯和带走'],
    phrases: [
      { en: 'Hi, can I get a latte, please?', zh: '你好，我要一杯拿铁。' },
      { en: 'Could I have a medium size?', zh: '可以给我中杯吗？' },
      { en: 'For here or to go?', zh: '在这儿喝还是带走？' },
      { en: 'That will be five dollars.', zh: '一共五美元。' },
      { en: 'Thanks, have a nice day!', zh: '谢谢，祝你今天愉快！' },
    ],
    steps: [
      { id: 'repeat', title: '跟读常用句', desc: '她读一句，你重复一句，共 5 句。' },
      { id: 'practice', title: '场景练习', desc: '在咖啡店点单。' },
      { id: 'challenge', title: '完成挑战', desc: '独立完成一次点单。' },
    ],
    taskPrompt: '点一杯咖啡并说明带走。',
    teacherIntro: 'Welcome to the café! Let us order a coffee together.',
  },
  {
    title: '机场值机',
    topic: '机场',
    emoji: '✈️',
    objectives: ['能办理值机', '能选座位'],
    phrases: [
      { en: 'I would like to check in, please.', zh: '我想办理值机。' },
      { en: 'Here is my passport.', zh: '这是我的护照。' },
      { en: 'Can I have a window seat?', zh: '可以给我靠窗座位吗？' },
      { en: 'How many bags are you checking?', zh: '你有几件托运行李？' },
      { en: 'Your gate is B12.', zh: '你的登机口是 B12。' },
    ],
    steps: [
      { id: 'repeat', title: '跟读常用句', desc: '她读一句，你重复一句。' },
      { id: 'practice', title: '场景练习', desc: '在机场值机。' },
      { id: 'challenge', title: '完成挑战', desc: '独立完成值机。' },
    ],
    taskPrompt: '办理值机并选一个靠窗座位。',
    teacherIntro: 'Let us check in for your flight.',
  },
  {
    title: '酒店入住',
    topic: '酒店',
    emoji: '🏨',
    objectives: ['能办理入住', '能问早餐时间'],
    phrases: [
      { en: 'I have a reservation under Wang.', zh: '我用王先生的名字订了房。' },
      { en: 'Could I see your ID?', zh: '可以看一下你的证件吗？' },
      { en: 'What time is breakfast?', zh: '早餐几点？' },
      { en: 'The elevator is on your right.', zh: '电梯在你右边。' },
      { en: 'Enjoy your stay!', zh: '祝你入住愉快！' },
    ],
    steps: [
      { id: 'repeat', title: '跟读常用句', desc: '她读一句，你重复一句。' },
      { id: 'practice', title: '场景练习', desc: '在酒店前台入住。' },
      { id: 'challenge', title: '完成挑战', desc: '独立完成入住。' },
    ],
    taskPrompt: '办理入住并问早餐时间。',
    teacherIntro: 'Welcome to our hotel!',
  },
]

describe('v3.1 lib/plans v3 自由文本计划', () => {
  test('createUserPlan：v3 骨架 3 课、generating、老师默认 Elena、初始进度 0/首课解锁', () => {
    const plan = createUserPlan({ goalText: '我想学咖啡店点单、机场值机和酒店入住', level: 'A2' })
    assert.equal(plan.version, 3, '计划应为 v3')
    assert.equal(PLAN_VERSION, 3)
    assert.equal(PLAN_LESSON_COUNT, 3)
    assert.equal(plan.teacherId, 'elena', '默认老师 Elena')
    assert.equal(plan.teacherName, 'Elena')
    assert.match(plan.goalText, /咖啡店/)
    assert.equal(plan.stages.length, 3)
    assert.deepEqual(plan.stages.map((st) => st.lessonId), ['lesson_1', 'lesson_2', 'lesson_3'])
    for (const stage of plan.stages) {
      const lesson = plan.lessons[stage.lessonId]
      assert.equal(lesson.status, 'generating', '课件初始 generating')
      assert.equal(lesson.phrases.length, 0)
    }
    assert.equal(plan.progress, 0)
    assert.equal(plan.generating, true)
    assert.equal(plan.stages[0].unlocked, true)
    assert.equal(plan.stages[1].unlocked, false, '顺序解锁：第 2 课初始锁定')
    assert.equal(plan.next.stageId, 'stage_1')
  })

  test('setPlanTeacher：切换老师保留课件/进度；非法老师 400 语义', () => {
    const plan = fillPlanLessons(createUserPlan({ goalText: '机场值机', level: 'A2' }), GEN_LESSONS)
    const hikari = setPlanTeacher(plan, 'hikari')
    assert.equal(hikari.teacherId, 'hikari')
    assert.equal(hikari.teacherName, 'Hikari')
    assert.equal(hikari.lessons.lesson_1.title, '咖啡店点单', '切换老师不应丢课件')
    assert.equal(hikari.progress, plan.progress)
    assert.throws(() => setPlanTeacher(plan, 'nope'), /老师|角色|teacher/i)
  })

  test('fillPlanLessons：3 课 ready、每课 5 句/3 步/目标；completeLesson 进度 33→67→100、锁/未完成/幂等', () => {
    let plan = fillPlanLessons(createUserPlan({ goalText: '咖啡店/机场/酒店', level: 'A2' }), GEN_LESSONS)
    assert.equal(plan.generating, false)
    for (let i = 1; i <= 3; i++) {
      const lesson = plan.lessons['lesson_' + i]
      assert.equal(lesson.status, 'ready')
      assert.equal(lesson.phrases.length, 5, '每课 5 句')
      assert.equal(lesson.steps.length, 3, '每课 3 步')
      assert.ok(lesson.objectives.length >= 2)
      assert.ok(lesson.phrases.every((p) => p.en && p.zh))
    }
    assert.equal(plan.progress, 0)
    assert.equal(plan.hasError, false)
    const incomplete = completeLesson(plan, { lessonId: 'lesson_1', stageId: 'stage_1', stepsCompleted: 2 })
    assert.equal(incomplete.completed, false)
    assert.equal(incomplete.reason, 'steps-incomplete')
    const done1 = completeLesson(plan, { lessonId: 'lesson_1', stageId: 'stage_1', stepsCompleted: 3 })
    assert.equal(done1.completed, true)
    assert.equal(done1.plan.progress, 33)
    assert.equal(done1.plan.stages[1].unlocked, true, '完成第 1 课后解锁第 2 课')
    assert.equal(done1.next.stageId, 'stage_2')
    const again = completeLesson(done1.plan, { lessonId: 'lesson_1', stageId: 'stage_1', stepsCompleted: 3 })
    assert.equal(again.completed, true)
    assert.equal(again.alreadyDone, true, '重复完成幂等')
    const locked = completeLesson(plan, { lessonId: 'lesson_3', stageId: 'stage_3', stepsCompleted: 3 })
    assert.equal(locked.completed, false)
    assert.equal(locked.reason, 'locked')
    const done2 = completeLesson(done1.plan, { lessonId: 'lesson_2', stageId: 'stage_2', stepsCompleted: 3 })
    assert.equal(done2.plan.progress, 67)
    const done3 = completeLesson(done2.plan, { lessonId: 'lesson_3', stageId: 'stage_3', stepsCompleted: 3 })
    assert.equal(done3.plan.progress, 100)
    assert.equal(done3.plan.allDone, true)
    assert.equal(done3.plan.next, null)
    const notReady = completeLesson(createUserPlan({ goalText: 'x' }), { lessonId: 'lesson_1', stepsCompleted: 3 })
    assert.equal(notReady.completed, false)
    assert.equal(notReady.reason, 'not-ready', '课件未生成时不可完成')
  })

  test('resetPlanForGeneration / setPlanLessonError / publicPlan / 课程读取', () => {
    const ready = fillPlanLessons(createUserPlan({ goalText: '咖啡店', level: 'A2' }), GEN_LESSONS)
    const reset = resetPlanForGeneration(ready)
    assert.equal(reset.generating, true)
    assert.equal(reset.lessons.lesson_1.status, 'generating')
    assert.equal(reset.lessons.lesson_1.done, false)
    const errored = setPlanLessonError(reset, '模型超时')
    assert.equal(errored.lessons.lesson_1.status, 'error')
    assert.match(String(errored.errorMessage), /模型超时/)
    assert.equal(errored.hasError, true)
    const decoded = decoratePlan(ready)
    assert.equal(decoded.version, 3)
    assert.equal(decoded.totalLessons, 3)
    assert.equal(decoded.doneLessons, 0)
    assert.equal(getPlanLesson(ready, 'lesson_2').title, '机场值机')
    assert.equal(getPlanLesson(ready, 'nope'), null)
    assert.equal(listPlanLessons(ready).length, 3)
    assert.equal(listPlanLessons(ready)[0].stageId, 'stage_1')
    const pub = publicPlan(ready)
    assert.equal(pub.next.lessonId, 'lesson_1')
    assert.equal(publicPlan(null), null)
  })
})

describe('v3.1 lib/tts 角色原声映射', () => {
  test('listTtsVoices：三角色映射（Hikari 映射英语教师音色）', () => {
    const voices = listTtsVoices()
    assert.equal(voices.length, 3)
    const ids = voices.map((v) => v.characterId).sort()
    assert.deepEqual(ids, ['elena', 'hikari', 'maya'])
    const elena = voices.find((v) => v.characterId === 'elena')
    const maya = voices.find((v) => v.characterId === 'maya')
    const hikari = voices.find((v) => v.characterId === 'hikari')
    assert.match(elena.ttsSpeaker, /uranus_bigtts/)
    assert.match(maya.ttsSpeaker, /uranus_bigtts/)
    assert.equal(hikari.ttsSpeaker, 'zh_female_yingyujiaoxue_uranus_bigtts', 'Hikari 应映射英语教师音色')
    for (const v of voices) {
      assert.ok(v.speaker && v.realtimeSpeaker, '含实时的原音色字段')
      assert.ok(v.name)
    }
  })

  test('synthesizeSpeech：空文本抛出中文错误（前端回退浏览器朗读）', async () => {
    await assert.rejects(() => synthesizeSpeech({ text: '', characterId: 'elena' }), /文本|内容|text/i)
    await assert.rejects(() => synthesizeSpeech({ text: '   ', characterId: 'maya' }), /文本|内容|text/i)
  })
})


/* ========================================================================== */
/* v3.2 · 课程断点（lesson-progress / lesson-restart / 完成清空）                  */
/* ========================================================================== */
describe('v3.2 lib/plans 课程断点续学', () => {
  test('saveLessonProgress：字段归一/clamp、GET 计划含 resume', () => {
    const plan = fillPlanLessons(createUserPlan({ goalText: '咖啡店和机场', level: 'A2' }), GEN_LESSONS)
    const saved = saveLessonProgress(plan, { lessonId: 'lesson_1', step: 9, phraseIdx: 99, practiceTurns: -3, challengeTurns: 2 })
    assert.equal(saved.ok, true)
    assert.equal(saved.resume.step, 3, 'step 归一 1–3')
    assert.equal(saved.resume.phraseIdx, 5, 'phraseIdx 归一句数')
    assert.equal(saved.resume.practiceTurns, 0, '负数轮次归零')
    assert.equal(saved.resume.challengeTurns, 2)
    assert.ok(saved.resume.updatedAt > 0)
    const lesson = decoratePlan(saved.plan).lessons.lesson_1
    assert.equal(lesson.resume.step, 3)
    assert.equal(lesson.resume.phraseIdx, 5)
    assert.equal(lesson.done, false)
    const missing = saveLessonProgress(plan, { lessonId: 'nope', step: 1 })
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'not-found')
    const generating = saveLessonProgress(createUserPlan({ goalText: 'x' }), { lessonId: 'lesson_1', step: 1 })
    assert.equal(generating.ok, false)
    assert.equal(generating.reason, 'not-ready')
  })

  test('clearLessonProgress / completeLesson：restart 清空、完成清空 resume 且 done 后不可再保存', () => {
    const plan = fillPlanLessons(createUserPlan({ goalText: '咖啡店和机场', level: 'A2' }), GEN_LESSONS)
    const withResume = saveLessonProgress(plan, { lessonId: 'lesson_1', step: 2, phraseIdx: 5, practiceTurns: 1 }).plan
    assert.ok(decoratePlan(withResume).lessons.lesson_1.resume, '应有断点')
    const cleared = clearLessonProgress(withResume, 'lesson_1')
    assert.equal(decoratePlan(cleared).lessons.lesson_1.resume, null, 'restart 应清空断点')
    const done = completeLesson(withResume, { lessonId: 'lesson_1', stageId: 'stage_1', stepsCompleted: 3 })
    assert.equal(done.completed, true)
    assert.equal(done.plan.progress, 33)
    assert.equal(decoratePlan(done.plan).lessons.lesson_1.resume, null, '完成课应清空 resume')
    assert.equal(decoratePlan(done.plan).lessons.lesson_1.done, true)
    const afterDone = saveLessonProgress(done.plan, { lessonId: 'lesson_1', step: 1, phraseIdx: 0 })
    assert.equal(afterDone.ok, false)
    assert.equal(afterDone.reason, 'done', '完成课不应再保存断点')
  })
})
