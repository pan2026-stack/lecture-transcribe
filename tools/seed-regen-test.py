"""播一份临时转写稿，供重新整理测试使用。"""
import pathlib
import time

ROOT = pathlib.Path(r'C:\Users\92182\Documents\deepseek-harness\default-workspace\lecture-transcribe')
path = ROOT / 'sessions' / '20261028-101500-刷新接续测试-转写稿.md'
path.write_text(f'''# 刷新接续测试

- 时间：{time.strftime('%Y-%m-%d %H:%M:%S')}
- 时长：00:40
- 片段数：4

## 转写原文（带时间戳）

[00:06] 这一节讲对抗搜索里的极小极大算法。
[00:14] 用 max 选最大、min 选最小的递归求值。
[00:24] alpha-beta 剪枝能大幅减少搜索量。
[00:34] 剪枝的前提是子节点已经足够好，不必再展开。

## 纯文本（便于复制整理）

这一节讲对抗搜索……
''', encoding='utf-8')
print('已写入', path.name)
