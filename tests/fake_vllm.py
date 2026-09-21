#!/usr/bin/env python3
"""
A stand-in for `vllm serve`, so the launcher's duties can be tested without a
GPU: it answers /health and /sleep on the requested port and nothing else.

Knobs (env):
  FAKE_VLLM_READY_AFTER    seconds before /health starts answering 200 (0)
  FAKE_VLLM_NEVER_READY    "1" keeps /health answering 503 forever
  FAKE_VLLM_EXIT_CODE      exit code on SIGTERM (0)
  FAKE_VLLM_EVENT_LOG      file every event is appended to, one JSON per line
  FAKE_VLLM_IGNORE_SIGTERM "1" makes it deaf to SIGTERM, as a wedged engine is
"""

import json
import os
import signal
import sys
import threading
import time

from http.server import BaseHTTPRequestHandler, HTTPServer
from types import FrameType
from typing import Any

START: float = time.monotonic()
READY_AFTER: float = float(os.environ.get("FAKE_VLLM_READY_AFTER", "0"))
NEVER_READY: bool = os.environ.get("FAKE_VLLM_NEVER_READY", "") == "1"
EXIT_CODE: int = int(os.environ.get("FAKE_VLLM_EXIT_CODE", "0"))
EVENT_LOG: str = os.environ.get("FAKE_VLLM_EVENT_LOG", "")


def record(event: str, **fields: Any) -> None:
    if not EVENT_LOG:
        return
    payload: dict[str, Any] = {"event": event, "at": time.time(), **fields}
    with open(EVENT_LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + "\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _respond(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.startswith("/health"):
            ready: bool = not NEVER_READY and (time.monotonic() - START) >= READY_AFTER
            self._respond(200 if ready else 503)
            return
        self._respond(404)

    def do_POST(self) -> None:
        if self.path.startswith("/sleep"):
            record("sleep", path=self.path, model=MODEL)
            self._respond(200)
            return
        self._respond(404)


def on_sigterm(_signum: int, _frame: FrameType | None) -> None:
    record("sigterm", model=MODEL)
    sys.exit(EXIT_CODE)


if __name__ == "__main__":
    argv: list[str] = sys.argv[1:]
    MODEL = argv[1] if len(argv) > 1 else "<none>"
    port: int = 8000
    for arg in argv:
        if arg.startswith("--port="):
            port = int(arg.split("=", 1)[1])
    record("start", model=MODEL, argv=argv, port=port)
    if os.environ.get("FAKE_VLLM_IGNORE_SIGTERM", "") == "1":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    else:
        signal.signal(signal.SIGTERM, on_sigterm)
    server: HTTPServer = HTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    while True:
        time.sleep(3600)
