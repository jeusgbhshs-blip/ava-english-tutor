# Ava iPhone 开发与发布路线

更新时间：2026-11-02（北京时间）。这份交付提供 iOS 开发工程和个人服务部署方案；不是已经签名、上架或完成真实语音验收的产品。

## 技术方案

- 现有二进制豆包接口默认使用 O2.0（模型 `1.2.1.1`）和 Dacey 英语音色。Seeduplex 3.0 属于另一套 JSON 协议，本轮未迁移。旧配置 `3.0` 会提示修正，不静默替换用户配置。
- 保留英语学习功能和豆包语音。Capacitor 8.6 将前端文件打包进 App，不依赖远程页面加载代码。
- 最低 iOS 16，支持横竖屏。界面采用安全区域与可视视口尺寸，统一字幕、按钮、资料面板和弹层的位置。
- API 与 WebSocket 连接 HTTPS 服务。供应商密钥只保存在服务端；App 访问码保存在钥匙串，原生桥接日志关闭。
- 语音使用 30 秒、一次性授权票据；长期访问码不放进 WebSocket 地址。后台及系统音频中断会暂停语音，用户再次点击后恢复。
- 知识库默认允许 100 MiB 源文件，使用二进制上传与临时文件处理。当前用于教学的提取文本最多 60,000 字符，界面提示截断；这不等于模型能一次理解整本大书。
- 网页导入有私网访问防护、重定向与响应容量限制，以及线性 HTML 文本解析。

## 开发与构建

使用 Node.js 24。Node 服务本身仍不依赖第三方 npm 包；`npm ci` 安装原生打包工具。

```sh
npm ci
npm run check
npm test
npm run test:e2e
npm run ios:sync
npm run ios:verify
npm run ios:open
```

`ios:verify` 只检查资源、配置、图标、权限和桥接注册，不编译应用。原生编译需要完整 Xcode 26+。

打开 `ios/App/App.xcodeproj`，使用共享 `App` scheme。暂定 Bundle ID 为 `io.github.jeusgbhshsblip.ava`；开发者账号注册前应确认命名可用，并选择开发团队。模拟器无需发布证书，真机分发和 TestFlight 需要签名配置。

`.github/workflows/ios.yml` 在 `codex/**` 分支推送及 PR 时构建无签名模拟器 App，保留日志与 ZIP。工作流存在不等于运行成功，应检查具体结果。模拟器 `.app` 不能安装到真实 iPhone，也不是商店 `.ipa`。

已有服务地址时可预填：

```sh
AVA_IOS_BACKEND_URL=https://ava.your-domain.com npm run ios:sync
```

访问码和豆包密钥不能放进这个变量、Capacitor 配置或安装包。

## 个人 HTTPS 服务部署

当前同一服务和访问码共享同一份资料、设置与学习记录。此方案适合本人验收或隔离的个人实例。面向多名顾客的正式服务，需先完成账号、数据归属、配额和删除机制。

准备支持 Docker Compose 的服务器及域名，设置 DNS 并开放 80/443。仓库提供 Node 24 容器、持久数据卷、访问认证和 Caddy HTTPS 配置。

```sh
node scripts/setup-private-server.mjs ava.your-domain.com
docker compose up -d --build
```

脚本仅在 `.env` 不存在时创建文件，权限 600，不打印访问码。访问码从该文件进入 App 连接界面，不应贴进聊天、日志或 GitHub。服务启动后，在自己的设置界面配置已开通的豆包/模型凭据。

默认单文件 100 MiB；改变 `AVA_MAX_UPLOAD_MB` 时应同时调整 Caddy 请求体上限和内存配置。可设置范围 1–500 MiB，不宜未经压力测试就设为最大。

Linux 容器不能运行现有 macOS Vision OCR。普通文字 PDF、TXT/MD/TSV/CSV、DOCX/PPTX、ODT/HTML 按实际解析能力使用；图片及扫描 PDF 的云端 OCR 仍需补齐。复杂排版应预览校对，不能宣称支持所有 PDF 或不限容量。

备份持久数据卷，升级前保留旧镜像和备份。只运行单个写入实例；当前文件存储不支持多个服务副本同时写一个数据目录。

## 真机验收

| 场景 | 验收要点 |
| --- | --- |
| 首次启动 | 数据处理说明、访问码、Keychain、重开恢复 |
| 麦克风 | 首次允许、拒绝、重新允许、按键输入 |
| 实时语音 | 真 ASR 字幕、回复音频、英语音色、打断、挂断停声 |
| 独立点读 | 开通 TTS 后验证课程、词库、资料中的点读 |
| 系统变化 | 后台、锁屏、来电、耳机/蓝牙、断网恢复 |
| 界面 | 小屏、安全区域、横屏、键盘、滚动、弹层 |
| 文件 | 普通/扫描 PDF、Office 文件、容量边界、超限、取消、截断 |
| 数据 | 删除资料、课程断点、评分、重启、服务之间缓存隔离 |

## App Store 提交顺序

1. 本人完成 Apple Developer 注册与身份验证，建立 App Store Connect 应用和最终 Bundle ID。
2. 确定个人客户端或公众产品的发行方式；若面向多人，先完成独立账号和数据隔离。
3. 补齐运营主体、联系邮箱、支持网址、正式隐私政策、实际 AI 数据处理方和保留/删除期限。`web/privacy.html` 是开发测试说明，不是已完成的正式政策。
4. 核对角色图、书库节选和声音的商用权利。若销售数字课程或会员，按销售地区及 Apple 当前规则实现支付。
5. 正式签名构建并上传 TestFlight，完成真机、多设备和真实语音验收。
6. 使用实际 App 截图，填写年龄分级、隐私标签、审核说明和有效审核访问方式，再提交审核。

Apple 当前要求上传包使用 Xcode 26+ 与 iOS 26+ SDK 构建，App 最低运行版本仍可为 iOS 16。第三方 AI 数据共享需要清楚说明并取得许可；以后若提供账号注册，也需提供应用内账号删除。最终资料应与实际部署一致。

官方依据：[Apple 构建要求](https://developer.apple.com/news/upcoming-requirements/)、[审核指南](https://developer.apple.com/app-store/review/guidelines/)、[Capacitor 环境要求](https://capacitorjs.com/docs/getting-started/environment-setup)、[豆包 iOS 接入](https://docs.volcengine.com/docs/doubao-voice/end-to-endios-sdk-interface-documentation?lang=zh)。

具体审计与未完成条件见 [RELEASE-AUDIT.md](RELEASE-AUDIT.md)。
