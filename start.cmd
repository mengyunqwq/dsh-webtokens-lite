@echo off
chcp 65001 >nul
title dsh-webtokens-lite 本机网页桥接
cd /d "%~dp0"

rem 优先用安装目录里的便携版 node（一键安装器装的那种，不写 PATH、不需要系统装 Node）
set "NODE_EXE=node"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"

rem 依赖已随安装包内置（ajv）；只有从源码克隆时才需要 npm install
if not exist node_modules (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [错误] 缺少 node_modules，且系统里没有 npm。
    echo        请用一键安装器重新安装（它会内置依赖），或先装 Node 22+ 再执行 npm install
    pause >nul
    exit /b 1
  )
  echo 首次运行：正在安装依赖...
  call npm install --no-audit --no-fund || goto :fail
)

if not exist config.json (
  echo 尚未初始化：正在执行 setup...
  "%NODE_EXE%" setup.mjs || goto :fail
)

"%NODE_EXE%" start.mjs
echo.
echo [已退出] 按任意键关闭窗口
pause >nul
exit /b 0

:fail
echo.
echo [失败] 请把上面的报错发出来
pause >nul
exit /b 1
