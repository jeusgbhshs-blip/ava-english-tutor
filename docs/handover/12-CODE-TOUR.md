# 12 · 关键代码走读（按修改场景）

> 行号会随代码变化；用函数名搜索。此处目标是快速定位“改哪里”。

## 1. 服务端

| 场景 | 函数/位置 | 说明 |
|---|---|---|
| 新增 HTTP API | `server.js handleApi()` 540–1425 行 | 按 `pathname/m` 匹配；返回 `sendJson` |
| 改聊天链路 | `handleChat()` / `buildChatContext()` | SSE、KB 注入、director、demo fallback |
| 改实时语音桥 | `handleVoiceSocket()` | start/audio/commit/interrupt/stop + Volc 事件转本地 JSON |
| 改提示词 | `content/prompts.js` | 所有 prompt builder |
| 改计划/解锁 | `lib/plans.js` | `createUserPlan/fillPlanLessons/saveLessonProgress/completeLesson/decoratePlan` |
| 改课件生成 | `lib/lessonGen.js` | 后台生成/轮询状态 |
| 改复习/SRS | `lib/review.js` / `lib/srs.js` | 四档评分/间隔 |
| 改总结 | `lib/summary.js` | quick 规则 + LLM 总结 + keyWords/keyPatterns |
| 改知识库 | `lib/kb.js` | chunk/BM25/enrich/buildKBTeachingMaterial |
| 改文档提取 | `lib/docExtract.js` | docx/pptx/pdf/OCR |
| 改 TTS | `lib/tts.js` | speaker 映射/分块/缓存 |
| 改火山协议 | `lib/volcProtocol.js` / `volcRealtime.js` | 二进制 frame/事件 |
| 改 WebSocket 实现 | `lib/wsServer.js` | 手写握手/帧/ping |

## 2. 通话页 `web/js/mobile/call.js`

| 场景 | 函数 | 说明 |
|---|---|---|
| 打开/关闭通话 | `openCall()` / `endCall()` / `hangup()` | DOM/背景/口播/计时/历史 |
| 实时语音初始化 | `ensureVolc()` / `startVolcPtt()` / `tryStartVolcSession()` | start frame、预热、resumeMic |
| PTT | `startPtt()` / `finishPtt()` / `finishVolcPtt()` / `cancelPtt()` | 录音/commit/取消 |
| 实时事件 | `onASR/onChat/onAudioStart/onAudioProgress/onAudioEnd/onError/onEnded` | 用户气泡、老师台词、TTS/状态 |
| 断线恢复 | `recoverVolcConnection()` / `teacherStalled()` / `fallbackContinueWithTts()` | 重连/TTS 续讲 |
| 资料课 | `initDocsForCall()` / `renderDocsBody()` / `autoStartMaterialLesson()` / `refreshDocsFollow()` / `readDocsSentence()` | 加载/高亮/跟随/点击朗读 |
| 资料声音 | `materialTtsMode()` / `speakGroundedReply()` | 实时文字 → 角色独立 TTS |
| 课程 | `lessonOnUserText()` / `saveLessonResume()` / `finishLessonStep()` | 断点/步骤 |
| 总结 | `endCall()` / `showSummary()` / `fetchQuickSummary()` | quick→LLM |
| 麦克风 | `ensureMicMonitor()` / `micLoopTick()` / `startPttWatchdog()` / `micDiagnostics()` | 权限/电平/看门狗 |
| 口播 | `mountTalkingHead()` / `setHeadMode()` | WebGL/静态图 |

## 3. `web/js/doubao-voice.js`

| 场景 | 函数 | 说明 |
|---|---|---|
| 创建 | `createDoubaoVoice()` | handlers/options |
| 建立会话 | `start()` / `openSocket()` / `sendJSON(startFrame)` | WS/鉴权/Start |
| 麦克风 | `startCapture()` / `sendPCM()` / `pauseMic()` / `resumeMic()` | AudioWorklet + 16k 重采样 + 门限 |
| 播放 | `handleBinaryPcm()` / `schedulePcm()` / `beginSpeaking()` | 24k PCM→AudioBuffer |
| 断线 | `handleSocketClosed()` / `attemptReconnect()` | 一次重连 |
| 输出静音 | `setOutputMuted()` | 资料模式实时音频静音 |
| 诊断 | `getMicInfo()` / getters | 设备/PCM 帧数/暂停状态 |

## 4. 知识库与书库

| 场景 | 函数/文件 | 说明 |
|---|---|---|
| KB 面板 | `web/js/mobile/kb.js panelHtml/bindPanel/renderList` | 上传/列表/多选 |
| 图片校对 | `reviewImageFile()` / `openProofreadSheet()` | preview-file → save-text |
| 粘贴 | `openPasteSheet()` | source=paste |
| 讨论 | `startDiscussion()` | close KB → ui.openCall |
| 每日书库 | `web/js/mobile/library.js ensureToday()` / `renderDailyCard()` / `startTodayLesson()` / `completeToday()` | localStorage/入库/开课 |
| 书库数据 | `web/js/mobile/book-library.js` | 6 本×5 天 |

## 5. 复习 / 课程页

| 场景 | 函数 | 说明 |
|---|---|---|
| 复习渲染 | `renderReview()` / `paintHome()` / `paintSession()` / `paintManage()` / `paintGame()` | view 状态机 |
| 复习会话 | `startSession()` / `flipCard()` / `gradeCurrent()` | 四档/SRS |
| 每日进度 | `loadDaily/reviewedCount/saveDaily` | localStorage |
| 游戏 | `openGame()` + 各 `startMatch/startListen/startSpell` | 单屏 |
| 课程页 | `renderCourses()` / `renderReadyPlan()` / `bindCourses()` | 计划/断点/老师切换 |
| 助手 | `renderAssistant()` / `sendAssistant()` | 计划创建/更新 |

## 6. 调试命令建议

```bash
# 找函数
rg "function openCall|autoStartMaterialLesson|recoverVolcConnection" web/js/mobile/call.js

# 看 API 路由
rg "pathname === '/api" server.js

# 看前端调用
rg "postJSON\('/api|fetch\('/api" web/js/mobile

# 看 prompt
rg "function build|Grounded|kbMode" content/prompts.js
```

## 7. 改动前的回归 Checklist

- 修改 `call.js`：必须手动跑通话、资料窗、挂断总结、课程断点。
- 修改 `doubao-voice.js`：必须真机麦克风 + Volc 凭据验证；mock 不能验证音频质量。
- 修改 `kb.js`：上传各格式 + 图片校对 + 粘贴 + 讨论。
- 修改 `library.js`：跨日期（修改系统时间/localStorage）验证 Day 推进、完成、streak。
- 修改 `plans.js`：生成、完成、解锁、断点、重启、老师切换。
- 修改 `review.js`：四档、每日进度、中途退出、三款游戏单屏。
- 修改 prompt：无 Key demo 模式必须仍可跑；打印 system prompt 检查长度（<8000 实时）。
