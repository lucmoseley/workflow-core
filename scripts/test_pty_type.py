"""Tests for pty_type.py (#2705), against a stand-in command on a real
pseudo-terminal.

The stand-in prompts, refuses to read unless stdin is a terminal, reads raw
bytes as a TUI does, and writes each chunk it read and the line a lone Enter
submitted to a file: what `claude attach` needs, without a daemon. Drop the
terminal check and the test no longer proves a TTY was given; loosen the chunk
check and a resume Claude Code takes as an unsent paste passes (#4659 F7);
loosen the rest and the refill loop's typed resume can fail while reporting
success, so no fallback to stop and resume runs.
"""

import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).with_name("pty_type.py")

READER = r"""
import json, os, sys, tty
assert os.isatty(0), 'no tty'
tty.setraw(0)
sys.stdout.write('> '); sys.stdout.flush()
chunks, line = [], b''
while True:
    chunk = os.read(0, 4096)
    chunks.append(chunk.decode('latin-1'))
    if chunk == b'\r':
        break
    line += chunk
line = line.removeprefix(b'\x1b[200~').removesuffix(b'\x1b[201~')
json.dump({'chunks': chunks, 'line': line.decode()}, open(sys.argv[1], 'w'))
"""


def run(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_types_the_line_as_a_paste_then_a_separate_enter(tmp_path):
    out = tmp_path / "line"
    text = "resume — check first"
    r = run(text, "--", sys.executable, "-c", READER, str(out))
    assert r.returncode == 0, r.stderr
    got = json.loads(out.read_text())
    frame = f"\x1b[200~{text}\x1b[201~".encode().decode("latin-1")
    assert got["chunks"] == [frame, "\r"]
    assert got["line"] == text


def test_a_command_that_exits_without_drawing_is_a_failure():
    r = run("resume", "--", sys.executable, "-c", "pass")
    assert r.returncode == 1
    assert r.stderr == f"{sys.executable} drew nothing or exited before the text\n"


def test_a_command_gone_before_its_sigterm_is_taken_as_exited():
    # A fresh interpreter, as pty.fork in pytest's threaded process risks a
    # deadlocked child.
    driver = (
        "import os, sys; sys.path.insert(0, sys.argv[1]); import pty_type\n"
        "def kill(pid, sig): raise ProcessLookupError('no such process')\n"
        "os.kill = kill\n"
        "sys.exit(pty_type.main(['resume', '--', sys.executable, '-c', 'pass']))\n"
    )
    r = subprocess.run(
        [sys.executable, "-c", driver, str(SCRIPT.parent)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert r.returncode == 1
    assert r.stderr == f"{sys.executable} drew nothing or exited before the text\n"


def test_a_bad_command_line_is_refused():
    r = run("resume")
    assert r.returncode == 2
    assert "pty_type.py <text> -- <command>" in r.stderr


def test_a_read_error_other_than_eio_is_raised():
    driver = (
        "import errno, os, sys; sys.path.insert(0, sys.argv[1]); import pty_type\n"
        "def read(fd, n): raise OSError(errno.EBADF, 'bad fd')\n"
        "os.read = read\n"
        "sys.exit(pty_type.main(['resume', '--', sys.executable, '-c', 'import time; time.sleep(1)']))\n"
    )
    r = subprocess.run(
        [sys.executable, "-c", driver, str(SCRIPT.parent)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert r.returncode == 1
    assert "OSError: [Errno 9] bad fd" in r.stderr
