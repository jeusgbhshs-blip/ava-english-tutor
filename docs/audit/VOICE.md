# Ava 语音与教学逻辑逆向审查

审查对象：`仓库根目录`，用户 2026-11-01 交接包原始源码。仅阅读和进程内 fake/纯函数验证，未修改产品源码，未连接真实模型/语音服务，未使用付费 API。以下行号对应原始包。

## 1. 产品能力的真实边界

已存在可运行实现的能力：音频采集与重采样、浏览器到 Node 的 WS 桥、火山二进制协议与会话、ASR 字幕、流式回复、PCM 播放、手动打断、PTT 录完提交、角色朗读接口与缓存、角色/场景内容、三步课件进度、简易转写匹配评分、规则演示模式。它不是仅有 UI 的壳。

尚不能凭代码或 mock 宣称：稳定的真机实时对话、真实发音/音素准确度评测、完整长文逐句教学、通过课程即掌握能力、真实云服务音色兼容性、生产成本可控。存在已复现的生命周期与事件接线错误，因此“当前已完成语音链路”等于主干实现，不等于线上验收。

### 三条音频路径

1. 主入口的实时通话：`mobile/call.js` → `doubao-voice.js` → 麦克风 AudioWorklet（失败回退 ScriptProcessor）→ 16kHz、mono、PCM16、20ms/640B → 同源 `/ws/voice` → `server.js handleVoiceSocket` → `VolcRealtimeSession` → 火山实时模型。下行音频 24kHz mono PCM16，ASR/Chat 文本以 JSON 事件返回浏览器。
2. 角色独立朗读：`mobile/voice-audio.js` → `/api/tts` → `lib/tts.js` 固定 HTTPS 火山合成接口 → mp3 → 浏览器 Audio。它不是实时 WS 原声流的延续，而是第二次独立合成。
3. 旧版浏览器语音：`speech.js` 封装 SpeechRecognition + speechSynthesis。主入口 `mobile/app.js:21–22` 明确禁用浏览器 TTS（源码注释为用户要求）；因此 voice-audio.js 中写的“自动回退浏览器语音”，在当前主入口事实上不可用。旧桌面版仍保留默认启用。

证据：`lib/volcRealtime.js:35–59`、`web/js/pcm-worklet.js:17–99`、`web/js/doubao-voice.js:1013–1102`、`server.js:1465–1632`、`web/js/mobile/voice-audio.js:248–280,464–512`、`web/js/speech.js:1261–1287`。

### 主交互是 PTT，不能直接宣传自然全双工

底层支持实时上下行，主通话 UX 固定 `ptt: true`（`mobile/call.js:2923–2934`）：点击开始，再点结束；录音时抑制上游自动回答，结束时服务端追加 120 帧静音，即 2.4 秒，以跨过 2 秒 VAD 窗口（`server.js:1604–1618`）。这是一种手动回合控制，提交后天然增加静音尾段延迟。代码确有手动抢断和音频清理；但服务端发来的 `interrupted` 事件在浏览器的 `handleServerEvent` switch 中没有分支，自动打断的播放清理未接通（`server.js:1569–1571`、`doubao-voice.js:655–716`；静态证据，未做真机自动抢话验证）。

## 2. 已复现的优先问题

### V1/P0：持续播放也被误判卡住，根因是漏接音频进度回调

- `doubao-voice.js:309–320` 复制 options 到 handlers 时没有 `onAudioProgress`。
- `doubao-voice.js:798` 收到每个 PCM 块后却调用 `handlers.onAudioProgress`；该字段永远 undefined。
- `mobile/call.js:2137–2145` 依赖该回调刷新 `lastTeacherAudioAt`、累加 `turnAudioBytes`。
- `mobile/call.js:3295–3310` 每 1.2 秒检查超过 3.5 秒没收到音频会执行 `teacherStalled`，即便声音实际上持续到达也会触发。另 2154–2160 的音频截断判断因字节数始终为 0 失效。

隔离验证：FakeWebSocket+FakeAudioContext 启动真实 `createDoubaoVoice`，注入 2 字节下行 PCM，`lastAudioAt` 被更新，而传入的 `onAudioProgress` 计数为 0。无任何网络调用。

建议：补齐回调转发；用持续超过 5 秒的模拟音频验证不会误触发停滞，用真正中断 >3.5 秒验证会恢复；保留两个相反条件，不能仅检验函数存在。

### V2/P0：第一句话可能在上游 ready 前被确定性丢弃

- `doubao-voice.js:1243–1289` 的 `start()` 只等待本地 WS 打开及麦克风采集启动即返回 true，不等待上游 `ready`。
- `sendPCM`（513–540）只检查本地 WS readyState，不检查会话 ready，直接发音频。
- 服务端收到即转发（`server.js:1490–1493`）；`VolcRealtimeSession.sendAudio`（263–270）在 `!this.ready` 时直接 return，没有缓冲。
- `mobile/call.js:3613–3630` 在 start 成功且 isActive 时恢复麦克风，也未等 isReady。UI 报录音并不等于火山会话开始接音频。

隔离验证：真实客户端在 fake 浏览器环境中，`start()` 返回 true、ready 事件 0 次，随后模拟采音已经发出 2 帧 PCM。上游代码对这些帧的丢弃是明确定义的。故首遍吞音不能全部归因用户输入设备。

建议：统一“本地 socket 已连接”和“云会话已就绪”的语义，ready 前不让用户进入可录状态，或使用有边界的前置音频队列并按顺序补发；重连也要走同一门禁。

### V3/P1：握手期间断线会让 connect Promise 永久 pending

`lib/volcRealtime.js:365–369` 的 `#onClose` 只清定时器、改 closed/ready、触发回调，没有 reject 尚未 settle 的 `connect()`。一旦 150 SESSION_STARTED 前对端直接断开，原 25 秒超时还会被清掉。

隔离验证：fake socket 在 ready 前 onclose，connectTimeoutMs=100；150ms 后 Promise 仍未 settle，errorCallbackCount=0。不是仅超时设置太长，是 Promise 失去所有完成路径。

建议：统一幂等 settle/close，pre-ready close 必须拒绝 connect，post-ready close 只通知断开，明确取消和错误类型。

### V4/P1：协议层错误帧被忽略

`lib/volcProtocol.js:165–172` 支持 ERROR 类型、eventId=0；parseFrame 会带 errorCode/json。但 `lib/volcRealtime.js:174–244` 只按 51/153/599 等事件处理错误，没有按 MSG_TYPE.ERROR 处理。底层鉴权/协议错误可能变成无响应。

隔离验证：向真实 session 注入 `encodeError({code:401,message:'mock unauthorized'})`，onError 计数 0，connect 未 settle。现有 mock 主要推 51/153/599，绕开了这个分支。

### V5/P1：主动 close 可通知两次

`VolcRealtimeSession.close` 先 `ws.close()`，再直接 `#onClose(reason)`；稍后 socket.onclose 又进 #onClose，它没有幂等护栏。进程内验证一次主动 close 触发 2 次 onClose。可能造成重复结束、重连和状态切换；应与 V3 一起统一生命周期。

### V6/P1：5600 字资料预算仍超限，且切掉续教历史

实时 KB 材料固定上限 5600（`server.js:1512`），但 grounded persona 自身说明很长（`content/prompts.js:297–330`）；最终 `buildSessionConfig` 直接 `.slice(0,8000)`（`lib/volcRealtime.js:56`）。

纯函数验证：Elena、A2、5600 字符资料、1 句历史，完整 persona=9548 字符，资料从第 3518 字开始；实际传 8000 字，资料只保留前 4482 字，尾部 TAILMARKER 和“当前第21句”历史均丢。当前阈值不能保证长文或重连连续教学。

建议：显式系统规则/当前句/附近上下文/历史的预算；优先传当前句和游标，采用按段教学。不能只把 5600 随意再减小而继续声称完整材料已传。

### V7/P2：TTS 超长无空格 token 会改变文本顺序

`lib/tts.js:240` 在 `part` 非空时调用清空 `buf` 的 `push()`，并未输出/清空 part。输入 `BEFORE `+501个X+` AFTER`（max=500），输出分块是 X×500、X、BEFORE AFTER，而非原顺序。已提取原函数纯计算复现。多见网址/粘连 OCR/异常文本。

建议：修 part flush，测试重组后保序且每块 <=500；避免只测空文本。

## 3. 教学闭环是真实实现，但目前代表“参与进度”

### 课程与内容规模

读取导出的静态数据得到：3 个角色（Elena/Maya/Hikari），每人3个场景；8个自由话题；4个角色扮演场景；4组跟读句库共34句；6组词汇主题、每组8词，共48词。这里不包含另一个模块的书库，也不把模型可生成的内容计入内置量。

`buildPlanLessonsMessages`（`content/prompts.js:388–429`）要求3节课，每课5个句子、2–4目标、跟读/练习/挑战3步骤；等级 A1/A2/B1/B2/C1 是 prompt 难度引导（15–20），没有看到基于学生测评证据自动校准等级。

### 课程完成不能证明掌握

`mobile/call.js:366–375` 的句子匹配允许内容词命中>=3或命中率>=55%；第一步两次失败也标记 passed（613–617），第二步说2轮即升级（631–638），第三步使用过目标表达或者说2轮即完成（643–647）。

纯函数隔离验证：5句课程，连续14次输入完全无关 `banana banana`，所有 lessonPassed=true、lessonDone=true。其友好设计可减少挫败，但“完成”只能说明流程参与，不能用作“掌握/达标”。课程状态由前端主导，根本上也不是高可信考试记录。

建议保留宽容体验，同时分离 `attempted`、`skipped`、`practiced`、`mastered`；让跳过项自动进入复习，不把它涂成掌握。必须用含目标句的任务表现和隔日复测来支持掌握结论。

### “发音评分”的真实算法

`lib/score.js:251–280` 输入仅 target、transcript、confidence。tokenize/缩写展开/词级编辑距离对齐，ok=1，close=0.6，额外词每个扣3分最多15。分数无音频、音素、时长、声学模型输入。confidence仅用于提示，不影响得分：同样转写，confidence=0和1都100分。

`buildTips` 199–239 根据错词是否含 th/r/l/v/w/尾辅音等字母给通用建议；完全匹配时给“发音很标准”，代码证据不足以支持这句评价。ASR可以把不标准发音纠成正确词，亦可因噪音把标准发音识错。

建议名称改为“跟读内容匹配/转写一致度”，提示注明“识别出的文字与你的目标句一致”；只有接入并验证音素级评测之后，才能提供发音准确度、重音/节奏等指标。

### 资料课的“逐句”和定位仍有启发式

材料初次自动开始是确定性的：`call.js:1299–1315` 从第一句生成开场。后续主要依靠 prompt 让模型逐句教，而 `focusDocsByText`（1268–1296）用老师文本与资料词语重合寻找句子，不是来自服务端的可靠教学游标。纠错、翻译或重复词多时可能定位错句；截断历史加剧问题。

`content/prompts.js:447–486` 内规则还存在局部冲突：前面要求 at most 2 sentences/25 words、提供短中文解释；输出格式后面却写1–3句35/55词且正文 English only。应统一成一种可验证合同，客户端也校验长度和引用范围。

### 总结、复习与演示

规则演示并非空白：`content/demo.js` 有中文求助、常见语法纠错、话题对话、阅读问答、总结；但无法证明针对任意材料的教学质量。demo总结（938–981）按用户回合数/词数与有限正则夸奖，“未命中错误规则”不等于没有语法错误，中文回合也被文本称为“句英文”。

`lib/srs.js` 是 Leitner 简化分箱，间隔[0,1,2,4,7,14,30,60]天，box>=3视为掌握。另主复习模块还存在自己的词/句调度（由后端审查覆盖），不能混称已实现学习科学验证或个性化掌握模型。

## 4. 延迟、成本与稳定性边界

- TTS 每块上游30秒超时，最长4000字符逐块串行合成；浏览器整次请求75秒超时（tts.js:196,266–284；voice-audio.js:32）。理论上8块及以上可能超出前端总时限，前端停止等待后服务端没有端到端取消传递，仍可能继续收费合成。
- 名为“流式TTS”，但 server 读完整 `response.text()` 才 parse，前端又 `res.blob()` 后播放；因此用户听到首音前等待全段合成。长篇需真分段播放队列或按句预取。
- 缓存：服务端400文件/80MiB、键 speaker+text+rate；前端20个Blob。服务端无同key in-flight去重；同时点同句可能重复调用。文件清理按创建/修改时间而非访问命中刷新，不是严格LRU。
- realtime 使用事件154有 `handlers.onUsage` 接口（volcRealtime.js:239–240），但 bridge 没传 onUsage；因此未落地会话用量/费用统计。没有用户预算上限和会话计费控制。
- 资料课只在浏览器 mute 上游实时音频（call.js:2255、voice options.outputMuted），服务端建会话并未设 textMode，仍请求实时TTS又调用独立TTS；存在重复合成与费用/延迟浪费，金额未经实测，不能给定量节省承诺。
- 实时支持 appId+apiKey 或 accessToken；独立 TTS 只读 AVA_TTS_API_KEY 或 volc.apiKey（tts.js:42–46,155）。仅配置旧 accessToken 的用户可实时连接但点读失败。应分别显示两条链路的配置状态。
- 语音看门狗/重连在多个层级并存：客户端一次重连、call自动恢复两次、PTT watchdog重连、预热与音频回退。多个异步 token 可降低重入但也增加理解难度，生命周期修复应先合并状态契约。
- `wsServer.js` 每帧2MiB上限，却未对分片总量设上限（131–138）；ping每25秒但alive从不置false，也不超时关闭（43、50–57、127–129）。仅限本地的默认适用边界需保留；若公开部署应采用成熟WS实现或补齐握手、origin、碎片累计、背压、连接数、心跳治理。无鉴权/origin问题交给后端报告，不重复展开。

## 5. 测试覆盖到底能证明什么

父任务反馈原始包 Node24 `npm test` 225/225，E2E 102 pass/2 fail；这些是父任务执行，不是本子任务重复运行。现有语音mock确实覆盖真实编码/桥/事件流程，但音频内容是440Hz正弦波，默认只有3×20ms=60ms（`test/mock-volc-realtime.mjs:61–71,107,158–173`），不会触发>3.5秒的音频守护逻辑，无法证明发音质量、首字、回声、移动设备、长对话和弱网稳定性。部分PTT测试只是源码正则（`test/api.test.mjs:3683–3694`），不能抓到 handlers 漏接。

必须补的行为用例：延迟SESSION_STARTED仍保存/阻止首句；超过5秒持续音频无误报；真实断流触发恢复；pre-ready close拒绝Promise且回调一次；协议ERROR透出；大量长文保证当前句和游标保留；前端取消后后端不继续合成；全流程与离线演示明确区分。真机验收独立列出Chrome/macOS、Windows麦克风、手机WebKit/Chromium等目标设备；本次未做这些验收。

### E2E grounded 断言过期的判定

`test/e2e.mjs:2701–2721` 要求“Knowledge base material / grounded / LENS / Director's plan”。新分支在 server.js:397–398真实取材料、311–319调用专用材料课prompt，417显式对grounded禁用导演。故旧断言属于设计迁移未更新，不是材料没注入。

建议替换为更强语义检查：精确包含测试文档唯一原句和标题、包含材料专属/离题回到材料/逐句教学约束、保留反馈JSON协议、角色姓名正确、没有自由聊天导演计划；仍检查meta命中引用和非空回复。divergent分支继续断言LENS和导演。不要只删断言让其变绿。

## 6. 下一阶段建议与验收

第一阶段先修语音状态可靠性：V1–V5，统一ready/录音/回复/关闭语义；假上游慢建链、正常长播放、断链、错误帧均有行为回归。第二阶段资料课服务端游标化：当前句+最近上下文+历史按预算构造，超长材料最后一句也能访问，重连准确续教。第三阶段教学结果可信：评分更名、跳过与掌握分开、复习回流；第四阶段再做真实云语音/设备矩阵与成本观测。角色更多、画面更炫不会先解决上述主链路问题。

## 审查覆盖

完整读取或关键全路径核查：lib/volcRealtime.js、volcProtocol.js、wsServer.js、tts.js、score.js、srs.js；web/js/doubao-voice.js、pcm-worklet.js、speech.js语音能力与回退、mobile/voice-audio.js、mobile/call.js的课程/采音/字幕/恢复/材料路径、mobile/app.js语音开关；content/characters.js、scenarios.js、vocab.js、openers.js、index.js、prompts.js、demo.js；test/mock-volc-realtime.mjs与api/e2e相关测试。前端外观/其他数据CRUD由并行审查覆盖。本报告不声称对真实火山服务进行过验证。
