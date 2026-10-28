"""在代理开着的情况下，测试「强制直连」能不能通。"""
import time
import urllib.error
import urllib.request

URLS = ['https://api.deepseek.com/', 'https://api.siliconflow.cn/v1/models',
        'https://www.baidu.com', 'https://api.github.com']


def fetch(url, use_proxy):
    handlers = [] if use_proxy else [urllib.request.ProxyHandler({})]
    opener = urllib.request.build_opener(*handlers)
    t0 = time.time()
    try:
        with opener.open(urllib.request.Request(url, method='GET'), timeout=10) as r:
            return f'可达 {r.status} {time.time()-t0:.2f}s'
    except urllib.error.HTTPError as e:
        return f'可达 HTTP {e.code} {time.time()-t0:.2f}s'
    except Exception as e:
        return f'不通 {type(e).__name__} {str(e)[:45]}'


print('=== 走系统代理（当前行为） ===')
for u in URLS:
    print(f'  {u:34} {fetch(u, True)}')

print('=== 强制直连（绕过代理） ===')
for u in URLS:
    print(f'  {u:34} {fetch(u, False)}')
