import json
import re
import time
import urllib.request
import pathlib

BASE = 'http://127.0.0.1:8787'

# 取那份 9 万字的哈佛公开课转写稿
f = max(pathlib.Path('sessions').glob('*哈佛公开课AI*转写稿.md'), key=lambda p: p.stat().st_size)
text = f.read_text(encoding='utf-8')
segs = []
for line in text.splitlines():
    m = re.match(r'^\[(\d{1,3}:\d{2})\]\s*(.+)$', line.strip())
    if m:
        segs.append({'time': m.group(1), 'text': m.group(2)})
print(f'转写稿：{f.name}')
print(f'段落 {len(segs)}，正文 {sum(len(s["text"]) for s in segs)} 字')

job = 'e2e' + str(int(time.time()))
body = json.dumps({'title': '哈佛公开课AI', 'segments': segs, 'duration': '约 2 小时',
                   'job': job}).encode()

t0 = time.time()
req = urllib.request.Request(BASE + '/api/notes', data=body,
                             headers={'Content-Type': 'application/json'})
res = None
seen = []
for i in range(200):
    if i == 0:
        try:
            with urllib.request.urlopen(req, timeout=1800) as r:
                res = json.loads(r.read().decode())
        except Exception as exc:
            print('请求异常:', exc)
            break
        break
    time.sleep(2)

print('耗时 %.0f 秒' % (time.time() - t0))
if res:
    art = res.get('article', '')
    notes = res.get('notes', '')
    print(f'讲稿 {len(art)} 字 | 笔记 {len(notes)} 字')
    print('讲稿开头:', art[:60].replace('\n', ' '))
    print('讲稿结尾:', art[-60:].replace('\n', ' '))
    print('原文文件:', res.get('article_path'))
    print('笔记文件:', res.get('notes_path'))
