import sys
import pathlib
import re

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import server  # noqa: E402

written = {}


def fake_write(title, text, cfg, label="课堂笔记", kind="笔记", tags=None, banner=""):
    written[label] = text
    return pathlib.Path(f"<{label}>.md"), "fake"


server.write_note_file = fake_write

# 用最长的真实转写稿，截到约 30k 字，走分段路径
f = max(pathlib.Path('sessions').glob('*转写稿.md'), key=lambda p: p.stat().st_size)
text = f.read_text(encoding='utf-8')

segs = []
total = 0
for line in text.splitlines():
    m = re.match(r'^\[(\d{1,3}:\d{2})\]\s*(.+)$', line.strip())
    if m:
        segs.append({'time': m.group(1), 'text': m.group(2)})
        total += len(m.group(2))
        if total > 30000:
            break

print(f'测试文件：{f.name}')
print(f'段落 {len(segs)}，送入约 {total} 字（超过 24000 会分段）')

out = server.generate_notes({'title': '分段完整性测试', 'segments': segs, 'duration': '约 40 分钟'})
art = out.get('article', '')
notes = out.get('notes', '')
print(f'讲稿输出 {len(art)} 字 / 笔记输出 {len(notes)} 字')
print('讲稿开头:', art[:70].replace('\n', ' '))
print('讲稿结尾:', art[-90:].replace('\n', ' '))
print('笔记有章节速览:', '章节速览' in notes)
print('笔记有术语:', '## 术语' in notes)
print('笔记有自测题:', '自测题' in notes)
