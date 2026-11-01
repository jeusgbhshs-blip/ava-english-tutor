# 03 · 语音完整链路（实时语音 + 角色 TTS）

> 这是项目最容易出问题的部分。修改前务必读 `web/js/mobile/call.js`、`web/js/doubao-voice.js`、`lib/volcRealtime.js`、`lib/volcProtocol.js` 和 `server.js` 的 `handleVoiceSocket()`。

## 1. 两条声音链路

| 用途 | 入口 | 协议 | 关键点 |
|---|---|---|---|
| 实时对话（用户说话 ↔ 数字人回话） | `/ws/voice` | 本地 WebSocket + 火山 WSS | ASR、对话、TTS 音频都在火山内部完成（端到端） |
| 角色朗读（点句子/课程句子/资料课老师声音） | `/api/tts` | HTTP POST → mp3 | 独立豆包 TTS；服务端长文本分块；前端播放 mp3 |

> 重要：资料教学模式（`kbMode=grounded`）下，老师的声音**不走实时语音的 TTS 音频**，而是等实时语音返回文字后，由 `/api/tts` 重新合成完整 mp3。原因见 §7。

## 2. 音频格式

| 方向 | 格式 | 帧/大小 |
|---|---|---|
| 浏览器麦克风上行 | PCM s16le mono 16 kHz | 20ms = 640 bytes |
| 本地 WS 上行 | binary | 直接转发 |
| 火山下行音频 | PCM s16le mono 24 kHz | 二进制帧 |
| 独立 TTS | mp3 | `/api/tts` 响应 |

`web/js/pcm-worklet.js` 负责把设备采样率重采样到 16k，按 20ms 发 `postMessage({type:'pcm', buffer})`；`doubao-voice.js` 直接 `ws.send(buffer)`。

## 3. 实时语音会话生命周期

### 3.1 进入通话

1. `call.js openCall()` 加载角色、背景、口播引擎、DOM。
2. `detectEngine()`：若设置 `voiceEngine=volc` 且 volc 已配置 → `ensureVolc()` 创建 `doubao-voice` 客户端；否则浏览器语音（mobile 已关闭浏览器 TTS，仅留 fallback 代码）。
3. 资料模式会跳过自由聊天开场白；`initDocsForCall()` 载入选中 KB 文档。
4. `autoStartMaterialLesson()` 在资料模式下把第一句用角色 TTS 读出，并显示台词。

### 3.2 预连接（避免第一遍吞音）

- `openCall` 完成 250ms 后调用 `scheduleVolcWarmup(200)`；老师 TTS 结束后也会再调度。
- `warmVolcSession()` 调用 `voice.start({...volcStartOptions(), startPaused:true})`：
  - 建立本地 WS → 服务端 → 火山 WSS；
  - 启动麦克风采集，但 `micPaused=true`，不向上游发送；
  - 这样点麦克风时只需 `resumeMic()`，不需要等待建链。
- 预热失败静默，不影响用户；语音恢复/正常 PTT 会重新起会话。

### 3.3 PTT 状态机（`call.js`）

```
idle
 └─(点击麦克风)─ connecting
      ├─ 成功 → recording（计时/波形/取消/完成）
      │    └─(再点/完成) → submitting（commit）
      │         ├─ ASR/text/audio → speaking
      │         └─ audio-end → idle
      └─ 失败/取消 → idle
```

- `startPtt()`：停掉角色 TTS（避免叠音）→ `tryStartVolcSession()` → 若已有预热会话直接 `resumeMic()`。
- `finishPtt()`：设置 `pttCommitted`、`submitting`，调用 `finishVolcPtt()`。
- `finishVolcPtt()`：
  - 若 `pttHadSound=false` 且 peak 很低 → 提示“没听到”，回 idle；
  - `pauseMic()`（停止上行）→ `commit()`；
  - 启动 ASR watchdog 6s / reply watchdog 7s。
- 服务端 `commit`：向火山补发 120 帧 20ms 静音（2.4s），越过 2s VAD 窗口，让模型出句。
- `cancelPtt()`：丢弃本轮，回 idle。

### 3.4 本地 WebSocket 协议

连接：`ws://<host>/ws/voice`

客户端 → 本地服务（JSON 文本）：

```json
{ "type": "start", "level": "A2", "characterId": "elena", "mode": "free",
  "lessonId": "lesson_1", "lessonStep": 1,
  "kbMode": "grounded", "kbDocIds": ["kb_xxx"],
  "history": [{"role":"user","content":"..."}],
  "ptt": true }
```

```json
{ "type": "interrupt" }
{ "type": "commit" }
{ "type": "stop" }
```

客户端 → 本地服务（binary）：16k PCM 640B 帧。

本地服务 → 客户端：

```json
{ "type": "ready", "model": "3.0", "speaker": "...", "character": {...}, "kb": {...} }
{ "type": "asr", "text": "...", "final": true }
{ "type": "chat", "text": "...", "final": false }
{ "type": "audio-start", "text": "..." }
{ "type": "audio-end" }
{ "type": "interrupted" }
{ "type": "error", "message": "..." }
{ "type": "ended", "reason": "..." }
```

本地服务 → 客户端（binary）：24k PCM 音频块。

### 3.5 服务端桥

`server.js handleVoiceSocket()`：

1. 读 `settings.volc`，无凭据直接 error/close。
2. 收到 `start`：
   - 校验 level/characterId/kbDocIds；
   - `buildKBrief` / `buildKBTeachingMaterial`；
   - `buildRealtimePersona({...})`（含资料模式专用人格）；
   - 创建 `new VolcRealtimeSession({volc, persona, pttMode})`；
   - `await session.connect()`；
   - 建好会话后才会 forward binary。
3. 收到 binary → `session.sendAudio(buffer)`。
4. `commit` → 补静音触发 VAD 结束。
5. `stop` → 结束并关闭。
6. 上游 `onReady/onASR/onChat/onTTSStart/onAudio/onTTSAllEnded/onInterrupted/onError/onClose` → 转成本地 JSON/二进制。
7. 上游 close → 发 `ended` 并关闭本地 WS。

## 4. 火山实时语音客户端（`lib/volcRealtime.js`）

- 端点：`wss://openspeech.bytedance.com/api/v3/realtime/dialogue`
- 资源：`volc.speech.dialog`，模型 `3.0`，默认 speaker `en_female_dacey_uranus_bigtts`。
- 鉴权头：`X-Api-App-Id` + `X-Api-Key` 或 `X-Api-Access-Key` + `X-Api-Resource-Id`。
- 会话配置（`buildSessionConfig`）：
  - ASR：PCM 16k mono，`end_smooth_window_ms = pttMode ? 2000 : 1200`
  - TTS：PCM s16le 24k mono，speaker 由角色决定
  - dialog：`bot_name`、`system_role`（**截断到 8000 字符**）、extra.model
- 事件码/编解码见 `lib/volcProtocol.js`；测试连接见 `/api/volc/test` / `testVolcConnection()`。

## 5. 前端 `doubao-voice.js`

- 创建：`createDoubaoVoice(opts)`，opts 包含角色 id、handlers、`outputMuted`（资料模式静音实时音频）。
- 公开 API：`start/stop/interrupt/commit/cancelTurn/pauseMic/resumeMic/dispose/setHandlers/setOutputMuted/setPttGateMode/getMicInfo`。
- 麦克风采集：AudioWorklet 优先，失败回退 ScriptProcessor；重采样到 16k。
- 播放：把 24k PCM 转 AudioBuffer 调度播放；`playbackGain` 控制静音，资料模式设为 0。
- PTT 静音门限：
  - `PTT_GATE_RMS = 0.0025`，`PTT_GATE_HANGOVER_MS = 500`；
  - 只在 PTT 模式开启；避免呼吸/静音帧触发服务端 VAD 自答；
  - 看门狗检测到有麦克风电平但帧被门限挡住时，自动 `setPttGateMode(false)` 放宽。
- 断线：`handleSocketClosed` 先尝试重连一次（300ms），重连成功重发 startFrame；失败交给 call.js 自动恢复。
- `startPaused`：预热时启动采集但不上行，避免建链窗口自答。

## 6. 客户端兜底/恢复机制（call.js）

| 机制 | 触发 | 行为 |
|---|---|---|
| `onError` 回退 | 上游错误/连接断开 | 先让 `doubao-voice` 自愈；否则 `recoverVolcConnection()` |
| `recoverVolcConnection` | 断线/超时 | 重置会话，最多 2 次重连；失败 → TTS 续讲 |
| `teacherStalled` | 7s 无回复、3.5s 无音频、13s 单轮超时 | 中断当前音频 → `fallbackContinueWithTts()` 读当前资料句 |
| `fallbackContinueWithTts` | 实时语音不可用 | 用 `/api/tts` 朗读当前资料句，追加老师气泡，不弹“已重置” |
| 音频时长判断 | 实际 PCM 时长明显短于台词估算 | 判定音频提前结束 → TTS 续读 |
| 预热 | 进入通话/老师说完 | 提前建链，麦克风暂停，减少首句吞音 |
| 麦克风看门狗 | 录音中 framesSent 2.5s 不增长 | 先放宽门限/恢复 micPaused；仍失败才提示并显示文字输入 |

## 7. 资料教学模式为什么老师声音走独立 TTS

实测火山实时语音的 TTS 音频在长台词/长引用时可能：
- 在某个词（如 “pull out / bring out”）中途断流；
- 上游返回 `audio-end` 但音频只播了一部分；
- 网络超时导致整个会话重置。

解决方案（当前实现）：

```
资料模式 (kbMode=grounded)
  → realtime session 仍负责 ASR/对话文字，但 outputMuted=true，实时 TTS 音频静音
  → onChat final 拿到老师完整文字
  → speakGroundedReply() → /api/tts → 角色独立 TTS 完整 mp3
  → 长文本由服务端按 ≤500 字符分块合成并拼接
```

代价：老师开口前多一次 TTS 合成延迟；收益：完整、可控、不会在某个词断掉。

## 8. 推荐后续改造

1. 把实时语音的 `output_modalities: ['text']` 做成服务端可选开关（资料模式直接不生成上游 TTS，降低延迟/费用）。
2. 给实时语音会话增加服务端心跳/健康检查，区分“WS 活着但火山会话已死”。
3. 将资料课改为“服务端句子游标 + 客户端 TTS 队列”，彻底摆脱实时模型自由发挥。
4. 为语音链路增加可观测性：每轮记录 asr/chat/audio 时长、字节数、close reason，前端展示诊断。
5. 真实麦克风自动化测试（Chrome fake device + 多设备矩阵）。
