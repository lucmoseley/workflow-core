"""Tests for write-secret.js's hidden prompt (#3817), on a real pseudo-terminal.

`scripts/lib/read-hidden.test.ts` splits input across reads with a fake
terminal; only a pty shows what reaches the screen and what stays queued for
the shell. Loosen a case and the rest of a pasted key lands in the founder's
shell and its history, or a closed terminal reads as success.

The child gets no controlling terminal, so closing the master reaches it as a
read error and not as SIGHUP.
"""

import os
import pty
import select
import subprocess
import termios
import time
import tty
from pathlib import Path

SCRIPT = Path(__file__).with_name("write-secret.js")
# What the prompt reads through, named for the test selector (base §X10).
READER = "lib/read-hidden.js"

# Untraced: far past any healthy run of a script that exits under a second.
EXIT_S = 30
# Untraced: how often to look for raw mode; well under a prompt's start-up.
POLL_S = 0.01
# Untraced: a screen quiet this long, after the exit, holds all it will.
SCREEN_QUIET_S = 0.1


class Prompt:
    """write-secret.js at its hidden prompt, on a pty, storing under `tmp_path`."""

    def __init__(self, tmp_path):
        self.store = tmp_path / "secrets.env"
        tmp_path.chmod(0o700)
        self.master, self.slave = pty.openpty()
        self.process = subprocess.Popen(
            ["node", str(SCRIPT), "K"],
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            env={**os.environ, "WFC_SECRETS_FILE": str(self.store)},
        )
        deadline = time.monotonic() + EXIT_S
        while termios.tcgetattr(self.slave)[3] & termios.ICANON:
            assert time.monotonic() < deadline, "the prompt never entered raw mode"
            assert self.process.poll() is None, "exited before the prompt"
            time.sleep(POLL_S)

    def finish(self, data):
        """Type `data`, wait for the exit, return (exit, screen, bytes left queued)."""
        os.write(self.master, data)
        code = self.process.wait(timeout=EXIT_S)
        return code, self.read_screen(), self.read_queued()

    def read_queued(self):
        """What a shell would read next. TCSANOW, as setraw's default flushes it."""
        tty.setraw(self.slave, termios.TCSANOW)
        os.set_blocking(self.slave, False)
        try:
            return os.read(self.slave, 4096)
        except BlockingIOError:
            return b""

    def read_screen(self):
        out = b""
        while select.select([self.master], [], [], SCREEN_QUIET_S)[0]:
            out += os.read(self.master, 4096)
        return out.decode()


def refused_clean(prompt, data, why):
    code, screen, left = prompt.finish(data)
    assert code == 2, screen
    assert why in screen
    assert "re-run" in screen.lower()
    assert not prompt.store.exists()
    assert left == b""


def test_stores_one_line(tmp_path):
    prompt = Prompt(tmp_path)
    code, screen, left = prompt.finish(b"plain-test-value\r")
    assert code == 0, screen
    assert prompt.store.read_text() == "K=plain-test-value\n"
    assert "plain-test-value" not in screen
    assert left == b""


def test_stores_a_line_pasted_with_its_crlf(tmp_path):
    prompt = Prompt(tmp_path)
    code, screen, left = prompt.finish(b"plain-test-value\r\n")
    assert code == 0, screen
    assert prompt.store.read_text() == "K=plain-test-value\n"
    assert left == b""


def test_a_multi_line_paste_stores_nothing_and_leaves_nothing_for_the_shell(tmp_path):
    prompt = Prompt(tmp_path)
    os.write(prompt.master, b"-----BEGIN KEY-----\r")
    code, screen, left = prompt.finish(b"MIIEsecondline\r-----END KEY-----\r")
    assert code == 2, screen
    assert "more input followed the line end" in screen
    assert "Re-run" in screen
    assert "MIIE" not in screen
    assert "BEGIN" not in screen
    assert not prompt.store.exists()
    assert left == b""


def test_the_queue_check_sees_what_a_shell_would_read(tmp_path):
    prompt = Prompt(tmp_path)
    prompt.finish(b"plain-test-value\r")
    os.write(prompt.master, b"typed-after-exit\n")
    assert b"typed-after-exit" in prompt.read_queued()


def test_a_tab_refuses_by_name(tmp_path):
    refused_clean(Prompt(tmp_path), b"a\tb\r", "a tab, a control key")


def test_ctrl_d_mid_value_refuses(tmp_path):
    refused_clean(Prompt(tmp_path), b"sk-trunc\x04", "Ctrl-D ended the input")


def test_a_pem_header_alone_refuses(tmp_path):
    refused_clean(Prompt(tmp_path), b"-----BEGIN KEY-----\r", "first line of a PEM")


def test_ctrl_c_refuses_as_interrupted(tmp_path):
    refused_clean(Prompt(tmp_path), b"abc\x03", "interrupted")


def test_bytes_not_utf8_refuse_by_name_not_as_interrupted(tmp_path):
    refused_clean(Prompt(tmp_path), b"caf\xe9\r", "not valid UTF-8")


def test_a_closed_terminal_refuses_with_nothing_stored(tmp_path):
    prompt = Prompt(tmp_path)
    os.write(prompt.master, b"partial")
    os.close(prompt.slave)
    os.close(prompt.master)
    assert prompt.process.wait(timeout=EXIT_S) == 2
    assert not prompt.store.exists()
