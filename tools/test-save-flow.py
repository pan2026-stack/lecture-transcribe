"""端到端：模拟「结束并保存」——先存大转写稿，再整理笔记，全程进程不能掉。"""
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PY = sys.executable
PORT = 8892
BASE = f'http://127.0.0.1:{PORT}'

proc = subprocess.Popen([PY, 'server.py', '--port', str(PORT)], cwd=str(ROOT),
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, encoding='utf-8', errors='ignore')

def wait_up(timeout=25):
    for _ in range(timeout * 2):
        time.sleep(0.5)
        try:
            with urllib.request.urlopen(BASE + '/api/config', timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            continue
    return False

def post(path, payload, timeout=300):
    req = urllib.request.Request(BASE + path,
                                 data=json.dumps(payload, ensure_ascii=False).encode(),
                                 headers={'Content-Type': 'application/json'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode()), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}'), time.time() - t0

try:
    if not wait_up():
        print('服务没起来')
        raise SystemExit(1)

    # 1) 大转写稿（300 段，模拟一节课）
    segs = [{'seq': i, 'time': f'{i // 60:02d}:{i % 60:02d}',
             'text': f'第 {i} 段课堂内容，用来测试保存链路是否稳定。', 'tr': ''} for i in range(300)]
    st, data, dt = post('/api/save', {'title': '自测-大稿', 'duration': '2 小时', 'segments': segs})
    print(f'保存转写稿 {st} {dt:.1f}s 文件={data.get("path", "")[-40:]}')

    # 2) 整理（用小样本，快）
    st2, data2, dt2 = post('/api/notes', {'title': '自测-整理', 'duration': '2 分钟',
                                          'segments': segs[:6], 'job': 'e2e'})
    print(f'整理笔记   {st2} {dt2:.1f}s 讲稿={len(data2.get("article", ""))} 字 笔记={len(data2.get("notes", ""))} 字')

    # 3) 进程还活着吗
    alive = proc.poll() is None
    print('进程存活:', alive, '✓' if alive else '✗')

    # 4) 日志文件
    log = ROOT / 'logs' / 'server.log'
    print('服务端日志存在:', log.exists(), f'({log.stat().st_size} 字节)' if log.exists() else '')
    print('结果:', '通过' if (st == 200 and st2 == 200 and alive) else '失败')
finally:
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
