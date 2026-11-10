"""Tests for scripts/memory_switchback.py — #4862's memory-hold switchback.

The runner is driven by an injected clock, sleep, reading and holder against
a temp home holding the schedule, events and minute log, so a week's walk
runs in milliseconds. One case runs the real holder for a few MB. Loosen a
case and the trial holds memory with no add-back, runs past a stop rule, or
reads a verdict the data does not support.
"""

import json
import math
import random
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import memory_switchback as ms

T0 = 1_800_000_000
SCRIPT = str(Path(__file__).resolve().parent / "memory_switchback.py")


def _iso(t):
    return datetime.fromtimestamp(t, UTC).isoformat()


class Clock:
    def __init__(self, t):
        self.t = t

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


class MinuteLog:
    """A minute log that always holds a fresh line, so the runner never
    reads it silent; `win` sets the Windows reading."""

    def __init__(self, path, clock, win=4000):
        self.path, self.clock, self.win = path, clock, win

    def sleep(self, s):
        self.clock.sleep(s)
        with open(self.path, "a") as f:
            f.write(
                json.dumps({"ts": _iso(self.clock.t), "win_avail_mb": self.win}) + "\n"
            )


class FakeHolder:
    def __init__(self, p):
        self.p, self.proc, self.log = p, None, []

    def start(self, mb):
        self.proc = object()
        self.log.append(("start", mb))
        Path(self.p["hold"]).write_text(f"{mb} 1\n")

    def stop(self):
        if self.proc is not None:
            self.log.append(("stop",))
        self.proc = None
        Path(self.p["hold"]).unlink(missing_ok=True)


def calm(**over):
    return lambda t, since: {
        "avail_mb": 4000,
        "swap_mb": 500,
        "psi_full": 1.0,
        "win_lines": [],
        "kills": [],
        **over,
    }


def setup(tmp_path, pairs=3, hold_mb=668):
    p = ms.paths(str(tmp_path))
    Path(p["schedule"]).parent.mkdir(parents=True)
    sched = ms.draw(T0, hold_mb, random.Random(1))
    sched["blocks"] = sched["blocks"][: 2 * pairs]
    Path(p["schedule"]).write_text(json.dumps(sched))
    return p, sched


def events(p):
    return [json.loads(x) for x in Path(p["events"]).read_text().splitlines()]


def test_draw_pairs_each_hold_with_none_and_halves_pair_0():
    s = ms.draw(T0, 668, random.Random(7))
    by_pair = {}
    for b in s["blocks"]:
        by_pair.setdefault(b["pair"], []).append(b)
    assert len(by_pair) == ms.SCHEDULE_H * 2
    assert all(
        sorted(x["arm"] for x in v) == ["hold", "none"] for v in by_pair.values()
    )
    assert {b["mb"] for b in by_pair[0] if b["arm"] == "hold"} == {334}
    assert {b["mb"] for b in s["blocks"][2:] if b["arm"] == "hold"} == {668}
    assert {b["mb"] for b in s["blocks"] if b["arm"] == "none"} == {0}


def test_launch_charge_reads_only_ticks_admitting_none():
    rows = [
        {"memory": {"memorySlots": 0, "nextNeedMb": 2663, "drawNeedMb": 1995}},
        {"memory": {"memorySlots": 1, "nextNeedMb": 1269, "drawNeedMb": -160}},
        {"memory": {"memorySlots": 0, "nextNeedMb": 2088, "drawNeedMb": 1420}},
        {"at": "x"},
    ]
    assert ms.launch_charge_mb(rows) == 668
    assert ms.launch_charge_mb([{"memory": {"memorySlots": 2}}]) is None


def test_run_holds_in_hold_blocks_only_and_clears_at_the_end(tmp_path):
    p, sched = setup(tmp_path)
    clock = Clock(T0 - 30)
    log = MinuteLog(p["minute_log"], clock)
    holder = FakeHolder(p)
    why = ms.run(
        p,
        now=clock.now,
        sleep=log.sleep,
        reading=calm(),
        holder=holder,
        usable=lambda pair: False,
    )
    assert why == "schedule complete"
    starts = [x[1] for x in holder.log if x[0] == "start"]
    assert starts == [b["mb"] for b in sched["blocks"] if b["arm"] == "hold"]
    assert holder.log.count(("stop",)) == 3
    assert not Path(p["hold"]).exists()
    assert events(p)[-1]["event"] == "end"


def test_run_ends_at_the_usable_pair_count_counting_a_past_life(tmp_path, monkeypatch):
    # A run restarted after a reboot keeps the pairs its last life counted.
    monkeypatch.setattr(ms, "USABLE_PAIRS", 3)
    p, _ = setup(tmp_path, pairs=5)
    Path(p["events"]).write_text(
        json.dumps({"ts": T0 - 9, "event": "pair", "pair": 9, "usable": True}) + "\n"
    )
    clock = Clock(T0)
    log = MinuteLog(p["minute_log"], clock)
    verdicts = iter([True, False, True, True])
    why = ms.run(
        p,
        now=clock.now,
        sleep=log.sleep,
        reading=calm(),
        holder=FakeHolder(p),
        usable=lambda pair: next(verdicts),
    )
    assert why == "3 usable pairs"
    assert [e["count"] for e in events(p) if e["event"] == "pair" and "count" in e] == [
        2,
        2,
        3,
    ]


def test_a_stop_rule_ends_the_trial_and_drops_the_hold(tmp_path):
    p, sched = setup(tmp_path)
    clock = Clock(T0)
    log = MinuteLog(p["minute_log"], clock)
    holder = FakeHolder(p)
    why = ms.run(
        p,
        now=clock.now,
        sleep=log.sleep,
        reading=calm(swap_mb=1900),
        holder=holder,
        usable=lambda pair: False,
    )
    assert why.startswith("swap used 1900 MB")
    first_hold = next(b for b in sched["blocks"] if b["arm"] == "hold")
    assert clock.t < T0 + (first_hold["i"] + 1) * ms.BLOCK_S
    assert not Path(p["hold"]).exists()


def test_stop_rules_are_not_read_with_no_hold_in_force(tmp_path):
    # A no-hold block followed by no hold: the breach is the machine's own,
    # not the hold's, and must not end the trial.
    p = ms.paths(str(tmp_path))
    Path(p["schedule"]).parent.mkdir(parents=True)
    sched = {
        "start": T0,
        "hold_mb": 668,
        "blocks": [{"i": 0, "pair": 0, "arm": "none", "mb": 0}],
    }
    Path(p["schedule"]).write_text(json.dumps(sched))
    clock = Clock(T0)
    log = MinuteLog(p["minute_log"], clock)
    why = ms.run(
        p,
        now=clock.now,
        sleep=log.sleep,
        reading=calm(swap_mb=1900),
        holder=FakeHolder(p),
        usable=lambda pair: False,
    )
    assert why == "schedule complete"


def test_a_silent_minute_log_ends_the_trial(tmp_path):
    p, _ = setup(tmp_path)
    clock = Clock(T0)
    why = ms.run(
        p,
        now=clock.now,
        sleep=clock.sleep,
        reading=calm(),
        holder=FakeHolder(p),
        usable=lambda pair: False,
    )
    assert why.startswith("no minute-log line")


def test_sustained_rules_fire_only_after_their_window():
    s = ms.Stops()
    base = {
        "avail_mb": 4000,
        "swap_mb": 0,
        "psi_full": 0.0,
        "win_lines": [],
        "kills": [],
    }
    low = {**base, "avail_mb": 1000}
    assert s.check(T0, **low) is None
    assert s.check(T0 + 119, **low) is None
    assert s.check(T0 + 60, **base) is None  # a break restarts the window
    assert s.check(T0 + 61, **low) is None
    assert "MemAvailable" in s.check(T0 + 61 + ms.AVAIL_STOP_S, **low)
    psi = {**base, "psi_full": 10.0}
    s2 = ms.Stops()
    assert s2.check(T0, **psi) is None
    assert "PSI" in s2.check(T0 + ms.PSI_FULL_STOP_S, **psi)
    assert "earlyoom" in ms.Stops().check(
        T0, **{**base, "kills": ["sending SIGTERM to process 9"]}
    )


def test_windows_rule_needs_five_fresh_low_lines():
    def lines(vals):
        return [
            {"t": T0 - 60 * (len(vals) - 1 - k), "win_avail_mb": v}
            for k, v in enumerate(vals)
        ]

    base = {"avail_mb": 4000, "swap_mb": 0, "psi_full": 0.0, "kills": []}
    assert ms.Stops().check(T0, win_lines=lines([400] * 4), **base) is None
    assert (
        ms.Stops().check(T0, win_lines=lines([400, 400, 600, 400, 400]), **base) is None
    )
    assert (
        ms.Stops().check(T0, win_lines=lines([None, 400, 400, 400, 400]), **base)
        is None
    )
    assert "Windows" in ms.Stops().check(T0, win_lines=lines([400] * 5), **base)


def block_rows(pairs, ratio, *, noise=0.0, seed=0, usable=True):
    rng = random.Random(seed)
    rows = []
    for k in range(pairs):
        base = 3.0 * math.exp(rng.gauss(0, 0.2))
        for arm in ("hold", "none"):
            r = base * (ratio if arm == "hold" else 1.0) * math.exp(rng.gauss(0, noise))
            rows.append(
                {
                    "pair": k,
                    "arm": arm,
                    "bash_p50": r,
                    "hto_min": 0.0,
                    "cpu_per_call": 1.0,
                    "closes_h": 6.0,
                    "usable": usable,
                }
            )
    return rows


def test_report_detects_a_real_slowdown_and_reads_none_where_there_is_none():
    slow = ms.report(block_rows(60, 1.3, noise=0.1, seed=1), "done", draws=2000)
    assert "the hold slows Bash round-trip (beyond the 14% break-even)" in slow
    flat = ms.report(block_rows(60, 1.0, noise=0.1, seed=2), "done", draws=2000)
    assert "no slowdown detected" in flat


def test_report_skips_pair_0_and_unusable_pairs():
    rows = block_rows(5, 1.3, seed=3)
    rows[2]["usable"] = False  # pair 1's hold block
    assert set(ms.usable_pairs(rows)) == {2, 3, 4}
    assert "no usable pair" in ms.report(
        block_rows(3, 1.3, usable=False), "done", draws=10
    )


def test_blocks_read_marks_usability_and_reads_the_last_ten_minutes():
    sched = {
        "start": T0,
        "hold_mb": 668,
        "blocks": [{"i": 0, "pair": 1, "arm": "hold", "mb": 668}],
    }
    evs = [{"ts": T0 + 1, "event": "block", "i": 0}]
    lo = T0 + ms.WASHOUT_S
    minute_rows = {
        lo + 60 * k: {"bash": [2.0, 4.0], "hto": 1, "active": 4} for k in range(10)
    }
    minute_rows[T0] = {"bash": [99.0] * 50, "hto": 50, "active": 9}  # washout: unread
    mem = [{"t": lo + 60 * k, "cpu_busy_pct": 200} for k in range(10)]
    kw = {
        "minute_rows": minute_rows,
        "mem": mem,
        "close_ts": [],
        "until": T0 + ms.BLOCK_S,
    }
    (row,) = ms.blocks_read(sched, evs, ticks=[lo + 30], **kw)
    assert row["bash_p50"] == 3.0
    assert row["hto_min"] == 1.0
    assert row["cpu_per_call"] == 1200 / 20
    assert row["usable"]
    (row,) = ms.blocks_read(sched, evs, ticks=[T0 + 10], **kw)
    assert not row["usable"]  # its only loop tick fell in the washout


def test_the_real_holder_declares_ready_and_dies_on_terminate(tmp_path):
    # Crosses the real child process: a holder that never prints ready, or
    # outlives its stop, would leave memory held with no add-back.
    p = ms.paths(str(tmp_path))
    Path(p["hold"]).parent.mkdir()
    h = ms.Holder(
        p,
        spawn=lambda mb: subprocess.Popen(
            [sys.executable, SCRIPT, "hold", str(mb)], stdout=subprocess.PIPE, text=True
        ),
    )
    h.start(4)
    mb, pid = Path(p["hold"]).read_text().split()
    assert mb == "4" and int(pid) == h.proc.pid
    proc = h.proc
    h.stop()
    assert proc.returncode is not None
    assert not Path(p["hold"]).exists()
