@echo off
chcp 65001 >nul
title dsh-webtokens-lite 本机网页桥接
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行：正在安装依赖...
  call npm install --no-audit --no-fund || goto :fail
)
if not exist config.json (
  echo 尚未初始化：正在执行 setup...
  call node setup.mjs || goto :fail
)
node start.mjs
echo.
echo [已退出] 按任意键关闭窗口
pause >nul
exit /b 0

:fail
echo.
echo [失败] 请把上面的报错发出来
pause >nul
exit /b 1
