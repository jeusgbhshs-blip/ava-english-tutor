# 14 · 打包说明

## 包名

`english-tutor-handover-20261101.zip`

## 包含内容

- 全部运行源码：`server.js`、`lib/`、`content/`、`web/`、`scripts/`、`start.command`、`package.json`
- 当前主前端与旧桌面版源码、`web/assets/characters` 角色素材
- 测试代码与 fixtures（不含测试截图）
- 文档：`README.md`、`SPEC.md`、`docs/使用说明.md`、`docs/测试报告.md`、`docs/handover/`
- 脱敏示例：`docs/handover/examples/*.json`

## 排除内容

| 路径 | 原因 |
|---|---|
| `data/` | 个人 API Key、知识库、记忆、计划、复习数据 |
| `data-share/` | LAN 分享实例数据 |
| `.runtime/` | PID/URL |
| `test/artifacts/` | 121MB 测试截图/日志 |
| `docs/assets/` | 106MB 历史 UI 截图（原仓库保留） |
| `node_modules/` `.DS_Store` | 依赖/系统文件 |

> 因此 README/交接文档里引用的历史截图在 zip 中不会存在；需要看截图时使用原工作区。交接包内的核心产品截图见 `docs/handover` 提到的原路径。

## 交接时测试状态

- 2026-11-01：`node --test test/api.test.mjs` → **225 tests / 225 pass / 0 fail**。
- 未在交接包生成时重新跑 `test:e2e` / `test:ui`（需要本机 Chrome/CDP）；命令与 mock 已包含。
- 真实豆包实时语音/TTS 需要单独凭据与网络，包内不含凭据。

## 解压后快速检查

```bash
cd english-tutor
node server.js --port 5180 --host 127.0.0.1
curl -s http://127.0.0.1:5180/api/health
```

然后打开 `http://127.0.0.1:5180/mobile`；设置页填模型/语音凭据。
