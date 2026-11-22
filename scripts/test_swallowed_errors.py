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


def test_tallied_passes_under_any_caught_type():
    for line, body in (
        ("from fail_open import tallied", "tallied(e, t, 'unparsed')"),
        ("import fail_open as fo", "fo.tallied(e, t, 'unparsed')"),
    ):
        assert breach_lines(imported(handler(body), line)) == [], body


def test_expected_passes_only_under_a_specific_caught_type():
    line = "from fail_open import expected"
    body = "expected(e, 'gone')"
    for caught in ("ChildProcessError", "(FileNotFoundError, ProcessLookupError)"):
        src = f"try:\n    x = 1\nexcept {caught} as e:\n    {body}\n"
        assert breach_lines(imported(src, line)) == [], caught
    for caught in (
        "OSError",
        "Exception",
        "(ProcessLookupError, OSError)",
        "os.error",
        "socket.error",
        "builtins.OSError",
        "ERRORS",
        "(ProcessLookupError, (OSError,))",
    ):
        src = f"try:\n    x = 1\nexcept {caught} as e:\n    {body}\n"
        assert breach_lines(imported(src, line)) == [4], caught


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


def test_a_suppress_of_a_broad_type_is_a_swallow():
    for line, opened in (
        ("import contextlib", "contextlib.suppress(Exception)"),
        ("import contextlib as cl", "cl.suppress(OSError)"),
        ("from contextlib import suppress", "suppress(ValueError, BaseException)"),
        ("from contextlib import suppress as quiet", "quiet(*ERRORS)"),
    ):
        src = f"{line}\ndef f():\n    with {opened}:\n        x = 1\n"
        assert breaches(src) == [(3, "f", opened)], opened
    entered = "import contextlib\nstack.enter_context(contextlib.suppress(Exception))\n"
    assert breach_lines(entered) == [2]


def test_a_suppress_of_a_specific_type_or_not_from_contextlib_passes():
    for src in (
        "import contextlib\nwith contextlib.suppress(FileNotFoundError):\n    x = 1\n",
        "def suppress(t):\n    pass\nwith suppress(Exception):\n    x = 1\n",
    ):
        assert breach_lines(src) == [], src


def exiting(body, sig="self, exc_type, error, tb"):
    return f"class Q:\n    def __exit__({sig}):\n        {body}\n"


def test_an_exit_that_returns_true_without_reporting_is_a_swallow():
    for body in (
        "return True",
        "if isinstance(error, Exception):\n            return True\n        return False",
        "print(error)\n        return True",
        "fail_open(error, 'kept')\n        return True",
        "if isinstance(error, KeyError):\n            fail_open(error, 'k')\n"
        "            return True\n        return True",
    ):
        found = [(f, c) for _, f, c in breaches(exiting(body))]
        assert found == [("Q.__exit__", "__exit__ returning True")], body
    assert breaches(exiting("return True", sig="self, *exc")) == [
        (3, "Q.__exit__", "__exit__ returning True")
    ]


def test_an_exit_that_reports_raises_or_propagates_passes():
    for body in (
        "fail_open(error, 'kept')\n        return True",
        "tallied(error, t, 'k')\n        return True",
        "if not isinstance(error, Exception):\n            return False\n"
        "        fail_open(error, 'kept')\n        return True",
        "if isinstance(error, Exception):\n            fail_open(error, 'kept')\n"
        "            return True\n        return False",
        "def g():\n            return True\n        return False",
        "if error:\n            raise SystemExit(1) from error\n        return False",
        "return False",
        "return None",
    ):
        src = imported(exiting(body), "from fail_open import fail_open, tallied")
        assert breach_lines(src) == [], body


def test_a_breach_names_its_function_and_clause():
    src = (
        "class C:\n    def f(self):\n        try:\n            pass\n"
        "        except (OSError, ValueError):\n            pass\n"
        "try:\n    pass\nexcept:\n    pass\n"
    )
    assert breaches(src) == [
        (5, "C.f", "except (OSError, ValueError)"),
        (9, "<module>", "except <bare>"),
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
    assert a["breaches"] == [
        {"line": 3, "function": "<module>", "caught": "except OSError"}
    ]
    assert b["name"] == "b.py"
    assert "error" in b
    assert "fail-open: b.py not judged: SyntaxError" in out.stderr
