#!/usr/bin/env python3

import errno
import os
import pty
import select
import shlex
import signal
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from fail_open import expected

USAGE = "  python3 {script} <text> -- <command> [args...]"
SETTLE_S = 1.0  # #2705 guess
DRAW_MAX_S = 15.0  # #2705 guess, below claude-attach.js ATTACH_TIMEOUT_MS
AFTER_ENTER_S = 2.0  # #2705 guess
PASTE_TO_ENTER_S = 0.01  # #4659 measured: Claude Code's own `[bg]` reply gap
PASTE_OPEN = b"\x1b[200~"
PASTE_CLOSE = b"\x1b[201~"
POLL_S = 0.1  # #2705 guess, well under SETTLE_S


def drain(fd, quiet, limit):
    seen = 0
    start = last = time.monotonic()
    while True:
        now = time.monotonic()
        if now - start >= limit or (seen and now - last >= quiet):
            return seen, True
        ready, _, _ = select.select([fd], [], [], POLL_S)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError as e:
            if e.errno != errno.EIO:
                raise
            return seen, False
        if not chunk:
            return seen, False
        seen += len(chunk)
        last = time.monotonic()


def main(argv):
    if len(argv) < 3 or argv[1] != "--":
        sys.stderr.write(USAGE.format(script=shlex.quote(sys.argv[0])) + "\n")
        return 2
    text, cmd = argv[0], argv[2:]
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(cmd[0], cmd)
        finally:
            os._exit(127)
    try:
        seen, alive = drain(fd, SETTLE_S, DRAW_MAX_S)
        if not seen or not alive:
            sys.stderr.write(f"{cmd[0]} drew nothing or exited before the text\n")
            return 1
        os.write(fd, PASTE_OPEN + text.encode() + PASTE_CLOSE)
        time.sleep(PASTE_TO_ENTER_S)
        os.write(fd, b"\r")
        drain(fd, AFTER_ENTER_S, AFTER_ENTER_S)
        return 0
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError as e:
            expected(e, f"pid {pid} already exited")
        os.waitpid(pid, 0)
        os.close(fd)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
