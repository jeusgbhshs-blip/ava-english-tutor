# Ava — AI 数字人英语老师 · 技术契约 (v1)

> 本地单人使用的实时语音英语教学 Web 应用。**零运行时依赖**（只用 Node 24 内置模块 + 原生浏览器 API），无构建步骤、无 CDN、无外部字体。
> 本文档是团队唯一契约。任何接口/文件归属变更必须先改本文件并通知 Lead。

## 0. 运行环境

- Node：`/Users/cici/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`（v24，ESM）。PATH 无 node，所有脚本必须用绝对路径或 `start.command` 内的探测逻辑。
- 浏览器：本机 Google Chrome（`/Applications/Google Chrome.app`），localhost 属安全上下文，可申请麦克风。
- 工作目录：`/Users/cici/Documents/deepseek-harness/default-workspace/english-tutor`。
- 启动：`./start.command`（双击，或 `bash start.command`）→ 启动服务器并打开 Chrome。
- 端口：默认 **5180**，被占用则 5181、5182…；服务器把实际 URL 写入 `.runtime/url.txt` 并在 stdout 打印 `Ava ready at http://127.0.0.1:PORT`。

## 1. 目录 / 文件所有权（写作用域，严禁越界）

| 归属 | 路径 | 内容 |
|---|---|---|
| **Lead** | `server.js`, `lib/*.js`, `content/*.js`, `data/`, `package.json`, `start.command`, `SPEC.md`, `.gitignore` | 服务器、LLM 接入、内容库、配置 |
| **avatar-dev** | `web/avatar/**` | `avatar.js` `avatar.css` `preview.html` | 数字人渲染与口型引擎 |
| **app-dev** | `web/index.html`, `web/css/app.css`, `web/js/**`（除 `web/js/avatar/`） | 主界面、语音输入、教学模式 UI |
| **qa-dev** | `test/**`, `docs/**` | 测试脚本、测试报告、使用说明 |

只读共享：任何人都可读全部文件；**只写自己作用域**。发现别人文件有 bug → 发消息给 owner（附复现步骤），不要直接改。

## 2. 服务端 HTTP API（全部 `Content-Type: application/json; charset=utf-8`；仅监听 127.0.0.1）

静态文件从 `web/` 提供：`GET /` → `web/index.html`；`GET /avatar/preview.html` → 预览页。

### 2.1 配置 / 健康
- `GET /api/health` → `{ ok:true, version:"1.0.0", mode:"live"|"demo", hasKey:boolean, model, baseUrl }`
- `GET /api/settings` → `{ baseUrl, model, hasKey, keyHint, level, teacherName, voice, explainChinese, autoListen }`
  - **绝不返回 apiKey 原文**；`keyHint` 形如 `sk-…a1b2`（后 4 位）。
- `PUT /api/settings`：body 任意子集 `{ baseUrl?, model?, apiKey?, level?, teacherName?, voice?, explainChinese?, autoListen?, clearKey? }`；`apiKey` 非空才覆盖；`clearKey:true` 清空。返回同 GET。
- `POST /api/settings/test` → `{ ok:true, model, latencyMs }` 或 `{ ok:false, error }`（服务器实际请求一次上游 `/models` 或极短 completion）。

### 2.2 内容
- `GET /api/content` → `{ topics:[{id,emoji,name,desc,level,questions:[string],demoScript?}], scenarios:[{id,emoji,name,desc,level,role,opener,objectives:[string],script:[{role:"assistant"|"user",en,zh}]}], sentenceBanks:[{id,name,level,sentences:[{en,zh,focus?}]}], vocabTopics:[{id,emoji,name,level,words:[{word,phonetic,meaning,example,exampleZh}]}], levels:[...], presets:[{name,baseUrl,model}] }`

### 2.3 对话（SSE 流式）
`POST /api/chat`，body：
```json
{ "mode":"free|roleplay|vocab|pronounce", "topicId":"cafe", "scenarioId":"coffee", "level":"A2",
  "message":"I want a coffee", "history":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}],
  "focusWords":["latte"], "teacherName":"Ava" }
```
响应 `text/event-stream`，每个事件：
```
event: <type>
data: <json>

```
事件序列：
1. `meta` `{ demo:boolean, fallback?:boolean, reason?:string, model }`
2. `delta` `{ text }`（多次，累积成英文回复正文；**不含反馈 JSON**）
3. `feedback` `{ corrections:[{original,corrected,explanation_zh}], better:[{original,better,why_zh}], newWords:[{word,phonetic?,meaning,example}], encouragement_zh, followUp? }`
4. `done` `{ fullReply }`（或出错时 `error` `{message}` 后 `done`）

服务端负责从模型输出中剥离 `<<<FEEDBACK>>>` 之后的 JSON；`delta` 只发正文。无 Key 或上游失败 → 自动降级 `demo`（`meta.demo=true`，仍完整发 delta/feedback/done）。

### 2.4 跟读评分
- `POST /api/score` body `{ target, transcript, confidence? }`
  → `{ score:0-100, stars:1-5, words:[{text,status:"ok"|"close"|"miss",heard?}], tips_zh:[...], accuracy:0-1 }`
  （纯函数 `lib/score.js`，不含 I/O；QA 必须有单元测试）

### 2.5 进度
- `GET /api/progress` → `{ streak, totalTurns, totalMinutes, words:{[word]:{box,due,seen,correct}}, days:[{date,turns,minutes}], updatedAt }`
- `POST /api/progress` body `{ turns?:number, minutes?:number, reviewWords?:[{word,correct:boolean}] }` → 返回合并后完整 progress。
  - 单词复习走 `lib/srs.js`（Leitner/SM-2 简化：box 0–7，间隔天数 `[0,1,2,4,7,14,30,60]`）。

### 2.6 安全/健壮
- 所有解析失败返回 `{ ok:false, error }` + 4xx；未匹配 `/api/*` → 404。
- 请求体限 1MB；上游超时 60s；`data/settings.json` 权限 600、`.gitignore` 忽略。
- SSE 头：`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`。

## 3. 前端模块契约

### 3.1 `web/js/api.js`
```js
export async function getJSON(path, opts)
export async function putJSON(path, body)
export async function postJSON(path, body)
export function chatStream(body, handlers) // handlers: {onMeta,onDelta,onFeedback,onDone,onError}; 返回 {abort()}
export const api = { health, getSettings, saveSettings, testSettings, getContent, score, getProgress, saveProgress }
```
SSE 客户端自行解析 `event:`/`data:` 分帧（fetch + ReadableStream）。

### 3.2 `web/js/speech.js`
```js
export function createSTT(opts) // opts:{lang='en-US', onInterim, onFinal, onError, onStart, onEnd, silenceMs=1200}
// 返回 { start(), stop(), abort(), isSupported, isActive }
// Chrome webkitSpeechRecognition：continuous=true, interimResults=true；15s 自动结束需自动重启；
// 静音 silenceMs 后触达 onFinal；权限拒绝/无支持时 onError(code:'unsupported'|'denied'|...)
export const tts = {
  getVoices(), pickVoice(prefName), speak(text, {voice, rate=0.95, onStart, onWordBoundary, onEnd, onError}),
  cancel(), isSpeaking()
}
// onWordBoundary({word, charIndex, elapsedMs, name})，用 speechSynthesis onboundary 驱动口型
```

### 3.3 `web/js/store.js`
本地缓存 + 进度：`state` 单例（`{settings, content, progress, mode, level, messages, corrections, words}`）、`loadAll()`、`saveProgress({turns,minutes,reviewWords})`、`recordTurn()`。UI 状态不可放进 store 之外的全局。

### 3.4 语音→大脑→数字人 主流程（app-dev 实现）
```
点麦克风/自动听 → STT interim 上屏 → onFinal → 状态 listening→thinking
→ api.chatStream → delta 累积（字幕打字机）→ 状态 speaking：tts.speak(完整句/句段)
  + tts.onWordBoundary → avatar.wordBoundary(...) 驱动口型
→ feedback 到达 → 右侧纠正卡片 + 生词入词库 + 鼓励动画
→ done → 状态 idle/listening
```
TTS 与流式可并行：文本按句切分，完整句先播（边播边收），最后一段播完才算 speaking 结束。

## 4. Avatar 模块契约（avatar-dev）

文件 `web/avatar/avatar.js`（ESM）+ `web/avatar/avatar.css` + `web/avatar/preview.html`。
app 端在 `web/index.html` 里准备 `<div id="avatar-stage" class="avatar-stage"></div>`，然后：
```js
import { mountAvatar } from './avatar/avatar.js'
const avatar = mountAvatar(document.getElementById('avatar-stage'), { teacherName:'Ava', level:'A2', theme:'teal-violet' })
```
返回对象（全部幂等、可随时调用）：
```js
{
  setState(state),        // 'idle'|'listening'|'thinking'|'speaking'|'celebrate'|'sad'|'encouraging'
  setEmotion(name),       // 'neutral'|'happy'|'proud'|'curious'|'thinking'|'encouraging'|'surprised'
  beginSpeech({ text, durationMs? }),   // 开始口型循环；durationMs 未知时按文本估算
  wordBoundary({ word, charIndex, elapsedMs }), // TTS 边界回调，重同步口型
  endSpeech(),
  setMicLevel(level01),   // 0..1 麦克风能量：倾听光环/波形
  setLevel(cefr), setTeacherName(name),
  wave(), nod(), blink(),
  destroy()
}
```
要求：
- 纯 SVG + CSS + JS，无外部依赖/网络请求/字体；挂载后自适应容器（`ResizeObserver`），`viewBox` 等比，最小宽 260px。
- 60fps；`prefers-reduced-motion` 时关闭持续动画但保留状态变化。
- 口型至少 6 种 viseme（rest / aa / ee / o / u / m-f），边界回调缺失时按音节估算，不能静止不动。
- 表情：眨眼、眉毛、脸颊腮红、眼神跟随（倾听时看用户、思考时看上）、呼吸起伏、说话时头部轻晃；`celebrate` 撒纸屑/星光。
- `preview.html`：自包含演示页，按钮触发全部状态/表情/口型，供 QA 截图与人工验收。

### 视觉规范（两人共用）
- 深色科技感 + 暖光：`--bg-0:#05070e; --bg-1:#0a1020; --panel:rgba(17,25,44,.62); --stroke:rgba(148,163,184,.16); --text:#e9eefc; --muted:#93a3c4; --accent:#5eead4; --accent-2:#a78bfa; --warm:#ffb86b; --ok:#4ade80; --danger:#fb7185`。
- 玻璃拟态（backdrop-filter: blur(18px)）、圆角 18–24px、细描边、柔和外发光；动效 180–360ms `cubic-bezier(.22,1,.36,1)`。
- 中文字体栈：`-apple-system, "SF Pro Display", "PingFang SC", system-ui, sans-serif`；英文教学文本可用 `"SF Pro Rounded"` 备选。
- 布局 100dvh：顶部栏 60px / 中部双栏（头像舞台 1fr + 右栏 340–380px，可折叠）/ 底部控制 Dock（麦克风大按钮、字幕、状态标签）。
- 无 CDN、无 Google Fonts、无外部图片；图标全部内联 SVG。
- 移动端 <900px：右栏变底部抽屉；控制 Dock 固定底部。

## 5. 教学模式（内容由 Lead 提供，UI 由 app-dev 实现）

1. **自由对话 Free Talk**：话题卡片（咖啡店/旅行/面试/日常/兴趣…），AI 用英文引导 + 中文提示按钮。
2. **单词闯关 Vocabulary**：词卡（单词/音标/中文/例句/发音按钮）→ 跟读 → 选择题/拼写测验 → 加入错词本（SRS）。
3. **跟读打分 Pronunciation**：句子库跟读 → `/api/score` 打分星级 + 逐词高亮 + 中文发音提示。
4. **角色扮演 Role-play**：场景（咖啡店点单/机场值机/面试/酒店入住），AI 扮演对方，列出目标句，结束后给总结。

每轮对话固定动作：英文回复 → 纠正（corrections/better）→ 生词（newWords）→ 中文鼓励（encouragement_zh）。CEFR A1–C1 控速控词。

## 6. 演示模式（无 Key 也能完整跑通）

服务器无 Key / 上游失败时，用 `content/demo.js` 的脚本化回复：按 mode+topic 匹配台词，逐词流式发出，feedback 含固定纠错示例；一切 UI 功能可验收。设置页需显著引导「填入 API Key → 升级为真 AI」。

## 7. 验收标准（Definition of Done）

- `bash start.command` 一条命令起服务，Chrome 自动打开，无控制台报错。
- 无 Key：完整走通「选话题→说/输入英文→AI 英文回复（字幕+口型+朗读）→ 纠正卡片→生词记录→进度更新」。
- 填 Key 后：`/api/settings/test` 通过，真实流式回复。
- 跟读评分有 `score/stars/逐词结果/中文 tips`。
- 单词闯关：发音、测验、错词本、SRS 到期复习可跑。
- 进度面板：连续天数、总句子数、掌握单词数、最近 7 天图。
- 桌面 1440×900 + 移动 420×860 截图正常，无溢出/遮挡。
- QA：`test/api.test.mjs`、`test/e2e.mjs`、`test/ui.mjs` 全绿；`docs/测试报告.md` 有结果与截图。

## 8. 协作协议

- 任务板：各自 `team_task_get` → `claim`（带 revision）→ 完成后 `complete`。开工前 10 分钟内先回一条「已认领 + 预计首次可验收时间」给 Lead。
- 每完成一个可验证里程碑（不是全部做完才说）→ `send_message` 给 lead，写清：做了什么、文件路径、怎么验证、已知限制。
- 阻塞 >15 分钟 → 立刻发消息给 lead，不要自己猜。
- 对别人的文件只提 bug，不改。合并/最终验证由 Lead 负责。
- 语言：中文沟通；代码/注释/UI 文案中文为主、英文教学内容英文。

---

# v1.1 需求变更（2026-10-22，用户反馈，优先级高于前文）

## A. 自由对话：从「选话题」改为「数字外国朋友」

**产品定位调整**：Ava 不是话题卡机器人，而是**一个会说中文解释的、像朋友一样的数字外国人**。她有自己的性格、生活和观点，可以聊任何话题；她的目标是让用户**愿意开口说、越说越多**，顺便纠正和扩大学词汇。

硬性要求：
1. **free 模式不得锁定话题**。请求里 `topicId` 变为可选且 free 模式一律忽略；system prompt 不再注入话题卡。
2. `GET /api/content` 新增 `openers.free`（8–12 条友好开场白，随机/轮换）与 `icebreakers`（10–12 条可点的聊天灵感，如「聊聊今天」「最近在忙什么」），它们**只是建议，不是必选**。
3. free 模式 UI：不出现"选择话题"这一步；默认直接开聊；右侧面板显示「想聊什么就聊什么」+ 灵感 chips（点击填入输入框，可忽略）+「换一个灵感」；舞台胶囊显示「自由对话 · 想聊什么就聊什么」。
4. 对话历史完整传给后端（最多最近 20 条），Ava 的回复必须**承接用户刚说的内容**（先回应、再追问），可以分享自己的"生活"和观点，中英混合只在反馈 JSON 内解释。
5. free 模式顶部/底部必须有「结束对话并总结」按钮。

## B. 结束对话 → 自动总结 + 当天单词表

### B1. 新 API：`POST /api/summary`
请求：
```json
{ "messages":[{"role":"user|assistant","content":"..."}], "level":"A2", "teacherName":"Ava", "mode":"free" }
```
规则：`messages` 1–40 条，至少 1 条 user；每条 content ≤ 1500 字符。
- 有 Key：用大模型做非流式总结（严格 JSON 输出）；失败自动降级 demo 总结器，**接口永远返回可用结果**。
- 无 Key：规则化 demo 总结（关键词识别话题 + 复用纠错规则 + 词库匹配重点词）。

响应 200：
```json
{
  "ok": true, "demo": false,
  "summary_zh": "2-4 句中文总结：聊了什么 + 整体表现 + 一条具体进步点",
  "topics_zh": ["今天的工作", "周末计划"],
  "strengths_zh": ["…"], "improvements_zh": ["…"],
  "corrections": [{ "original": "...", "corrected": "...", "explanation_zh": "..." }],
  "keyWords": [{ "word": "commute", "phonetic": "/kəˈmjuːt/", "meaning": "通勤", "example": "I commute by subway.", "why_zh": "你提到了每天坐地铁，这个词更地道" }],
  "encouragement_zh": "…",
  "dailyWords": { "date": "2026-10-22", "words": [ /* 当天单词表完整数据，含历史 */ ] },
  "addedCount": 4
}
```
副作用（服务端自动完成）：
1. `keyWords` 写入**当天单词表**（按 word 去重，重复则更新释义/例句并 timesSeen+1）；
2. 同步写入 `progress.words` 作为 SRS 新词（已存在的词不重置）；
3. `keyWords` 要求 3–8 个、英文单词或 ≤3 词短语、去重、附音标/中文释义/英文例句/中文"为什么要记"；优先「用户说过但可能不熟练的词 / Ava 用过的好表达 / 话题核心词」。

### B2. 单词表持久化 API
- `GET /api/wordbook?days=7` → `{ today, totalWords, days:[{ date, label:"今天|昨天|10月20日", words:[{word,phonetic,meaning,example,why_zh?,addedAt,source,timesSeen}], count }] }`（按日期倒序，最多 60 天）
- `POST /api/wordbook` body `{ words:[...], source? }` → 追加/合并到当天单词表，返回同 GET 的完整数据。
- 存储：`data/wordbook.json`，原子写，权限 600。

### B3. 前端「今日单词表」入口
- 顶栏新增「单词本」按钮（书本图标，带当日新增数量徽标）；
- 弹窗按日期分组（今天置顶）：每条显示 word、音标、中文释义、例句、为什么要记；可点 🔊 朗读；空状态显示引导文案；
- 结束对话的总结弹窗里展示本次 keyWords，并标注「已加入今日单词表」；底部按钮「查看今日单词表 / 继续聊」。

### B4. 结束后会话
总结弹窗关闭后 = 开始新一轮对话：清空当前消息与字幕，Ava 用 `openers.free` 里的新一条打招呼；历史不跨轮次，但单词表/进度/SRS 持续累积。

## C. 其它约定
- `api.js` 新增 `summarizeConversation(body)`、`getWordbook(days)`、`addWordbook(body)`，并挂到 `api` 对象；签名见 B。
- 自由对话前端不再需要 topic 选择，但 `topics` 内容保留作为「聊天灵感」扩展位（不强制）。
- 验收追加：无 Key 时完整走「聊 3–5 轮 → 结束对话 → 看到总结卡片与重点词 → 词自动进入当天单词表与 SRS → 单词本按日期可见」；有 Key 时总结由真实模型生成且 JSON 可解析。

---

# v1.2 需求变更（2026-10-22 第二轮用户反馈，优先级最高）

用户原话要点：
1. **"还是有点所问非所答"** —— Ava 必须先正面回答/回应学生刚说的内容，不能自顾自换话题/只提问/空泛夸奖。
2. **"我用中文回复时，他需要识别出来什么意思并给我指导，而不是都夸我 very nice"** —— 用户不会说或听不懂时会用中文；Ava 必须理解中文意图，教用户用英文表达，而不是当成英文回合并乱夸。

## A. 相关性硬规则（live / demo 都适用）
1. 回复第一条动作：**直接回答或具体回应学生最新消息**。
   - 学生提问 → 必须给出真实答案（有自己的观点/偏好/经历），不能反问代替回答；
   - 学生陈述 → 必须引用/复述其具体内容再回应（"你刚说你今天被老板催 deadline…"）。
2. 禁止主动换话题、禁止答非所问、禁止用提问回避问题；追问只能放在回应之后，且与学生内容相关。
3. **禁止空洞夸奖**：不写 "very nice/good job" 等无具体理由的表扬。表扬必须具体（"这句过去式用对了"）；`encouragement_zh` 无具体观察时可为空。
4. demo 模式必须**显式声明脚本性质**：顶部「演示模式」徽标可点击直达设置页；当用户消息没有匹配到脚本场景时，前端弹出一次中文提示「演示模式只能脚本式接话，填入 API Key 后 Ava 才能真的回答你」，不要假装听懂了。

## B. 中文求助协议（核心新增）
服务端检测用户消息中的中文字符（`/[\u4e00-\u9fff]/`），命中即进入「中文求助」流程。

### B1. 说话回复（英文）要求
1. 先理解中文意图，并**用英文确认理解**（"So you're saying you were exhausted after work, right?"）。
2. 给出**用户想说的那句英文**，并邀请跟读（"In English you can say: 'I was completely exhausted after work.' Let's try it."）。
3. 然后自然地把这句英文用在对话里继续（问一个简单问题），不打断学习节奏。
4. 长度仍为 1–3 句。

### B2. feedback JSON 新增字段 `chineseHelp`（可选，命中中文时必填）
```json
"chineseHelp": {
  "original_zh": "用户原话（≤300 字）",
  "english": "地道的英文表达",
  "chunks": [{ "en": "英文意群", "zh": "中文对应" }],
  "tips_zh": "用法/发音/场景提示（中文，≤200 字）"
}
```
- 中文输入时 `corrections` 必须为空数组（中文不是英文语法错误）。
- `newWords` 可从目标英文句中挑 1–3 个词。
- 服务端 `llm.js normalizeFeedback()` 必须容忍/规范化该字段；demo 模式在下文实现规则版。

### B3. 前端
1. Dock 新增「中文求助」按钮（中/文图标）：点击后语音识别语言切到 `zh-CN`，提示「现在可以说中文，Ava 会教你怎么用英文说」；本轮识别结果发送后自动切回 `en-US`。
2. 反馈面板顶部渲染「中文求助」卡：你想说（中文）→ 英文可以这样说 + 🔊 朗读 + 意群拆解（en/zh）+ 中文提示 + 「跟我读」按钮。
3. 文本输入直接支持中文（无需切换）。
4. `speech.js` 的 `createSTT` 支持运行中切换语言：新增 `setLang(lang)`（切换 recognition.lang，必要时重启），不破坏既有 API。
5. 状态提示：中文求助进行中显示「Ava 正在教你怎么用英文说…」。

### B4. demo 模式下中文翻译的覆盖范围
- 内置 **≥30 组中文高频表达** 的规则映射（听不懂/不会说/累了/饿了/我喜欢X/我想要X/我在学英语/天气/情绪/周末…），命中即输出翻译 + 意群 + 提示；
- 未命中：诚实告知「演示模式无法逐句翻译任意中文」，给出可复用的英文求助句式（如 "What I'm trying to say is …"），并建议填入 API Key 获得真 AI 翻译；`chineseHelp.tips_zh` 里说明这一点。
- demo 对话中如果用户使用中文求助，总结时应在 `improvements_zh` 增加一条「遇到不会表达时先问 'How do you say … in English?'，再用简单英文解释」的正向建议。

### B5. 服务端 meta 事件扩展
`/api/chat` 的 `meta` 事件增加 `chinese: true|false`（是否中文求助），前端可用它切换状态文案；SSE 事件顺序不变。

## C. 总结与验收补充
- 总结 prompt：若对话中学生用中文求助过，总结需注明「遇到不会表达的地方你用中文求助，这是很好的学习策略」，并列出学会的英文表达。
- 验收：无 Key demo 下，「输入中文 → Ava 给出英文表达 + 意群 + 提示，且 corrections 为空、无不具体夸奖」；「问 Ava 一个直接问题 → 她的回复必须正面回答」；「点中文求助按钮说话 → 识别语言切换并回切」；有 Key 时由真模型生成同样结构。

---

# v1.3 需求变更（2026-10-22 第三轮用户反馈，优先级最高）

用户需求：「我有一个英文文档或者英文图片，可以上传，让 Ava 帮我分析和讲解，并且能互动。」

## A. 产品形态
新增第 5 个模式 **📄 阅读讲解 Reading**：
1. 用户上传英文材料（文档或图片）→ 服务端本地提取文字 → Ava 生成中文分析（摘要/要点/重点词汇/理解题）。
2. 用户点「开始讲解」→ Ava 用英文开场 + 逐题提问，用户用英文回答或随时提问，Ava 结合原文讲解、纠正、追问；中文求助协议照常生效。
3. 「朗读原文」用浏览器 TTS 分段朗读；重点词汇可单独听读。
4. 材料与提取文字**只保存在本机**（`data/docs/`），不上传第三方（除用户自己配置的模型 API 会收到用于讲解的文本片段）。

## B. 支持格式与提取（服务端本地，零第三方依赖）
| 类别 | 扩展名 | 方案 |
|---|---|---|
| 纯文本 | .txt/.md/.markdown/.csv/.json/.log | UTF-8 直读 |
| Office | .doc/.docx/.rtf/.odt/.html | macOS `textutil`；docx 失败时用内置 ZIP+XML 兜底 |
| 幻灯片 | .pptx/.pptm | 内置 ZIP 解析 + 逐页 `<a:t>` |
| PDF | .pdf | 内置 FlateDecode 流 + 文本算子提取（扫描版失败时提示上传截图） |
| 图片 | .png/.jpg/.jpeg/.webp/.gif/.bmp/.heic/.tif | macOS 内置 Vision OCR（JXA，离线） |

限制：单文件 ≤ 12MB；提取文字 ≤ 60k 字符（超出截断并提示）；图片 OCR 仅 macOS。
失败必须返回中文可操作提示（如"扫描版 PDF，请上传截图"）。

## C. 服务端 API
### C1. 上传
`POST /api/doc/upload`（JSON，**此路由 body 上限 20MB**）
```json
{ "name": "article.pdf", "dataBase64": "<base64>", "mime": "application/pdf" }
```
→ 200：
```json
{ "ok": true, "doc": { "id": "d_ab12cd34", "name": "article.pdf", "kind": "pdf", "chars": 5120,
  "truncated": false, "warnings": ["PDF 为自动抽取…"], "createdAt": 1690000000000, "preview": "前 400 字…" } }
```
存储：`data/docs/{id}.json` = `{id,name,kind,chars,truncated,warnings,text,createdAt,analysis?}`；不保存原始二进制。

### C2. 列表 / 详情 / 删除
- `GET /api/doc/list` → `{ok, docs:[{id,name,kind,chars,createdAt,analyzed}]}`（按 createdAt 倒序，最多 30）
- `GET /api/doc/:id` → `{ok, doc:{...包含 text 与 analysis}}`
- `DELETE /api/doc/:id` → `{ok:true}`

### C3. 分析
`POST /api/doc/analyze` body `{ id, level? }` → 200：
```json
{ "ok": true, "demo": false, "docId": "d_ab12cd34", "analysis": {
  "summary_zh": "2–4 句中文摘要（讲什么 + 适合练什么）",
  "keyPoints": [{ "en": "原文关键句", "zh": "中文要点" }],
  "keyWords": [{ "word": "collaboration", "phonetic": "/kəˌlæbəˈreɪʃn/", "meaning": "协作", "example": "Clear communication helps collaboration.", "why_zh": "文中核心词" }],
  "questions": [{ "en": "What is the main idea of the text?", "zh": "这篇文章的主旨是什么？" }],
  "readAloud": "建议朗读的原文片段（≤800 字符）",
  "wordCount": 512
} }
```
- 有 Key：大模型严格 JSON；失败/无 Key：规则化 demo 分析（词频 + 句长 + 词库匹配 + 模板题），接口永不失败。
- 结果缓存到 doc.analysis，再次 analyze 直接返回。

### C4. 互动讲解（复用 /api/chat）
`/api/chat` 新增 `mode:"reading"`，body 增加 `docId`：
- `meta` 事件增加 `doc: { id, name, kind }`；
- 服务端把「文档标题 + 前 6000 字原文 + analysis 要点/词汇/问题」注入 system prompt；
- 回复要求：结合原文讲解、引用原句、一次只问一道题、检查学生回答并纠正；中文求助协议照常；
- 无 Key demo：脚本化阅读教练（开场介绍 → 依次提问 → 对回答给反馈 → 解释重点词）；
- 缺少 docId 或 doc 不存在 → 400/404 中文错误。

## D. 前端（第 5 个 Tab「阅读讲解」）
1. 右栏：上传区（拖拽/点击，显示支持格式与大小限制）→ 上传中进度 → 最近文档列表（名称/类型/字数/时间/已分析标记）→ 选中文档的分析面板（中文摘要、核心要点、重点词汇卡带 🔊、理解题列表）+ 按钮「开始讲解」「朗读原文」「删除」。
2. 音频/交互：点「开始讲解」后自动把 Ava 的英文讲解+第一题显示到字幕并朗读；用户可回答/提问；「下一题」按钮；`readAloud` 用 tts 分段朗读。
3. 上传/分析中状态：`Ava 正在读这份材料…`；失败给中文 toast + 重试。
4. 移动端：上传区/文档列表/分析面板在 420×860 下可用、不横向溢出。
5. 交互细节：切换模式不丢当前文档；刷新页面后从 `/api/doc/list` 恢复；删除需确认。
6. 文本输入支持中文（求助协议照常）；语音照常。

## E. api.js 新增
```js
uploadDoc({ name, dataBase64, mime })   // POST /api/doc/upload
listDocs()                              // GET /api/doc/list
getDoc(id)                              // GET /api/doc/:id
analyzeDoc(id, level?)                  // POST /api/doc/analyze
deleteDoc(id)                           // DELETE /api/doc/:id
```
并挂到 `api` 对象：`api.uploadDoc/listDocs/getDoc/analyzeDoc/deleteDoc`。

## F. 验收
- 无 Key demo：上传 txt/docx/pptx/pdf/图片 各返回非空 text；分析接口返回合法 analysis；进入阅读讲解能收到开场白+第一题，回答后有反馈；总结/单词表流程不回归。
- 有 Key：分析由真实模型生成且 JSON 可解析；讲解引用原文。
- 错误路径：不支持格式/超大文件/空文件/扫描版 PDF/无文字图片 → 中文错误；缺少 docId → 400。
- 隐私：原始文件不落盘，只保存提取文字；data/docs/ 不进 Git。

---

# v1.4 需求：接入豆包实时语音模型 3.0（用户提出，优先级最高）

## A. 产品形态
新增可切换的「语音引擎」：
- **浏览器内置语音**（默认，现状不变）
- **豆包实时语音 3.0（端到端实时语音大模型）**：麦克风音频经本地服务桥接到火山引擎 WebSocket，Ava 的声音由豆包实时生成（更低延迟、更自然），字幕取识别人工与模型回复文本。

豆包模式只接管「说/听」。教学层（纠错、中文求助、生词、结束总结、单词表）仍由本应用负责：
- 每轮用户语音 final 后调用新接口 `POST /api/coach` 生成纠错/中文求助/生词卡片（文本模型，失败降级规则版）；
- 结束总结/单词表沿用 `/api/summary`；
- 豆包侧人格/相关性/中文求助行为通过会话配置 `dialog.system_role` 注入（由服务端生成，浏览器不接触密钥）。

## B. 后端
### B1. 设置扩展（`GET/PUT /api/settings`）
```json
{
  "voiceEngine": "browser" | "volc",
  "volc": {
    "appId": "…", "model": "3.0", "speaker": "en_female_dacey_uranus_bigtts",
    "endpoint": "wss://openspeech.bytedance.com/api/v3/realtime/dialogue",
    "resourceId": "volc.speech.dialog",
    "hasKey": true, "keyHint": "…abcd"
  }
}
```
- PUT 支持嵌套：`voiceEngine`、`volc.{appId,model,speaker,endpoint,resourceId}`；`volc.apiKey`/`volc.accessToken` 非空才覆盖；`volc.clearKey:true` 清空；**任何 GET 都不返回明文密钥**（keyHint 形如 `sk-…abcd`）。
- 凭据只存 `data/settings.json`（600）。

### B2. 测试连接 `POST /api/volc/test`
body 可覆盖 `{appId,apiKey,accessToken,model,speaker,endpoint,resourceId}`（缺省用已保存）→ 服务端建立 WS → StartConnection → StartSession → 等待 SessionStarted（≤20s）→ FinishSession/FinishConnection → 返回 `{ok:true, latencyMs, model, speaker}` 或 `{ok:false, error:"中文原因"}`（HTTP 200）。未填凭据返回中文提示。

### B3. 教练分析 `POST /api/coach`（豆包语音模式下用）
body `{message, level?, mode?, history?, docId?, chinese?}` → `{ok, demo, feedback:{corrections,better,newWords,encouragement_zh,chineseHelp}}`。
- 有文本模型 Key：严格 JSON「只分析不回复」；失败/无 Key 用规则版（`detectCorrections`/`buildChineseHelp`）。
- 与 `/api/chat` 的区别：不产生 Ava 的对话回复，只产出教学反馈。

### B4. 实时语音桥 `GET /ws/voice`（WebSocket，仅本机 127.0.0.1）
浏览器 ↔ 本地服务 ↔ 火山。浏览器不传密钥。
**客户端→服务端**
- 文本 JSON：`{type:'start', mode?, level?, teacherName?, docId?}`、`{type:'stop'}`、`{type:'interrupt'}`
- 二进制：16kHz mono s16le PCM，20ms = 640B 一块
**服务端→客户端**
- `{type:'ready', model, speaker, demo:false}`
- `{type:'asr', text, final}`（451/450/459）
- `{type:'chat', text, final}`（550/559）
- `{type:'audio-start'}` → 若干**二进制 24kHz mono s16le PCM 帧** → `{type:'audio-end'}`（352）
- `{type:'error', message, code?}`、`{type:'ended', reason}`
- 未配置凭据/连接失败 → 中文 `error` 并关闭；断开时清理火山会话（FinishSession/Connection）。

### B5. 新增模块（零第三方依赖）
- `lib/volcProtocol.js`：二进制协议编解码。4 字节头（版本 0b0001/头长 0b0001；消息类型 1=客户端文本、9=服务端文本、2=客户端音频、11=服务端音频、15=错误；序列化 0/1；压缩 0/1 gzip）+ event id + 可选 sequence/event/connect_id/session_id + 4 字节负载长度 + 负载。导出 `encodeEvent`、`encodeAudio`、`encodeServerEvent`（供测试 mock）、`parseFrame`、事件常量。
- `lib/volcRealtime.js`：Node 内置 WebSocket 客户端；鉴权头 `X-Api-App-Id` + `X-Api-Key`（没有 ApiKey 则 `X-Api-Access-Key`）+ `X-Api-Resource-Id`；StartConnection(1)→StartSession(100)→事件回调→sendAudio(200 音频帧)→ClientInterrupt(515)→FinishSession(102)→FinishConnection(2)；错误码/WebSocket 错误映射中文。
- `lib/wsServer.js`：零依赖 RFC6455 服务端（握手、掩码帧、分片、ping/pong、close、最大 1MB），`attachWsServer(httpServer, path, onConnection)`。
- `content/prompts.js`：`buildRealtimePersona({level,teacherName,mode,doc})`（朋友式英语老师 + 相关性/中文求助规则，**不要 JSON 输出格式**，因为实时模型直接说）；`buildCoachMessages()`（只分析不回复的严格 JSON 提示词）。

### B6. 火山会话配置（服务端生成）
```json
{
  "asr": { "audio_info": { "format": "pcm", "sample_rate": 16000, "channel": 1 } },
  "tts": { "speaker": "<设置>", "audio_config": { "format": "pcm_s16le", "sample_rate": 24000, "channel": 1 } },
  "dialog": { "bot_name": "Ava", "system_role": "<persona>", "extra": { "model": "<设置>" } }
}
```
（模型默认 `3.0`，实际版本以用户控制台为准；鉴权/资源 ID/端点均可在设置页改。若接口返回模型或音色不匹配，错误要转成中文提示。）

## C. 前端
### C1. 设置页新增「语音引擎（高级）」
- 单选：浏览器内置语音 / 豆包实时语音 3.0
- 豆包字段：App ID、API Key 或 Access Token（二选一即可）、模型版本（默认 3.0）、音色 ID（默认 en_female_dacey_uranus_bigtts）、服务地址、资源 ID；「测试连接」显示耗时/错误；保存后掩码显示，Key 只写不回显。
- 说明：豆包模式会把你的录音发送到火山引擎；需要账号已开通端到端实时语音；失败自动回退浏览器语音。
### C2. 豆包模式通话（free / roleplay 模式生效，其它模式保持浏览器 TTS）
- 点麦克风 → `doubao.start()` → `ready` 后 listening；ASR interim 上字幕；final → 记录用户消息 + 调 `/api/coach` 渲染反馈卡；`chat` 文本流式上字幕；播放 24k PCM + 数字人说话状态；打断时停止播放。
- 结束对话/总结、单词表、中文求助卡、设置/进度等既有功能保持不变。
### C3. 新增 `web/js/doubao-voice.js` + `web/js/pcm-worklet.js`
麦克风采集与 48k→16k 重采样（AudioWorklet，20ms 640B 块）；WebSocket `ws(s)://<host>/ws/voice`；PCM 播放队列（24k，可清空/打断）；回调 `onReady/onASR/onChat/onAudioStart/onAudioEnd/onLevel/onError/onEnded`；方法 `start/stop/interrupt/dispose`；`onLevel` 提供 0..1 振幅供数字人口型。
### C4. `api.js` 新增
`testVolc(config?)` → POST `/api/volc/test`；`coach(body)` → POST `/api/coach`；settings 保存时透传 `voiceEngine` / `volc`（含 key，仅提交填写过的）。

## D. Avatar 扩展
`mountAvatar()` 返回对象新增 `setSpeechLevel(level01)`：按播放音频振幅实时驱动口型（0..1），不传时行为与现状一致；不破坏既有 API。

## E. 验收
1. 无凭据：设置页可填写/保存（掩码）；测试连接返回中文错误；选豆包引擎点麦克风提示先配置；浏览器语音模式完全不受影响。
2. mock 火山 WS E2E：桥 start→ready→上行 PCM 二进制→mock 回 asr/chat/audio→客户端收到；stop/断开清理；mock 错误码 → 中文 error。
3. 有凭据人工：测试连接通过；实时语音对话可用；字幕/反馈卡/总结正常。
4. 回归：既有 141 项测试不减少；新增模块独立、设置扩展向后兼容。

---

# v1.5 需求：双语字幕 + 关闭逐轮说教（用户反馈，优先级最高）

用户原话：「我不需要他说完话以后下面告诉我我应该怎么说，我希望他说的话可以有中文字幕，然后我说的话也有中文字幕。」

## A. 双语字幕（双方）
1. Ava 的回复：英文字幕（现有）+ **中文翻译字幕**（略小、次要样式）。
2. 用户的话：英文识别字幕 + **中文翻译字幕**（用户说中文时，中文为原文、英文为翻译）。
3. 翻译服务 `POST /api/translate`：body `{texts:[string], target:'zh'}`（1–8 条，每条 ≤500 字）→
   `{ok:true, texts:[string|null], provider:'volc'|'llm'}`；失败返回 `{ok:false,error}`，前端**静默降级为只显示英文**，不弹错误。
4. 翻译来源优先级：
   - a) 已配置豆包凭据：服务端复用「文本模式」实时语音会话（`dialog.extra.input_mod='text'`、`output_modalities:['text']`、系统提示为翻译器）做英译中（不产生语音）；
   - b) 已配置文本模型 Key：用文本模型翻译；
   - c) 都没有：返回 ok:false，前端只显示英文。
5. 前端行为：
   - 用户语音 final / 文本消息发送后 → 调翻译并把中文显示在用户字幕第二行；
   - Ava 回复结束（引擎各自完成信号）后 → 调翻译并显示回复中文第二行；
   - 流式期间中文可稍晚出现（不阻塞英文/语音）；翻译失败不影响对话；
   - 桌面与 420×860 移动端布局不溢出。

## B. 关闭逐轮「你应该怎么说」提示（自由对话语音体验）
1. 语音引擎为「豆包实时语音」时，free / roleplay 模式**不再调用 `/api/coach`、不渲染纠错/更好的说法/生词/鼓励卡片**（即 Ava 说完话下面不再出现"你应该这样说"）。
2. 例外：用户主动用**中文**说话/打字求助时，仍可显示「中文求助」卡（用户明确求教时才出现）。
3. 结束对话总结、今日单词表、进度保持不变（总结里仍有纠错与重点词）。
4. 浏览器语音引擎的行为保持不变（仍可选逐轮反馈），避免破坏现有教学能力。
5. 右上教练面板在豆包语音会话期间显示简洁占位（如「专注对话模式：结束对话后可看总结」），不显示逐轮纠错。

## C. 验收
- 有豆包凭据：真实 `/api/translate` 英译中成功（服务端文本会话，无 TTS 音频）；无凭据/失败时前端只显示英文，无报错弹窗。
- 豆包语音模式：一轮英文对话后**不出现**纠错/建议卡；双方字幕均有中英文两行；结束对话总结正常。
- 浏览器语音模式回归：原逐轮纠错功能不受影响；既有 180 项测试不减少。

---

# v1.6 需求：Midoo 式手机网页版（角色卡 + 视频通话页 + AI 管家）

用户确认：**不做原生 App，用网页实现**；角色由 Lead 直接设定（3 个：2 个真人风女性 + 1 个二次元；不同城市/性格/标签/音色）。新交互先挂在 `/mobile`（手机优先），旧版 `/` 保持不变，验收后再切换默认入口。

## A. 角色设定（固定）
| id | 名字 | 城市 | 身份 | 性格标签 | 形象风格 | 豆包音色 | 场景 |
|---|---|---|---|---|---|---|---|
| elena | Elena（艾莲娜） | 伦敦 | 27 岁画廊策展人 | 温柔 / 艺术 / 下午茶 | 半写实女性（暖色画廊、风衣、盘发） | en_female_dacey_uranus_bigtts | 在画廊聊艺术 / 英式下午茶 / 伦敦街头问路 |
| maya | Maya（玛雅） | 纽约 | 29 岁广告创意总监 | 直爽 / 幽默 / 职场 | 半写实女性（干练短发、纽约 loft/霓虹窗景） | en_female_stokie_uranus_bigtts | 纽约咖啡店点单 / 创意提案会议 / 健身房偶遇 |
| hikari | Hikari（光） | 东京 | 20 岁虚拟偶像练习生 | 元气 / 二次元 / 游戏 | 二次元（粉发、霓虹街头/游戏房） | zh_female_vv_jupiter_bigtts | 秋叶原逛店 / 游戏语音房 / 漫展聊天 |

形象素材：`web/assets/characters/{elena,maya,hikari}.svg`（900×1350，含柔和背景；avatar-dev 产出）。P0 使用 **CSS 微动**（缓慢推拉/呼吸/光效/说话状态波纹），P1 再换实时视频数字人。

## B. 新增后端 API
1. `GET /api/characters` → `{ok, characters:[{id,name,city,style,tags,voiceLabel,cover,greeting,scenes:[{id,label,emoji}],level}]}`（不返回人设 prompt 全文）
2. `GET /api/characters/:id` → 同上单个
3. `GET /api/plan` → `{ok, plan}`；plan=`{id,characterId,goal,level,createdAt,stages:[{id,title,emoji,progress,scenes:[{characterId,sceneId,label}]}],updatedAt}`；未创建返回 `{ok:true, plan:null}`
4. `POST /api/assistant` body `{message, characterId?, history?}` → `{ok, demo, reply, actions:[{type,payload}]}`
   - actions 类型：`create_plan`(payload=plan)、`update_plan`、`open_scene`({characterId,sceneId})、`open_tab`({tab})、`review_words`
   - 有豆包凭据时用「文本模式」实时会话（复用 translator 的机制）生成回复+意图；失败/无凭据走规则版（关键词识别+模板回复），接口永不失败。
5. `/ws/voice` 的 `start` 帧支持 `characterId`：服务端用该角色的人设+音色建立实时语音会话；`meta` 增加 `character:{id,name,voiceLabel}`。
6. `/api/chat` 支持 `characterId`：system prompt 使用角色人设，demo 回复带角色口吻（文本输入路径使用）。
7. `GET /mobile` 与 `/mobile.html` 返回新手机壳页面；`/` 保持旧版不变。

## C. 前端（新文件，手机优先）
`web/mobile.html` + `web/css/mobile.css` + `web/js/mobile/*.js` + `web/manifest.webmanifest`。
1. **底部 5 Tab**：课程 / 对话 / 助手(Ava) / 趣玩 / 我的（避免直接使用 Midoo 商标，助手叫「Ava 助手」）。
2. **对话页**：角色卡横滑画廊（大图 + 名字 + 城市 + 性格标签 + 「去聊聊」+ 分页圆点）；点击进 **全屏通话页**：
   - 角色形象全屏 + CSS 微动（slow zoom/呼吸/光晕），说话时加"正在说话"光效/波纹；
   - 顶部：返回/挂断 + 通话计时 + 信号电量图标 + 场景标签（可换场景）；
   - 中下部：双方气泡 + 中英双语字幕（复用 /api/translate）；
   - 底部：长按/点击说话、文字输入切换、提示按钮、静音/翻译开关；
   - 结束通话 → 总结弹层（复用 /api/summary：复盘/纠错/重点词入今日单词表）；
   - 语音走现有 `/ws/voice` 桥 + 豆包实时语音（characterId 指定角色音色）；文本走 `/api/chat`（带 characterId）。
3. **助手页**：`Hi, 我是 Ava 我能为你做什么？` + chips（创建计划/更新我的计划/快速复习/场景练习/学习偏好/我要反馈）+ 输入框；点 chip 或发消息 → `POST /api/assistant` → 渲染回复 + 根据 actions 跳转/刷新课程计划。
4. **课程页**：展示 `/api/plan`（阶段进度、讲解/练习/情景对话入口）；无计划时引导去助手创建；点场景 → 通话页指定角色/场景。
5. **趣玩页**：先做 1 个可玩小游戏（词义配对/听音选词），其余为「即将上线」卡片。
6. **我的页**：昵称/等级/学习目标/语音引擎状态（复用 /api/settings）、今日单词数、订阅占位。
7. **PWA**：manifest（name/short_name/icons/display:standalone/theme_color）+ `<meta name="apple-mobile-web-app-capable">`；手机「添加到主屏幕」可全屏运行。
8. 手机优先：390×844 / 430×932 无横向溢出，安全区适配；桌面居中显示（可选手机边框预览）。

## D. 验收
- `/mobile` 在 Chrome 手机尺寸下：5 Tab 可切；3 个角色卡展示；点击进通话页可建立豆包语音（角色音色不同）；说话后中英字幕+气泡；结束通话出总结；助手页 chips 可创建计划并在课程页展示；趣玩小游戏可玩；PWA manifest 可被识别。
- 旧版 `/`、既有 190 项测试不回归（新功能独立文件/新增接口）。
- 真实环境：用户豆包凭据保留；不修改 `data/settings.json` 的已有配置（仅新增 plans.json）。

---

# v1.7 方向修正（用户反馈，最高优先级）

用户原话：「不要做这种像手机端的页面……把它扑到整个网页那种像游戏画面」「你的人物太丑了，我给你发……就按照那些人物去做」「人物动起来像真人口播」「三个人物角色的样子，按照我给你这三张人物例严格执行，不要做任何人物修改」。

## A. 形态：整屏游戏化网页（不是手机壳）
- `/mobile` 去掉 phone-shell / 限宽 / 手机边框；`#app` 占满 **100vw × 100dvh**，桌面（1440×900、1920×1080、1280×800）为主要验收尺寸，430 宽仍可用。
- 布局按"游戏画面"设计：全屏人物场景 + HUD（角色名/城市/计时/信号/场景标签）+ 底部对话框 + 右下操作；课程/助手/趣玩/我的为整屏面板，不是手机卡片堆叠。
- 5 个 Tab 用游戏 HUD 风格导航（可键盘 1–5）。

## B. 人物：严格使用用户提供的三张插画（不得改画）
| 角色 | 素材 | 设定 |
|---|---|---|
| Elena | `web/assets/characters/elena.jpg`（金棕卷发/白花礼服/金色阳光） | 伦敦 · 画廊策展人 · 温柔/艺术/下午茶 |
| Maya | `web/assets/characters/maya.jpg`（蓝发/水晶礼服/深蓝森林） | 纽约 · 广告创意总监 · 直爽/幽默/职场 |
| Hikari | `web/assets/characters/hikari.jpg`（银蓝发/冰晶花饰/冷光） | 东京 · 虚拟偶像练习生 · 元气/二次元/游戏 |

原图（1448×1086）保留在 `docs/assets/characters/source/`；前端只允许 cover 裁切、暗角、光晕等 UI 处理，**不得改人物长相/颜色/造型**。

## C. 口播动画（P0 客户端；P1 真视频数字人）
- P0：`web/js/talking-head.js`（WebGL 局部形变，不修改素材）：呼吸/头部轻摆/眨眼/说话口型（motion.json 标定嘴眼坐标，`setSpeechLevel` 驱动）。目标观感：像真人对镜头口播。
- P1（下一步，需用户选服务）：实时视频数字人（Spatius / D-ID / LiveAvatar / 火山/腾讯云数智人 的 Web SDK，LITE 模式只出脸、声音继续豆包、保留教学层）；或把三张插画做成 Live2D/VRM 分层模型做真口型（观感更"游戏"，工作量大）。

---

# v1.8 需求：自由发散对话 + 个人知识库（方案二）

用户反馈：「人物永远是重复的几个问题，不会发散，强硬围绕几个话题」「下午茶/职业这些标签应该只是环境/属性，不是必须聊的主题」「要上传我感兴趣的文章/杂志，围绕它讨论；也不一定按文章，可以构建相对完整知识库 + 发散思维」。

## A. 对话引擎（身份=视角，不是话题）
1. **人格改造**：角色身份（伦敦画廊策展人/纽约创意总监/东京偶像）只作为**看世界的视角、语气、知识偏好**；禁止主动把话题拉回职业/爱好；只有用户主动问起才聊。
2. **对话导演（Director）**：每轮先规划再回复——输入用户最新消息+最近 8 轮+兴趣档案+知识库片段 → 输出 JSON `{angle, stance, question, avoid, hook, kbUse}`（angle 从：用户细节/反例/联想/个人故事/知识关联/观点碰撞 中选）；主回复按规划生成，禁止重复最近问过的问题。
3. **反重复/发散规则**：每轮最多 1 个问句；不复述用户原话；不空泛夸奖；给出具体观点/例子/经历；用户岔开话题立刻跟随；每 3 轮至少 1 次用户主导；用 memory.topics/avoid 去重。
4. **记忆**：`data/memory.json`（按角色）：interests、facts、topics(最近/频次)、最近对话摘要；每轮/每 8 轮异步更新；跨会话生效；`/api/profile` 可读改兴趣。
5. **豆包实时语音**：start 支持 `kbDocIds/kbMode`；persona 注入「视角化身份 + 用户兴趣/历史话题 + 知识库要点摘要 + 反重复规则」；voice 模式先覆盖"身份环境化+记忆"，逐轮导演在文字模式先落地（语音后续版本）。
6. **聊天大脑**：DeepSeek（`deepseek-chat`，已配置）→ live 模式；无 Key 才回退 demo。

## B. 知识库（本地私有，不上传第三方）
1. **导入**：文件上传（txt/md/csv/doc/docx/rtf/pptx/pdf/png/jpg 等，复用 docExtract）；**网页链接导入**（抓取 HTML→正文提取→标题）；支持中英文混合。
2. **处理**：切块（约 700 字、重叠 120，按段落/标题）；每块异步生成摘要+关键词（DeepSeek，失败保留原文）；存 `data/kb/{id}.json`，列表 `data/kb/index.json`。
3. **检索**：混合检索 = 查询扩展（DeepSeek 生成同义/关联词）+ BM25（原文+关键词+摘要）+ LLM 重排 top 12→top 4-6；返回带 docId/chunkId/标题/片段/score 以便引用。
4. **讨论模式**（`/api/chat` 新增 `kbMode`）：`free`（自由聊，KB 可选参考）/`grounded`（围绕知识库，必须引用原文，可对比多篇）/`divergent`（以 KB 为起点发散：联想/反例/跨领域/辩论，可超出原文）。
5. **API**：`POST /api/kb/upload`、`POST /api/kb/url`、`GET /api/kb/list`、`GET /api/kb/:id`、`DELETE /api/kb/:id`、`POST /api/kb/search`、`POST /api/kb/:id/enrich`、`GET/PUT /api/profile`。
6. **前端**：助手页新增「知识库」入口→全屏面板（文件上传/网页导入/文档列表/删除/多选/状态）；通话页新增模式切换（自由聊/知识库讨论/发散讨论）+ 引用卡片（文章标题+片段，可展开）；「我的」显示/编辑兴趣标签。
7. 数据只存本机 `data/kb`、`data/memory.json`；DeepSeek 调用可能包含用户消息/文档片段（用户已知并同意）。

## C. 验收
- 同一角色连续聊 10 轮：不重复最近问题；能跟随用户话题；身份标签不再强行出现；至少出现 2 次新角度。
- 上传中英文章/网页 → 列表可见 → 围绕讨论能引用原文（引用卡片可见）→ 发散模式能延伸出文章外观点。
- 旧版 `/` 与既有测试不回归；真实 settings 的 DeepSeek/火山凭据保留；报告 v2.1。

---

# v2.7 需求：讲解资料对照窗（方案A）+ 单词复习系统（A+C，第6个Tab）

用户确认：
- ① 讲解时看资料窗口选 **A**：桌面右侧玻璃资料栏（人物不被遮挡）、手机底部抽屉，自动跟随讲解高亮对应段落，可收起。
- ② 单词复习选 **A + C**：双库（生词本/已掌握）+ 间隔重复 SRS + 游戏化复习；入口为**底部第 6 个 Tab「复习」**；要**每日复习提醒**；单词支持**点击发音**；生词库可**自己加入/删除/改状态**。

## A. 讲解资料窗口（call page）
1. 仅当 call 带 `kbDocIds`（知识库讨论/发散）显示入口；进入知识库讨论模式默认展开。
2. 桌面：人物世界层缩为左侧 62%，右侧 38% 半透明玻璃资料栏（不覆盖人物）；手机：底部抽屉约 42% 高度，人物上移/缩放，可上下滑动收起。
3. 内容：所选材料标题 tabs；按段落渲染原文（分块）；顶部「跟随讲解」开关（默认开）：
   - 收到 `meta.kb.hits[].chunkId` 时，自动高亮并滚动到对应块（引用 [1] 可点击跳转）；
   - 手动滚动后暂停跟随，直到重新点击「跟随讲解」或点击引用。
4. 工具：字号 A-/A+、原文/要点（要点=该块 summary，若有）、收起/展开、关闭；空材料/加载失败中文提示；不影响语音/字幕/引用卡片/总结。
5. 复用 `GET /api/kb/:id` 获取 chunks；无新后端要求（可选加轻量 content 接口）。

## B. 单词复习系统（第 6 个 Tab）
1. **数据**：`data/review.json`（本地）words 字典：word/phonetic/meaning/example/source/sourceTitle/status(new|learning|known)/interval/ease/due/reps/lapses/createdAt/updatedAt。
2. **API**：
   - `GET /api/review/summary` → dueCount/total/newCount/learningCount/knownCount
   - `GET /api/review/due?limit=` → 今日到期词列表（due<=now，按 due asc）
   - `GET /api/review/list?status=all|new|learning|known&q=&limit=` → 词库列表+counts
   - `POST /api/review/add` `{words:[{word,meaning,phonetic,example,source,sourceTitle,status?}]}` → 手动/批量加入（upsert）
   - `PATCH /api/review/word` `{word,patch:{meaning,phonetic,example,status,source...}}` → 编辑/改状态
   - `DELETE /api/review/word?word=` → 删除
   - `POST /api/review/grade` `{word,grade:'again'|'hard'|'good'|'easy'}` → SRS 更新并返回该词+summary
   - **自动收录**：`POST /api/summary` 生成 keyWords 后，同步 upsert 到 review（source=conversation，status=new，due=now）。
   - 所有接口不因存储异常 500；前端失败静默/中文提示。
3. **SRS**：again→due=now+10min、ease-0.2、lapses+1、status=learning；hard→interval=max(1,interval*1.2) 天；good→reps=0 时 1 天，否则 interval*ease；easy→interval*ease*1.3（easy 连续 3 次以上可置 known）。interval 上限 365 天。
4. **UI（第 6 个 Tab「复习」）**：
   - 首页：今日待复习 N（大按钮「开始复习」）、生词 X / 掌握 Y、每日提醒（当天首次进入且 due>0 弹 toast + Tab 徽标）；
   - 复习会话：卡片显示单词 + 🔊 发音（点词/喇叭朗读，浏览器 TTS）、翻转显示音标/释义/例句/来源；底部 4 档按钮（不认识/模糊/认识/简单）；进度 x/y；结束页统计；
   - 词库管理：「生词本 / 已掌握 / 全部」筛选 + 搜索；每词：发音、释义、来源、状态按钮（加入生词本/标为掌握）、删除；新增单词表单（word/释义/例句可选）；
   - 小游戏（C）：词义配对（已有可复用）、听音选词（点 🔊 选正确英文）、拼写填空；至少 2 个可玩；失败/完成反馈；用复习库单词。
   - Tab：底部 HUD 新增第 6 个「复习」，带 dueCount 徽标；键盘 1–6；移动/桌面不溢出。
5. **提醒**：`GET /api/review/summary` 在 App 初始化/切到复习 Tab 时调用；due>0 且当天未提醒过（localStorage 日期）→ toast「今天有 N 个单词要复习」+ Tab 徽标。
6. 发音：点击单词/喇叭调用浏览器 TTS（en-US）；不对每个词自动播放。

---

# v3.0 需求：课程-场景教学闭环（数字人当老师）

用户确认：
1. 教学方式：**她说一句、我说一句（逐句跟读）**；
2. 每课常用句 **4–5 句**；
3. 完成 **3 个教学步骤**（跟读 → 场景练习 → 挑战）即算完成；
4. 阶段解锁：**完成前一阶段才能进入下一阶段**；
5. 先做 **Elena 的 3 个场景（画廊 / 下午茶 / 问路）**，验证闭环；
6. 进度条只显示「**场景完成比例**」。

## 数据/后端（已实现）
- `content/lessons.js`：Elena 3 课，每课 objectives + 5 句常用句（en/zh）+ 3 步 + teacherIntro/taskPrompt。
- `lib/plans.js` v2：每阶段 1 节课（3 阶段顺序解锁）；进度 = 已完成场景数 / 场景总数；`decoratePlan` 返回 progress/stages[].progress/done/unlocked/next/allDone；`completeScene` 要求 lesson 场景 `stepsCompleted>=3` 才完成，并拒绝未解锁阶段；旧计划自动迁移。
- `GET /api/plan` → `{ok, plan(decorated v2), lessons:[publicLesson]}`；`GET /api/lessons`、`GET /api/lessons/:id`；`POST /api/plan/scene-done {characterId,sceneId,stageId,lessonId,stepsCompleted}` → `{ok,completed,reason,requiredSteps,plan,next,lessons}`。
- Prompt：`buildLessonBlock`（老师模式：逐句教/等待跟读/场景任务/挑战），文字 `buildSystemPrompt` 与 `buildRealtimePersona` 均支持 lesson/lessonStep。
- 实时语音 start 帧与 chat body 透传：`sceneId/lessonId/stageId/lessonStep`。

## 前端（本轮实现）
- 课程页：整体/阶段进度条按场景完成比例；阶段锁定态（锁图标、完成上一阶段解锁）；场景卡显示「已完成 ✓ / 可开始 / 复习」+ 本课目标与常用句预览；「继续学习」打开 `plan.next`；点场景以 lesson 模式进入通话；助手创建计划后跳到课程页并提示开始第一课。
- 通话页 lesson 模式：
  - 本课面板：标题/3 步进度（跟读→场景练习→挑战）/本课目标/5 句常用句（点 🔊 朗读、当前句高亮）；
  - 步骤推进：step1 逐句跟读判定（ASR 相似度，2 次失败自动通过避免卡住）→ step2 场景练习（≥2 轮）→ step3 挑战（≥2 轮或用到目标句）→ 完成；
  - 完成时 POST scene-done（stepsCompleted=3），更新进度、弹「本课完成」结算卡（学会的常用句/进度/下一课/返回课程）；
  - 支持「自由聊」退出上课模式；文字输入与语音输入都参与步骤判定。

---

# v3.1 需求：学习计划改为用户自定义（固定3节）+ 自选老师 + 角色原声点读

用户确认：
- 计划不再绑定数字人预设场景；用户自由文本描述想学什么 → AI 生成计划（**固定 3 节课**，用户不选数量）；
- 计划生成后在课程页出现；**整份计划统一选一个老师**（Elena/Maya/Hikari，可随时换）；角色只提供人设+音色；
- 每节课 AI 生成 5 句常用句 + 3 步教学（跟读→场景练习→挑战）；
- 现有 Elena「画廊/下午茶/问路」示例课**删除**；
- 音色：接豆包独立 TTS，让点读/兜底朗读使用角色原声（Hikari 旧 1.0 音色资源不匹配 → 映射英语教师兼容音色）。

## 数据/后端（Lead 已实现）
- `lib/plans.js` v3：plan {version:3, teacherId/teacherName, goalText, level, title, stages[3]{id,title,emoji,lessonId}, lessons{id:{title,topic,objectives[],phrases[5],steps[3],taskPrompt,teacherIntro,status:generating|ready|error,done}}, progress/doneLessons/allDone/next/generating/hasError}；进度=课完成/3；顺序解锁；`completeLesson` 必须 stepsCompleted>=3；旧 v1/v2 计划清空。
- `lib/lessonGen.js`：后台调用 DeepSeek 生成 3 节课 JSON（`buildPlanLessonsMessages`），写回 plan；失败标 error 可重试。
- 路由：`GET /api/plan`（自动续跑生成）、`PATCH /api/plan/teacher`、`POST /api/plan/generate`、`GET /api/lessons`、`POST /api/plan/scene-done {lessonId,stageId,stepsCompleted}`；`POST /api/assistant` 自由文本 → 创建 v3 计划并后台生成。
- `lib/tts.js` + `POST /api/tts {text,characterId}`：豆包 seed-tts-2.0 HTTP 流式合成 mp3，按 speaker+text 缓存；Elena=dacey、Maya=stokie、Hikari→zh_female_yingyujiaoxue_uranus_bigtts；`GET /api/tts/voices` 诊断。
- prompts：`buildLessonBlock` 继续用于生成课件；chat/实时语音按 plan lesson 解析，characterId=当前老师。

## 前端
- 课程页：空态/生成中骨架轮询/错误重试/ready 课程卡（目标+常用句展开+🔊原声）/老师选择器（PATCH 整计划）/继续学习/进度比例/顺序解锁。
- 对话页与通话页：移除角色预设场景（不再显示场景 chips/切换）。
- 通话页：lesson 面板沿用；点读/文字兜底走 `/api/tts` 角色原声；完成上报 v3 body；结算卡下一课。
- `web/js/mobile/voice-audio.js`：playCharacterText/stop/角色 pitch 兜底。
