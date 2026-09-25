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

rem dependencies (ajv) are bundled in the installer package; npm is only needed for source clones
if exist node_modules goto have_deps
where npm >nul 2>nul
if errorlevel 1 goto no_npm
echo First run: installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

:have_deps
if exist config.json goto run
echo Not initialized yet: running setup...
"%NODE_EXE%" setup.mjs
if errorlevel 1 goto fail

:run
"%NODE_EXE%" start.mjs
echo.
echo [exited] press any key to close
if "%DSH_WEB_BRIDGE_NO_PAUSE%"=="1" exit /b 0
pause >nul
exit /b 0

:no_npm
echo [ERROR] node_modules is missing and npm was not found.
echo         Reinstall with the one-command installer (it bundles dependencies),
echo         or install Node.js 22+ and run: npm install
if "%DSH_WEB_BRIDGE_NO_PAUSE%"=="1" exit /b 1
pause >nul
exit /b 1

:fail
echo.
echo [FAILED] please share the error above when asking for help.
if "%DSH_WEB_BRIDGE_NO_PAUSE%"=="1" exit /b 1
pause >nul
exit /b 1
