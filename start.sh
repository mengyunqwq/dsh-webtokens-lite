#!/usr/bin/env bash
# macOS / Linux 启动脚本
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖…"
  npm install --no-audit --no-fund
fi

if [ ! -f config.json ]; then
  echo "尚未初始化：正在执行 setup…"
  node setup.mjs
fi

exec node start.mjs
