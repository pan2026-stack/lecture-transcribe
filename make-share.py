import shutil
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent
version = (root / 'VERSION').read_text(encoding='utf-8').strip() or '0.0.0'
out = root / 'portable' / 'share' / '课堂转写'
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)

# ---------- 1. 程序文件 ----------
files = ['server.py', 'speaker.py', 'export.py', 'index.html', 'style.css', 'app.js',
         'VERSION', 'app.ico', 'SKILL.md']
for name in files:
    src = root / name
    if src.exists():
        shutil.copy2(src, out / name)
    else:
        print('[warn] 缺少', name)

for d in ('emotion-ball', 'models'):
    src = root / d
    if src.is_dir():
        shutil.copytree(src, out / d)

if (root / 'vendor').is_dir():
    shutil.copytree(root / 'vendor', out / 'vendor')

# ---------- 2. 内置 Python 运行时（对方机器不用装 Python） ----------
py_src = pathlib.Path.home() / 'AppData' / 'Roaming' / 'uv' / 'python' / 'cpython-3.12-windows-x86_64-none'
if (py_src / 'python.exe').exists():
    shutil.copytree(py_src, out / 'python')
    print('已内置 Python 运行时')
else:
    print('[warn] 找不到可内置的 Python，需要对方自己装')

# ---------- 3. 启动脚本 ----------
BAT = r'''@echo off
chcp 936 >nul
title 课堂转写
setlocal
cd /d "%~dp0"

set "PY="
if exist "%~dp0python\python.exe" set "PY=%~dp0python\python.exe"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo.
  echo   没找到 Python，本应内置在 python\ 文件夹里。
  echo   如果这个文件夹被删了，请重新解压整个压缩包。
  echo.
  pause
  exit /b 1
)

rem 端口被旧进程占着就先清掉
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1

echo   正在启动课堂转写…
start "" "http://127.0.0.1:8787"
"%PY%" server.py --port 8787
echo.
echo   服务已停止。
pause
'''

VBS = r'''Option Explicit
' 课堂转写 —— 后台启动（不显示黑窗口）
Dim shell, fso, base, url, i, ok, pyw
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:8787/"

If Not fso.FileExists(base & "\server.py") Then
  MsgBox "找不到 server.py，请把本文件放回程序文件夹。", 16, "课堂转写"
  WScript.Quit 1
End If

If Health(url) Then
  shell.Run url, 1, False
  WScript.Quit 0
End If

shell.Run "cmd /c for /f ""tokens=5"" %p in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do taskkill /PID %p /F", 0, True

pyw = base & "\python\pythonw.exe"
If Not fso.FileExists(pyw) Then
  MsgBox "找不到内置的 python\pythonw.exe，请重新解压压缩包。", 16, "课堂转写"
  WScript.Quit 1
End If

shell.CurrentDirectory = base
shell.Run """" & pyw & """ """ & base & "\server.py"" --port 8787", 0, False

ok = False
For i = 1 To 30
  WScript.Sleep 1000
  If Health(url) Then
    ok = True
    Exit For
  End If
Next

If ok Then
  shell.Run url, 1, False
Else
  MsgBox "30 秒内没能启动，请改用「启动.bat」查看报错。", 48, "课堂转写"
End If

Function Health(u)
  On Error Resume Next
  Dim x
  Set x = CreateObject("MSXML2.XMLHTTP")
  x.Open "GET", u & "api/health", False
  x.Send
  Health = (Err.Number = 0) And (x.Status = 200)
  On Error GoTo 0
End Function
'''

STOP = r'''Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c for /f ""tokens=5"" %p in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do taskkill /PID %p /F", 0, True
MsgBox "课堂转写已停止。", 64, "课堂转写"
'''

README = f'''课堂转写 v{version}  ·  使用说明
========================================

一、第一次用
   1) 解压整个文件夹到任意位置（别只解压一半，python、models 都要在）
   2) 双击「启动-无窗口.vbs」——不弹黑框，几秒后浏览器自动打开
      如果浏览器没反应，改成双击「启动.bat」，能看到报错信息
   3) 页面会弹设置向导，填两个 KEY：
        · 硅基流动 KEY —— 语音识别   申请：cloud.siliconflow.cn
        · DeepSeek KEY —— 生成笔记   申请：platform.deepseek.com
      填完保存即可，以后不用再填。

二、怎么用
   点右下角圆形按钮开始听课 → 讲完点「结束并保存」
   结束后会自动整理出「完整原文」和「结构化笔记」，存进知识库收件箱。
   左侧「处理」里能看到所有历史记录，可以重新整理、导出 Word/PDF/HTML。

三、数据在哪
   config.json   两个 KEY 和设置，只存在这台电脑上
   sessions\\     转写稿、讲稿、笔记、断点音频
   D:\\Obsidian\\00-收件箱   如果这个目录存在，会往这里也写一份
                         （不存在就只存 sessions\\，不影响使用）

四、什么能做什么不能做
   ✓ 实时转写、自动分段、翻译、生成笔记、导出 Word/PDF/HTML
   ✓ 完全本地运行，录音只在本机切片后发给识别接口
   ✓ 不需要安装 Python，运行时已内置在 python\\ 文件夹
   ✗ 说话人分离需要额外模型，本包未包含（不影响主要功能）

五、停止 / 重启
   停止：双击「停止.vbs」
   重启：再双击一次「启动-无窗口.vbs」

六、换电脑
   整个文件夹拷走即可，config.json 里有 KEY，注意别外传。
'''

(out / '启动.bat').write_bytes(BAT.replace('\n', '\r\n').encode('gbk', errors='replace'))
(out / '启动-无窗口.vbs').write_bytes(VBS.replace('\n', '\r\n').encode('gbk', errors='replace'))
(out / '停止.vbs').write_bytes(STOP.replace('\n', '\r\n').encode('gbk', errors='replace'))
(out / '使用说明.txt').write_bytes(README.replace('\n', '\r\n').encode('utf-8'))

# ---------- 4. 打 zip ----------
target = root / 'portable' / f'课堂转写-v{version}-可分享'
archive = shutil.make_archive(str(target), 'zip', root_dir=out.parent, base_dir=out.name)
size = pathlib.Path(archive).stat().st_size / 1048576
print(f'打包完成：{archive}  {size:.0f} MB')

# 确认没有夹带私货
bad = [p.name for p in out.iterdir() if p.name in ('config.json', 'sessions', 'logs', 'stats.json', 'frames', 'shots', 'tools')]
print('夹带检查:', '干净' if not bad else bad)
