import shutil
from pathlib import Path

root = Path(__file__).resolve().parent
out = root / 'portable' / '课堂转写'
py_dir = out / 'python'
if py_dir.exists():
    # 保留已内置的解释器，只重建程序文件
    for item in out.iterdir():
        if item.name == 'python':
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
else:
    if out.exists():
        shutil.rmtree(out)
    py_dir.mkdir(parents=True)

if (py_dir / '放这里.txt').exists():
    (py_dir / '放这里.txt').unlink()

for name in ['server.py', 'index.html', 'style.css', 'app.js', 'SKILL.md', 'README.md', 'VERSION',
             'app.ico', 'make-shortcut.ps1', '创建桌面快捷方式.bat']:
    shutil.copy2(root / name, out / name)
shutil.copytree(root / 'emotion-ball', out / 'emotion-ball')
if (root / 'vendor').is_dir():
    shutil.copytree(root / 'vendor', out / 'vendor')   # jieba 分词

BAT = r'''@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 课堂转写

set "PY="
if exist "python\python.exe" set "PY=python\python.exe"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo.
  echo   没找到 Python。
  echo   两种办法，任选其一：
  echo     1^) 把 python-3.12.x-embed-amd64.zip 解压到本目录的 python\ 文件夹里
  echo     2^) 安装 Python 3.10+ 并勾选 Add to PATH
  echo.
  pause
  exit /b 1
)

echo   正在启动，浏览器会自动打开...
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"
%PY% server.py
echo.
pause
'''

PYNOTE = '''把 python-3.12.x-embed-amd64.zip 解压到这里，让 python.exe 直接位于本文件夹下。

下载地址：https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip

放好之后，双击上一层的「启动.bat」即可，不再需要安装 Python。
'''

README = '''课堂转写 · 绿色版

一、启动
   双击「启动.bat」。浏览器会自动打开 http://127.0.0.1:8787
   第一次会弹出向导，填两个 KEY 即可：
     1) 硅基流动 KEY —— 语音识别（cloud.siliconflow.cn）
     2) DeepSeek KEY —— 整理讲稿和笔记（platform.deepseek.com）

二、除了 KEY 还要配什么
   不需要。接口地址、模型、切片长度、Obsidian 收件箱路径都有默认值。
   想改的话点右上角「设置」，那里才是全量配置。

三、数据在哪
   config.json  两个 KEY 和设置（只存在本机）
   sessions\\    转写稿、讲稿、笔记，以及断点音频
   默认还会往 D:\\Obsidian\\00-收件箱 写一份；那个目录不存在时只存 sessions\\

四、换电脑
   整个文件夹拷走即可。KEY 在 config.json 里，别外传。

五、Python
   已内置在 python\\ 文件夹里，对方机器不需要安装 Python。
'''

(out / '启动.bat').write_text(BAT.replace('\n', '\r\n'), encoding='utf-8')
(out / '使用说明.txt').write_text(README.replace('\n', '\r\n'), encoding='utf-8')

# 顺带打一个带版本号的 zip
version = (root / 'VERSION').read_text(encoding='utf-8').strip() or '0.0.0'
target = root / 'portable' / f'课堂转写-绿色版-v{version}'
for old_zip in (root / 'portable').glob('课堂转写-绿色版*.zip'):
    old_zip.unlink(missing_ok=True)
archive = shutil.make_archive(str(target), 'zip', root_dir=out.parent, base_dir=out.name)
print('打包:', archive, f'{Path(archive).stat().st_size / 1048576:.1f} MB')

print('生成完成:', out)
for p in sorted(out.iterdir()):
    size = p.stat().st_size if p.is_file() else '-'
    print(f'  {p.name:16} {size}')
