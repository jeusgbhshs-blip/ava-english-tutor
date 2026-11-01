# Ava — AI 英语口语数字人互动教学 · 开发交接包

> 交接版本：2026-11-01  
> 源码根目录：`english-tutor/`  
> 当前主要入口：`http://127.0.0.1:5180/mobile`（手机/桌面浏览器均可打开，当前产品按桌面优先）  
> 交接目的：让新的前端 / 后端 / 语音 / 内容开发者可以独立理解、启动、调试和继续开发本项目。

---

## 1. 先看这几件事

1. **当前活跃前端是 `web/mobile.html` + `web/js/mobile/*`。**
   - `web/index.html`、`web/js/main.js`、`web/js/modes.js`、`web/js/avatar/*` 是早期桌面版/实验版，保留但不作为后续主开发目标。
2. **零构建、零 npm 依赖**：Node 24 原生 ESM + 原生 `http` / `WebSocket`；前端原生 ES Modules + 原生 CSS；没有 React/Vue/Webpack/Vite。
3. **所有数据默认在本机文件系统**（`data/` 或 `AVA_DATA_DIR`），没有账号系统、数据库、云同步。
4. **语音是两条独立链路**：
   - 实时对话：浏览器 → 本地 `/ws/voice` → 火山豆包 realtime dialogue；
   - 角色朗读：浏览器 → `/api/tts` → 火山独立 TTS（长文本服务端自动分块）。
5. **不要把 `data/`、`data-share/`、`test/artifacts/`、`docs/assets/` 提交给外部**：包含个人知识库、API Key、对话记忆和大量截图。

## 2. 快速启动

```bash
cd english-tutor
node server.js --port 5180 --host 127.0.0.1
# 浏览器打开 http://127.0.0.1:5180/mobile
```

macOS 可双击 `start.command`；局域网分享用：

```bash
./scripts/share.sh
# 默认 http://<本机IP>:5181/mobile，数据目录 data-share/
```

设置步骤：页面 → 我的 → 设置（或桌面版设置）→ 填 DeepSeek/OpenAI-compatible API Key；语音需要豆包 App ID + API Key/Access Token + 实时语音资源。

## 3. 交接文档索引

| 文档 | 内容 |
|---|---|
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | 总体架构、进程/端口、前后端拓扑、主要数据流 |
| [02-MODULE-MAP.md](02-MODULE-MAP.md) | 每个目录、每个模块的职责与依赖 |
| [03-VOICE-PIPELINE.md](03-VOICE-PIPELINE.md) | 麦克风 → 实时语音 → 字幕 → TTS 的完整链路 |
| [04-KB-AND-LIBRARY.md](04-KB-AND-LIBRARY.md) | 知识库导入、检索、资料教学、英语书库/每日节选 |
| [05-API-REFERENCE.md](05-API-REFERENCE.md) | 全部 HTTP API、SSE 格式、WebSocket 协议 |
| [06-DATA-MODEL.md](06-DATA-MODEL.md) | 服务端 JSON 数据、localStorage 键、数据生命周期 |
| [07-FRONTEND-MOBILE.md](07-FRONTEND-MOBILE.md) | 手机版页面、Tab、通话页、知识库、书库、状态管理 |
| [08-COURSE-REVIEW-GAMES.md](08-COURSE-REVIEW-GAMES.md) | 三课计划、课件生成、复习 SRS、小游戏、总结 |
| [09-LLM-PROMPTS.md](09-LLM-PROMPTS.md) | 模型配置、prompt 文件、反馈 JSON、资料课规则 |
| [10-TESTING-OPS.md](10-TESTING-OPS.md) | 测试命令、Mock、部署、安全、日志 |
| [11-KNOWN-ISSUES.md](11-KNOWN-ISSUES.md) | 已知问题、限制、建议的下一步 |
| [12-CODE-TOUR.md](12-CODE-TOUR.md) | 按修改场景定位关键函数 |
| [13-GLOSSARY.md](13-GLOSSARY.md) | PTT/ASR/TTS/SRS 等术语 |
| [14-PACKAGE-CONTENTS.md](14-PACKAGE-CONTENTS.md) | 交接包范围/排除项/测试状态 |
| [SOURCE-MANIFEST.md](SOURCE-MANIFEST.md) | 源码清单、行数、SHA256、打包范围 |
| [examples/](examples/) | 脱敏配置/数据示例 |

根目录已有 `README.md`（产品迭代记录/变更日志）和 `SPEC.md`（早期技术契约与历史需求），**建议先读本交接包，再用 README 查历史决策**。

## 4. 新开发者第一天建议顺序

1. 启动服务，确认 `/api/health`、打开 `/mobile`。
2. 读 `01-ARCHITECTURE.md` + `02-MODULE-MAP.md`。
3. 在设置里填 key，跑一次文字聊天（`/api/chat`）和一次实时语音通话。
4. 读 `03-VOICE-PIPELINE.md`，重点理解 `doubao-voice.js` ↔ `server.js handleVoiceSocket` ↔ `lib/volcRealtime.js`。
5. 读 `04-KB-AND-LIBRARY.md`，走一遍 知识库上传→讨论→资料对照窗→总结。
6. 改一个小需求（如新增一本书/一个 API）后跑 `npm test`、`npm run test:e2e`。

## 5. 交接时已知的关键注意点

- **没有登录/权限系统**：所有访问者共享同一份服务端数据；LAN 分享模式尤其要注意。
- **图片 OCR 仅 macOS**：`lib/docExtract.js` 调用 macOS Vision（`swift`/`osascript` 相关脚本）；Linux/Windows 需替换 OCR 引擎。
- **实时语音依赖火山网络**：上游超时会由客户端自动重连/角色 TTS 续讲；日志在 `/tmp/ava-5180.log`（若按 README 启动）。
- **资料课 prompt 有 8000 字符 system_role 上限**，所以实时语音注入的资料被限制在 5600 字符；长文完整教学需要后续做分段检索/上下文路由。
- **TTS 文本会按 500 字符分块，最多 4000 字符**；超长文章不会整篇朗读，应走逐句/分段教学。
- **每日书库进度是浏览器 localStorage**，不是服务端账号；多设备不会同步。
- **当前测试以 API/UI 自动化为主**，真实实时语音链路（火山）主要靠 mock + 手动验证。
