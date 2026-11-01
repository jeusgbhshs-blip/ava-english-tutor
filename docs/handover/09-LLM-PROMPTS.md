# 09 · 模型、Prompt 与内容层

## 1. 模型接入

`lib/llm.js` 是唯一 OpenAI-compatible 客户端：

- `baseUrl` + `/chat/completions`；
- `Authorization: Bearer <apiKey>`；
- SSE 解析（`data:` 行、`[DONE]`）；
- 60s 超时、错误友好化；
- `settings` 从 `lib/config.js` 读取，支持环境变量覆盖。

默认：

| 项 | 值 |
|---|---|
| baseUrl | `https://api.deepseek.com/v1` |
| model | `deepseek-chat` |
| 可选 Presets | DeepSeek / OpenAI / Kimi / 通义千问 / Ollama |

`lib/llmJson.js`：要求返回纯 JSON 的封装，用于计划生成、记忆更新、文档分析等。

## 2. 文本聊天输出契约

`content/prompts.js`：

```text
<English spoken reply>
<<<FEEDBACK>>>
{"corrections":[...],"better":[...],"newWords":[...],"encouragement_zh":"...","followUp":"...","chineseHelp":null}
```

- `FEEDBACK_MARKER = '<<<FEEDBACK>>>'`；
- `lib/llm.js parseFeedback()` 解析；无 marker 时返回空 feedback；
- `chineseHelp` 用于中文求助（原句、英文、chunks、tips）；
- 前端 `/api/chat` meta/delta/feedback/done 渲染。

## 3. Prompt 文件与用途

| 函数 | 用途 |
|---|---|
| `buildSystemPrompt(ctx)` | 文字聊天总 system prompt：free/roleplay/vocab/reading/pronounce/lesson + 角色 + 记忆 + 知识库 |
| `buildGroundedChatSystemPrompt()` | **资料模式专用文字聊天**：只讲材料、逐句、短纠错 |
| `buildRealtimePersona()` | 实时语音人格；若 `grounded` 且材料存在，走 `buildGroundedRealtimePersona()` |
| `buildGroundedRealtimePersona()` | 资料课专用实时人格；严格材料约束；不自由聊 |
| `buildLessonBlock()` | 3 步课程/断点注入 |
| `buildSummaryMessages()` | 挂断总结（重点词/句型/纠错） |
| `buildDocAnalysisMessages()` | 阅读文档分析 JSON |
| `buildPlanLessonsMessages()` | 3 节课课件生成 JSON |
| `buildCoachMessages()` | 语音模式教练分析 |
| `buildDirectorMessages()` | free/roleplay 每轮导演计划 |
| `buildMemoryMessages()` | 对话后更新角色长期记忆 |
| `buildKBEnrichMessages()` / `buildKBQueryMessages()` / `buildKBRerankMessages()` | KB 摘要/检索增强 |

## 4. 关键 prompt 约束（改之前先读）

### 4.1 资料模式（grounded）

- 只讨论所选材料；问候/跑题/换话题都必须回到材料；
- 从第一句开始，逐句，一次一句；
- 一次只纠一个错误（≤5 词 chunk），**不重复整句、不要求整句重读**；
- 单次引用材料 ≤20 词；长句只读第一个从句；
- 每轮口语回复 ≤2 句/25 词；
- 长句/长引用是导致实时 TTS 断流的主要风险。

### 4.2 自由对话

- 像朋友，不锁话题；
- 回应 → 一个观点/小故事 → 一个追问；
- 不空洞夸奖；
- 中文求助时先确认理解、给自然英文、邀请重复。

### 4.3 角色人格

`content/characters.js` 三位：
- Elena（伦敦、画廊策展人、温柔、英式）
- Maya（纽约、广告创意总监、直爽、美式）
- Hikari（东京、虚拟偶像练习生、元气、A2）

实时语音：`system_role` 最多 **8000 字符**；资料注入被限制在 5600 字符（同时留出规则/记忆空间）。
文字聊天：完整资料最多 10000 字符上下文（`/api/chat` 的 `kbContext.slice(0,10000)`）。

## 5. 演示/降级链路

- `content/demo.js` 提供无 Key 的完整演示回复（自由聊/角色/阅读/双语/纠错/总结）；
- `/api/chat` 无 Key 或上游连接失败时自动 fallback 到 demo；
- 演示模式对前端表现为 `meta.demo=true`；
- 任何新功能必须在 demo 模式可跑通（离线体验是产品要求）。

## 6. 内容层

| 文件 | 内容 |
|---|---|
| `content/characters.js` | 3 位角色 + 场景 + 音色 + 人设 |
| `content/scenarios.js` | 自由聊话题、角色扮演场景、句型库 |
| `content/vocab.js` | 词库主题（小游戏/词汇模式） |
| `content/openers.js` | 开场白/破冰句 |
| `content/demo.js` | 无 Key 演示回复 |
| `content/index.js` | `/api/content` 聚合 |
| `web/js/mobile/book-library.js` | 英语书库 6 本书 ×5 天节选 |

修改内容层时注意：
- 不要把大段内容写进 prompt 字符串；静态内容放 `content/`；
- 新增角色要同时补 `web/assets/characters/*` 封面/分层素材 + voice speaker；
- 新书必须公版或自制；标注来源；
- 任何语音/聊天行为改动先跑 demo（无 Key）避免付费依赖。

## 7. 温度/长度/上下文

- Node 侧没有显式 temperature；走 provider 默认；若要稳定教学，可在 `lib/llm.buildRequestPayload` 增加参数。
- 历史裁剪：普通聊天保留最近 60 条/32k 字符；实时语音历史 24 条/6k 字符，每条 300 字。
- 60s LLM 超时；上游失败时未输出则 demo fallback，已输出则 error + done。
- `/api/chat` 的 `AVA_DEBUG_CONTEXT=1` 可 dump system prompt 到 `/tmp/ava-ctx-system.txt`——排查 prompt 问题首选。
