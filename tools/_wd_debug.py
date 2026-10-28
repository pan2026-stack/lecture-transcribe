import os
import sys
import time
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import server  # noqa: E402

os.environ['DICT_PROBE_TARGET'] = 'http://127.0.0.1:9'
os.environ['DICT_PROBE_SECONDS'] = '0.5'
os.environ['DICT_PROBE_FAILS'] = '2'

print('probe 结果:', server._probe_outbound())
print('strict:', server.load_config().get('watchdog_strict', False))
print('NOTES_PROGRESS:', server.NOTES_PROGRESS)
print('LAST_ACTIVITY 距今:', round(time.time() - server.LAST_ACTIVITY[0], 1))
print('DEFAULT watchdog_restart:', server.DEFAULT_CONFIG.get('watchdog_restart'))

# 直接跑两轮判断逻辑，观察 fails 变化
import threading
threading.Thread(target=server._watchdog_loop, daemon=True).start()
for i in range(6):
    time.sleep(0.6)
    print(f't={0.6*(i+1):.1f}s fails={server.WATCHDOG["fails"]} last_check={server.WATCHDOG["last_check"]:.1f}')
print('结束（如果进程还在，说明没触发退出）')
