$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root '启动.bat'
$icon = Join-Path $root 'app.ico'

if (-not (Test-Path $target)) {
    Write-Host "找不到 启动.bat，请确认这个脚本和解压后的程序放在一起。" -ForegroundColor Red
    exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop '课堂转写.lnk'

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $target
$lnk.WorkingDirectory = $root
$lnk.Description = '课堂实时转写：上课点开始，下课自动整理笔记'
if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
$lnk.Save()

Write-Host ""
Write-Host "已在桌面创建快捷方式：课堂转写" -ForegroundColor Green
Write-Host "目标：$target"
if (Test-Path $icon) { Write-Host "图标：$icon" }
Write-Host ""
