#!/usr/bin/env bash
# macOS / Linux 启动脚本
set -euo pipefail
cd "$(dirname "$0")"

# 优先用安装目录里的便携版 node（如果安装器放了一份），否则用 PATH 上的
NODE_EXE="node"
if [ -x "./node/bin/node" ]; then NODE_EXE="./node/bin/node"; fi

# 这里**刻意没有依赖安装步骤**——不要加回来。
# 本实现只 import "node:" 内置模块与自己的 ./lib/*.mjs（已核对：包里没有任何文件 import
# ajv 或其它三方包），所以没有任何东西需要安装。
# 之前的版本在这里判断 node_modules 是否存在、缺了就 npm install；而一键安装包从不携带
# node_modules（打包器明确排除），干净机器上也没有 npm（便携 node 不在 PATH 里）→ 直接
# exit 1，start.mjs 永远不执行。
if ! "$NODE_EXE" --version >/dev/null 2>&1; then
  echo "[错误] 找不到可用的 Node.js：既没有 ./node/bin/node，PATH 上也没有 node。" >&2
  echo "        请重跑一键安装器，或安装 Node.js 22+ 后重试。" >&2
  exit 1
fi

if [ ! -f config.json ]; then
  echo "尚未初始化：正在执行 setup…"
  "$NODE_EXE" setup.mjs
fi

exec "$NODE_EXE" start.mjs
