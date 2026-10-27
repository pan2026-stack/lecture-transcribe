#!/usr/bin/env python3
"""把一份转写稿 Markdown 整理成「完整讲稿 + 结构化笔记」。

用法：
    python cli.py sessions/20261024-1430-课堂.md
    python cli.py 转写稿.md --title "法理学 第五讲" --duration 01:42:00

转写稿格式：每行 `[mm:ss] 句子`，可有可无 `↳ 译文` 行。
输出：两份 markdown 的路径（同时落进 config.json 里的 obsidian_inbox）。
"""
import argparse
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import server  # noqa: E402


def parse_transcript(path: pathlib.Path) -> list[dict]:
    segments = []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+?)\s*$", line)
        if m:
            segments.append({"time": m.group(1), "text": m.group(2)})
    return segments


def main() -> int:
    ap = argparse.ArgumentParser(description="把转写稿整理成讲稿和笔记")
    ap.add_argument("file", help="转写稿 markdown 路径")
    ap.add_argument("--title", default="", help="课程标题，默认用文件名")
    ap.add_argument("--duration", default="", help="时长，例如 01:42:00")
    args = ap.parse_args()

    path = pathlib.Path(args.file)
    if not path.is_file():
        print(f"找不到文件：{path}", file=sys.stderr)
        return 2

    segments = parse_transcript(path)
    if not segments:
        print("没有解析到 `[mm:ss] 句子` 格式的行。请确认这是转写稿。", file=sys.stderr)
        return 3

    title = args.title or path.stem
    print(f"共 {len(segments)} 段，开始整理：{title}")

    try:
        out = server.generate_notes(
            {"title": title, "duration": args.duration, "segments": segments}
        )
    except Exception as exc:  # noqa: BLE001 - 直接展示给用户
        print(f"整理失败：{exc}", file=sys.stderr)
        return 1

    print("完整讲稿：", out.get("article_path") or "(未返回)")
    print("结构化笔记：", out.get("notes_path") or "(未返回)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
