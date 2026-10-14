#!/usr/bin/env python3
"""Tiny read-only online-status lookup for the landing page's saved computers.

GET /status?ids=123456789,staff-rajesh -> {"123456789": {"id": "123456789", "online": true}, ...}
Aliases (set by the admin on a device) resolve to the numeric ID. Only IDs that are asked for are returned.
"""
import json
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DB = "/opt/bainsla-remote/api/release/data/rustdeskapi.db"
ONLINE_WINDOW = 90
MAX_IDS = 30
VALID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$")


def lookup(keys):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)
    try:
        now = int(time.time())
        out = {}
        for k in keys:
            row = con.execute(
                "SELECT id, last_online_time FROM peers WHERE id = ? OR (alias <> '' AND lower(alias) = lower(?)) LIMIT 1",
                (k, k),
            ).fetchone()
            if row:
                out[k] = {"id": row[0], "online": bool(row[1]) and now - int(row[1]) <= ONLINE_WINDOW}
            else:
                out[k] = {"id": k if k.isdigit() else None, "online": False}
        return out
    finally:
        con.close()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path)
        if u.path != "/status":
            return self.send_error(404)
        raw = parse_qs(u.query).get("ids", [""])[0]
        keys = [k.replace(" ", "") for k in raw.split(",") if k.strip()][:MAX_IDS]
        keys = [k for k in keys if VALID.match(k)]
        try:
            body = json.dumps(lookup(keys)).encode()
        except sqlite3.Error:
            return self.send_error(503)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 21120), Handler).serve_forever()
