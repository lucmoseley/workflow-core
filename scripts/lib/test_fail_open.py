"""test_fail_open.py — the reporter base §N5's Python fail-opens call (#5487):
it prints the error and what the program does instead, to stderr alone.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fail_open import fail_open


def test_it_prints_the_error_and_the_fallback_to_stderr(capsys):
    fail_open(FileNotFoundError(2, "No such file", "x.json"), "x.json read as empty")
    out, err = capsys.readouterr()
    assert out == ""
    assert err == (
        "fail-open: x.json read as empty: FileNotFoundError: "
        "[Errno 2] No such file: 'x.json'\n"
    )
