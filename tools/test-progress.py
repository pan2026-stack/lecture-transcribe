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

job = 'testsmall'
segs = [
    {'time': '00:10', 'text': '今天我们讲可逆矩阵的定义与判定方法。'},
    {'time': '00:40', 'text': '一个方阵可逆，当且仅当它的行列式不为零。'},
    {'time': '01:20', 'text': '举例来说，二阶矩阵 ad-bc 不等于零就可逆。'},
]
out = server.generate_notes({'title': '进度测试', 'segments': segs, 'duration': '2 分钟', 'job': job})
print('短课返回 keys:', list(out.keys()))
print('进度表:', server.NOTES_PROGRESS.get(job))
print('讲稿字数:', len(out['article']), '笔记字数:', len(out['notes']))
