"""Tests for scripts/memory_switchback.py — #4862's memory-hold switchback.

The runner is driven by an injected clock, sleep, reading and holder against
a temp home holding the schedule and events, so a week's walk runs in
milliseconds. The holder cases run the real child for a few MB, and `draw`
runs as a program against a temp home. Loosen a case and the trial holds
memory with no add-back, runs past a stop rule, resumes a trial a stop rule
ended, or reads a verdict the data does not support.
"""

import json
import math
import random
import subprocess
import sys
from pathlib import Path

import pytest

import memory_switchback as ms

T0 = 1_800_000_000
SCRIPT = str(Path(__file__).resolve().parent / "memory_switchback.py")


class Clock:
    def __init__(self, t):
        self.t = t

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


class FakeHolder:
    def __init__(self, p):
        self.p, self.proc, self.log = p, None, []

    def start(self, mb):
        self.proc = object()
        self.log.append(("start", mb))
        Path(self.p["hold"]).write_text(f"{mb} 1 1\n")

    def stop(self):
        if self.proc is not None:
            self.log.append(("stop",))
        self.proc = None
        Path(self.p["hold"]).unlink(missing_ok=True)


def calm(**over):
    """A reading that breaks no rule, its minute log fresh at `t`."""
    return lambda t, since: {
        "avail_mb": 4000,
        "swap_mb": 500,
        "psi_full": 1.0,
        "win_lines": [{"t": t - 30, "win_avail_mb": 4000}],
        "kills": [],
        **over,
    }


def setup(tmp_path, pairs=3, hold_mb=668, events=()):
    p = ms.paths(str(tmp_path))
    Path(p["schedule"]).parent.mkdir(parents=True)
    sched = ms.draw(T0, hold_mb, random.Random(1))
    sched["blocks"] = sched["blocks"][: 2 * pairs]
    Path(p["schedule"]).write_text(json.dumps(sched))
    if events:
        Path(p["events"]).write_text("".join(json.dumps(e) + "\n" for e in events))
    return p, sched


def events(p):
    return [json.loads(x) for x in Path(p["events"]).read_text().splitlines()]


def walk(p, clock, **kw):
    kw = {
        "reading": calm(),
        "holder": FakeHolder(p),
        "usable": lambda pair: False,
        **kw,
    }
    return ms.run(p, now=clock.now, sleep=clock.sleep, **kw)


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


def test_draw_as_a_program_sizes_the_hold_and_refuses_a_second_draw(tmp_path):
    claude = tmp_path / ".claude"
    claude.mkdir()
    tick = {
        "at": "2026-11-10T03:42:09Z",
        "memory": {"memorySlots": 0, "nextNeedMb": 2663, "drawNeedMb": 1995},
    }
    (claude / "concurrency.jsonl").write_text(json.dumps(tick) + "\n{torn\n")
    cmd = [sys.executable, SCRIPT, "--home", str(tmp_path), "draw"]
    first = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert first.returncode == 0, first.stderr
    assert (
        json.loads((claude / "memory-switchback" / "schedule.json").read_text())[
            "hold_mb"
        ]
        == 668
    )
    again = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert again.returncode == 1
    assert "already exists" in again.stderr


def test_run_holds_in_hold_blocks_only_and_clears_at_the_end(tmp_path):
    p, sched = setup(tmp_path)
    holder = FakeHolder(p)
    assert walk(p, Clock(T0 - 30), holder=holder) == "schedule complete"
    starts = [x[1] for x in holder.log if x[0] == "start"]
    assert starts == [b["mb"] for b in sched["blocks"] if b["arm"] == "hold"]
    assert holder.log.count(("stop",)) == 3
    assert not Path(p["hold"]).exists()
    assert events(p)[-1]["event"] == "end"


def test_run_ends_at_the_usable_pair_count_counting_a_past_life(tmp_path):
    # A run restarted after a reboot keeps the pairs its last life counted.
    past = [
        {"ts": T0 - 9, "event": "block", "i": 0},
        {"ts": T0 - 9, "event": "pair", "pair": 0, "usable": True},
        {"ts": T0 - 8, "event": "end", "why": "SystemExit: terminated"},
    ]
    p, _ = setup(tmp_path, pairs=5, events=past)
    verdicts = iter([True, False, True, True])
    why = walk(p, Clock(T0), usable=lambda pair: next(verdicts), target=3)
    assert why == "3 usable pairs"
    assert [e["count"] for e in events(p) if "count" in e] == [2, 2, 3]


def test_a_stop_rule_ends_the_trial_drops_the_hold_and_bars_a_restart(tmp_path):
    p, sched = setup(tmp_path)
    clock = Clock(T0)
    why = walk(p, clock, reading=calm(swap_mb=1900))
    assert why.startswith("stop rule: swap used 1900 MB")
    first_hold = next(b for b in sched["blocks"] if b["arm"] == "hold")
    assert clock.t < T0 + (first_hold["i"] + 1) * ms.BLOCK_S
    assert not Path(p["hold"]).exists()
    assert walk(p, clock).startswith("refused: the trial ended (stop rule")


def test_stop_rules_are_not_read_with_no_hold_in_force(tmp_path):
    # A no-hold block followed by no hold: the breach, a silent minute log
    # included, is the machine's own, not the hold's, and must not end it.
    p = ms.paths(str(tmp_path))
    Path(p["schedule"]).parent.mkdir(parents=True)
    sched = {
        "start": T0,
        "hold_mb": 668,
        "blocks": [{"i": 0, "pair": 0, "arm": "none", "mb": 0}],
    }
    Path(p["schedule"]).write_text(json.dumps(sched))
    assert (
        walk(p, Clock(T0), reading=calm(swap_mb=1900, win_lines=[]))
        == "schedule complete"
    )


def test_a_stale_schedule_is_refused(tmp_path):
    p, _ = setup(tmp_path)
    why = walk(p, Clock(T0 + ms.WASHOUT_S))
    assert why.startswith("refused: the schedule's pair 0 has passed unrun")


def test_a_holder_not_ready_ends_the_trial_as_a_stop_rule(tmp_path):
    p, _ = setup(tmp_path)

    class Stuck(FakeHolder):
        def start(self, mb):
            raise ms.HolderNotReadyError(
                f"stop rule: holder of {mb} MB not ready in {ms.READY_S} s"
            )

    assert walk(p, Clock(T0), holder=Stuck(p)).startswith("stop rule: holder of")


def test_sustained_rules_fire_only_after_their_window():
    fresh = [{"t": T0 + 10_000, "win_avail_mb": 4000}]
    base = {
        "avail_mb": 4000,
        "swap_mb": 0,
        "psi_full": 0.0,
        "win_lines": fresh,
        "kills": [],
    }
    low = {**base, "avail_mb": 1000}
    s = ms.Stops()
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


def test_windows_rule_needs_five_fresh_low_lines_and_a_live_log():
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
    old = [{"t": T0 - ms.SILENT_S - 1, "win_avail_mb": 4000}]
    assert "no minute-log line" in ms.Stops().check(T0, win_lines=old, **base)


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
                    "win_floor_min": 0,
                    "ticked": True,
                    "usable": usable,
                }
            )
    return rows


# 16 read pairs plus the unread pair 0: the sign flip runs exact.
@pytest.mark.parametrize(
    ("ratio", "noise", "says"),
    [
        (1.3, 0.05, "the hold slows Bash round-trip (beyond the 14% break-even)"),
        (1.0, 0.02, "the interval rules out the 14% break-even"),
        (1.0, 0.5, "inconclusive"),
    ],
)
def test_report_verdicts(ratio, noise, says):
    assert says in ms.report(block_rows(17, ratio, noise=noise, seed=1), "done")


def test_report_skips_pair_0_and_unusable_pairs_and_names_a_missing_loop():
    rows = block_rows(5, 1.3, seed=3)
    rows[2]["usable"] = False  # pair 1's hold block
    assert set(ms.usable_pairs(rows)) == {2, 3, 4}
    dark = [{**r, "usable": False, "ticked": False} for r in block_rows(3, 1.3)]
    out = ms.report(dark, "done")
    assert "no usable pair" in out
    assert "No block saw a refill-loop tick" in out


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
    mem = [
        {"t": lo + 60 * k, "cpu_busy_pct": 200, "win_avail_mb": 900 if k < 3 else 2000}
        for k in range(10)
    ]
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
    assert row["win_floor_min"] == 3
    assert row["usable"]
    (row,) = ms.blocks_read(sched, evs, ticks=[T0 + 10], **kw)
    assert not row["usable"]  # its only loop tick fell in the washout


def test_the_real_holder_declares_itself_and_dies_on_stop(tmp_path):
    # Crosses the real child process and /proc: a holder that never reports
    # ready, declares a wrong start token, or outlives its stop would leave
    # memory held with no add-back, or an add-back with no memory.
    p = ms.paths(str(tmp_path))
    Path(p["hold"]).parent.mkdir()
    h = ms.Holder(p)
    h.start(4)
    mb, pid, start = Path(p["hold"]).read_text().split()
    assert (mb, int(pid)) == ("4", h.proc.pid)
    assert start == Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    proc = h.proc
    h.stop()
    assert proc.returncode is not None
    assert not Path(p["hold"]).exists()
