# Ava 后端与数据层逆向审查

审查对象：`仓库根目录`，用户提供 2026-11-01 交接包的解压源码。审查方式：逐模块静态阅读、函数级隔离复现；未修改产品源代码、未调用真实付费服务。本报告中的行号指交接原始源码，后续修改后可能移动。

## 1. 产品实际阶段

后端已具备较完整的**本机、单用户英语学习原型**：文本流式聊天、独立语音/TTS 的服务端接入点、角色配置、材料导入与校对、BM25 检索、三课学习计划、课中恢复、总结入词库、两套复习算法、角色记忆、模型设置都有实现。它不是静态网页，也不是只有 UI 的空壳。

当前服务是单进程 Node 原生 HTTP 服务，没有 npm 运行依赖、账号表、数据库、访问控制、租户隔离、计费或运营后台。默认监听 `127.0.0.1`，这与代码能力匹配；`--share` 或分享脚本会开放到 `0.0.0.0`，共享的是整个实例的设置、资料、学习进度和模型额度。**源码公开与服务公网可用是两个不同交付状态**；当前可以整理为公开的本机产品代码，但不能据此宣称可直接作为多人 SaaS 上线。

证据：`server.js:119–130,536–1424,1446–1459,1650–1695`；`lib/config.js:9–15`；`scripts/share.sh:23–43`；`package.json:1–14`。

## 2. 运行与模块依赖

- `server.js` 包含 HTTP 路由、静态文件、SSE 文本对话入口和 WS 语音桥，单文件 1724 行。
- `lib/config.js` 是所有存储模块的底层：选择 `AVA_DATA_DIR` 或项目 `data/`，读 JSON，临时文件 + rename 原子替换，合并环境变量/用户设置。
- `lib/llm.js` 对接 OpenAI 兼容 `chat/completions`，流式文本与 `<<<FEEDBACK>>>` JSON 分离；`llmJson.js` 支撑内部非流式任务。
- `lib/assistant.js` 决定学习管家的页面动作，靠规则意图识别；豆包文本会话主要润色回复，不能把它描述为任意工具调用的通用 Agent。
- `lib/plans.js` 维护当前唯一一份三课计划；`lessonGen.js` 负责背景生成、最小结构验证、失败状态、按 plan id 防旧任务覆盖新计划。
- `lib/docExtract.js` 统一处理上传文档；`docStore.js` 保存旧阅读材料及分析；`kb.js` 保存新知识库和检索索引。两个资料存储体系并存。
- `lib/review.js` 是新的单词复习体系；`progress.js` + `srs.js` 是旧进度/Leitner 体系；`wordbook.js` 是按日期聚合的词表。总结一次会同时写三套状态。
- `lib/memory.js` 存角色长期记忆和用户兴趣；`director.js` 做下一轮对话角度规划。
- `summary.js`、`coach.js`、`docAnalysis.js`、`translator.js` 都有真模型路径和不同程度的回退路径。

后端相对导入所需的本地源码都在交接包中。无法恢复的原个人资料和 API Key 是被主动排除的用户数据，不是用重建代码可以补出的业务信息。未见后端依赖缺少的 React/Vue 构建产物、npm 包或单独远程业务服务器。

## 3. HTTP 接口全貌

按“请求方法 + 路由模式”统计：**52 个 HTTP 业务入口**（45 个字面量入口 + 7 个参数路由入口），另有 `/ws/voice` WS 入口。HEAD 在总路由里按 GET 处理，未重复计数。

| 模块 | 实际接口 | 源码证据 |
|---|---|---|
| 健康与设置 | GET `/api/health`；GET/PUT `/api/settings`；POST `/api/settings/test` | server.js:541–598 |
| 内容与聊天 | GET `/api/content`；POST `/api/chat`（SSE） | server.js:600–606；369–534 |
| TTS | GET `/api/tts/voices`；POST `/api/tts` | server.js:615–647 |
| 新复习系统 | GET `/api/review/summary`、`due`、`list`；POST `/api/review/add`、`grade`；PATCH/DELETE `/api/review/word` | server.js:651–727 |
| 知识库 | GET `/api/kb/list`；POST `/api/kb/preview-file`、`save-text`、`upload`、`url`、`search`；POST `/api/kb/:id/enrich`；GET/DELETE `/api/kb/:id` | server.js:731–885 |
| 用户兴趣 | GET/PUT `/api/profile` | server.js:887–901 |
| 角色 | GET `/api/characters`、`/api/characters/:id` | server.js:905–914 |
| 学习计划 | GET `/api/plan`；PATCH `/api/plan/teacher`；POST `/api/plan/lesson-progress`、`lesson-restart`、`generate`、`scene-done` | server.js:916–1029 |
| 课程 | GET `/api/lessons`、`/api/lessons/:id` | server.js:988–1001 |
| 学习管家 | POST `/api/assistant` | server.js:1031–1079 |
| 旧阅读文档 | POST `/api/doc/upload`、`analyze`；GET `/api/doc/list`、`/api/doc/:id`；DELETE `/api/doc/:id` | server.js:1084–1179 |
| 语音服务检查 | POST `/api/volc/test` | server.js:1184–1211 |
| 教练/翻译/跟读评分 | POST `/api/coach`、`translate`、`score` | server.js:1213–1297 |
| 学习统计 | GET/POST `/api/progress` | server.js:1299–1320 |
| 总结 | POST `/api/summary/quick`、`summary` | server.js:1324–1399 |
| 日词表 | GET/POST `/api/wordbook` | server.js:1401–1419 |

不存在账号注册/登录、单独用户删除、会员/订单、按用户数据导出、团队权限等接口。健康检查仅证明进程存活和配置是否存在，不会验证模型/语音凭据是否仍然可用。

## 4. 数据模型与生命周期

| 文件 | 模型与用途 | 约束/生命周期 |
|---|---|---|
| `settings.json` | 文本模型 URL/model/key；CEFR、老师名、语音引擎、火山配置 | 环境变量优先；GET 返回掩码；保存后 chmod 0600 |
| `profile.json` | interests、updatedAt | 最多 24 项兴趣；单实例共享 |
| `memory.json` | characters[角色 id]：interests、facts、topics、summary | 兴趣24/事实24/话题30/摘要400字符；每次总结后异步更新 |
| `plans.json` | `{ active: plan, updatedAt }`，plan.version=3 | 仅一份 active 计划；固定3课；旧 v1/v2 计划读取时删除，不做迁移 |
| `docs/d_*.json` | 提取文字、名称/类型、字数/截断提示、缓存分析 | 原始二进制不保存；最近30份；上传第31份会自动删除旧文档 |
| `kb/index.json` + `kb/kb_*.json` | 索引元数据、chunks 文本/摘要/关键词、source/meta | 索引最多200文档；文本切块最多60k字符/120块；原始二进制不保存 |
| `wordbook.json` | version=1，按 YYYY-MM-DD 分组，词/音标/释义/例句/来源/出现次数 | 最多60天，每天60词；跨天总词数去重 |
| `progress.json` | 总分钟/轮次、连续天数、最近60天活动、words[词] Leitner记录 | 旧SRS箱子0–7；box>=3算掌握 |
| `review.json` | words[小写词]：词义/例句/来源/status/ease/interval/due/reps/lapses | 新SRS again/hard/good/easy，最多365天间隔；新增接口上限5000词 |

存储证据：`config.js:58–75,109–160`；`memory.js:11–15,30–98`；`plans.js:24–27,120–148`；`docStore.js:41–78,114–123`；`kb.js:144–221`；`wordbook.js:9–11,47–62,86–114`；`progress.js:12–22,39–64`；`review.js:8–15,42–71`。

固定文件的准确口径为 **8 个 JSON 文件**：settings、plans、profile、memory、progress、review、wordbook、kb/index；此外还有两类按文档生成的 JSON（kb/kb_*.json、docs/d_*.json）及 TTS mp3 缓存。本表按业务存储分组，因此将 KB 索引与正文合并展示。

### 数据一致性边界

交接文档“所有服务端 JSON 使用 tmp+rename”对当前业务 JSON 写路径是准确的；不能把“没有数据库事务”误写成“JSON 全部非原子写”。TTS mp3 缓存直接 `writeFileSync`（tts.js:211），运行 PID/URL/debug 文件也是直接写，不属于上述业务 JSON。

同步读改写在单进程、同一同步调用内不会被其他请求随意插入，但这不等于整个系统有事务能力。总结写 wordbook/progress/review 三个文件没有事务；异步记忆更新在模型调用前读旧数据，模型完成后将旧快照合并写回，并发总结可能互相丢更新（memory.js:120–138）。后台 KB 增强也可能在用户删除后重新写出被删文档文件（kb.js:277–320）。多进程共用 DATA_DIR 会竞争同一 `.tmp` 文件。

损坏 JSON 一律静默回退（config.js:58–66），随后正常操作可能用空结构覆盖损坏文件；没有恢复日志、版本备份、导入/导出和 fsync。只有 settings/wordbook 主动设600；隔离实测 review/KB 默认644。`saveSettingsPatch` 从已合并环境变量的 loadSettings 开始，修改非敏感设置也可能把原本仅在环境中的 Key 写入 settings.json（config.js:127–154）。

## 5. 核心业务链路复原

### 5.1 文本对话

请求校验 → 读取设置/可选阅读材料 → 识别资料模式 → 可选 KB 查询扩展、BM25、重排 → 读取兴趣/角色记忆 → 可选对话导演 → 生成 system prompt → 清理历史（最多60条/32k字符、每条2k） → SSE meta/delta/feedback/done。

free/roleplay 可能先调用一次导演模型，再调用主回复模型；资料模式可能先调用查询扩展和重排。这些操作在 SSE 开始前执行，因而“语音/文字首响应慢”并不全是前端故障：至少需要把预处理延迟与主模型延迟分开观察。证据：server.js:388–430,471–503；kb.js:411–468；director.js:58–85。

未配 Key 或连接未打开前失败时回退演示文本，并通过 meta.demo/fallback/reason 标注；上游已经打开后失败则发 error/done。接口仍有内容，不代表真实 AI 链路通过。未启用模型的演示回复主要是规则/预置内容，不足以证明任意主题或任意材料讲解质量。

### 5.2 知识库与材料课

导入可以先 preview-file 提取，再由用户校对 save-text；也保留旧 upload 一步入库和 URL 抓取入口。文本按段落/句子切约700字符，无重叠。英文词+中文二字词分词，真正本地 BM25（k1=1.4，b=.75），无向量数据库。配置 Key 后可后台摘要/关键词增强；搜索时先扩展查询再 BM25，候选多时 LLM 重排。相关来源随聊天 meta 返回，结构是文档id/标题/块id/文本片段/得分。

受控材料模式把选定资料的开头截取到 prompt：文字对话6500字符，通用 helper默认7200，多文档最多取3份；并非完整长文游标检索。检索有命中、或 prompt 有“严格依据资料”，不等于答案经过逐条证据核验。未见独立事实验证器/幻觉拦截评估。

证据：server.js:735–818,397–415；kb.js:71–126,277–338,343–471,475–544。

### 5.3 学习计划

管家用规则识别创建/修改意图 → 固定3课骨架立即保存 → 文本模型后台生成课件 → 每课至少3句、最多5句短语；3步教学结构由程序固定为跟读/场景练习/挑战 → 前端轮询计划 → 按课序解锁 → 保存 resume → 客户端报告 stepsCompleted>=3后标记完成。

已经实现结构化课程和恢复点，不是“完整自适应课程引擎”：仅一个当前计划；结课判据信任前端传的步骤数，不检验是否真正达到语言能力要求；没有模型评测驱动升级、目标达成报告或学习证据账本。

证据：assistant.js:49–98；lessonGen.js:21–73,77–117；plans.js:87–117,273–322。

### 5.4 总结与复习闭环

挂断后 quick summary 不调用模型，快速返回规则总结。正式 summary 尝试模型，失败降级；随后把关键词写日词表、旧SRS进度和新复习库，并异步更新角色记忆。复习库支持增删改查、自评四档、到期查询和状态分组。

学习闭环已经有真实持久化，但存在两套掌握判据和数据源：旧进度依据 box>=3，新复习依据 status。新复习操作不自动同步旧progress，统计可能不一致。模型总结漏词/句型时补规则数据，而返回 demo:false；这属于混合生成，建议来源按字段标记，避免把全部内容都展示成真实评估。

证据：server.js:1324–1398；summary.js:193–211；progress.js:129–146；srs.js:52–55；review.js:245–295。

## 6. 已确认问题清单

| 级别 | 问题与结果 | 证据/验证等级 | 建议 |
|---|---|---|---|
| P0（公开服务前） | 所有敏感HTTP/WS入口没有鉴权、Origin/Host校验。访问者可读删资料、改设置、花共享额度 | server.js:1446–1459,1632；静态确认 | 保留本机默认；先加受控访问入口、同源检查、配置权限，再考虑分享部署 |
| P0（密钥边界） | 设置测试允许用户指定 baseUrl 并沿用已存 Key；火山测试允许指定 endpoint 并沿用已有凭据；可将凭据送到调用者选择的目标 | server.js:582–593,1191–1206；llm.js:249–264；主审查以假Key+回环地址证实文本Key被转发，无真实外部数据 | 受保护的配置入口；更换源站必须明确提供相匹配的新Key，或只允许已配置/白名单目标；本轮没有对真实Key测试 |
| P0/P1 | Host URL 构造放 try 外，畸形Host可能造成未捕获异步异常退出 | server.js:1446–1449；主审查已在隔离服务复现Host为`[`→ECONNRESET、exit 1 Invalid URL | URL构造放入try，校验host，返回400；避免任意Host进入路由基准 |
| P1 | 学习管家上游 onError 清空 pending 后又取 pending.resolve，确定空指针 | assistant.js:193–199；静态确认 | 保存局部pending再清空与resolve；按 Translator:98–104的同类代码修 |
| P1 | 已掌握单词被新对话总结重置为new，旧due/interval却保留，状态互相矛盾 | review.js:75–110,299–313；**隔离函数实测**：known→new，due/interval不变 | defaults只用于新增；更新已有条目保留status与复习历史；补回归 |
| P1 | 修改已生成计划的目标/等级，只改表层信息，课件仍是旧内容 | assistant.js:84–98；plans.js:237–246；server.js:1069；**实测**：目标商务谈判/B2，第一课仍机场课/A2，generating=false | 区分仅换老师和改目标；改目标生成新的计划版本，保留旧计划可回看 |
| P1 | URL导入允许内网URL、自动跟随重定向，不限制响应字节量；只能读完再截文本 | kb.js:240–269；静态确认 | 解析/重定向每跳校验地址，屏蔽保留IP和DNS重绑定，流式限额；本机用途也应设抓取边界 |
| P1 | ZIP/PDF同步解压没有输出字节/压缩比/条目数预算，12MB压缩输入不约束解压后内存 | docExtract.js:72–109,220–255,346–348；静态确认 | 明确解压预算、超时与worker隔离；不运行压缩炸弹 |
| P1（可移植） | npm start包含--open，所有平台都spawn('open')；Linux缺命令会触发子进程异步error，try/catch接不住 | package.json:8；server.js:1697–1704；条件性静态缺陷，当前执行环境有open命令，主审查本次未复现退出 | 分平台打开浏览器、监听error，打开失败不影响服务 |
| P1（内容可信） | 旧doc analyze缓存不区分模型/等级，演示分析一旦缓存，后来配置Key仍直接返回demo缓存 | server.js:1140–1147；docStore.js:73–77；静态确认 | 缓存键包括内容hash/等级/模型/prompt版本；允许重分析；demo不永久覆盖真实分析 |
| P1（数据） | JSON损坏静默回退、旧版计划读时直接删除、超30旧材料自动删除，缺备份/恢复 | config.js:58–66；plans.js:120–140；docStore.js:114–123；静态确认 | 显式迁移、备份、损坏隔离提示和容量删除告知 |
| P2 | KB文本记录的chars与实际保存不一致；save-text可接受长文而chunkText只留60k，无截断meta | kb.js:71–77,187–205；server.js:766–787；**实测**93999字符报告、约59908字符保存、meta={} | 在统一入口截断并返回原始/保留字数，或保留全文按页处理 |
| P2 | 未配Key时新KB一直pending，stats.enriching持续计算它 | kb.js:202,547–554；server.js:782–787；**隔离实测** | 增加skipped/unconfigured状态，配置Key后再补任务 |
| P2 | 记忆上限按旧项在前截断，达到24兴趣/事实后新内容被永久丢弃 | memory.js:77–85；**实测**24旧项+1新项，new=false | 最近/重要性合并、去重替换策略；允许用户纠正/删除 |
| P2 | KB只裁剪索引200条，不删除相应文档文件，旧材料可能不可见且占磁盘 | kb.js:144–146,207–221；静态确认 | 容量达到时阻止新增或显式归档/删除；清理孤儿文件需有恢复策略 |
| P2 | 课程生成/翻译/KB增强任务均在进程内，重启没有持久任务队列；计划GET可触发后台续跑 | server.js:916–923；lessonGen.js:11,77–117；translator.js:161–166 | 本机先最小任务状态/重试记录；不必立即引入重型分布式队列 |

“P0”指阻止公开服务放行的问题，不代表上传公开源码本身就是这些运行风险的触发条件。

## 7. 文档解析的真实支持范围

| 输入 | 当前实现 | 实际限制 |
|---|---|---|
| TXT/MD/CSV/JSON/LOG | UTF-8直接读 | 无GBK编码检测；英文至少20字母或中文至少40字；最多12MB输入/60k提取字 |
| DOCX | macOS优先textutil；否则自制ZIP+XML | 主要正文文字，复杂布局/脚注/图不保留 |
| DOC | macOS textutil；非macOS错误尝试当DOCX ZIP | 真二进制.doc在Linux/Windows不支持，应明确提示 |
| RTF/ODT/HTML/HTM | 只在macOS textutil执行 | 虽列入SUPPORTED_EXTENSIONS，Linux/Windows实际上无法提取 |
| PPTX/PPTM | ZIP提取各页a:t | 不提图表图片内文字/讲者注释，复杂内容不保证完整 |
| PDF | 自制Flate流+Tj/TJ/简单字符串解析 | 不处理完整PDF字体CMap/复杂Unicode/版式；扫描PDF失败；不是可靠通用PDF解析器 |
| 图片 | macOS Vision via osascript/JXA | 明确仅macOS；代码里不是Swift调用；Linux/Windows无OCR |
| URL | fetch HTML正则去标签 | 动态渲染页无正文时失败；非浏览器抓取 |

证据：docExtract.js:18–27,123–158,163–267,271–336,346–402；kb.js:240–271。

## 8. 已做的无网络复现

脚本使用 `mkdtempSync` 设置独立 `AVA_DATA_DIR`，只调用纯逻辑/本地持久化函数，退出前清理临时数据；产品原件未动。

```json
{"check":"summary_resets_mastered_status","before":"known","after":"new","oldIntervalRetained":true,"oldDueRetained":true}
{"check":"plan_goal_changes_but_lessons_stay","goal":"商务谈判","level":"B2","firstLesson":"机场课0","lessonLevel":"A2","generating":false}
{"check":"bounded_memory_drops_new_facts","count":24,"retainsNew":false}
{"check":"kb_text_size_reporting","reportedChars":93999,"persistedChars":59908,"meta":{},"enrichStatus":"pending"}
{"check":"default_file_mode","review":"644","kb":"644"}
```

主审查另在临时服务完成了HTTP级复现，记录为 `/tmp/ava-runtime-probes.json`：未鉴权PUT settings返回200、指定baseUrl的settings/test收到虚构存储Key、畸形Host导致进程退出。全部在本机隔离环境完成，不涉及真实Key或外部攻击。主审查原始API测试为225/225通过；E2E为102通过/2失败（Linux OCR不支持及资料prompt断言），最终以主审查汇总报告为准。

真实模型质量、生产火山接口、真麦克风、真实网络延迟、复杂文档提取准确率不是本次这些函数测试能够证明的。全量API/UI测试由主审查代理单独执行和汇总。

## 9. 可落地的完善顺序

1. **建立可恢复基线**：完整源包/清单校验、启动说明、Node版本约束、源码与用户数据隔离；保留交接原件和现状记录。
2. **修确定性故障**：空指针、启动打开浏览器失败、畸形请求退出、复习状态倒退；这些不需要先重写架构。
3. **修教学一致性**：目标修改和课程内容同步，材料截断显式提示，demo与真实分析缓存分开，新旧复习状态统一来源。
4. **守住单用户运行边界**：同源/Host检查、设置入口保护、URL导入网络边界和文件资源上限；分享模式要有明确访问权限。
5. **补数据恢复**：导出/导入、版本化迁移、备份、损坏提示、任务状态；优先保护实际学习积累。
6. **再决定是否成为多人网站**：用户系统、每用户数据隔离、数据库、费用配额、审计与部署运维。这个阶段是产品范围扩展，不能用当前可运行或测试通过替代。

## 10. 本分工覆盖范围

完整阅读了 server.js 的 HTTP路由/静态处理/启动与聊天上下文部分，以及 config、llm、llmJson、assistant、director、lessonGen、plans、docExtract、docStore、docAnalysis、kb、memory、progress、srs、review、summary、wordbook、coach、translator；检查了 package.json、start.command、scripts/share.sh。实时语音协议/音频/TTS/声学评分及前端由其他分工审查。报告未将这些未执行的真实外部链路标为已验收。
