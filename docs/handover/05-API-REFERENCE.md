# 05 · API / SSE / WebSocket 参考

约定：
- 全部 JSON：`Content-Type: application/json; charset=utf-8`。
- 成功通常是 `{ ok: true, ... }`；失败 `{ ok: false, error: "中文提示" }`。
- 没有鉴权；服务默认只监听 `127.0.0.1`；LAN 分享模式= `--host 0.0.0.0`，风险见安全文档。
- Body 大小限制：普通 API 1MB；文件/预览 20MB；KB save-text 6MB；TTS 64KB。超限返回 413/400。

## 1. 静态入口

| 路径 | 文件 |
|---|---|
| `/mobile` `/mobile/` | `web/mobile.html` |
| `/` | `web/index.html`（旧桌面版） |
| `/avatar/preview.html` | 旧数字人预览 |
| 其他带扩展名 | `web/` 下静态文件 |
| 无扩展名未知路径 | 回退 `index.html` |

HTTP 头：`x-content-type-options: nosniff`、`referrer-policy: no-referrer`、`cache-control: no-store`（静态/接口）。

## 2. 健康与设置

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | 运行状态：version/mode/hasKey/model/baseUrl/voiceEngine/volcConfigured/uptime |
| GET | `/api/settings` | 返回 `publicSettings`（**永不含 key 原文**，只有 keyHint/hasKey） |
| PUT | `/api/settings` | 合并保存；字段见 `lib/config.js`；apiKey 只有非空才覆盖；`clearKey:true` 清空 |
| POST | `/api/settings/test` | 测试 LLM 连接；body 可临时传 baseUrl/model/apiKey |

`GET /api/settings` 形状示例：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "hasKey": true,
  "keyHint": "sk-a…wxyz",
  "level": "A2",
  "teacherName": "Ava",
  "explainChinese": true,
  "voiceEngine": "volc",
  "volc": {
    "appId": "…", "model": "1.2.1.1", "speaker": "…", "endpoint": "…",
    "resourceId": "volc.speech.dialog", "hasKey": true, "keyHint": "…", "configured": true
  },
  "presets": [], "levels": []
}
```

## 3. 聊天 / 语音 / 翻译 / 评分

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/chat` | SSE 流式聊天；支持 free/vocab/pronounce/roleplay/reading；支持 `kbMode`/`kbDocIds` |
| POST | `/api/coach` | 豆包语音模式的纠错/教练分析 JSON |
| POST | `/api/translate` | 批量中英翻译（≤8 条，每条 ≤500 字） |
| POST | `/api/score` | 跟读评分（target/transcript/confidence） |
| POST | `/api/volc/test` | 测试火山实时语音连接 |
| GET | `/api/tts/voices` | 可用音色列表（characterId/speaker） |
| POST | `/api/tts` | 角色 TTS，返回 `audio/mpeg`；body `{text, characterId?, speaker?, rate?}` |

### POST /api/chat

请求：

```json
{
  "mode": "free",
  "level": "A2",
  "characterId": "elena",
  "message": "I went to a gallery yesterday.",
  "history": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}],
  "kbMode": "free|grounded|divergent",
  "kbDocIds": ["kb_xxx"],
  "theme": "...",
  "lessonId": "lesson_1",
  "lessonStep": 1
}
```

`reading` 模式额外：`docId`，或 `start:true` 无 message 触发开场。

SSE 事件：

```
meta      {demo, model, level, chinese, doc, character, kb:{mode,hits}}
delta     {text}
feedback  {corrections[], better[], newWords[], encouragement_zh, followUp, chineseHelp}
done      {fullReply}
error     {message}
```

`meta.demo=true` 无 Key/强制演示；上游失败在未输出内容时会自动 fallback 到 demo。

### POST /api/coach

Body：`{message, level?, mode?, history?}`  
响应：`{ok, demo, feedback:{corrections,better,newWords,encouragement_zh,followUp}}`。

### POST /api/translate

Body：`{texts: string[] | text: string, target?: "zh"|"en"}`  
响应：`{ok, texts: string[]|null[], provider}`；单条失败位置为 null。

### POST /api/score

Body：`{target, transcript, confidence?}`  
响应：评分详情（总分行、单词对比、tips；见 `lib/score.js`）。

### POST /api/tts

Body：`{text, characterId?, speaker?, rate?}`  
响应：`audio/mpeg`；头部 `x-tts-speaker`、`x-tts-cache: hit|miss`。  
服务端：长文本 ≤500 字符分块、≤4000 字符；失败返回 502 JSON。

## 4. 复习 / SRS

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/review/summary` | total/dueCount/newCount/learningCount/knownCount |
| GET | `/api/review/due?limit=20` | 到期词 |
| GET | `/api/review/list?status=all&q=&limit=200` | 词库列表（new/learning/known） |
| POST | `/api/review/add` | 批量新增/更新 `{words[], defaults?}` |
| PATCH | `/api/review/word` | 更新 `{word, patch}` |
| DELETE | `/api/review/word?word=` | 删除 |
| POST | `/api/review/grade` | `{word, grade: again|hard|good|easy}` → SRS 下次间隔 |

词条形状：

```json
{
  "word": "gallery",
  "phonetic": "/ˈɡæləri/",
  "meaning": "画廊",
  "example": "I visited a small gallery.",
  "source": "book|summary|manual|conversation",
  "sourceTitle": "快乐王子 · Day 1",
  "status": "new|learning|known",
  "interval": 0, "ease": 2.5, "due": 0, "reps": 0, "lapses": 0
}
```

## 5. 知识库 KB

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/kb/list` | `{docs[], stats}`；docs 是元数据 |
| POST | `/api/kb/preview-file` | 提取文本不保存；body `{name,dataBase64,mime?}`；返回 text/kind/warnings |
| POST | `/api/kb/save-text` | 保存校对/粘贴/书库文本；`{name,title?,text,kind?,source?}` |
| POST | `/api/kb/upload` | 上传文件并直接入库；base64 |
| POST | `/api/kb/url` | `{url}` 抓网页正文入库 |
| POST | `/api/kb/search` | `{query,docIds[],limit}` → `{hits[],...}` |
| POST | `/api/kb/:id/enrich` | 重新生成摘要 |
| GET | `/api/kb/:id` | 完整 doc（含 chunks） |
| DELETE | `/api/kb/:id` | 删除 |

`source` 允许：`file`、`paste`、`library`、`web`（服务端 save-text 仅 file/paste/library；web 由 url 导入）。

## 6. 个人资料 / 计划 / 助手

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/profile` | `{interests[], updatedAt}` |
| PUT | `/api/profile` | `{interests[]}` |
| GET | `/api/characters` | 公开角色数组（不含 persona） |
| GET | `/api/characters/:id` | 单个公开角色 |
| GET | `/api/content` | topics/scenarios/sentenceBanks/vocab/modes/levels/presets/openers |
| GET | `/api/plan` | 当前计划（decorate 后；生成中断会自动续跑） |
| PATCH | `/api/plan/teacher` | `{teacherId}` 换老师 |
| POST | `/api/plan/lesson-progress` | 保存断点 `{lessonId,step,phraseIdx,practiceTurns,challengeTurns}` |
| POST | `/api/plan/lesson-restart` | 清断点 `{lessonId}` |
| POST | `/api/plan/generate` | 重新生成 3 节课 |
| GET | `/api/lessons` | 课程列表 |
| GET | `/api/lessons/:id` | 单课 |
| POST | `/api/plan/scene-done` | 完成课程 `{lessonId,stageId,stepsCompleted}` |
| POST | `/api/assistant` | 助手对话 + 创建/更新计划 action |

计划/课程结构详见 `08-COURSE-REVIEW-GAMES.md`。

## 7. 旧桌面版文档 API（阅读讲解）

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/doc/upload` | 旧阅读文档上传（`data/docs/`，与 KB 不同） |
| GET | `/api/doc/list` | 最近 30 个 |
| POST | `/api/doc/analyze` | `{id,level}` 生成分析 |
| GET | `/api/doc/:id` | 详情（text/analysis） |
| DELETE | `/api/doc/:id` | 删除 |

> 新功能请优先使用 KB API；`/api/doc/*` 是旧桌面版阅读讲解链路。

## 8. 进度 / 总结 / 单词本

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/progress` | 连续天数/累计轮次/分钟/单词统计/天数图 |
| POST | `/api/progress` | `{turns,minutes,reviewWords?:[{word,correct}]}` |
| POST | `/api/summary/quick` | 不发 LLM 的规则总结，挂断即时显示 |
| POST | `/api/summary` | LLM 总结；重点词写入 wordbook + SRS + review；更新角色记忆 |
| GET | `/api/wordbook?days=7` | 按天词表 |
| POST | `/api/wordbook` | `{words[],source?}` 手动加词 |

`/api/summary` 关键响应：`keyWords[]`、`keyPatterns[]`、`corrections[]`、`dailyWords`、`wordbook`、`reviewAdded`。

## 9. WebSocket `/ws/voice`

完整协议见 `03-VOICE-PIPELINE.md` §3.4；摘要：

Client JSON：`start` / `interrupt` / `commit` / `stop`  
Server JSON：`ready` / `asr` / `chat` / `audio-start` / `audio-end` / `interrupted` / `error` / `ended`  
Binary：双向 PCM。

## 10. 错误/环境变量

- 错误统一 `{ok:false,error}`；LLM 上游错误会友好化。
- 环境变量：
  - `AVA_DATA_DIR`：覆盖数据目录（分享实例用）
  - `AVA_BASE_URL` `AVA_MODEL` `AVA_API_KEY`：覆盖 LLM 配置
  - `AVA_VOLC_ENDPOINT` `AVA_VOLC_APP_ID` `AVA_VOLC_API_KEY` `AVA_VOLC_ACCESS_TOKEN` `AVA_VOLC_MODEL` `AVA_VOLC_SPEAKER`
  - `AVA_TTS_API_KEY`：TTS 单独 key（优先于 settings）
  - `AVA_DEBUG_CONTEXT=1`：把 chat system prompt 写 `/tmp/ava-ctx-system.txt`
