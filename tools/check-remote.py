"""推送后自检：GitHub 上的文件里有没有不该出现的东西。"""
import json
import re
import urllib.request

PROXY = 'http://127.0.0.1:8899'
REPO = 'pan2026-stack/lecture-transcribe'
opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY}))


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'dsh-check'})
    with opener.open(req, timeout=20) as r:
        return json.loads(r.read().decode())


tree = get(f'https://api.github.com/repos/{REPO}/git/trees/main?recursive=1')
files = [x['path'] for x in tree['tree'] if x['type'] == 'blob']
print('远端文件数:', len(files))

pats = {
    'KEY': re.compile(r'sk-[A-Za-z0-9]{16,}'),
    '个人路径': re.compile(r'Users[\\/]92182'),
    '课程名': re.compile(r'哈佛公开课|大模型技术原理|信息检索|学术写作|马克的技术工坊|CS50x'),
    '知识库': re.compile(r'D:\\\\知识库|D:\\知识库'),
}
TEXT = ('.py', '.js', '.html', '.css', '.md', '.json', '.txt', '.diff', '.mjs')
bad = {k: [] for k in pats}
checked = 0
for path in files:
    if not path.lower().endswith(TEXT):
        continue
    checked += 1
    raw = f'https://raw.githubusercontent.com/{REPO}/main/{path}'
    try:
        req = urllib.request.Request(raw, headers={'User-Agent': 'dsh-check'})
        with opener.open(req, timeout=20) as r:
            text = r.read().decode('utf-8', errors='ignore')
    except Exception as exc:
        print('读取失败', path, exc)
        continue
    for label, pat in pats.items():
        if pat.search(text):
            bad[label].append(path)

print('检查文件数:', checked)
for label, hits in bad.items():
    print(f'  {label}: {len(hits)}', hits[:5])
