"""Pins scan_arbiter.py's pre/post day spans to the corpus it reads (#1324).

The script runs as a subprocess over a temp CLAUDE_CONFIG_DIR, with the
WFC_CLAUDE_CONFIG_* knobs stripped so no live seat leaks into the corpus.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Breaking it lets the per-day table divide by
the wrong span, misstating session-arbiter.js's daily tool-output cost before
and after region claims went live.
"""

import json
import math
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from scan_arbiter import span_days  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def _call(i, ts):
    use = {
        "type": "assistant",
        "timestamp": ts,
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": f"t{i}",
                    "name": "Bash",
                    "input": {"command": "node scripts/session-arbiter.js list"},
                }
            ]
        },
    }
    res = {
        "type": "user",
        "timestamp": ts,
        "toolUseResult": "x",
        "message": {
            "content": [
                {"type": "tool_result", "tool_use_id": f"t{i}", "content": "x" * 1000}
            ]
        },
    }
    return json.dumps(use) + "\n" + json.dumps(res) + "\n"


def scan_corpus(tmp_path, *stamps):
    root = tmp_path / ".claude" / "projects" / "-p"
    root.mkdir(parents=True)
    (root / "s.jsonl").write_text("".join(_call(i, ts) for i, ts in enumerate(stamps)))
    env = {
        k: v for k, v in os.environ.items() if not k.startswith("WFC_CLAUDE_CONFIG_")
    }
    env.update(CLAUDE_CONFIG_DIR=str(tmp_path / ".claude"), CLAUDE_PROJECT_DIR="/p")
    return subprocess.run(
        [sys.executable, str(HERE / "scan_arbiter.py")],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def test_spans_run_from_the_first_record_to_the_cut_and_on_to_the_last(tmp_path):
    # CUT is 2026-08-21T16:13:50Z: one call 4 days before it, two 2 days after.
    out = scan_corpus(
        tmp_path, "2026-08-17T16:13:50Z", "2026-08-23T16:13:50Z", "2026-08-23T16:13:50Z"
    )
    assert (
        "spans: pre 4.00 d from 2026-08-17T16:13:50Z, post 2.00 d to 2026-08-23T16:13:50Z"
        in out
    )
    rates = out.split("spans:")[1]
    total = next(ln for ln in rates.splitlines() if ln.startswith("TOTAL"))
    assert total.split()[1:] == ["250", "1000"]


def test_a_window_the_corpus_never_reaches_spans_zero_days():
    assert span_days("2026-08-22T16:13:50Z", "2026-08-23T04:13:50Z") == (0.0, 1.5)
    assert span_days(None, None) == (0.0, 0.0)


def test_an_empty_window_prints_no_rate_rather_than_dividing_by_zero(tmp_path):
    out = scan_corpus(tmp_path, "2026-08-23T16:13:50Z")
    row = next(ln for ln in out.splitlines() if ln.startswith("list") and "nan" in ln)
    assert math.isnan(float(row.split()[1]))
