# 08 · 课程、复习、小游戏、总结

## A. 三课计划（plans.js + lessonGen.js）

### 1. 产品规则

- 学习计划由用户一句话定义（例如“咖啡店点单 + 机场值机，A2”）。
- 固定 **3 节课**，每节课 5 句常用句 + 3 步练习：
  1. repeat 跟读常用句
  2. practice 场景练习
  3. challenge 完成挑战
- 一个计划一个老师（Elena/Maya/Hikari），可切换。
- 顺序解锁：完成上一课才能进入下一课。
- 断点续学：`lesson.resume` 记录 step/phraseIdx/练习轮数。
- 课件生成是异步的：计划先返回 `generating` 骨架，后台 `generatePlanLessonsInBackground()` 调 LLM，前端 2s 轮询；失败可重试。

### 2. 数据流

```
助手 /api/assistant
  → lib/assistant.detectIntent
  → create_plan/update_plan action.payload (plan v3)
  → server savePlan + generatePlanLessonsInBackground
  → lib/lessonGen.generatePlanLessons (LLM JSON)
  → fillPlanLessons → status ready/error
  → GET /api/plan → decoratePlan
  → screens.renderCourses
```

### 3. 上课

- 课程卡「开始上课」→ `openCall(character, sceneIdx, {lessonId, lessonStep,...})`。
- 通话页 `C.lesson`；实时语音 start frame 带 `lessonId/lessonStep`；服务端 `buildRealtimePersona` 注入 lesson block。
- 每一步完成调 `/api/plan/lesson-progress`；全部步骤完成调 `/api/plan/scene-done`，后端校验 requiredSteps 后解锁下一课。
- 返回/挂断会 flush 断点；`/api/plan/lesson-restart` 可从头。

### 4. 代码入口

- `lib/plans.js`：数据结构、`createUserPlan`、`fillPlanLessons`、`saveLessonProgress`、`completeLesson`、`decoratePlan`。
- `lib/lessonGen.js`：后台生成/状态/失败重试。
- `content/prompts.js`：`buildPlanLessonsMessages`。
- `screens.js`：`renderCourses`、老师切换、生成轮询。
- `call.js`：lesson 状态/步骤/断点。

---

## B. 复习 / SRS

### 1. 数据与状态

- 服务端词库：`data/review.json`；每词一条 SRS 记录。
- 服务端统计：`lib/review.getSummary()` → total/dueCount/newCount/learningCount/knownCount。
- 浏览器每日复习目标/进度：`ava.review.daily.v1`；会话草稿：`ava.review.session.draft.v1`。
- 每日提醒：`ava.review.remindedDate`。

### 2. 评分（四档）

| grade | 含义 | 结果 |
|---|---|---|
| again | 不认识 | 10 分钟后重来，lapses+1 |
| hard | 模糊 | 短间隔 |
| good | 认识 | 正常间隔 |
| easy | 简单 | 更长间隔 |

实现：`lib/review.gradeWord()` + `lib/srs.js`（Leitner 盒子 `[0,1,2,4,7,14,30,60]` 天）。

### 3. 复习页面

`web/js/mobile/review.js`：
- `renderReview()` 根据 `R.view` 切换 home/session/finish/manage/game。
- 会话：`startSession('due'|'extra'|'again')`，卡片翻面，`gradeCurrent()`，进度环；
- 每日 target：`targetToday = max(due, min(10,...))`；完成/退出进度保存；
- 主页环显示「今日复习」百分比；完成后 100%；有草稿时显示「继续复习 · N」；
- 词库管理：`openManage()`，状态筛选/搜索/新增/删除；
- 游戏：`openGame('match'|'listen'|'spell')`。

### 4. 单词来源

- 总结 `/api/summary` 的 `keyWords` → `wordbook` + `progress` + `review.syncFromSummary`；
- 对话 summary feedback 的 `newWords` 也会被前端/后端收集（旧路径）；
- 英语书库 `library.syncWords()` 直接 `/api/review/add`；
- 用户手动加词/词库管理。

---

## C. 小游戏

### 1. 三款游戏

| kind | 名称 | 规则 | 题量 |
|---|---|---|---|
| match | 词义配对 | 英文 ↔ 中文两两配对 | 5 对/轮 |
| listen | 听音选词 | 播放单词发音，4 选 1（选项含中文） | 6 题 |
| spell | 拼写填空 | 看释义/音标拼单词；提示一个字母/不会看答案 | 5 题 |

词库：复习库优先；不足使用内置 `SAMPLE_WORDS`。游戏为桌面单屏布局，不能滚动。
- 入口在复习 Tab；`review.js` 内联游戏实现（`games.js` 是旧“趣玩”词义配对，功能有重叠）。
- 结果计入本地分数 key；不写入 SRS（避免游戏刷分影响复习）。

### 2. 修改注意

- 单屏：1440×900、1280×800 都不能出现滚动条；
- 选项必须双语/中文提示；拼写要有提示与跳过；
- 不要使用虚线框、深色大暗层；
- 新游戏必须提供 `cleanup()`，避免切页后定时器泄漏。

---

## D. 挂断总结

```
用户挂断
  → call.js 显示 summary overlay
  → POST /api/summary/quick (规则总结，立即显示)
  → POST /api/summary (LLM 总结，替换 quick)
  → 显示：summary、keyWords、keyPatterns（重点句型）、corrections
  → 关闭总结 → 真正结束通话
```

服务端 `/api/summary` 还会：
- `addWords(keyWords)` 写当天单词表；
- `addVocabWords` 写 progress SRS；
- `syncReviewFromSummary` 写 review 词库；
- 更新角色长期记忆（有 API key 时）。

关键要求：**每次挂断必须有总结**（用户明确要求），且包含**重点句型 + 重点单词**。`lib/summary.js` 的 `normalizeSummary`/`normalizeKeyPatterns` 做兜底。
