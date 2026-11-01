# 06 · 数据模型与存储

## 1. 服务端数据目录

默认：`DATA_DIR = AVA_DATA_DIR || <project>/data`

| 文件/目录 | 内容 | 写入模块 |
|---|---|---|
| `settings.json` | 模型/语音配置（含 API Key，chmod 600） | `lib/config.js` |
| `plans.json` | 当前学习计划 `{active, updatedAt}` | `lib/plans.js` |
| `profile.json` | 用户兴趣 `{interests[], updatedAt}` | `lib/memory.js` |
| `memory.json` | 按角色的长期记忆（interests/facts/topics/summary） | `lib/memory.js` |
| `progress.json` | 连续天数、累计分钟、每天统计、SRS 单词进度 | `lib/progress.js` |
| `review.json` | 复习词库（小写 word 为 key） | `lib/review.js` |
| `wordbook.json` | 按天单词表（最近 60 天） | `lib/wordbook.js` |
| `kb/index.json` | KB 文档索引 | `lib/kb.js` |
| `kb/kb_*.json` | KB 文档正文 + chunks | `lib/kb.js` |
| `docs/` | 旧桌面版阅读文档（`/api/doc/*`） | `lib/docStore.js` |
| `tts-cache/*.mp3` | TTS 缓存（≤400 文件/80MB） | `lib/tts.js` |

> `data/` 与 `data-share/` 都被 `.gitignore`；不要打包个人数据。

## 2. settings.json

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKey": "sk-...",
  "level": "A2",
  "teacherName": "Ava",
  "voice": "",
  "explainChinese": true,
  "autoListen": false,
  "voiceEngine": "volc",
  "volc": {
    "appId": "...",
    "apiKey": "...",
    "accessToken": "",
    "model": "3.0",
    "speaker": "en_female_dacey_uranus_bigtts",
    "endpoint": "wss://openspeech.bytedance.com/api/v3/realtime/dialogue",
    "resourceId": "volc.speech.dialog"
  }
}
```

API 返回 `publicSettings` 时只给 `hasKey/keyHint`；真实 key 只在服务端。

## 3. plans.json

```json
{
  "active": {
    "version": 3,
    "id": "plan_xxx",
    "teacherId": "elena",
    "teacherName": "Elena",
    "level": "A2",
    "goalText": "想在咖啡店和旅行时开口",
    "title": "Elena 的专属英语计划",
    "summary": "...",
    "stages": [
      { "id": "stage_1", "title": "第一课", "emoji": "🌱", "focus": "先开口，跟读常用句", "lessonId": "lesson_1" }
    ],
    "lessons": {
      "lesson_1": {
        "id": "lesson_1",
        "title": "第 1 课 · ...",
        "topic": "", "emoji": "📘", "level": "A2",
        "objectives": ["..."],
        "phrases": [{"en":"...","zh":"..."}],
        "steps": [{"id":"repeat","title":"跟读常用句","desc":"..."}],
        "taskPrompt": "...", "teacherIntro": "...",
        "status": "generating|ready|error", "error": "",
        "done": false, "doneAt": 0,
        "resume": { "step": 1, "phraseIdx": 0, "practiceTurns": 0, "challengeTurns": 0 }
      }
    },
    "generating": false,
    "createdAt": 0, "updatedAt": 0
  },
  "updatedAt": 0
}
```

`decoratePlan()` 会补：解锁状态、下一课、完成数、resume 摘要。详见 `lib/plans.js`。

## 4. review.json

```json
{
  "words": {
    "gallery": {
      "word": "gallery",
      "phonetic": "/ˈɡæləri/",
      "meaning": "画廊",
      "example": "I visited a small gallery.",
      "source": "book|summary|manual|conversation",
      "sourceTitle": "快乐王子 · Day 1",
      "status": "new|learning|known",
      "interval": 0,
      "ease": 2.5,
      "due": 1790000000000,
      "reps": 0, "lapses": 0,
      "createdAt": 0, "updatedAt": 0,
      "lastGrade": ""
    }
  },
  "updatedAt": 0
}
```

SRS 评分见 `lib/review.js` / `lib/srs.js`。

## 5. progress.json

```json
{
  "version": 1,
  "streak": 1,
  "lastActive": "2026-11-01",
  "totalTurns": 12,
  "totalMinutes": 30,
  "days": [{ "date": "2026-11-01", "turns": 12, "minutes": 10 }],
  "words": { "gallery": { "box": 0, "due": 0, "seen": 1, "correct": 0, "last": 0 } },
  "updatedAt": 0
}
```

## 6. wordbook.json

```json
{
  "version": 1,
  "days": {
    "2026-11-01": [
      { "word": "gallery", "phonetic": "...", "meaning": "画廊", "example": "...",
        "why_zh": "...", "source": "summary", "addedAt": 0, "timesSeen": 1, "lastAt": 0 }
    ]
  },
  "updatedAt": 0
}
```

## 7. kb/index.json + kb 文档

```json
{
  "docs": [
    {
      "id": "kb_xxx",
      "title": "快乐王子 · Day 1 The Golden Statue",
      "source": "library",
      "kind": "txt",
      "lang": "en",
      "chars": 900,
      "chunkCount": 2,
      "preview": "...",
      "enrichStatus": "done",
      "createdAt": 0
    }
  ],
  "updatedAt": 0
}
```

文档文件：

```json
{
  "id": "kb_xxx",
  "title": "...",
  "source": "file|paste|web|library",
  "kind": "txt|pdf|docx|pptx|image",
  "lang": "en|zh|mixed",
  "chars": 900,
  "chunks": [
    { "id": "c1", "text": "...", "summary": "...", "keywords": [] }
  ],
  "preview": "...",
  "enrichStatus": "pending|done|error",
  "createdAt": 0,
  "meta": {}
}
```

## 8. 浏览器 localStorage（mobile）

| 键 | 写入模块 | 用途 |
|---|---|---|
| `ava.book.library.v1` | `library.js` | 6 本书每日进度、streak、完成记录 |
| `ava.review.daily.v1` | `review.js` | 当天已复习单词、目标数 |
| `ava.review.session.draft.v1` | `review.js` | 中途退出复习的会话草稿 |
| `ava.review.remindedDate` | `review.js` | 每日复习提醒是否已弹 |
| `ava.mobile.review.match.score` | `review.js` | 词义配对最高分 |
| `ava.mobile.play.score` | `games.js` | 旧趣玩比分 |
| `ava.mobile.nickname` | `core.js`/`screens.js` | 昵称 |
| `ava.mobile.plan` | `core.js` | 本地计划兜底缓存 |
| `ava.cache.v1` / `ava.pendingProgress.v1` | 旧桌面版 `store.js` | 旧桌面缓存/未同步进度 |
| `ava.wordMeta.v1` / `ava.onboarded.v1` | 旧桌面版 `main.js` | 单词元数据/引导 |

## 9. 数据生命周期与迁移

- 所有服务端 JSON 使用 `writeJsonFile` 原子写（tmp + rename）。
- 没有数据库迁移框架；`plans.js` 对旧版本计划会**直接丢弃并要求重新生成**（`PLAN_VERSION=3`）。
- KB 文档没有自动清理；上限 200 篇。TTS 缓存自动 prune（400 文件/80MB）。
- 删除 KB 文档会删除 `data/kb/<id>.json` 与 index 项；旧 `data/docs/` 与 KB 独立。
- 备份：直接备份 `DATA_DIR` 即可；恢复时保证目录权限（settings 600）。
- 分享实例 `data-share/` 与个人 `data/` 完全独立；`scripts/share.sh` 首次只复制 settings 用于语音/模型配置（需注意会复制 API key）。

## 10. 隐私/安全注意

- `data/` 里有 API Key、用户知识库、对话记忆、复习记录。交接包必须排除。
- 前端只能拿到打码设置；但**同一局域网**可访问所有没有鉴权的 API，分享模式只适合可信环境。
- `settings.json` 权限尝试 600；其他 JSON 可能默认权限，若需要更严格可统一 chmod。
