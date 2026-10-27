@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 课堂转写 - 关掉本窗口即停止服务
set "APP=C:\Users\92182\Documents\deepseek-harness\default-workspace\lecture-transcribe"
set "URL=http://127.0.0.1:8787"

echo.
echo   ==========================================
echo      课堂实时转写
echo   ==========================================
echo.

if not exist "%APP%\server.py" (
    echo   [错误] 找不到程序目录：
    echo   %APP%
    echo   程序可能被移动或删除了。
    goto :end
)

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
    where py >nul 2>nul && set "PY=py -3"
)
if not defined PY (
    echo   [错误] 没找到 Python，请先安装 Python 3 并添加到 PATH。
    goto :end
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if(Test-NetConnection 127.0.0.1 -Port 8787 -InformationLevel Quiet -WarningAction SilentlyContinue){exit 0}else{exit 1}"
if not errorlevel 1 (
    if /i "%~1"=="dry" (
        echo   [dry] 端口 8787 已被占用，服务已在运行
        goto :end
    )
    echo   服务已经在运行，正在打开网页...
    start "" "%URL%"
    goto :end
)

if /i "%~1"=="dry" (
    echo   [dry] 检查通过：Python=%PY%，端口空闲
    goto :end
)

echo   正在启动服务，浏览器 2 秒后自动打开...
echo   （关掉这个窗口就是停止服务）
echo.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"
cd /d "%APP%"
%PY% server.py

:end
echo.
if /i not "%~1"=="dry" pause