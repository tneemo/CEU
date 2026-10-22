"""Offline regression checks for public-source startup and HTTP boundaries."""
import http.client
from contextlib import closing
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server import code_tools, main


class StaticTests(unittest.TestCase):
    def test_static_and_origin_boundaries(self):
        with tempfile.TemporaryDirectory(prefix="ceu-http-") as tmp:
            root = Path(tmp) / "web"
            root.mkdir()
            (root / "index.html").write_text("<h1>CEU fixture</h1>", encoding="utf-8")
            sibling = Path(tmp) / "web-private"
            sibling.mkdir()
            (sibling / "secret.txt").write_text("private fixture", encoding="utf-8")
            with patch.object(main, "WEB", str(root)), main.Server(("127.0.0.1", 0), main.Handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                port = server.server_address[1]

                def request(path, headers=None, method="GET"):
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    try:
                        conn.request(method, path, headers=headers or {})
                        response = conn.getresponse()
                        return response.status, response.read()
                    finally:
                        conn.close()

                try:
                    self.assertEqual(request("/")[0], 200)
                    self.assertIn(b"CEU fixture", request("/c/example")[1])
                    self.assertEqual(json.loads(request("/api/health")[1])["app"], "CEU")
                    for path in ("/../web-private/secret.txt", "/%2e%2e/web-private/secret.txt",
                                 "/..%5cweb-private%5csecret.txt"):
                        status, body = request(path)
                        self.assertEqual(status, 404, path)
                        self.assertNotIn(b"private fixture", body)
                    self.assertEqual(request("/api/health", {"Host": f"attacker.example:{port}"})[0], 403)
                    self.assertEqual(request("/api/health", {"Origin": "https://attacker.example"})[0], 403)
                    self.assertEqual(request("/api/health", {"Origin": f"http://localhost:{port}",
                                                            "Host": f"localhost:{port}"})[0], 200)
                    self.assertEqual(request("/api/health", {"Origin": "http://localhost:5173"})[0], 200)
                    self.assertEqual(request("/api/health", {"Host": "attacker.example"}, "OPTIONS")[0], 403)
                finally:
                    server.shutdown()
                    thread.join(timeout=5)

    def test_frontend_selection(self):
        with tempfile.TemporaryDirectory(prefix="ceu-web-") as tmp, patch.object(main, "ROOT", tmp):
            self.assertEqual(main.web_root(), os.path.join(tmp, "web"))
            built = Path(tmp) / "web-app" / "dist"
            built.mkdir(parents=True)
            (built / "index.html").write_text("React fixture", encoding="utf-8")
            self.assertEqual(main.web_root(), str(built))
            self.assertEqual(main.web_root("legacy"), os.path.join(tmp, "web"))


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class StartupTests(unittest.TestCase):
    def test_duplicate_start_preserves_streams_and_lock_releases(self):
        with tempfile.TemporaryDirectory(prefix="ceu-startup-") as tmp:
            env = {**os.environ, "CEU_DATA_DIR": tmp, "PYTHONIOENCODING": "utf-8"}
            # Exercise actual main startup, without vendor probes, models or scheduler work.
            driver = ("from server import main; main.seed_providers=lambda: None; "
                      "main.integrations.warm=lambda: None; main.agent_mode.start_scheduler=lambda: None; main.main()")

            def launch(port):
                return subprocess.Popen([sys.executable, "-c", driver, "--port", str(port)],
                                        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

            def ready(proc, port):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        self.fail(proc.stderr.read().decode("utf-8", errors="replace"))
                    try:
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                        conn.request("GET", "/api/health")
                        response = conn.getresponse()
                        if json.loads(response.read())["app"] == "CEU":
                            return
                    except (OSError, ValueError):
                        time.sleep(0.05)
                    finally:
                        conn.close()
                self.fail("CEU did not become ready")

            port = free_port()
            proc = launch(port)
            try:
                ready(proc, port)
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                try:
                    conn.request("GET", "/api/suggestions")
                    self.assertEqual(json.loads(conn.getresponse().read()), {"items": []})
                finally:
                    conn.close()
                with closing(sqlite3.connect(Path(tmp) / "app.db")) as database:
                    database.execute("INSERT INTO conversations (id, created_at, updated_at) VALUES ('test', 0, 0)")
                    database.execute("INSERT INTO messages (id, conversation_id, role, status, created_at) "
                                     "VALUES ('stream', 'test', 'assistant', 'streaming', 0)")
                    database.commit()
                for other_port in (port, free_port()):
                    other = launch(other_port)
                    _, stderr = other.communicate(timeout=15)
                    self.assertNotEqual(other.returncode, 0)
                    self.assertIn("pasta de dados", stderr.decode("utf-8"))
                    with closing(sqlite3.connect(Path(tmp) / "app.db")) as database:
                        self.assertEqual(database.execute("SELECT status FROM messages WHERE id='stream'").fetchone()[0],
                                         "streaming")
            finally:
                code_tools.kill_tree(proc)
                proc.wait(timeout=10)
                stderr = proc.stderr.read()
                proc.stderr.close()
            self.assertNotIn(b"Traceback", stderr, "First-run suggestions must not raise background errors")

            # The lock is released even after process termination; recovery now runs once.
            proc = launch(port)
            try:
                ready(proc, port)
                with closing(sqlite3.connect(Path(tmp) / "app.db")) as database:
                    self.assertEqual(database.execute("SELECT status FROM messages WHERE id='stream'").fetchone()[0],
                                     "stopped")
            finally:
                code_tools.kill_tree(proc)
                proc.wait(timeout=10)
                proc.stderr.close()

    def test_occupied_port_does_not_initialize_database(self):
        with tempfile.TemporaryDirectory(prefix="ceu-port-") as tmp, socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            result = subprocess.run([sys.executable, "-m", "server.main", "--port", str(sock.getsockname()[1])],
                                    cwd=ROOT, env={**os.environ, "CEU_DATA_DIR": tmp},
                                    capture_output=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((Path(tmp) / "app.db").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
