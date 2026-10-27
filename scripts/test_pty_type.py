"""Tests for pty_type.py (#2705), against a stand-in command on a real
pseudo-terminal.

The stand-in prompts, refuses to read unless stdin is a terminal, and writes
the line it reads to a file: what `claude attach` needs, without a daemon.
Drop the terminal check and the test no longer proves a TTY was given; loosen
the rest and the refill loop's typed resume can fail while reporting success,
so no fallback to stop and resume runs.
"""

import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).with_name("pty_type.py")

READER = (
    "import sys, os\n"
    "assert os.isatty(0), 'no tty'\n"
    "sys.stdout.write('> '); sys.stdout.flush()\n"
    "open(sys.argv[1], 'w').write(sys.stdin.readline())\n"
)


def run(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_types_the_line_into_a_command_that_needs_a_terminal(tmp_path):
    out = tmp_path / "line"
    r = run("resume — check first", "--", sys.executable, "-c", READER, str(out))
    assert r.returncode == 0, r.stderr
    assert out.read_text() == "resume — check first\n"


def test_a_command_that_exits_without_drawing_is_a_failure():
    r = run("resume", "--", sys.executable, "-c", "pass")
    assert r.returncode == 1
    assert "drew nothing or exited before the text" in r.stderr


def test_a_bad_command_line_is_refused():
    r = run("resume")
    assert r.returncode == 2
    assert "pty_type.py <text> -- <command>" in r.stderr
