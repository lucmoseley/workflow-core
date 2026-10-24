"""test_swallowed_errors.py — the cases of the base §N5 walk every repo's
pre-commit runs (`swallowed_errors.py`, #1274, #1830): what a swallow is, what
a citation is, and the keys the judge counts by.

Loosen one and an uncited swallow lands unrefused in every repo the plugin runs
in. The core's whole tree is the python CI job's
`node scripts/check-swallowed-errors.js --all`, through the gate's own routing.
"""

import json
import subprocess
import sys
from pathlib import Path

from swallowed_errors import breaches, cite_pattern

WALK = Path(__file__).resolve().parent / "swallowed_errors.py"
CITE = cite_pattern(["mantahostels", "fantasy-books"])


def breach_lines(src):
    return [n for n, _, _ in breaches(src, CITE)]


def test_the_walk_finds_an_uncited_swallow_and_passes_a_cited_one():
    assert breach_lines("try:\n    x = 1\nexcept OSError:\n    pass\n") == [3]
    counted = (
        "# Skipped and printed (#1).\nDROPS = 0\n"
        "def f():\n    try:\n        x = 1\n    except OSError:\n        DROPS += 1\n"
    )
    assert breach_lines(counted) == []
    loud = "try:\n    x = 1\nexcept OSError:\n    raise SystemExit(1)\n"
    assert breach_lines(loud) == []


def test_a_citation_is_a_bare_number_or_one_after_a_corpus_repo():
    swallow = "try:\n    x = 1\nexcept OSError:\n    pass  # skipped ({})\n"
    for cited in ("#12", "mantahostels#12", "lucmoseley/fantasy-books#12"):
        assert breach_lines(swallow.format(cited)) == [], cited
    for uncited in ("design-vault#12", "issue12", "#"):
        assert breach_lines(swallow.format(uncited)) == [3], uncited


def test_a_breach_names_its_function_and_clause():
    src = (
        "class C:\n    def f(self):\n        try:\n            pass\n"
        "        except (OSError, ValueError):\n            pass\n"
        "try:\n    pass\nexcept:\n    pass\n"
    )
    assert breaches(src, CITE) == [
        (5, "C.f", "(OSError, ValueError)"),
        (9, "<module>", "<bare>"),
    ]


def test_the_cli_reports_each_source_and_an_unparsable_one_as_an_error():
    req = {
        "prefixes": ["mantahostels"],
        "sources": [
            {"name": "a.py", "text": "try:\n    x = 1\nexcept OSError:\n    pass\n"},
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
