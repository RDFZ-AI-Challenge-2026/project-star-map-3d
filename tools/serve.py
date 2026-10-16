#!/usr/bin/env python
"""serve.py — tiny static server for the star map.

Why not `python -m http.server`: that sends no cache headers, so the browser is
free to reuse a stale style.css / main.js and you end up looking at an old page
without knowing it. This one always says "do not cache", so every reload really
is the latest file.

    python tools/serve.py [port] [directory]
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8811
ROOT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web"
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # keep the console quiet unless something went wrong
        code = args[1] if len(args) > 1 else ""
        if str(code).startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        sys.exit("no index.html in %s" % ROOT)
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print("star map  ->  http://127.0.0.1:%d/" % PORT)
        print("serving   %s" % ROOT)
        print("cache     disabled (always the newest file)")
        print("Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped.")
