"""test_swallowed_errors.py — the cases of the base §N5 walk every repo's
pre-commit runs (`swallowed_errors.py`, #1830, #5487): what a swallow is, and
the keys the judge counts by.

Loosen one and a swallow lands unrefused in every repo the plugin runs in. The
core's whole tree is the python CI job's
`node scripts/check-swallowed-errors.js --all`, through the gate's own routing.
"""

import json
import subprocess
import sys
from pathlib import Path

from swallowed_errors import breaches

WALK = Path(__file__).resolve().parent / "swallowed_errors.py"


def breach_lines(src):
    return [n for n, _, _ in breaches(src)]


def handler(body, bind=" as e"):
    return f"try:\n    x = 1\nexcept OSError{bind}:\n    {body}\n"


def imported(src, line="from fail_open import fail_open"):
    return f"{line}\n{src}"


def test_a_handler_that_raises_exits_or_reports_passes():
    for body in ("raise", "raise SystemExit(1)", "sys.exit(2)", "parser.error('x')"):
        assert breach_lines(handler(body)) == [], body
    for line, body in (
        ("from fail_open import fail_open", "fail_open(e, 'skipped')"),
        ("import fail_open as fo", "fo.fail_open(e, 'skipped')"),
    ):
        assert breach_lines(imported(handler(body), line)) == [], body


def test_a_fail_open_not_imported_from_the_reporter_is_a_swallow():
    own = "def fail_open(e, s):\n    pass\n"
    assert breach_lines(own + handler("fail_open(e, 'skipped')")) == [5]


def test_a_fail_open_on_only_some_paths_is_a_swallow():
    src = imported(handler("if x:\n        fail_open(e, 'skipped')"))
    assert breach_lines(src) == [4]


def test_fail_open_must_be_handed_the_error_the_clause_binds():
    assert breach_lines(imported(handler("fail_open(None, 'skipped')"))) == [4]
    assert breach_lines(imported(handler("fail_open(err, 'skipped')"))) == [4]
    assert breach_lines(imported(handler("fail_open(e, 'skipped')", bind=""))) == [4]


def test_a_breach_names_its_function_and_clause():
    src = (
        "class C:\n    def f(self):\n        try:\n            pass\n"
        "        except (OSError, ValueError):\n            pass\n"
        "try:\n    pass\nexcept:\n    pass\n"
    )
    assert breaches(src) == [
        (5, "C.f", "(OSError, ValueError)"),
        (9, "<module>", "<bare>"),
    ]


def test_the_cli_reports_each_source_and_an_unparsable_one_as_an_error():
    req = {
        "sources": [
            {"name": "a.py", "text": handler("pass")},
            {"name": "b.py", "text": "def (:\n"},
        ],
    }
    out = subprocess.run(
        [sys.executable, str(WALK)],
        input=json.dumps(req),
        capture_output=True,
        text=True,
        check=True,
    )
    a, b = json.loads(out.stdout)["results"]
    assert a["breaches"] == [{"line": 3, "function": "<module>", "caught": "OSError"}]
    assert b["name"] == "b.py"
    assert "error" in b
    assert "fail-open: b.py not judged: SyntaxError" in out.stderr
