# 13 · 术语表

| 术语 | 含义 |
|---|---|
| **PTT** | Push-To-Talk，点击开始/再点结束的录音方式；本项目通话页主交互 |
| **端到端语音** | 火山把 ASR→对话→TTS 内部完成，输出语音；本项目实时对话用这个 |
| **ASR** | 自动语音识别，把用户声音转文字 |
| **TTS** | 文字转语音；独立 `/api/tts` 用角色音色朗读 |
| **PCM** | 未压缩音频；上行 16k mono s16le，下行 24k mono s16le |
| **VAD** | 语音活动检测；PTT commit 后发 2.4s 静音触发服务端断句 |
| **grounded** | 资料模式：只能围绕所选材料教学，不自由聊 |
| **divergent** | 发散模式：以材料为跳板扩展讨论 |
| **KB** | Knowledge Base，知识库 |
| **chunk / overlap** | KB 文档切块；overlap 是相邻块重叠，现已默认 0 |
| **BM25** | KB 关键词检索排序算法 |
| **enrich** | 入库后异步生成 chunk 摘要/keywords |
| **SRS** | Spaced Repetition System，间隔重复复习 |
| **Leitner box** | SRS 的盒子间隔模型 `[0,1,2,4,7,14,30,60]` 天 |
| **streak** | 连续学习天数 |
| **resume** | 课程中途断点 |
| **口播/talking head** | 数字人头部动画；WebGL 或静态图 |
| **demo 模式** | 无 LLM Key 的本地规则回复，保证完整流程可体验 |
| **DIRECTOR** | 每轮对话导演计划（角度/问题/避免重复），free/roleplay 用 |
| **FEEDBACK_MARKER** | `<<<FEEDBACK>>>`，文字聊天中分隔口语正文与 JSON 反馈 |
| **source=library** | 英语书库生成的 KB 文档来源 |
| **数据目录** | `DATA_DIR`（默认 `data/`，分享用 `data-share/`） |
