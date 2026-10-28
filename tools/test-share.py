import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
src = root / 'portable' / '课堂转写-v1.21.2-可分享.zip'
tmp = pathlib.Path(tempfile.mkdtemp(prefix='share-test-'))

print('解压到', tmp)
with zipfile.ZipFile(src) as z:
    z.extractall(tmp)
app = tmp / '课堂转写'

py = app / 'python' / 'python.exe'
print('内置 python 存在:', py.exists())

port = 8899
proc = subprocess.Popen([str(py), 'server.py', '--port', str(port)], cwd=str(app),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
ok = False
for _ in range(20):
    time.sleep(1)
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/config', timeout=3) as r:
            cfg = json.loads(r.read().decode())
        print('启动成功，版本', cfg.get('version'))
        ok = True
        break
    except Exception:
        continue

if not ok:
    print('启动失败')

cfg_path = app / 'config.json'
print('首次运行生成 config.json:', cfg_path.exists())
if cfg_path.exists():
    j = json.loads(cfg_path.read_text(encoding='utf-8'))
    print('  默认模型:', j.get('model'))
    print('  api_key 为空:', not (j.get('api_key') or '').strip())
    print('  notes_api_key 为空:', not (j.get('notes_api_key') or '').strip())

proc.terminate()
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()

shutil.rmtree(tmp, ignore_errors=True)
print('测试目录已清理')
