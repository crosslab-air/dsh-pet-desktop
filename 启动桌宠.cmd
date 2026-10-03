@echo off
chcp 65001 >nul
setlocal
rem ============================================================================
rem  dsh-pet-desktop 启动入口
rem
rem  正常用法：直接双击桌面上的「DSH蓝色大肥鱼桌宠」快捷方式（无任何黑框）。
rem  本脚本是备用入口，只做两件事：
rem    ① 首次运行时自动下载 Electron 运行时到 electron\（约 300MB，走 npmmirror 镜像）
rem    ② 以"应用模式"拉起 Electron 外壳后立即退出
rem
rem  用 start 让 Electron 脱离本控制台独立运行，所以黑框一闪即消失，
rem  关掉它**不会**影响桌宠。退出请用：桌宠右键 ->「退出桌宠程序」。
rem ============================================================================
set "ROOT=%~dp0"
set "EXE=%ROOT%electron\electron.exe"
set "APP=%ROOT%standalone\app"

if not exist "%EXE%" (
  echo [dsh-pet] 首次运行：正在下载 Electron 运行时（约 300MB）...
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\ensure-electron.ps1" -Root "%ROOT%"
  if errorlevel 1 (
    echo.
    echo [dsh-pet] Electron 下载失败。可检查网络后重试，
    echo            或手动下载 electron-v43.3.0-win32-x64.zip 解压到 "%ROOT%electron\"。
    pause
    exit /b 1
  )
)

rem 关键：清掉可能被上层终端透传的 ELECTRON_RUN_AS_NODE。
rem 带着它启动会退化成纯 Node 模式，Electron API 全部不可用（入口里也有同样的自救逻辑兜底）。
set "ELECTRON_RUN_AS_NODE="

start "" "%EXE%" "%APP%"
exit /b 0
