"""Tests for scripts/dense_minute.py — the per-minute counts #3223's switchback reads.

Each case writes literal transcript records through conftest's `corpus`
fixture, which points every seat at a temp dir, so no case reads a real
session. Loosen a case and the
readout misstates a block's hook timeouts, its Bash round-trip or the
test-run refusals its stop rule counts.
"""

import json
import os
import subprocess
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import dense_minute as d

T0 = 1_800_000_000  # a whole minute
REPO = Path(__file__).resolve().parent.parent


def _iso(t):
    return datetime.fromtimestamp(t, UTC).isoformat().replace("+00:00", "Z")


def call(i, name, span, result):
    sent, landed = span
    return [
        {
            "timestamp": _iso(sent),
            "message": {"content": [{"type": "tool_use", "id": f"t{i}", "name": name}]},
        },
        {
            "timestamp": _iso(landed),
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": f"t{i}", "content": result}
                ]
            },
        },
    ]


def test_counts_each_minute_by_the_minute_its_result_landed(corpus):
    f = corpus(
        "s1",
        call(1, "Bash", (T0 + 10, T0 + 13), "ok")
        + call(2, "Read", (T0 + 50, T0 + 70), "ok")
        + call(3, "Bash", (T0 + 61, T0 + 65), [{"type": "text", "text": "x"}]),
    )
    rows = d.minutes([str(f)], T0, T0 + 600, Counter())
    assert sorted(rows) == [T0, T0 + 60]
    assert rows[T0]["calls"] == 1 and rows[T0]["bash"] == [3.0]
    assert rows[T0 + 60]["calls"] == 2 and rows[T0 + 60]["bash"] == [4.0]
    assert rows[T0 + 60]["active"] == 1


def test_counts_hook_timeouts_on_any_tool_and_load_refusals_on_bash_only(corpus):
    hto = 'PreToolUse:Bash hook error: [x]: timed out; blocking because onFailure is "block"'
    refusal = "run-vitest: REFUSED — load1 still 31.2, at or above the 24 ceiling (#830), after 300s."
    f = corpus(
        "s1",
        call(1, "Edit", (T0, T0 + 1), hto)
        + call(
            2, "Bash", (T0 + 2, T0 + 302), [{"type": "text", "text": "out\n" + refusal}]
        )
        + call(3, "Read", (T0 + 2, T0 + 3), refusal),
    )
    rows = d.minutes([str(f)], T0, T0 + 600, Counter())
    assert rows[T0]["hto"] == 1
    assert rows[T0 + 300]["refused"] == 1
    assert sum(m["refused"] for m in rows.values()) == 1


def test_the_refusal_text_is_the_one_run_vitest_prints():
    source = (REPO / "scripts/lib/cpu-sample.js").read_text()
    assert d.LOAD_REFUSAL + " ${r.load1}" in source


def test_reads_only_results_inside_the_window(corpus):
    f = corpus(
        "s1",
        call(1, "Bash", (T0 - 5, T0 - 1), "x")
        + call(2, "Bash", (T0 + 600, T0 + 601), "x"),
    )
    assert d.minutes([str(f)], T0, T0 + 600, Counter()) == {}


def test_counts_unreadable_files_and_torn_lines(corpus):
    f = corpus("s1", call(1, "Bash", (T0, T0 + 1), "x"))
    with open(f, "a") as fh:
        fh.write('{"type": "tool_use", torn\n')
    tally = Counter()
    rows = d.minutes([str(f), str(f) + ".gone"], T0, T0 + 600, tally)
    assert rows[T0]["calls"] == 1
    assert d.counts_line(tally) == "(unreadable files: 1, unparsed lines: 1)"


def test_transcripts_spans_every_seat_and_subagents_and_skips_old_files(corpus):
    new = corpus("s1", [])
    sub = corpus("a1", [], subagent_of="s1")
    other = corpus("s2", [], seat=1)
    old = corpus("s3", [])
    os.utime(old, (T0 - 100, T0 - 100))
    for f in (new, sub, other):
        os.utime(f, (T0 + 1, T0 + 1))
    assert sorted(d.transcripts(T0)) == sorted(str(f) for f in (new, sub, other))


def test_transcripts_reads_a_session_on_two_seats_once_from_its_largest_copy(corpus):
    small = corpus("s1", [{"x": 1}])
    large = corpus("s1", [{"x": 1}, {"x": 2}], seat=1)
    for f in (small, large):
        os.utime(f, (T0 + 1, T0 + 1))
    assert d.transcripts(T0) == [str(large)]


def test_program_prints_one_line_a_minute_and_the_skip_counts(corpus):
    f = corpus(
        "s1",
        call(1, "Bash", (T0, T0 + 2), "x") + call(2, "Bash", (T0 + 3, T0 + 7), "x"),
    )
    os.utime(f, (T0 + 10, T0 + 10))
    out = subprocess.run(
        [sys.executable, str(REPO / "scripts/dense_minute.py"), "--since", str(T0 - 1)],
        capture_output=True,
        text=True,
        check=True,
        env=os.environ,
    )
    (row,) = [json.loads(line) for line in out.stdout.splitlines()]
    assert row["bash_n"] == 2 and row["bash_p50"] == 3.0
    assert "unreadable files: 0, unparsed lines: 0" in out.stderr
