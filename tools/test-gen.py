import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import server  # noqa: E402

written = {}


def fake_write(title, text, cfg, label="课堂笔记", kind="笔记", tags=None, banner=""):
    written[label] = text
    return pathlib.Path(f"<{label}>.md"), "fake"


server.write_note_file = fake_write

# 取一份真实的转写稿，截到大约 26k 字，触发分段逻辑
tr = sorted(pathlib.Path('sessions').glob('*转写稿.md'), key=lambda p: p.stat().st_size)
target = None
for f in tr:
    text = f.read_text(encoding='utf-8')
    if 20000 < len(text) < 40000:
        target = (f, text)
        break
if not target:
    for f in tr:
        text = f.read_text(encoding='utf-8')
        if len(text) > 26000:
            target = (f, text[:26000])
            break

f, text = target
import re

segs = []
for line in text.splitlines():
    m = re.match(r'^\[(\d{1,3}:\d{2})\]\s*(.+)$', line.strip())
    if m:
        segs.append({'time': m.group(1), 'text': m.group(2)})

print(f'测试文件：{f.name}')
print(f'段落 {len(segs)}，原文 {sum(len(x["text"]) for x in segs)} 字')

out = server.generate_notes({'title': '完整性测试', 'segments': segs, 'duration': '测试'})
print('返回 keys:', list(out.keys()))
art = out.get('article', '')
notes = out.get('notes', '')
print(f'讲稿输出 {len(art)} 字 / 笔记输出 {len(notes)} 字')
print('讲稿开头:', art[:80].replace('\n', ' '))
print('讲稿结尾:', art[-80:].replace('\n', ' '))
print('讲稿是否含结尾缺失标记:', '[不清楚]' in art)
