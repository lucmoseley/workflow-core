#!/usr/bin/env python3
"""memory_switchback.py — the memory-hold switchback (#4862, designed on #4162).

Does holding one session's worth of guest memory, with launches held fixed,
slow Bash round-trip? Time is cut into 15-minute blocks taken in pairs; one
fair coin per pair gives one block a hold and the other none. Each block's
first 5 minutes are a washout and are not read (load_switchback.py's shape).

The hold is one more session's launch charge as admission computes it at
`draw` (`nextNeedMb - drawNeedMb` in ~/.claude/concurrency.jsonl, 668 MB on
10 Nov). Pair 0 holds half of it and is never read: the low-side start. While
a hold runs, ~/.claude/memory-hold reads `<MB> <pid>`, and lib/meminfo.js adds
the MB back to MemAvailable for admission, the suite ladder and the reap, so
launches stay fixed and only the kernel feels the hold.

  draw     pre-draw the schedule and the hold size into <home>/.claude/memory-switchback/
  run      walk the schedule, starting and ending the holder at each block's edges.
           Ends at the schedule's end, at USABLE_PAIRS usable pairs, at a stop
           rule or when the minute log falls silent, and removes the hold either
           way. Run it detached, the unit removing the hold file even on a kill
           the script cannot see; stopping the unit kills the holder with it:
             systemd-run --user --unit=wfc-memory-switchback --collect \\
               -p ExecStopPost="/bin/rm -f $HOME/.claude/memory-hold" \\
               python3 "$PWD/scripts/memory_switchback.py" run
           A run restarted after a reboot resumes at the block in progress.
  hold     the holder itself: resident anonymous memory, re-touched every
           TOUCH_S seconds at low CPU, `ready` on stdout once every page is in
  readout  print the markdown readout for the ticket

Stop rules, set before the start (#4162 issuecomment-6757858934, the Windows
rule re-set on #4862). Each binds while a hold runs and through the washout
after it, where its harm would show; any one ends the trial:
  an earlyoom kill; guest MemAvailable under 1,094 MB for 2 min; swap used over
  1,800 MB; memory PSI full avg60 >= 10% for 5 min; Windows available memory
  (`win_avail_mb`, the minute log) under 500 MB for 5 minute lines.

The readout reads each block's last 10 minutes. Decision: the within-pair log
ratio of block median Bash round-trip, hold over none, by a two-sided sign-flip
test at ALPHA. Companions: hook-timeout refusals per minute, CPU-s per Bash
call. Guardrail, spending no alpha: closes per hour. A pair counts only where
both blocks are usable: a refill-loop tick, a median of >= 3 active
transcripts and >= 20 Bash calls in the read window.
"""

import argparse
import json
import math
import os
import random
import secrets
import signal
import statistics
import subprocess
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import dense_minute
from dense_minute import epoch, median
from load_switchback import (
    ALPHA,
    BLOCK_S,
    READ_MIN,
    WASHOUT_S,
    _events,
    _iso,
    _log,
    closes,
    minute_log,
)

HOLD, NONE = "hold", "none"
# #4162: 77 usable pairs detect a 14% slowdown at 80% power, two-sided ALPHA.
USABLE_PAIRS = 77
# Half of loop-on pairs were usable on 4-10 Nov (#4162), and the loop is not
# always on: a week of schedule bounds the run, USABLE_PAIRS ends it sooner.
SCHEDULE_H = 7 * 24
MIN_ACTIVE = 3
MIN_BASH = 20
# The pairs each read skips: pair 0 is the half-size low-side start (#4162).
UNREAD_PAIRS = {0}

PAGE = 4096
TOUCH_S = 10
READY_S = 120
TICK_S = 15

AVAIL_STOP_MB = 1094  # earlyoom's 794 MB floor + 300 margin
AVAIL_STOP_S = 2 * 60
SWAP_STOP_MB = 1800
PSI_FULL_STOP = 10.0
PSI_FULL_STOP_S = 5 * 60
# Re-set on #4862 from the ruled ~1.9 GB: Windows read under 1.9 GB in 64% of
# minutes from 4 Nov with no hold, so that line would end the trial at its
# first minute. Under 500 MB for 5 minute lines read zero times from 9 Nov
# 19:04 to 10 Nov 11:50 +08 with the guest reclaim live, and 4 times with
# 668 MB taken off every line.
WIN_STOP_MB = 500
WIN_STOP_LINES = 5
SILENT_S = 3 * 60

SIGN_FLIP_DRAWS = 100_000


def paths(home):
    state = os.path.join(home, ".claude", "memory-switchback")
    return {
        "schedule": os.path.join(state, "schedule.json"),
        "events": os.path.join(state, "events.jsonl"),
        "hold": os.path.join(home, ".claude", "memory-hold"),
        "minute_log": os.path.join(home, "memwatch-minute.jsonl"),
        "concurrency": os.path.join(home, ".claude", "concurrency.jsonl"),
    }


# ---- draw -----------------------------------------------------------------


def launch_charge_mb(rows):
    """One more session's launch charge, `nextNeedMb - drawNeedMb`, as the
    median of the last 50 ticks admitting no session by memory. Only there is
    nextNeedMb the need for exactly one more: past that it carries the spare
    pairs a 2nd launch warms (lib/admission-figures.js's launchNeedFor)."""
    deltas = [
        m["nextNeedMb"] - m["drawNeedMb"]
        for m in (r.get("memory") or {} for r in rows)
        if m.get("memorySlots") == 0
        and isinstance(m.get("nextNeedMb"), int)
        and isinstance(m.get("drawNeedMb"), int)
    ][-50:]
    return round(statistics.median(deltas)) if deltas else None


def read_jsonl(path):
    out = []
    try:
        with open(path) as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    # A torn line carries no tick (#4862).
                    continue
    except FileNotFoundError:
        # No log is no tick; the caller reads that as absent (#4862).
        pass
    return out


def draw(start, hold_mb, rng=None):
    """The schedule: SCHEDULE_H of paired blocks from `start`, a fair coin per
    pair; pair 0 holds half of `hold_mb`."""
    rng = rng or secrets.SystemRandom()
    blocks = []
    for pair in range(SCHEDULE_H * 3600 // (2 * BLOCK_S)):
        first = rng.choice((HOLD, NONE))
        for arm in (first, NONE if first == HOLD else HOLD):
            mb = (hold_mb // 2 if pair == 0 else hold_mb) if arm == HOLD else 0
            blocks.append({"i": len(blocks), "pair": pair, "arm": arm, "mb": mb})
    return {"start": start, "hold_mb": hold_mb, "blocks": blocks}


def load_schedule(p):
    with open(p["schedule"]) as f:
        return json.load(f)


def block_span(sched, b):
    start = sched["start"] + b["i"] * BLOCK_S
    return start, start + BLOCK_S


# ---- hold -----------------------------------------------------------------


def hold(mb, touch_s=TOUCH_S, stdout=sys.stdout):
    """Hold `mb` MB of anonymous memory resident: one byte written per page
    makes each resident, and rewriting it every `touch_s` keeps the pages
    recently used, the way a working session's are. Runs until killed."""
    os.nice(19)
    buf = bytearray(mb * 2**20)
    pages = len(buf) // PAGE
    v = 1
    buf[::PAGE] = bytes([v]) * pages
    print("ready", file=stdout, flush=True)
    while True:
        time.sleep(touch_s)
        v = 3 - v
        buf[::PAGE] = bytes([v]) * pages


class Holder:
    """The holder child and its declaration, ~/.claude/memory-hold."""

    def __init__(self, p, spawn=None):
        self.p = p
        self.proc = None
        self.spawn = spawn or (
            lambda mb: subprocess.Popen(
                [sys.executable, os.path.abspath(__file__), "hold", str(mb)],
                stdout=subprocess.PIPE,
                text=True,
            )
        )

    def start(self, mb):
        self.proc = self.spawn(mb)
        # The pages go in before the add-back does: the brief window between
        # holds memory unannounced, the conservative side for admission.
        line = self.proc.stdout.readline()
        if line.strip() != "ready":
            self.stop()
            raise RuntimeError(f"holder of {mb} MB never reported ready")
        tmp = self.p["hold"] + ".tmp"
        try:
            with open(tmp, "w") as f:
                f.write(f"{mb} {self.proc.pid}\n")
            os.replace(tmp, self.p["hold"])
        except BaseException:
            self.stop()
            raise

    def stop(self):
        # The add-back goes before the pages do, the conservative order again.
        try:
            os.remove(self.p["hold"])
        except FileNotFoundError:
            # Already gone is the state wanted: nothing is added back (#4862).
            pass
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                # A holder deaf to SIGTERM still holds the pages: kill it (#4862).
                self.proc.kill()
                self.proc.wait()
            self.proc = None


# ---- stop rules -----------------------------------------------------------


def read_meminfo(path="/proc/meminfo"):
    """MemAvailable and swap used in MB, read raw: no add-back here."""
    kb = {}
    with open(path) as f:
        for line in f:
            k, _, rest = line.partition(":")
            kb[k] = int(rest.split()[0])
    return kb["MemAvailable"] // 1024, (kb["SwapTotal"] - kb["SwapFree"]) // 1024


def read_psi_full_avg60(path="/proc/pressure/memory"):
    with open(path) as f:
        for line in f:
            if line.startswith("full"):
                return float(line.split("avg60=")[1].split()[0])
    return None


def earlyoom_kills(since):
    """earlyoom's kill lines since epoch `since`, from the journal."""
    out = subprocess.run(
        [
            "journalctl",
            "-u",
            "earlyoom",
            "--since",
            f"@{int(since)}",
            "-o",
            "cat",
            "--no-pager",
        ],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    return [
        line
        for line in out.splitlines()
        if "sending SIG" in line and "to process" in line
    ]


class Stops:
    """The stop rules. `check` takes one reading and returns the reason the
    trial ends, or None. A sustained rule fires once its condition has held,
    unbroken, for its window."""

    def __init__(self):
        self.since = {}

    def _held(self, key, cond, now, window):
        if not cond:
            self.since.pop(key, None)
            return False
        t0 = self.since.setdefault(key, now)
        return now - t0 >= window

    def check(self, now, *, avail_mb, swap_mb, psi_full, win_lines, kills):
        if kills:
            return f"earlyoom killed: {kills[0]}"
        if self._held("avail", avail_mb < AVAIL_STOP_MB, now, AVAIL_STOP_S):
            return f"guest MemAvailable under {AVAIL_STOP_MB} MB for {AVAIL_STOP_S // 60} min"
        if swap_mb > SWAP_STOP_MB:
            return f"swap used {swap_mb} MB, over {SWAP_STOP_MB} MB"
        if self._held(
            "psi",
            psi_full is not None and psi_full >= PSI_FULL_STOP,
            now,
            PSI_FULL_STOP_S,
        ):
            return f"memory PSI full avg60 >= {PSI_FULL_STOP:g}% for {PSI_FULL_STOP_S // 60} min"
        recent = [
            r.get("win_avail_mb")
            for r in win_lines
            if now - (WIN_STOP_LINES + 1) * 60 <= r["t"] <= now
        ]
        last = recent[-WIN_STOP_LINES:]
        if len(last) == WIN_STOP_LINES and all(
            w is not None and w < WIN_STOP_MB for w in last
        ):
            return f"Windows available under {WIN_STOP_MB} MB for {WIN_STOP_LINES} minute lines"
        return None

    def reset(self):
        self.since.clear()


def live_reading(p, now, kills_since):
    avail, swap = read_meminfo()
    return {
        "avail_mb": avail,
        "swap_mb": swap,
        "psi_full": read_psi_full_avg60(),
        "win_lines": minute_log(p["minute_log"], now - 10 * 60, math.inf, 8 * 1024),
        "kills": earlyoom_kills(kills_since),
    }


# ---- run ------------------------------------------------------------------


def run(p, *, now=time.time, sleep=time.sleep, reading=None, holder=None, usable=None):
    """Walk the schedule from now. Returns the reason it ended."""
    sched = load_schedule(p)
    holder = holder or Holder(p)
    stops = Stops()
    reading = reading or (lambda t, since: live_reading(p, t, since))
    usable = usable or (lambda pair: pair_usable(p, sched, pair))
    # Resume-safe: a restarted run counts the pairs its last life logged.
    count = sum(bool(e.get("usable")) for e in _events(p) if e.get("event") == "pair")
    guard_until = 0.0  # the end of the washout after the last hold
    hold_began = None

    def term(*_):
        raise SystemExit("terminated")

    def check():
        t = now()
        lines = minute_log(p["minute_log"], t - 10 * 60, math.inf, 8 * 1024)
        if not any(r["t"] >= t - SILENT_S for r in lines):
            return f"no minute-log line in the last {SILENT_S // 60} min, so the Windows stop cannot see"
        if holder.proc is None and t >= guard_until:
            stops.reset()
            return None
        return stops.check(t, **reading(t, hold_began or t))

    def wait_until(t):
        while now() < t:
            sleep(min(TICK_S, t - now()))
            stop = check()
            if stop:
                return stop
        return None

    signal.signal(signal.SIGTERM, term)
    _log(p, now(), event="start", hold_mb=sched["hold_mb"])
    why = "schedule complete"
    try:
        for b in sched["blocks"]:
            start, end = block_span(sched, b)
            if now() >= end:
                continue
            stop = wait_until(start)
            if stop:
                why = stop
                return why
            if b["arm"] == HOLD:
                hold_began = now()
                holder.start(b["mb"])
            _log(p, now(), event="block", i=b["i"], arm=b["arm"], mb=b["mb"])
            stop = wait_until(end)
            if b["arm"] == HOLD:
                holder.stop()
                guard_until = end + WASHOUT_S
            if stop:
                why = stop
                return why
            if b["i"] % 2 == 1:
                ok = usable(b["pair"])
                count += ok
                _log(p, now(), event="pair", pair=b["pair"], usable=ok, count=count)
                if count >= USABLE_PAIRS:
                    why = f"{count} usable pairs"
                    return why
        return why
    except BaseException as e:
        why = f"{type(e).__name__}: {e}"
        raise
    finally:
        holder.stop()
        _log(p, now(), event="end", why=why)


# ---- readout --------------------------------------------------------------


def loop_ticks(p, since, until):
    return [
        epoch(r["at"])
        for r in read_jsonl(p["concurrency"])
        if "at" in r and since <= epoch(r["at"]) < until
    ]


def blocks_read(sched, events, *, minute_rows, mem, ticks, close_ts, until):
    """One row per block that ended by `until`, begun by a runner inside its
    washout and not ended before the block did, read past its washout."""
    rows = []
    for b in sched["blocks"]:
        start, hi = block_span(sched, b)
        lo = start + WASHOUT_S
        began = [
            e["ts"] for e in events if e.get("event") == "block" and e["i"] == b["i"]
        ]
        if hi > until or not began or not start <= began[-1] <= lo:
            continue
        if any(e.get("event") == "end" and began[-1] <= e["ts"] < hi for e in events):
            continue
        mins = [m for k, m in minute_rows.items() if lo <= k < hi]
        bash = [x for m in mins for x in m["bash"]]
        cpu_s = sum(
            (r.get("cpu_busy_pct") or 0) / 100 * 60 for r in mem if lo <= r["t"] < hi
        )
        active = median([m["active"] for m in mins]) if mins else 0
        rows.append(
            {
                **b,
                "bash_p50": median(bash),
                "hto_min": sum(m["hto"] for m in mins) / READ_MIN,
                "cpu_per_call": cpu_s / len(bash) if bash else None,
                "closes_h": sum(lo <= t < hi for t in close_ts) * 60 / READ_MIN,
                "usable": any(lo <= t < hi for t in ticks)
                and (active or 0) >= MIN_ACTIVE
                and len(bash) >= MIN_BASH,
            }
        )
    return rows


def usable_pairs(rows):
    """{pair: {arm: row}} for each read pair whose two blocks are both usable."""
    by_pair = {}
    for r in rows:
        if r["pair"] not in UNREAD_PAIRS:
            by_pair.setdefault(r["pair"], {})[r["arm"]] = r
    return {
        k: v
        for k, v in by_pair.items()
        if len(v) == 2 and all(r["usable"] for r in v.values())
    }


def sign_flip_two_sided(diffs, draws=SIGN_FLIP_DRAWS, seed=4862):
    """Two-sided p that the mean within-pair difference is this far from 0 by
    the coin alone, by sampled sign flips."""
    if not diffs:
        return None
    obs = abs(sum(diffs))
    rng = random.Random(seed)
    hits = sum(
        abs(sum(d if rng.random() < 0.5 else -d for d in diffs)) >= obs - 1e-12
        for _ in range(draws)
    )
    return (hits + 1) / (draws + 1)


# The companions: label, key. Each is read as a within-pair hold − none
# difference beside the decision; the guardrail spends no alpha.
COMPANIONS = (
    ("Hook-timeout refusals / min", "hto_min"),
    ("Machine CPU-s per Bash call", "cpu_per_call"),
    ("Closes / h (guardrail)", "closes_h"),
)


def _fmt(x, f="{:.3f}"):
    return "–" if x is None else f.format(x)


def report(rows, end_why, draws=SIGN_FLIP_DRAWS):
    pairs = usable_pairs(rows)
    logs = [
        math.log(pr[HOLD]["bash_p50"] / pr[NONE]["bash_p50"])
        for pr in pairs.values()
        if pr[HOLD]["bash_p50"] and pr[NONE]["bash_p50"]
    ]
    p = sign_flip_two_sided(logs, draws)
    mean = statistics.fmean(logs) if logs else None
    half = (
        1.96 * statistics.stdev(logs) / math.sqrt(len(logs)) if len(logs) > 1 else None
    )
    out = [
        "| Measure | Hold arm | No-hold arm | Within-pair hold − none | p (two-sided) |",
        "|---|---|---|---|---|",
    ]
    arm = {a: [pr[a] for pr in pairs.values()] for a in (HOLD, NONE)}

    def med(a, k):
        return median([r[k] for r in arm[a] if r[k] is not None]) if arm[a] else None

    ratio = (
        f"× {math.exp(mean):.3f} [{math.exp(mean - half):.3f}, {math.exp(mean + half):.3f}]"
        if half is not None
        else "–"
    )
    out.append(
        f"| Bash median round-trip, s (decision) | {_fmt(med(HOLD, 'bash_p50'))} | {_fmt(med(NONE, 'bash_p50'))} | {ratio} | {_fmt(p)} |"
    )
    for label, key in COMPANIONS:
        diffs = [
            pr[HOLD][key] - pr[NONE][key]
            for pr in pairs.values()
            if pr[HOLD][key] is not None and pr[NONE][key] is not None
        ]
        out.append(
            f"| {label} | {_fmt(med(HOLD, key))} | {_fmt(med(NONE, key))} | {_fmt(median(diffs) if diffs else None)} | |"
        )
    if p is None:
        verdict = "no reading — no usable pair"
    elif p >= ALPHA:
        verdict = f"no slowdown detected at p < {ALPHA}"
    elif mean > 0:
        clears = math.exp(mean - half) > 1.14
        verdict = f"the hold slows Bash round-trip ({'beyond' if clears else 'not clearly beyond'} the 14% break-even)"
    else:
        verdict = "the hold speeds Bash round-trip"
    out += [
        "",
        f"Ended: {end_why}. {len(pairs)} usable pairs of {len({r['pair'] for r in rows} - UNREAD_PAIRS)} read; "
        f"each block read over its last {READ_MIN} minutes; ratio is the geometric mean with its 95% interval.",
        f"**Verdict: {verdict}.**",
    ]
    return "\n".join(out)


def read_rows(p, sched, until, *, since=None, with_closes=True):
    events = _events(p)
    since = sched["start"] if since is None else since
    tally = Counter()
    minute_rows = dense_minute.minutes(
        dense_minute.transcripts(since), since, until, tally
    )
    rows = blocks_read(
        sched,
        events,
        minute_rows=minute_rows,
        mem=minute_log(p["minute_log"], since, until),
        ticks=loop_ticks(p, since, until),
        close_ts=closes(since, until) if with_closes else [],
        until=until,
    )
    return rows, events, tally


def pair_usable(p, sched, pair):
    """Whether `pair`, just ended, counts: read over its own hour alone, so
    the check costs one pair's transcripts, not the whole run's."""
    blocks = [b for b in sched["blocks"] if b["pair"] == pair]
    one = {**sched, "blocks": blocks}
    since, _ = block_span(sched, blocks[0])
    _, until = block_span(sched, blocks[-1])
    rows, _, _ = read_rows(p, one, until, since=since, with_closes=False)
    return pair in usable_pairs(rows)


def readout(p):
    sched = load_schedule(p)
    rows, events, tally = read_rows(p, sched, time.time())
    last = events[-1] if events else {}
    end_why = last["why"] if last.get("event") == "end" else "still running"
    return f"Hold: {sched['hold_mb']} MB.\n\n{report(rows, end_why)}\n\nTranscripts skipped: {dense_minute.counts_line(tally)}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--home", default=os.path.expanduser("~"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("draw")
    sub.add_parser("run")
    sub.add_parser("hold").add_argument("mb", type=int)
    sub.add_parser("readout")
    a = ap.parse_args(argv)
    p = paths(a.home)
    if a.cmd == "draw":
        for k in ("schedule", "events", "hold"):
            if os.path.exists(p[k]):
                sys.exit(f"draw: {p[k]} already exists; move it aside first")
        mb = launch_charge_mb(read_jsonl(p["concurrency"]))
        if not mb or mb <= 0:
            sys.exit(f"draw: no launch charge in {p['concurrency']}")
        os.makedirs(os.path.dirname(p["schedule"]), exist_ok=True)
        start = math.ceil(time.time() / 60) * 60
        with open(p["schedule"], "w") as f:
            json.dump(draw(start, mb), f, indent=1)
        print(
            f"draw: {SCHEDULE_H} h of paired blocks from {_iso(start)}, hold {mb} MB -> {p['schedule']}"
        )
    elif a.cmd == "run":
        print(f"run: ended — {run(p)}")
    elif a.cmd == "hold":
        hold(a.mb)
    else:
        print(readout(p))


if __name__ == "__main__":
    main()
