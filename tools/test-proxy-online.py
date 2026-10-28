"""代理开着的情况下，验证识别与整理两条链路。"""
import io
import json
import struct
import time
import urllib.request
import wave

BASE = 'http://127.0.0.1:8787'

# 1) 造 1 秒静音 WAV，验证识别链路能通（结果为空是正常的）
buf = io.BytesIO()
with wave.open(buf, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(b'\x00\x00' * 16000)
wav = buf.getvalue()

req = urllib.request.Request(BASE + '/api/transcribe?lang=zh&seq=1', data=wav,
                             headers={'Content-Type': 'application/octet-stream'}, method='POST')
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read().decode())
    print(f'识别接口: {r.status} {time.time()-t0:.1f}s 文本={data.get("text")!r} 错误={data.get("error")}')
except Exception as e:
    print('识别接口失败:', type(e).__name__, str(e)[:120])

# 2) 整理链路
job = 'jproxy' + str(int(time.time()))
body = json.dumps({
    'title': '代理验证', 'duration': '1 分钟',
    'segments': [{'time': '00:05', 'text': '同时开代理看视频时，识别和整理也应该正常。'}],
    'job': job, 'background': True,
}).encode()
req = urllib.request.Request(BASE + '/api/notes', data=body,
                             headers={'Content-Type': 'application/json'}, method='POST')
with urllib.request.urlopen(req, timeout=20) as r:
    print('整理提交:', r.status, r.read().decode())

t0 = time.time()
while time.time() - t0 < 240:
    time.sleep(2)
    with urllib.request.urlopen(BASE + '/api/notes-progress?job=' + job, timeout=10) as r:
        st = json.loads(r.read().decode())
    if st.get('stage') in ('done', 'error'):
        print(f'整理结果: {st["stage"]} {time.time()-t0:.0f}s')
        if st['stage'] == 'done':
            res = st.get('result') or {}
            print('  笔记:', res.get('notes_path'))
            import pathlib
            for key in ('notes_path', 'article_path'):
                p = pathlib.Path(res.get(key) or '')
                if p.exists():
                    p.unlink()
                    print('  已删', p.name)
        else:
            print('  错误:', (st.get('error') or '')[:160])
        break
