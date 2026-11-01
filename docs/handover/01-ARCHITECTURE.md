# 01 · 总体架构

## 1. 系统拓扑

```
┌──────────────────────────────── Browser (desktop-first) ───────────────────────────────┐
│  web/mobile.html                                                                        │
│   ├─ web/js/mobile/app.js        入口/路由/弹层/通话启动                                │
│   ├─ screens.js                  课程/对话/助手/复习/我的 五个 Tab                       │
│   ├─ call.js                     通话页、PTT、实时语音桥接、资料对照窗、总结            │
│   ├─ kb.js / library.js          知识库、英语书库                                       │
│   ├─ review.js / games.js        SRS 复习、小游戏                                       │
│   ├─ doubao-voice.js             Volc realtime WebSocket 客户端 + 麦克风采集/播放       │
│   └─ voice-audio.js              角色独立 TTS 播放器                                    │
│                                                                                         │
│  原生 ES Modules · 原生 CSS · 无构建                                                   │
└───────────────┬───────────────────────────────┬────────────────────────────────────────┘
                │ HTTP / SSE                    │ WebSocket /ws/voice
                ▼                               ▼
┌──────────────────────────── Node.js 24 local server (server.js) ────────────────────────┐
│  HTTP router /api/* + 静态文件                                                          │
│  ├─ LLM 文本链路      lib/llm.js → DeepSeek/OpenAI-compatible /chat/completions         │
│  ├─ 实时语音桥         handleVoiceSocket → lib/volcRealtime.js → 火山 realtime dialogue  │
│  ├─ 独立 TTS          /api/tts → lib/tts.js → 火山 TTS unidirectional                   │
│  ├─ 知识库            lib/kb.js + lib/docExtract.js + data/kb/                         │
│  ├─ 课程/计划         lib/plans.js + lib/lessonGen.js + data/plans.json                 │
│  ├─ 复习/SRS          lib/review.js + lib/progress.js + lib/srs.js + data/*.json        │
│  ├─ 总结/记忆         lib/summary.js + lib/memory.js + lib/wordbook.js                 │
│  └─ 配置/安全         lib/config.js + data/settings.json                                │
│                                                                                         │
│  零依赖：Node 内置 http / WebSocket / crypto / fs；无 express / ws / dotenv             │
└───────────────┬───────────────────────────────┬────────────────────────────────────────┘
                │ HTTPS/WSS                     │ 可选独立 TTS HTTP
                ▼                               ▼
       DeepSeek / OpenAI-compatible        火山 openspeech.bytedance.com
       /chat/completions                   /api/v3/realtime/dialogue
                                           /api/v3/tts/unidirectional
```

## 2. 两个前端

| 入口 | 状态 | 说明 |
|---|---|---|
| `/mobile` → `web/mobile.html` | **当前主产品** | 五个 Tab + 全屏通话；手机/桌面都能打开，但产品按桌面浏览器调优 |
| `/` → `web/index.html` | 早期桌面版/实验版 | `main.js`/`modes.js`/`avatar/*`；有课程/阅读/单词/设置等旧功能，**新功能不要默认加到这里** |

当前产品页面：

- 课程：计划、3 节课、开课/续课
- 对话：角色选择、进入通话
- 助手：Ava 助手对话、我的知识库、英语书库入口
- 复习：SRS、词库、三款小游戏
- 我的：设置、统计、兴趣/记忆

## 3. 请求链路（从粗到细）

### 3.1 纯文字聊天

```
screens.js / call.js
  → core.js assistantChat / api.js chatStream
  → POST /api/chat  (Accept: text/event-stream)
  → server.js handleChat
  → lib/llm.js streamChat (OpenAI SSE)
  → SSE: meta → delta* → feedback → done
  → 前端渲染气泡 + 双语字幕 + 反馈 JSON
```

### 3.2 实时语音对话

```
用户点麦克风 (PTT)
  → doubao-voice.js 采集 16k mono PCM (20ms/640B 帧)
  → 本地 WS /ws/voice 发二进制帧
  → server.js handleVoiceSocket
  → lib/volcRealtime.js 发送 Volc 二进制音频帧
  → 火山返回事件：ASR / chat / audio-start / PCM 音频 / audio-end
  → 本地 WS 转 JSON/二进制给前端
  → 前端显示用户字幕、老师台词、播放 24k PCM
```

### 3.3 资料课（知识库讨论）

```
KB 选中 docs
  → openCall({kbMode:'grounded', kbDocIds})
  → server 在 start 帧中取 buildKBTeachingMaterial(docIds, max 5600)
  → buildRealtimePersona 生成“只讲这份材料”的专用人格
  → 自动从第一句开教；资料课老师音频改由 /api/tts 完整朗读
  → 前端 docs 窗口高亮句子；点击句子 → 定位 + 角色 TTS
```

### 3.4 英语书库每日课

```
助手/知识库 → 英语书库
  → library.js ensureToday()：按 localStorage 进度选下一节
  → POST /api/kb/save-text (source=library) 写入知识库
  → POST /api/review/add 同步重点词
  → ui.openCall({kbMode:'grounded', kbDocIds:[今日doc]})
  → 资料课流程；回到书库点“标记完成”
```

## 4. 进程与端口

| 服务 | 默认 | 说明 |
|---|---|---|
| 本地个人实例 | `127.0.0.1:5180` | `node server.js`；数据 `data/` |
| 局域网分享实例 | `0.0.0.0:5181` | `AVA_DATA_DIR=data-share`；数据隔离 |
| 端口冲突 | 5180+1..+19 | `main()` 会尝试后续端口 |
| WebSocket | `/ws/voice` | 同 HTTP 端口，升级为 WS |
| 运行时文件 | `.runtime/url.txt` `.runtime/pid.txt` | 启动时写，便于工具查端口/进程 |

## 5. 关键设计决策

1. **单进程本地优先**：数据和模型 key 都在本机，避免前端暴露 key。
2. **无构建**：HTML 直接加载 ES Module，降低交接和部署成本；代价是没有类型检查和打包优化。
3. **文本/实时双脑**：通话页优先豆包实时语音；文字输入和所有非通话页面走 `/api/chat`（DeepSeek）。
4. **资料模式强约束**：一旦 `kbMode=grounded`，专用 persona 不允许自由聊，必须围绕材料逐句教；聊天侧同样走 `buildGroundedChatSystemPrompt`。
5. **断线可解释/可续**：实时语音上游超时不再直接“已重置”，而是重连 + 角色 TTS 兜底；资料模式老师声音完全改走独立 TTS 以规避实时 TTS 断流。
6. **数据可读、可迁移**：所有持久化都是 JSON 文件，方便备份、调试和后续换数据库。
7. **内容分层**：`content/` 只放静态/规则内容；模型生成内容走 prompt；避免把大段内容写进前端。
