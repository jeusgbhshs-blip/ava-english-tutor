# 个人端弹层独立验证

日期：2026-11-01。新增测试文件：`test/personal-dialog.test.mjs`。

本分工只新增测试，没有修改 `web/js/mobile/dialog.js` 或 `app.js`。测试使用项目已有 VM 方式执行实际 dialog 模块，替换边界为一个最小连通 DOM、节点移除、焦点事件与键盘事件模型，没有重写控制器逻辑。

## 最终结果

**14 项全部通过。** 运行命令：

```bash
node --test --test-isolation=none --test-reporter=tap test/personal-dialog.test.mjs
```

逐项日志保存在 `/tmp/ava-personal-dialog.tap`。测试文件 `git diff --check` 通过。

覆盖内容：

1. 替换或关闭后旧 token 的 update/close 无效。
2. 替换、关闭回调各只执行一次，reason 正确。
3. 多背景元素的原始 inert 值跨弹层替换后完整恢复；弹层与其祖先不被设为 inert。
4. 初始焦点优先选择可用的明确指定控件，并设置弹层语义。
5. 不可用的初始焦点退回第一个可用控件。
6. Tab/Shift-Tab 在首末控件之间环绕，中间控件保留浏览器默认行为。
7. tabindex 为负的原生控件不进入键盘 Tab 顺序。
8. 无可用控件时聚焦弹层本身，并将 Tab 保持在弹层。
9. 活动弹层捕获逃逸焦点，关闭后停止焦点捕获。
10. 替换正文导致原焦点节点移除时重新聚焦；仍存在的页头控件保留焦点。
11. 跨弹层替换后仍回到最初触发控件；触发控件已移除时使用后备焦点。
12. onClose 同步打开新弹层，外层 close 不会隐藏新弹层或错误恢复背景。
13. 替换回调同步打开第三个弹层，第二个弹层 token 立即失效，回调只执行一次。
14. onClose 抛错不会使弹层保持活动或造成重复回调。

## 实证发现与修复确认

初跑为13通过/1失败。实际 focusSelector 的 button/input 等分支包含 `tabindex="-1"` 的原生控件，导致最后一个真正 Tab 停靠点无法按期环绕，Shift-Tab 也可能聚焦程序性焦点控件。主审查随后在 `focusables()` 增加 `element.tabIndex >= 0` 过滤，保留 `usable()` 对弹层本身 `tabindex=-1` 的程序聚焦能力。原失败回归现已通过。

顺带只读检查了 app 的 token 转发、close 按钮/背景点击、Escape、背景选择与后备焦点集成；未修改这些文件，也没有把本轮扩展为导航或其他页面实现。

本验证是执行实际逻辑的离线模块验证，不替代真实浏览器与辅助技术端到端体验验收。主审查另负责导航与本地演示验证。
