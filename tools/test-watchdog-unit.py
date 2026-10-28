"""看门狗决策单测：三种场景直接调用 _watchdog_tick()。"""
import os
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import server  # noqa: E402

os.environ['DICT_PROBE_TARGET'] = 'http://127.0.0.1:9'   # 必定连不上
os.environ['DICT_PROBE_FAILS'] = '2'

results = []


def scenario(name, expect, setup):
    server.WATCHDOG['fails'] = 0
    server.NOTES_PROGRESS.clear()
    server.LAST_ACTIVITY[0] = time.time()
    setup()
    fired = False
    for _ in range(4):
        if server._watchdog_tick():
            fired = True
            break
    ok = (fired == expect)
    results.append(ok)
    print(f'{name:22} 触发退出={fired} 期望={expect} {"✓" if ok else "✗"}')


# 1) 空闲 + 出网失败 → 应该重启
scenario('空闲应重启', True, lambda: None)

# 2) 有生成任务在跑 → 不能重启（本次修复的核心）
scenario('生成中不重启', False,
         lambda: server.NOTES_PROGRESS.update({'jobX': {'stage': 'article', 'at': time.time()}}))

# 3) 有任务刚结束（done）+ 失败 → 可以重启
scenario('任务结束后可重启', True,
         lambda: server.NOTES_PROGRESS.update({'jobY': {'stage': 'done', 'at': time.time()}}))

# 4) 严格模式 + 刚刚有请求 → 不重启
def strict_setup():
    server.LAST_ACTIVITY[0] = time.time()
    orig = server.load_config
    server.load_config = lambda: {'watchdog_strict': True, 'watchdog_restart': True}
    server._restore_load_config = orig


strict_setup()
fired = False
server.WATCHDOG['fails'] = 0
for _ in range(4):
    if server._watchdog_tick():
        fired = True
        break
print(f'{"严格模式不重启":22} 触发退出={fired} 期望=False {"✓" if not fired else "✗"}')
results.append(not fired)
server.load_config = server._restore_load_config

print()
print('全部通过' if all(results) else '有失败项')
sys.exit(0 if all(results) else 1)
