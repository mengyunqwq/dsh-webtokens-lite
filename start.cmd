@echo off
chcp 65001 >nul
title dsh-webtokens-lite (local web bridge)
cd /d "%~dp0"

rem NOTE 1: this file is intentionally ASCII-only, and uses only single-line "if ... goto".
rem   cmd.exe decodes a batch file using the console code page. Non-ASCII text can be
rem   decoded into bytes that cmd then treats as separators, so half a line gets executed
rem   as a command (observed: a stray "'? is not recognized as an internal or external
rem   command"). Multi-line "if ( ... )" blocks additionally assume CRLF endings.
rem   Both failure modes stop the bridge from ever starting, so avoid them here.
rem   Chinese documentation lives in README.md / docs/ instead.

rem NOTE 2: prefer the portable node shipped by the one-command installer
rem   (it is not added to PATH, so a bare "node" would not resolve).
set "NODE_EXE=node"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"

rem NOTE 3: DSH_WEB_BRIDGE_NO_PAUSE=1 is set by tools\autostart.vbs (hidden autostart).
rem   Without it, an exited bridge would sit at "pause" forever inside an invisible window
rem   while still holding bridge.out.log open - and the next autostart could not open that
rem   log for appending, so it silently started nothing (observed while testing).

rem NOTE 4: there is deliberately NO dependency step here - do not add one back.
rem   This implementation imports only "node:" builtins plus its own ./lib/*.mjs files
rem   (verified: no file in the package imports ajv or anything else), so there is
rem   nothing to install.
rem   The previous version gated on "node_modules exists, else npm install". A clean
rem   machine has no node_modules (the kit never ships one) and no npm on PATH (the
rem   portable node lives under %~dp0node and is never added to PATH), so "where npm"
rem   failed and this file exited 1 BEFORE start.mjs ever ran. Because autostart.vbs
rem   launches this file hidden, the user saw a successful install while the bridge
rem   never started, and the device stayed offline with no visible error.

rem Fail loudly when node itself is missing: silently exiting 0 here looks like success
rem (and autostart would report nothing).
"%NODE_EXE%" --version >nul 2>nul
if errorlevel 1 goto no_node

if exist config.json goto run
echo Not initialized yet: running setup...
"%NODE_EXE%" setup.mjs
if errorlevel 1 goto fail

:run
"%NODE_EXE%" start.mjs
if errorlevel 1 goto fail
echo.
echo [exited] press any key to close
if "%DSH_WEB_BRIDGE_NO_PAUSE%"=="1" exit /b 0
pause >nul
exit /b 0

:no_node
echo [ERROR] Node.js not found.
echo         Expected the portable copy at "%~dp0node\node.exe", or "node" on PATH.
echo         Re-run the one-command installer, or install Node.js 22+ and retry.
if "%DSH_WEB_BRIDGE_NO_PAUSE%"=="1" exit /b 1
pause >nul
exit /b 1

:fail
echo.
echo [FAILED] please share the error above when asking for help.
if "%DSH_WEB_BRIDGE_NO_PAUSE%"=="1" exit /b 1
pause >nul
exit /b 1
