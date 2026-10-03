# =============================================================================
#  ensure-electron.ps1 —— 首次运行时把 Electron 运行时下载并解压到 <仓库根>\electron\
#
#  由「启动桌宠.cmd」自动调用；也可手动执行：
#      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-electron.ps1
#
#  默认走 npmmirror 镜像（国内可达）；失败时回落到官方 GitHub Releases。
#  已存在 electron.exe 则直接跳过，不会重复下载。
# =============================================================================
param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$Version = '43.3.0'
$Arch = 'win32-x64'
$Dir = Join-Path $Root 'electron'
$Exe = Join-Path $Dir 'electron.exe'

if (Test-Path -LiteralPath $Exe) {
    Write-Host "[dsh-pet] Electron 已就绪：$Exe"
    exit 0
}

$File = "electron-v$Version-$Arch.zip"
$Urls = @(
    "https://npmmirror.com/mirrors/electron/$Version/$File",
    "https://registry.npmmirror.com/-/binary/electron/$Version/$File",
    "https://github.com/electron/electron/releases/download/v$Version/$File"
)
$Zip = Join-Path $env:TEMP $File

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$ok = $false
foreach ($u in $Urls) {
    Write-Host "[dsh-pet] 尝试下载：$u"
    try {
        Invoke-WebRequest -Uri $u -OutFile $Zip -UseBasicParsing
        if ((Get-Item -LiteralPath $Zip).Length -gt 10MB) { $ok = $true; break }
        Write-Host "[dsh-pet] 下载内容不完整，换下一个源"
    } catch {
        Write-Host ("[dsh-pet] 该源失败：" + $_.Exception.Message)
    }
}

if (-not $ok) {
    Write-Error "[dsh-pet] 所有下载源均失败。请手动下载 $File 并解压到 $Dir"
    exit 1
}

Write-Host "[dsh-pet] 解压中..."
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Expand-Archive -LiteralPath $Zip -DestinationPath $Dir -Force

try { Remove-Item -LiteralPath $Zip -Force -ErrorAction SilentlyContinue } catch { }

if (Test-Path -LiteralPath $Exe) {
    Write-Host "[dsh-pet] Electron 安装完成：$Exe"
    exit 0
}

Write-Error "[dsh-pet] 解压后未找到 electron.exe，请检查 $Dir"
exit 1
