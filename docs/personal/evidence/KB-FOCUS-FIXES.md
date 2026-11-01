# 知识库全屏焦点与自由聊入口：末项修复

日期：2026-11-01。仅修改 `web/js/mobile/kb.js`，新增 `test/personal-kb-focus.test.mjs`。没有修改 call、dialog、app 或其他模块，没有提交 git。

## 修复行为

- 打开知识库时保存原入口和 `#screens`、`#tabbar` 的原始 inert 值；背景设为 inert，避免键盘与辅助技术继续进入助手/个人页面。
- 实际面板完成渲染后，焦点移到 `#kb-close`（返回助手）；面板有 dialog/aria-modal 语义与程序焦点后备。
- 重复 open 不覆盖最初入口、不重新拍摄背景状态、不重置正在编辑的焦点，也不重复添加键盘监听。
- Tab/Shift-Tab 只环绕可见、可用且 `tabIndex >= 0` 的面板控件；尊重 `defaultPrevented`，面板关闭或上层 `sheet-open` 时不拦截。
- 关闭知识库时恢复背景原值；原入口仍可见可用则回焦，否则回到当前选中的导航 Tab。上层弹层存在时不抢其焦点；不无条件关闭其他弹层。
- 正常嵌套顺序由现有 dialog 控制器把 KB 临时设为 inert，关闭 sheet 后恢复 KB；随后关闭 KB 才释放其自身背景隔离。
- 点击“自由聊”时，不再向 call 传入选中的 `kbDocIds` / `kbDocs`；围绕资料讨论和发散讨论继续携带选中资料。选择本身保留，不因开始自由聊被清空。

## 验证

新增测试执行实际 KB 模块及实际 dialog 模块，使用最小 DOM、焦点事件和无网络 API 替身。7 项覆盖打开回焦、原始 inert 状态、重复打开、Tab 范围、上层弹层让出焦点、关闭后备焦点、正常嵌套弹层恢复，以及自由/资料讨论参数区分。

- 修复前：7 项中 1 通过 / 6 失败，确认测试捕捉实际问题。
- 修复后：**7/7 通过**。
- 指定既有 `personal-frontend.test.mjs` 与 `recovery-frontend.test.mjs`：**48/48 通过**。
- `node --check web/js/mobile/kb.js` 与限定文件 `git diff --check`：通过。

```bash
node --test --test-isolation=none --test-reporter=tap test/personal-kb-focus.test.mjs
node --test --test-isolation=none --test-reporter=tap test/personal-frontend.test.mjs test/recovery-frontend.test.mjs
```

日志：`/tmp/ava-personal-kb-focus-before.tap`、`/tmp/ava-personal-kb-focus-after.tap`、`/tmp/ava-kb-frontend-regression.tap`。

真实浏览器最后验收由主审查执行；本分工没有把 DOM 模拟验证表述为已完成真实浏览器验收。
