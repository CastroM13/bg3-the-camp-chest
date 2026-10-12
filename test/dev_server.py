"""Local test server: serves site/ at / and, for automated tests on this machine only, a BG3 Data folder at
/__bg3data/ (HTTP Range, plus /__bg3data/<dir>/?list for directory listings). Binds to 127.0.0.1.
usage: python -I test/dev_server.py <site dir> <BG3 Data dir> [port]"""
import json, os, re, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

SITE, DATA = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8772
PREFIX = "/__bg3data/"


class H(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript", ".md": "text/plain; charset=utf-8"}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=SITE, **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass

    def do_GET(self):
        if not self.path.startswith(PREFIX):
            return super().do_GET()
        rel, _, query = unquote(self.path[len(PREFIX):]).partition("?")
        path = os.path.abspath(os.path.join(DATA, rel))
        if not path.startswith(DATA):
            return self.send_error(403)
        if query == "list":
            if not os.path.isdir(path):
                return self.send_error(404)
            body = json.dumps([{"name": n, "kind": "directory" if os.path.isdir(os.path.join(path, n)) else "file"} for n in os.listdir(path)]).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            return self.wfile.write(body)
        if not os.path.isfile(path):
            return self.send_error(404)
        size = os.path.getsize(path)
        m = re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        start, end = (int(m.group(1)), int(m.group(2)) if m.group(2) else size - 1) if m else (0, size - 1)
        end = min(end, size - 1)
        self.send_response(206 if m else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("X-File-Size", str(size))
        self.send_header("X-Last-Modified", str(int(os.path.getmtime(path) * 1000)))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(left, 1 << 20))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
