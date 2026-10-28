"""一键更新并推送到 GitHub。

做的事：把项目里的代码同步到镜像仓库 → 有改动就提交 → 挑一个能连通的
GitHub IP（必要时本地起中转）推送。推完自动清理。

    python tools/push-github.py                    # 自动生成提交信息
    python tools/push-github.py "这次改了什么"       # 指定提交信息
"""
import os
import shutil
import socket
import subprocess
import sys
import threading

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.join(os.path.dirname(PROJECT), 'lecture-notes-repo')

# 需要同步到仓库的文件/目录（其余靠 .gitignore 排除）
SYNC_FILES = ['server.py', 'app.js', 'index.html', 'style.css', 'export.py', 'speaker.py',
              'cli.py', 'VERSION', 'README.md', 'PACKAGING.md', 'SKILL.md', 'requirements.txt',
              'config.example.json', 'make-portable.py', 'make-share.py', 'make-debug.py',
              'qa.js', 'smoke.py', 'record.js', 'app.ico', '.gitignore',
              '修复与自测说明.md', '启动-调试.bat']
SYNC_DIRS = ['emotion-ball', 'tests']
SYNC_TOOLS = ['qa.js', 'smoke.py', 'push-github.py', 'eslint.config.mjs']
SKIP_DIR_NAMES = {'node_modules', '__pycache__', 'shots', 'ruffpy', '_probe', 'portable'}

CANDIDATES = ['140.82.112.4', '140.82.113.4', '140.82.114.4',
              '140.82.112.3', '140.82.113.3', '140.82.114.3', '20.205.243.166']


def tcp_ok(host, port=443, timeout=2.5):
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except OSError:
        return False


def pick_ip():
    try:
        dns_ip = socket.gethostbyname('github.com')
    except OSError:
        dns_ip = None
    if dns_ip and tcp_ok(dns_ip):
        return dns_ip, True
    for ip in CANDIDATES:
        if ip != dns_ip and tcp_ok(ip):
            return ip, False
    return None, False


def start_relay(ip):
    import select

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', 0))
    srv.listen(50)
    port = srv.getsockname()[1]

    def pipe(a, b):
        try:
            while True:
                ready, _, _ = select.select([a, b], [], [], 60)
                if not ready:
                    break
                for sock in ready:
                    data = sock.recv(65536)
                    if not data:
                        return
                    (b if sock is a else a).sendall(data)
        except OSError:
            pass
        finally:
            for sock in (a, b):
                try:
                    sock.close()
                except OSError:
                    pass

    def handle(conn):
        try:
            conn.settimeout(30)
            buf = b''
            while b'\r\n\r\n' not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    conn.close()
                    return
                buf += chunk
            method, target = buf.split(b'\r\n', 1)[0].decode('latin-1').split(' ')[:2]
            if method.upper() != 'CONNECT':
                conn.sendall(b'HTTP/1.1 405 Method Not Allowed\r\n\r\n')
                conn.close()
                return
            host, _, port_s = target.rpartition(':')
            dest = ip if host.endswith('github.com') else host
            up = socket.create_connection((dest, int(port_s or 443)), timeout=15)
            conn.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
            conn.settimeout(None)
            up.settimeout(None)
            pipe(conn, up)
        except Exception:
            try:
                conn.close()
            except OSError:
                pass

    def serve():
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            threading.Thread(target=handle, args=(conn,), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    return port, srv


def git(*args, env=None):
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    r = subprocess.run(['git', *args], cwd=REPO, env=full_env,
                       capture_output=True, text=True, encoding='utf-8', errors='ignore')
    out = ((r.stdout or '') + (r.stderr or '')).strip()
    if out:
        for line in out.splitlines():
            print('   ', line.strip())
    return r.returncode


def sync():
    if not os.path.isdir(REPO):
        print('找不到镜像仓库:', REPO)
        return False
    copied = 0
    for name in SYNC_FILES:
        src = os.path.join(PROJECT, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(REPO, name))
            copied += 1
    for d in SYNC_DIRS:
        src_dir = os.path.join(PROJECT, d)
        if not os.path.isdir(src_dir):
            continue
        dst_dir = os.path.join(REPO, d)
        for root, dirs, files in os.walk(src_dir):
            dirs[:] = [x for x in dirs if x not in SKIP_DIR_NAMES]
            rel = os.path.relpath(root, src_dir)
            target = dst_dir if rel == '.' else os.path.join(dst_dir, rel)
            os.makedirs(target, exist_ok=True)
            for f in files:
                shutil.copy2(os.path.join(root, f), os.path.join(target, f))
                copied += 1
    tools_dst = os.path.join(REPO, 'tools')
    os.makedirs(tools_dst, exist_ok=True)
    for name in SYNC_TOOLS:
        src = os.path.join(PROJECT, 'tools', name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(tools_dst, name))
            copied += 1
    print(f'已同步 {copied} 个文件到镜像仓库')
    return True


def main():
    message = sys.argv[1] if len(sys.argv) > 1 else ''
    if not sync():
        return 1

    status = subprocess.run(['git', 'status', '--porcelain'], cwd=REPO,
                            capture_output=True, text=True,
                            encoding='utf-8', errors='ignore').stdout
    if status.strip():
        if not message:
            names = [ln[3:].strip() for ln in status.strip().splitlines()[:3]]
            message = '更新：' + '，'.join(names)
        print('提交：', message)
        git('add', '-A')
        if git('commit', '-m', message) != 0:
            print('提交失败')
            return 1
    else:
        print('没有新改动，直接检查推送')

    ip, direct = pick_ip()
    if not ip:
        print('候选 IP 全都不通，先检查网络')
        return 1

    if direct:
        print(f'github.com 解析可用（{ip}），直接推送')
        if git('push', 'origin', 'main') == 0:
            print('已推送')
            return 0
        print('直连失败，改走中转')

    print(f'用 {ip} 起本地中转…')
    port, srv = start_relay(ip)
    env = {'HTTPS_PROXY': f'http://127.0.0.1:{port}',
           'HTTP_PROXY': f'http://127.0.0.1:{port}',
           'GIT_TERMINAL_PROMPT': '0'}
    try:
        code = git('push', 'origin', 'main', env=env)
        print('已推送' if code == 0 else '推送失败（见上方 git 输出）')
        return code
    finally:
        srv.close()


if __name__ == '__main__':
    sys.exit(main())
