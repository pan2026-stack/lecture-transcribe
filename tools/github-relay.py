"""临时本地代理：把 github.com 指到当前能连通的 IP，其余原样转发。

用法：
    python tools/github-relay.py 8899 140.82.112.4
    git -c http.proxy=http://127.0.0.1:8899 push origin main
"""
import select
import socket
import sys
import threading

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
GITHUB_IP = sys.argv[2] if len(sys.argv) > 2 else '140.82.112.4'


def pipe(a: socket.socket, b: socket.socket) -> None:
    try:
        while True:
            r, _, _ = select.select([a, b], [], [], 60)
            if not r:
                break
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.close()
            except OSError:
                pass


def handle(conn: socket.socket) -> None:
    try:
        conn.settimeout(30)
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                conn.close()
                return
            buf += chunk
        head = buf.split(b'\r\n\r\n', 1)[0].decode('latin-1')
        lines = head.split('\r\n')
        method, target, _ = lines[0].split(' ', 2)
        if method.upper() != 'CONNECT':
            conn.sendall(b'HTTP/1.1 405 Method Not Allowed\r\n\r\n')
            conn.close()
            return
        host, _, port = target.rpartition(':')
        port = int(port or 443)
        dest = GITHUB_IP if host.endswith('github.com') else host
        upstream = socket.create_connection((dest, port), timeout=15)
        conn.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        conn.settimeout(None)
        upstream.settimeout(None)
        pipe(conn, upstream)
    except Exception:
        try:
            conn.close()
        except OSError:
            pass


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', LISTEN_PORT))
    srv.listen(50)
    print(f'relay 就绪 127.0.0.1:{LISTEN_PORT} → github.com 走 {GITHUB_IP}', flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == '__main__':
    main()
