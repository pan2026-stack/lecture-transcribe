"""Regression tests: no real credentials or upstream API calls are used."""
import concurrent.futures
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        self.gate = threading.Event()
        self.gate.set()
        self.entered = threading.Event()
        self.calls = 0
        self.upstream_error = False
        owner = self

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.calls += 1
                owner.entered.set()
                owner.gate.wait(10)
                if owner.upstream_error:
                    self.send_response(400)
                    body = b'{"error":"provider rejected input"}'
                else:
                    self.send_response(200)
                    content = '<<<ARTICLE>>>\n# 完整讲稿\n测试内容。\n<<<NOTES>>>\n# 笔记\n测试结论。'
                    body = json.dumps({'choices': [{'message': {'content': content},
                                                   'finish_reason': 'stop'}]}).encode()
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        self.provider_thread = threading.Thread(target=self.provider.serve_forever, daemon=True)
        self.provider_thread.start()
        cfg = dict(server.DEFAULT_CONFIG, notes_api_key='test-only-not-a-real-key',
                   notes_base_url=f'http://127.0.0.1:{self.provider.server_port}', notes_timeout=5)
        self.patches = [patch.object(server, 'load_config', return_value=cfg),
                        patch.object(server, 'SESSIONS', self.data / 'sessions'),
                        patch.object(server, 'LOGS', self.data / 'logs'),
                        patch.object(server, 'LOG_PATH', self.data / 'logs/server.log')]
        for p in self.patches:
            p.start()
        with server.NOTES_LOCK:
            server.NOTES_TASKS.clear()
            server.NOTES_PROGRESS.clear()
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        self.payload = {'job': 'regression', 'background': True, 'title': '断线回归',
                        'segments': [{'time': '00:00', 'text': '课堂内容，必须保留。'}]}

    def tearDown(self):
        self.gate.set()
        deadline = time.monotonic() + 12
        while server.ACTIVE_NOTES and time.monotonic() < deadline:
            time.sleep(.02)
        for http, thread in ((self.http, self.thread), (self.provider, self.provider_thread)):
            http.shutdown()
            http.server_close()
            thread.join(2)
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def call(self, path, payload=None):
        req = urllib.request.Request(self.base + path,
                                     data=json.dumps(payload).encode() if payload is not None else None,
                                     headers={'Content-Type': 'application/json'})
        try:
            response = urllib.request.urlopen(req, timeout=3)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.load(response)

    def done(self, job='regression'):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            status, state = self.call('/api/notes-progress?job=' + job)
            self.assertEqual(status, 200)
            if state['stage'] in ('done', 'error'):
                return state
            time.sleep(.03)
        self.fail('background task did not reach a terminal state')

    def test_slow_provider_lost_ack_and_concurrent_retries(self):
        self.gate.clear()
        start = time.monotonic()
        self.assertEqual(self.call('/api/notes', self.payload)[0], 202)
        self.assertLess(time.monotonic() - start, 1)
        self.assertTrue(self.entered.wait(2))
        # Simulate losing the 202 response and retrying the exact same task.
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            statuses = list(pool.map(lambda _: self.call('/api/notes', self.payload)[0], range(8)))
        self.assertEqual(statuses, [202] * 8)
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.call('/api/ping')[1]['ok'], True)
        self.assertNotEqual(self.call('/api/notes-progress?job=regression')[1]['stage'], 'done')
        self.gate.set()
        result = self.done()
        self.assertEqual(result['stage'], 'done')
        for name in ('article_path', 'notes_path'):
            self.assertTrue(Path(result['result'][name]).is_file())
        self.assertEqual(len(list((self.data / 'sessions').glob('*.md'))), 2)
        # A completed task can be attached again without another billable call.
        self.assertEqual(self.call('/api/notes', self.payload)[0], 202)
        self.assertEqual(self.calls, 1)

    def test_conflicting_task_id_is_rejected(self):
        self.call('/api/notes', self.payload)
        conflict = dict(self.payload, title='different content')
        self.assertEqual(self.call('/api/notes', conflict)[0], 409)
        self.assertEqual(self.done()['stage'], 'done')

    def test_upstream_failure_is_terminal_and_not_server_failure(self):
        self.upstream_error = True
        self.assertEqual(self.call('/api/notes', self.payload)[0], 202)
        state = self.done()
        self.assertEqual(state['stage'], 'error')
        self.assertIn('400', state['error'])
        self.assertTrue(self.call('/api/ping')[1]['ok'])
        self.assertEqual(self.calls, 1)

    def test_sync_api_remains_compatible(self):
        payload = dict(self.payload, background=False)
        status, result = self.call('/api/notes', payload)
        self.assertEqual(status, 200)
        self.assertTrue(Path(result['notes_path']).is_file())

    def test_long_transcript_completes_all_chunks(self):
        payload = dict(self.payload, job='long', segments=[
            {'time': f'00:{i:02d}', 'text': '课堂理论与例子。' * 800} for i in range(5)])
        self.assertEqual(self.call('/api/notes', payload)[0], 202)
        self.assertEqual(self.done('long')['stage'], 'done')
        self.assertGreater(self.calls, 2)

    def test_watchdog_never_exits_without_supervisor(self):
        server.WATCHDOG['fails'] = 0
        server.LAST_ACTIVITY[0] = time.time() - 1000
        with patch.object(server, '_probe_outbound', return_value=False), patch.dict(
                'os.environ', {'DICT_SUPERVISED': '', 'DICT_PROBE_FAILS': '1'}):
            for _ in range(4):
                self.assertFalse(server._watchdog_tick())

    def test_watchdog_protects_job_without_progress_id(self):
        self.gate.clear()
        payload = dict(self.payload, background=False, job='')
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(self.call, '/api/notes', payload)
            self.assertTrue(self.entered.wait(2))
            server.LAST_ACTIVITY[0] = time.time() - 1000
            with patch.object(server, '_probe_outbound', return_value=False), patch.dict(
                    'os.environ', {'DICT_SUPERVISED': '1', 'DICT_PROBE_FAILS': '1'}):
                self.assertFalse(server._watchdog_tick())
            self.gate.set()
            self.assertEqual(future.result()[0], 200)

    def test_progress_cleanup_preserves_active_lecture(self):
        server.NOTES_PROGRESS['long-running'] = {'stage': 'article', 'at': time.time() - 90000}
        server._progress('new-job', stage='start')
        self.assertIn('long-running', server.NOTES_PROGRESS)


if __name__ == '__main__':
    unittest.main(verbosity=2)
