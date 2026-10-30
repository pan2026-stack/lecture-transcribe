@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 课堂转写 - 关掉本窗口即停止服务
set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
set "URL=http://127.0.0.1:8787"
set "PORT=8787"

echo.
echo   ==========================================
echo      课堂实时转写
echo   ==========================================
echo.

if not exist "%APP%\server.py" goto :nodir

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY goto :nopy

powershell -NoProfile -ExecutionPolicy Bypass -Command "if(Test-NetConnection 127.0.0.1 -Port %PORT% -InformationLevel Quiet -WarningAction SilentlyContinue){exit 0}else{exit 1}"
if errorlevel 1 goto :notrunning

if /i "%~1"=="dry" (
    echo   [dry] 端口 %PORT% 已被占用，服务已在运行
    goto :end
)
echo   服务已经在运行，正在打开网页...
start "" "%URL%"
echo.
echo   想重启就先关掉那个还在跑的服务窗口，或运行「停止服务.bat」。
goto :end

:notrunning
if /i "%~1"=="dry" (
    echo   [dry] 检查通过：Python=%PY%，端口空闲
    goto :end
)

:run
echo   启动中，2 秒后自动打开浏览器...
echo   地址：%URL%
echo   （这个窗口别关，关了就等于停止服务）
echo.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"
cd /d "%APP%"
%PY% server.py
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" goto :stopped
echo   [服务异常退出] 退出码 %CODE%
echo   如果是端口被占，先运行「停止服务.bat」再试。
echo.
choice /c RQ /n /m "   按 R 重新启动，按 Q 退出："
if errorlevel 2 goto :end
goto :run

:stopped
echo   服务已停止。
goto :end

:nodir
echo   [错误] 找不到 server.py：
echo   %APP%
echo   程序可能被移动或删除了。
goto :end

:nopy
echo   [错误] 没找到 Python，请先安装 Python 3 并加到 PATH。

:end
echo.
if /i not "%~1"=="dry" pause
