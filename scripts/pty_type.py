#!/usr/bin/env python3
"""pty_type.py — type one line into a command that reads only from a terminal.

The refill loop types its API-error resume into a live background session
through `claude attach`, which needs a TTY (workflow-core#2354 F6, workflow-core#2705). This runs the
command on a pseudo-terminal, waits for its screen to settle, types the text
as a bracketed paste and then Enter in a separate write, then ends the command
with SIGTERM. Text and Enter in one chunk of about 61 bytes or more is taken as
a paste, its Enter a newline, and nothing is sent (workflow-core#4659 F7). `claude attach` leaves the
session running either way. It drives a TUI by keys, so a change to that TUI
can break it: the caller checks the session's timeline for the typed line.

USAGE
  python3 {script} <text> -- <command> [args...]

Exit 0 once the text and Enter are written; 1 where the command drew nothing
or exited first; 2 on a bad command line.
"""

import os
import pty
import select
import shlex
import signal
import sys
import time

# Untraced: this long with no output counts as drawn.
SETTLE_S = 1.0
# Untraced: a TUI that has drawn nothing by now never will. lib/claude-attach.js's
# ATTACH_TIMEOUT_MS must outlast it plus AFTER_ENTER_S.
DRAW_MAX_S = 15.0
# Untraced: time for the TUI to hand the line on before the command is ended.
AFTER_ENTER_S = 2.0
# The gap between the paste and its Enter, as Claude Code's own `[bg]` reply
# code writes them (workflow-core#4659 F7).
PASTE_TO_ENTER_S = 0.01
PASTE_OPEN = b"\x1b[200~"
PASTE_CLOSE = b"\x1b[201~"
# Untraced: how often the read wakes to check the clocks, well under SETTLE_S.
POLL_S = 0.1


def drain(fd, quiet, limit):
    """Read `fd` until it has drawn and then been quiet for `quiet` seconds, or
    `limit` passes. Return (bytes read, whether the command is still there)."""
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
        except OSError:
            # EIO is how a pty master reads once the command has exited (workflow-core#2705).
            return seen, False
        if not chunk:
            return seen, False
        seen += len(chunk)
        last = time.monotonic()


def main(argv):
    if len(argv) < 3 or argv[1] != "--":
        usage = __doc__.split("USAGE\n")[1].split("\n\n")[0]
        sys.stderr.write(usage.format(script=shlex.quote(sys.argv[0])) + "\n")
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
        except ProcessLookupError:
            # Already exited (workflow-core#2705).
            pass
        os.waitpid(pid, 0)
        os.close(fd)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
