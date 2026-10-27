import pathlib
import re

js = pathlib.Path('app.js').read_text(encoding='utf-8')
html = pathlib.Path('index.html').read_text(encoding='utf-8')

ids = set(re.findall(r'id="([^"]+)"', html))
used = set(re.findall(r"\$\('([A-Za-z0-9_-]+)'\)", js))
missing = sorted(used - ids)

print('index.html id 数量:', len(ids))
print('app.js 引用 id 数量:', len(used))
print('缺失的 id:', missing if missing else '无')

# 找出对缺失 id 的调用位置
for name in missing:
    for n, line in enumerate(js.splitlines(), 1):
        if f"$('{name}')" in line:
            print(f'  {n}: {line.strip()[:100]}')
