"""Pins runs.py's reading of the run ledger (#2828): kind, verdict and fullCause come off each line, and the
one rule it applies itself, lander-rerun, reclasses an unsessioned run after LANDER_START only."""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs.py")
START, END = "2026-10-20T00:00:00Z", "2026-10-25T00:00:00Z"


def line(started, kind, verdict, *, session="s1", suite="vitest", **extra):
    return {
        "startedAt": started,
        "at": (datetime.fromisoformat(started) + timedelta(minutes=1)).isoformat(),
        "durationMs": 60000,
        "kind": kind,
        "verdict": verdict,
        "suite": suite,
        "session": session,
        "sha": "a" * 40,
        "treeAtEnd": "t" * 40,
        "argv": [],
        "repo": "workflow-core",
        **extra,
    }


def run(tmp_path, rows, torn=False):
    text = "".join(json.dumps(r) + "\n" for r in rows)
    if torn:
        text += '{"startedAt": "2026-10-23T'
    (tmp_path / ".test-runs.jsonl").write_text(text)
    dump = tmp_path / "runs.jsonl"
    out = subprocess.run(
        [sys.executable, "-I", RUNS, str(tmp_path), START, END, "--dump", str(dump)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return out, [json.loads(x) for x in dump.read_text().splitlines()]


def test_kind_and_verdict_come_off_the_ledger_line(tmp_path):
    out, dump = run(
        tmp_path,
        [
            line("2026-10-21T00:00:00Z", "pytest", "green", suite="pytest"),
            line("2026-10-21T01:00:00Z", "named", "red"),
            line("2026-10-21T02:00:00Z", "bare", "killed"),
            line("2026-10-21T03:00:00Z", "full", "stalled", fullCause="push-gate"),
        ],
    )
    assert [(r["_k"], r["_v"]) for r in dump] == [
        ("pytest", "green"),
        ("named", "red"),
        ("bare", "killed"),
        ("full", "stalled"),
    ]
    for v in ("green", "red", "killed", "stalled"):
        assert f"  {v:8}     1    0.02" in out
    assert "('full', 'push-gate') 1" in out


def test_an_unsessioned_run_after_the_lander_start_is_a_lander_rerun(tmp_path):
    out, dump = run(
        tmp_path,
        [
            line("2026-10-21T00:00:00Z", "named", "green", session=None),
            line(
                "2026-10-22T12:00:00Z", "full", "red", session=None, fullCause="flake"
            ),
            line("2026-10-23T00:00:00Z", "lander", "green", session=None),
            line("2026-10-23T01:00:00Z", "named", "red", session=None),
            line("2026-10-23T02:00:00Z", "named", "red"),
            line(
                "2026-10-23T03:00:00Z", "pytest", "green", session=None, suite="pytest"
            ),
        ],
    )
    assert [r["_k"] for r in dump] == [
        "named",
        "lander-rerun",
        "lander",
        "lander-rerun",
        "named",
        "pytest",
    ]
    assert "('lander-rerun', 'flake') 1" in out


def test_a_full_run_with_no_cause_prints_as_the_whole_selection(tmp_path):
    out, _ = run(tmp_path, [line("2026-10-21T00:00:00Z", "full", "green")])
    assert "('full', 'no flag (whole selection)') 1" in out


def test_torn_undated_out_of_window_and_repeated_lines_are_not_counted(tmp_path):
    kept = line("2026-10-21T00:00:00Z", "named", "green")
    out, dump = run(
        tmp_path,
        [
            kept,
            kept,
            {**line("2026-10-21T01:00:00Z", "named", "green"), "durationMs": None},
            line("2026-10-19T00:00:00Z", "named", "green"),
        ],
        torn=True,
    )
    assert len(dump) == 1
    assert out.startswith("runs 1 ")


def test_the_dump_keeps_the_fields_its_readers_key_on(tmp_path):
    _, dump = run(tmp_path, [line("2026-10-21T00:00:00Z", "named", "green")])
    assert dump[0] == {
        "sha": "a" * 40,
        "startedAt": "2026-10-21T00:00:00Z",
        "at": "2026-10-21T00:01:00+00:00",
        "durationMs": 60000,
        "suite": "vitest",
        "treeAtEnd": "t" * 40,
        "argv": [],
        "_k": "named",
        "_v": "green",
        "sessionId": "s1",
    }


def test_a_missing_ledger_exits_non_zero_naming_it(tmp_path):
    r = subprocess.run(
        [sys.executable, "-I", RUNS, str(tmp_path)], capture_output=True, text=True
    )
    assert r.returncode == 1
    assert ".test-runs.jsonl" in r.stderr
