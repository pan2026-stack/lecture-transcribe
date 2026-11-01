@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 课堂转写 - 停止服务
set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
rem 正式运行时是 8787；LT_PORT 只给自测用（不动线上服务）
set "PORT=8787"
if defined LT_PORT set "PORT=%LT_PORT%"
set "URL=http://127.0.0.1:%PORT%"
set "FLAG=%APP%\logs\stop.flag"

echo.
echo   正在停止服务...

if not exist "%APP%\logs" mkdir "%APP%\logs" >nul 2>&1

rem ---------- 1) 先写退出标记：守护看到它就不会再把服务拉起来 ----------
> "%FLAG%" echo %DATE% %TIME% source=stop-bat reason=%PORT%
if exist "%FLAG%" (
    echo   已写退出标记：%FLAG%
) else (
    echo   [警告] 写不了退出标记，下面直接强制结束。
)

rem ---------- 2) 请服务自己优雅退出（它会先把后台整理任务收尾）----------
set "PY="
if exist "%APP%\python\python.exe" set "PY=%APP%\python\python.exe"
if not defined PY for %%p in (python.exe) do if not defined PY if exist "%%~$PATH:p" set "PY=%%~$PATH:p"
set "ASKED="
if defined PY (
    "%PY%" -c "import sys,urllib.request;r=urllib.request.Request(sys.argv[1]+'/api/shutdown',data=b'{}',headers={'Content-Type':'application/json'},method='POST');print(urllib.request.urlopen(r,timeout=3).read().decode('utf-8'))" "%URL%" >nul 2>&1
    if not errorlevel 1 set "ASKED=1"
)
if not defined ASKED (
    curl -s -X POST -H "Content-Type: application/json" -d "{}" "%URL%/api/shutdown" >nul 2>&1
    if not errorlevel 1 set "ASKED=1"
)
if defined ASKED (
    echo   已通知服务退出，正在等它收尾...
) else (
    echo   服务没有响应（可能本来就没在跑），直接清理进程。
)

rem 最多等 8 秒；服务在等后台整理任务时会久一点
set "ALIVE="
for /l %%i in (1,1,8) do if not defined ALIVE (
    if defined PY (
        "%PY%" -c "import socket,sys;s=socket.socket();s.settimeout(0.5);sys.exit(0 if s.connect_ex(('127.0.0.1',%PORT%))==0 else 1)" >nul 2>&1
    ) else (
        powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; $t=$c.ConnectAsync('127.0.0.1',%PORT%); if($t.Wait(800) -and $c.Connected){ exit 0 } else { exit 1 }" >nul 2>&1
    )
    if not errorlevel 1 (
        set "ALIVE=1"
        ping -n 2 127.0.0.1 >nul
    )
)
if not defined ALIVE echo   服务已退出。
if defined ALIVE echo   服务还在收尾，继续清理进程。

rem ---------- 3) 结束守护（命名互斥体的持有者，按命令行扫）----------
set "WD_KILLED="
for /f "usebackq delims=" %%n in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$app='%APP%'; $p=@(Get-CimInstance Win32_Process).Where({ ($_.Name -eq 'python.exe' -or $_.Name -eq 'pythonw.exe') -and $_.CommandLine -and $_.CommandLine.Contains('watchdog.pyw') -and ($_.CommandLine.Contains($app) -or $_.CommandLine.Contains('--port %PORT%')) }); foreach($x in $p){ Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count"`) do set "WD_KILLED=%%n"
if defined WD_KILLED if not "%WD_KILLED%"=="0" echo   已结束守护进程 %WD_KILLED% 个

rem ---------- 4) 再停端口上的服务（netstat 拿不到 PID 时按命令行找）----------
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    if not "%%p"=="0" (
        taskkill /PID %%p /F >nul 2>&1
        if not errorlevel 1 (
            set "FOUND=1"
            echo   已停止服务进程 PID %%p
        )
    )
)
set "SRV_KILLED="
for /f "usebackq delims=" %%n in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=@(Get-CimInstance Win32_Process).Where({ ($_.Name -eq 'python.exe' -or $_.Name -eq 'pythonw.exe') -and $_.CommandLine -and $_.CommandLine.Contains('server.py') -and $_.CommandLine.Contains('--port %PORT%') }); foreach($x in $p){ Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count"`) do set "SRV_KILLED=%%n"
if defined SRV_KILLED if not "%SRV_KILLED%"=="0" (
    set "FOUND=1"
    echo   已停止服务进程 %SRV_KILLED% 个
)

if not defined FOUND (
    echo   没有在跑的服务。
)

rem 老版本留下的 pid 文件已经没用了，删掉免得下次误判
del /q "%APP%\logs\watchdog.pid" >nul 2>&1

echo.
echo   服务已经停了，守护也不会再把它拉起来。
echo   下次照常双击桌面「课堂转写」就行。
echo.
pause
