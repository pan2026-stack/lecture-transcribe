@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   正在创建桌面快捷方式（带麦克风图标）...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcut.ps1"

pause
