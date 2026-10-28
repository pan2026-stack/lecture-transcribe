"""看 github.com 现在能怎么连：直连 / 走代理。"""
import socket
import time
import urllib.error
import urllib.request

PROXY = 'http://127.0.0.1:22385'
TARGETS = ['https://github.com', 'https://api.github.com', 'https://github.com/pan2026-stack/lecture-transcribe.git/info/refs?service=git-upload-pack']


def probe(url, proxy=None):
    handlers = [urllib.request.ProxyHandler({'http': proxy, 'https': proxy})] if proxy else [urllib.request.ProxyHandler({})]
    opener = urllib.request.build_opener(*handlers)
    t0 = time.time()
    try:
        req = urllib.request.Request(url, method='GET', headers={'User-Agent': 'git/2.55'})
        with opener.open(req, timeout=12) as r:
            return f'可达 {r.status} {time.time()-t0:.2f}s'
    except urllib.error.HTTPError as e:
        return f'可达 HTTP {e.code} {time.time()-t0:.2f}s'
    except Exception as e:
        return f'不通 {type(e).__name__} {str(e)[:50]}'


print('=== TCP 直连 443 ===')
for host in ('github.com', '140.82.112.4', '140.82.113.4'):
    t0 = time.time()
    try:
        s = socket.create_connection((host, 443), timeout=6)
        s.close()
        print(f'  {host:18} 可连 {time.time()-t0:.2f}s')
    except Exception as e:
        print(f'  {host:18} 失败 {type(e).__name__}')

print('=== HTTPS 直连 ===')
for u in TARGETS:
    print(f'  {u[:60]:60} {probe(u)}')

print('=== HTTPS 走代理 ===')
for u in TARGETS:
    print(f'  {u[:60]:60} {probe(u, PROXY)}')
