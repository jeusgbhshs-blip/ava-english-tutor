# 07 · 手机版前端（当前主产品）

## 1. 入口与启动

`web/mobile.html` 加载：

```html
CSS: mobile.css → review.css → glass.css → call-redesign.css → library.css
JS : js/mobile/app.js (type=module)
```

`app.js boot()`：

1. 画首屏骨架；
2. `bindChrome()`：Tab、键盘快捷键、返回键、弹层/sheet、通话返回；
3. `registerUi()`：把 `openCall/openKbPanel/openSheet/...` 注册进 `core.js` 的 `ui` 对象；
4. `loadInitialData()`：并行 `loadCharacters/loadPlan/loadSettings/loadContent`；再异步 `loadProgress/loadWordbook`；
5. `initWorld()` + `setWorld()`：背景双图层人物；
6. `switchTab('courses')`；
7. `initReview()`：复习徽标/每日提醒；
8. 暴露 `window.__avaMobile` 调试接口。

## 2. 全局状态 `M`（core.js）

```js
M = {
  tab: 'courses',
  characters: [],
  activeCharId: 'elena',
  plan: null,
  settings: null,
  content: null,
  progress: null,
  wordbook: null,
  loaded: false,
  nickname: '英语学习者'
}
```

`core.js` 负责：
- `$`/`$$`/`esc`/`icon`/`toast`/`mmss`；
- 角色封面/主题；
- API 包装：`assistantChat`、`translateTexts`、`fetchSummary`、`chatStream`、KB 方法、profile；
- 本地计划缓存：`saveLocalPlan/loadLocalPlan/buildLocalPlan`。

## 3. 五个 Tab（screens.js）

| Tab | 渲染函数 | 关键内容 |
|---|---|---|
| 课程 `courses` | `renderCourses()` | 计划空态/生成中/就绪；3 节课、老师切换、开始/继续、断点 |
| 对话 `chat` | `renderChat()` | 角色卡/进入通话；当前角色世界背景 |
| 助手 `assistant` | `renderAssistant()` | 与 Ava 文字对话、创建/更新计划、我的知识库入口、英语书库入口 |
| 复习 `review` | `renderReview()`（review.js） | SRS 首页/会话/管理/游戏 |
| 我的 `profile` | `renderProfile()` | 设置、统计、兴趣、昵称、诊断入口 |

Tab 切换：
- 保存/恢复各 screen 滚动位置；
- 离开 review 调 `onReviewTabLeave()`，进入调 `onReviewTabEnter()`；
- 不播放入场动画（保证 backdrop-filter 稳定）；
- 课程/复习会触发刷新；
- 键盘 `1-5` 切 Tab；左右箭头在 Tabbar 内切换。

## 4. 外壳与弹层（app.js）

- `openSheet(title, html)`：全局唯一 sheet（`#sheet`），用于单词表/粘贴文本/OCR 校对/书库/总结。
- KB 整屏：`#kb-screen`，独立于 sheet；`ui.openKbPanel/closeKbPanel`。
- history 返回栈：
  - `pushOverlay('sheet'|'kb'|'call')`；
  - `popstate` → 优先关 sheet → KB → 通话 → review 子视图。
- 通话页是全局 overlay，不是 Tab；打开通话会关闭 sheet/KB 并压历史。
- 关闭 sheet 时 `notifySheetClosed()` → `call.js onSheetClosed()`，用于“总结弹层关闭后才真正挂断”。

## 5. 通话页（call.js）

### 5.1 DOM 结构（`mobile.html`）

```
#call
├─ #call-bg / #call-glow / 分层人物 img
├─ 顶部：返回、名字、状态、计时
├─ #call-side-actions（左侧记录/历史）
├─ #call-bubbles（隐藏的消息记录）
├─ #call-docs（右侧讲解资料窗）
├─ #call-dialogue（唯一台词框：用户最新句 + 老师英文/中文）
├─ #call-mode-row（知识库讨论/切换）
├─ #mic-dock（麦克风环境提示）
├─ #call-ptt（录音计时/波形/取消/完成）
├─ #call-textform（文字输入，兜底）
└─ #call-control-dock（主按钮组：记录/静音/翻译/麦克风/提示/挂断）
```

### 5.2 通话状态 `C`

核心字段（简化）：

```js
C = {
  open, engine:'volc|browser', state:'idle|listening|thinking|speaking',
  ptt:'idle|connecting|recording|submitting|speaking',
  character, messages: [{role,content}], userTurns,
  kbMode:'free|grounded|divergent', kbDocIds, kbDocs,
  docs: { docs, activeId, activeChunk, activeSentence, follow, fontSize, ... },
  lesson, lessonStep, ...,
  volc, volcToken, volcRecovering, volcWarmPromise, ...
}
```

### 5.3 主要内容区

- **通话记录**：`#call-bubbles` + 左侧记录按钮；历史面板可查看用户/老师消息、引用、总结入口。
- **台词框**：只显示最新用户句 + 老师当前回复；英文/中文双语；长回复内部滚动，不裁字。
- **资料窗**：仅打开 KB 时显示；桌面宽屏占右侧约 38vw；左边内容限制宽度避免遮挡。
- **模式切换**：知识库讨论（grounded）→ 发散（divergent）→ 自由聊（free）；切换时更新实时会话 `/api/tts` 静音/预热。
- **PTT/文字**：主按钮点击切换；文字输入走 `/api/chat`，资料模式文字回复也会用角色 TTS。
- **口播动画**：`talking-head.js` WebGL 引擎；未就绪用静态图；state 驱动口型。
- **挂断总结**：`/api/summary/quick` 先出规则版 → `/api/summary` AI 替换；重点词/句型；关闭总结后结束通话。

### 5.4 调试接口

`window.__avaMobile`：

```js
openCall/openKb/closeKb/switchTab/setCharacter/setWorld
getCallState()/togglePtt()/cancelPtt()/simulateTranscript(text)
previewSpeaking(ms)
micDiagnostics()
review.startSession()/flip()/grade()/back()
openSheet/closeSheet/send(text)
refresh()
```

`window.__avaErrors` 收集运行时错误（最多 24 条），可用于 CDP/Ui 测试。

## 6. 知识库面板（kb.js）

- 整屏 `#kb-screen`，不是 sheet；
- 左侧：**英语书库卡片（今日）**、添加材料（文件/URL/粘贴）、使用提示；
- 中部：材料列表（多选/预览/删除/轮询 enrich）；
- 底部：围绕知识库讨论 / 发散讨论 / 自由聊；
- 图片：先 `/api/kb/preview-file` → OCR 校对 sheet → `/api/kb/save-text`；
- 英语书库卡片：`libraryBlockHtml()`，动作 `library-start/library-open/library-complete`。

## 7. 英语书库（library.js）

- 助手页入口 + KB 侧栏卡片；
- sheet：今日卡 + 6 本书 + 进度/连续天数；
- `ensureToday()` 每日选节；`startTodayLesson()` 写 KB + 开 call；`completeToday()` 记完成；
- 进度 localStorage，详见 `04-KB-AND-LIBRARY.md`。

## 8. 复习（review.js）

- 首页：今日到期/生词本/已掌握/掌握环；
- 会话：卡片翻转、四档评分、SRS、进度环；
- 每日进度：`ava.review.daily.v1` 目标 + 已完成；会话草稿 `ava.review.session.draft.v1` 支持中途退出续做；
- 词库管理：状态筛选/搜索/新增/删除/发音；
- 小游戏：词义配对、听音选词、拼写填空；单屏布局（桌面）；
- 每日提醒：进入 review Tab / 初始化时检查 due，弹一次 toast + 徽标。

## 9. CSS 组织

| 文件 | 范围 | 注意 |
|---|---|---|
| `mobile.css` | 手机版基础布局、Tabbar、screen、assistant、KB 基础 | 2200 行；改动需回归所有 Tab |
| `review.css` | 复习页 + 游戏；单屏 grid、无虚线框 | 1259 行；桌面优先 |
| `glass.css` | 毛玻璃、KB 重设计、资料窗、我的、弹层 | 747 行；有 `prefers-reduced-transparency` |
| `call-redesign.css` | 通话页方案 C；左侧记录/PTT、台词框长文本、资料窗布局 | 360 行；和 `glass.css` 有覆盖关系 |
| `library.css` | 书库卡片/弹层 | 2026-11 新增 |

设计约束（用户明确要求）：
- 桌面优先；不要做手机适配；
- 不要重叠/遮挡；不要虚线/虚框；不要深色大暗层；用毛玻璃；
- 复习课/3 个游戏必须单屏不滚动；
- 资料窗在右时，记录/PTT/识别/台词在左；
- 长台词不得裁字（内部滚动，页面不拖）。

## 10. 前端扩展建议

1. 新页面优先在 `mobile/` 加 screen 或 sheet，不要动旧桌面版。
2. 新 API 统一放 `api.js`（core 复用）或 `mobile/core.js` 直接 `postJSON`；保持“永不 throw”约定（返回 `{ok:false}`）。
3. 任何全局状态放 `core.js` 的 `M`，模块局部状态放模块对象；不要污染 window（调试接口除外）。
4. 修改通话页前读 `03-VOICE-PIPELINE.md`；改 UI 前用 1440×900 截图回归。
