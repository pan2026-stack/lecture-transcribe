"""守护进程：pythonw 运行，无声，定时确认服务还活着，挂了才拉起来。

生命周期（用户定的方案）：打开软件 = 起服务；关掉窗口 / 点「停止服务」= 全部停掉。
服务退出前会写 logs/stop.flag，本进程每次循环先看它：存在就自己退出，不再拉起服务。

为什么不再「一次 ping 不通就拉起」：Windows 的 SO_REUSEADDR 曾让多个 server.py
同时绑 8787，请求被分到不同实例、内存里的任务状态不一致，页面看起来一直超时。现在：
  1) 连续 3 次探活失败（每次间隔 1 秒、单次超时 5 秒）才认为服务真的不在；
  2) 拉起前先按命令行扫一遍，已经有同端口的 server.py 进程就绝不重复拉起；
  3) 拉起失败按 10 / 30 / 60 秒退避，不再每 6 秒循环；
  4) 单实例用命名互斥体，不再用 pid 文件（死 pid 会误判成「已经有一个在跑」）。
"""
import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

PROBE_INTERVAL = 1.0        # 两次探活的间隔
PROBE_TIMEOUT = 5           # 单次探活超时
FAIL_THRESHOLD = 3          # 连续失败这么多次才认定服务挂了
START_WAIT = 8              # 拉起后最多等多久让它应答
BACKOFF_SECONDS = (10, 30, 60)   # 拉起失败后的退避

MUTEX_NAME = r"Global\LectureTranscribeWatchdog"
MUTEX_FALLBACK = r"Local\LectureTranscribeWatchdog"
ERROR_ALREADY_EXISTS = 183
_MUTEX = None          # 句柄要留到进程结束；被回收掉互斥体就没了


def _arg_value(flag: str, default: str) -> str:
    argv = sys.argv
    for i, item in enumerate(argv):
        if item == flag and i + 1 < len(argv):
            return argv[i + 1]
        if item.startswith(flag + "="):
            return item.split("=", 1)[1]
    return default


HERE = Path(__file__).resolve().parent
PORT = int(_arg_value("--port", os.environ.get("LT_PORT") or "8787"))
SERVICE_DIR = Path(_arg_value("--dir", str(HERE))).resolve()
BASE = f"http://127.0.0.1:{PORT}"
SERVER = SERVICE_DIR / "server.py"
LOGS = SERVICE_DIR / "logs"
LOG = LOGS / "watchdog.log"
STOP_FLAG = LOGS / "stop.flag"


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def acquire_single_instance() -> tuple[bool, str]:
    """拿命名互斥体做单实例。返回 (是否拿到, 说明)。

    先试 Global\，普通用户没权限建时退到 Local\（同一登录会话内一样能防重复）。
    互斥体创建本身失败时「放行」而不是退出：宁可多一个守护，也别一个都没有。
    """
    global _MUTEX
    if os.name != "nt":
        return True, "非 Windows，未使用互斥体"
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    except (OSError, AttributeError) as exc:
        return True, f"互斥体不可用（{exc}），本次不做单实例限制"
    last_error = ""
    for name in (MUTEX_NAME, MUTEX_FALLBACK):
        handle = kernel32.CreateMutexW(None, True, name)
        err = ctypes.get_last_error()
        if not handle:
            last_error = f"创建 {name} 失败（错误码 {err}）"
            continue
        if err == ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return False, name
        _MUTEX = handle          # 进程活着期间一直持有，退出时由系统释放
        return True, name
    return True, last_error or "互斥体不可用，本次不做单实例限制"


def ping_server() -> int:
    """探活：返回服务进程 pid，没应答返回 0。超时按 PROBE_TIMEOUT 秒算。"""
    try:
        with urllib.request.urlopen(BASE + "/api/ping", timeout=PROBE_TIMEOUT) as r:
            return int(json.loads(r.read().decode()).get("pid") or 0)
    except Exception:
        return 0


def find_server_process() -> tuple[int, bool]:
    """按命令行找已经在跑的 server.py --port <PORT>，返回 (pid, 是否同一目录)。

    这是「绝不重复拉起」的保险：探活可能因为卡顿误判，进程存在就只观察不拉起。
    老实例可能是用相对路径 `server.py --port 8787` 起的（命令行里没有目录），
    所以目录只作为加分项：端口对得上就算，最多在日志里注明。
    """
    if os.name != "nt":
        return 0, False
    script = (
        "$dir=$env:LT_DIR; $port=$env:LT_PORT; "
        "$p=@(Get-CimInstance Win32_Process).Where({ "
        "($_.Name -eq 'python.exe' -or $_.Name -eq 'pythonw.exe') -and $_.CommandLine -and "
        "$_.CommandLine.Contains('server.py') -and "
        "($_.CommandLine.Contains('--port ' + $port) -or $_.CommandLine.Contains('--port=' + $port)) }); "
        "foreach($x in $p){ '{0}|{1}' -f $x.ProcessId, $([bool]($x.CommandLine.Contains($dir))) }"
    )
    env = dict(os.environ)
    env["LT_DIR"] = str(SERVICE_DIR)
    env["LT_PORT"] = str(PORT)
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        out = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True, text=True, timeout=20, env=env, creationflags=flags,
            encoding="utf-8", errors="replace")
    except Exception as exc:
        log(f"扫描已有服务进程失败：{exc}")
        return 0, False
    for line in (out.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        pid_text, _, same_text = line.partition("|")
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid == os.getpid():       # 排除自己（正常不会匹配到）
            continue
        return pid, same_text.strip().lower() in ("true", "1")
    return 0, False


def python_for_server() -> str:
    for rel in (r"python\pythonw.exe", r"python\python.exe"):
        p = SERVICE_DIR / rel
        if p.exists():
            return str(p)
    exe = sys.executable
    cand = Path(exe).with_name("pythonw.exe")
    return str(cand if cand.exists() else exe)


def start_server() -> bool:
    if not SERVER.exists():
        log(f"拉起失败：找不到 {SERVER}")
        return False
    py = python_for_server()
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    try:
        subprocess.Popen(
            [py, str(SERVER), "--port", str(PORT)],
            cwd=str(SERVICE_DIR),
            creationflags=flags,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log(f"已执行拉起命令（{py}）")
        return True
    except Exception as exc:
        log(f"拉起命令失败：{exc}")
        return False


def wait_ping(timeout: float) -> int:
    """等端口应答，成功返回服务 pid。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        pid = ping_server()
        if pid:
            return pid
        time.sleep(0.3)
    return 0


def start_and_wait() -> int:
    if not start_server():
        return 0
    return wait_ping(START_WAIT)


def main() -> None:
    ok, detail = acquire_single_instance()
    if not ok:
        log(f"已经有一个守护在跑（互斥体 {detail} 被占用），本次退出 pid={os.getpid()}")
        return
    log(f"守护启动 pid={os.getpid()} 端口={PORT} 目录={SERVICE_DIR} 单实例={detail}")

    fails = 0
    attempts = 0
    last_attempt = 0.0
    last_blocked_log = 0.0

    # 守护刚起来时服务通常还没跑：先判一次，需要就立刻拉起，不必等 3 次失败
    pid = ping_server()
    if pid:
        log(f"服务已在运行（pid={pid}），开始监控")
    else:
        existing, same = find_server_process()
        if existing:
            log(f"启动检查：服务没应答，但已有 server.py 进程 pid={existing}"
                f"（同目录={same}），不重复拉起")
        else:
            log("启动检查：服务还没有起来，立即拉起")
            last_attempt = time.time()
            started = start_and_wait()
            if started:
                log(f"已拉起服务（pid={started}）")
            else:
                attempts = 1
                log(f"拉起后 {START_WAIT} 秒内没有应答，进入 {BACKOFF_SECONDS[0]} 秒退避")

    while True:
        time.sleep(PROBE_INTERVAL)
        # 用户要停：服务（或停止脚本）写了 stop.flag，守护立刻退，别再拉起
        if STOP_FLAG.exists():
            log(f"发现 {STOP_FLAG.name}（用户要停止服务），守护退出，不再拉起服务")
            return
        pid = ping_server()
        if pid:
            if fails:
                log(f"服务已恢复（pid={pid}，此前连续失败 {fails} 次）")
            fails = 0
            attempts = 0
            continue
        fails += 1
        log(f"探活失败（连续 {fails}/{FAIL_THRESHOLD} 次，{PORT} 端口无应答）")
        if fails < FAIL_THRESHOLD:
            continue

        existing, same = find_server_process()
        if existing:
            if time.time() - last_blocked_log > 30:
                last_blocked_log = time.time()
                log(f"连续 {fails} 次探活失败，但已存在 server.py 进程 pid={existing}"
                    f"（同目录={same}），不重复拉起，等它恢复")
            fails = 0
            continue

        wait_s = 0 if attempts == 0 else BACKOFF_SECONDS[min(attempts - 1, len(BACKOFF_SECONDS) - 1)]
        now = time.time()
        if wait_s and now - last_attempt < wait_s:
            log(f"退避中：距上次拉起 {now - last_attempt:.0f}s，本次至少等 {wait_s}s")
            fails = 0
            continue
        last_attempt = now
        log(f"连续 {fails} 次探活失败且没有已存在的服务进程，第 {attempts + 1} 次尝试拉起")
        started = start_and_wait()
        if started:
            log(f"已拉起服务（pid={started}）")
            fails = 0
            attempts = 0
        else:
            attempts += 1
            next_wait = BACKOFF_SECONDS[min(attempts - 1, len(BACKOFF_SECONDS) - 1)]
            log(f"拉起后 {START_WAIT} 秒内没有应答，下次至少等 {next_wait} 秒再试")
            fails = 0


if __name__ == "__main__":
    main()
