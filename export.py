"""把笔记 markdown 导出成 HTML / PDF / Word。

- HTML：自带样式，双击就能看
- PDF：用本机 Edge 无头打印，无需额外依赖
- DOCX：直接生成 OOXML 压缩包，不依赖 python-docx
"""

from __future__ import annotations

import html as htmllib
import re
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/microsoft-edge",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]

CSS = """
:root { --ink:#1c2229; --muted:#69707a; --line:#e4e8ee; --accent:#1c78aa; }
* { box-sizing:border-box; }
body { margin:0; padding:48px 56px; background:#fff; color:var(--ink);
       font:15px/1.85 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
h1 { font-size:26px; margin:0 0 6px; }
.meta { color:var(--muted); font-size:13px; margin-bottom:26px; }
h2 { font-size:19px; margin:34px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
h3 { font-size:16px; margin:22px 0 8px; }
ul, ol { padding-left:22px; margin:8px 0 14px; }
li { margin:4px 0; }
strong { font-weight:600; }
code { background:#f4f6f8; padding:1px 5px; border-radius:4px; font-size:.92em; }
.ts { color:var(--accent); font-variant-numeric:tabular-nums; font-size:.9em; }
.tag { display:inline-block; padding:0 6px; border-radius:999px; background:#eef4f8;
       color:var(--accent); font-size:11px; line-height:1.7; }
.foot { margin-top:40px; padding-top:12px; border-top:1px solid var(--line);
        color:var(--muted); font-size:12px; }
@page { margin: 16mm; }
"""


def _inline(text: str) -> str:
    s = htmllib.escape(text)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\[([^\]]{1,40})\]\((https?://[^\s)]+)\)", r'<a href="\2">\1</a>', s)
    s = re.sub(r"\[(\d{2}:\d{2})\]", r'<span class="ts">\1</span>', s)
    s = re.sub(r"（(理论|现状|方法|案例|对比|原则|风险)）", r'<span class="tag">\1</span>', s)
    return s


def md_to_html(md: str, title: str) -> str:
    out, list_open = [], None
    for raw in md.splitlines():
        line = raw.rstrip()
        if not line.strip():
            if list_open:
                out.append(f"</{list_open}>")
                list_open = None
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", line.strip())
        if m:
            if list_open:
                out.append(f"</{list_open}>")
                list_open = None
            lvl = min(3, len(m.group(1)) + 1)
            out.append(f"<h{lvl}>{_inline(m.group(2))}</h{lvl}>")
            continue
        m = re.match(r"^[-*+]\s+(.*)$", line.strip())
        if m:
            if list_open != "ul":
                if list_open:
                    out.append(f"</{list_open}>")
                out.append("<ul>")
                list_open = "ul"
            item = m.group(1)
            item = re.sub(r"^\[[ xX]\]\s*", "", item)
            out.append(f"<li>{_inline(item)}</li>")
            continue
        m = re.match(r"^\d+[.)、]\s*(.*)$", line.strip())
        if m:
            if list_open != "ol":
                if list_open:
                    out.append(f"</{list_open}>")
                out.append("<ol>")
                list_open = "ol"
            out.append(f"<li>{_inline(m.group(1))}</li>")
            continue
        if list_open:
            out.append(f"</{list_open}>")
            list_open = None
        out.append(f"<p>{_inline(line.strip())}</p>")
    if list_open:
        out.append(f"</{list_open}>")

    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>{htmllib.escape(title)}</title><style>{CSS}</style></head><body>
<h1>{htmllib.escape(title)}</h1>
<div class="meta">导出于 {stamp}</div>
{chr(10).join(out)}
<div class="foot">由「课堂转写」生成</div>
</body></html>"""


def _edge() -> str | None:
    for p in EDGE_CANDIDATES:
        if Path(p).exists():
            return p
    for name in ("msedge", "microsoft-edge", "chrome", "google-chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


def html_to_pdf(html_text: str, out_pdf: Path) -> None:
    edge = _edge()
    if not edge:
        raise RuntimeError("找不到 Edge/Chrome，无法导出 PDF")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "note.html"
        src.write_text(html_text, encoding="utf-8")
        cmd = [
            edge, "--headless=new", "--disable-gpu", "--no-first-run",
            f"--print-to-pdf={out_pdf}", "--print-to-pdf-no-header",
            "--virtual-time-budget=4000", src.as_uri(),
        ]
        res = subprocess.run(cmd, capture_output=True, timeout=120)
        if not out_pdf.exists():
            raise RuntimeError("PDF 生成失败：" + res.stderr.decode("utf-8", "ignore")[:200])


# ---------------------------------------------------------------- docx

DOCX_PARTS = {
    "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""",
    "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""",
}


def _para(text: str, style: str | None = None, bold: bool = False, size: int | None = None) -> str:
    props = []
    if style:
        props.append(f'<w:pStyle w:val="{style}"/>')
    if bold:
        props.append("<w:b/>")
    if size:
        props.append(f'<w:sz w:val="{size}"/>')
    ppr = f"<w:pPr>{''.join(props)}</w:pPr>" if props else ""
    safe = htmllib.escape(text)
    return f"<w:p>{ppr}<w:r><w:t xml:space=\"preserve\">{safe}</w:t></w:r></w:p>"


def md_to_docx(md: str, title: str, out: Path) -> None:
    body = [_para(title, bold=True, size=36), _para("由「课堂转写」生成 · " + datetime.now().strftime("%Y-%m-%d %H:%M"))]
    for raw in md.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            lvl = len(m.group(1))
            body.append(_para(m.group(2), bold=True, size=32 if lvl <= 2 else 26))
            continue
        m = re.match(r"^[-*+]\s+(.*)$", line)
        if m:
            text = re.sub(r"^\[[ xX]\]\s*", "☐ ", m.group(1))
            body.append(_para("• " + re.sub(r"\*\*(.+?)\*\*", r"\1", text)))
            continue
        body.append(_para(re.sub(r"\*\*(.+?)\*\*", r"\1", line)))

    doc = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>" + "".join(body) +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'
    )
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in DOCX_PARTS.items():
            z.writestr(name, data)
        z.writestr("word/document.xml", doc)
