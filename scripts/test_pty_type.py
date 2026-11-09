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
    assert "drew nothing or exited before the text" in r.stderr


def test_a_bad_command_line_is_refused():
    r = run("resume")
    assert r.returncode == 2
    assert "pty_type.py <text> -- <command>" in r.stderr
