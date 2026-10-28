"""Local-only application fixture for browser recovery tests."""
import json
from pathlib import Path
import sys
import tempfile
import time
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

state = {'calls': 0, 'fail': False, 'delay': 18}


def chat(cfg, messages, max_tokens):
    state['calls'] += 1
    if state['fail']:
        raise RuntimeError('模拟上游拒绝请求')
    time.sleep(state['delay'])
    return '<<<ARTICLE>>>\n# 完整讲稿\n二叉树的中序遍历。\n<<<NOTES>>>\n# 课堂笔记\n先左子树，再根节点，最后右子树。'


class Handler(server.Handler):
    def do_GET(self):
        if self.path.startswith('/__test/state'):
            return self._json(200, state)
        if self.path == '/__test/fail':
            state['fail'] = True
            return self._json(200, state)
        return super().do_GET()


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as tmp:
        server.DATA = Path(tmp)
        server.SESSIONS = Path(tmp) / 'sessions'
        server.LOGS = Path(tmp) / 'logs'
        server.LOG_PATH = server.LOGS / 'server.log'
        server.CONFIG_PATH = Path(tmp) / 'config.json'
        cfg = dict(server.DEFAULT_CONFIG, api_key='browser-test-only', notes_api_key='browser-test-only')
        server.load_config = lambda: dict(cfg)
        server._notes_chat_full = chat
        server.chatter = lambda payload: {'line': ''}
        server.health = lambda: {'asr': {'ok': True}, 'notes': {'ok': True}}
        server._probe_outbound = lambda: False
        http = ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Handler)
        print('READY', flush=True)
        http.serve_forever()
