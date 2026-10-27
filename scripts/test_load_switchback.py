"""Tests for scripts/load_switchback.py — #3223's 24-against-48 switchback.

The runner is driven by an injected clock and sleep against a temp
home holding the schedule, events and minute log, so a 36 h walk runs in
milliseconds; the program cases run the script itself, `gh` crossed through
the `WFC_GH` stub. Loosen a case and the switchback sets the wrong ceiling,
runs past a stop rule, or reads a verdict the data does not support.
"""

import json
import math
import os
import random
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

import load_switchback as ls

T0 = 1_800_000_000
SCRIPT = str(Path(__file__).resolve().parent / "load_switchback.py")


def _iso(t):
    return datetime.fromtimestamp(t, UTC).isoformat()


def minute_lines(start, minutes, psi=10.0):
    return [
        {"ts": _iso(start + 60 * k), "psi_cpu_some": psi, "load1": 30}
        for k in range(minutes)
    ]


class Clock:
    def __init__(self, t):
        self.t = t

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


def setup(tmp_path, blocks, mem=None, start=T0):
    """A temp home holding a schedule of `blocks` from `start` and a minute log,
    by default a quiet one spanning the whole walk."""
    mem = minute_lines(start - 120, 180) if mem is None else mem
    p = ls.paths(str(tmp_path))
    (tmp_path / ".claude" / "load-switchback").mkdir(parents=True)
    with open(p["schedule"], "w") as f:
        json.dump({"start": start, "blocks": blocks}, f)
    with open(p["minute_log"], "w") as f:
        for r in mem:
            f.write(json.dumps(r) + "\n")
    return p


def _blocks(*ceilings):
    return [{"i": i, "pair": i // 2, "ceiling": c} for i, c in enumerate(ceilings)]


def events(p):
    return [json.loads(x) for x in open(p["events"])]


def no_refusals(lo, hi):
    return 0, {}


def test_draw_pairs_every_block_with_its_opposite_arm():
    s = ls.draw(T0, rng=random.Random(1))
    assert len(s["blocks"]) == ls.HOURS * 4
    pairs = {}
    for b in s["blocks"]:
        pairs.setdefault(b["pair"], []).append(b["ceiling"])
    assert all(sorted(v) == [24, 48] for v in pairs.values())
    assert {v[0] for v in pairs.values()} == {24, 48}


def test_run_writes_each_blocks_ceiling_and_removes_the_file_at_the_end(tmp_path):
    p = setup(tmp_path, _blocks(48, 24))
    seen = []
    clock = Clock(T0 - 30)

    def sleep(s):
        clock.sleep(s)
        seen.append(
            open(p["ceiling"]).read().strip() if os.path.exists(p["ceiling"]) else None
        )

    assert ls.run(p, clock.now, sleep, no_refusals) == "schedule complete"
    assert seen[0] is None
    assert seen.index("48") < seen.index("24")
    assert seen[-1] is None  # gone while the last low block's refusals come in
    assert not os.path.exists(p["ceiling"])
    assert [e["event"] for e in events(p)] == [
        "start",
        "block",
        "block",
        "refusals",
        "end",
    ]


def test_run_counts_a_low_blocks_refusals_one_hold_late_and_stops_past_three(tmp_path):
    p = setup(tmp_path, _blocks(24, 48, 24, 48))
    clock = Clock(T0)
    asked = []

    def refusals(lo, hi):
        asked.append((lo, hi, clock.t))
        return 4, {}

    why = ls.run(p, clock.now, clock.sleep, refusals)
    assert why == "4 test runs refused in 24-arm block 0"
    ((lo, hi, at),) = asked
    assert (lo, hi) == (T0 + 300, T0 + 1200)
    assert at >= T0 + 1200
    assert not os.path.exists(p["ceiling"])


def test_run_carries_on_past_a_low_block_with_three_refusals(tmp_path):
    p = setup(tmp_path, _blocks(24, 48))
    clock = Clock(T0)
    assert (
        ls.run(p, clock.now, clock.sleep, lambda lo, hi: (3, {})) == "schedule complete"
    )


def test_run_stops_on_ten_minutes_of_cpu_psi_at_90(tmp_path):
    p = setup(
        tmp_path,
        _blocks(48, 24),
        minute_lines(T0 - 120, 2) + minute_lines(T0, 40, psi=95.0),
    )
    clock = Clock(T0)
    assert "PSI" in ls.run(p, clock.now, clock.sleep, no_refusals)
    assert clock.t <= T0 + 11 * 60
    assert not os.path.exists(p["ceiling"])


def test_psi_stop_needs_ten_consecutive_recent_lines_at_90():
    now = T0 + 3600
    hot = [{"t": now - 60 * k, "psi_cpu_some": 91.0} for k in range(9, -1, -1)]
    assert ls.psi_stop(hot, now)
    assert ls.psi_stop(hot[:-1], now) is None
    assert ls.psi_stop([*hot[:-1], {"t": now, "psi_cpu_some": 89.9}], now) is None
    assert ls.psi_stop([*hot[:-1], {"t": now}], now) is None
    assert ls.psi_stop([{**r, "t": r["t"] - 3600} for r in hot], now) is None


def test_run_will_not_start_without_a_recent_minute_log(tmp_path):
    p = setup(tmp_path, _blocks(24, 48), mem=[])
    clock = Clock(T0)
    assert "cannot see" in ls.run(p, clock.now, clock.sleep, no_refusals)
    assert clock.t == T0
    assert [e["event"] for e in events(p)] == ["start", "end"]


def test_run_stops_when_the_minute_log_falls_silent(tmp_path):
    p = setup(tmp_path, _blocks(48, 24), mem=minute_lines(T0 - 120, 12))
    clock = Clock(T0)
    assert "cannot see" in ls.run(p, clock.now, clock.sleep, no_refusals)
    assert T0 + 600 < clock.t <= T0 + 900
    assert not os.path.exists(p["ceiling"])


def test_run_records_an_unplanned_exit_as_itself_and_still_removes_the_file(tmp_path):
    p = setup(tmp_path, _blocks(24, 48))
    clock = Clock(T0)

    def boom(lo, hi):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        ls.run(p, clock.now, clock.sleep, boom)
    assert events(p)[-1]["why"] == "RuntimeError: boom"
    assert not os.path.exists(p["ceiling"])


def test_run_skips_blocks_already_past(tmp_path):
    p = setup(tmp_path, _blocks(48, 24))
    clock = Clock(T0 + 1000)
    ls.run(p, clock.now, clock.sleep, no_refusals)
    assert [e.get("i") for e in events(p) if e["event"] == "block"] == [1]


def test_blocks_read_reads_past_the_washout_of_blocks_a_runner_saw_whole():
    sched = {"start": T0, "blocks": _blocks(24, 48, 24, 48)}
    ev = [
        {"event": "start", "ts": T0},
        {"event": "block", "i": 0, "ts": T0 + 1},
        {"event": "block", "i": 1, "ts": T0 + 900 + 400},  # begun after its washout
        {"event": "block", "i": 2, "ts": T0 + 1801},
        {"event": "end", "ts": T0 + 2000, "why": "terminated"},  # cut short
        {"event": "start", "ts": T0 + 2690},
        {"event": "block", "i": 3, "ts": T0 + 2701},  # a relaunch's block counts
    ]
    minute_rows = {
        T0 + 240: {"hto": 50, "bash": [100.0]},  # in the washout
        T0 + 300: {"hto": 10, "bash": [2.0, 4.0]},
        T0 + 840: {"hto": 10, "bash": [6.0, 8.0]},
    }
    mem = [{"t": T0 + 360, "psi_cpu_some": 40.0, "load1": 30}]
    rows = ls.blocks_read(
        sched,
        ev,
        minute_rows=minute_rows,
        mem=mem,
        close_ts=[T0 + 10, T0 + 600],
        until=T0 + 3700,
    )
    assert [r["i"] for r in rows] == [0, 3]
    r = rows[0]
    assert r["hto_min"] == 2.0
    assert r["bash_p50"] == 5.0
    assert r["closes_h"] == 6.0
    assert r["psi"] == 40.0 and r["binding"]


def test_median_ci_is_the_order_statistic_interval():
    assert ls.median_ci([1, 2, 3, 4, 5]) is None
    assert ls.median_ci(list(range(1, 7))) == (1, 6)
    # n 20: k 6, so x(6) and x(15).
    assert ls.median_ci(list(range(1, 21))) == (6, 15)


def test_sign_flip_p_is_exact_up_to_sixteen_pairs():
    assert ls.sign_flip_p([1, 1, 1]) == 1 / 8
    assert ls.sign_flip_p([1, -1]) == 3 / 4
    assert ls.sign_flip_p([]) is None


def test_sign_flip_p_samples_past_sixteen_pairs(monkeypatch):
    monkeypatch.setattr(ls, "SIGN_FLIP_DRAWS", 2000)
    assert ls.sign_flip_p([1.0] * 20) < 0.01
    assert ls.sign_flip_p([1.0, -1.0] * 10) > 0.4


def _row(pair, ceiling, metrics):
    hto, bash, closes = metrics
    return {
        "pair": pair,
        "ceiling": ceiling,
        "hto_min": hto,
        "bash_p50": bash,
        "closes_h": closes,
        "psi": 50.0,
        "binding": True,
    }


def _pairs(low, high):
    return [r for k in range(8) for r in (_row(k, 24, low), _row(k, 48, high))]


def test_report_keeps_24_where_the_low_arm_is_better():
    table, verdict = ls.report(
        _pairs((0.1, 3.0, 6), (1.0, 6.0, 6)), "schedule complete"
    )
    assert verdict == "keep 24"
    assert "8 complete pairs" in table and "8 of 8" in table


def test_report_reverts_where_the_low_arm_times_out_more():
    table, verdict = ls.report(
        _pairs((1.0, 4.0, 6), (0.1, 4.0, 6)), "schedule complete"
    )
    assert verdict == "revert"
    assert "Hook-timeout" in table.split("**Verdict")[1]


def test_report_lets_closes_inform_but_never_revert():
    _, verdict = ls.report(_pairs((0.5, 4.0, 2), (0.5, 4.0, 8)), "schedule complete")
    assert verdict == "keep 24"


def _program(home, *args, env=None):
    return subprocess.run(
        [sys.executable, SCRIPT, "--home", str(home), *args],
        capture_output=True,
        text=True,
        env=env or os.environ,
    )


def test_draw_writes_the_schedule_and_will_not_draw_over_a_run(tmp_path):
    first = _program(tmp_path, "draw")
    assert first.returncode == 0, first.stderr
    p = ls.paths(str(tmp_path))
    assert len(ls.load_schedule(p)["blocks"]) == ls.HOURS * 4
    os.remove(p["schedule"])
    open(p["events"], "w").close()
    again = _program(tmp_path, "draw")
    assert again.returncode != 0 and "events.jsonl already exists" in again.stderr


def test_readout_reads_the_whole_trial_end_to_end(tmp_path, corpus, stub_bin):
    start = math.floor(time.time() / 60) * 60 - 3600
    corpus("s1", [])
    gh, calls = stub_bin("gh", _iso(start + 400).replace("+00:00", "Z") + "\n")
    p = setup(tmp_path, _blocks(24, 48, 48, 24), minute_lines(start, 60), start=start)
    with open(p["events"], "w") as f:
        for i in range(4):
            f.write(
                json.dumps({"event": "block", "i": i, "ts": start + 900 * i + 1}) + "\n"
            )
    out = _program(tmp_path, "readout", env={**os.environ, "WFC_GH": gh})
    assert out.returncode == 0, out.stderr
    assert "2 complete pairs" in out.stdout and "Ended: still running" in out.stdout
    assert "**Verdict: keep 24**" in out.stdout
    assert "(unreadable files: 0, unparsed lines: 0)" in out.stdout
    (argv,) = calls()
    assert "reason:completed" in argv and "user:lucmoseley" in argv
