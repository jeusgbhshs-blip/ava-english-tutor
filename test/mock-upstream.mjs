/**
 * test/mock-upstream.mjs — 本地假 OpenAI 兼容上游（零依赖，仅 node 内置模块）
 *
 * 用途：给 e2e.mjs 提供可控的「大模型服务端」，不发真实网络请求。
 *
 * 支持：
 *   GET  <base>/models              → OpenAI /models 列表（/api/settings/test 用）
 *   POST <base>/chat/completions    → SSE 流式 chat completion（stream:true），
 *                                     或普通 JSON completion（stream:false）
 *   <base> 可带或不带 /v1 前缀（路径以 /models、/chat/completions 结尾即可）。
 *
 * 可切换场景（热切换，无需重启）：
 *   - 'ok'          正常流式返回（英文正文 + `<<<FEEDBACK>>>` + 合法 JSON）
 *   - '401'         返回 401（非法 apiKey）
 *   - '500'         返回 500（上游错误）
 *   - 'slow'        首字节与分块都变慢（默认 1200ms / 150ms，测流式与超时路径）
 *   - 'abort'       已发送若干 SSE 分块后强制断开连接（断流）
 *   - 'truncate'    发送到 `<<<FEEDBACK>>>` 标记后只给半截 JSON 就断流
 *   - 'bad-json'    feedback 标记后跟非法 JSON（服务端剥离/解析健壮性）
 *   - 'no-feedback' 只返回英文正文，没有 `<<<FEEDBACK>>>` 标记
 *   - 'bad-summary' 总结请求（POST /api/summary）返回非法 JSON，验证降级 demo
 *   - 'bad-doc-analysis' 阅读分析请求（POST /api/doc/analyze）返回非法 JSON，验证降级 demo
 *   - 'bad-coach'     教练分析请求（POST /api/coach）返回非法 JSON，验证降级 demo
 *   - 'bad-translation' 文本模型翻译请求返回英文（应被丢弃 → 翻译失败）
 *
 * v1.2：当上游请求的「最新一条 user 消息」含中文字符时，chat SSE 的反馈 JSON 会自动附带
 * `chineseHelp`（且 corrections 为空），供服务端/前端联调与 e2e 断言使用。
 *   - 'hang'        永不响应（测上游超时；注意 60s 超时上限，别在常规用例里等）
 *
 * 用法：
 *   import { startMockUpstream } from './mock-upstream.mjs'
 *   const mock = await startMockUpstream()
 *   mock.url                      // http://127.0.0.1:PORT/v1 （填到 settings.baseUrl）
 *   mock.setScenario('401')
 *   mock.calls                    // [{ kind:'chat'|'models', url, headers, body, at }]
 *   mock.chatCalls                // 过滤出 chat 调用
 *   mock.summaryCalls             // 过滤出总结调用（stream:false 的 JSON 总结）
 *   await mock.close()
 */

import http from 'node:http'
import { fileURLToPath } from 'node:url'

/** 默认反馈 JSON（结构严格按 SPEC §2.3） */
export const DEFAULT_FEEDBACK = {
  corrections: [
    {
      original: 'I want a coffee',
      corrected: 'I would like a coffee',
      explanation_zh: '「I would like」比「I want」更礼貌自然。',
    },
  ],
  better: [
    {
      original: 'I want a coffee',
      better: 'Could I get a coffee, please?',
      why_zh: '加 could 和 please，语气更委婉，是咖啡店常用说法。',
    },
  ],
  newWords: [
    {
      word: 'latte',
      phonetic: '/ˈlɑːteɪ/',
      meaning: '拿铁咖啡',
      example: 'I would like a latte, please.',
    },
  ],
  encouragement_zh: '说得很棒！继续保持，再多练一轮吧。',
  followUp: 'What size would you like — small, medium or large?',
}

/** 默认英文正文（流式 delta 应只包含这部分，不含反馈 JSON） */
export const DEFAULT_REPLY_TEXT =
  "That sounds lovely! I'd like a latte with oat milk, please.\n" +
  'Sure — would you like it hot or iced? ' +
  'And do you want anything to eat with that?'

/** 默认「对话总结」JSON（POST /api/summary 的非流式返回，结构严格按 SPEC v1.1 §B1） */
export const DEFAULT_SUMMARY = {
  summary_zh: '这次你聊了工作里的忙碌和周末计划，表达比较自然，也能主动补充细节。进步点是过去式用得更准确了，继续保持每天开口说的习惯！',
  topics_zh: ['工作', '周末计划'],
  strengths_zh: ['能主动补充细节，句子信息量不错'],
  improvements_zh: ['描述昨天发生的事时注意用一般过去时'],
  corrections: [
    {
      original: 'I go to the office yesterday',
      corrected: 'I went to the office yesterday',
      explanation_zh: '描述过去发生的事，动词要用一般过去时。',
    },
  ],
  keyWords: [
    {
      word: 'commute',
      phonetic: '/kəˈmjuːt/',
      meaning: '通勤',
      example: 'I commute by subway every day.',
      why_zh: '你提到了每天坐地铁，这个词比 go to work 更地道。',
    },
    {
      word: 'deadline',
      phonetic: '/ˈdedlaɪn/',
      meaning: '截止日期',
      example: 'The deadline is on Friday.',
      why_zh: '聊工作进度时的高频词。',
    },
    {
      word: 'spreadsheet',
      phonetic: '/ˈspredʃiːt/',
      meaning: '电子表格',
      example: 'I updated the spreadsheet this morning.',
      why_zh: '办公室场景常用词，值得记住。',
    },
  ],
  encouragement_zh: '你这次主动聊了很多细节，进步很明显，继续加油！',
}

/** 默认「文本教练反馈」JSON（POST /api/coach 非流式返回，SPEC v1.4 §B3） */
export const DEFAULT_COACH_FEEDBACK = {
  corrections: [
    { original: 'I very like it', corrected: 'I really like it', explanation_zh: 'very 不能直接修饰动词，要用 really。' },
  ],
  better: [],
  newWords: [{ word: 'really', phonetic: '/ˈrɪəli/', meaning: '确实；非常', example: 'I really like it.', why_zh: '修饰动词更自然' }],
  encouragement_zh: '这句里的时态用对了，继续保持。',
  chineseHelp: null,
}

function isPlanLessonsPayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((m) => m && typeof m.content === 'string' && /experienced English curriculum designer/i.test(m.content))
}

function isDirectorPayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((m) => m && typeof m.content === 'string' && /conversation director for a language-practice chat/i.test(m.content))
}

function isMemoryPayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((m) => m && typeof m.content === 'string' && /extract long-term memory from a language-practice conversation/i.test(m.content))
}

function isKBEnrichPayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((m) => m && typeof m.content === 'string' && /prepare knowledge-base chunks for retrieval/i.test(m.content))
}

function isKBQueryPayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((m) => m && typeof m.content === 'string' && /expand a knowledge-base search query/i.test(m.content))
}

function isKBRerankPayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((m) => m && typeof m.content === 'string' && /rerank knowledge-base passages for a query/i.test(m.content))
}

/** 默认文本模型翻译结果（每行一条中文译文） */
export const DEFAULT_TRANSLATIONS = ['你好，今天过得怎么样？', '我喜欢喝咖啡。', '这是一篇关于阅读的短文。', '很高兴认识你。']

/** 判断一次 /chat/completions 调用是不是文本模型翻译请求 */
function isTranslatePayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((m) => m && typeof m.content === 'string' && /You are a translator/i.test(m.content))
}

/** 判断一次 /chat/completions 调用是不是教练分析请求 */
function isCoachPayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some(
    (m) => m && typeof m.content === 'string' && /Analyze ONLY the student.s latest spoken message/i.test(m.content),
  )
}

/** v1.8：对话导演计划 JSON */
export const DEFAULT_DIRECTOR_PLAN = {
  angle: '细节追问',
  stance: 'Tell a concrete opinion with one specific example from your own perspective.',
  question: true,
  avoid: ['Do you like art?'],
  hook: 'Ask about the specific detail the student just mentioned.',
}

/** v1.8：记忆提取 JSON */
export const DEFAULT_MEMORY_PATCH = {
  interests: ['摄影', '现代艺术'],
  facts: ['经常加班到很晚', '喜欢周末逛画廊'],
  topics: ['艺术展览', '摄影'],
  summary: '学生喜欢摄影和现代艺术，最近工作比较忙。',
}

/** v1.8：知识库查询扩展 JSON */
export const DEFAULT_KB_QUERY = {
  terms: ['画廊', '艺术', '策展'],
  english_terms: ['gallery', 'art', 'curator', 'exhibition'],
}

/** v3.1：AI 生成的 3 节英语课（自由文本计划） */
export const DEFAULT_PLAN_LESSONS = {
  planTitle: 'QA 三课（咖啡/机场/酒店）',
  lessons: [
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
  ],
}

/** 默认「阅读材料分析」JSON（POST /api/doc/analyze 非流式返回，SPEC v1.3 §C3） */
export const DEFAULT_DOC_ANALYSIS = {
  summary_zh: '这是一篇关于阅读练习的短文，一共约 33 个英文单词，适合练习基础词汇与简单句。先听朗读抓大意，再逐句精读效果更好。',
  keyPoints: [
    { en: 'The quick brown fox jumps over the lazy dog.', zh: '经典打字练习句，用于展示如何快速输入英文。' },
    { en: 'Reading English every day helps learners build vocabulary.', zh: '每天阅读英文有助于积累词汇。' },
    { en: 'The weather is really nice today.', zh: '今天天气很好。' },
  ],
  keyWords: [
    { word: 'vocabulary', phonetic: '/vəˈkæbjələri/', meaning: '词汇', example: 'Reading builds vocabulary.', why_zh: '文中核心词，值得掌握。' },
    { word: 'practice', phonetic: '/ˈpræktɪs/', meaning: '练习', example: 'Practice makes perfect.', why_zh: '阅读练习主题词。' },
    { word: 'learner', phonetic: '/ˈlɜːnə/', meaning: '学习者', example: 'Every learner reads a lot.', why_zh: '学习者相关高频词。' },
    { word: 'sentence', phonetic: '/ˈsentəns/', meaning: '句子', example: 'This is a simple sentence.', why_zh: '句子结构学习必备词。' },
    { word: 'famous', phonetic: '/ˈfeɪməs/', meaning: '著名的', example: 'The fox sentence is famous.', why_zh: '文中描述经典句子。' },
  ],
  questions: [
    { en: 'What is the main idea of the text?', zh: '这篇文章的主旨是什么？' },
    { en: 'According to the text, what does reading every day help?', zh: '根据文章，每天阅读有什么帮助？' },
    { en: 'Which sentence in the text do you find most interesting?', zh: '你觉得文中哪一句最有趣？' },
  ],
  readAloud: 'The quick brown fox jumps over the lazy dog. Reading English every day helps learners build vocabulary.',
  wordCount: 33,
}

/** 判断一次 /chat/completions 调用是不是阅读材料分析请求（服务端分析 prompt 含固定英文短语） */
function isDocAnalysisPayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((m) => m && typeof m.content === 'string' && /reading tutor preparing a lesson plan/i.test(m.content))
}

/** 默认中文求助反馈（SPEC v1.2 §B2） */
export const DEFAULT_CHINESE_HELP = {
  original_zh: '我今天很累，不知道怎么说',
  english: "I was completely exhausted after work today.",
  chunks: [
    { en: 'I was completely exhausted', zh: '我累坏了' },
    { en: 'after work today', zh: '今天下班后' },
  ],
  tips_zh: 'exhausted 是“累坏了”的地道说法；想说“疲惫”也可以用 tired / worn out。注意用过去式 was 描述今天已经发生的事。',
}

const HAS_CHINESE = /[\u4e00-\u9fff]/

/** 取上游请求里最新一条 user 消息内容 */
function latestUserContent(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content
  }
  return ''
}

/** 判断一次 /chat/completions 调用是不是对话总结请求（服务端总结 prompt 含固定英文短语） */
function isSummaryPayload(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((m) => m && typeof m.content === 'string' && /post-conversation learning summary/i.test(m.content))
}

/** 把正文 + 反馈拼成模型原始输出（服务端必须能自己剥离标记后的 JSON） */
export function buildRawReply({ text = DEFAULT_REPLY_TEXT, feedback = DEFAULT_FEEDBACK } = {}) {
  return `${text}\n<<<FEEDBACK>>>\n${JSON.stringify(feedback)}`
}

const OPENAI_401 = {
  error: {
    message: 'Incorrect API key provided: sk-test***. You can find your API key at https://platform.openai.com/account/api-keys.',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error(`mock upstream: 请求体超过 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 启动 mock 上游。
 * @param {object} [options]
 * @param {string} [options.scenario='ok']
 * @param {{text?:string, feedback?:object}} [options.reply] 自定义正文/反馈
 * @param {number} [options.chunkSize=7] 每个 SSE delta 的字符数
 * @param {number} [options.chunkDelayMs=3] 分块间隔
 * @param {number} [options.slowFirstByteMs=1200] 'slow' 场景首字节延迟
 * @param {boolean} [options.requireApiKey=false] 为 true 时无 Authorization 直接 401
 * @returns {Promise<object>} mock 控制器
 */
export async function startMockUpstream(options = {}) {
  const state = {
    scenario: options.scenario ?? 'ok',
    reply: options.reply ?? null,
    summaryReply: options.summaryReply ?? null,
    chineseHelp: options.chineseHelp ?? null,
    docAnalysisReply: options.docAnalysisReply ?? null,
    coachReply: options.coachReply ?? null,
    translationIndex: 0,
    directorCalls: [],
    memoryCalls: [],
    kbEnrichCalls: [],
    kbQueryCalls: [],
    kbRerankCalls: [],
    planLessonsCalls: [],
    chunkSize: options.chunkSize ?? 7,
    chunkDelayMs: options.chunkDelayMs ?? 3,
    slowFirstByteMs: options.slowFirstByteMs ?? 1200,
    requireApiKey: options.requireApiKey ?? false,
    calls: [],
  }
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()

  async function handlePlanLessons(req, res, payload) {
    state.planLessonsCalls.push({ body: payload, at: Date.now() })
    if (state.scenario === 'bad-plan-lessons') {
      return sendJSON(res, 200, completion('not valid json at all'))
    }
    return sendJSON(res, 200, completion(JSON.stringify(state.planLessonsReply ?? DEFAULT_PLAN_LESSONS)))
  }

  async function handleDirector(req, res, payload) {
    state.directorCalls.push({ body: payload, at: Date.now() })
    if (state.scenario === 'bad-director') {
      return sendJSON(res, 200, completion('I am not going to give you JSON today.'))
    }
    const plan = state.directorPlan ?? DEFAULT_DIRECTOR_PLAN
    return sendJSON(res, 200, completion(JSON.stringify(plan)))
  }

  async function handleMemory(req, res, payload) {
    state.memoryCalls.push({ body: payload, at: Date.now() })
    return sendJSON(res, 200, completion(JSON.stringify(state.memoryPatch ?? DEFAULT_MEMORY_PATCH)))
  }

  async function handleKBEnrich(req, res, payload) {
    state.kbEnrichCalls.push({ body: payload, at: Date.now() })
    const user = (payload.messages || []).find((m) => m && m.role === 'user')
    const indexes = [...String((user && user.content) || '').matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]))
    const list = indexes.length ? indexes : [1]
    const items = list.map((i) => ({ i, summary: '这是第 ' + i + ' 段的中文摘要，讲艺术与阅读。', keywords: ['art', 'reading', '艺术', '阅读'] }))
    return sendJSON(res, 200, completion(JSON.stringify(items)))
  }

  async function handleKBQuery(req, res, payload) {
    state.kbQueryCalls.push({ body: payload, at: Date.now() })
    return sendJSON(res, 200, completion(JSON.stringify(DEFAULT_KB_QUERY)))
  }

  async function handleKBRerank(req, res, payload) {
    state.kbRerankCalls.push({ body: payload, at: Date.now() })
    const user = (payload.messages || []).find((m) => m && m.role === 'user')
    const candidates = [...String((user && user.content) || '').matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]))
    return sendJSON(res, 200, completion(JSON.stringify({ order: candidates.length ? candidates : [1] })))
  }

  async function handleTranslate(req, res, payload) {
    if (state.requireApiKey && !req.headers.authorization) return sendJSON(res, 401, OPENAI_401)
    if (state.scenario === '401') return sendJSON(res, 401, OPENAI_401)
    if (state.scenario === '500') {
      return sendJSON(res, 500, { error: { message: 'mock upstream translate error', type: 'server_error' } })
    }
    if (state.scenario === 'hang') return
    const user = (payload.messages || []).find((m) => m && m.role === 'user')
    const lineCount = String((user && user.content) || '')
      .split('\n')
      .filter((l) => /^\s*\d+[.、)]/.test(l)).length || 1
    const content =
      state.scenario === 'bad-translation'
        ? Array.from({ length: lineCount }, (_, i) => `${i + 1}. This is an English line, not Chinese.`).join('\n')
        : Array.from({ length: lineCount }, (_, i) => `${i + 1}. ${DEFAULT_TRANSLATIONS[i % DEFAULT_TRANSLATIONS.length]}`).join('\n')
    return sendJSON(res, 200, {
      id: 'chatcmpl-mock-translate',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
    })
  }

  function completion(content) {
    return {
      id: 'chatcmpl-mock-json',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
    }
  }

  async function handleCoach(req, res, payload) {
    if (state.requireApiKey && !req.headers.authorization) return sendJSON(res, 401, OPENAI_401)
    if (state.scenario === '401') return sendJSON(res, 401, OPENAI_401)
    if (state.scenario === '500') {
      return sendJSON(res, 500, { error: { message: 'mock upstream coach error', type: 'server_error' } })
    }
    if (state.scenario === 'hang') return
    const feedback = state.coachReply ?? DEFAULT_COACH_FEEDBACK
    const content = state.scenario === 'bad-coach' ? '抱歉，我无法生成结构化反馈（not a json）。' : JSON.stringify(feedback)
    return sendJSON(res, 200, {
      id: 'chatcmpl-mock-coach',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 90, total_tokens: 210 },
    })
  }

  async function handleDocAnalysis(req, res, payload) {
    if (state.requireApiKey && !req.headers.authorization) return sendJSON(res, 401, OPENAI_401)
    if (state.scenario === '401') return sendJSON(res, 401, OPENAI_401)
    if (state.scenario === '500') {
      return sendJSON(res, 500, { error: { message: 'mock upstream doc analysis error', type: 'server_error' } })
    }
    if (state.scenario === 'hang') return
    const analysis = state.docAnalysisReply ?? DEFAULT_DOC_ANALYSIS
    const content =
      state.scenario === 'bad-doc-analysis' ? '抱歉，我无法生成结构化分析（not a json）。' : JSON.stringify(analysis)
    return sendJSON(res, 200, {
      id: 'chatcmpl-mock-docanalysis',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 },
    })
  }

  async function handleSummary(req, res, payload) {
    if (state.requireApiKey && !req.headers.authorization) return sendJSON(res, 401, OPENAI_401)
    if (state.scenario === '401') return sendJSON(res, 401, OPENAI_401)
    if (state.scenario === '500') {
      return sendJSON(res, 500, { error: { message: 'mock upstream summary error', type: 'server_error' } })
    }
    if (state.scenario === 'hang') return
    const summary = state.summaryReply ?? DEFAULT_SUMMARY
    const content =
      state.scenario === 'bad-summary'
        ? '抱歉，这次我无法生成结构化的总结（not a json）。'
        : JSON.stringify(summary)
    return sendJSON(res, 200, {
      id: 'chatcmpl-mock-summary',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 200, completion_tokens: 120, total_tokens: 320 },
    })
  }

  async function handleChat(req, res, bodyText) {
    const scenario = state.scenario
    if (state.requireApiKey && !req.headers.authorization) {
      return sendJSON(res, 401, OPENAI_401)
    }
    if (scenario === '401') return sendJSON(res, 401, OPENAI_401)
    if (scenario === '500') {
      return sendJSON(res, 500, { error: { message: 'mock upstream internal error', type: 'server_error' } })
    }
    if (scenario === 'hang') return // 永不响应，连接由 close() 清理

    const payload = JSON.parse(bodyText || '{}')
    const reply = state.reply ?? {}
    const text = reply.text ?? DEFAULT_REPLY_TEXT
    const chineseText = reply.chineseText ?? (HAS_CHINESE.test(latestUserContent(payload)) ? ('So you are saying you were really tired today, right? In English you can say: "I was completely exhausted after work today." Let us try it together. How did that feel?' ) : null)
    const feedback = reply.feedback ?? DEFAULT_FEEDBACK
    const stream = payload.stream !== false

    // v1.2：最新 user 消息含中文时，反馈必须带 chineseHelp 且 corrections 为空
    const lastUser = latestUserContent(payload)
    const chineseRequest = HAS_CHINESE.test(lastUser)
    const effectiveFeedback = chineseRequest
      ? { ...feedback, corrections: [], newWords: (feedback && feedback.newWords) || [], chineseHelp: state.chineseHelp ?? DEFAULT_CHINESE_HELP }
      : feedback
    const effectiveText = chineseText ?? text

    let raw
    if (scenario === 'no-feedback') raw = effectiveText
    else if (scenario === 'bad-json') raw = `${effectiveText}\n<<<FEEDBACK>>>\n{ "corrections": [ this is not json ]`
    else if (scenario === 'truncate') raw = `${effectiveText}\n<<<FEEDBACK>>>\n{"corrections":[{"orig`
    else raw = buildRawReply({ text: effectiveText, feedback: effectiveFeedback })

    if (!stream) {
      return sendJSON(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model || 'mock-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: raw }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
      })
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const chunkSize = Math.max(1, Math.min(64, state.chunkSize))
    const delay = scenario === 'slow' ? 150 : state.chunkDelayMs
    if (scenario === 'slow') await sleep(state.slowFirstByteMs)

    const chunks = []
    for (let i = 0; i < raw.length; i += chunkSize) chunks.push(raw.slice(i, i + chunkSize))

    const maxBeforeAbort = scenario === 'abort' ? Math.min(2, chunks.length) : chunks.length
    for (let i = 0; i < maxBeforeAbort; i++) {
      if (res.destroyed || res.writableEnded) return
      const frame = {
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: payload.model || 'mock-model',
        choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
      }
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
      if (delay > 0 && i < maxBeforeAbort - 1) await sleep(delay)
    }

    if (scenario === 'abort' || scenario === 'truncate') {
      // 模拟上游断流：不发 [DONE]，直接断 TCP
      await sleep(20)
      res.destroy()
      return
    }

    const last = {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'mock-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
    res.write(`data: ${JSON.stringify(last)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }

  const server = http.createServer((req, res) => {
    ;(async () => {
      const bodyText = await readBody(req).catch(() => '')
      const urlPath = (req.url || '').split('?')[0]
      const isModels = /\/models$/.test(urlPath)
      const isChat = /\/chat\/completions$/.test(urlPath)

      let parsedBody = null
      if (isChat && bodyText) {
        try {
          parsedBody = JSON.parse(bodyText)
        } catch {
          parsedBody = bodyText
        }
      }
      const summaryRequest = isChat && isSummaryPayload(parsedBody)
      const docAnalysisRequest = isChat && isDocAnalysisPayload(parsedBody)
      const coachRequest = isChat && isCoachPayload(parsedBody)
      const translateRequest = isChat && isTranslatePayload(parsedBody)
      const directorRequest = isChat && isDirectorPayload(parsedBody)
      const memoryRequest = isChat && isMemoryPayload(parsedBody)
      const kbEnrichRequest = isChat && isKBEnrichPayload(parsedBody)
      const kbQueryRequest = isChat && isKBQueryPayload(parsedBody)
      const kbRerankRequest = isChat && isKBRerankPayload(parsedBody)
      const planLessonsRequest = isChat && isPlanLessonsPayload(parsedBody)
      state.calls.push({
        kind: isModels
          ? 'models'
          : summaryRequest
            ? 'summary'
            : docAnalysisRequest
              ? 'docAnalysis'
              : coachRequest
                ? 'coach'
                : translateRequest
                  ? 'translation'
                  : directorRequest
                    ? 'director'
                    : memoryRequest
                      ? 'memory'
                      : kbEnrichRequest
                        ? 'kbEnrich'
                        : kbQueryRequest
                          ? 'kbQuery'
                          : kbRerankRequest
                            ? 'kbRerank'
                            : planLessonsRequest
                              ? 'planLessons'
                              : isChat
                                ? 'chat'
                                : 'other',
        method: req.method,
        url: req.url,
        path: urlPath,
        headers: { ...req.headers },
        body: parsedBody,
        at: new Date().toISOString(),
      })

      if (isModels) {
        if (state.scenario === '401') return sendJSON(res, 401, OPENAI_401)
        if (state.scenario === '500') return sendJSON(res, 500, { error: { message: 'mock /models error' } })
        if (state.scenario === 'hang') return
        return sendJSON(res, 200, {
          object: 'list',
          data: [
            { id: 'mock-model', object: 'model', created: 1700000000, owned_by: 'mock' },
            { id: 'mock-model-mini', object: 'model', created: 1700000000, owned_by: 'mock' },
          ],
        })
      }
      if (planLessonsRequest && req.method === 'POST') return handlePlanLessons(req, res, parsedBody)
      if (directorRequest && req.method === 'POST') return handleDirector(req, res, parsedBody)
      if (memoryRequest && req.method === 'POST') return handleMemory(req, res, parsedBody)
      if (kbEnrichRequest && req.method === 'POST') return handleKBEnrich(req, res, parsedBody)
      if (kbQueryRequest && req.method === 'POST') return handleKBQuery(req, res, parsedBody)
      if (kbRerankRequest && req.method === 'POST') return handleKBRerank(req, res, parsedBody)
      if (translateRequest && req.method === 'POST') return handleTranslate(req, res, parsedBody)
      if (coachRequest && req.method === 'POST') return handleCoach(req, res, parsedBody)
      if (docAnalysisRequest && req.method === 'POST') return handleDocAnalysis(req, res, parsedBody)
      if (summaryRequest && req.method === 'POST') return handleSummary(req, res, parsedBody)
      if (isChat && req.method === 'POST') return handleChat(req, res, bodyText)

      return sendJSON(res, 404, { error: { message: `mock upstream: 未知路径 ${req.method} ${urlPath}` } })
    })().catch((err) => {
      if (!res.headersSent) sendJSON(res, 500, { error: { message: String(err && err.message ? err.message : err) } })
      else res.destroy()
    })
  })

  server.keepAliveTimeout = 1000
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const origin = `http://127.0.0.1:${port}`

  const mock = {
    port,
    origin,
    url: `${origin}/v1`,
    get scenario() {
      return state.scenario
    },
    get calls() {
      return state.calls
    },
    get chatCalls() {
      return state.calls.filter((c) => c.kind === 'chat')
    },
    get modelCalls() {
      return state.calls.filter((c) => c.kind === 'models')
    },
    get summaryCalls() {
      return state.calls.filter((c) => c.kind === 'summary')
    },
    get docAnalysisCalls() {
      return state.calls.filter((c) => c.kind === 'docAnalysis')
    },
    get coachCalls() {
      return state.calls.filter((c) => c.kind === 'coach')
    },
    get translationCalls() {
      return state.calls.filter((c) => c.kind === 'translation')
    },
    get directorCalls() {
      return state.directorCalls
    },
    get memoryCalls() {
      return state.memoryCalls
    },
    get kbEnrichCalls() {
      return state.kbEnrichCalls
    },
    get kbQueryCalls() {
      return state.kbQueryCalls
    },
    get kbRerankCalls() {
      return state.kbRerankCalls
    },
    get planLessonsCalls() {
      return state.planLessonsCalls
    },
    setScenario(next) {
      state.scenario = next
      return mock
    },
    setReply(reply) {
      state.reply = reply
      return mock
    },
    setSummaryReply(summary) {
      state.summaryReply = summary
      return mock
    },
    setChineseHelp(help) {
      state.chineseHelp = help
      return mock
    },
    setDocAnalysisReply(analysis) {
      state.docAnalysisReply = analysis
      return mock
    },
    setCoachReply(feedback) {
      state.coachReply = feedback
      return mock
    },
    reset() {
      state.scenario = 'ok'
      state.reply = options.reply ?? null
      state.summaryReply = options.summaryReply ?? null
      state.chineseHelp = options.chineseHelp ?? null
      state.docAnalysisReply = options.docAnalysisReply ?? null
      state.coachReply = options.coachReply ?? null
      state.translationIndex = 0
      state.directorCalls.length = 0
      state.memoryCalls.length = 0
      state.kbEnrichCalls.length = 0
      state.kbQueryCalls.length = 0
      state.kbRerankCalls.length = 0
      state.planLessonsCalls.length = 0
      state.calls.length = 0
      return mock
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  return mock
}

// 直接执行（node test/mock-upstream.mjs）时启动一个常驻 mock 便于手工排查；
// 被 node --test 当测试文件扫描时（NODE_TEST_CONTEXT 存在）不启动。
const isCli =
  !process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
if (isCli) {
  const mock = await startMockUpstream()
  console.log(`[mock-upstream] listening on ${mock.origin} (baseUrl 填 ${mock.url})`)
  console.log('[mock-upstream] Ctrl+C 退出')
}
