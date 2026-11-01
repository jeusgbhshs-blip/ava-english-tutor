#!/bin/bash
# Ava — AI 数字人英语老师 · 一键启动
# 双击本文件即可启动服务并打开 Chrome。
cd "$(dirname "$0")" || exit 1

NODE_BIN=""
for candidate in \
  "/Users/cici/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
  "$(command -v node 2>/dev/null)" \
  "/usr/local/bin/node" \
  "/opt/homebrew/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  echo "❌ 没有找到 Node.js。"
  echo "   请安装 Node.js（https://nodejs.org）后重试，或把 node 路径填到 start.command 里。"
  read -r -p "按回车键退出..." _
  exit 1
fi

echo "🚀 正在启动 Ava（AI 数字人英语老师）..."
echo "   关闭这个终端窗口即可停止服务。"
echo ""
exec "$NODE_BIN" server.js --open
