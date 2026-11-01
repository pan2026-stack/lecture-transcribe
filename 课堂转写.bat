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

rem ---------- 1) 找浏览器：用 App 模式开窗口，没有地址栏和标签页 ----------
set "BROWSER="
for %%b in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
) do if not defined BROWSER if exist "%%~b" set "BROWSER=%%~b"

rem ---------- 2) 找 python：优先安装包自带的 ----------
set "PY="
set "PYARGS="
if exist "%APP%\python\python.exe" set "PY=%APP%\python\python.exe"
if not defined PY for %%p in (python.exe) do if not defined PY if exist "%%~$PATH:p" set "PY=%%~$PATH:p"
if not defined PY where py >nul 2>nul && set "PY=py" & set "PYARGS=-3"
if not defined PY goto :nopy
echo %PY% | find /i "WindowsApps" >nul && goto :nopy

rem ---------- 3) 已经在跑就直接开窗口 ----------
powershell -NoProfile -ExecutionPolicy Bypass -Command "if(Test-NetConnection 127.0.0.1 -Port %PORT% -InformationLevel Quiet -WarningAction SilentlyContinue){exit 0}else{exit 1}"
if errorlevel 1 goto :notrunning

if /i "%~1"=="dry" (
    echo   [dry] 端口 %PORT% 已被占用，服务已在运行
    goto :end
)
echo   服务已经在运行，正在打开窗口...
call :openapp
echo.
echo   想重启就先关掉那个还在跑的服务窗口，或运行「停止服务.bat」。
goto :end

:notrunning
if /i "%~1"=="dry" goto :dryfree

:run

:run
echo   启动中，2 秒后自动打开窗口...
echo   地址：%URL%
echo   （这个窗口别关，关了就等于停止服务）
echo.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; if ('%BROWSER%' -ne '') { Start-Process '%BROWSER%' -ArgumentList '--app=%URL%','--window-size=1440,900' } else { Start-Process '%URL%' }"
cd /d "%APP%"
"%PY%" %PYARGS% server.py
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" goto :stopped
echo   [服务异常退出] 退出码 %CODE%
if "%CODE%"=="9009" (
    echo   9009 的意思是系统里找不到 python 命令。
    echo   这个安装包本该自带 python，请确认安装目录下有 python\python.exe；
    echo   没有的话多半被杀毒软件删了，重新安装一次即可。
)
echo   如果是端口被占，先运行「停止服务.bat」再试。
if exist "%APP%\logs\server.log" (
    echo.
    echo   ---- server.log 最后 12 行 ----
    powershell -NoProfile -Command "Get-Content -LiteralPath '%APP%\logs\server.log' -Tail 12 -ErrorAction SilentlyContinue"
    echo   ----------------------------
)
echo.
choice /c RQ /n /m "   按 R 重新启动，按 Q 退出："
if errorlevel 2 goto :end
goto :run

:openapp
if defined BROWSER (
    start "" "%BROWSER%" --app="%URL%" --window-size=1440,900
) else (
    start "" "%URL%"
)
exit /b

:stopped
echo   服务已停止。
goto :end

:nodir
echo   [错误] 找不到 server.py：
echo   %APP%
echo   程序可能被移动或删除了。
goto :end

:nopy
echo   [错误] 找不到可用的 Python。
echo   这个安装包应该自带 python，请检查安装目录下有没有：
echo   %APP%\python\python.exe
echo   没有的话多半是被杀毒软件删了，重新安装一次即可。
goto :end

:dryfree
echo   [dry] 检查通过
echo   [dry] Python=%PY%
echo   [dry] 浏览器=%BROWSER%
echo   [dry] 端口空闲
goto :end

:end
echo.
if /i not "%~1"=="dry" pause
