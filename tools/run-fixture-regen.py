"""用包内 fixture（本地假上游）验证：重新整理建任务 + 刷新后接续完成。"""
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(r'C:\Users\92182\Documents\deepseek-harness\default-workspace\lecture-transcribe')
PORT = 8893
BASE = f'http://127.0.0.1:{PORT}'

proc = subprocess.Popen([sys.executable, '-X', 'utf8', 'tests/browser_fixture.py', str(PORT)],
                        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, encoding='utf-8', errors='ignore')


def up(timeout=40):
    for _ in range(timeout * 2):
        time.sleep(0.5)
        try:
            with urllib.request.urlopen(BASE + '/api/config', timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            continue
    return False


try:
    if not up():
        print('fixture 没起来')
        print((proc.stdout.read() or '')[:600])
        raise SystemExit(1)
    print('fixture 就绪（本地假上游，不花钱）')

    body = json.dumps({
        'title': '接续验证', 'duration': '00:40',
        'segments': [
            {'time': '00:06', 'text': '这一节讲对抗搜索里的极小极大算法。'},
            {'time': '00:14', 'text': '用 max 选最大、min 选最小的递归求值。'},
            {'time': '00:24', 'text': 'alpha-beta 剪枝能大幅减少搜索量。'},
        ],
    }).encode()
    req = urllib.request.Request(BASE + '/api/save', data=body,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=20) as r:
        saved = json.loads(r.read().decode())
    print('已写入测试转写稿:', str(saved.get('path', ''))[-36:])

    env = dict(os.environ)
    env['TEST_BASE'] = BASE
    r = subprocess.run(['node', str(ROOT / 'tools' / 'test-regen-resume-fixture.js')],
                       cwd=str(ROOT), env=env, capture_output=True, text=True,
                       encoding='utf-8', errors='ignore', timeout=300)
    print(r.stdout[-2500:])
    if r.stderr.strip():
        print('stderr:', r.stderr[-400:])
finally:
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
