"""等 DeepSeek 恢复后再继续（最多等 5 分钟）。"""
import ssl
import time
import urllib.error
import urllib.request

OK = False
for i in range(20):
    t0 = time.time()
    try:
        urllib.request.urlopen('https://api.deepseek.com/', timeout=10)
    except urllib.error.HTTPError as e:
        print(f'第 {i+1} 次：可达 HTTP {e.code} {time.time()-t0:.2f}s')
        OK = True
        break
    except Exception as e:
        print(f'第 {i+1} 次：{type(e).__name__} {str(e)[:60]}')
    time.sleep(12)

print('结果:', '恢复' if OK else '仍未恢复')
