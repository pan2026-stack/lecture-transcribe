"""冒烟测试：把本地服务的主要接口都打一遍。"""
import json
import sys
import time
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787'
ok = 0
total = 0


def call(path, method='GET', body=None):
    req = urllib.request.Request(
        BASE + path, method=method, data=body,
        headers={'Content-Type': 'application/json'} if body else {},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.status, r.headers.get('Content-Type'), r.read(), time.time() - t0


def check(name, fn):
    global ok, total
    total += 1
    try:
        print(f'  ✓ {name}  {fn()}')
        ok += 1
    except Exception as exc:
        print(f'  ✗ {name}  {exc}')


def t_config():
    st, _, body, dt = call('/api/config')
    assert st == 200
    cfg = json.loads(body)
    return f'{len(body)}B {dt:.2f}s 版本 {cfg.get("version")}'


def t_stats():
    st, _, body, dt = call('/api/stats')
    assert st == 200
    d = json.loads(body)
    assert len(d.get('week', [])) == 7, 'week 必须是 7 天'
    t = d['today']
    return f"今日 {t['minutes']} 分 / {t['sessions']} 节 {dt:.2f}s"


def t_history():
    st, _, body, dt = call('/api/history')
    assert st == 200
    items = json.loads(body)['items']
    return f'{len(items)} 个文件 {dt:.2f}s'


DOCS = []


def t_doc():
    if not DOCS:
        raise RuntimeError('没有可测文件')
    path = DOCS[0]['path']
    st, _, body, dt = call('/api/doc?path=' + urllib.parse.quote(path))
    assert st == 200
    return f'{len(json.loads(body)["text"])} 字 {dt:.2f}s'


def make_export(fmt, magic):
    def run():
        if not DOCS:
            raise RuntimeError('没有可测文件')
        path = DOCS[0]['path']
        st, _, body, dt = call(f'/api/export?fmt={fmt}&path=' + urllib.parse.quote(path))
        assert st == 200, f'HTTP {st}'
        assert body.startswith(magic), '内容前缀不对'
        return f'{len(body)/1024:.0f} KB {dt:.1f}s'
    return run


def t_segments():
    st, _, body, _ = call('/api/segments?session=none')
    assert st == 200
    return f'{len(json.loads(body)["seqs"])} 段'


def t_words():
    payload = json.dumps({'text': '这个制度设计需要重新考虑权利分配', 'top': 3}, ensure_ascii=False).encode()
    st, _, body, _ = call('/api/words', 'POST', payload)
    assert st == 200
    return str(json.loads(body).get('words'))[:50]


def t_chatter():
    payload = json.dumps({'state': '录音中', 'recent': []}, ensure_ascii=False).encode()
    st, _, body, _ = call('/api/chatter', 'POST', payload)
    assert st == 200
    return json.loads(body).get('line', '')[:26]


def t_health():
    st, _, body, dt = call('/api/health')
    assert st == 200
    return f'{len(body)}B {dt:.1f}s'


def t_diarize():
    st, _, body, _ = call('/api/diarize?session=none')
    assert st == 200
    return str(json.loads(body))


DOCS.extend(json.loads(call('/api/history')[2])['items'])

print(f'冒烟测试 → {BASE}')
check('GET /api/config', t_config)
check('GET /api/health', t_health)
check('GET /api/stats', t_stats)
check('GET /api/history', t_history)
check('GET /api/doc', t_doc)
check('GET /api/export html', make_export('html', b'<!DOCTYPE'))
check('GET /api/export docx', make_export('docx', b'PK'))
check('GET /api/export pdf', make_export('pdf', b'%PDF'))
check('GET /api/segments', t_segments)
check('GET /api/diarize', t_diarize)
check('POST /api/words', t_words)
check('POST /api/chatter', t_chatter)
print(f'\n通过 {ok}/{total}')
sys.exit(0 if ok == total else 1)
