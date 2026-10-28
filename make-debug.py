"""打一个调试包：源码 + 测试脚本 + 日志 + 说明，不含密钥和课堂数据。"""
import json
import pathlib
import shutil

root = pathlib.Path(__file__).resolve().parent
version = (root / 'VERSION').read_text(encoding='utf-8').strip()
out_root = root / 'portable' / 'debug'
out = out_root / f'课堂转写-调试包-v{version}'

if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)

# ---------- 1. 程序文件 ----------
files = ['server.py', 'speaker.py', 'export.py', 'cli.py', 'index.html', 'style.css', 'app.js',
         'VERSION', 'README.md', 'PACKAGING.md', 'SKILL.md', 'requirements.txt',
         'config.example.json', 'make-portable.py', 'make-share.py', 'qa.js', 'smoke.py',
         'record.js', '.gitignore', 'app.ico']
for name in files:
    src = root / name
    if src.exists():
        shutil.copy2(src, out / name)

for d in ('emotion-ball', 'tools'):
    src = root / d
    if src.is_dir():
        shutil.copytree(src, out / d, ignore=shutil.ignore_patterns('node_modules', '__pycache__', 'shots', 'ruffpy', '_probe'))

# ---------- 2. 日志 ----------
logs_out = out / 'logs'
logs_out.mkdir(exist_ok=True)
for name in ('server.log', 'requests.log', 'client.log'):
    src = root / 'logs' / name
    if src.exists():
        shutil.copy2(src, logs_out / name)

# ---------- 3. 说明 ----------
guide = f'''课堂转写 · 调试包 v{version}

这是一个「出问题时拿去排查」的包，不含你的 KEY、不含课堂录音和转写稿。

一、怎么跑起来
   1) 装 Python 3.10 及以上（建议 3.12），勾选 Add to PATH
   2) 双击「启动-调试.bat」（会开一个黑窗口，报错能直接看到）
   3) 浏览器打开 http://127.0.0.1:8787

   想让它真正转写，需要在设置里填两个 KEY（这个包里没有）：
     硅基流动 KEY / DeepSeek KEY

二、这个包里有什么
   server.py           后端（纯标准库）
   app.js / style.css  前端
   tools/              自测脚本（node 或 python 跑）
   logs/               出问题时的现场：server.log、requests.log、client.log
   调试说明.md         本文件

三、日志怎么读
   logs/requests.log   每个请求的进和出，看「请求有没有到、回了没有」
   logs/server.log     看门狗决策、服务端异常堆栈
   logs/client.log     浏览器里的 JS 异常（页面、段数、服务状态、堆栈）

   排查顺序建议：
     1. requests.log 里最后一条是什么？如果连 POST /api/save 都没有，说明请求没发出来（前端问题）
     2. 有请求但没有对应的 "-> 200"，说明服务端中途断了（看 server.log）
     3. client.log 有记录，说明是前端异常，堆栈直接指向代码行

四、自测脚本
   python tools/smoke.py                     接口冒烟（12 项）
   node tools/qa.js http://127.0.0.1:8787/?qa=1 shots    界面视觉检查（8 项）
   node tools/test-fold-regression.js        静音折叠回归（脱离文档不报错）
   node tools/test-stop-inflight.js          上传中途点结束的回归
   node tools/test-watchdog-unit.py 的等价脚本见 tools/test-watchdog-unit.py（需 python 跑）

   跑 node 脚本前先在 tools 里装依赖：
     cd tools && npm install puppeteer-core

五、已知问题历史（避免重复踩）
   1) 结束课程后报「连不上本地服务 + insertBefore」
      真因：转写区清空后，静音折叠仍对已脱离文档的行做 insertBefore
      修复：改用 isConnected 判断；上传结果只收数据不碰 DOM
   2) 整理过程中服务被杀
      真因：看门狗宽松模式下不看是否有生成任务
      修复：有任务在跑时任何模式都不重启
   3) 服务进程出网状态坏掉（10061/10054）
      修复：出网探针 + 外层守护自动重启

六、注意
   这个包里的 logs/ 是从本机带出来的现场，可能包含你的课程名（不含正文）。
   发给别人前可以先看看要不要删。
'''

(out / '调试说明.md').write_text(guide.replace('\n', '\r\n'), encoding='utf-8')

BAT = f'''@echo off
chcp 65001 >nul
title 课堂转写 调试模式 v{version}
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo 没找到 Python，请先安装 3.10 以上版本并勾选 Add to PATH
  pause
  exit /b 1
)

echo 调试模式：黑窗口里会打印所有日志和报错
echo 浏览器访问 http://127.0.0.1:8787
echo.
start "" "http://127.0.0.1:8787"
python server.py --port 8787
echo.
echo 服务已退出，按任意键关闭
pause
'''
(out / '启动-调试.bat').write_bytes(BAT.replace('\n', '\r\n').encode('utf-8'))

# ---------- 4. 打 zip ----------
target = out_root / f'课堂转写-调试包-v{version}'
archive = shutil.make_archive(str(target), 'zip', root_dir=out.parent, base_dir=out.name)

# ---------- 5. 检查有没有夹带 ----------
banned = ['config.json', 'sessions', 'vendor', 'models', 'node_modules']
leaked = [name for name in banned if (out / name).exists()]
print(f'打包完成：{archive}')
print(f'大小：{pathlib.Path(archive).stat().st_size / 1048576:.1f} MB')
print('夹带检查：', '干净' if not leaked else leaked)

total = sum(f.stat().st_size for f in out.rglob('*') if f.is_file())
print(f'解压后：{total / 1048576:.1f} MB')

# 统计文件
py_files = len(list(out.glob('*.py')))
js_files = len(list(out.glob('*.js')))
print(f'文件数：{sum(1 for _ in out.rglob("*") if _.is_file())}（py {py_files} / js {js_files}）')
