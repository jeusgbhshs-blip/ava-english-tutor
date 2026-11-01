# 04 · 知识库与英语书库

## A. 知识库（KB）

### 1. 数据目录

```text
data/kb/
├─ index.json                 # 文档元数据数组
├─ kb_<id>.json               # 每篇文档：chunks、摘要、keywords、meta
└─ ...
```

`index.json` 只存列表元数据；正文/分块在独立文件。上限：
- `MAX_KB_DOCS = 200`
- 单文档取前 `MAX_TEXT_CHARS = 60000` 字符
- chunk 大小 `700` 字符，**默认 overlap = 0**（历史版本是 120，会导致重复句；新版本已改为 0，并在老文档展示时去重）

### 2. 导入链路

```
用户操作
 ├─ 文件上传 → POST /api/kb/upload (base64) → lib/docExtract.extractText
 ├─ 网页链接 → POST /api/kb/url → lib/kb.importWebPage
 ├─ 图片      → POST /api/kb/preview-file → OCR 预览 → 用户校对 → POST /api/kb/save-text
 ├─ 粘贴文本 → POST /api/kb/save-text (source=paste)
 └─ 英语书库 → POST /api/kb/save-text (source=library)
```

`lib/docExtract.js` 支持：

| 类型 | 实现 |
|---|---|
| txt/md/csv/rtf | 直接读文本 |
| docx | 解压 zip + 解析 word/document.xml |
| pptx | 解压 + 解析 slides XML |
| pdf | 解析 PDF 文本对象；扫描版 PDF 会走 OCR/警告 |
| png/jpg/... | 调 macOS Vision OCR（`swift`/`osascript` 脚本）；非 macOS 需替换引擎 |
| 不支持 | 抛错并提示 |

**严格模式**：图片/扫描件不能直接入库；前端打开校对弹层，用户确认后才 `save-text`。

### 3. 文档结构

```json
{
  "id": "kb_xxx",
  "title": "标题",
  "source": "file|paste|web|library",
  "kind": "txt|pdf|docx|pptx|image",
  "lang": "en|zh|mixed",
  "chars": 1234,
  "chunks": [
    { "id": "c1", "text": "...", "summary": "...", "keywords": ["..."] }
  ],
  "preview": "前 320 字",
  "enrichStatus": "pending|done|error",
  "createdAt": 0,
  "meta": { "reviewed": true, "method": "paste" }
}
```

### 4. 检索链路

- `searchKB({query, docIds, limit, settings})`
  - BM25 关键词检索 `bm25Rank`；
  - 若模型 Key 可用，会做 LLM rerank/query 扩展（`buildKBRerankMessages` / `buildKBQueryMessages`）；
  - 返回 `hits: [{docId, docTitle, chunkId, text, summary, source, score}]`。
- `/api/kb/search` 供通话资料逐句跟随使用。
- 客户端 `call.js refreshDocsFollow()`：
  1. 先用老师原话做**本地句子匹配** `focusDocsByText()`；
  2. 再请求 `/api/kb/search` 细化；
  3. 高亮并滚动到对应句；
  4. 失败保持当前句。

### 5. 摘要增强（enrich）

- 入库后若配置了模型 key，`enrichKBInBackground()` 异步为每个 chunk 生成 `summary/keywords`。
- `enrichStatus: pending → done/error`。
- 前端 KB 列表会轮询 pending 文档。
- `/api/kb/:id/enrich` 可手动重试。

### 6. 资料教学链路（核心）

1. 用户在 KB 中勾选 1–N 篇 → `openCall({kbMode:'grounded', kbDocIds})`。
2. server voice start：
   - `buildKBTeachingMaterial(docIds, {maxChars:5600})` 注入完整资料（受 system_role 8000 字符限制）；
   - `buildRealtimePersona({kbMode:'grounded', kbMaterial})` 返回**资料课专用人格**：
     - 只讲材料；不管用户说什么都不跑题；
     - 从第一句开始、逐句、一次一句；
     - 一次最多纠一个错误；引用不超过 20 词；
     - 不重复整句、不要求整句重读。
3. 客户端：
   - 资料模式跳过自由聊天开场白；
   - `autoStartMaterialLesson()` 自动读第一句并高亮；
   - 老师音频用独立 TTS（见 voice 文档）；
   - 文档窗可点击任意句 → 定位 + TTS 朗读；
   - 资料模式实时音频静音，避免和 TTS 叠音。
4. 文本聊天同样使用 `buildGroundedChatSystemPrompt()`，并注入完整资料；`/api/chat` 的 grounded 模式禁用 director。

### 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 资料重复句/朗读重复 | 旧 chunk overlap=120，或 `slice(-0)` 把上一段整段带入 | 新版本 chunk overlap=0，客户端/服务端对老文档 strip overlap |
| 图片 OCR 乱码 | OCR 错误 | 必须走校对弹层；不要直接入库 |
| 资料引用不出现 | 检索无命中 | 客户端本地句子匹配兜底 |
| 资料被截断 | system_role 8000 字符 | 当前限制 5600 字注入；长文需后续分段路由 |

---

## B. 英语书库（内置每日节选）

### 1. 文件

- `web/js/mobile/book-library.js`：静态数据 `BOOK_LIBRARY`。
- `web/js/mobile/library.js`：每日选择、进度、入库、开课、完成、词同步。
- `web/css/library.css`：书库 UI。

### 2. 书籍与结构

6 本公版经典（按难度）：

| id | 书名 | 等级 | 作者 |
|---|---|---|---|
| happyprince | The Happy Prince / 快乐王子 | A2 | Oscar Wilde |
| magi | The Gift of the Magi / 麦琪的礼物 | A2 | O. Henry |
| alice | Alice in Wonderland / 爱丽丝梦游仙境 | B1 | Lewis Carroll |
| odyssey | The Odyssey / 奥德赛 | B1 | Homer |
| carol | A Christmas Carol / 圣诞颂歌 | B2 | Charles Dickens |
| gatsby | The Great Gatsby / 了不起的盖茨比 | B2 | F. Scott Fitzgerald |

每本：
```js
{
  id, title, titleZh, author, level, introZh,
  sourceNote: '公版经典 · 学习节选',
  days: [{ title, text }], // 5 天，约 130–180 词/天
  focusWords: [{ word, meaning, example }],
  focusPatterns: ['...']
}
```

内容来自 Project Gutenberg 公版文本，做了学习节选与分日；**不是完整原著**。

### 3. 每日进度（localStorage）

键：`ava.book.library.v1`

```json
{
  "version": 1,
  "currentBookIndex": 0,
  "books": {
    "happyprince": { "cursor": 1, "completedDays": [0] }
  },
  "today": {
    "date": "2026-11-01",
    "bookId": "happyprince",
    "dayIndex": 0,
    "started": true,
    "completed": false,
    "docId": "kb_xxx",
    "createdAt": 0
  },
  "lastStudyDate": "2026-11-01",
  "streak": 1,
  "totalMinutes": 10,
  "totalCompleted": 1
}
```

规则：
- 同一自然日重复打开：返回同一个 `today`。
- 新的一天：`ensureToday()` 取当前书的 `cursor`，创建新 `today`，`cursor + 1`。
- 一本 5 天读完 → `nextBookWithRoom()` 自动切下一本。
- 6 本 30 天读完 → 重置所有 cursor，开始第二轮复习（保留 completedDays）。
- `completeToday()`：标记完成、`streak/totalMinutes/totalCompleted` 更新。
- `startTodayLesson()`：创建 KB 文档 `source=library` → 关闭弹层 → `ui.openCall({kbMode:'grounded',...})`。
- 启动/选中书后调用 `/api/review/add` 把 `focusWords` 写入复习词库。

### 4. 每日学习闭环（产品约定）

1. 老师带读第一句（自动，不需特定话术）。
2. 学生跟读；老师只纠一个错误，不整句重读。
3. 重点词/句型在资料底部；老师围绕资料讲解。
4. 回到书库点「标记完成」→ 连续天数/分钟/完成节数 +1。
5. 第二天自动出现下一节；重点词进入「复习」SRS。

### 5. 新增一本书的步骤

1. 在 `web/js/mobile/book-library.js` 增加对象：
   - 5 个 `days`（建议 130–180 词/天，避免长引用）；
   - 6 个 `focusWords`（尽量出现在文本中）；
   - 3 个 `focusPatterns`。
2. 确认 `id` 唯一；前端顺序即书库顺序（当前按 A2→B2）。
3. 公版文本：标 `sourceNote`；如为自制改写，明确标注“非原文”。
4. 跑一次书库页/开始今日带读，确认：
   - 书库 6/7 本卡片布局；
   - `save-text` source=library；
   - 资料第一句正确、无 chunk 重复；
   - 完成按钮、streak、复习词同步。
5. 可选：更新 `docs/assets/hero-v83-library-sheet.png` 截图。
