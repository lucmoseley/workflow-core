"""test_fail_open.py — the reporters base §N5's Python fail-opens call (#5487,
#5503): `fail_open` prints the error and what the program does instead, to
stderr alone; `tallied` counts it and `expected` takes it, both silently.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collections import Counter

from fail_open import expected, fail_open, tallied


def test_it_prints_the_error_and_the_fallback_to_stderr(capsys):
    fail_open(FileNotFoundError(2, "No such file", "x.json"), "x.json read as empty")
    out, err = capsys.readouterr()
    assert out == ""
    assert err == (
        "fail-open: x.json read as empty: FileNotFoundError: "
        "[Errno 2] No such file: 'x.json'\n"
    )


def test_tallied_counts_under_its_key_and_prints_nothing(capsys):
    tally = Counter()
    tallied(ValueError("x"), tally, "unparsed lines")
    tallied(ValueError("y"), tally, "unparsed lines")
    assert tally == Counter({"unparsed lines": 2})
    assert capsys.readouterr() == ("", "")


def test_expected_prints_nothing(capsys):
    expected(ChildProcessError(10, "No child processes"), "no child left")
    assert capsys.readouterr() == ("", "")
