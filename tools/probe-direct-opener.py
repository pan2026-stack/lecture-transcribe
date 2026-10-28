import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import urllib.request  # noqa: E402
import server  # noqa: E402

print('安装前 opener:', type(urllib.request._opener).__name__ if urllib.request._opener else None)
server.install_api_opener()
print('安装后 opener:', type(urllib.request._opener).__name__ if urllib.request._opener else None)
print('getproxies:', urllib.request.getproxies())

cfg = server.load_config()
print('api_proxy 配置:', cfg.get('api_proxy'))

# 直接调上游
try:
    out = server._notes_chat(cfg, [{'role': 'user', 'content': '回复两个字：收到'}], 16)
    print('调用成功:', str(out[0]).strip()[:40])
except Exception as e:
    print('调用失败:', type(e).__name__, str(e)[:160])

# 健康检查函数
try:
    print('health:', server.handler_health if hasattr(server, 'handler_health') else '无')
except Exception as e:
    print(e)
