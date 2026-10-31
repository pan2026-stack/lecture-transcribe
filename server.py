#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""课堂实时转写 —— 本地服务端（纯标准库，无需 pip 安装任何东西）

职责：
  1. 托管静态页面（麦克风采集 + 实时字幕 UI）
  2. 代理转发音频片段到「OpenAI 兼容」的语音识别接口，API Key 只留在本机
  3. 把转写结果落盘为 markdown，方便随后让 AI 整理成课堂笔记

启动：python server.py [--port 8787]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import ssl
import sys
import logging
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 打包成 exe 后：静态文件在临时解包目录，配置和会话要留在 exe 旁边
if getattr(sys, "frozen", False):
    BASE = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))   # 只读资源
    DATA = Path(sys.executable).resolve().parent                          # 可写数据
else:
    BASE = Path(__file__).resolve().parent
    DATA = BASE
LOGS = BASE / "logs"
LOG = logging.getLogger("lecture")

CONFIG_PATH = DATA / "config.json"
SESSIONS = DATA / "sessions"
AUDIO_DIR = SESSIONS / "_audio"

# 构建戳：改完文件重启服务，页脚会显示时间，用来判断页面是不是最新的
def _read_version() -> str:
    """版本号只维护 VERSION 一个文件"""
    head = BASE / "VERSION"
    try:
        if head.is_file():
            return head.read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        pass
    return "0.0.0"


APP_VERSION = _read_version()

def build_stamp() -> str:
    """页脚显示的构建时间：跟着文件改动实时变，用来判断页面是不是最新的"""
    files = [BASE / "app.js", BASE / "style.css", BASE / "index.html"]
    exists = [f.stat().st_mtime for f in files if f.exists()]
    return time.strftime("%m-%d %H:%M:%S", time.localtime(max(exists) if exists else time.time()))

DEFAULT_CONFIG = {
    # 语音识别（OpenAI 兼容 /audio/transcriptions）
    "base_url": "https://api.siliconflow.cn/v1",
    "model": "XingChenAGI/XingChenASR-V3.2-Ultra",
    "api_key": "",
    "language": "zh",
    "segment_seconds": 15,
    "keep_audio": False,   # 默认不保留录音片段，转完就删
    "prompt": "以下是大学课堂的中文讲解，可能中英夹杂，保留专业术语、公式和符号。",
    "request_timeout": 90,
    # 笔记生成（DeepSeek /chat/completions）
    "notes_base_url": "https://api.deepseek.com",
    "notes_model": "deepseek-flash",
    "notes_api_key": "",
    "notes_timeout": 300,
    # 落盘位置：Obsidian 收件箱（留空则存到本目录 sessions/）
    "obsidian_inbox": "",
    # 重新生成时，把知识库里同名旧文件归档到 99-归档（不直接删）
    "archive_old_notes": True,
    # 自动重启默认关闭；显式启用还必须由 DICT_SUPERVISED=1 声明外部守护。
    # 无论旧配置 watchdog_strict 如何，近期有请求或有整理任务时均不退出。
    "watchdog_restart": False,
    "watchdog_strict": False,
    # 课堂截图存哪：相对知识库根目录的文件夹名（留空则存 sessions/shots/）
    "shot_dir": "attachments",
    # 截图在笔记里怎么引用：wiki 用 ![[文件名]]，md 用 ![](attachments/文件名)
    "shot_link_style": "wiki",
    # 出网方式：auto = 先直连，DNS/连接失败自动改走系统代理（推荐）
    #           direct = 只直连；system = 只走系统代理；也可直接写代理地址
    "api_proxy": "auto",
    # 延伸阅读最多给几条；4 是「一屏扫完」的经验值，可改
    "reading_list_max": 4,
}

NOTE_PROMPT = """你是课堂记录整理助手。下面是老师讲课的语音转写稿，来自实时识别，可能存在：口头语、重复、断句错误、同音错字、语序混乱。

请输出两部分，用下面两个分隔行隔开，顺序不能变，分隔行必须原样保留：

<<<ARTICLE>>>
（第一部分：整理后的完整讲稿）
<<<NOTES>>>
（第二部分：结构化笔记）

【第一部分 · 完整讲稿】
- 去掉「嗯、啊、那个、就是说、然后呢、对吧、这个这个」之类的语气词、口吃和无效重复。
- 老师讲到一半回头补充、前后重复说明的同一件事，要合并到一起，按逻辑顺序重排，不要保留现场的来回跳跃。
- 改成通顺的书面语，但**保留老师自己的讲法、举的例子和强调方式**，不要改写成教科书腔。
- 不添加转写稿里没有的内容；听不清或明显残缺处标注 `[不清楚]`。
- 合理分段，可用 `## 一、xxx` 这样的小标题，篇幅要和讲课内容量相当，不要压缩成提纲。

【第二部分 · 结构化笔记】
1. 最开头写 4 行元信息，格式固定：
   `- 主题：xxx`
   `- 主讲：xxx（听不出就写 老师）`
   `- 时长：xxx`
   `- 章节：N 段`

2. `## 摘要`：4–6 句话。必须回答四件事：
   ① 这一节在解决什么问题；② 用的是什么方法或框架；③ 得出什么结论；
   ④ 它和上一节/整门课的关系。不要写「本节介绍了……」这种空话。

3. `## 章节速览`：每行 `- [03:12] 小节标题`，时间必须是转写稿里真实出现的；
   超过一小时的用 `- [1:05:52] 标题` 这种写法。**6–12 条**，标题要具体到能被搜索
   （「论文标题的三条原则」而不是「第一部分」）。

4. 然后按知识逻辑分章节（`## 一、xxx [08:12]`），**不要按时间流水账**。
   每章 4–8 条知识点，每条写成这种卡片：
   `- **概念名**（类型）：是什么 —— 为什么重要或怎么用。`
   - 类型从「理论 / 方法 / 案例 / 对比 / 步骤 / 易错」里选一个，没有就不写括号。
   - **概念名后面要用破折号写清「是什么」，再写「怎么用」**，不要只给一句定义。
   - 老师讲了推导、公式、数字、步骤的，必须原样保留并写完成（不能只写「推导了公式」）。
   - 老师举的例子，单独写成一条 `- **例子**（案例）：xxx`。
   - 有前后因果或流程的，用 `→` 串起来：`先 A → 再 B → 得到 C`。
   - 同一概念有对比（比如 DFS vs BFS），写成一条 `- **A 与 B**（对比）：…`，把差异列清楚。

5. 定义、公式、结论、关键数字用 **加粗**。

6. `## 重点提示`：「会考 / 重点 / 注意 / 记住 / 容易错」的内容汇总在这里，每条一句话。

7. `## 待办`：作业、deadline、要读的材料，每条 `- [ ] xxx`；没有就整节省略。

8. `## 术语`：本节出现的专业词，**8–15 条**，每条 `- **词**：一句话解释`；没有就省略。

9. 结尾 `## 自测题`：6 道题，前 4 道覆盖核心概念，后 2 道是应用题
   （「给定 xxx，你会怎么选/怎么算」）。只出题，不给答案。

10. 不编造；残缺处标 `[不清楚]`。

11. 讲到关键概念时，**就在正文里那个概念后面挂一个链接**，不要另起「延伸阅读」小节：
   - 写法：`**红黑树**（[维基百科](https://zh.wikipedia.org/wiki/红黑树)）`，或紧跟在词后 `[CLRS 第 13 章](https://…)`
   - 同一个概念只在**第一次出现**处挂，后文再提不重复挂
   - 全篇最多 __MAX_READS__ 个内联链接，宁少勿多，只挂真正值得深入的概念
   - 只挂确定存在的来源：官方文档、标准/规范、维基、出版社作者页、RFC、项目主页
   - 拿不准网址的，只写《书名》· 作者，不加链接；**绝不编造 URL**
   - 链接文字要短（2–6 个字），不要出现裸网址

只输出这两部分内容，不要开场白和总结语。"""


def split_parts(text: str) -> tuple[str, str]:
    """拆出（完整讲稿, 结构化笔记）；模型没按格式输出时兜底"""
    raw = text.strip()
    # 去掉模型可能加的代码块围栏
    raw = re.sub(r"\A```[a-zA-Z]*\s*", "", raw)
    raw = re.sub(r"\s*```\Z", "", raw).strip()

    article, notes = "", raw
    if "<<<ARTICLE>>>" in raw:
        rest = raw.split("<<<ARTICLE>>>", 1)[1]
        if "<<<NOTES>>>" in rest:
            article, notes = rest.split("<<<NOTES>>>", 1)
        else:
            article, notes = rest, ""
    elif "<<<NOTES>>>" in raw:
        article, notes = raw.split("<<<NOTES>>>", 1)

    def tidy(s: str) -> str:
        s = s.strip()
        s = re.sub(r"\A```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```\Z", "", s)
        # 模型偶尔会把分隔符再抄一遍，清掉残留
        s = s.replace("<<<ARTICLE>>>", "").replace("<<<NOTES>>>", "")
        return s.strip()

    return tidy(article), tidy(notes)


# ---------------------------------------------------------------- 配置

def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception as exc:  # 配置坏了也要能启动
            print(f"[warn] config.json 解析失败，使用默认值: {exc}", file=sys.stderr)
    return cfg


def save_config(data: dict) -> dict:
    cfg = load_config()
    # 这些字段留空表示「不修改」：前端万一没加载完就保存，也不会把配置清空
    MUST_HAVE = {
        "base_url", "model", "notes_base_url", "notes_model", "obsidian_inbox",
    }
    for key in (
        "base_url", "model", "api_key", "language", "prompt",
        "notes_base_url", "notes_model", "notes_api_key", "obsidian_inbox",
    ):
        if key in data and isinstance(data[key], str):
            val = data[key].strip()
            if not val and key in MUST_HAVE:
                continue
            cfg[key] = val
    if "segment_seconds" in data:
        try:
            cfg["segment_seconds"] = max(2, min(30, int(data["segment_seconds"])))
        except (TypeError, ValueError):
            pass
    CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return cfg


def public_config(cfg: dict) -> dict:
    key = cfg.get("api_key") or ""
    nkey = cfg.get("notes_api_key") or ""
    return {
        "base_url": cfg["base_url"],
        "model": cfg["model"],
        "language": cfg["language"],
        "segment_seconds": cfg["segment_seconds"],
        "prompt": cfg.get("prompt", ""),
        "has_key": bool(key),
        "key_hint": f"****{key[-4:]}" if len(key) >= 8 else ("已设置" if key else ""),
        "notes_base_url": cfg.get("notes_base_url", ""),
        "notes_model": cfg.get("notes_model", ""),
        "has_notes_key": bool(nkey),
        "notes_key_hint": f"****{nkey[-4:]}" if len(nkey) >= 8 else ("已设置" if nkey else ""),
        "obsidian_inbox": cfg.get("obsidian_inbox", ""),
        "keep_audio": bool(cfg.get("keep_audio")),
        "obsidian_ok": Path(cfg.get("obsidian_inbox") or ".").is_dir() if cfg.get("obsidian_inbox") else False,
        "version": _read_version(),   # 每次现读，改了 VERSION 不用重启
        "build": build_stamp(),
    }


# ---------------------------------------------------------------- 转写

def _multipart(fields: dict, files: dict) -> tuple[bytes, str]:
    boundary = "----lecture" + uuid.uuid4().hex
    out = bytearray()
    for name, value in fields.items():
        if value in (None, ""):
            continue
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        out += str(value).encode("utf-8") + b"\r\n"
    for name, (filename, ctype, blob) in files.items():
        out += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'
        ).encode()
        out += blob + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def _pick_text(payload) -> str:
    """兼容各家返回结构：{"text"} / {"result":{"text"}} / {"output":{"text"}} / 纯文本"""
    if isinstance(payload, str):
        return payload.strip()
    if not isinstance(payload, dict):
        return ""
    for key in ("text", "transcription", "transcript"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    for key in ("result", "output", "data", "response"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, dict):
            got = _pick_text(val)
            if got:
                return got
        if isinstance(val, list):
            parts = [_pick_text(x) for x in val]
            merged = "".join(p for p in parts if p)
            if merged:
                return merged
    return ""


# ---------------------------------------------------------------- 声纹
# 每段音频在识别时顺带算一个说话人向量，存内存；课后统一聚类
SPK_STORE: dict[str, dict[int, list[float]]] = {}
SPK_LOCK = threading.Lock()


def speaker_vec(wav: bytes) -> list[float]:
    """算声纹向量；环境不支持就返回空，不影响主流程"""
    try:
        import speaker as spk  # noqa: WPS433
        if not spk.MODEL.exists():
            return []
        return spk.embedding(wav)
    except Exception:
        return []


def remember_speaker(session_id: str, seq: int, wav: bytes) -> None:
    if not session_id:
        return
    vec = speaker_vec(wav)
    if not vec:
        return
    with SPK_LOCK:
        SPK_STORE.setdefault(session_id, {})[int(seq)] = vec


def export_doc(md_path: str, fmt: str) -> tuple[bytes, str, str]:
    """把一篇 markdown 导出成 html / pdf / docx，返回 (内容, 文件名, MIME)"""
    import export as ex  # noqa: WPS433

    src = Path(md_path)
    if not src.is_file():
        raise RuntimeError("找不到文件：" + src.name)
    if src.suffix.lower() != ".md":
        raise RuntimeError("只能导出 markdown")
    # 只允许导出会话目录或知识库里的文件，别把整块磁盘当读取器
    roots = [SESSIONS.resolve()]
    vault = _vault_root()
    if vault:
        roots.append(vault.resolve())
    resolved = src.resolve()
    if not any(resolved == r or resolved.is_relative_to(r) for r in roots):
        raise RuntimeError("只能导出会话目录或知识库里的文件")

    md = src.read_text(encoding="utf-8")
    title = (re.search(r"^#\s+(.+)$", md, re.M) or [None, src.stem])[1]
    title = re.sub(r'[\\/:*?"<>|]', "-", title.strip()) or src.stem

    def _images() -> dict:
        """把 markdown 里引用到的截图读出来，交给导出模块内嵌"""
        found = {}
        for name in ex.shot_names(md):
            path = shot_file(name)
            if not path:
                continue
            ext = path.suffix.lstrip(".").lower()
            mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
                    "png": "image/png", "webp": "image/webp", "gif": "image/gif"}.get(ext, "image/jpeg")
            try:
                found[name] = (path.read_bytes(), mime)
            except OSError:
                continue
        return found

    images = _images()

    if fmt == "html":
        html = ex.md_to_html(md, title, images)
        return html.encode("utf-8"), f"{title}.html", "text/html; charset=utf-8"

    if fmt == "pdf":
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.pdf"
            ex.html_to_pdf(ex.md_to_html(md, title, images), out)
            return out.read_bytes(), f"{title}.pdf", "application/pdf"

    if fmt == "docx":
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.docx"
            ex.md_to_docx(md, title, out, images)
            return out.read_bytes(), f"{title}.docx", (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            )

    raise RuntimeError("不支持的格式：" + fmt)


def diarize(session_id: str) -> dict:
    """把这一节存下来的向量聚成说话人，返回 {seq: 编号}"""
    with SPK_LOCK:
        vecs = dict(SPK_STORE.get(session_id) or {})
    if len(vecs) < 3:
        return {"labels": {}, "count": 0}
    import speaker as spk  # noqa: WPS433
    seqs = sorted(vecs)
    labels = spk.cluster([vecs[k] for k in seqs])
    return {"labels": {str(k): n for k, n in zip(seqs, labels)}, "count": len(set(labels))}


def _net_error_text(what: str, url: str, exc: Exception) -> str:
    """把网络错误翻译成人能看懂的一句话"""
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, socket.gaierror):
        return (f"{what}的域名解析失败（{reason}）。通常是切换代理/VPN 后系统 DNS 变了，"
                f"重启一下本程序即可；如果一直这样，检查网络或关闭代理再试。")
    text = str(reason)
    if "UNEXPECTED_EOF" in text or "SSL" in text:
        return (f"{what}的 TLS 连接被中断（{text[:60]}）。常见于代理节点不稳定，"
                f"换节点或关掉代理后重试。")
    return f"连不上{what}（{url}）：{text[:80]}"


def transcribe(wav: bytes, language: str) -> str:
    cfg = load_config()
    key = cfg.get("api_key") or ""
    if not key:
        raise RuntimeError("尚未配置 API Key：请点右上角「设置」填入后保存。")
    url = cfg["base_url"].rstrip("/") + "/audio/transcriptions"
    body, ctype = _multipart(
        {
            "model": cfg["model"],
            "language": language or cfg.get("language") or "zh",
            "response_format": "json",
            "prompt": cfg.get("prompt") or "",
        },
        {"file": ("segment.wav", "audio/wav", wav)},
    )
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": ctype,
            "Accept": "application/json",
        },
    )
    # DNS 在代理/VPN 切换的瞬间常会失败一两秒，这里给它三次机会再报错
    last_err = None
    for attempt in range(3):
        try:
            with api_request(req, timeout=int(cfg.get("request_timeout", 90))) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                ctype_resp = resp.headers.get("Content-Type", "")
            last_err = None
            break
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"识别接口返回 HTTP {exc.code}：{detail}") from None
        except urllib.error.URLError as exc:
            last_err = exc
            if isinstance(getattr(exc, "reason", None), socket.gaierror) and attempt < 2:
                time.sleep(1.0)
                continue
            raise RuntimeError(_net_error_text("识别接口", url, exc)) from None
        except TimeoutError:
            raise RuntimeError("识别接口超时，网络不稳或音频片段过长。") from None
    if last_err is not None:
        raise RuntimeError(_net_error_text("识别接口", url, last_err)) from None

    if "json" in ctype_resp.lower() or raw.lstrip().startswith(("{", "[")):
        try:
            return _pick_text(json.loads(raw))
        except json.JSONDecodeError:
            pass
    return raw.strip()


TRANSLATE_PROMPTS = {
    "zh2en": (
        "你是专业的课堂口译。把下面的中文讲解翻译成自然的英文。"
        "保留技术术语、数学符号和公式，专有名词用通行译法；"
        "不要解释、不要加引号或前缀，只输出译文本身。"
    ),
    "en2zh": (
        "你是专业的课堂口译。把下面的英文讲解翻译成通顺的中文。"
        "保留技术术语、数学符号和公式，专有名词用通行译法；"
        "不要解释、不要加引号或前缀，只输出译文本身。"
    ),
}


def chat_completion(system: str, user: str, temperature: float = 0.2) -> str:
    """调 DeepSeek /chat/completions，返回正文"""
    cfg = load_config()
    key = cfg.get("notes_api_key") or ""
    if not key:
        raise RuntimeError("尚未配置 DeepSeek API Key：请在「设置 → 笔记整理」里填入。")

    url = (cfg.get("notes_base_url") or "https://api.deepseek.com").rstrip("/") + "/chat/completions"
    body = json.dumps(
        {
            "model": cfg.get("notes_model") or "deepseek-flash",
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "temperature": temperature,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with api_request(req, timeout=int(cfg.get("notes_timeout", 300))) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"翻译接口返回 HTTP {exc.code}：{detail}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"连不上 {url}：{exc.reason}") from None
    except TimeoutError:
        raise RuntimeError("翻译超时。") from None
    except json.JSONDecodeError:
        raise RuntimeError("返回的不是合法 JSON。") from None

    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError):
        raise RuntimeError("返回结构异常。") from None


def translate_text(text: str, direction: str) -> str:
    text = (text or "").strip()
    if not text:
        return ""
    prompt = TRANSLATE_PROMPTS.get(direction)
    if not prompt:
        raise RuntimeError(f"未知翻译方向：{direction}")
    out = chat_completion(prompt, text, temperature=0.2)
    # 去掉模型偶尔加的引号
    if len(out) >= 2 and out[0] in '"“「' and out[-1] in '"”」':
        out = out[1:-1].strip()
    return out


# ---------------------------------------------------------------- 笔记生成

def _safe_name(s: str) -> str:
    return "".join(c for c in s if c not in '\\/:*?"<>|').strip()


def _unique(path: Path) -> Path:
    """知识库硬性规则：不覆盖已有笔记"""
    if not path.exists():
        return path
    for i in range(2, 100):
        cand = path.with_name(f"{path.stem}-{i}{path.suffix}")
        if not cand.exists():
            return cand
    return path.with_name(f"{path.stem}-{uuid.uuid4().hex[:6]}{path.suffix}")


def _purge_old_sessions(label: str, title: str, keep_name: str) -> None:
    """sessions 里的文件名是「时间戳-标题-label.md」，和知识库的 glob 不一样"""
    safe = _safe_name(title) or "课堂记录"
    for f in SESSIONS.glob(f"*-{safe}-{label}.md"):
        if f.name == keep_name:
            continue
        try:
            f.unlink()
        except OSError:
            pass


def _purge_old_notes(target_dir: Path, label: str, title: str, keep: Path | None = None) -> list[str]:
    """同一标题重新生成时，删掉旧的同名文件，只留最新一份"""
    safe = _safe_name(title) or "课堂记录"
    removed = []
    for f in sorted(target_dir.glob(f"{label}-{safe}-*.md")):
        if keep is not None and f.resolve() == keep.resolve():
            continue
        try:
            f.unlink()
            removed.append(f.name)
        except OSError:
            pass
    if removed:
        print(f"[notes] 覆盖旧文件 {len(removed)} 个：{', '.join(removed[:3])}")
    return removed


def _archive_old_notes(cfg: dict, label: str, title: str, keep: Path) -> list[str]:
    """生成新文件后，把知识库里同名旧文件挪到 99-归档/YYYY-MM，不直接删"""
    if not cfg.get("archive_old_notes", True):
        return []
    inbox = (cfg.get("obsidian_inbox") or "").strip()
    if not inbox:
        return []
    vault = Path(inbox).parent
    if not vault.is_dir():
        return []

    safe = _safe_name(title) or "课堂记录"
    pattern = f"{label}-{safe}-*.md"
    archive_root = vault / "99-归档" / time.strftime("%Y-%m")
    moved = []
    for f in vault.rglob(pattern):
        if not f.is_file():
            continue
        if f.resolve() == keep.resolve():
            continue
        if "99-归档" in f.parts:
            continue
        try:
            archive_root.mkdir(parents=True, exist_ok=True)
            dest = _unique(archive_root / f.name)
            shutil.move(str(f), str(dest))
            moved.append(str(f.relative_to(vault)))
        except OSError as exc:
            print(f"[warn] 归档旧文件失败 {f}: {exc}")
    if moved:
        print(f"[notes] 归档同名旧文件 {len(moved)} 个 -> 99-归档/{time.strftime('%Y-%m')}")
    return moved


def _shot_dir() -> Path:
    """截图目录：优先放知识库，没有知识库就放 sessions/shots"""
    cfg = load_config()
    name = (cfg.get("shot_dir") or "").strip()
    vault = _vault_root()
    if vault and name:
        target = vault / name
    else:
        target = SESSIONS / "shots"
    target.mkdir(parents=True, exist_ok=True)
    return target


def save_shot(data: bytes, sec: float, title: str = "", ext: str = "jpg") -> dict:
    """把浏览器传来的一帧存成图片，文件名带时间戳"""
    if not data:
        raise ValueError("截图内容为空")
    if len(data) > 12 * 1024 * 1024:
        raise ValueError("截图太大（超过 12MB）")
    ext = (ext or "jpg").lower().lstrip(".")
    if ext not in ("jpg", "jpeg", "png", "webp"):
        ext = "jpg"
    if ext in ("jpg", "jpeg") and not data.startswith(b"\xff\xd8"):
        raise ValueError("这不像一张 JPEG 图片")
    if ext == "png" and not data.startswith(b"\x89PNG"):
        raise ValueError("这不像一张 PNG 图片")
    folder = _shot_dir()
    stamp = time.strftime("%Y-%m-%d-%H%M%S")
    total = max(0, int(sec))
    # 同一秒可能连拍两张，加个短随机后缀，别互相覆盖
    suffix = os.urandom(3).hex()
    name = f"课堂截图-{stamp}-{total // 60:02d}m{total % 60:02d}s-{suffix}.{ext}"
    path = _unique(folder / name)
    path.write_bytes(data)

    vault = _vault_root()
    rel = ""
    if vault:
        try:
            rel = str(path.relative_to(vault)).replace("\\", "/")
        except ValueError:
            rel = path.name
    return {"name": name, "path": str(path), "rel": rel, "sec": round(float(sec), 1)}


def shot_file(name: str) -> Path | None:
    """按文件名取截图，禁止目录穿越"""
    safe = os.path.basename(name or "")
    if not safe or safe != name:
        return None
    for folder in (_shot_dir(), SESSIONS / "shots"):
        candidate = folder / safe
        if candidate.is_file():
            return candidate
    return None


def _mmss(sec: float) -> str:
    total = max(0, int(sec))
    if total >= 3600:
        return f"{total // 3600}:{total % 3600 // 60:02d}:{total % 60:02d}"
    return f"{total // 60:02d}:{total % 60:02d}"


def insert_shots(markdown: str, shots: list) -> str:
    """把截图按时间插到对应章节末尾；没有章节就用文末附录"""
    if not shots:
        return markdown
    cfg = load_config()
    style = str(cfg.get("shot_link_style") or "wiki").strip().lower()
    prefix = "/" + str(cfg.get("shot_dir") or "attachments").strip("/")
    items = []
    skipped = []
    for raw in shots:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        if not shot_file(name):
            skipped.append(name)      # 文件被删了，别往笔记里塞死链
            continue
        try:
            sec = float(raw.get("sec") or 0)
        except (TypeError, ValueError):
            sec = 0.0
        items.append((sec, name))
    if skipped:
        _log(f"[shots] 跳过 {len(skipped)} 张找不到的截图：{', '.join(skipped[:3])}")
    if not items:
        return markdown
    items.sort()

    def block(sec: float, name: str) -> str:
        link = f"![[{name}]]" if style == "wiki" else f"![]({prefix}/{name})"
        return f"{link}\n> 截图 {_mmss(sec)}\n"

    lines = markdown.split("\n")
    heads = []  # (行号, 章节起始秒或 None)
    for idx, line in enumerate(lines):
        if line.startswith("## "):
            # 标题里可能带后缀（[02:00]（重点）），取最后一个时间而不是要求行尾
            hit = list(re.finditer(r"\[(\d{1,3}:\d{2}(?::\d{2})?)\]", line))[-1:] or [None]
            hit = hit[0]
            if hit:
                parts = [int(x) for x in hit.group(1).split(":")]
                sec = parts[0] * 60 + parts[1] if len(parts) == 2 else parts[0] * 3600 + parts[1] * 60 + parts[2]
                heads.append((idx, sec))
            else:
                heads.append((idx, None))

    # 没有带时间的章节：整段挂到文末
    if not any(sec is not None for _, sec in heads):
        tail = "\n\n## 课堂截图\n\n"
        tail += "\n".join(block(sec, name) for sec, name in items)
        return markdown.rstrip() + "\n" + tail

    # 给每张图找归属章节
    groups = {}
    early = []
    for sec, name in items:
        # 章节可能按知识逻辑排序（时间不单调），所以要看全部标题取「≤sec 且时间最大」的那个
        target = None
        best = None
        for idx, head_sec in heads:
            if head_sec is None or head_sec > sec:
                continue
            if best is None or head_sec > best:
                best = head_sec
                target = idx
        if target is None:
            early.append((sec, name))      # 比第一个带时间章节还早，统一进文末附录
            continue
        groups.setdefault(target, []).append((sec, name))

    # 从后往前插，避免行号错位
    for target in sorted(groups, reverse=True):
        end = len(lines)
        for idx in range(target + 1, len(lines)):
            if lines[idx].startswith("## "):
                end = idx
                break
        insert_at = end
        while insert_at > target + 1 and not lines[insert_at - 1].strip():
            insert_at -= 1
        block_text = "\n" + "\n".join(block(sec, name) for sec, name in sorted(groups[target]))
        lines.insert(insert_at, block_text)

    text = "\n".join(lines)
    if early:
        text = text.rstrip() + "\n\n## 课堂截图\n\n" + "\n".join(
            block(sec, name) for sec, name in sorted(early))
    return text


def shots_sidecar(transcript_path: str | Path) -> Path:
    path = Path(transcript_path)
    return path.with_suffix(".shots.json")


def save_shots_sidecar(transcript_path: str | Path, shots: list) -> None:
    """把这一节的截图清单存成旁挂文件，重新整理时还能把图插回去"""
    try:
        path = shots_sidecar(transcript_path)
        clean = [{"sec": float(x.get("sec") or 0), "name": str(x.get("name") or "")}
                 for x in shots if isinstance(x, dict) and x.get("name")]
        if clean:
            path.write_text(json.dumps(clean, ensure_ascii=False), encoding="utf-8")
        elif path.exists():
            path.unlink()          # 这一节没有截图了，别让旧清单在下次重新整理时复活
    except (OSError, TypeError, ValueError):
        pass


def load_shots_sidecar(transcript_path: str | Path) -> list:
    try:
        path = shots_sidecar(transcript_path)
        if not path.is_file():
            return []
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def write_note_file(
    title: str,
    markdown: str,
    cfg: dict,
    label: str = "课堂笔记",
    kind: str = "笔记",
    tags: tuple[str, ...] = ("待分类", "课堂笔记"),
    banner: str = "",
) -> tuple[Path, str]:
    """按知识库约定写文件：优先进 Obsidian 收件箱，失败退回本目录 sessions/"""
    stamp_date = time.strftime("%Y-%m-%d")
    stamp_time = time.strftime("%H:%M")
    tag_lines = "".join(f"  - {t}\n" for t in tags)
    body = (
        "---\n"
        f"created: {stamp_date} {stamp_time}\n"
        f"updated: {stamp_date} {stamp_time}\n"
        "tags:\n"
        f"{tag_lines}"
        "source: 课堂实时转写\n"
        f"kind: {kind}\n"
        "status: 待整理\n"
        "---\n\n"
        f"# {title}\n\n"
        f"{banner}"
        f"{markdown.strip()}\n"
    )
    stem = f"{label}-{_safe_name(title) or '课堂记录'}-{stamp_date}-{stamp_time.replace(':', '')}"

    inbox = (cfg.get("obsidian_inbox") or "").strip()
    if inbox:
        target_dir = Path(inbox)
        try:
            if not target_dir.is_dir():
                raise FileNotFoundError(f"目录不存在：{target_dir}")
            path = target_dir / f"{stem}.md"
            tmp = path.with_suffix(".md.part")
            try:
                tmp.write_text(body, encoding="utf-8")
                os.replace(tmp, path)          # 先落盘成功，再清旧文件，避免写失败把旧笔记删了
            finally:
                if tmp.exists():
                    try:
                        tmp.unlink()
                    except OSError:
                        pass
            _purge_old_notes(target_dir, label, title, keep=path)
            _archive_old_notes(cfg, label, title, path)
            return path, "obsidian"
        except OSError as exc:
            print(f"[warn] 写入 Obsidian 收件箱失败（{exc}），改存 sessions/", file=sys.stderr)

    SESSIONS.mkdir(parents=True, exist_ok=True)
    name = f"{time.strftime('%Y%m%d-%H%M%S')}-{_safe_name(title)[:40] or '课堂记录'}-{label}.md"
    path = SESSIONS / name
    tmp = path.with_suffix(".md.part")
    try:
        tmp.write_text(body, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    _purge_old_sessions(label, title, keep_name=name)
    return path, "sessions"


# 生成笔记的实时进度（job id -> 进度），供前端轮询
NOTES_PROGRESS: dict[str, dict] = {}
NOTES_LOCK = threading.RLock()
NOTES_TASKS: dict[str, dict] = {}
ACTIVE_NOTES = 0


def notes_task_status(job: str) -> dict:
    with NOTES_LOCK:
        task = NOTES_TASKS.get(job)
        if task is None:
            return dict(NOTES_PROGRESS.get(job) or {"stage": "unknown"})
        if task["stage"] in ("done", "error"):
            return {k: v for k, v in task.items() if k != "fingerprint"}
        progress = dict(NOTES_PROGRESS.get(job) or {"stage": "start", "text": "正在准备"})
        if progress.get("stage") in ("done", "error"):
            progress["stage"] = "save"  # worker has not published its result yet
        return progress


def submit_notes(payload: dict) -> dict:
    job = str(payload.get("job") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job):
        raise ValueError("后台整理需要有效的 job 编号")
    fingerprint = hashlib.sha256(json.dumps(
        {k: v for k, v in payload.items() if k != "background"},
        sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    with NOTES_LOCK:
        now = time.time()
        for old in list(NOTES_TASKS):
            task = NOTES_TASKS[old]
            if task["stage"] in ("done", "error") and now - task["at"] > 86400:
                del NOTES_TASKS[old]
        existing = NOTES_TASKS.get(job)
        if existing:
            if existing["fingerprint"] != fingerprint:
                raise ValueError("同一 job 编号不能用于不同的转写内容")
            return {"job": job, "accepted": True}
        if sum(t["stage"] not in ("done", "error") for t in NOTES_TASKS.values()) >= 4:
            raise RuntimeError("正在整理的任务过多，请稍后再试")
        NOTES_TASKS[job] = {"stage": "start", "at": now, "fingerprint": fingerprint}

    def work():
        try:
            result = generate_notes(payload)
            state = {"stage": "done", "result": result}
        except Exception as exc:
            state = {"stage": "error", "error": str(exc), "text": str(exc)}
        with NOTES_LOCK:
            NOTES_TASKS[job].update(state, at=time.time())

    try:
        threading.Thread(target=work, name="notes-" + job, daemon=True).start()
    except Exception:
        with NOTES_LOCK:
            NOTES_TASKS.pop(job, None)
        raise
    return {"job": job, "accepted": True}



def _progress(job: str, **kw) -> None:
    if not job:
        return
    with NOTES_LOCK:
        cur = dict(NOTES_PROGRESS.get(job) or {})
        cur.update(kw)
        cur["at"] = time.time()
        NOTES_PROGRESS[job] = cur
        # Never expire an active long lecture while another task reports progress.
        now = time.time()
        for k in list(NOTES_PROGRESS):
            v = NOTES_PROGRESS[k]
            if v.get("stage") in ("done", "error") and now - v.get("at", now) > 86400:
                NOTES_PROGRESS.pop(k, None)


LOG_PATH = LOGS / "server.log"


def _log(msg: str) -> None:
    """写文件日志：pythonw 没有控制台，崩溃和看门狗决策只能落盘"""
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    try:
        LOGS.mkdir(parents=True, exist_ok=True)
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 2 * 1024 * 1024:
            LOG_PATH.replace(LOG_PATH.with_suffix(".log.1"))
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    try:
        if sys.stdout:
            print(line)
            sys.stdout.flush()
    except Exception:
        pass


CLIENT_LOG = LOGS / "client.log"


_SSL_CTX = ssl.create_default_context()
_OPENERS: dict[bool, urllib.request.OpenerDirector] = {}
_GOOD_MODE = None          # 上次成功的通道：direct / proxy


def _api_opener(use_proxy: bool) -> urllib.request.OpenerDirector:
    """直连 / 走系统代理 各准备一个 opener（都带我们的 SSLContext）"""
    opener = _OPENERS.get(use_proxy)
    if opener is None:
        handler = urllib.request.ProxyHandler() if use_proxy else urllib.request.ProxyHandler({})
        opener = urllib.request.build_opener(
            handler, urllib.request.HTTPSHandler(context=_SSL_CTX))
        _OPENERS[use_proxy] = opener
    return opener


def _proxy_mode() -> str:
    return str(load_config().get("api_proxy") or "auto").strip().lower()


_PROXY_ALIVE = {"at": 0.0, "ok": False}


def _win_proxy_settings() -> tuple[bool, str]:
    """读注册表里的系统代理开关与地址（不依赖 urllib 的缓存）"""
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        enable, _ = winreg.QueryValueEx(key, "ProxyEnable")
        server, _ = winreg.QueryValueEx(key, "ProxyServer")
        return bool(enable), str(server or "")
    except OSError:
        return False, ""


def _proxy_alive() -> bool:
    """系统代理是否真的可用：开着 + 端口能连上。结果缓存 5 秒"""
    now = time.time()
    if now - _PROXY_ALIVE["at"] < 5:
        return bool(_PROXY_ALIVE["ok"])
    enable, server = _win_proxy_settings()
    ok = False
    if enable and server:
        host, _, port = server.rpartition(":")
        host = host or "127.0.0.1"
        try:
            sock = socket.create_connection((host, int(port or 0)), timeout=0.6)
            sock.close()
            ok = True
        except (OSError, ValueError):
            ok = False
    _PROXY_ALIVE.update(at=now, ok=ok)
    return ok


def api_request(req: urllib.request.Request, timeout: float = 30):
    """所有出网请求的统一入口。

    auto 模式：先按上次成功的通道试，失败了换另一条。
    典型场景：系统 DNS 被代理切换弄坏时，直连会报 getaddrinfo failed，
    这时自动改走系统代理（代理自己解析域名）就能继续用。
    """
    global _GOOD_MODE
    mode = _proxy_mode()

    if mode in ("", "direct", "none", "off"):
        return _api_opener(False).open(req, timeout=timeout)
    if mode == "system":
        return _api_opener(True).open(req, timeout=timeout)
    if mode != "auto":
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": mode, "https": mode}),
            urllib.request.HTTPSHandler(context=_SSL_CTX))
        return opener.open(req, timeout=timeout)

    if not _proxy_alive():
        # 代理已关或端口已死：别再往它上面撞
        order = (False,)
    elif _GOOD_MODE == "proxy":
        order = (True, False)
    else:
        order = (False, True)
    last_err = None
    for use_proxy in order:
        try:
            resp = _api_opener(use_proxy).open(req, timeout=timeout)
            choice = "proxy" if use_proxy else "direct"
            if _GOOD_MODE != choice:
                _log(f"[net] 改用{'系统代理' if use_proxy else '直连'}")
            _GOOD_MODE = choice
            return resp
        except urllib.error.HTTPError:
            _GOOD_MODE = "proxy" if use_proxy else "direct"
            raise
        except (urllib.error.URLError, OSError) as exc:
            last_err = exc
            continue
    reason = str(last_err) if last_err else "网络不可用"
    if _proxy_alive():
        reason += "（直连和系统代理都试过了）"
    raise RuntimeError(reason) from None


def install_api_opener() -> None:
    """按配置决定 API 请求走直连还是代理。

    浏览器可能开着代理看视频，但 Python 这边的请求没必要跟着走；
    国内接口（DeepSeek / 硅基流动）走系统代理经常 TLS 被断。
    """
    mode = str(load_config().get("api_proxy") or "auto").strip().lower()
    if mode == "auto":
        _log("[net] API 请求：先直连，失败自动走系统代理")
        return
    if mode in ("", "direct", "none", "off"):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        label = "直连（忽略系统代理）"
    elif mode == "system":
        opener = urllib.request.build_opener()
        label = "跟随系统代理 " + str(urllib.request.getproxies().get("https") or "")
    else:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": mode, "https": mode}))
        label = "指定代理 " + mode
    urllib.request.install_opener(opener)
    _log(f"[net] API 请求使用：{label}")


def _proxy_hint() -> str:
    """本机开了系统代理时，失败信息里带上它，省得误判成程序坏了"""
    try:
        proxies = urllib.request.getproxies()
    except Exception:
        return ""
    proxy = proxies.get("https") or proxies.get("http") or ""
    if not proxy or not _proxy_alive():
        return ""
    return (f"（配置项 api_proxy 现在是 system，走系统代理 {proxy}；"
            f"国内接口建议改成 direct 直连）")


def _log_client(payload: dict) -> None:
    """浏览器端异常落盘，方便事后定位（不用再靠用户截图）"""
    try:
        LOGS.mkdir(parents=True, exist_ok=True)
        if CLIENT_LOG.exists() and CLIENT_LOG.stat().st_size > 2 * 1024 * 1024:
            CLIENT_LOG.replace(CLIENT_LOG.with_suffix(".log.1"))
        def clean(value, limit=120):
            text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))
            return text[:limit]

        items = [
            time.strftime("%Y-%m-%d %H:%M:%S"),
            clean(payload.get("kind") or "error", 20),
            "view=" + clean(payload.get("view") or "-", 20),
            "running=" + clean(payload.get("running"), 8),
            "segments=" + clean(payload.get("segments"), 8),
            "serverDown=" + clean(payload.get("serverDown"), 8),
            "msg=" + clean(payload.get("message"), 300),
        ]
        ctx = payload.get("ctx")
        if ctx:
            items.append("ctx=" + str(ctx)[:200].replace("\n", " "))
        line = " | ".join(items)
        stack = str(payload.get("stack") or "")
        with open(CLIENT_LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
            if stack:
                for part in stack.splitlines()[:8]:
                    fh.write("    " + part.strip()[:200] + "\n")
    except OSError:
        pass


def _notes_chat(cfg: dict, messages: list, max_tokens: int) -> tuple[str, str]:
    """调一次 DeepSeek（网络抖动/限流自动重试），返回（内容, finish_reason）"""
    key = cfg.get("notes_api_key") or ""
    url = cfg["notes_base_url"].rstrip("/") + "/chat/completions"
    body = json.dumps(
        {
            "model": cfg.get("notes_model") or "deepseek-flash",
            "messages": messages,
            "stream": False,
            "temperature": 0.3,
            "max_tokens": max_tokens,
        },
        ensure_ascii=False,
    ).encode("utf-8")

    last_err = ""
    # 网络瞬断（VPN 切换、DNS 节点抽风）会报 10061/10054，多给几次机会
    backoff = [3, 6, 10, 15]
    for attempt in range(len(backoff) + 1):
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with api_request(req, timeout=int(cfg.get("notes_timeout", 300))) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
            choice = data["choices"][0]
            return choice["message"]["content"], (choice.get("finish_reason") or "")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            last_err = f"HTTP {exc.code}：{detail}"
            if exc.code in (429, 500, 502, 503, 504) and attempt < len(backoff):
                time.sleep(backoff[attempt])
                continue
            raise RuntimeError(f"DeepSeek 接口返回 {last_err}") from None
        except (urllib.error.URLError, ConnectionResetError, TimeoutError) as exc:
            reason = getattr(exc, "reason", exc)
            last_err = str(reason)
            print(f"[notes] 第 {attempt + 1} 次请求失败：{last_err}")
            if attempt < len(backoff):
                time.sleep(backoff[attempt])
                continue
            raise RuntimeError(
            f"连不上 {url}（已重试 {len(backoff)} 次）：{last_err}。"
            f"{_proxy_hint()}检查网络后重试。") from None
        except json.JSONDecodeError:
            raise RuntimeError("DeepSeek 返回的不是合法 JSON。") from None
        except (KeyError, IndexError, TypeError):
            raise RuntimeError("DeepSeek 返回结构异常。") from None

    raise RuntimeError(f"DeepSeek 请求失败：{last_err}")


def _notes_chat_full(cfg: dict, messages: list, max_tokens: int, rounds: int = 6) -> str:
    """被 max_tokens 截断时自动续写，拼成完整内容"""
    out, msgs = "", list(messages)
    for i in range(rounds):
        content, finish = _notes_chat(cfg, msgs, max_tokens)
        out += content
        if finish != "length":
            return out
        # 截断了：把已写的当 assistant 历史，让它接着写
        msgs = list(messages) + [
            {"role": "assistant", "content": out},
            {"role": "user", "content": "上一条被长度截断了。请紧接断点继续输出剩余内容，不要重复已写过的部分，不要加开场白。"},
        ]
        print(f"[notes] 输出被截断，续写第 {i + 2} 轮")
    return out


# ---------------------------------------------------------------- 看门狗
# 作用：进程还活着但出网通道坏了（10061/10054）时主动退出，让外层守护重启它
WATCHDOG = {"fails": 0, "last_check": 0.0, "last_alive": 0.0, "restarts": 0}
LAST_ACTIVITY = [time.time()]


def _touch():
    """记录最近一次有业务请求的时间；录音/生成期间不重启"""
    LAST_ACTIVITY[0] = time.time()


def _probe_outbound() -> bool:
    """Use the application's HTTPS/proxy route; HTTP errors still prove reachability."""
    cfg = load_config()
    url = os.environ.get("DICT_PROBE_TARGET") or cfg.get("notes_base_url") or "https://api.deepseek.com"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with api_request(req, timeout=6):
            return True
    except urllib.error.HTTPError:
        return True
    except (OSError, ValueError):
        return False


def _watchdog_tick() -> bool:
    """跑一次探针。返回 True 表示应当退出重启。独立成函数便于测试"""
    interval_threshold = int(os.environ.get("DICT_PROBE_FAILS", "3"))
    WATCHDOG["last_check"] = time.time()
    if not _probe_outbound():
        WATCHDOG["fails"] += 1
        _log(f"[watchdog] 出网探测失败，连续 {WATCHDOG['fails']} 次")
    else:
        if WATCHDOG["fails"]:
            _log(f"[watchdog] 出网恢复（之前连续失败 {WATCHDOG['fails']} 次）")
        WATCHDOG["fails"] = 0
        WATCHDOG["last_alive"] = time.time()

    if WATCHDOG["fails"] < interval_threshold:
        return False

    # Remote network failures do not mean this HTTP server is broken. In
    # particular the debug launcher has no supervisor to bring it back.
    if os.environ.get("DICT_SUPERVISED") != "1":
        return False
    with NOTES_LOCK:
        busy = ACTIVE_NOTES or any(t["stage"] not in ("done", "error")
                                  for t in NOTES_TASKS.values()) or any(
            v.get("stage") not in ("done", "error", "unknown")
            for v in NOTES_PROGRESS.values())
    if busy:
        return False
    idle_for = time.time() - LAST_ACTIVITY[0]
    if idle_for < 90:
        return False

    _log(f"[watchdog] 出网连续失败 {WATCHDOG['fails']} 次（空闲 {idle_for:.0f}s），主动退出等待守护重启")
    return True


def _watchdog_loop():
    interval = float(os.environ.get("DICT_PROBE_SECONDS", "45"))
    while True:
        time.sleep(interval)
        try:
            if _watchdog_tick():
                os._exit(9)          # 交给外层守护进程拉起
        except Exception as exc:      # 看门狗自己不能崩
            _log(f"[watchdog] 检查异常：{exc}")


def start_watchdog():
    if not load_config().get("watchdog_restart", False) or os.environ.get("DICT_SUPERVISED") != "1":
        print("[watchdog] 自动重启未启用（需要显式配置且存在外部守护进程）")
        return
    threading.Thread(target=_watchdog_loop, name="watchdog", daemon=True).start()
    print("[watchdog] 已启动：每 45 秒探一次出网，连续 3 次失败且空闲时自动重启")


def generate_notes(payload: dict) -> dict:
    global ACTIVE_NOTES
    with NOTES_LOCK:
        ACTIVE_NOTES += 1
    try:
        return _generate_notes(payload)
    finally:
        with NOTES_LOCK:
            ACTIVE_NOTES -= 1
        _touch()


def _generate_notes(payload: dict) -> dict:
    """把转写稿交给 DeepSeek：产出「整理后的完整讲稿」+「结构化笔记」两份文件"""
    cfg = load_config()
    job = str(payload.get("job") or "")
    if not (cfg.get("notes_api_key") or ""):
        _progress(job, stage="error", text="没配 DeepSeek KEY")
        raise RuntimeError("尚未配置 DeepSeek API Key：请在「设置 → 笔记生成」里填入。")

    segments = [s for s in (payload.get("segments") or []) if str(s.get("text", "")).strip()]
    if not segments:
        _progress(job, stage="error", text="没有可用的转写内容")
        raise RuntimeError("没有可用的转写内容。")

    title = (payload.get("title") or "课堂记录").strip()
    max_tokens = int(cfg.get("notes_max_tokens") or 8192)
    system_prompt = NOTE_PROMPT.replace("__MAX_READS__", str(cfg.get("reading_list_max", 4)))
    has_spk = any(seg.get("spk") for seg in segments)
    if has_spk:
        system_prompt += (
            "\n\n【说话人】转写稿的行首可能带「发言人一：」这类前缀。"
            "整理讲稿时要保留该前缀，并让不同发言人各自成段，"
            "不要把两个人的话合并成一句；章节标题不受影响。"
        )

    transcript = "\n".join(_seg_line(s) for s in segments)
    total_chars = len(transcript)
    print(f"[notes] 转写稿 {len(segments)} 段 / {total_chars} 字")
    _progress(job, stage="start", done=0, total=1, text="正在准备")
    _touch()

    try:
        # 长课：分段整理讲稿，笔记用整理后的讲稿生成（上下文更省、去噪更好）
        if total_chars > 24000:
            article_parts = []
            chapters = []            # [(时间, 标题)]，从 [[05:12]] 标记里抽出来
            chunk_size = int(cfg.get("notes_chunk_chars") or 14000)
            chunks, buf, used = [], [], 0
            for seg in segments:
                line = _seg_line(seg)
                if used + len(line) > chunk_size and buf:
                    chunks.append(buf)
                    buf, used = [], 0
                buf.append(line)
                used += len(line) + 1
            if buf:
                chunks.append(buf)
            print(f"[notes] 分 {len(chunks)} 段整理讲稿")
            _progress(job, stage="article", done=0, total=len(chunks), text="整理讲稿")

            for idx, chunk in enumerate(chunks):
                part_msgs = [
                    {"role": "system", "content": (
                        "你是课堂记录整理助手。下面是同一节课转写稿的第 "
                        f"{idx + 1}/{len(chunks)} 部分。请只整理这一部分："
                        "去掉语气词与口吃，合并重复，改成通顺书面语，保留老师原话风格与例子，"
                        "不添加原文没有的内容。\n"
                        "要求：每个 `## 小标题` 前面加一个时间标记，写成 `[[05:12]] ## 一、标题`，"
                        "时间取该小节在转写稿里开始的那个时间戳。正文其它地方不要出现时间标记。\n"
                        "只输出整理后的正文，不要写「第一部分」之类的前后缀，不要总结。"
                        + ("如果某行以「发言人一：」这类前缀开头，整理时保留前缀，"
                           "不同发言人的话不要合并成一句。\n" if any(x.get("spk") for x in chunk) else "")
                    )},
                    {"role": "user", "content": "\n".join(chunk)},
                ]
                raw = _notes_chat_full(cfg, part_msgs, max_tokens).strip()
                for m in re.finditer(r"\[\[(\d{1,3}:\d{2}(?::\d{2})?)\]\]\s*##\s*([^\n]+)", raw):
                    chapters.append((m.group(1), m.group(2).strip()))
                article_parts.append(re.sub(r"\[\[\d{1,3}:\d{2}(?::\d{2})?\]\]\s*", "", raw))
                _progress(job, stage="article", done=idx + 1, total=len(chunks),
                          text=f"整理讲稿 {idx + 1}/{len(chunks)}")

            article = "\n\n".join(article_parts)

            # 笔记改用讲稿 + 章节时间轴
            timeline = "\n".join(f"- [{t}] {h}" for t, h in chapters)
            notes_user = (
                f"课程：{title}（时长 {payload.get('duration', '未知')}）\n\n"
                f"整理后的讲稿：\n{article}\n\n"
                + (f"已知章节时间轴（章节速览必须用这些时间，不要自己编）：\n{timeline}\n" if timeline else "")
            )
            _progress(job, stage="notes", done=0, total=1, text="整理笔记")
            notes_raw = _notes_chat_full(
                cfg,
                [{"role": "system", "content": system_prompt},
                 {"role": "user", "content": notes_user}],
                max_tokens,
            )
            _, notes = split_parts(notes_raw)
            if not notes:
                notes = notes_raw
            notes = notes.replace("<<<ARTICLE>>>", "").replace("<<<NOTES>>>", "").strip()
        else:
            _progress(job, stage="all", done=0, total=1, text="整理讲稿和笔记")
            user_msg = (
                f"课程：{title}（时长 {payload.get('duration', '未知')}）\n\n"
                f"转写稿：\n{transcript}"
            )
            content = _notes_chat_full(
                cfg,
                [{"role": "system", "content": system_prompt},
                 {"role": "user", "content": user_msg}],
                max_tokens,
            )
            article, notes = split_parts(content)
            if not notes:
                article, notes = "", article

        # 先把截图插好，再落盘——避免原文写两遍（第二遍会把刚写的文件归档一次）
        shots = payload.get("shots") or []
        if shots:
            notes = insert_shots(notes, shots)
            if article.strip():
                article = insert_shots(article, shots)

        _progress(job, stage="save", done=0, total=1, text="写入知识库")
        article_path, where = "", ""
        if article.strip():
            p, where_one = write_note_file(
                title, article, cfg,
                label="课堂原文", kind="原文", tags=("待分类", "课堂原文", "讲稿"),
            )
            article_path, where = str(p), where_one

        banner = f"> 对应原文：[[{Path(article_path).stem}]]\n\n" if article_path else ""
        p_notes, where_two = write_note_file(title, notes, cfg, banner=banner)
        _progress(job, stage="done", done=1, total=1, text="完成")
        return {
            "article": article,
            "notes": notes,
            "article_path": article_path,
            "notes_path": str(p_notes),
            "where": where_two or where,
            "chars": total_chars,
        }
    except Exception as exc:
        _progress(job, stage="error", text=str(exc)[:80])
        raise


def save_segment(session_id: str, seq: int, wav: bytes) -> str:
    d = AUDIO_DIR / _safe_name(session_id)
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{int(seq):05d}.wav"
    p.write_bytes(wav)
    return str(p)


def list_segments(session_id: str) -> list[int]:
    d = AUDIO_DIR / _safe_name(session_id)
    if not d.is_dir():
        return []
    return sorted(int(p.stem) for p in d.glob("*.wav") if p.stem.isdigit())


def transcribe_saved(session_id: str, seq: int, language: str) -> str:
    p = AUDIO_DIR / _safe_name(session_id) / f"{int(seq):05d}.wav"
    if not p.exists():
        raise RuntimeError(f"找不到这段音频：{p.name}")
    text = transcribe(p.read_bytes(), language)
    # 默认转成功就删音频；用户勾了「保留录音」才留着
    if not load_config().get("keep_audio"):
        p.unlink(missing_ok=True)
        _drop_empty_dir(p.parent)
    return text


def _drop_empty_dir(d: Path) -> None:
    try:
        if d.is_dir() and not any(d.iterdir()):
            d.rmdir()
    except OSError:
        pass


def sweep_audio(max_age_days: int = 3) -> int:
    """清理没转成功的历史音频（默认 3 天前的），避免越积越多"""
    if not AUDIO_DIR.is_dir():
        return 0
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    for p in AUDIO_DIR.rglob("*.wav"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            pass
    for d in AUDIO_DIR.iterdir():
        if d.is_dir():
            _drop_empty_dir(d)
    return removed


# ---------------------------------------------------------------- 分词

_JIEBA = None

STOPWORDS = set("""
事情 例子 明白 道理 东西 情况 程度 方面 部分 内容 形式 过程 结果 原样 关键 细节 这个 那个 就是 其实 然后 所以 因为 但是 这样 那样 一个 可以 没有 不是 还是 如果 已经
什么 怎么 时候 问题 东西 大家 现在 这些 那些 以及 对于 关于 通过 进行 能够 需要 应该
可能 一定 非常 比较 特别 一直 不断 我们 你们 他们 对吧 是不是 的话 一下 这种 那种
自己 这么 那么 知道 觉得 感觉 而且 或者 虽然 不过 只是 还有 一样 这里 那里 因此 由于
并且 然而 而是 甚至 尤其 比如 例如 就是 也是 都是 还是 总是 可是 于是 要是 即使 尽管
无论 不管 除了 关于 按照 根据 随着 作为 成为 具有 存在 产生 出现 发生 得到 提高 增加
第一 第二 第三 首先 其次 最后 总之 反正 其实 确实 当然 基本 主要 重要 一般 通常 往往
绝对 肯定 也许 大概 差不多 实际上 事实上 真的 有点 稍微 比较 更加 最好 更好 很多 更多
一些 一点 有点 没什么 什么样 怎么样 为什么 哪儿 哪里 怎么 那么 这么 多么 起来 出来
下来 上来 过来 回去 进去 出来 看到 说说 想想 看看 听听 来讲 来说 而言 来说 之类 等等
方面 角度 情况 过程 结果 原因 方式 方法 部分 内容 形式 状态 程度 关系 影响 作用 意义
老师 同学 上课 下课 今天 昨天 明天 这个 那个 咱们 人家 别人 自己 本身 之间 之中 之后
之前 以后 以前 现在 目前 当前 同时 另外 此外 否则 不然 万一 千万 究竟 到底 难道 居然
竟然 果然 仍然 依然 曾经 刚刚 马上 立刻 后来 接着 于是 因此 从而 以便 以免 甚至
不能 不会 不要 不用 不会 必要 必须 需要 觉得 认为 表示 说明 提到 讲到 说到
这种 那种 哪种 某个 某些 各种 各类 一些 一点 有点 没什么 什么样 怎么样 为什么
""".split())


EN_STOP = set("""
the a an is are was were be been being am do does did doing have has had having
to of in on at by for with from into onto about over under between among through
and or but if then than so because as while when where what which who whom whose why how
not no nor yes ok okay you your yours we our ours they them their this that these those
it its he she his her him i me my mine us
can could will would shall should may might must
just very too also only even still yet already again more most much many some any all
one two three first second next last other another such same own few little less least
here there now then thus hence however therefore though although
""".split())


def _is_noise(word: str) -> bool:
    """连词、副词、语气词、虚词和半截词一律不要"""
    if len(word) < 2:
        return True
    if word in STOPWORDS:
        return True
    # 以助词/语气收尾的，多半是半截短语
    if word[-1] in "的了着呢吗吧啊呀哦嘛哈呗咧":
        return True
    if word.isdigit():
        return True
    # 英文虚词、过短的英文
    if re.fullmatch(r"[A-Za-z]+", word):
        low = word.lower()
        if low in EN_STOP or len(word) < 4:
            return True
    return False


def _jieba():
    """按需加载：第一次调用才读词典，避免拖慢启动"""
    global _JIEBA
    if _JIEBA is not None:
        return _JIEBA
    vendor = BASE / "vendor"
    if vendor.is_dir() and str(vendor) not in sys.path:
        sys.path.insert(0, str(vendor))
    import jieba
    jieba.setLogLevel(60)
    _JIEBA = jieba
    return jieba


def extract_words(text: str, top: int = 8) -> list[dict]:
    text = (text or "").strip()
    if len(text) < 10:
        return []

    jieba = _jieba()

    # 有词性标注就只收名词类；没有就退回普通分词
    pairs: list[tuple[str, str]] = []
    try:
        import jieba.posseg as pseg
        pairs = [(w, f) for w, f in pseg.cut(text)]
    except Exception:
        pairs = [(w, "") for w in jieba.lcut(text)]



    KEEP = ("n", "vn", "an", "eng")   # 名词、动名词、形容词名用、英文词

    counts: dict[str, int] = {}
    for word, flag in pairs:
        word = word.strip()
        if _is_noise(word):
            continue
        if flag:
            if not (flag.startswith("n") or flag in KEEP):
                continue
            if flag == "eng" and (len(word) < 4 or word.lower() in EN_STOP):
                continue
        counts[word] = counts.get(word, 0) + 1

    items = [(w, c) for w, c in counts.items() if c >= (2 if len(w) >= 3 else 3)]
    items.sort(key=lambda x: -x[1] * len(x[0]))

    picked: list[dict] = []
    for word, count in items:
        if any(word in p["w"] or p["w"] in word for p in picked):
            continue
        picked.append({"w": word, "c": count})
        if len(picked) >= max(1, min(20, top)):
            break
    return picked


# ---------------------------------------------------------------- 连通性

CHATTER_SYSTEM = (
    "你扮演一个十岁左右的男孩，在一个课堂录音工具里蹲着负责录音记笔记。"
    "用第一人称「我」说话，不要给自己起名字，也不要自称某个名字。"
    "性格：皮、坐不住、爱插嘴但没坏心；常自言自语些莫名其妙的话；"
    "爱玩射击类和派对类手游、爱刷短视频、爱吃（正在减肥）、"
    "学过书法和编程、羽毛球打得一般。"
    "说话像小孩：短句、口语，偶尔用「啊/吧/啦/诶」，不用书面语。"
    "场景：用户坐在下面听课，讲台上是老师，说话的不是用户；提到说话的人用「老师」「台上」。"
    "硬性要求：中文；10-24 字；最多两句；爱好偶尔带一个，别每句都提；"
    "按状态说话，录音中禁止说「老师还没到」「在路上」「还没开始」「等你」；"
    "不写解释、不写引号、不写前缀，只输出这一句。"
)


def chatter(payload: dict) -> dict:
    """每次现编一句台词，由 DeepSeek 生成；失败时返回空串，由前端兜底。"""
    state = str(payload.get("state") or "录音中")[:20]
    recent = [str(x)[:40] for x in (payload.get("recent") or [])][:5]

    guard = {
        "还没开始": "还没点开始录音，可以写老师还没到、讲台还空着这类。",
        "录音中": "已经在录音，老师正在讲。禁止出现“老师还没到”“在路上”“还没开始”“等你”之类的说法。",
        "沉默太久": "正在录音，但讲台上已经安静了一阵。可以说安静、停顿，不能说老师没来。",
        "识别排队": "正在录音，字幕在排队。只写排队这件事。",
        "讲得太久": "正在录音，已经讲很久了。可以吐槽时长，不能说还没开始。",
        "整理完成": "录音已结束，笔记和讲稿刚刚生成。",
        "出错了": "出现了识别或网络错误。",
        "深夜还在讲": "深夜还在录音，老师还在讲。",
    }.get(state, "")

    user = f"当前状态：{state}。{guard}"
    if recent:
        user += "\n下面这些以前说过，别重复，也别换个说法重复：\n" + "\n".join(f"- {r}" for r in recent)
    user += "\n现在写一句。"

    try:
        line = chat_completion(CHATTER_SYSTEM, user, temperature=1.0)
    except Exception as exc:  # noqa: BLE001
        return {"line": "", "error": str(exc)[:120]}

    line = (line or "").strip().splitlines()[0] if line else ""
    line = line.strip().strip('"“”「」').strip()
    if len(line) > 40:
        line = line[:40]
    return {"line": line}


def _probe(base_url: str, key: str, timeout: int = 8) -> dict:
    """用 /models 探一下这家服务通不通、key 对不对"""
    if not key:
        return {"ok": False, "msg": "未配置 KEY", "definitive": True}
    if not base_url:
        return {"ok": False, "msg": "接口地址为空", "definitive": True}
    url = base_url.rstrip("/") + "/models"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "lecture-transcribe/1.0",
    })
    try:
        with api_request(req, timeout=timeout) as r:
            body = json.loads(r.read().decode("utf-8", errors="replace"))
        n = len(body.get("data", [])) if isinstance(body, dict) else 0
        return {"ok": True, "msg": f"已连接（{n} 个模型）", "definitive": False}
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return {"ok": False, "msg": f"KEY 被拒绝（HTTP {exc.code}）", "definitive": True}
        # 404/429/5xx 多半是网络或频率问题，不算 KEY 坏
        return {"ok": False, "msg": f"接口返回 HTTP {exc.code}", "definitive": False}
    except urllib.error.URLError as exc:
        return {"ok": False, "msg": f"连不上：{exc.reason}", "definitive": False}
    except TimeoutError:
        return {"ok": False, "msg": "连接超时", "definitive": False}
    except Exception as exc:
        return {"ok": False, "msg": f"异常：{exc}", "definitive": False}


def health() -> dict:
    cfg = load_config()
    return {
        "asr": _probe(cfg.get("base_url", ""), cfg.get("api_key", "")),
        "notes": _probe(cfg.get("notes_base_url", ""), cfg.get("notes_api_key", "")),
    }


# ---------------------------------------------------------------- 历史记录

def _vault_dir() -> Path | None:
    v = (load_config().get("obsidian_inbox") or "").strip()
    if not v:
        return None
    p = Path(v)
    return p if p.is_dir() else None


def _kind_of(name: str) -> str:
    if "笔记" in name:
        return "笔记"
    if "讲稿" in name or "课堂原文" in name:
        return "讲稿"
    if "转写稿" in name or re.match(r"^\d{8}-\d{6}-", name):
        return "转写稿"
    return "文档"


def _vault_root() -> Path | None:
    """收件箱的上一级就是知识库根目录"""
    inbox = _vault_dir()
    return inbox.parent if inbox else None


def list_history(limit: int = 300) -> list[dict]:
    items: list[dict] = []

    def collect(folder: Path, where: str, depth: int = 0) -> None:
        if depth > 3 or not folder.is_dir():
            return
        try:
            entries = list(folder.iterdir())
        except OSError:
            return
        for f in entries:
            if f.name.startswith(".") or f.name.startswith("_"):
                continue
            if f.is_dir():
                collect(f, f"{where}/{f.name}", depth + 1)
                continue
            if f.suffix.lower() != ".md":
                continue
            stem = f.stem
            keep = any(k in stem for k in ("讲稿", "笔记", "转写稿", "课堂原文"))
            # 老版本转写稿只带时间戳，在本地会话目录里仍收
            if not keep and where == "本地" and re.match(r"^\d{8}-\d{6}-", stem):
                keep = True
            if not keep:
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            items.append({
                "path": str(f),
                "name": f.stem,
                "kind": _kind_of(f.stem),
                "where": where,
                "mtime": st.st_mtime,
                "size": st.st_size,
            })

    collect(SESSIONS, "本地")
    root = _vault_root()
    if root:
        collect(root, "知识库")

    # 同名文件只留最新的一份（归档和 02-笔记 经常各有一份）
    best: dict[str, dict] = {}
    for it in items:
        key = it["name"]
        if key not in best or it["mtime"] > best[key]["mtime"]:
            best[key] = it
    merged = sorted(best.values(), key=lambda x: x["mtime"], reverse=True)
    return merged[:limit]


def read_doc(path_str: str) -> str:
    p = Path(path_str).resolve()
    roots = [SESSIONS.resolve()]
    v = _vault_root()
    if v:
        roots.append(v.resolve())

    # 路径必须落在允许范围内
    if not any(p == r or p.is_relative_to(r) for r in roots):
        raise RuntimeError("只能读取会话目录或知识库里的文件")

    if p.suffix.lower() == ".md" and p.is_file():
        return p.read_text(encoding="utf-8")

    # 文件被移走了（收件箱→归档/笔记）：按文件名在库里找最新的一份
    name = Path(path_str).name
    if not name:
        raise RuntimeError("文件不存在")

    found: list[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        try:
            found.extend(x for x in root.rglob(name) if x.is_file() and x.suffix.lower() == ".md")
        except OSError:
            continue
    if not found:
        raise RuntimeError(f"文件不存在，库里也没有同名文件：{name}")

    found.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    return found[0].read_text(encoding="utf-8")


# ---------------------------------------------------------------- 落盘

STATS_FILE = SESSIONS / "stats.json"
STATS_LOCK = threading.Lock()


def _duration_seconds(text: str) -> int:
    """把 05:12 / 1:02:33 这类时长字符串变成秒"""
    parts = [p for p in str(text or "").split(":") if p.strip().isdigit()]
    if not parts:
        return 0
    try:
        nums = [int(x) for x in parts]
    except ValueError:
        return 0
    if len(nums) == 2:
        return nums[0] * 60 + nums[1]
    if len(nums) == 3:
        return nums[0] * 3600 + nums[1] * 60 + nums[2]
    return 0


def _load_stats() -> dict:
    try:
        data = json.loads(STATS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def _save_stats(data: dict) -> None:
    try:
        SESSIONS.mkdir(parents=True, exist_ok=True)
        STATS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def record_stats(payload: dict) -> None:
    """保存一节时累计当天数据"""
    segs = payload.get("segments") or []
    seconds = _duration_seconds(payload.get("duration", ""))
    if not seconds:
        seconds = len(segs) * 15
    chars = sum(len(str(s.get("text", "")).strip()) for s in segs)
    day = time.strftime("%Y-%m-%d")
    with STATS_LOCK:
        data = _load_stats()
        row = data.get(day) or {"minutes": 0, "sessions": 0, "segments": 0, "chars": 0}
        row["sessions"] += 1
        row["segments"] += len(segs)
        row["chars"] += chars
        row["minutes"] = round(row.get("minutes", 0) + seconds / 60, 1)
        data[day] = row
        _save_stats(data)


def stats_snapshot() -> dict:
    """今天概览 + 最近 7 天（周一..周日）分钟数"""
    with STATS_LOCK:
        data = _load_stats()

    # 历史兜底：sessions 里今天写过的转写稿，按段落数 × 15 秒估时长
    today = time.strftime("%Y-%m-%d")
    row = dict(data.get(today) or {"minutes": 0, "sessions": 0, "segments": 0, "chars": 0})
    if not row.get("sessions"):
        estimated = {"minutes": 0.0, "sessions": 0, "segments": 0, "chars": 0}
        for f in SESSIONS.glob("*.md"):
            try:
                if time.strftime("%Y-%m-%d", time.localtime(f.stat().st_mtime)) != today:
                    continue
                text = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            seg_count = text.count("\\n[")
            estimated["sessions"] += 1
            estimated["segments"] += seg_count
            estimated["chars"] += len(text)
            estimated["minutes"] += seg_count * 15 / 60
        if estimated["sessions"]:
            row = {k: (round(v, 1) if isinstance(v, float) else v) for k, v in estimated.items()}

    notes_today = 0
    for p in list(SESSIONS.glob("*.md")) + list(_vault_candidates()):
        try:
            if time.strftime("%Y-%m-%d", time.localtime(p.stat().st_mtime)) == today and "笔记" in p.name:
                notes_today += 1
        except OSError:
            continue

    week = []
    now = time.localtime()
    monday = time.mktime((now.tm_year, now.tm_mon, now.tm_mday, 0, 0, 0, 0, 0, -1)) - (now.tm_wday * 86400)
    for i in range(7):
        stamp = time.strftime("%Y-%m-%d", time.localtime(monday + i * 86400))
        day_row = data.get(stamp) or {}
        minutes = day_row.get("minutes", 0) or 0
        if stamp == today:
            minutes = row.get("minutes", 0)
        week.append(round(float(minutes), 1))

    return {
        "today": {
            "minutes": round(float(row.get("minutes", 0) or 0)),
            "sessions": int(row.get("sessions", 0) or 0),
            "segments": int(row.get("segments", 0) or 0),
            "chars": int(row.get("chars", 0) or 0),
            "notes": notes_today,
        },
        "week": week,
    }


def _vault_candidates():
    v = _vault_root()
    if not v:
        return []
    try:
        return [p for p in v.rglob("*笔记*.md")][:200]
    except OSError:
        return []


_CN_NUM = "一二三四五六七八九十"


def _spk_name(n) -> str:
    """声纹编号 → 发言人一 / 二 / 三……"""
    try:
        i = int(n)
    except (TypeError, ValueError):
        return ""
    if i <= 0:
        return ""
    return "发言人" + (_CN_NUM[i - 1] if i <= 10 else str(i))


def _seg_line(seg: dict) -> str:
    """一行转写：[时间] 发言人X：内容（没有声纹时就没有前缀）"""
    label = _spk_name(seg.get("spk"))
    text = str(seg.get("text", "")).strip()
    return f"[{seg.get('time', '--:--')}] {label + '：' if label else ''}{text}"


def save_session(payload: dict) -> str:
    SESSIONS.mkdir(parents=True, exist_ok=True)
    title = (payload.get("title") or "课堂记录").strip()
    segments = payload.get("segments") or []
    stamp = time.strftime("%Y%m%d-%H%M%S")
    safe = "".join(c for c in title if c not in '\\/:*?"<>|').strip() or "课堂记录"
    path = SESSIONS / f"{stamp}-{safe[:36]}-转写稿.md"

    lines = [
        f"# {title}",
        "",
        f"- 时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 时长：{payload.get('duration', '')}",
        f"- 片段数：{len(segments)}",
        "",
        "## 转写原文（带时间戳）",
        "",
    ]
    for seg in segments:
        lines.append(_seg_line(seg))
        tr = str(seg.get("tr", "")).strip()
        if tr:
            lines.append(f"    ↳ {tr}")
    lines += ["", "## 纯文本（便于复制整理）", "", ""]
    plain_bits = []
    for seg in segments:
        label = _spk_name(seg.get("spk"))
        plain_bits.append((label + "：" if label else "") + str(seg.get("text", "")).strip())
    lines.append("".join(plain_bits))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        record_stats(payload)
    except Exception:
        pass
    return str(path)


# ---------------------------------------------------------------- HTTP

def _inject_version(html: str) -> str:
    """给 app.js / style.css 带上版本号，改完刷新就能拿到新文件"""
    ver = _read_version()
    html = html.replace('src="app.js"', f'src="app.js?v={ver}"')
    html = html.replace('href="style.css"', f'href="style.css?v={ver}"')
    # 顺手把配置塞进页面：少一次网络请求，也避免 /api/config 失败把整页卡死
    try:
        blob = json.dumps(public_config(load_config()), ensure_ascii=False)
        # 别让配置里的 </script> 把内联脚本截断（prompt / 路径都是用户可控的）
        blob = blob.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
        boot = f'<script>window.__BOOT_CONFIG = {blob};</script>'
        html = html.replace("</head>", boot + "</head>", 1)
    except Exception as exc:      # 配置坏了也别把页面拖死
        print(f"[warn] 注入配置失败：{exc}")
    return html


ALLOW_REMOTE = False   # 只有显式 --host 指定其它地址时才放开


def _origin_allowed(origin: str) -> bool:
    """只放行本机页面的跨站请求；没有 Origin（curl、脚本）也放行"""
    if not origin:
        return True
    try:
        host = urllib.parse.urlparse(origin).hostname or ""
    except ValueError:
        return False
    return host in ("127.0.0.1", "localhost", "::1")


def _is_loopback(addr: str) -> bool:
    if not addr:
        return False
    if addr in ("::1", "localhost"):
        return True
    if addr.startswith("::ffff:"):
        addr = addr[7:]
    return addr.startswith("127.")


STATIC_ALLOW = {
    "", "/", "/index.html", "/app.js", "/style.css", "/app.ico",
    "/favicon.ico", "/manifest.json", "/robots.txt",
}


class DualStackServer(ThreadingHTTPServer):
    """同时吃 IPv4 与 IPv6：浏览器把 localhost 解析成 ::1 时也能连上"""
    daemon_threads = True
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()

    def verify_request(self, request, client_address):
        # 双栈监听必然绑到 0.0.0.0，这里把非本机的连接挡掉：
        # 同一 Wi-Fi 下的设备不该能读笔记、不该能花你的 API 额度
        if ALLOW_REMOTE:
            return True
        return _is_loopback(client_address[0])


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE), **kwargs)

    def log_message(self, fmt, *args):  # 安静一点
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def log_request(self, code='-', size='-'):
        ua = (self.headers.get('User-Agent') or '?')[:60]
        self._log_line(f"   -> {code} {self.path}  UA={ua}")

    def _log_line(self, text: str):
        try:
            LOGS.mkdir(parents=True, exist_ok=True)
            with open(LOGS / "requests.log", "a", encoding="utf-8") as fh:
                fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text}\n")
        except OSError:
            pass

    def send_response(self, code, message=None):

        super().send_response(code, message)
        # 开发中反复改前端，禁用缓存，避免浏览器拿着旧 app.js 跑
        self.send_header("Cache-Control", "no-store, must-revalidate")

    def _cors(self):
        # 只对同源页面回显，别再全站 *（否则任意网页能读走整库笔记）
        origin = (self.headers.get("Origin") or "").strip()
        if origin and _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _json(self, code: int, data: dict):
        blob = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(blob)))
        self._cors()
        try:
            self.end_headers()
            self.wfile.write(blob)
        except (ConnectionError, OSError) as exc:
            LOG.warning("写响应失败（客户端已断开）%s %s", self.path, exc)

    def _safe_handle(self, fn):
        try:
            return fn()
        except (ConnectionError, BrokenPipeError):
            raise
        except Exception:
            import traceback
            detail = traceback.format_exc()
            _log(f"[error] {self.command} {self.path}\n{detail}")
            try:
                return self._json(500, {"error": f"服务端异常：{detail.splitlines()[-1][:160]}"})
            except Exception:
                return None

    def do_GET(self):
        self._log_line(f"GET  {self.path}  from {self.client_address[0]}")
        route = self.path.split("?")[0]
        if route == "/api/ping":
            # 极轻量：不碰外部接口，只用来判断本地服务是否活着
            return self._json(200, {"ok": True, "pid": os.getpid()})

        if route == "/api/watchdog":
            cfg = load_config()
            now = time.time()
            return self._json(200, {
                "enabled": bool(cfg.get("watchdog_restart", False)),
                "strict": bool(cfg.get("watchdog_strict", False)),
                "fails": WATCHDOG["fails"],
                "last_check": WATCHDOG["last_check"],
                "last_alive": WATCHDOG["last_alive"],
                "since_check": round(now - WATCHDOG["last_check"], 1) if WATCHDOG["last_check"] else None,
                "idle_for": round(now - LAST_ACTIVITY[0], 1),
                "interval": float(os.environ.get("DICT_PROBE_SECONDS", "45")),
                "threshold": int(os.environ.get("DICT_PROBE_FAILS", "3")),
                "pid": os.getpid(),
            })

        if route == "/api/notes-progress":
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            job = (qs.get("job") or [""])[0]
            return self._json(200, notes_task_status(job))

        if route == "/api/config":
            return self._json(200, public_config(load_config()))
        if route == "/api/health":
            _touch()
            return self._json(200, health())
        if route == "/api/stats":
            try:
                return self._json(200, stats_snapshot())
            except Exception as exc:
                return self._json(400, {"error": str(exc)})
        if route == "/api/history":
            return self._json(200, {"items": list_history()})
        if route == "/api/shot":
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            name = (qs.get("name") or [""])[0]
            path = shot_file(name)
            if not path:
                return self._json(404, {"error": "找不到这张截图"})
            try:
                data = path.read_bytes()
            except OSError:
                return self._json(404, {"error": "这张截图读不出来了"})
            ctype = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
                     "png": "image/png", "webp": "image/webp"}.get(path.suffix.lstrip("."), "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(data)
            return

        if route == "/api/doc":
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            try:
                return self._json(200, {"text": read_doc((q.get("path") or [""])[0])})
            except RuntimeError as exc:
                return self._json(400, {"error": str(exc)})
        if route in ("/", "/index.html"):
            page = BASE / "index.html"
            if page.is_file():
                data = _inject_version(page.read_text(encoding="utf-8")).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        if route == "/api/export":
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            src = (q.get("path") or [""])[0]
            fmt = ((q.get("fmt") or ["html"])[0] or "html").lower()
            try:
                data, name, mime = export_doc(src, fmt)
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Disposition",
                                 f"attachment; filename*=UTF-8''{urllib.parse.quote(name)}")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            except RuntimeError as exc:
                return self._json(400, {"error": str(exc)})
        if route == "/api/diarize":
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            sid = (q.get("session") or [""])[0]
            try:
                return self._json(200, diarize(sid))
            except Exception as exc:
                return self._json(400, {"error": str(exc)})
        if route == "/api/segments":
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            sid = (q.get("session") or [""])[0]
            return self._json(200, {"seqs": list_segments(sid)})
        # 只放行前端资源和模型文件；config.json、sessions、logs 一律不给
        if route in STATIC_ALLOW or route.startswith(("/emotion-ball/", "/models/", "/vendor/")):
            return super().do_GET()
        return self._json(404, {"error": "没有这个资源"})

    def do_POST(self):
        self._log_line(f"POST {self.path}  from {self.client_address[0]}")
        # 别让随便一个网页就能往本机接口写东西（改配置、花额度、灌截图）
        origin = (self.headers.get("Origin") or "").strip()
        if not _origin_allowed(origin):
            return self._json(403, {"error": "跨站请求被拒绝"})
        _touch()
        route = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return self._json(400, {"error": "请求长度不合法"})
        # 别让一个 Content-Length 就把内存打爆
        limit = 32 * 1024 * 1024 if route == "/api/shot" else 4 * 1024 * 1024
        if length > limit:
            return self._json(413, {"error": f"请求太大（上限 {limit // 1048576}MB）"})
        try:
            body = self.rfile.read(length) if length else b""
        except Exception:
            return self._json(400, {"error": "读取请求体失败"})

        if route == "/api/shot":
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            try:
                sec = float((qs.get("sec") or ["0"])[0])
            except ValueError:
                sec = 0.0
            title = (qs.get("title") or [""])[0]
            ext = (qs.get("ext") or ["jpg"])[0]
            try:
                info = save_shot(body, sec, title, ext)
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            return self._json(200, info)

        if route == "/api/client-log":
            try:
                payload = json.loads(body or b"{}")
            except Exception:
                payload = {}
            _log_client(payload if isinstance(payload, dict) else {})
            return self._json(200, {"ok": True})

        if route == "/api/config":
            try:
                return self._json(200, public_config(save_config(json.loads(body or b"{}"))))
            except Exception as exc:
                return self._json(400, {"error": f"保存配置失败：{exc}"})

        if route == "/api/transcribe":
            lang = "zh"
            if "?" in self.path:
                for pair in self.path.split("?", 1)[1].split("&"):
                    if pair.startswith("lang="):
                        lang = pair[5:] or "zh"
            if not body:
                return self._json(400, {"error": "空音频"})
            try:
                text = transcribe(body, lang)
                sess_id, seq = "", 0
                if "?" in self.path:
                    for pair in self.path.split("?", 1)[1].split("&"):
                        if pair.startswith("session="):
                            sess_id = urllib.parse.unquote(pair[8:])
                        elif pair.startswith("seq="):
                            try:
                                seq = int(pair[4:])
                            except ValueError:
                                seq = 0
                if sess_id and seq:
                    threading.Thread(
                        target=remember_speaker, args=(sess_id, seq, body), daemon=True
                    ).start()
                return self._json(200, {"text": text})
            except RuntimeError as exc:
                return self._json(400, {"error": str(exc)})
            except Exception as exc:
                return self._json(500, {"error": f"服务端异常：{exc}"})

        if route == "/api/segment":
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            sid = (q.get("session") or [""])[0]
            seq = int((q.get("seq") or ["0"])[0])
            if not body or not sid:
                return self._json(400, {"error": "缺少音频或会话号"})
            try:
                return self._json(200, {"path": save_segment(sid, seq, body)})
            except OSError as exc:
                return self._json(500, {"error": f"存盘失败：{exc}"})

        if route == "/api/transcribe-file":
            try:
                d = json.loads(body or b"{}")
                text = transcribe_saved(d.get("session", ""), int(d.get("seq", 0)), d.get("lang", "zh"))
                return self._json(200, {"text": text})
            except RuntimeError as exc:
                return self._json(400, {"error": str(exc)})
            except Exception as exc:
                return self._json(500, {"error": f"服务端异常：{exc}"})

        if route == "/api/chatter":
            try:
                d = json.loads(body or b"{}")
                return self._json(200, chatter(d))
            except Exception as exc:
                return self._json(500, {"error": f"生成台词失败：{exc}", "line": ""})

        if route == "/api/words":
            try:
                d = json.loads(body or b"{}")
                return self._json(200, {"words": extract_words(d.get("text", ""), int(d.get("top", 8)))})
            except Exception as exc:
                return self._json(500, {"error": f"分词失败：{exc}"})

        if route == "/api/translate":
            try:
                data_in = json.loads(body or b"{}")
                text = translate_text(data_in.get("text", ""), data_in.get("direction", ""))
                return self._json(200, {"text": text})
            except RuntimeError as exc:
                return self._json(400, {"error": str(exc)})
            except Exception as exc:
                return self._json(500, {"error": f"服务端异常：{exc}"})

        if route == "/api/notes":
            try:
                payload = json.loads(body or b"{}")
                if not payload.get("shots") and payload.get("source"):
                    payload["shots"] = load_shots_sidecar(payload["source"])
                if payload.get("background"):
                    try:
                        accepted = submit_notes(payload)
                    except ValueError as exc:
                        return self._json(409, {"error": str(exc)})
                    return self._json(202, accepted)
                return self._json(200, generate_notes(payload))
            except RuntimeError as exc:
                return self._json(400, {"error": str(exc)})
            except Exception as exc:
                return self._json(500, {"error": f"服务端异常：{exc}"})

        if route == "/api/save":
            try:
                payload = json.loads(body or b"{}")
                path = save_session(payload)
                if "shots" in payload:
                    save_shots_sidecar(path, payload.get("shots") or [])
                return self._json(200, {"path": path})
            except Exception as exc:
                return self._json(500, {"error": f"保存失败：{exc}"})

        return self._json(404, {"error": "未知接口"})


def _watch_server() -> None:
    """server.py 一改就原地重启（同一个窗口、同一个端口），免得手动杀进程"""
    if os.environ.get("DICT_RELOAD") != "1":
        return

    target = Path(__file__)
    try:
        last = (target.stat().st_mtime, target.stat().st_size)
    except OSError:
        return

    def loop() -> None:
        nonlocal last
        while True:
            time.sleep(1.5)
            try:
                cur = (target.stat().st_mtime, target.stat().st_size)
            except OSError:
                continue
            if cur == last:
                continue
            last = cur
            time.sleep(0.2)
            print("\n[reload] server.py 有改动，正在重启…", flush=True)
            try:
                os.execv(sys.executable, [sys.executable, str(target)] + sys.argv[1:])
            except OSError as exc:
                print(f"[reload] 重启失败：{exc}", flush=True)
                return

    threading.Thread(target=loop, name="reload-watch", daemon=True).start()


def main():
    # 热重启默认关闭：它会在文件一改时重启服务，正在录音的人会被打断
    if os.environ.get("DICT_RELOAD") == "1":
        _watch_server()
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    global ALLOW_REMOTE
    ALLOW_REMOTE = args.host not in ("127.0.0.1", "localhost", "::1")

    cfg = load_config()
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    install_api_opener()

    try:
        host = "::" if args.host in ("127.0.0.1", "localhost", "0.0.0.0") else args.host
        srv = DualStackServer((host, args.port), Handler)
    except OSError:
        srv = ThreadingHTTPServer((args.host, args.port), Handler)
    start_watchdog()
    swept = sweep_audio()
    if swept:
        print(f"清理了 {swept} 个未转写的历史音频片段")
    print(f"课堂实时转写已启动： http://{args.host}:{args.port}")
    print(f"配置：{CONFIG_PATH}")
    if not cfg.get("api_key"):
        print("提示：还没有 API Key，页面右上角「设置」里填。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    os.chdir(BASE)
    main()
