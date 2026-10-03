@echo off
chcp 65001 >nul
title dsh-pet - 设置 DeepSeek API Key
setlocal

rem ============================================================================
rem  设置 / 更换 DeepSeek API Key
rem  —— 优先用本仓库自带的 Electron 当 Node 用（无需另装 Node.js）；
rem     没有 Electron 时回落到系统 PATH 里的 node。
rem  也可以不跑本脚本：直接在桌宠右键 ->「设置…」->「API Key」里填。
rem ============================================================================
set "EXE=%~dp0electron\electron.exe"

if exist "%EXE%" (
  rem ELECTRON_RUN_AS_NODE=1 让 electron.exe 以纯 Node 模式跑这段脚本
  set "ELECTRON_RUN_AS_NODE=1"
  "%EXE%" "%~dp0standalone\set-key.mjs"
) else (
  node "%~dp0standalone\set-key.mjs"
)

echo.
pause
