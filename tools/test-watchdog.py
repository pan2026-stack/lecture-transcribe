"""验证宽松模式：模拟出网故障，看进程会不会按策略自己退出。"""
import os
import pathlib
import socket
import subprocess
import sys
import time
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
py = sys.executable
port = 8891

env = dict(os.environ)
env['DICT_PROBE_SECONDS'] = '2'        # 测试时 2 秒探一次
env['DICT_PROBE_FAILS'] = '2'          # 连续 2 次就触发
env['DICT_PROBE_TARGET'] = 'http://127.0.0.1:9'   # 必定失败的端口

proc = subprocess.Popen([py, 'server.py', '--port', str(port)], cwd=str(root),
                        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, encoding='utf-8', errors='ignore')

# 等服务起来
for _ in range(20):
    time.sleep(0.5)
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/config', timeout=2) as r:
            assert r.status == 200
        break
    except Exception:
        continue
else:
    print('服务没起来')
    proc.kill()
    raise SystemExit(1)

print('服务已启动，等待看门狗触发…')
t0 = time.time()
try:
    proc.wait(timeout=20)
    print(f'进程在 {time.time()-t0:.1f}s 后退出，退出码 {proc.returncode}')
except subprocess.TimeoutExpired:
    print(f'20 秒内没有退出（宽松模式可能没生效）')
    proc.kill()

out = proc.stdout.read() if proc.stdout else ''
for line in out.splitlines():
    if 'watchdog' in line:
        print(' 日志:', line)
