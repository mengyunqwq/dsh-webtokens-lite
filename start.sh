#!/usr/bin/env bash
# macOS / Linux 启动脚本
set -euo pipefail
cd "$(dirname "$0")"

# 优先用安装目录里的便携版 node（如果安装器放了一份），否则用 PATH 上的
NODE_EXE="node"
if [ -x "./node/bin/node" ]; then NODE_EXE="./node/bin/node"; fi

if [ ! -d node_modules ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "[错误] 缺少 node_modules，且系统里没有 npm。请用一键安装器安装，或先装 Node 22+ 再执行 npm install。" >&2
    exit 1
  fi
  echo "首次运行：正在安装依赖…"
  npm install --no-audit --no-fund
fi

if [ ! -f config.json ]; then
  echo "尚未初始化：正在执行 setup…"
  "$NODE_EXE" setup.mjs
fi

exec "$NODE_EXE" start.mjs
