"""验证看门狗：生成任务在跑时，即使出网探测全失败也不能退出。"""
import os
import subprocess
import sys
import textwrap

PY = sys.executable
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCENARIO = textwrap.dedent('''
    import os, sys, time, threading
    sys.path.insert(0, r"{root}")
    import server

    os.environ["DICT_PROBE_TARGET"] = "http://127.0.0.1:9"   # 必定失败
    os.environ["DICT_PROBE_SECONDS"] = "0.5"
    os.environ["DICT_PROBE_FAILS"] = "2"

    mode = sys.argv[1]
    if mode == "busy":
        # 假装有一个生成任务在跑
        server.NOTES_PROGRESS["fakejob"] = {{"stage": "article", "at": time.time()}}

    threading.Thread(target=server._watchdog_loop, daemon=True).start()
    time.sleep(3.5)          # 足够触发 2 次以上失败
    print("SURVIVED")
''').format(root=ROOT)

tmp = os.path.join(ROOT, '_wd_test.py')
with open(tmp, 'w', encoding='utf-8') as fh:
    fh.write(SCENARIO)

try:
    for mode, expect in (('busy', 0), ('idle', 9)):
        r = subprocess.run([PY, tmp, mode], capture_output=True, text=True,
                           encoding='utf-8', errors='ignore', timeout=30)
        ok = (r.returncode == expect)
        print(f'{mode:5} 退出码 {r.returncode}（期望 {expect}）{"✓" if ok else "✗"}')
        for line in (r.stdout or '').splitlines():
            if 'watchdog' in line or 'SURVIVED' in line:
                print('   ', line.strip()[:100])
finally:
    if os.path.exists(tmp):
        os.remove(tmp)
