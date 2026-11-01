# 02 · 模块地图

> 规则：`lib/` 只跑在 Node；`web/js/mobile/` 只跑在浏览器；`content/` 两边共享（静态 JS）；`server.js` 是唯一的 HTTP/WS 入口。

## 1. 目录树

```
english-tutor/
├─ server.js                    本地 HTTP + SSE + WebSocket 桥入口
├─ start.command                macOS 一键启动
├─ scripts/share.sh             LAN 分享实例（独立 data-share/）
├─ package.json                scripts 只有 start/dev/test/test:e2e/test:ui
├─ content/                    静态内容与 prompt（服务端/前端共享）
│  ├─ characters.js            Elena / Maya / Hikari 人设、音色、场景
│  ├─ scenarios.js             自由聊话题、角色场景、句型库
│  ├─ vocab.js                 词库主题
│  ├─ openers.js               开场白/破冰句
│  ├─ prompts.js               所有 LLM prompt 构造函数（核心）
│  ├─ demo.js                  无 Key 演示回复（保证体验）
│  └─ index.js                 /api/content 聚合
├─ lib/                        服务端领域模块
│  ├─ config.js                路径、默认设置、settings.json 读写
│  ├─ llm.js                   OpenAI-compatible 流式聊天 + feedback 解析
│  ├─ llmJson.js               严格 JSON 调用封装
│  ├─ assistant.js             助手意图/计划动作
│  ├─ coach.js                 语音模式教练分析（JSON）
│  ├─ director.js              对话导演（free/roleplay 的角度规划）
│  ├─ lessonGen.js             AI 生成 3 节课课件
│  ├─ plans.js                 计划数据结构、进度、解锁、断点
│  ├─ summary.js               对话总结（重点词/句型/纠错）
│  ├─ score.js                 跟读评分（编辑距离/音近）
│  ├─ review.js                复习词库 + SRS 评分
│  ├─ srs.js                   Leitner 间隔重复核心
│  ├─ progress.js              学习统计/连续天数
│  ├─ memory.js                用户兴趣 + 角色长期记忆
│  ├─ wordbook.js              按天单词表
│  ├─ translator.js            中英翻译（带缓存/去重）
│  ├─ tts.js                   豆包独立 TTS + 分块 + 缓存
│  ├─ kb.js                    知识库 chunk/BM25/检索/摘要增强
│  ├─ docExtract.js            PDF/Word/PPT/图片/txt 原生提取 + macOS OCR
│  ├─ docStore.js              旧“阅读讲解”文档存储（/api/doc）
│  ├─ docAnalysis.js           文档分析 JSON
│  ├─ volcProtocol.js          火山实时语音二进制协议编解码
│  ├─ volcRealtime.js          火山实时语音会话客户端
│  └─ wsServer.js              手写 WebSocket server + 心跳
├─ web/
│  ├─ mobile.html              当前主页面（5 Tab + 通话 + KB + 弹层）
│  ├─ index.html               早期桌面版（保留）
│  ├─ assets/                  角色图片/图标/分层素材
│  ├─ css/
│  │  ├─ mobile.css            手机版基础布局
│  │  ├─ review.css            复习 + 小游戏单屏布局
│  │  ├─ glass.css             全站毛玻璃/资料窗/我的
│  │  ├─ call-redesign.css     通话页方案 C
│  │  └─ library.css           英语书库
│  ├─ js/
│  │  ├─ mobile/               当前主前端（见下）
│  │  ├─ api.js                旧桌面版 API 封装
│  │  ├─ speech.js             浏览器 STT/TTS（移动端已关闭浏览器 TTS）
│  │  ├─ main.js/modes.js/ui.js/store.js/talking-head.js/avatar/  旧桌面版
│  │  └─ pcm-worklet.js        麦克风 16k PCM worklet
│  ├─ avatar/                  旧桌面版数字人渲染实验
│  └─ design-preview/          早期设计预览 HTML（不参与运行）
├─ test/
│  ├─ api.test.mjs             API/领域单元测试
│  ├─ e2e.mjs                  端到端测试
│  ├─ ui.mjs                   UI/截图测试
│  ├─ mock-upstream.mjs        Mock LLM/上游
│  ├─ mock-volc-realtime.mjs   Mock 火山实时语音
│  └─ fixtures/                测试文档/图片/PDF
├─ data/                       个人运行数据（gitignore）
├─ data-share/                 LAN 分享数据（gitignore）
└─ docs/                       使用说明、测试报告、本交接包
```

## 2. 服务端模块职责

| 模块 | 职责 | 主要导出 / 使用方 |
|---|---|---|
| `server.js` | HTTP 静态/SPA、API 路由、SSE chat、Voice WS 桥、启动参数、优雅退出 | 全部 |
| `lib/config.js` | `ROOT/DATA_DIR/WEB_ROOT`、默认设置、settings 归一化/读写/打码、环境变量覆盖 | 所有服务端模块 |
| `lib/llm.js` | OpenAI-compatible `/chat/completions` 流式请求、SSE extractor、feedback marker 解析、错误友好化 | `server.js`、`assistant.js`、`coach.js`、`summary.js`、`director.js` |
| `lib/llmJson.js` | 要求模型返回纯 JSON 的封装（计划生成/记忆/文档分析等） | `lessonGen.js`、`memory.js`、`docAnalysis.js` |
| `lib/assistant.js` | 助手意图识别（创建/更新计划等）、回复组装 | `/api/assistant` |
| `lib/coach.js` | 实时语音模式的纠错分析（feedback JSON） | `/api/coach` |
| `lib/director.js` | free/roleplay 每轮“导演计划”（角度/问题/避免重复） | `/api/chat` 的 free/roleplay |
| `lib/plans.js` | 计划树、3 节课、阶段解锁、断点 progress、完成状态 | `/api/plan*`、`lessonGen`、call |
| `lib/lessonGen.js` | 后台调用 LLM 生成 3 节课；状态机/轮询 | `/api/plan/generate`、`/api/characters` 后 |
| `lib/summary.js` | 挂断总结：重点单词、重点句型、纠错、鼓励；quick 规则版 | `/api/summary`、`/api/summary/quick` |
| `lib/score.js` | 跟读评分：分词/编辑距离/音近/提示 | `/api/score` |
| `lib/srs.js` | SRS 盒子间隔 | `review.js`、`progress.js` |
| `lib/review.js` | 复习词库 CRUD、四档评分、summary 同步 | `/api/review/*` |
| `lib/progress.js` | 学习分钟/轮次/连续天数/单词进度 | `/api/progress` |
| `lib/memory.js` | profile 兴趣 + 按角色长期记忆；写 prompt 文本 | `/api/profile`、chat、voice、summary |
| `lib/wordbook.js` | 按天单词表，去重/计数/7 天视图 | `/api/wordbook`、summary |
| `lib/translator.js` | 中文翻译、缓存、批量/去重；失败静默 | `/api/translate`、前端字幕 |
| `lib/tts.js` | 豆包独立 TTS、speaker 兼容、长文本分块、mp3 缓存 | `/api/tts`、call 资料模式 |
| `lib/kb.js` | KB 文档 CRUD、chunk、BM25、语义/关键词检索、摘要 enrich、教学材料 | `/api/kb/*`、chat、voice |
| `lib/docExtract.js` | 文件类型识别、txt/md/csv/docx/pptx/pdf 文本提取、图片 OCR | `/api/kb/preview-file`、`/api/kb/upload` |
| `lib/docStore.js` | 旧版阅读文档 `data/docs/`（与 KB 不同） | `/api/doc/*` |
| `lib/docAnalysis.js` | 阅读材料分析 JSON | `/api/doc/analyze` |
| `lib/volcProtocol.js` | 火山二进制 frame 编解码/事件常量 | `volcRealtime.js`、测试 mock |
| `lib/volcRealtime.js` | 建立/维护火山 WSS，事件回调，测试连接 | `server.js` voice 桥 |
| `lib/wsServer.js` | 手写 WebSocket server（握手/帧/ping） | `server.js` |

## 3. 前端 mobile 模块

| 文件 | 职责 | 关键导出 / 依赖 |
|---|---|---|
| `web/mobile.html` | DOM 骨架：5 个 screen、通话页、KB 整屏、弹层、图标 sprite、脚本入口 | 所有 CSS/mobile 模块 |
| `js/mobile/app.js` | 启动、Tab 路由、history 返回栈、sheet、通话入口、ui 注册、`window.__avaMobile` | `core`、`screens`、`call`、`kb`、`review` |
| `js/mobile/core.js` | 共享 `$`/`esc`/`icon`/`toast`、`M` 全局状态、API 包装（api.js）、角色/计划/设置加载、`ui` 注册表 | 所有 mobile 模块 |
| `js/mobile/screens.js` | 课程/对话/助手/复习/我的 渲染；计划创建/老师切换/进度；助手对话 | `core`、`review`、`library` |
| `js/mobile/call.js` | 最大模块：通话页 DOM/状态机/PTT/实时语音/文本聊天/资料窗/课程/总结/口播 | `core`、`doubao-voice`、`voice-audio`、`speech` |
| `js/mobile/kb.js` | 知识库整屏：上传/URL/粘贴/图片校对/列表/多选/讨论入口；英语书库卡片 | `core`、`library` |
| `js/mobile/library.js` | 6 本书每日节选、进度 localStorage、入库、开课、完成、词同步 | `book-library.js`、`core` |
| `js/mobile/book-library.js` | 6 本公版书静态数据（每本 5 天文本 + 重点词/句型） | 无 |
| `js/mobile/review.js` | 复习首页/会话/词库管理/三款游戏/每日提醒；localStorage 进度 | `api`、`core`、`voice-audio` |
| `js/mobile/games.js` | 旧“趣玩”词义配对（部分逻辑被 review 内联游戏复用/取代） | `core` |
| `js/doubao-voice.js` | WebSocket 实时语音客户端：麦克风采集 AudioWorklet、PCM、播放、重连、静音/暂停 | `pcm-worklet.js` |
| `js/mobile/voice-audio.js` | 角色独立 TTS：`/api/tts` 请求、blob 缓存、播放/停止、浏览器兜底（已禁用 TTS） | `/api/tts` |
| `js/pcm-worklet.js` | 麦克风重采样到 16k/20ms/640B | `doubao-voice.js` |
| `js/speech.js` | 浏览器 Web Speech STT/TTS 封装；mobile 启动时 `setBrowserTTSEnabled(false)` | 旧桌面 + mobile 兼容 |
| `js/api.js` | 桌面版/通用 API 客户端（chatStream、上传、总结、翻译、计划等） | 旧桌面 + mobile `core` 复用部分 |

## 4. 旧桌面版模块（保留，不是主开发目标）

- `web/index.html` + `js/main.js`（约 3300 行）+ `js/modes.js`（约 2200 行）+ `js/ui.js` + `js/store.js` + `js/api.js` + `js/speech.js` + `js/talking-head.js` + `web/avatar/avatar.js`。
- 功能：旧版课程/阅读/单词/设置/数字人口播；部分 API 和逻辑被 mobile 复用。
- 如果要统一维护，建议后续单独做一次“删除或迁移旧桌面版”的技术决策；当前不要在两个入口同时实现新功能。

## 5. 测试/脚本

| 文件 | 用途 |
|---|---|
| `test/api.test.mjs` | Node test runner；配置/计划/SRS/文档提取/API 规则 |
| `test/e2e.mjs` | 启动 mock upstream + server，跑端到端 API/流程 |
| `test/ui.mjs` | 启动 Chrome，截图与 UI 断言（桌面/手机尺寸） |
| `test/mock-upstream.mjs` | Mock OpenAI-compatible/火山 HTTP，避免真实计费 |
| `test/mock-volc-realtime.mjs` | Mock Volc WSS，验证 voice 桥/音频链路 |
| `scripts/share.sh` | LAN 分享实例 |
| `start.command` | macOS 一键启动 |

## 6. 关键 import 关系

```
app.js
 ├─ core.js (状态/API)
 ├─ screens.js
 │   ├─ review.js
 │   └─ library.js → book-library.js
 ├─ call.js
 │   ├─ doubao-voice.js (dynamic import)
 │   ├─ voice-audio.js (dynamic import)
 │   └─ speech.js
 ├─ kb.js → library.js
 └─ review.js

server.js
 ├─ lib/config.js
 ├─ lib/llm.js / llmJson.js
 ├─ lib/plans.js / lessonGen.js
 ├─ lib/kb.js / docExtract.js / docStore.js
 ├─ lib/review.js / progress.js / srs.js / wordbook.js
 ├─ lib/summary.js / memory.js / translator.js / tts.js
 ├─ lib/volcRealtime.js / volcProtocol.js / wsServer.js
 └─ content/*.js
```
