@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 课堂转写 - 停止服务
set "PORT=8787"

echo.
echo   正在停止 %PORT% 端口上的服务...
echo.

set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    set "FOUND=1"
    taskkill /PID %%p /F >nul 2>&1
    echo   已停止进程 PID %%p
)

if not defined FOUND (
    echo   没有在跑的服务。
    echo   如果之前是用「课堂转写.bat」开的，直接关掉那个窗口也可以。
)

echo.
pause
