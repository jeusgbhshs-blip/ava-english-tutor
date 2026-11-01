# 10 · 测试、运行与运维

## 1. 环境

- Node.js **24**（项目使用原生 ESM、内置 WebSocket、`AbortSignal.timeout` 等）。
- macOS 推荐；图片 OCR 依赖 macOS Vision。
- 无需 `npm install`（零依赖）。`package.json` 只定义 scripts。
- Chrome/Edge 用于前端（当前产品按桌面浏览器调优）。
- 需要麦克风权限与安全上下文：`http://127.0.0.1` 或 `https://`。局域网纯 HTTP 下浏览器可能禁用麦克风（见 README）。

## 2. 启动

```bash
node server.js --port 5180 --host 127.0.0.1
node server.js --open            # 自动打开 Chrome
./scripts/share.sh                # LAN 分享，5181，data-share
```

- 端口冲突会自动尝试 5180+1…+19（`main()`）。
- `.runtime/url.txt` / `.runtime/pid.txt` 记录实际地址/PID。
- 进程信号 `SIGINT`/`SIGTERM` 会关闭 HTTP server 并退出。

## 3. 测试命令

```bash
npm test          # node --test test/api.test.mjs
npm run test:e2e  # test/e2e.mjs，启动 mock upstream + 服务
npm run test:ui   # test/ui.mjs，Chrome 截图/UI 断言（依赖本机 Chrome）
```

测试资产：
- `test/mock-upstream.mjs`：Mock OpenAI-compatible/HTTP，避免真实 API 计费；
- `test/mock-volc-realtime.mjs`：Mock 火山 WSS，验证实时语音桥；
- `test/fixtures/`：txt/md/docx/pptx/pdf/图片/不支持文件。

已知限制：
- 真实火山实时语音/TTS 需要凭据，CI 只覆盖 mock；
- UI 测试使用本机 Chrome/CDP；没有 Playwright/Puppeteer 依赖（自写 CDP 脚本）；
- 测试截图在 `test/artifacts/`，不要提交/打包。

## 4. 手动验收清单（改核心后至少跑）

1. `/api/health` 返回 `ok:true`。
2. 设置页填入 key → 文字聊天 → 流式回复 + 双语。
3. 进入通话 → 麦克风权限 → 点麦克风说一句 → 用户字幕 + 老师回复。
4. 知识库：上传/粘贴/URL → 勾选 → 围绕资料讨论 → 资料窗高亮 → 挂断总结含重点词/句型。
5. 资料模式：进入后自动第一句；用户问无关话题仍回材料；纠错只纠一个 chunk；不整句重读。
6. 英语书库：开始今日带读 → 生成 KB 文档 → 资料课 → 标记完成 → streak +1 → 第二天 Day 2。
7. 复习：到期卡片 → 四档评分 → 环/徽标；三款小游戏单屏。
8. 1440×900、1280×800、1920×1080 检查无遮挡/滚动（复习/游戏必须单屏）。

## 5. 日志与诊断

- 服务端 stdout：`[voice] upstream error/closed`、启动信息。
- 前端 `window.__avaErrors`（最多 24 条）。
- 通话诊断：`window.__avaMobile.micDiagnostics()`，返回 URL/权限/输入设备/voice 状态。
- `AVA_DEBUG_CONTEXT=1` → `/tmp/ava-ctx-system.txt`。
- TTS：响应头 `x-tts-speaker` / `x-tts-cache`；缓存目录 `data/tts-cache`。
- KB enrich 状态：`pending/done/error`；前端会轮询。

## 6. 部署

### 本机长期运行

```bash
nohup node server.js --port 5180 --host 127.0.0.1 > /tmp/ava-5180.log 2>&1 &
```

### LAN 分享

```bash
AVA_DATA_DIR="$PWD/data-share" nohup node server.js --port 5181 --host 0.0.0.0 > /tmp/ava-share-5181.log 2>&1 &
```

- 分享实例与个人数据隔离；
- 首次会复制个人 settings 到 `data-share/`（含 key，注意权限）；
- 所有访问者共享该实例的 API 额度、复习数据、KB；
- 不要暴露到公网：无认证、无速率限制、API 可被滥用。

### 反向代理/HTTPS

- 麦克风需要安全上下文；如果通过局域网 HTTP 访问，浏览器可能拒绝 getUserMedia。需要 HTTPS 反代或本机 127.0.0.1。
- WebSocket `/ws/voice` 要支持 Upgrade；普通反代需配置 `proxy_http_version 1.1`、`Upgrade`/`Connection`。

## 7. 安全要点

- API Key 只在服务端 `settings.json`（600）；前端只拿打码提示。
- 没有 CSRF/鉴权；`127.0.0.1` 模式相对安全；`0.0.0.0` 只用于可信 LAN。
- 文件上传有限制（普通 API 1MB/文件 20MB/KB 6MB/TTS 64KB），但没有病毒扫描。
- 不要将 `data/` 备份到公共仓库。
- 错误信息可能包含上游返回摘要（截断 200 字）；生产化应做脱敏。

## 8. 发布/打包

- 交接包生成方式见 `SOURCE-MANIFEST.md`：排除 `data/`、`data-share/`、`test/artifacts/`、`docs/assets/`、`.runtime/`、`.DS_Store`。
- 需要包含：源码、`web/assets/characters`、`content/`、`test/`、`SPEC.md`、`README.md`、`docs/使用说明.md`、`docs/测试报告.md`、本 `docs/handover/`。
- 运行环境只要求 Node 24；不需要构建产物。
