#!/bin/bash
# 分享实例：额外端口 + 独立数据目录，朋友访问不会动到你的个人数据/记忆。
# 用法：./scripts/share.sh            （默认端口 5181）
#      AVA_SHARE_PORT=5190 ./scripts/share.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${AVA_SHARE_PORT:-5181}"
DATA="$ROOT/data-share"

# 找一个可用的 Node（优先 PATH；否则用 DSH 运行时内置 Node）
NODE="${NODE:-}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  elif [ -x "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" ]; then
    NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
  else
    echo "找不到 node，请先安装 Node 24 或设置 NODE=/path/to/node" >&2
    exit 1
  fi
fi

mkdir -p "$DATA"
# 首次启动：复制 API/语音配置（若已有个人设置），但学习数据/记忆/知识库保持独立
if [ ! -f "$DATA/settings.json" ] && [ -f "$ROOT/data/settings.json" ]; then
  cp "$ROOT/data/settings.json" "$DATA/settings.json"
  chmod 600 "$DATA/settings.json"
  echo "[分享] 已复制语音/模型配置到独立数据目录（data-share/），不会影响个人 data/。"
fi

IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
echo ""
echo "============================================================"
echo " Ava 分享实例（与个人实例数据隔离）"
echo " 本机访问：http://127.0.0.1:$PORT/mobile"
if [ -n "$IP" ]; then
  echo " 朋友访问：http://$IP:$PORT/mobile   （需在同一个 Wi-Fi）"
fi
echo " 停止：Ctrl+C"
echo " 重置分享数据：删除 data-share/ 后重新运行"
echo "============================================================"
echo ""
exec env AVA_DATA_DIR="$DATA" "$NODE" "$ROOT/server.js" --port "$PORT" --host 0.0.0.0
