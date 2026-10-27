@echo off
chcp 936 >nul
title 课堂转写 - 一键启动
setlocal enabledelayedexpansion

rem 脚本放在项目根目录，所以用 %~dp0 自动定位，移动文件夹也不失效
set "APP=%~dp0"
set "PORT=8787"

echo.
echo   ============================================
echo      课堂转写 - 一键启动
echo   ============================================
echo.

if not exist "%APP%server.py" goto nodir
cd /d "%APP%"

echo   [1/4] 清理占用 %PORT% 的旧进程...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1
)
timeout /t 1 >nul

set "PY="
for %%c in (python.exe) do if not defined PY if exist "%%~$PATH:c" set "PY=%%~$PATH:c"
if not defined PY if exist "%USERPROFILE%\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\python.exe" set "PY=%USERPROFILE%\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\python.exe"
if not defined PY goto nopy
echo   [2/4] Python: !PY!

echo   [3/4] 启动服务窗口...
start "课堂转写服务" /D "%APP%" cmd /k ""!PY!" server.py --port %PORT%"

set /a TRIES=0
:wait
set /a TRIES+=1
set "CODE=0"
for /f %%r in ('powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 2).StatusCode}catch{0}"') do set "CODE=%%r"
if "!CODE!"=="200" goto ready
if !TRIES! GEQ 30 goto failed
timeout /t 1 >nul
goto wait

:ready
echo   [4/4] 服务已就绪，正在打开浏览器...
echo.
echo   ============================================
echo      地址： http://127.0.0.1:%PORT%
echo      关闭「课堂转写服务」窗口即可停止服务
echo   ============================================
echo.
start "" "http://127.0.0.1:%PORT%/?r=%RANDOM%%RANDOM%"
timeout /t 2 >nul
exit /b 0

:nodir
echo   [X] 找不到 server.py，请把本文件放回程序文件夹。
echo.
pause
exit /b 1

:nopy
echo   [X] 找不到 Python，请确认已安装后再运行。
echo.
pause
exit /b 1

:failed
echo.
echo   [X] 30 秒内没能连上服务。
echo       请查看「课堂转写服务」窗口里的报错信息。
echo.
pause
exit /b 1
