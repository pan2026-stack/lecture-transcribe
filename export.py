"""把笔记 markdown 导出成 HTML / PDF / Word。

- HTML：自带样式，双击就能看；截图以 base64 内嵌，单文件可用
- PDF：用本机 Edge 无头打印，无需额外依赖
- DOCX：直接生成 OOXML 压缩包，不依赖 python-docx，截图作为图片嵌入

图片来源：调用方传入 {文件名: (字节, mime)}，由 server 从知识库附件目录读取。
"""

from __future__ import annotations

import base64
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
figure { margin:18px 0 10px; page-break-inside:avoid; }
figure img { width:100%; max-width:100%; border-radius:8px; display:block; }
figcaption { color:var(--muted); font-size:12px; margin-top:6px; }
.foot { margin-top:40px; padding-top:12px; border-top:1px solid var(--line);
        color:var(--muted); font-size:12px; }
@page { margin: 16mm; }
"""

IMG_RE = re.compile(r"^\s*!\[\[([^\]|]+?\.(?:jpe?g|png|webp|gif))(?:\|[^\]]*)?\]\]\s*$", re.I)
MD_IMG_RE = re.compile(r"^\s*!\[[^\]]*\]\(([^)\s]+?\.(?:jpe?g|png|webp|gif))\)\s*$", re.I)
CAPTION_RE = re.compile(r"^>\s*截图\s*(\d{1,3}:\d{2}(?::\d{2})?)\s*$")


def shot_names(markdown: str) -> list[str]:
    """找出 markdown 里引用到的截图文件名（去重、保序）"""
    names = []
    for m in re.finditer(r"!\[\[([^\]|]+?\.(?:jpe?g|png|webp|gif))(?:S*\|[^\]]*)?\]\]", markdown, re.I):
        names.append(m.group(1).strip())
    for m in re.finditer(r"!\[[^\]]*\]\(([^)\s]+?\.(?:jpe?g|png|webp|gif))\)", markdown, re.I):
        names.append(Path(m.group(1)).name)
    seen, out = set(), []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def image_size(data: bytes) -> tuple[int, int]:
    """不依赖 Pillow 读 JPEG/PNG 的宽高"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                          0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h = int.from_bytes(data[i + 5:i + 7], "big")
                w = int.from_bytes(data[i + 7:i + 9], "big")
                return w, h
            seg = int.from_bytes(data[i + 2:i + 4], "big")
            i += 2 + seg
    return 1280, 720


def _inline(text: str) -> str:
    s = htmllib.escape(text)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\[([^\]]{1,40})\]\((https?://[^\s)]+)\)", r'<a href="\2">\1</a>', s)
    s = re.sub(r"\[(\d{1,3}:\d{2}(?::\d{2})?)\]", r'<span class="ts">\1</span>', s)
    s = re.sub(r"（(理论|现状|方法|案例|对比|原则|风险)）", r'<span class="tag">\1</span>', s)
    return s


def _figure_html(name: str, caption: str, images: dict) -> str:
    item = images.get(name)
    if not item:
        return f'<p class="meta">（截图缺失：{htmllib.escape(name)}）</p>'
    data, mime = item
    b64 = base64.b64encode(data).decode("ascii")
    cap = f"<figcaption>{htmllib.escape(caption)}</figcaption>" if caption else ""
    return (f'<figure><img alt="{htmllib.escape(name)}" '
            f'src="data:{mime};base64,{b64}">{cap}</figure>')


def md_to_html(md: str, title: str, images: dict | None = None) -> str:
    images = images or {}
    out, list_open = [], None

    def close_list():
        nonlocal list_open
        if list_open:
            out.append(f"</{list_open}>")
            list_open = None

    lines = md.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip()
        i += 1
        if not line.strip():
            close_list()
            continue

        m = IMG_RE.match(line) or MD_IMG_RE.match(line)
        if m:
            name = Path(m.group(1).strip()).name
            caption = ""
            if i < len(lines):
                cap = CAPTION_RE.match(lines[i].strip())
                if cap:
                    caption = "截图 " + cap.group(1)
                    i += 1
            close_list()
            out.append(_figure_html(name, caption, images))
            continue

        m = re.match(r"^(#{1,4})\s+(.*)$", line.strip())
        if m:
            close_list()
            lvl = min(3, len(m.group(1)) + 1)
            out.append(f"<h{lvl}>{_inline(m.group(2))}</h{lvl}>")
            continue

        m = re.match(r"^[-*+]\s+(.*)$", line.strip())
        if m:
            if list_open != "ul":
                close_list()
                out.append("<ul>")
                list_open = "ul"
            item = re.sub(r"^\[[ xX]\]\s*", "", m.group(1))
            out.append(f"<li>{_inline(item)}</li>")
            continue

        m = re.match(r"^\d+[.)、]\s*(.*)$", line.strip())
        if m:
            if list_open != "ol":
                close_list()
                out.append("<ol>")
                list_open = "ol"
            out.append(f"<li>{_inline(m.group(1))}</li>")
            continue

        close_list()
        out.append(f"<p>{_inline(line.strip())}</p>")

    close_list()
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
            "--virtual-time-budget=6000", src.as_uri(),
        ]
        res = subprocess.run(cmd, capture_output=True, timeout=180)
        if not out_pdf.exists():
            raise RuntimeError("PDF 生成失败：" + res.stderr.decode("utf-8", "ignore")[:200])


# ---------------------------------------------------------------- docx

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOC_RELS_HEAD = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"""

DOC_RELS_ITEM = ('<Relationship Id="rId{rid}" '
                 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
                 'Target="media/{name}"/>')

W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
WP_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
PIC_NS = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

EMU_PER_CM = 360000
CONTENT_WIDTH_CM = 16.0


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
    return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{safe}</w:t></w:r></w:p>'


def _image_para(rid: int, pic_id: int, width: int, height: int) -> str:
    """把像素尺寸换算成 EMU，并按页面内容宽度等比缩放"""
    px_w = max(1, int(width)) * 9525          # 96 DPI: 1px = 9525 EMU
    px_h = max(1, int(height)) * 9525
    max_w = int(CONTENT_WIDTH_CM * EMU_PER_CM)
    scale = min(1.0, max_w / px_w)
    cx, cy = int(px_w * scale), int(px_h * scale)
    return (
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>'
        f'<wp:inline distT="0" distB="0" distL="0" distR="0" {WP_NS}>'
        f'<wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{pic_id}" name="Picture {pic_id}"/>'
        f'<a:graphic {A_NS}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<pic:pic {PIC_NS}><pic:nvPicPr><pic:cNvPr id="{pic_id}" name="img{pic_id}"/><pic:cNvPicPr/></pic:nvPicPr>'
        f'<pic:blipFill><a:blip r:embed="rId{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    )


def md_to_docx(md: str, title: str, out: Path, images: dict | None = None) -> None:
    images = images or {}
    body = [_para(title, bold=True, size=36),
            _para("由「课堂转写」生成 · " + datetime.now().strftime("%Y-%m-%d %H:%M"))]
    rels = []
    media = {}
    next_rid = 10
    pic_id = 100
    used = {}

    def add_image(name: str) -> str:
        nonlocal next_rid, pic_id
        item = images.get(name)
        if not item:
            return _para("（截图缺失：" + name + "）")
        if name in used:
            rid = used[name]
        else:
            data, _mime = item
            rid = next_rid
            next_rid += 1
            ext = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpg"
            fname = f"image{rid}.{ext}"
            media[fname] = data
            rels.append(DOC_RELS_ITEM.format(rid=rid, name=fname))
            used[name] = rid
        w, h = image_size(images[name][0])
        pic_id += 1
        return _image_para(used[name], pic_id, w, h)

    lines = md.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line:
            continue
        m = IMG_RE.match(line) or MD_IMG_RE.match(line)
        if m:
            body.append(add_image(Path(m.group(1).strip()).name))
            if i < len(lines):
                cap = CAPTION_RE.match(lines[i].strip())
                if cap:
                    body.append(_para("截图 " + cap.group(1), size=18))
                    i += 1
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
        f'<w:document {W_NS} {R_NS}>'
        "<w:body>" + "".join(body) +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'
    )
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", ROOT_RELS)
        z.writestr("word/document.xml", doc)
        if rels:
            z.writestr("word/_rels/document.xml.rels", DOC_RELS_HEAD + "".join(rels) + "</Relationships>")
        for name, data in media.items():
            z.writestr("word/media/" + name, data)
