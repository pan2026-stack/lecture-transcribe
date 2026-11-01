@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 课堂转写
set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
rem 正式双击时永远是 8787；LT_PORT 只给自测用（不动线上服务）
set "PORT=8787"
if defined LT_PORT set "PORT=%LT_PORT%"
set "URL=http://127.0.0.1:%PORT%"
set "FLAG=%APP%\logs\stop.flag"

echo.
echo   ==========================================
echo      课堂实时转写
echo   ==========================================
echo.

if not exist "%APP%\server.py" goto :nodir

rem ---------- 1) 浏览器 ----------
set "BROWSER="
call :trybrowser "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
call :trybrowser "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
call :trybrowser "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
call :trybrowser "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

rem ---------- 2) python ----------
set "PY="
set "PYW="
if exist "%APP%\python\python.exe" set "PY=%APP%\python\python.exe"
if exist "%APP%\python\pythonw.exe" set "PYW=%APP%\python\pythonw.exe"
if not defined PY for %%p in (python.exe) do if not defined PY if exist "%%~$PATH:p" set "PY=%%~$PATH:p"
if not defined PY goto :nopy
if not defined PYW call :derivepyw
if not defined PYW set "PYW=%PY%"

if /i "%~1"=="dry" goto :dry

rem ---------- 3) 清掉上次「停止服务」留下的标记（否则这次起不来）----------
if exist "%FLAG%" del /q "%FLAG%" >nul 2>&1

rem ---------- 4) 起后台守护（命名互斥体单实例，负责拉起并盯着服务）----------
if exist "%APP%\watchdog.pyw" (
    start "" /min "%PYW%" "%APP%\watchdog.pyw" --port %PORT% --dir "%APP%"
)

rem ---------- 5) 等守护把服务拉起来（最多 20 秒）----------
echo   正在准备服务...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ try{ $r=Invoke-WebRequest -UseBasicParsing -Uri '%URL%/api/ping' -TimeoutSec 2; if($r.StatusCode -eq 200){$ok=$true; break} }catch{}; Start-Sleep -Milliseconds 500 }; if(-not $ok){ exit 1 }"
if errorlevel 1 goto :fallback

echo   服务已就绪，正在打开窗口...
if /i not "%~1"=="noopen" call :openapp
echo.
echo   关掉窗口（或在页面里点「停止服务」）就会全部停掉，后台不会残留。
echo   下次要用再双击这个图标就行。
goto :done

:fallback
echo   守护没起来，改为直接启动服务...
start "" /min "%PYW%" "%APP%\server.py" --port %PORT%
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ try{ $r=Invoke-WebRequest -UseBasicParsing -Uri '%URL%/api/ping' -TimeoutSec 2; if($r.StatusCode -eq 200){$ok=$true; break} }catch{}; Start-Sleep -Milliseconds 500 }; if(-not $ok){ exit 1 }"
if errorlevel 1 goto :failed
echo   服务已就绪（无守护模式，关掉窗口照样会停）。
if /i not "%~1"=="noopen" call :openapp
goto :done

:failed
echo   [错误] 服务没有起来。下面是最近的日志：
if exist "%APP%\logs\watchdog.log" (
    echo   ---- watchdog.log 最后 10 行 ----
    powershell -NoProfile -Command "Get-Content -LiteralPath '%APP%\logs\watchdog.log' -Tail 10 -Encoding UTF8 -ErrorAction SilentlyContinue"
)
if exist "%APP%\logs\server.log" (
    echo   ---- server.log 最后 10 行 ----
    powershell -NoProfile -Command "Get-Content -LiteralPath '%APP%\logs\server.log' -Tail 10 -Encoding UTF8 -ErrorAction SilentlyContinue"
)
echo.
echo   可以先运行「诊断.bat」看环境检查结果。
pause
goto :done

:dry
echo   [dry] 端口=%PORT%
echo   [dry] 目录=%APP%
echo   [dry] Python=%PY%
echo   [dry] PythonW=%PYW%
echo   [dry] 浏览器=%BROWSER%
echo   [dry] 退出标记=%FLAG%
goto :done

:trybrowser
if not defined BROWSER if exist "%~1" set "BROWSER=%~1"
goto :eof

:derivepyw
rem 先看 python.exe 旁边有没有 pythonw.exe（安装包自带的 python 目录已处理）
for %%q in ("%PY%") do set "PYDIR=%%~dpq"
if exist "%PYDIR%pythonw.exe" set "PYW=%PYDIR%pythonw.exe"
if defined PYW goto :eof
rem 再问解释器自己：uv / venv 这种 shim 旁边不是真解释器目录
set "PYWPROBE=%TEMP%\lt-pyw-%RANDOM%.txt"
if not defined TEMP set "PYWPROBE=%APP%\logs\.pyw-probe.txt"
"%PY%" -c "import os,sys;p=os.path.join(os.path.dirname(sys.executable),'pythonw.exe');print(p if os.path.exists(p) else '')" > "%PYWPROBE%" 2>nul
for /f "usebackq delims=" %%w in ("%PYWPROBE%") do if exist "%%w" set "PYW=%%w"
if exist "%PYWPROBE%" del /q "%PYWPROBE%" >nul 2>&1
goto :eof

:openapp
if defined BROWSER (
    start "" "%BROWSER%" --app="%URL%" --window-size=1440,900
) else (
    start "" "%URL%"
)
goto :eof

:nodir
echo   [错误] 找不到 server.py：
echo   %APP%
goto :done

:nopy
echo   [错误] 找不到可用的 Python。
echo   这个安装包应该自带 python，请检查：
echo   %APP%\python\python.exe
echo   没有的话多半是被杀毒软件删了，重新安装一次即可。
goto :done

:done
exit /b 0
